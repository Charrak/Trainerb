import { Injectable } from '@nestjs/common';
import { ALL_ROLES } from '@trainerb/contracts';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { apiError, bodyObject, requireUuid } from './security';
import type { SessionContext } from './sessions';

@Injectable()
export class Admin {
  constructor(private readonly db: Database) {}
  async listAuditEvents(query: unknown) {
    const { scope, before } = bodyObject(query, ['scope', 'before']);
    if (scope !== undefined && scope !== 'certificates') throw apiError(422, 'INVALID_SCOPE', 'Unbekannter Bereich.');
    if (before !== undefined && typeof before !== 'string') throw apiError(422, 'INVALID_CURSOR', 'Ungültige Seitenmarke.');
    // Audit writers assign UUIDv7. Page by this immutable key, not by offset.
    const rows = await this.db.auditEvent.findMany({
      where: { ...(before !== undefined && { id: { lt: requireUuid(before) } }),
        ...(scope === 'certificates' && { target_type: { in: ['certificate', 'certificate_template'] } }) },
      orderBy: { id: 'desc' }, take: 26,
      select: { id: true, created_at: true, action: true, origin: true, target_type: true, target_ref: true },
    });
    // target_ref is free text, not a UUID column. Never expose arbitrary references,
    // actor profiles, IP fingerprints, reasons or before/after payloads in the reader.
    return { data: rows.slice(0, 25).map(({ target_ref, ...event }) => ({ ...event,
      target_id: /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(target_ref) ? target_ref : null })),
      next_cursor: rows.length > 25 ? rows[24].id : null };
  }
  async listUsers(limitInput: unknown, cursorInput: unknown) {
    const limit = limitInput === undefined ? 25 : Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw apiError(422, 'INVALID_LIMIT', 'Ungültige Seitengröße.');
    const cursor = cursorInput === undefined ? undefined : requireUuid(String(cursorInput));
    const users = await this.db.user.findMany({
      where: { status: { not: 'deleted' } }, orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, first_name: true, last_name: true, email_original: true, status: true, created_at: true,
        roles: { select: { role: { select: { key: true } } } } },
    });
    const more = users.length > limit;
    const data = users.slice(0, limit).map(user => ({ id:user.id, first_name:user.first_name, last_name:user.last_name,
      email:user.email_original, status:user.status, created_at:user.created_at, roles:user.roles.map(r => r.role.key).sort() }));
    return { data, next_cursor: more && data.length ? data[data.length - 1].id : null };
  }
  async changeRoles(ctx: SessionContext, targetId: string, input: unknown) {
    requireUuid(targetId);
    const body = bodyObject(input, ['role_keys', 'reason_code']);
    if (!Array.isArray(body.role_keys) || !body.role_keys.every(x => typeof x === 'string' && (ALL_ROLES as readonly string[]).includes(x)) ||
        new Set(body.role_keys).size !== body.role_keys.length || !body.role_keys.includes('participant')) {
      throw apiError(422, 'INVALID_ROLES', 'Rollen sind ungültig; die Teilnehmerrolle muss erhalten bleiben.');
    }
    if (typeof body.reason_code !== 'string' || !['staff_change','correction','security'].includes(body.reason_code)) {
      throw apiError(422, 'INVALID_REASON', 'Bitte gib einen zulässigen Änderungsgrund an.');
    }
    const keys = body.role_keys as string[]; const reason = body.reason_code;
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('trainerb_role_changes'))::text`;
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.user.id}::uuid FOR UPDATE`;
      if (targetId !== ctx.user.id) await tx.$queryRaw`SELECT id FROM users WHERE id = ${targetId}::uuid FOR UPDATE`;
      const actor = await tx.user.findUnique({ where: { id:ctx.user.id }, include: { roles: { include: { role:true } } } });
      await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${ctx.session.id}::uuid FOR UPDATE`;
      const now = new Date();
      const session = await tx.authSession.findFirst({ where: { id:ctx.session.id, user_id:ctx.user.id, kind:'backoffice',
        revoked_at:null, expires_at:{gt:now}, last_seen_at:{gt:new Date(now.getTime() - 30 * 60_000)} } });
      if (!actor || actor.status !== 'active' || !actor.roles.some(x => x.role.key === 'superadmin') ||
          !session?.mfa_verified_at || !session.reauthenticated_at || now.getTime() - session.reauthenticated_at.getTime() > 5 * 60_000) {
        throw apiError(403, 'REAUTH_REQUIRED', 'Bitte bestätige deine Anmeldung erneut.');
      }
      const target = await tx.user.findUnique({ where: { id:targetId }, include: { roles: { include: { role:true } } } });
      if (!target || target.status === 'deleted') throw apiError(404, 'NOT_FOUND', 'Nicht gefunden.');
      const before = target.roles.map(r => r.role.key).sort();
      if (before.includes('superadmin') && !keys.includes('superadmin') && target.status === 'active') {
        // A pending or blocked superadmin is not an available administrator.
        const activeCount = await tx.userRole.count({ where: { role: { key: 'superadmin' }, user: { status: 'active' } } });
        if (activeCount <= 1) throw apiError(409, 'LAST_SUPERADMIN', 'Der letzte aktive Superadmin darf nicht entfernt werden.');
      }
      const roles = await tx.role.findMany({ where: { key:{in:keys} } });
      if (roles.length !== keys.length) throw apiError(422, 'INVALID_ROLES', 'Eine Rolle ist nicht eingerichtet.');
      await tx.userRole.deleteMany({ where: { user_id:targetId } });
      await tx.userRole.createMany({ data:roles.map(role => ({ user_id:targetId, role_id:role.id, granted_by:ctx.user.id })) });
      // Remove now-inapplicable course scopes atomically. Regranting a role
      // later must not silently restore its old course access. Course staff
      // mutations take the same advisory lock and lock this user first.
      const removedScopes = [ ...(!keys.includes('course_manager') ? ['manager'] : []), ...(!keys.includes('instructor') ? ['instructor'] : []) ];
      if (removedScopes.length) {
        const where = { user_id: targetId, scope_role: { in: removedScopes } };
        const assignments = await tx.courseStaff.findMany({ where, select: { course_id: true, scope_role: true } });
        if (assignments.length) {
          await tx.courseStaff.deleteMany({ where });
          for (let offset = 0; offset < assignments.length; offset += 500) {
            await tx.auditEvent.createMany({ data: assignments.slice(offset, offset + 500).map(assignment => ({ id:uuidv7(), actor_user_id:ctx.user.id, origin:'user',
              action:'course.staff_removed', target_type:'course', target_ref:assignment.course_id,
              after_safe:{ user_id:targetId, scope_role:assignment.scope_role, cause:'role_revoked' }, reason_code:reason })) });
          }
          await tx.auditEvent.create({ data: { id:uuidv7(), actor_user_id:ctx.user.id, origin:'user',
            action:'course.staff_roles_revoked', target_type:'user', target_ref:targetId,
            after_safe:{ removed_count:assignments.length, scope_roles:removedScopes }, reason_code:reason } });
        }
      }
      await tx.authSession.updateMany({ where: { user_id:targetId, revoked_at:null }, data:{revoked_at:now} });
      await tx.auditEvent.create({ data:{id:uuidv7(), actor_user_id:ctx.user.id, origin:'user', action:'roles.changed',
        target_type:'user', target_ref:targetId, before_safe:{role_keys:before}, after_safe:{role_keys:[...keys].sort()}, reason_code:reason} });
      return { id:targetId, role_keys:[...keys].sort() };
    }, { timeout:30_000 });
  }
}
