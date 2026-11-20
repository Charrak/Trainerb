import type { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';

/**
 * Retention (Aufbewahrung).
 *
 * Every rule here is a *technical* implementation of a policy a human signed
 * off; the periods live in one place (`RETENTION_DAYS`) so a legal decision
 * changes a number, not code scattered across modules. Two principles:
 *
 *  - Nothing that is evidence of a completed transaction (invoices, credit
 *    notes, payments, audit events, disputes) is deleted by this job. It only
 *    removes what has stopped being necessary: expired one-time material, stale
 *    sessions, and the readable address of a closed withdrawal case.
 *  - A removal is written down. Each run records counts in the audit log, and
 *    each withdrawal case keeps the moment its address was removed. Deletion
 *    without a trace would make the next erasure request unanswerable.
 */

export type RetentionPeriods = {
  /** Unused/expired account tokens, e.g. verification or password reset. */
  accountTokenDays: number;
  /** Sessions that expired or were revoked this long ago. */
  sessionDays: number;
  /** Readable address of a *closed* withdrawal case; the case itself stays. */
  withdrawalAddressDays: number;
  /** Undeliverable outbox rows (never sent, no longer eligible). */
  outboxDays: number;
};

/**
 * Defaults follow docs/04 §4.4. They are deliberately conservative: too long is
 * a documented risk, too short destroys evidence.
 */
export const RETENTION_DAYS: RetentionPeriods = {
  accountTokenDays: 7,
  sessionDays: 30,
  withdrawalAddressDays: 180,
  outboxDays: 90,
};

export type RetentionReport = {
  ran_at: string;
  periods: RetentionPeriods;
  newsletter_proofs_deleted: number;
  newsletter_unconfirmed_deleted: number;
  account_tokens_deleted: number;
  sessions_deleted: number;
  withdrawal_addresses_scrubbed: number;
  outbox_rows_deleted: number;
};

const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 24 * 60 * 60_000);

/**
 * Run one retention pass. Safe to run repeatedly: every step is a conditional
 * update/delete on a state that no longer changes afterwards.
 */
export async function runRetention(db: Prisma.TransactionClient, options: {
  now?: Date; periods?: Partial<RetentionPeriods>; dryRun?: boolean;
} = {}): Promise<RetentionReport> {
  const now = options.now ?? new Date();
  const periods = { ...RETENTION_DAYS, ...options.periods };
  const report: RetentionReport = { ran_at: now.toISOString(), periods,
    newsletter_proofs_deleted: 0, newsletter_unconfirmed_deleted: 0, account_tokens_deleted: 0, sessions_deleted: 0, withdrawal_addresses_scrubbed: 0, outbox_rows_deleted: 0 };

  // Expired tokens are dead weight; an unexpired one is never touched.
  const tokenWhere = { expires_at: { lte: daysAgo(now, periods.accountTokenDays) } };
  report.account_tokens_deleted = options.dryRun ? await db.accountToken.count({ where: tokenWhere })
    : (await db.accountToken.deleteMany({ where: tokenWhere })).count;

  // Lock in the same order as subscribe/confirm/suppress. Recheck in a new statement
  // after acquiring the lock so a freshly replaced proof cannot be deleted.
  const batch = options.dryRun
    ? await db.$queryRaw<{id:string}[]>`SELECT s.id FROM newsletter_subscribers s JOIN newsletter_proofs p ON p.subscriber_id=s.id WHERE p.expires_at<=${now} ORDER BY s.id LIMIT 500`
    : await db.$queryRaw<{id:string}[]>`SELECT s.id FROM newsletter_subscribers s JOIN newsletter_proofs p ON p.subscriber_id=s.id WHERE p.expires_at<=${now} ORDER BY s.id LIMIT 500 FOR UPDATE OF s SKIP LOCKED`;
  const ids = batch.map(r => r.id), proofWhere = { subscriber_id:{in:ids},expires_at:{lte:now} };
  if(options.dryRun){
    report.newsletter_proofs_deleted = await db.newsletterProof.count({where:proofWhere});
    report.newsletter_unconfirmed_deleted = await db.newsletterSubscriber.count({where:{id:{in:ids},status:'pending'}});
  } else if(ids.length){
    const removed = await db.newsletterProof.findMany({where:proofWhere,select:{subscriber_id:true}});
    await db.newsletterProof.deleteMany({where:proofWhere});
    report.newsletter_proofs_deleted = removed.length;
    report.newsletter_unconfirmed_deleted = (await db.newsletterSubscriber.deleteMany({where:{id:{in:removed.map(r=>r.subscriber_id)},status:'pending'}})).count;
  }

  const sessionWhere = { OR: [{ expires_at: { lte: daysAgo(now, periods.sessionDays) } },
    { revoked_at: { lte: daysAgo(now, periods.sessionDays) } }] };
  report.sessions_deleted = options.dryRun ? await db.authSession.count({ where: sessionWhere })
    : (await db.authSession.deleteMany({ where: sessionWhere })).count;

  // The withdrawal case stays — it is the proof that the deadline was met. Only
  // the readable address goes; the HMAC keeps the case findable for a repeated
  // request without keeping the address itself.
  if (options.dryRun) {
    report.withdrawal_addresses_scrubbed = await db.withdrawalRequest.count({ where: {
      status: { in: ['completed', 'rejected'] }, contact_email: { not: null },
      contact_email_scrubbed_at: null, processed_at: { lte: daysAgo(now, periods.withdrawalAddressDays) } } });
  } else {
    const scrubbed = await db.withdrawalRequest.updateMany({
      where: { status: { in: ['completed', 'rejected'] }, contact_email: { not: null },
        contact_email_scrubbed_at: null, processed_at: { lte: daysAgo(now, periods.withdrawalAddressDays) } },
      data: { contact_email: null, contact_email_scrubbed_at: now } });
    report.withdrawal_addresses_scrubbed = scrubbed.count;
  }

  // Outbox rows that will never be sent again: the durable evidence of a *sent*
  // mail stays, only abandoned drafts and permanently failed rows go.
  const outboxWhere = { status: { in: ['cancelled', 'failed'] },
    created_at: { lte: daysAgo(now, periods.outboxDays) } };
  report.outbox_rows_deleted = options.dryRun ? await db.emailOutbox.count({ where: outboxWhere })
    : (await db.emailOutbox.deleteMany({ where: outboxWhere })).count;

  if (!options.dryRun) {
    await db.auditEvent.create({ data: { id: uuidv7(), actor_user_id: null, origin: 'system',
      action: 'retention.run', target_type: 'system', target_ref: 'retention',
      after_safe: report as unknown as Prisma.InputJsonValue } });
  }
  return report;
}
