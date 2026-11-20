import { unexpiredGrant } from './access-period';
import type { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { apiError } from './security';

/**
 * Fulfilment is the single place where money turns into learning access.
 *
 * It is shared by both paid paths — the administrator confirming a bank
 * transfer and the signature-verified Stripe webhook — so the two can never
 * drift apart. Everything runs inside the caller's transaction, after the order
 * row has been locked.
 *
 * A guest order has no account when it is placed. Linking happens here, only
 * after the payment is real, and only to the address that was verified before
 * the order existed:
 *  - an account with that address already exists → the order joins it;
 *  - the account is blocked → nothing is granted, a human has to decide;
 *  - no account exists → one is created in `pending_activation` with the
 *    participant name from the order, and the usual activation mail is queued.
 * In every case the buyer never gains access to an account they did not prove
 * control over.
 *
 * Money that the bank has already taken back, or is still deciding about, must
 * not turn into access. A lost chargeback leaves the order `charged_back` and
 * never reaches this function; a running one (`warning`, `open`) reaches it and
 * is refused, so the caller can park the order. Granting first and asking later
 * would hand out a course for money that may be gone tomorrow.
 */
/** What fulfilment did, so a caller can report it without guessing. */
export type FulfilmentOutcome =
  | { status: 'fulfilled' }
  | { status: 'needs_review'; reason: string }
  | { status: 'blocked_by_dispute'; dispute_id: string; dispute_status: string };

export async function fulfilPaidOrder(tx: Prisma.TransactionClient, orderId: string,
                                     outbox?: { issueActivationFor: (tx: Prisma.TransactionClient, userId: string) => Promise<void> },
                                     options?: { staffApprovedBlockedBuyer: true }): Promise<FulfilmentOutcome> {
  const order = await tx.order.findUnique({ where: { id: orderId } });
  if (!order) throw apiError(404, 'NOT_FOUND', 'Nicht gefunden.');
  if (order.payment_state !== 'paid') {
    throw apiError(409, 'ORDER_NOT_PAID', 'Ein Zugang kann erst nach bestätigter Zahlung entstehen.');
  }
  // An open chargeback is a question, not an answer. Until the bank decides, no
  // access is granted and the order is parked visibly as `blocked`.
  //
  // This returns instead of throwing on purpose: the caller's transaction also
  // records the payment (the money *did* arrive), and an exception here would
  // roll that back and leave the payment invisible. Parking keeps both facts —
  // money received, access withheld pending a decision.
  const pending = await tx.dispute.findFirst({ where: { order_id: orderId,
    status: { in: ['warning', 'open'] } }, select: { id: true, status: true } });
  if (pending) {
    await tx.order.update({ where: { id: orderId }, data: { fulfillment_state: 'blocked' } });
    await tx.auditEvent.create({ data: { id: uuidv7(), origin: 'system',
      action: 'fulfilment.blocked_by_dispute', target_type: 'order', target_ref: orderId,
      after_safe: { dispute_id: pending.id, dispute_status: pending.status } } });
    return { status: 'blocked_by_dispute', dispute_id: pending.id, dispute_status: pending.status };
  }
  const park = async (reason: string): Promise<FulfilmentOutcome> => {
    await tx.order.update({ where: { id: orderId }, data: { fulfillment_state: 'blocked' } });
    await tx.auditEvent.create({ data: { id: uuidv7(), origin: 'system', action: 'fulfilment.needs_review',
      target_type: 'order', target_ref: orderId, after_safe: { reason } } });
    return { status: 'needs_review', reason };
  };
  const items = await tx.orderItemCourse.findMany({ where: { order_id: orderId }, orderBy: { order_item_product: 'asc' } });
  if (!items.length) return park('FULFILMENT_INCOMPLETE');
  if (!order.user_id && order.identity_kind !== 'guest') return park('ORDER_WITHOUT_BUYER');
  const userId = order.user_id ?? await linkGuestAccount(tx, order, outbox);
  if (!userId) return park('ACCOUNT_BLOCKED');
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
  const buyer = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { status: true } });
  if (buyer.status === 'deletion_requested' || buyer.status === 'deleted' || (buyer.status === 'blocked' && !options?.staffApprovedBlockedBuyer)) return park('ACCOUNT_BLOCKED');
  const now = new Date();
  // Check the complete bundle before writing any grants. An unrelated active grant
  // cannot count as fulfilment of this payment (including concurrent checkouts).
  const existing = await tx.courseAccess.findMany({ where: { user_id: userId, ...unexpiredGrant(now),
    course_id: { in: items.map(i => i.course_id) } }, select: { course_id: true, order_id: true } });
  if (existing.some(g => g.order_id !== orderId)) return park('ACCESS_ALREADY_EXISTS');
  const granted = new Set(existing.map(g => g.course_id));
  for (const item of items) {
    if (granted.has(item.course_id)) continue;
    granted.add(item.course_id);
    const endsAt = item.access_days ? new Date(now.getTime() + item.access_days * 24 * 60 * 60_000) : null;
    await tx.courseAccess.create({ data: { id: uuidv7(), user_id: userId, course_id: item.course_id,
      course_version_id: item.course_version_id, source: 'order', order_id: orderId, starts_at: now, ends_at: endsAt } });
  }
  await tx.order.update({ where: { id: orderId }, data: { fulfillment_state: 'fulfilled', fulfilled_at: now } });
  await tx.couponReservation.updateMany({ where: { order_id: orderId, status: 'reserved' },
    data: { status: 'redeemed', resolved_at: now, user_id: userId } });
  return { status: 'fulfilled' };
}

/**
 * Attach a paid guest order to the account behind its verified address. This is
 * idempotent: an already linked order returns its account untouched.
 */
async function linkGuestAccount(tx: Prisma.TransactionClient, order: Prisma.OrderGetPayload<Record<string, never>>,
                                outbox?: { issueActivationFor: (tx: Prisma.TransactionClient, userId: string) => Promise<void> }): Promise<string | null> {
  const existing = await tx.user.findUnique({ where: { email_canonical: order.buyer_email_canonical } });
  let userId: string;
  if (existing) {
    userId = existing.id;
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
    const current = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (current.status === 'blocked' || current.status === 'deletion_requested' || current.status === 'deleted' || current.email_canonical !== order.buyer_email_canonical) return null;
  } else {
    const role = await tx.role.findUnique({ where: { key: 'participant' } });
    if (!role) throw new Error('Role catalog is not initialized.');
    userId = uuidv7();
    // The participant name was captured with the order; the invoice address is
    // never used as a profile name because it may belong to someone else.
    await tx.user.create({ data: { id: userId, email_original: order.buyer_email_original,
      email_canonical: order.buyer_email_canonical,
      first_name: order.guest_participant_first_name, last_name: order.guest_participant_last_name,
      locale: 'de-DE', status: 'pending_activation' } });
    await tx.userRole.create({ data: { user_id: userId, role_id: role.id, granted_by: userId } });
    await tx.auditEvent.create({ data: { id: uuidv7(), origin: 'system', action: 'account.created_by_purchase',
      target_type: 'user', target_ref: userId, after_safe: { order_id: order.id } } });
  }
  await tx.order.update({ where: { id: order.id }, data: { user_id: userId } });
  await tx.couponReservation.updateMany({ where: { order_id: order.id, user_id: null }, data: { user_id: userId } });
  await tx.auditEvent.create({ data: { id: uuidv7(), origin: 'system', action: 'order.buyer_linked',
    target_type: 'order', target_ref: order.id, after_safe: { user_id: userId, created: !existing } } });
  // The new account needs its activation link before the buyer can log in.
  if (!existing && outbox) await outbox.issueActivationFor(tx, userId);
  return userId;
}
