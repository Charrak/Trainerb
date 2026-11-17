import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import type { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { getConfig } from './config';
import { apiError } from './security';

const unavailable = () => apiError(409, 'STRIPE_UNAVAILABLE', 'Kartenzahlung ist derzeit nicht eingerichtet.');

type StripeSessionFacts = { id: string; paymentIntentId: string | null; amount: bigint; currency: string;
  orderId: string };

/**
 * Optional Stripe integration.
 *
 * Access is granted **only** by a signature-verified webhook. The browser
 * redirect after checkout therefore grants nothing by itself: it merely shows a
 * waiting page. `checkout.session.completed` (or
 * `checkout.session.async_payment_succeeded`) with `payment_status = 'paid'` is
 * the single trigger that marks the order paid and fulfilled.
 */
@Injectable()
export class StripePayments {
  private readonly client = getConfig().stripeSecretKey
    ? new Stripe(getConfig().stripeSecretKey!, { maxNetworkRetries: 2 }) : null;

  constructor(private readonly db: Database) {}

  get enabled(): boolean { return this.client !== null; }

  /** Create (or reuse) a hosted Stripe session for an awaiting order. */
  async startSession(orderId: string, userEmail: string): Promise<{ url: string }> {
    if (!this.client) throw unavailable();
    const order = await this.db.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order) throw apiError(404, 'NOT_FOUND', 'Nicht gefunden.');
    if (order.payment_method !== 'stripe') throw apiError(409, 'WRONG_PAYMENT_METHOD', 'Diese Bestellung ist nicht für Kartenzahlung vorgesehen.');
    if (order.payment_state !== 'awaiting') throw apiError(409, 'ORDER_NOT_PAYABLE', 'Diese Bestellung kann nicht mehr bezahlt werden.');
    const open = await this.db.paymentAttempt.findFirst({ where: { order_id: orderId, provider: 'stripe',
      status: { in: ['created', 'pending'] } }, orderBy: { created_at: 'desc' } });
    if (open?.provider_session_id) {
      const session = await this.client.checkout.sessions.retrieve(open.provider_session_id);
      if (session.status === 'open' && session.url) return { url: session.url };
    }
    const attemptId = uuidv7();
    const session = await this.client.checkout.sessions.create({
      mode: 'payment',
      customer_email: userEmail,
      client_reference_id: orderId,
      line_items: order.items.map(item => ({ quantity: 1, price_data: { currency: 'eur',
        unit_amount: Number(item.total_gross_cents),
        product_data: { name: item.title_snapshot } } })),
      metadata: { order_id: orderId, order_number: order.order_number, attempt_id: attemptId },
      payment_intent_data: { metadata: { order_id: orderId, attempt_id: attemptId } },
      success_url: `${getConfig().publicBaseUrl}/bestellung/${orderId}?status=pruefung`,
      cancel_url: `${getConfig().publicBaseUrl}/bestellung/${orderId}?status=abgebrochen`,
    }, { idempotencyKey: `checkout-${orderId}-${attemptId}` });
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
      await tx.paymentAttempt.updateMany({ where: { order_id: orderId, provider: 'stripe', status: 'created' },
        data: { status: 'cancelled', failure_code: 'superseded' } });
      await tx.paymentAttempt.create({ data: { id: attemptId, order_id: orderId, provider: 'stripe',
        environment: getConfig().paymentEnvironment, provider_session_id: session.id,
        provider_idempotency_key: `stripe-${attemptId}`, status: 'pending', amount_cents: order.total_gross_cents,
        currency: order.currency } });
    });
    if (!session.url) throw apiError(502, 'STRIPE_UNAVAILABLE', 'Die Zahlung konnte nicht gestartet werden.');
    return { url: session.url };
  }

  /** Signature verification happens before any database access. */
  async handleWebhook(rawBody: Buffer | undefined, signature: string | undefined): Promise<{ received: boolean }> {
    const webhookSecret = getConfig().stripeWebhookSecret;
    if (!this.client || !webhookSecret) throw unavailable();
    if (!rawBody || !signature) throw apiError(400, 'INVALID_WEBHOOK', 'Ungültige Anfrage.');
    let event: Stripe.Event;
    try {
      event = this.client.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch { throw apiError(400, 'INVALID_SIGNATURE', 'Ungültige Signatur.'); }
    if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') {
      return { received: true };
    }
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.payment_status !== 'paid') return { received: true };
    const orderId = session.metadata?.order_id ?? session.client_reference_id ?? '';
    const facts: StripeSessionFacts = { id: session.id,
      paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null,
      amount: BigInt(session.amount_total ?? 0), currency: (session.currency ?? '').toUpperCase(), orderId };
    if (!/^[0-9a-f-]{36}$/.test(orderId)) throw apiError(400, 'INVALID_WEBHOOK', 'Ungültige Anfrage.');
    await this.applyPaidEvent(facts, event.id, event.type);
    return { received: true };
  }

  private async applyPaidEvent(facts: StripeSessionFacts, eventId: string, eventType: string): Promise<void> {
    await this.db.$transaction(async tx => {
      // Replay protection: the provider event id is unique.
      const seen = await tx.paymentEvent.findFirst({ where: { provider: 'stripe',
        environment: getConfig().paymentEnvironment, provider_event_id: eventId }, select: { id: true } });
      if (seen) return;
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${facts.orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id: facts.orderId } });
      if (!order) throw apiError(404, 'NOT_FOUND', 'Nicht gefunden.');
      if (order.payment_method !== 'stripe') throw apiError(409, 'WRONG_PAYMENT_METHOD', 'Zahlungsart passt nicht zur Bestellung.');
      if (facts.amount !== order.total_gross_cents || facts.currency !== order.currency) {
        // An amount mismatch is never auto-accepted: it needs a human decision.
        await tx.order.update({ where: { id: order.id }, data: { payment_state: 'review' } });
        await tx.paymentEvent.create({ data: { id: uuidv7(), order_id: order.id, provider: 'stripe',
          environment: getConfig().paymentEnvironment, provider_event_id: eventId, event_type: eventType,
          amount_cents: facts.amount, currency: facts.currency } });
        return;
      }
      await tx.paymentEvent.create({ data: { id: uuidv7(), order_id: order.id, provider: 'stripe',
        environment: getConfig().paymentEnvironment, provider_event_id: eventId, event_type: eventType,
        amount_cents: facts.amount, currency: facts.currency } });
      // Ignore a late duplicate success for an already paid order.
      if (order.payment_state === 'paid') return;
      if (order.payment_state !== 'awaiting') return;
      const now = new Date();
      const attempt = await tx.paymentAttempt.findFirst({ where: { order_id: order.id, provider: 'stripe',
        OR: [{ provider_session_id: facts.id }, { provider_payment_id: facts.paymentIntentId ?? '__none__' }] },
        orderBy: { created_at: 'desc' } });
      if (!attempt) throw apiError(409, 'PAYMENT_NOT_TRACKED', 'Zu dieser Zahlung liegt kein Zahlungsversuch vor.');
      await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'succeeded', confirmed_at: now,
        provider_payment_id: facts.paymentIntentId } });
      await tx.paymentAttempt.updateMany({ where: { order_id: order.id, provider: 'stripe', id: { not: attempt.id },
        status: { in: ['created', 'pending'] } }, data: { status: 'cancelled', failure_code: 'superseded' } });
      await tx.order.update({ where: { id: order.id }, data: { payment_state: 'paid', paid_at: now } });
      await tx.couponReservation.updateMany({ where: { order_id: order.id, status: 'reserved' },
        data: { status: 'redeemed', resolved_at: now } });
      const courses = await tx.orderItemCourse.findMany({ where: { order_id: order.id } });
      for (const course of courses) {
        const existing = await tx.courseAccess.findFirst({ where: { user_id: order.user_id,
          course_id: course.course_id, revoked_at: null } });
        if (existing) continue;
        const endsAt = course.access_days ? new Date(now.getTime() + course.access_days * 24 * 60 * 60_000) : null;
        await tx.courseAccess.create({ data: { id: uuidv7(), user_id: order.user_id, course_id: course.course_id,
          course_version_id: course.course_version_id, source: 'order', order_id: order.id, starts_at: now, ends_at: endsAt } });
      }
      await tx.order.update({ where: { id: order.id }, data: { fulfillment_state: 'fulfilled', fulfilled_at: now } });
    });
  }
}

/** Marker type so callers can reason about the raw body requirement. */
export type RawBodyRequest = { rawBody?: Buffer; body?: unknown } & Record<string, unknown>;
export type OrderForStripe = Prisma.OrderGetPayload<{ include: { items: true } }>;
