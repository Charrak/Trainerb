import { templates } from './mail-catalog';
import { renderMailParts, sampleValues } from './mail-fassung';
import { backofficeWrite } from './backoffice-write';
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { Sessions, type ApiRequest } from './sessions';
import { apiError, bodyObject, requireString, requireUuid } from './security';

const preflightError = 'MAIL_PREPARATION_FAILED';
const jobStates = ['queued', 'waiting_for_data', 'running', 'succeeded', 'failed', 'cancelled'];
const errorCodes = [preflightError, 'MAIL_DELIVERY_FAILED', 'MAX_ATTEMPTS_REACHED', 'MAIL_NO_LONGER_ELIGIBLE'];
const conflict = () =>
  apiError(409, 'STATE_CONFLICT', 'Der Stand hat sich geändert oder der Vorgang ist nicht zulässig. Bitte neu laden.');
const invalid = () => apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.');
const missing = () => apiError(404, 'NOT_FOUND', 'Nicht gefunden.');
function checkedKey(key?: string) {
  const k = key ?? 'certificate_ready';
  if (!Object.hasOwn(templates, k)) throw missing();
  return { key: k, locale: 'de-DE' };
}
const names = (s: string) => Array.from(new Set([...s.matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1])));

const fields = { id: true, version: true, state: true, subject_template: true, body_text_template: true } as const;

// Each field is restricted to its built-in contract. Never move a secret into a subject or concatenate it with a URL.
function templateText(value: unknown, subject: boolean, key: string) {
  const s = requireString(value, subject ? 'subject' : 'text', subject ? 160 : 6000)
    .replace(/\r\n/g, '\n')
    .trim();
  const baseline = templates[key][subject ? 'subject' : 'text'],
    allowed = new Set(names(baseline));
  // Jede eingebaute Vorlage darf für sich stehen; erlaubt bleiben genau die
  // Platzhalter der Vorlage (plus der Anrede, wo sie fachlich zulässig ist).
  if (key === 'certificate_ready') allowed.add('first_name');
  const used = names(s);
  if (used.some((n) => !allowed.has(n)) || names(baseline).some((n) => n !== 'first_name' && !used.includes(n)))
    throw invalid();
  for (const m of s.matchAll(/\{\{(?:[a-z_]+_url|code)\}\}/g)) {
    if (
      subject ||
      !/^\s*$/.test(s.slice(Math.max(0, m.index - 1), m.index)) ||
      !/^\s*$/.test(s.slice(m.index + m[0].length, m.index + m[0].length + 1))
    )
      throw invalid();
  }
  if (
    !s ||
    /[\p{Cc}\p{Cf}]/u.test(subject ? s : s.replace(/\n/g, '')) ||
    /[{}<>]/.test(s.replace(/\{\{[a-z_]+\}\}/g, '')) ||
    /(?:https?:|mailto:|www\.)/i.test(s)
  )
    throw invalid();
  return s;
}

@Controller('admin')
export class BackofficeOperations {
  constructor(
    private readonly db: Database,
    private readonly sessions: Sessions,
  ) {}

  private audit(tx: Prisma.TransactionClient, actor: string, action: string, type: string, ref: string) {
    return tx.auditEvent.create({
      data: { id: uuidv7(), origin: 'user', actor_user_id: actor, action, target_type: type, target_ref: ref },
    });
  }
  @Get('automation-jobs') async jobs(@Req() req: ApiRequest, @Query() query: unknown) {
    await this.sessions.require(req, { backoffice: true, permission: 'operations.read' });
    const { status, before } = bodyObject(query, ['status', 'before']);
    if (
      (status !== undefined && (typeof status !== 'string' || !jobStates.includes(status))) ||
      (before !== undefined && typeof before !== 'string')
    )
      throw invalid();
    const rows = await this.db.automationJob.findMany({
      where: {
        kind: 'email.send',
        ref_type: 'email_outbox',
        ...(typeof status === 'string' && { status }),
        ...(typeof before === 'string' && { id: { lt: requireUuid(before) } }),
      },
      orderBy: { id: 'desc' },
      take: 26,
      select: {
        id: true,
        status: true,
        attempts: true,
        max_attempts: true,
        run_after: true,
        finished_at: true,
        last_error_safe: true,
        _count: { select: { job_attempts: { where: { result: 'failed', error_safe: preflightError } } } },
      },
    });
    return {
      data: rows.slice(0, 25).map(({ _count, last_error_safe, ...job }) => ({
        ...job,
        error_code: last_error_safe ? (errorCodes.includes(last_error_safe) ? last_error_safe : 'OTHER') : null,
        retry_candidate:
          job.status === 'failed' &&
          job.attempts > 0 &&
          job.attempts === job.max_attempts &&
          _count.job_attempts === job.attempts &&
          last_error_safe === preflightError,
      })),
      next_cursor: rows.length > 25 ? rows[24].id : null,
    };
  }
  @Post('automation-jobs/:id/retry') @HttpCode(200) retry(
    @Req() req: ApiRequest,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return backofficeWrite(this.db, this.sessions, req, 'operations.retry', async (tx, actor) => {
      const { expected_attempts } = bodyObject(input, ['expected_attempts']);
      if (!Number.isSafeInteger(expected_attempts) || Number(expected_attempts) < 1) throw invalid();
      await tx.$queryRaw`SELECT id FROM automation_jobs WHERE id=${requireUuid(id)}::uuid FOR UPDATE`;
      const job = await tx.automationJob.findUnique({
        where: { id },
        select: {
          kind: true,
          ref_type: true,
          ref_id: true,
          status: true,
          attempts: true,
          max_attempts: true,
          last_error_safe: true,
        },
      });
      if (!job || job.kind !== 'email.send' || job.ref_type !== 'email_outbox') throw missing();
      if (
        !job.ref_id ||
        job.status !== 'failed' ||
        job.attempts !== expected_attempts ||
        job.max_attempts !== expected_attempts ||
        job.last_error_safe !== preflightError
      )
        throw conflict();
      // Attempt history is never reset. Even one missing/ambiguous transport outcome blocks a manual retry.
      const safe = await tx.automationJobAttempt.count({
        where: {
          automation_job_id: id,
          result: 'failed',
          error_safe: preflightError,
          attempt_no: { lte: job.attempts },
        },
      });
      if (safe !== job.attempts) throw conflict();
      const now = new Date();
      const outbox = await tx.emailOutbox.updateMany({
        where: {
          id: job.ref_id,
          status: 'failed',
          last_error_safe: preflightError,
          sent_at: null,
          provider_message_id: null,
          OR: [{ secret_delete_after: null }, { secret_delete_after: { gt: now } }],
        },
        data: { status: 'queued', last_error_safe: null },
      });
      if (!outbox.count) throw conflict();
      await tx.automationJob.update({
        where: { id },
        data: {
          status: 'queued',
          max_attempts: { increment: 1 },
          run_after: now,
          finished_at: null,
          lease_until: null,
          last_error_safe: null,
        },
      });
      await this.audit(tx, actor, 'automation_job.retry_requested', 'automation_job', id);
      return { status: 'queued' };
    });
  }

  @Get('mail-templates') async keys(@Req() req: ApiRequest) {
    await this.sessions.require(req, { backoffice: true, permission: 'mail.manage' });
    return { keys: Object.keys(templates).sort() };
  }
  @Get(['certificate-mail-template', 'mail-templates/:key']) async template(
    @Req() req: ApiRequest,
    @Param('key') key?: string,
  ) {
    await this.sessions.require(req, { backoffice: true, permission: 'mail.manage' });
    const mailKey = checkedKey(key);
    const template = await this.db.emailTemplate.findUnique({
      where: { key_locale: mailKey },
      select: {
        status: true,
        versions: {
          where: { state: { in: ['draft', 'published'] } },
          orderBy: { version: 'desc' },
          select: fields,
          take: 2,
        },
      },
    });
    if (!template || template.status !== 'active') throw missing();
    return {
      published: template.versions.find((v) => v.state === 'published') ?? null,
      draft: template.versions.find((v) => v.state === 'draft') ?? null,
      // Pflicht-Platzhalter der eingebauten Vorlage; die Anrede ist freiwillig.
      variables: Array.from(new Set([...names(templates[mailKey.key].text), ...names(templates[mailKey.key].subject)])).sort(),
    };
  }
  private async lockTemplate(tx: Prisma.TransactionClient, key?: string) {
    const mailKey = checkedKey(key);
    const [t] = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM email_templates WHERE key=${mailKey.key} AND locale=${mailKey.locale} AND status='active' FOR UPDATE`;
    if (!t) throw missing();
    return t.id;
  }
  /**
   * Vorschau: die freigegebene Version mit synthetischen Werten in beiden
   * Fassungen. Ist keine Version gespeichert, gilt der eingebaute Wortlaut.
   */
  @Get(['certificate-mail-template/preview', 'mail-templates/:key/preview']) async preview(
    @Req() req: ApiRequest,
    @Param('key') key?: string,
  ) {
    await this.sessions.require(req, { backoffice: true, permission: 'mail.manage' });
    const mailKey = checkedKey(key);
    const published = await this.db.emailTemplateVersion.findFirst({
      where: { template: { key: mailKey.key, locale: mailKey.locale }, state: 'published' },
      select: { subject_template: true, body_text_template: true },
    });
    return renderMailParts(
      published?.subject_template ?? templates[mailKey.key].subject,
      published?.body_text_template ?? templates[mailKey.key].text,
      sampleValues,
    );
  }
  @Post(['certificate-mail-template/drafts', 'mail-templates/:key/drafts']) draft(
    @Req() req: ApiRequest,
    @Body() input: unknown,
    @Param('key') key?: string,
  ) {
    return backofficeWrite(this.db, this.sessions, req, 'mail.manage', async (tx, actor) => {
      const { base_id, subject, text } = bodyObject(input, ['base_id', 'subject', 'text']);
      const subject_template = templateText(subject, true, checkedKey(key).key),
        body_text_template = templateText(text, false, checkedKey(key).key);
      const template_id = await this.lockTemplate(tx, key);
      const last = await tx.emailTemplateVersion.findFirst({
        where: { template_id },
        orderBy: { version: 'desc' },
        select: { id: true, version: true, state: true, allowed_variables: true },
      });
      if (!last || last.id !== base_id || !['draft', 'published'].includes(last.state)) throw conflict();
      if (last.state === 'draft')
        await tx.emailTemplateVersion.update({ where: { id: last.id }, data: { state: 'retired' } });
      const v = await tx.emailTemplateVersion.create({
        data: {
          id: uuidv7(),
          template_id,
          version: last.version + 1,
          state: 'draft',
          subject_template,
          body_text_template,
          body_html_template: body_text_template,
          allowed_variables: last.allowed_variables as Prisma.InputJsonValue,
          created_by: actor,
        },
        select: fields,
      });
      await this.audit(tx, actor, 'mail_template.drafted', 'email_template_version', v.id);
      return v;
    });
  }
  @Post(['certificate-mail-template/publish', 'mail-templates/:key/publish']) @HttpCode(200) publish(
    @Req() req: ApiRequest,
    @Body() input: unknown,
    @Param('key') key?: string,
  ) {
    return backofficeWrite(this.db, this.sessions, req, 'mail.manage', async (tx, actor) => {
      const { draft_id } = bodyObject(input, ['draft_id']);
      const template_id = await this.lockTemplate(tx, key);
      const last = await tx.emailTemplateVersion.findFirst({
        where: { template_id },
        orderBy: { version: 'desc' },
        select: { id: true, state: true },
      });
      if (!last || last.id !== draft_id || last.state !== 'draft') throw conflict();
      await tx.emailTemplateVersion.updateMany({
        where: { template_id, state: 'published' },
        data: { state: 'retired' },
      });
      const v = await tx.emailTemplateVersion.update({
        where: { id: last.id },
        data: { state: 'published', published_at: new Date() },
        select: fields,
      });
      await this.audit(tx, actor, 'mail_template.published', 'email_template_version', v.id);
      return v;
    });
  }
}
