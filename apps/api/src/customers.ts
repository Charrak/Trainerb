import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { apiError, bodyObject, requireString, requireUuid } from './security';
import { Sessions, type SessionContext } from './sessions';

// Staff also have the participant role. Never expose or mutate a staff account
// via the limited support projection, even when addressed directly by UUID.
const customer: Prisma.UserWhereInput = { status: { not: 'deleted' }, roles: {
  some: { role: { key: 'participant' } }, every: { role: { key: 'participant' } },
} };

@Injectable()
export class Customers {
  constructor(private readonly db: Database, private readonly sessions: Sessions) {}

  async search(input: unknown) {
    const body = bodyObject(input, ['query', 'status']);
    const query = requireString(body.query, 'query', 254).trim();
    if (query.length < 2 || query.includes('\0')) throw apiError(422, 'INVALID_QUERY', 'Bitte mindestens zwei Suchzeichen eingeben.');
    const status = body.status;
    if (status !== undefined && (typeof status !== 'string' || !['active', 'blocked', 'pending_activation', 'deletion_requested'].includes(status))) {
      throw apiError(422, 'INVALID_STATUS', 'Unbekannter Kontostatus.');
    }
    const terms = query.split(/\s+/u).map(term => {
      // Prisma contains uses LIKE; user input must match literally.
      const match = { contains: term.replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' as const };
      return { OR: [{ first_name: match }, { last_name: match }, { email_original: match }] };
    });
    const rows = await this.db.user.findMany({ where: { AND: [customer, ...terms], ...(status ? { status } : {}) },
      select: { id: true, first_name: true, last_name: true, email_original: true, status: true },
      orderBy: [{ last_name: 'asc' }, { first_name: 'asc' }, { id: 'asc' }], take: 26 });
    return { data: rows.slice(0, 25), has_more: rows.length > 25 };
  }

  async changeStatus(ctx: SessionContext, id: string, input: unknown) {
    requireUuid(id);
    const body = bodyObject(input, ['status', 'reason_code']);
    const { status, reason_code } = body;
    if (status !== 'active' && status !== 'blocked') throw apiError(422, 'INVALID_STATUS', 'Unzulässiger Zielstatus.');
    if (reason_code !== 'security' && reason_code !== 'customer_request' && reason_code !== 'correction') {
      throw apiError(422, 'INVALID_REASON', 'Bitte einen zulässigen Grund auswählen.');
    }
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('trainerb_role_changes'))::text`;
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.user.id}::uuid FOR UPDATE`;
      const session = await this.sessions.assertCurrent(tx, ctx);
      const now = new Date();
      if (!session.reauthenticated_at || now.getTime() - session.reauthenticated_at.getTime() > 5 * 60_000) {
        throw apiError(403, 'REAUTH_REQUIRED', 'Bitte bestätige deine Anmeldung erneut.');
      }
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${id}::uuid FOR UPDATE`;
      const target = await tx.user.findFirst({ where: { id, ...customer }, select: { status: true, email_verified_at: true } });
      if (!target) throw apiError(404, 'NOT_FOUND', 'Kundenkonto nicht gefunden.');
      if (target.status !== (status === 'active' ? 'blocked' : 'active') || !target.email_verified_at) {
        throw apiError(409, 'STATUS_CONFLICT', 'Der Kontostatus erlaubt diese Änderung nicht.');
      }
      // An unblock is not an activation and must never bypass password setup.
      const changed = await tx.user.updateMany({ where: { id, password_hash: { not: null } }, data: { status } });
      if (!changed.count) throw apiError(409, 'STATUS_CONFLICT', 'Das Konto ist nicht aktiviert.');
      if (status === 'blocked') {
        await tx.authSession.updateMany({ where: { user_id: id, revoked_at: null }, data: { revoked_at: now } });
        await tx.accountToken.updateMany({ where: { user_id: id, revoked_at: null, used_at: null }, data: { revoked_at: now } });
      }
      await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: ctx.user.id, origin: 'user',
        action: status === 'blocked' ? 'customer.blocked' : 'customer.unblocked', target_type: 'user', target_ref: id,
        before_safe: { status: target.status }, after_safe: { status }, reason_code } });
      return { id, status };
    });
  }
}
