import type Stripe from 'stripe';
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
type Entry = {
  id: string;
  kind: 'payment' | 'refund';
  remote_id: string;
  intent: string | null;
  order_id: string;
  amount_cents: bigint;
  currency: string;
};
const mismatch = () => new Error('FEE_EVIDENCE_MISMATCH');
/** Never confirm a payment/refund, mutate the provider, create access, or store the raw provider response. */
export async function readStripeFee(api: Stripe, r: Entry, environment: 'test' | 'live') {
  const live = environment === 'live';
  let balance: Stripe.BalanceTransaction | string | null, source: string;
  if (r.kind === 'payment') {
    const pi = await api.paymentIntents.retrieve(r.remote_id, { expand: ['latest_charge.balance_transaction'] });
    const c = pi.latest_charge;
    if (
      pi.id !== r.remote_id ||
      pi.livemode !== live ||
      pi.status !== 'succeeded' ||
      pi.currency.toUpperCase() !== r.currency ||
      BigInt(pi.amount_received) !== r.amount_cents ||
      !c ||
      typeof c === 'string' ||
      c.payment_intent !== pi.id ||
      c.livemode !== live ||
      !c.paid ||
      !c.captured ||
      c.currency !== pi.currency ||
      BigInt(c.amount_captured) !== r.amount_cents
    )
      throw mismatch();
    balance = c.balance_transaction;
    source = c.id;
  } else {
    const refund = await api.refunds.retrieve(r.remote_id, { expand: ['balance_transaction', 'charge'] });
    const c = refund.charge;
    if (
      refund.id !== r.remote_id ||
      refund.status !== 'succeeded' ||
      refund.currency.toUpperCase() !== r.currency ||
      BigInt(refund.amount) !== r.amount_cents ||
      !r.intent ||
      refund.payment_intent !== r.intent ||
      !c ||
      typeof c === 'string' ||
      c.livemode !== live ||
      c.payment_intent !== r.intent
    )
      throw mismatch();
    balance = refund.balance_transaction;
    source = refund.id;
  }
  if (balance === null) return null; // May arrive after the original provider confirmation.
  if (
    typeof balance === 'string' ||
    !balance.id.startsWith('txn_') ||
    balance.source !== source ||
    balance.currency.toUpperCase() !== r.currency ||
    ![balance.amount, balance.fee, balance.net].every(Number.isSafeInteger)
  )
    throw mismatch();
  const amount = BigInt(balance.amount),
    fee = BigInt(balance.fee),
    net = BigInt(balance.net);
  if (amount !== r.amount_cents * (r.kind === 'payment' ? 1n : -1n) || amount - fee !== net) throw mismatch();
  return {
    environment,
    balance_id: balance.id,
    currency: r.currency,
    amount_cents: amount,
    fee_cents: fee,
    net_cents: net,
    payment_id: r.kind === 'payment' ? r.id : null,
    refund_id: r.kind === 'refund' ? r.id : null,
  };
}
export async function reconcileFees(db: PrismaClient, api: Stripe, environment: 'test' | 'live', after?: string) {
  const rows = await db.$queryRaw<Entry[]>`SELECT * FROM (
 SELECT p.id,'payment' AS kind,p.provider_payment_id AS remote_id,p.provider_payment_id AS intent,p.order_id,p.amount_cents,p.currency FROM payment_attempts p WHERE p.status='succeeded' AND p.environment=${environment} AND p.provider='stripe' AND p.provider_payment_id IS NOT NULL AND NOT EXISTS(SELECT FROM stripe_fee_evidence f WHERE f.payment_id=p.id)
 UNION ALL SELECT r.id,'refund',r.provider_refund_id,p.provider_payment_id,r.order_id,r.amount_cents,r.currency FROM refunds r JOIN payment_attempts p ON p.id=r.payment_attempt_id WHERE r.status='succeeded' AND r.environment=${environment} AND p.environment=r.environment AND r.provider='stripe' AND r.provider_refund_id IS NOT NULL AND NOT EXISTS(SELECT FROM stripe_fee_evidence f WHERE f.refund_id=r.id)
 ) x ${after ? Prisma.sql`WHERE id>${after}::uuid` : Prisma.empty} ORDER BY id LIMIT 51`;
  let recorded = 0,
    pending = 0,
    errors = 0;
  for (const r of rows.slice(0, 50)) {
    try {
      const data = await readStripeFee(api, r, environment);
      if (!data) {
        pending++;
        continue;
      }
      // Skip exact replays only; a conflicting assignment of the same balance movement is an error.
      await db.$transaction(async (tx) => {
        await tx.stripeFeeEvidence.createMany({ data: [data], skipDuplicates: true });
        if (!(await tx.stripeFeeEvidence.count({ where: data }))) throw mismatch();
      });
      recorded++;
    } catch {
      errors++;
    }
  }
  return { recorded, pending, errors, next_cursor: rows.length > 50 ? rows[49].id : null };
}
