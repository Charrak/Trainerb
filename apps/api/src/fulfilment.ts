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
 */
export async function fulfilPaidOrder(tx: Prisma.TransactionClient, orderId: string,
                                     outbox?: { issueActivationFor: (tx: Prisma.TransactionClient, userId: string) => Promise<void> }): Promise<void> {
  const order = await tx.order.findUnique({ where: { id: orderId } });
  if (!order) throw apiError(404, 'NOT_FOUND', 'Nicht gefunden.');
  if (order.payment_state !== 'paid') {
    throw apiError(409, 'ORDER_NOT_PAID', 'Ein Zugang kann erst nach bestätigter Zahlung entstehen.');
  }
  const userId = order.user_id ?? await linkGuestAccount(tx, order, outbox);
  const items = await tx.orderItemCourse.findMany({ where: { order_id: orderId },
    orderBy: [{ order_item_product: 'asc' }] });
  if (!items.length) throw apiError(409, 'FULFILMENT_INCOMPLETE', 'Diese Bestellung enthält keine Kurszuordnung.');
  const now = new Date();
  for (const item of items) {
    const existing = await tx.courseAccess.findFirst({ where: { user_id: userId, course_id: item.course_id,
      revoked_at: null } });
    // Owning the course twice grants nothing new; the order is still fulfilled.
    if (existing) continue;
    const endsAt = item.access_days ? new Date(now.getTime() + item.access_days * 24 * 60 * 60_000) : null;
    await tx.courseAccess.create({ data: { id: uuidv7(), user_id: userId, course_id: item.course_id,
      course_version_id: item.course_version_id, source: 'order', order_id: orderId, starts_at: now, ends_at: endsAt } });
  }
  await tx.order.update({ where: { id: orderId }, data: { fulfillment_state: 'fulfilled', fulfilled_at: now } });
  await tx.couponReservation.updateMany({ where: { order_id: orderId, status: 'reserved' },
    data: { status: 'redeemed', resolved_at: now, user_id: userId } });
}

/**
 * Attach a paid guest order to the account behind its verified address. This is
 * idempotent: an already linked order returns its account untouched.
 */
async function linkGuestAccount(tx: Prisma.TransactionClient, order: Prisma.OrderGetPayload<Record<string, never>>,
                                outbox?: { issueActivationFor: (tx: Prisma.TransactionClient, userId: string) => Promise<void> }): Promise<string> {
  if (order.identity_kind !== 'guest') {
    throw apiError(409, 'ORDER_WITHOUT_BUYER', 'Diese Bestellung hat kein zugeordnetes Konto.');
  }
  const existing = await tx.user.findUnique({ where: { email_canonical: order.buyer_email_canonical } });
  let userId: string;
  if (existing) {
    if (existing.status === 'blocked' || existing.status === 'deleted') {
      // A blocked buyer must not receive access as a side effect of a payment.
      throw apiError(409, 'ACCOUNT_BLOCKED', 'Zu dieser Bestellung besteht ein gesperrtes Konto. Bitte kläre den Fall manuell.');
    }
    userId = existing.id;
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
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
