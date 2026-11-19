import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { Sessions, type ApiRequest } from './sessions';
import { RateLimiter } from './limiter';
import { apiError, bodyObject, requireString, requireUuid, unseal } from './security';
import { qualificationProfile } from './completion';
import { createHash } from 'node:crypto';
import { pdfResponse } from './invoice-response';

const missing = () => apiError(404, 'NOT_FOUND', 'Nicht gefunden.');
const conflict = () => apiError(409, 'CERTIFICATE_CONFLICT', 'Der aktuelle Status erlaubt diesen Vorgang nicht.');
function text(body: Record<string, unknown>, field: string, max: number) {
  const value = requireString(body[field], field, max).trim();
  if (!value || /[\p{Cc}\p{Cf}]/u.test(value)) throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe die Eingabe.');
  return value;
}
function page<T extends { id: string }>(rows: T[]) {
  return { data: rows.slice(0, 50), next_cursor: rows.length > 50 ? rows[49].id : null };
}
@Controller()
export class CertificateController {
  constructor(
    private readonly db: Database,
    private readonly sessions: Sessions,
    private readonly limiter: RateLimiter,
  ) {}

  @Get('me/certificates') async mine(@Req() req: ApiRequest) {
    const ctx = await this.sessions.require(req, { permission: 'certificates.read_own' });
    const data = await this.db.$queryRaw`SELECT c.id,c.status,c.issued_at,r.completed_at,v.title FROM certificates c
      JOIN completion_records r ON r.id=c.completion_id JOIN course_access a ON a.id=r.access_id JOIN course_versions v ON v.id=c.course_version_id
      WHERE a.user_id=${ctx.user.id}::uuid ORDER BY r.completed_at DESC,c.issued_at DESC NULLS FIRST,c.id`;
    return { data };
  }
  @Get('me/certificates/:id/download') async download(
    @Req() req: ApiRequest,
    @Res() res: Response,
    @Param('id') id: string,
  ) {
    const ctx = await this.sessions.require(req, { permission: 'certificates.read_own' });
    const [doc] = await this.db.$queryRaw<
      { document_ciphertext: Uint8Array; key_id: string }[]
    >`SELECT c.document_ciphertext,c.key_id
      FROM certificates c JOIN completion_records r ON r.id=c.completion_id JOIN course_access a ON a.id=r.access_id
      WHERE c.id=${requireUuid(id)}::uuid AND c.status='valid' AND a.user_id=${ctx.user.id}::uuid`;
    if (!doc) throw missing();
    const { pdf } = unseal<{ pdf: string }>(doc.document_ciphertext, `certificate:${id.toLowerCase()}`, doc.key_id);
    pdfResponse(res, { fileName: `Zertifikat-${id}.pdf`, content: Buffer.from(pdf, 'base64') });
  }
  @Post('certificates/verify') @HttpCode(200) async verify(@Req() req: ApiRequest, @Body() input: unknown) {
    await this.limiter.hit('certificate-verify', req.ip || req.socket.remoteAddress || 'unknown', 30);
    const { token } = bodyObject(input, ['token']);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return { status: 'unknown' };
    const row = await this.db.certificate.findUnique({
      where: { verification_hash: createHash('sha256').update(token).digest() },
      select: { status: true },
    });
    return { status: row?.status ?? 'unknown' };
  }

  private async change<T>(req: ApiRequest, fn: (tx: Prisma.TransactionClient, actor: string) => Promise<T>) {
    const ctx = await this.sessions.require(req, { backoffice: true, fresh: true, permission: 'certificates.manage' });
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
            roles: { some: { role: { permissions: { some: { permission: { key: 'certificates.manage' } } } } } },
          },
        }))
      )
        throw apiError(403, 'FORBIDDEN', 'Keine Berechtigung.');
      return fn(tx, ctx.user.id);
    });
  }
  private audit(tx: Prisma.TransactionClient, actor: string, action: string, type: string, id: string) {
    return tx.auditEvent.create({
      data: { id: uuidv7(), origin: 'user', actor_user_id: actor, action, target_type: type, target_ref: id },
    });
  }
  private async draftVersion(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT id FROM course_versions WHERE id=${requireUuid(id)}::uuid FOR UPDATE`;
    const version = await tx.courseVersion.findUnique({
      where: { id },
      select: { state: true, completion_profile: true },
    });
    if (!version) throw missing();
    if (
      version.state !== 'draft' ||
      version.completion_profile !== qualificationProfile ||
      (await tx.certificateTemplate.count({ where: { course_version_id: id, approved_at: { not: null } } }))
    )
      throw conflict();
  }
  @Get('admin/certificate-templates') async templates(@Req() req: ApiRequest, @Query('before') before?: string) {
    await this.sessions.require(req, { backoffice: true, permission: 'certificates.manage' });
    const rows = await this.db.certificateTemplate.findMany({
      where: before ? { id: { lt: requireUuid(before) } } : {},
      orderBy: { id: 'desc' },
      take: 51,
    });
    return page(rows);
  }
  @Post('admin/certificate-templates') async draft(@Req() req: ApiRequest, @Body() input: unknown) {
    return this.change(req, async (tx, actor) => {
      const body = bodyObject(input, ['course_version_id', 'heading', 'issuer']),
        version = requireUuid(requireString(body.course_version_id, 'course_version_id', 36));
      await this.draftVersion(tx, version);
      const t = await tx.certificateTemplate.create({
        data: {
          id: uuidv7(),
          course_version_id: version,
          created_by: actor,
          heading: text(body, 'heading', 100),
          issuer: text(body, 'issuer', 160),
        },
      });
      await this.audit(tx, actor, 'certificate_template.created', 'certificate_template', t.id);
      return t;
    });
  }
  @Post('admin/certificate-templates/:id/approve') @HttpCode(200) async approve(
    @Req() req: ApiRequest,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return this.change(req, async (tx, actor) => {
      bodyObject(input, []);
      const t = await tx.certificateTemplate.findUnique({ where: { id: requireUuid(id) } });
      if (!t) throw missing();
      if (t.approved_at) return t;
      await this.draftVersion(tx, t.course_version_id);
      const result = await tx.certificateTemplate.update({
        where: { id },
        data: { approved_at: new Date(), approved_by: actor },
      });
      await this.audit(tx, actor, 'certificate_template.approved', 'certificate_template', id);
      return result;
    });
  }
  @Get('admin/certificates') async list(@Req() req: ApiRequest, @Query('before') before?: string) {
    await this.sessions.require(req, { backoffice: true, permission: 'certificates.manage' });
    return page(
      await this.db.certificate.findMany({
        where: before ? { id: { lt: requireUuid(before) } } : {},
        take: 51,
        orderBy: { id: 'desc' },
        select: { id: true, completion_id: true, status: true, attempts: true, last_error: true, issued_at: true },
      }),
    );
  }
  @Post('admin/certificates/:id/revoke') @HttpCode(200) async revoke(
    @Req() req: ApiRequest,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return this.change(req, async (tx, actor) => {
      const reason = text(bodyObject(input, ['reason']), 'reason', 300);
      const result = await tx.certificate.updateMany({
        where: { id: requireUuid(id), status: 'valid' },
        data: { status: 'revoked', revoked_at: new Date(), revoked_by: actor, revoke_reason: reason },
      });
      if (!result.count) throw conflict();
      await this.audit(tx, actor, 'certificate.revoked', 'certificate', id);
      return { status: 'revoked' };
    });
  }
  @Post('admin/completions/:id/reissue') @HttpCode(200) async reissue(
    @Req() req: ApiRequest,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return this.change(req, async (tx, actor) => {
      const body = bodyObject(input, ['revoked_id']),
        predecessor = requireUuid(requireString(body.revoked_id, 'revoked_id', 36));
      await tx.$queryRaw`SELECT id FROM completion_records WHERE id=${requireUuid(id)}::uuid FOR UPDATE`;
      const old = await tx.certificate.findFirst({
        where: { id: predecessor, completion_id: id, status: 'revoked' },
        select: { template_id: true, course_version_id: true },
      });
      if (!old) throw conflict();
      const select = { id: true, status: true };
      const replay = await tx.certificate.findUnique({ where: { replaces_id: predecessor }, select });
      if (replay) return replay;
      const next = await tx.certificate.create({
        data: { ...old, id: uuidv7(), completion_id: id, replaces_id: predecessor },
        select,
      });
      await this.audit(tx, actor, 'certificate.reissue_requested', 'certificate', next.id);
      return next;
    });
  }
}
