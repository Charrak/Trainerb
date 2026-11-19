import { Prisma } from '@prisma/client';
import type { Database } from './database';
import { getConfig } from './config';

export type FinancePeriod = 'today' | 'month' | 'all';
const zone = 'Europe/Berlin';

/** Operative EUR figures, not a ledger or a payout reconciliation. Read all three
 * sources in one statement/snapshot. Never join payment rows to their many refunds. */
export async function financeReport(db: Database, period: FinancePeriod, asOf = new Date()) {
  const environment = getConfig().paymentEnvironment;
  // Convert to local wall time BEFORE truncating, then convert midnight back to
  // an instant. In particular this is not a rolling 24-hour or 30-day window.
  const start =
    period === 'all'
      ? Prisma.sql`NULL::timestamptz`
      : Prisma.sql`date_trunc(${period === 'today' ? 'day' : 'month'}, stamp AT TIME ZONE ${zone}) AT TIME ZONE ${zone}`;
  const [row] = await db.$queryRaw<
    Array<{
      starts_at: Date | null;
      payments_cents: string;
      refunds_cents: string;
      dispute_face_value_cents: string;
    }>
  >`WITH clock AS (SELECT ${asOf}::timestamptz AS stamp), bounds AS (SELECT stamp, ${start} AS starts_at FROM clock)
    SELECT starts_at,
      (SELECT coalesce(sum(amount_cents),0)::text FROM payment_attempts
        WHERE environment=${environment} AND currency='EUR' AND status='succeeded'
          AND confirmed_at >= coalesce(starts_at,'-infinity') AND confirmed_at <= stamp) AS payments_cents,
      (SELECT coalesce(sum(amount_cents),0)::text FROM refunds
        WHERE environment=${environment} AND currency='EUR' AND status='succeeded'
          AND confirmed_at >= coalesce(starts_at,'-infinity') AND confirmed_at <= stamp) AS refunds_cents,
      (SELECT coalesce(sum(amount_cents),0)::text FROM disputes
        WHERE environment=${environment} AND currency='EUR'
          AND opened_at >= coalesce(starts_at,'-infinity') AND opened_at <= stamp) AS dispute_face_value_cents
    FROM bounds`;
  return {
    period,
    timezone: zone,
    environment,
    currency: 'EUR',
    as_of: asOf,
    ...row,
    balance_cents: String(BigInt(row.payments_cents) - BigInt(row.refunds_cents)),
    fees_cents: null,
  };
}
