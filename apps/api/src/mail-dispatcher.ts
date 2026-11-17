import type { Database } from './database';

/** BullMQ is only a wake-up transport. PostgreSQL remains the source of truth;
 * this reconciliation re-enqueues due jobs after queue or worker loss. */
export async function dispatchDueMail(db: Database, enqueue: (jobId: string) => Promise<unknown>): Promise<number> {
  const now = new Date();
  const due = await db.automationJob.findMany({ where: { kind: 'email.send', ref_type: 'email_outbox', OR: [
    { status: 'queued', run_after: { lte: now } }, { status: 'running', lease_until: { lte: now } },
  ] }, orderBy: [{ run_after: 'asc' }, { id: 'asc' }], select: { id: true }, take: 100 });
  for (const job of due) await enqueue(job.id);
  return due.length;
}
