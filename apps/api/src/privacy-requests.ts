import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { Sessions, type ApiRequest } from './sessions';
import { RateLimiter } from './limiter';
import { backofficeWrite } from './backoffice-write';
import { apiError, bodyObject, normalizeEmail, requireUuid, seal, unseal } from './security';
import { getConfig } from './config';
const invalid = () => apiError(422, 'INVALID_REQUEST', 'Bitte die Angaben prüfen.');
const missing = () => apiError(404, 'NOT_FOUND', 'Nicht gefunden.');
const permission = 'data_requests.manage';
const fields = {
  id: true,
  type: true,
  status: true,
  requested_at: true,
  identity_verified_at: true,
  processed_at: true,
  decision: true,
} as const;
@Controller()
export class PrivacyRequests {
  constructor(
    private readonly db: Database,
    private readonly sessions: Sessions,
    private readonly limiter: RateLimiter,
  ) {}
  @Post('privacy/requests') @HttpCode(202) async file(@Req() req: ApiRequest, @Body() input: unknown) {
    await this.sessions.verifyCsrf(req);
    await this.limiter.hit('privacy-ip', req.ip || req.socket.remoteAddress || 'unknown', 12, 3600000);
    const b = bodyObject(input, ['type', 'email']);
    if (typeof b.type !== 'string' || !['access', 'export', 'deletion', 'correction'].includes(b.type)) throw invalid();
    const { original, canonical } = normalizeEmail(b.email);
    await this.limiter.hit('privacy-address', canonical, 5, 3600000);
    const id = uuidv7();
    await this.db.dataRequest.create({
      data: {
        id,
        type: b.type,
        contact_cipher: seal({ email: original }, `privacy:${id}`),
        contact_key_id: getConfig().encryptionKeyId,
      },
    });
    return { received: true };
  }
  @Get('admin/data-requests') async list(
    @Req() req: ApiRequest,
    @Query('status') status = 'open',
    @Query('after') after?: string,
  ) {
    await this.sessions.require(req, { backoffice: true, permission });
    if (!['open', 'identity_check', 'in_progress', 'completed', 'rejected'].includes(status)) throw invalid();
    const rows = await this.db.dataRequest.findMany({
      where: { status, ...(after ? { id: { gt: requireUuid(after) } } : {}) },
      select: fields,
      orderBy: { id: 'asc' },
      take: 51,
    });
    return { data: rows.slice(0, 50), next_cursor: rows.length > 50 ? rows[49].id : null };
  }
  @Post('admin/data-requests/:id/contact') @HttpCode(200) contact(
    @Req() req: ApiRequest,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return backofficeWrite(this.db, this.sessions, req, permission, async (tx, actor) => {
      bodyObject(input, []);
      requireUuid(id);
      await tx.$queryRaw`SELECT id FROM data_requests WHERE id=${id}::uuid FOR UPDATE`;
      const r = await tx.dataRequest.findUnique({ where: { id } });
      if (!r?.contact_cipher || !r.contact_key_id) throw missing();
      const result = unseal<{ email: string }>(r.contact_cipher, `privacy:${id}`, r.contact_key_id);
      await tx.auditEvent.create({
        data: {
          id: uuidv7(),
          origin: 'user',
          actor_user_id: actor,
          action: 'privacy.contact_read',
          target_type: 'data_request',
          target_ref: id,
        },
      });
      return result;
    });
  }
  @Post('admin/data-requests/:id/advance') @HttpCode(200) advance(
    @Req() req: ApiRequest,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return backofficeWrite(this.db, this.sessions, req, permission, async (tx, actor) => {
      requireUuid(id);
      const b = bodyObject(input, ['action']);
      const r = await tx.dataRequest.findUnique({ where: { id }, select: fields });
      if (!r) throw missing();
      const now = new Date();
      const a = b.action;
      let status: string,
        decision: string | null = null;
      if (r.status === 'open' && a === 'begin_identification') status = 'identity_check';
      else if (r.status === 'identity_check' && a === 'identity_verified') status = 'in_progress';
      else if (r.status === 'identity_check' && a === 'identity_unverified') {
        status = 'rejected';
        decision = a;
      } else if (
        r.status === 'in_progress' &&
        (a === 'fulfilled' || a === 'partially_retained' || a === 'not_applicable')
      ) {
        status = a === 'not_applicable' ? 'rejected' : 'completed';
        decision = a;
      } else throw apiError(409, 'INVALID_TRANSITION', 'Für diesen Fallstand ist der Schritt nicht möglich.');
      const changed = await tx.dataRequest.updateMany({
        where: { id, status: r.status },
        data: {
          status,
          processed_by: actor,
          ...(a === 'identity_verified' ? { identity_verified_at: now } : {}),
          ...(decision ? { decision, processed_at: now, contact_cipher: null, contact_key_id: null } : {}),
        },
      });
      if (!changed.count) throw apiError(409, 'REQUEST_CHANGED', 'Fall neu laden.');
      await tx.auditEvent.create({
        data: {
          id: uuidv7(),
          origin: 'user',
          actor_user_id: actor,
          action: 'privacy.case_updated',
          target_type: 'data_request',
          target_ref: id,
          after_safe: { status, decision },
        },
      });
      return { status };
    });
  }
}
