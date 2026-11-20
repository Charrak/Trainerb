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
      stripe_fees:{expected:number;verified:number;known_cents:string};
      sold_course_positions:number;
      orders_by_state:{payment_state:string;fulfillment_state:string;count:number}[];
      payments_cents: string;
      refunds_cents: string;
      dispute_face_value_cents: string;
    }>
  >`WITH clock AS (SELECT ${asOf}::timestamptz AS stamp), bounds AS (SELECT stamp, ${start} AS starts_at FROM clock)
    , movements AS (
      SELECT p.id AS payment_id,NULL::uuid AS refund_id FROM payment_attempts p,bounds WHERE p.provider='stripe' AND p.environment=${environment} AND p.currency='EUR' AND p.status='succeeded' AND p.confirmed_at BETWEEN coalesce(starts_at,'-infinity') AND stamp
      UNION ALL SELECT NULL::uuid,r.id FROM refunds r,bounds WHERE r.provider='stripe' AND r.environment=${environment} AND r.currency='EUR' AND r.status='succeeded' AND r.confirmed_at BETWEEN coalesce(starts_at,'-infinity') AND stamp)
    SELECT starts_at,
      (SELECT jsonb_build_object('expected',count(*),'verified',count(f.balance_id),'known_cents',coalesce(sum(f.fee_cents),0)::text) FROM movements m LEFT JOIN stripe_fee_evidence f ON f.payment_id=m.payment_id OR f.refund_id=m.refund_id) AS stripe_fees,
      (SELECT count(*)::int FROM order_item_courses i WHERE EXISTS(SELECT FROM payment_attempts p WHERE p.order_id=i.order_id AND p.environment=${environment} AND p.currency='EUR' AND p.status='succeeded' AND p.confirmed_at BETWEEN coalesce(starts_at,'-infinity') AND stamp)) AS sold_course_positions,
      (SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.payment_state,g.fulfillment_state),'[]'::jsonb) FROM (SELECT o.payment_state,o.fulfillment_state,count(*)::int AS count FROM orders o WHERE o.currency='EUR' AND o.placed_at BETWEEN coalesce(starts_at,'-infinity') AND stamp GROUP BY o.payment_state,o.fulfillment_state) g) AS orders_by_state,
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
    fees_cents: row.stripe_fees.expected>0 && row.stripe_fees.expected===row.stripe_fees.verified?row.stripe_fees.known_cents:null,
  };
}
