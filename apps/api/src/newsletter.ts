import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { getConfig } from './config';
import { apiError, keyedHash, safeEqual } from './security';
import { Outbox } from './outbox';
type Tx = Prisma.TransactionClient;
export const invalid = () => apiError(422, 'INVALID_NEWSLETTER', 'Bitte die Newsletter-Eingaben prüfen.');
export const expired = () => apiError(410, 'NEWSLETTER_LINK_EXPIRED', 'Dieser Link ist nicht mehr gültig.');
export const unavailable = () =>
  apiError(409, 'NEWSLETTER_UNAVAILABLE', 'Die Newsletter-Anmeldung ist derzeit nicht verfügbar.');
export async function policy(tx: Tx) {
  const wording = process.env.NEWSLETTER_CONSENT_WORDING?.trim();
  if (!wording || wording.length > 2000) return null;
  const privacy = await tx.legalDocumentVersion.findFirst({
    where: { status: 'active', document: { kind: 'privacy' } },
    select: { id: true },
  });
  if (!privacy) return null;
  return {
    wording,
    privacy_id: privacy.id,
    policy: createHash('sha256')
      .update(JSON.stringify([wording, privacy.id]))
      .digest('hex'),
  };
}
export const tokenHash = (token: string) => keyedHash(getConfig().tokenKey, 'newsletter-confirm', token);
export function leaveToken(id: string, epoch: string) {
  const key = id + '.' + epoch;
  return key + '.' + keyedHash(getConfig().tokenKey, 'newsletter-leave', key).toString('base64url');
}
export function parseLeave(token: unknown) {
  const m =
    typeof token === 'string' &&
    /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.[A-Za-z0-9_-]{43}$/.exec(
      token,
    );
  if (!m || !safeEqual(leaveToken(m[1], m[2]), String(token))) throw expired();
  return { id: m[1], epoch: m[2] };
}
export async function lockSubscriber(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM newsletter_subscribers WHERE id=${id}::uuid FOR UPDATE`;
  return tx.newsletterSubscriber.findUniqueOrThrow({ where: { id } });
}
export async function endGrant(tx: Tx, epoch: string, action: 'withdraw' | 'bounced' | 'complained') {
  const { subscriber_id, policy, wording, privacy_id, topic } = await tx.newsletterConsentEvent.findUniqueOrThrow({
    where: { epoch_action: { epoch, action: 'grant' } },
  });
  await tx.newsletterConsentEvent.create({
    data: { id: uuidv7(), subscriber_id, epoch, action, policy, wording, privacy_id, topic },
  });
}
export function audit(tx: Tx, actor: string, action: string, id: string) {
  return tx.auditEvent.create({
    data: {
      id: uuidv7(),
      origin: 'user',
      actor_user_id: actor,
      action: 'newsletter.' + action,
      target_type: 'newsletter',
      target_ref: id,
    },
  });
}
export const sendingEnabled = () => process.env.NEWSLETTER_DELIVERY_ENABLED === 'true';
/** Freeze one consistent audience at send start; allocate only a bounded batch of outbox jobs per tick. */
export async function dispatchNewsletter(db: Database, outbox: Outbox) {
  if (!sendingEnabled()) return;
  await db.$transaction(
    async (tx) => {
      const [campaign] = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM newsletter_campaigns WHERE status='scheduled' AND scheduled_at<=now() ORDER BY scheduled_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`;
      if (campaign) {
        // "kurse_aktiv" verlangt zusätzlich einen zum Versandzeitpunkt aktiven
        // Lernzugang; die Einwilligung bleibt davon unberührt.
        await tx.$executeRaw`INSERT INTO newsletter_sends(campaign_id,subscriber_id,epoch)
    SELECT c.id,s.id,s.epoch FROM newsletter_campaigns c JOIN newsletter_subscribers s ON s.policy=c.policy
    WHERE c.id=${campaign.id}::uuid AND s.status='confirmed'
      AND (c.audience IN ('all','akademie') OR (c.audience='kurse' AND s.topic='kurse')
        OR (c.audience='kurse_aktiv' AND s.topic='kurse' AND EXISTS(
          SELECT 1 FROM users u JOIN course_access a ON a.user_id=u.id
          WHERE u.email_canonical=s.email AND u.deleted_at IS NULL AND u.status='active'
            AND a.revoked_at IS NULL AND a.suspended_at IS NULL AND a.starts_at<=now()
            AND (a.ends_at IS NULL OR a.ends_at>now()))))`;
        const [size] = await tx.$queryRaw<{ count: number }[]>`
          SELECT count(*)::int AS count FROM newsletter_sends WHERE campaign_id=${campaign.id}::uuid`;
        await tx.newsletterCampaign.update({
          where: { id: campaign.id },
          data: { status: 'frozen', frozen_at: new Date(), audience_size: size.count },
        });
      }
      const rows = await tx.$queryRaw<
        { campaign_id: string; subscriber_id: string; email: string }[]
      >`SELECT n.campaign_id,n.subscriber_id,s.email FROM newsletter_sends n
    JOIN newsletter_subscribers s ON s.id=n.subscriber_id JOIN newsletter_campaigns c ON c.id=n.campaign_id
    WHERE c.status='frozen' AND n.dispatched_at IS NULL ORDER BY c.scheduled_at,n.subscriber_id LIMIT 20 FOR UPDATE OF n SKIP LOCKED`;
      for (const row of rows) {
        const id = await outbox.notifyGuest(tx, row.email, '', 'newsletter_campaign', {});
        await tx.emailOutbox.update({ where: { id }, data: { purpose: 'newsletter' } });
        await tx.newsletterSend.update({
          where: { campaign_id_subscriber_id: { campaign_id: row.campaign_id, subscriber_id: row.subscriber_id } },
          data: { outbox_id: id, dispatched_at: new Date() },
        });
      }
    },
    { timeout: 20000 },
  );
}
/** Called after the mail job is claimed, immediately before composing a provider handoff, including on retries. */
export async function campaignMessage(db: Database, outboxId: string, to: string) {
  if (!sendingEnabled()) return null;
  const active = await policy(db);
  if (!active) return null;
  const [r] = await db.$queryRaw<
    { subject: string; body: string; id: string; epoch: string }[]
  >`SELECT c.subject,c.body,s.id,s.epoch FROM newsletter_sends n JOIN newsletter_campaigns c ON c.id=n.campaign_id
  JOIN newsletter_subscribers s ON s.id=n.subscriber_id WHERE n.outbox_id=${outboxId}::uuid AND s.email=${to} AND s.status='confirmed' AND s.epoch=n.epoch AND c.status='frozen'
  AND c.policy=s.policy AND c.policy=${active.policy}
  AND (c.audience IN ('all','akademie') OR (c.audience='kurse' AND s.topic='kurse')
    OR (c.audience='kurse_aktiv' AND s.topic='kurse' AND EXISTS(
      SELECT 1 FROM users u JOIN course_access a ON a.user_id=u.id
      WHERE u.email_canonical=s.email AND u.deleted_at IS NULL AND u.status='active'
        AND a.revoked_at IS NULL AND a.suspended_at IS NULL AND a.starts_at<=now()
        AND (a.ends_at IS NULL OR a.ends_at>now()))))`;
  return r ? { subject: r.subject, body: r.body, leave_token: leaveToken(r.id, r.epoch) } : null;
}
