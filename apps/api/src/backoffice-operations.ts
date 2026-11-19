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
const mailKey = { key: 'certificate_ready', locale: 'de-DE' };
const fields = { id: true, version: true, state: true, subject_template: true, body_text_template: true } as const;

// Only plain text and the one variable actually rendered for certificate_ready.
function templateText(value: unknown, subject: boolean) {
  const s = requireString(value, subject ? 'subject' : 'text', subject ? 160 : 6000)
    .replace(/\r\n/g, '\n')
    .trim();
  if (
    !s ||
    /[\p{Cc}\p{Cf}]/u.test(subject ? s : s.replace(/\n/g, '')) ||
    /[{}<>]/.test(s.replace(/\{\{first_name\}\}/g, ''))
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

  private async change<T>(
    req: ApiRequest,
    permission: string,
    fn: (tx: Prisma.TransactionClient, actor: string) => Promise<T>,
  ) {
    const ctx = await this.sessions.require(req, { backoffice: true, fresh: true, permission });
    await this.sessions.verifyCsrf(req, ctx);
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id=${ctx.user.id}::uuid FOR UPDATE`;
      const session = await this.sessions.assertCurrent(tx, ctx);
      if (
        !session.reauthenticated_at ||
        Date.now() - session.reauthenticated_at.getTime() > 300000 ||
        !(await tx.user.count({
          where: {
            id: ctx.user.id,
            status: 'active',
            roles: { some: { role: { permissions: { some: { permission: { key: permission } } } } } },
          },
        }))
      )
        throw apiError(403, 'FORBIDDEN', 'Bitte Berechtigung und Identitätsbestätigung prüfen.');
      return fn(tx, ctx.user.id);
    });
  }
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
      data: rows
        .slice(0, 25)
        .map(({ _count, last_error_safe, ...job }) => ({
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
    return this.change(req, 'operations.retry', async (tx, actor) => {
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

  @Get('certificate-mail-template') async template(@Req() req: ApiRequest) {
    await this.sessions.require(req, { backoffice: true, permission: 'mail.manage' });
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
    };
  }
  private async lockTemplate(tx: Prisma.TransactionClient) {
    const [t] = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM email_templates WHERE key=${mailKey.key} AND locale=${mailKey.locale} AND status='active' FOR UPDATE`;
    if (!t) throw missing();
    return t.id;
  }
  @Post('certificate-mail-template/drafts') draft(@Req() req: ApiRequest, @Body() input: unknown) {
    return this.change(req, 'mail.manage', async (tx, actor) => {
      const { base_id, subject, text } = bodyObject(input, ['base_id', 'subject', 'text']);
      const subject_template = templateText(subject, true),
        body_text_template = templateText(text, false);
      const template_id = await this.lockTemplate(tx);
      const last = await tx.emailTemplateVersion.findFirst({
        where: { template_id },
        orderBy: { version: 'desc' },
        select: { id: true, version: true, state: true },
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
          body_html_template: body_text_template.replaceAll('&', '&amp;').replaceAll('\n', '<br>'),
          allowed_variables: [{ name: 'first_name', type: 'text', secrecy: 'personal' }],
          created_by: actor,
        },
        select: fields,
      });
      await this.audit(tx, actor, 'mail_template.drafted', 'email_template_version', v.id);
      return v;
    });
  }
  @Post('certificate-mail-template/publish') @HttpCode(200) publish(@Req() req: ApiRequest, @Body() input: unknown) {
    return this.change(req, 'mail.manage', async (tx, actor) => {
      const { draft_id } = bodyObject(input, ['draft_id']);
      const template_id = await this.lockTemplate(tx);
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
