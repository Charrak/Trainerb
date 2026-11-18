import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { Sessions, type SessionContext } from './sessions';
import { apiError, bodyObject, requireUuid } from './security';
import { getConfig } from './config';
import { Refunds } from './refunds';

const missing = () => apiError(404, 'NOT_FOUND', 'Nicht gefunden.');

/** The statuses a provider can report, in the order they usually arrive. */
const DISPUTE_STATUSES = ['warning', 'open', 'won', 'lost', 'closed'] as const;

/**
 * Chargebacks (Streitfälle).
 *
 * A dispute is **not** a refund and must never be rewritten into one:
 *
 *  - A refund is money *we* send back; a dispute is money the buyer's bank took
 *    back. They live in separate tables with separate lifecycles, so a report can
 *    always tell who moved the money. A lost dispute issues no credit note,
 *    because we never issued the credit.
 *  - The provider reports asynchronously and out of order. A case may arrive
 *    after the order was already refunded, and the same case may be delivered
 *    twice. The unique provider id makes the second delivery an update; a state
 *    never moves backwards (`won` after `lost` is refused, not silently applied).
 *  - A case never decides anything by itself. Whether the learner keeps the
 *    course after a chargeback is a recorded decision (`access.manage`), exactly
 *    like after a refund — the same rule, the same table, the same audit.
 */
@Injectable()
export class Disputes {
  constructor(private readonly db: Database, private readonly sessions: Sessions,
              private readonly refunds: Refunds) {}

  private async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try { return await this.db.$transaction(work, { timeout: 20_000 }); } catch (error) { this.dbError(error); }
  }

  private dbError(error: unknown): never {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('DISPUTE_EXCEEDS_PAYMENT')) {
      throw apiError(409, 'DISPUTE_EXCEEDS_PAYMENT', 'Der Streitfall ist größer als der bestätigte Zahlbetrag.');
    }
    if (message.includes('REFUND_EXCEEDS_PAYMENT')) {
      throw apiError(409, 'REFUND_EXCEEDS_PAYMENT',
        'Nach dieser Rückbuchung ist nichts mehr zu erstatten.');
    }
    if (message.includes('ORDER_CHARGED_BACK')) {
      throw apiError(409, 'ORDER_CHARGED_BACK', 'Eine zurückgebuchte Bestellung wird nicht storniert.');
    }
    if (message.includes('ACCESS_DECISION_REQUIRED')) {
      throw apiError(409, 'ACCESS_DECISION_REQUIRED', 'Bitte zuerst über den Zugang entscheiden.');
    }
    if (message.includes('disputes_provider_dispute')) {
      throw apiError(409, 'CONFLICT', 'Dieser Streitfall existiert bereits.');
    }
    if (message.includes('order_access_decisions_origin')) {
      throw apiError(409, 'ACCESS_DECISION_ORIGIN', 'Eine Zugangsentscheidung braucht einen Vorgang.');
    }
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      throw apiError(409, 'CONFLICT', 'Dieser Eintrag existiert bereits.');
    }
    throw error;
  }

  private async staffActor(tx: Prisma.TransactionClient, ctx: SessionContext, permission: string) {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.user.id}::uuid FOR UPDATE`;
    await this.sessions.assertCurrent(tx, ctx);
    if (ctx.session.kind !== 'backoffice' || !ctx.permissionKeys.has(permission)) {
      throw apiError(403, 'FORBIDDEN', 'Kein Zugriff.');
    }
  }

  /**
   * Money the bank took that we cannot refund any more.
   *
   * An open or won case does **not** reduce the refund capacity: the money may
   * still come back. Only `lost` is money gone — the database trigger enforces
   * the same rule, so a hand-written row cannot bypass it.
   */
  async lostTotal(tx: Prisma.TransactionClient | Database, paymentAttemptId: string): Promise<bigint> {
    const lost = await tx.dispute.aggregate({ where: { payment_attempt_id: paymentAttemptId, status: 'lost' },
      _sum: { amount_cents: true } });
    return lost._sum.amount_cents ?? 0n;
  }

  /**
   * Record a provider report. Called by the webhook and available to staff for
   * a case the provider announced by mail.
   *
   * Idempotent by `provider_dispute_id`: a repeated delivery updates the same
   * row. `provider_refund_id`-style providers send the amount each time, so an
   * amount change is refused instead of silently accepted — a provider
   * disagreement becomes a visible `409`, not a rewritten book.
   */
  async record(ctx: SessionContext | null, orderIdInput: string, input: unknown,
               options: { permission?: string } = {}, outcome: { created: boolean } = { created: false }) {
    const orderId = requireUuid(orderIdInput);
    const body = bodyObject(input, ['provider_dispute_id', 'amount_cents', 'status', 'reason_code', 'opened_at']);
    const providerDisputeId = typeof body.provider_dispute_id === 'string' ? body.provider_dispute_id.trim() : '';
    if (!/^[A-Za-z0-9_-]{4,120}$/.test(providerDisputeId)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { provider_dispute_id: 'Ungültige Referenz.' });
    }
    const amountText = String(body.amount_cents ?? '');
    if (!/^[1-9][0-9]{0,11}$/.test(amountText)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { amount_cents: 'Betrag in Cent angeben.' });
    }
    const amount = BigInt(amountText);
    const status = body.status;
    if (typeof status !== 'string' || !(DISPUTE_STATUSES as readonly string[]).includes(status)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { status: 'Unbekannter Status.' });
    }
    const reasonCode = body.reason_code === undefined || body.reason_code === null ? null : String(body.reason_code).trim();
    if (reasonCode !== null && !/^[a-z_]{3,60}$/.test(reasonCode)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { reason_code: 'Ungültiger Grund.' });
    }

    return this.transaction(async tx => {
      if (ctx) await this.staffActor(tx, ctx, options.permission ?? 'refunds.manage');
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id: orderId }, include: { attempts: true } });
      if (!order) throw missing();
      const attempt = order.attempts.find(candidate => candidate.status === 'succeeded');
      if (!attempt) throw apiError(409, 'PAYMENT_NOT_TRACKED', 'Zu dieser Bestellung liegt kein bestätigter Zahlungsversuch vor.');
      // A dispute is only meaningful for money that the provider actually holds.
      if (order.payment_state !== 'paid' && order.payment_state !== 'refunded' &&
          order.payment_state !== 'charged_back' && order.payment_state !== 'review') {
        throw apiError(409, 'ORDER_NOT_DISPUTABLE', 'Für diese Bestellung ist kein Streitfall möglich.');
      }
      const environment = getConfig().appEnv === 'production' ? 'live' : 'test';
      const existing = await tx.dispute.findUnique({ where: { provider_environment_provider_dispute_id: {
        provider: 'stripe', environment, provider_dispute_id: providerDisputeId } } });
      if (existing && existing.order_id !== orderId) {
        throw apiError(409, 'CONFLICT', 'Dieser Streitfall gehört zu einer anderen Bestellung.');
      }
      if (existing && existing.amount_cents !== amount) {
        // A changed amount is a provider disagreement, not an update.
        throw apiError(409, 'DISPUTE_AMOUNT_MISMATCH',
          'Der gemeldete Betrag weicht von der bereits erfassten Rückbuchung ab.');
      }
      const resolvedAt = status === 'won' || status === 'lost' || status === 'closed' ? new Date() : null;
      const disputeId = existing?.id ?? uuidv7();
      outcome.created = !existing;
      if (existing) {
        // A decided case is history, not a form field. The one exception is a
        // lost chargeback that the bank later reverses — an appeal that
        // succeeds is the only real way out of `lost`.
        const terminal = ['won', 'closed'].includes(existing.status);
        const appeal = existing.status === 'lost' && status === 'won';
        if ((terminal || existing.status === 'lost') && existing.status !== status && !appeal) {
          throw apiError(409, 'DISPUTE_ALREADY_RESOLVED', 'Dieser Streitfall ist bereits entschieden.');
        }
        await tx.dispute.update({ where: { id: disputeId }, data: { status,
          reason_code: reasonCode ?? existing.reason_code,
          resolved_at: resolvedAt ?? existing.resolved_at } });
      } else {
        await tx.dispute.create({ data: { id: disputeId, order_id: orderId, payment_attempt_id: attempt.id,
          provider: 'stripe', environment, provider_dispute_id: providerDisputeId, amount_cents: amount,
          currency: order.currency, status, reason_code: reasonCode, opened_at: new Date(), resolved_at: resolvedAt } });
      }

      // A lost case is money gone: the order shows it, and the payment evidence
      // stays. `refunded` is reserved for money we returned ourselves.
      if (status === 'lost' && order.payment_state !== 'charged_back') {
        await tx.order.update({ where: { id: orderId }, data: { payment_state: 'charged_back',
          charged_back_at: resolvedAt ?? new Date() } });
      }
      // A won case restores nothing automatically either: if the order was only
      // "charged_back" because of this case and the bank reversed it, the state
      // goes back to `paid` only when no other lost case explains a gap.
      if (status === 'won' && existing?.status !== 'won' && order.payment_state === 'charged_back') {
        const otherLost = await tx.dispute.findFirst({ where: { order_id: orderId, status: 'lost',
          id: { not: disputeId } }, select: { id: true } });
        if (!otherLost) {
          await tx.order.update({ where: { id: orderId },
            data: { payment_state: 'paid', charged_back_at: null } });
        }
      }
      await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: ctx?.user.id ?? null, origin: 'user',
        action: existing ? 'dispute.updated' : 'dispute.opened', target_type: 'dispute', target_ref: disputeId,
        after_safe: { order_id: orderId, status, amount_cents: amountText, reason_code: reasonCode,
          previous_status: existing?.status ?? null } } });
      return this.view(tx, disputeId);
    });
  }

  /** The open cases that need a human, newest first. */
  async list(statusInput: unknown, limitInput: unknown, cursorInput: unknown) {
    const status = statusInput === undefined || statusInput === '' ? null : String(statusInput);
    if (status !== null && !(DISPUTE_STATUSES as readonly string[]).includes(status)) {
      throw apiError(422, 'INVALID_STATE', 'Unbekannter Status.');
    }
    const limit = limitInput === undefined ? 25 : Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw apiError(422, 'INVALID_LIMIT', 'Ungültige Seitengröße.');
    const cursor = cursorInput === undefined ? undefined : requireUuid(String(cursorInput));
    const rows = await this.db.dispute.findMany({ where: status ? { status } : {},
      take: limit + 1, orderBy: [{ opened_at: 'desc' }, { id: 'desc' }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { order: { select: { order_number: true, buyer_email_canonical: true } } } });
    const data = rows.slice(0, limit).map(dispute => ({ id: dispute.id, order_id: dispute.order_id,
      order_number: dispute.order.order_number, buyer_email: dispute.order.buyer_email_canonical,
      amount_cents: String(dispute.amount_cents), currency: dispute.currency, status: dispute.status,
      reason_code: dispute.reason_code, opened_at: dispute.opened_at, resolved_at: dispute.resolved_at,
      provider_dispute_id: dispute.provider_dispute_id }));
    return { data, next_cursor: rows.length > limit && data.length ? data[data.length - 1].id : null,
      totals: { open: await this.db.dispute.count({ where: { status: { in: ['warning', 'open'] } } }),
        lost: await this.db.dispute.count({ where: { status: 'lost' } }) } };
  }

  /** One case with everything a support agent needs to answer the bank. */
  async view(tx: Prisma.TransactionClient | Database, disputeId: string) {
    const dispute = await tx.dispute.findUnique({ where: { id: disputeId }, include: {
      access_decisions: { orderBy: { decided_at: 'asc' } },
      order: { select: { id: true, order_number: true, payment_state: true, total_gross_cents: true,
        paid_at: true, refunded_at: true, charged_back_at: true, user_id: true,
        buyer_email_original: true, buyer_email_canonical: true } },
      attempt: { select: { id: true, amount_cents: true, provider: true, environment: true, confirmed_at: true } } } });
    if (!dispute) throw missing();
    const capacity = await this.refunds.capacity(dispute.order_id, dispute.payment_attempt_id, tx);
    return { id: dispute.id, order_id: dispute.order_id, order_number: dispute.order.order_number,
      buyer_email: dispute.order.buyer_email_canonical,
      amount_cents: String(dispute.amount_cents), currency: dispute.currency, status: dispute.status,
      reason_code: dispute.reason_code, provider: dispute.provider, environment: dispute.environment,
      provider_dispute_id: dispute.provider_dispute_id, opened_at: dispute.opened_at,
      resolved_at: dispute.resolved_at,
      payment: { attempt_amount_cents: String(dispute.attempt.amount_cents),
        paid_cents: String(capacity?.paid_cents ?? 0n),
        refunded_cents: String(capacity?.refunded_cents ?? 0n),
        refundable_cents: String(capacity?.refundable_cents ?? 0n) },
      order: { id: dispute.order.id, order_number: dispute.order.order_number,
        payment_state: dispute.order.payment_state, total_gross_cents: String(dispute.order.total_gross_cents),
        paid_at: dispute.order.paid_at, refunded_at: dispute.order.refunded_at,
        charged_back_at: dispute.order.charged_back_at },
      access_decisions: dispute.access_decisions.map(decision => ({ id: decision.id,
        access_id: decision.access_id, decision: decision.decision, reason: decision.reason,
        decided_at: decision.decided_at })) };
  }

  /**
   * Decide about the access after a chargeback.
   *
   * Only a lost case justifies taking the course away; an open case is a claim,
   * not a fact. `suspended` is the honest middle for exactly that situation, and
   * it is available too — but it is a decision, never a default.
   */
  async decideAccess(ctx: SessionContext, disputeIdInput: string, input: unknown) {
    const disputeId = requireUuid(disputeIdInput);
    const dispute = await this.db.dispute.findUnique({ where: { id: disputeId },
      select: { order_id: true, status: true } });
    if (!dispute) throw missing();
    if (dispute.status !== 'lost' && dispute.status !== 'won' && dispute.status !== 'closed') {
      throw apiError(409, 'DISPUTE_NOT_RESOLVED',
        'Erst nach dem Ausgang des Streitfalls wird über den Zugang entschieden.');
    }
    const body = bodyObject(input, ['decision', 'reason', 'access_ids']);
    if (dispute.status === 'won' && body.decision === 'revoked') {
      // We won: the money stays. Ending the access would need a different reason
      // than the chargeback, and that is not what this endpoint records.
      throw apiError(409, 'DISPUTE_WON',
        'Ein gewonnener Streitfall ist kein Grund, den Zugang zu entziehen.');
    }
    await this.refunds.decideAccessFor(ctx, { disputeId, orderId: dispute.order_id }, input);
    return this.view(this.db, disputeId);
  }
}
