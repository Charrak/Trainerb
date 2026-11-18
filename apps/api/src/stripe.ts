import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import type { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { getConfig } from './config';
import { apiError } from './security';
import { Outbox } from './outbox';
import { fulfilPaidOrder } from './fulfilment';
import { Disputes } from './disputes';

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
  constructor(private readonly db: Database, private readonly outbox: Outbox,
              private readonly disputes: Disputes) {}

  private readonly client = getConfig().stripeSecretKey
    ? new Stripe(getConfig().stripeSecretKey!, { maxNetworkRetries: 2 }) : null;

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
      // `complete` means the customer finished the form — the money may still be
      // on its way (SEPA and other delayed methods). Starting a second session
      // here would invite a second payment for one order.
      if (session.status === 'complete') {
        throw apiError(409, 'PAYMENT_IN_PROGRESS',
          'Die Zahlung ist bereits abgeschlossen und wird noch bestätigt. Bitte warte auf die Bestätigung.');
      }
      if (session.status === 'open' && session.url) return { url: session.url };
    }
    const attemptId = uuidv7();
    const session = await this.client.checkout.sessions.create({
      mode: 'payment',
      customer_email: userEmail,
      client_reference_id: orderId,
      // The session must bill in the order's currency, not a hardcoded one: the
      // webhook compares the reported currency with `orders.currency`.
      line_items: order.items.map(item => ({ quantity: 1, price_data: { currency: order.currency.toLowerCase(),
        unit_amount: Number(item.total_gross_cents),
        product_data: { name: item.title_snapshot } } })),
      metadata: { order_id: orderId, order_number: order.order_number, attempt_id: attemptId },
      payment_intent_data: { metadata: { order_id: orderId, attempt_id: attemptId } },
      success_url: `${getConfig().publicBaseUrl}/bestellung/${orderId}?status=pruefung`,
      cancel_url: `${getConfig().publicBaseUrl}/bestellung/${orderId}?status=abgebrochen`,
    }, { idempotencyKey: `checkout-${orderId}-${attemptId}` });
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
      // `payment_attempts_one_open` allows exactly one open attempt per order, and
      // a replaced attempt is usually `pending`, not `created`. Superseding only
      // `created` rows therefore made the new row fail the unique index.
      await tx.paymentAttempt.updateMany({ where: { order_id: orderId, provider: 'stripe',
        status: { in: ['created', 'pending'] } },
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
    // Chargebacks arrive as their own family of events and never carry a
    // checkout session; they are routed before the payment branch.
    if (event.type.startsWith('charge.dispute.')) {
      await this.applyDisputeEvent(event);
      return { received: true };
    }
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

  /**
   * A provider-reported chargeback.
   *
   * Nothing here decides anything: the event is translated into the same
   * `Disputes.record` call staff use, marked `webhook`, and that function keeps
   * every rule (one row per provider reference, no changed amounts, a lost case
   * is money gone, a resolved case releases a blocked order). A case the provider
   * reports twice updates the row and bumps `last_synced_at`.
   */
  private async applyDisputeEvent(event: Stripe.Event): Promise<void> {
    const dispute = event.data.object as Stripe.Dispute;
    const intentId = typeof dispute.payment_intent === 'string'
      ? dispute.payment_intent : dispute.payment_intent?.id ?? '';
    if (!intentId) return;
    // The order is found through the payment we booked, not through metadata a
    // provider may not send on this event type.
    const attempt = await this.db.paymentAttempt.findFirst({ where: { provider: 'stripe',
      provider_payment_id: intentId, status: 'succeeded' }, select: { order_id: true } });
    if (!attempt) {
      // A chargeback about a payment we never booked is not silently attached to
      // an arbitrary order; the delivery is acknowledged so Stripe stops retrying.
      return;
    }
    const status = disputeStatus(dispute.status);
    try {
      // `warning_*` are pre-dispute notices; they keep the dispute id and are
      // told apart by status, exactly as the shared recorder expects.
      await this.disputes.record(null, attempt.order_id, {
        provider_dispute_id: dispute.id,
        amount_cents: String(dispute.amount),
        status,
        reason_code: dispute.reason ? dispute.reason.replace(/[^a-z_]/g, '_').slice(0, 60) : null,
      }, { source: 'webhook' });
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 500;
      // A refusal by our own rules is final: retrying the same delivery would
      // fail identically forever. It is written down for a human instead, with
      // the provider's reference, so nothing disappears.
      if (!Number.isFinite(status) || status >= 500) throw error;
      await this.db.auditEvent.create({ data: { id: uuidv7(), actor_user_id: null, origin: 'provider',
        action: 'dispute.webhook_rejected', target_type: 'order', target_ref: attempt.order_id,
        after_safe: { provider_dispute_id: dispute.id, provider_status: dispute.status,
          reported_status: status, reason: error instanceof Error ? error.message : 'unbekannt' } } });
    }
  }

  /**
   * Money that arrived without a matching open order.
   *
   * Two shapes, both needing a human: a second payment for something already
   * paid (a customer clicked twice, or paid a second session), and a payment for
   * a cancelled or otherwise closed order. The order is parked in `review` —
   * *except* where that would rewrite an already settled state (`paid`,
   * `refunded`, `charged_back`) — and an audit event with origin `provider`
   * names the provider facts, so the case is visible instead of silent. The
   * money is never refunded automatically; that stays a `refunds.manage` action.
   */
  private async reportSurplus(tx: Prisma.TransactionClient,
                              order: { id: string; order_number: string; payment_state: string;
                                total_gross_cents: bigint; currency: string },
                              facts: StripeSessionFacts, eventId: string, eventType: string,
                              reason: 'amount_mismatch' | 'duplicate_payment' | 'payment_after_cancellation') {
    const settled = ['paid', 'refunded', 'charged_back'].includes(order.payment_state);
    if (!settled && order.payment_state !== 'review') {
      await tx.order.update({ where: { id: order.id }, data: { payment_state: 'review' } });
    }
    await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: null, origin: 'provider',
      action: 'payment.unmatched', target_type: 'order', target_ref: order.id,
      after_safe: { reason, order_number: order.order_number, previous_payment_state: order.payment_state,
        session_id: facts.id, payment_intent_id: facts.paymentIntentId,
        amount_cents: facts.amount.toString(), currency: facts.currency,
        expected_amount_cents: order.total_gross_cents.toString(), expected_currency: order.currency,
        provider_event_id: eventId, provider_event_type: eventType } } });
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
        // But a *later* mismatching delivery must not pull an order that is
        // already settled back into review — money that arrived once does not
        // become doubtful because a second event reports another amount.
        await tx.paymentEvent.create({ data: { id: uuidv7(), order_id: order.id, provider: 'stripe',
          environment: getConfig().paymentEnvironment, provider_event_id: eventId, event_type: eventType,
          amount_cents: facts.amount, currency: facts.currency } });
        await this.reportSurplus(tx, order, facts, eventId, eventType, 'amount_mismatch');
        return;
      }
      await tx.paymentEvent.create({ data: { id: uuidv7(), order_id: order.id, provider: 'stripe',
        environment: getConfig().paymentEnvironment, provider_event_id: eventId, event_type: eventType,
        amount_cents: facts.amount, currency: facts.currency } });
      // A payment that arrives for an order which is no longer awaiting is never
      // simply dropped: the customer paid, so either this is a duplicate of the
      // payment we already booked, or real money arrived that nothing accounts
      // for. Both are written down; the second one parks the order in `review`.
      if (order.payment_state === 'paid' || order.payment_state === 'refunded'
          || order.payment_state === 'charged_back' || order.payment_state === 'cancelled'
          || order.payment_state === 'review') {
        // Was this payment already booked for this order? Then the delivery is a
        // late duplicate and there is nothing to do.
        const booked = await tx.paymentAttempt.findFirst({ where: { order_id: order.id, provider: 'stripe',
          status: 'succeeded', OR: [{ provider_payment_id: facts.paymentIntentId ?? '__none__' },
            { provider_session_id: facts.id }] }, select: { id: true } });
        if (booked) return;
        await this.reportSurplus(tx, order, facts, eventId, eventType,
          order.payment_state === 'cancelled' ? 'payment_after_cancellation' : 'duplicate_payment');
        return;
      }
      const now = new Date();
      const attempt = await tx.paymentAttempt.findFirst({ where: { order_id: order.id, provider: 'stripe',
        OR: [{ provider_session_id: facts.id }, { provider_payment_id: facts.paymentIntentId ?? '__none__' }] },
        orderBy: { created_at: 'desc' } });
      if (!attempt) throw apiError(409, 'PAYMENT_NOT_TRACKED', 'Zu dieser Zahlung liegt kein Zahlungsversuch vor.');
      await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'succeeded', confirmed_at: now,
        provider_payment_id: facts.paymentIntentId } });
      await tx.paymentAttempt.updateMany({ where: { order_id: order.id, provider: 'stripe', id: { not: attempt.id },
        status: { in: ['created', 'pending'] } }, data: { status: 'cancelled', failure_code: 'superseded' } });
      // A provider callback is a payment confirmation without a human actor;
      // `paid_via` records that instead of a person.
      await tx.order.update({ where: { id: order.id }, data: { payment_state: 'paid', paid_at: now,
        paid_via: 'provider' } });
      // Shared with the bank-transfer path: the same rules decide when access
      // exists, including linking a guest order to its account.
      await fulfilPaidOrder(tx, order.id, this.outbox);
    });
  }
}

/**
 * Stripe's case states mapped onto ours. `warning_needs_response` is a notice
 * that a chargeback may come; it is recorded as `warning`, not as an open case.
 */
function disputeStatus(status: Stripe.Dispute.Status | null | undefined): string {
  switch (status) {
    case 'warning_needs_response':
    case 'warning_under_review':
    case 'warning_closed': return 'warning';
    case 'needs_response':
    case 'under_review': return 'open';
    case 'won': return 'won';
    case 'lost': return 'lost';
    default: return 'open';
  }
}

/** Marker type so callers can reason about the raw body requirement. */
export type RawBodyRequest = { rawBody?: Buffer; body?: unknown } & Record<string, unknown>;
export type OrderForStripe = Prisma.OrderGetPayload<{ include: { items: true } }>;
