import { Database } from './database';
import { Outbox } from './outbox';
export async function queueExpiryNotices(db: Database, outbox: Outbox) {
  if (process.env.ACCESS_EXPIRY_NOTICES_ENABLED !== 'true') return 0;
  return db.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string; user_id: string; email_original: string; first_name: string }[]
      >`WITH inserted AS (
   INSERT INTO access_expiry_notices(user_id,course_id,ends_at,window_days)
    SELECT e.user_id,e.course_id,e.ends_at,e.window_days FROM current_course_expiries e JOIN users u ON u.id=e.user_id
    WHERE u.status='active' AND u.email_verified_at IS NOT NULL AND u.email_original IS NOT NULL AND NOT EXISTS
    (SELECT FROM access_expiry_notices n WHERE (n.user_id,n.course_id,n.ends_at,n.window_days)=(e.user_id,e.course_id,e.ends_at,e.window_days))
    ORDER BY e.ends_at,e.user_id,e.course_id LIMIT 50 ON CONFLICT DO NOTHING RETURNING id,user_id)
    SELECT n.id,n.user_id,u.email_original,u.first_name FROM inserted n JOIN users u ON u.id=n.user_id`;
      for (const r of rows) {
        const id = await outbox.notify(tx, r.user_id, r.email_original, r.first_name, 'course_expiry');
        await tx.accessExpiryNotice.update({ where: { id: r.id }, data: { outbox_id: id } });
      }
      return rows.length;
    },
    { timeout: 20000 },
  );
}
export async function expiryMessage(db: Database, id: string, email: string) {
  if (process.env.ACCESS_EXPIRY_NOTICES_ENABLED !== 'true') return null;
  const [r] = await db.$queryRaw<
    { title: string; ends_at: Date }[]
  >`SELECT v.title,e.ends_at FROM access_expiry_notices n JOIN current_course_expiries e
 ON (n.user_id,n.course_id,n.ends_at,n.window_days)=(e.user_id,e.course_id,e.ends_at,e.window_days)
 JOIN users u ON u.id=e.user_id AND u.status='active' AND u.email_original=${email} AND u.email_verified_at IS NOT NULL
 JOIN course_access a ON a.user_id=u.id AND a.course_id=e.course_id AND a.starts_at<=now() AND (a.ends_at IS NULL OR a.ends_at>now()) AND a.revoked_at IS NULL AND a.suspended_at IS NULL
 JOIN course_versions v ON v.id=a.course_version_id WHERE n.outbox_id=${id}::uuid LIMIT 1`;
  return r
    ? {
        title: r.title,
        ends_at: new Intl.DateTimeFormat('de-DE', {
          timeZone: 'Europe/Berlin',
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(r.ends_at),
      }
    : null;
}
