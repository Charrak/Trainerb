import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { Sessions, type SessionContext } from './sessions';
import { Outbox } from './outbox';
import { apiError, bodyObject, requireUuid } from './security';
import { getConfig } from './config';
import { centsToText } from './shop';
import { creditNoteFileName, renderInvoicePdf } from './invoice-pdf';

const missing = () => apiError(404, 'NOT_FOUND', 'Nicht gefunden.');

/**
 * Refunds.
 *
 * Three rules shape everything here:
 *
 *  1. **A refund is money going back, not a second truth about the payment.**
 *     The successful `payment_attempt` and `orders.paid_at` stay untouched. Only
 *     the refund rows say that part of the money was returned, so the payment
 *     evidence never disappears from the books.
 *  2. **Nothing is decided implicitly.** Whether the learner keeps the course
 *     after a refund is its own row in `order_access_decisions` — including
 *     "kept". The database refuses to revoke or suspend purchased access while
 *     no decision exists, so a silent revocation cannot happen.
 *  3. **No invented money.** The sum of requested, pending and confirmed refunds
 *     must not exceed the confirmed payment (enforced by a trigger as well, so a
 *     concurrent request cannot slip past). Allocations carry gross amounts only
 *     until approved tax rates exist.
 */
@Injectable()
export class Refunds {
  constructor(private readonly db: Database, private readonly sessions: Sessions,
              private readonly outbox: Outbox) {}

  private async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try { return await this.db.$transaction(work, { timeout: 20_000 }); } catch (error) { this.dbError(error); }
  }

  /** Translate the database guards into stable API errors instead of a 500. */
  private dbError(error: unknown): never {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('REFUND_EXCEEDS_PAYMENT')) {
      throw apiError(409, 'REFUND_EXCEEDS_PAYMENT', 'Die Erstattung ist größer als der bestätigte Zahlbetrag.');
    }
    if (message.includes('ACCESS_DECISION_REQUIRED')) {
      throw apiError(409, 'ACCESS_DECISION_REQUIRED', 'Bitte zuerst über den Zugang entscheiden.');
    }
    if (message.includes('ACCESS_REVOKE_REASON_REQUIRED')) {
      throw apiError(409, 'ACCESS_REVOKE_REASON_REQUIRED', 'Für den Entzug des Zugangs fehlt ein Grund.');
    }
    if (message.includes('ACCESS_SUSPEND_REASON_REQUIRED')) {
      throw apiError(409, 'ACCESS_SUSPEND_REASON_REQUIRED', 'Für die Sperrung des Zugangs fehlt ein Grund.');
    }
    if (message.includes('ORDER_CANCEL_WITH_ACTIVE_ACCESS')) {
      throw apiError(409, 'ORDER_HAS_ACTIVE_ACCESS', 'Der Zugang muss vor der Stornierung entzogen werden.');
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
   * How much of one payment is still available for a refund.
   *
   * `failed` and `cancelled` refunds give their capacity back — a failed attempt
   * never moved money, so blocking it forever would be wrong.
   */
  async capacity(orderId: string, paymentAttemptId?: string, client: Prisma.TransactionClient | Database = this.db) {
    const attempt = paymentAttemptId
      ? await client.paymentAttempt.findFirst({ where: { id: paymentAttemptId, order_id: orderId } })
      : await client.paymentAttempt.findFirst({ where: { order_id: orderId, status: 'succeeded' },
        orderBy: { confirmed_at: 'desc' } });
    if (!attempt) return null;
    const used = await client.refund.aggregate({ where: { payment_attempt_id: attempt.id,
      status: { in: ['requested', 'pending', 'succeeded'] } }, _sum: { amount_cents: true } });
    const refunded = used._sum.amount_cents ?? 0n;
    // A lost chargeback is money already gone, so it consumes capacity exactly
    // like a confirmed refund. Without this, a decided case could be "refunded"
    // on top and the same payment would leave twice.
    const lost = await client.dispute.aggregate({ where: { payment_attempt_id: attempt.id, status: 'lost' },
      _sum: { amount_cents: true } });
    const chargedBack = lost._sum.amount_cents ?? 0n;
    const consumed = refunded + chargedBack;
    return { attempt, paid_cents: attempt.amount_cents, refunded_cents: refunded,
      charged_back_cents: chargedBack,
      refundable_cents: attempt.amount_cents > consumed ? attempt.amount_cents - consumed : 0n };
  }

  /** The refund history of an order (staff view, part of the order detail). */
  async listForOrder(tx: Prisma.TransactionClient, orderId: string) {
    const refunds = await tx.refund.findMany({ where: { order_id: orderId },
      orderBy: [{ requested_at: 'asc' }, { id: 'asc' }], include: {
        allocations: true, credit_notes: true,
        access_decisions: { orderBy: { decided_at: 'asc' }, select: { id: true, decision: true, reason: true,
          access_id: true, decided_at: true } } } });
    return refunds.map(refund => ({
      id: refund.id, amount_cents: String(refund.amount_cents), currency: refund.currency,
      status: refund.status, provider: refund.provider, environment: refund.environment,
      reason_code: refund.reason_code, note: refund.note, requested_at: refund.requested_at,
      confirmed_at: refund.confirmed_at, provider_refund_id: refund.provider_refund_id,
      last_error_safe: refund.last_error_safe,
      allocations: refund.allocations.map(allocation => ({ order_item_product: allocation.order_item_product,
        gross_cents: String(allocation.gross_cents), net_cents: String(allocation.net_cents),
        tax_cents: String(allocation.tax_cents) })),
      // A credit note exists exactly when the money really went back.
      credit_notes: refund.credit_notes.map(note => ({ id: note.id, document_number: note.document_number,
        issued_at: note.issued_at, total_gross_cents: String(note.total_gross_cents) })),
      access_decisions: refund.access_decisions,
    }));
  }

  /** Refund list for the back office, newest first. */
  async list(statusInput: unknown, limitInput: unknown, cursorInput: unknown) {
    const status = statusInput === undefined || statusInput === '' ? null : String(statusInput);
    if (status !== null && !['requested', 'pending', 'succeeded', 'failed', 'cancelled'].includes(status)) {
      throw apiError(422, 'INVALID_STATE', 'Unbekannter Status.');
    }
    const limit = limitInput === undefined ? 25 : Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw apiError(422, 'INVALID_LIMIT', 'Ungültige Seitengröße.');
    const cursor = cursorInput === undefined ? undefined : requireUuid(String(cursorInput));
    const rows = await this.db.refund.findMany({ where: status ? { status } : {}, take: limit + 1,
      orderBy: [{ requested_at: 'desc' }, { id: 'desc' }], ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { order: { select: { order_number: true, buyer_email_canonical: true } } } });
    const data = rows.slice(0, limit).map(refund => ({ id: refund.id, order_id: refund.order_id,
      order_number: refund.order.order_number, buyer_email: refund.order.buyer_email_canonical,
      amount_cents: String(refund.amount_cents), currency: refund.currency, status: refund.status,
      provider: refund.provider, reason_code: refund.reason_code, requested_at: refund.requested_at,
      confirmed_at: refund.confirmed_at }));
    return { data, next_cursor: rows.length > limit && data.length ? data[data.length - 1].id : null };
  }

  /**
   * Propose a refund. Support may do this (`refunds.propose`); it moves no money.
   *
   * `idempotency_key` makes a repeated click harmless: the same key returns the
   * same row instead of two proposals. The check runs under a lock on the order,
   * and the trigger re-checks the sum, so two parallel requests for the same
   * cents cannot both succeed.
   *
   * `execute` turns the proposal into an actual, confirmed refund — that needs
   * `refunds.manage` and a fresh second factor on the route.
   */
  async propose(ctx: SessionContext, orderIdInput: string, input: unknown, execute: boolean) {
    const orderId = requireUuid(orderIdInput);
    const body = bodyObject(input, ['amount_cents', 'reason_code', 'note', 'idempotency_key',
      'allocations', 'provider_refund_id', 'auto_confirm']);
    const amountText = String(body.amount_cents ?? '');
    if (!/^[1-9][0-9]{0,11}$/.test(amountText)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { amount_cents: 'Betrag in Cent angeben.' });
    }
    const amount = BigInt(amountText);
    const reason = typeof body.reason_code === 'string' ? body.reason_code.trim() : '';
    if (!/^[a-z_]{3,60}$/.test(reason)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { reason_code: 'Bitte einen Grund angeben.' });
    }
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length > 500 || /[\u0000-\u001f]/.test(note)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { note: 'Ungültige Notiz.' });
    }
    const key = typeof body.idempotency_key === 'string' ? body.idempotency_key : '';
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(key)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte lade die Seite neu und versuche es erneut.',
        { idempotency_key: 'Ungültiger Schlüssel.' });
    }
    const providerRefundId = body.provider_refund_id === undefined || body.provider_refund_id === null ? null
      : String(body.provider_refund_id).trim();
    if (providerRefundId !== null && !/^[A-Za-z0-9_-]{4,120}$/.test(providerRefundId)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { provider_refund_id: 'Ungültige Referenz.' });
    }
    const allocationsInput = body.allocations === undefined ? [] : body.allocations;
    if (!Array.isArray(allocationsInput)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { allocations: 'Ungültige Aufteilung.' });
    }
    const allocations = allocationsInput.map(entry => {
      const row = (entry ?? {}) as Record<string, unknown>;
      const productId = requireUuid(String(row.order_item_product ?? ''));
      const gross = String(row.gross_cents ?? '');
      if (!/^[1-9][0-9]{0,11}$/.test(gross)) {
        throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { allocations: 'Ungültiger Betrag.' });
      }
      return { productId, gross: BigInt(gross) };
    });
    if (new Set(allocations.map(row => row.productId)).size !== allocations.length) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { allocations: 'Position doppelt.' });
    }
    const allocated = allocations.reduce((sum, row) => sum + row.gross, 0n);
    if (allocations.length && allocated !== amount) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.',
        { allocations: 'Die Aufteilung muss den Erstattungsbetrag ergeben.' });
    }
    const autoConfirm = body.auto_confirm === true;

    return this.transaction(async tx => {
      await this.staffActor(tx, ctx, execute ? 'refunds.manage' : 'refunds.propose');
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
      const replay = await tx.refund.findUnique({ where: { provider_idempotency_key: key } });
      if (replay) {
        if (replay.order_id !== orderId) throw apiError(409, 'CONFLICT', 'Dieser Schlüssel gehört zu einer anderen Bestellung.');
        if (String(replay.amount_cents) !== amountText) {
          throw apiError(409, 'CONFLICT', 'Dieser Schlüssel wurde bereits für einen anderen Betrag verwendet.');
        }
        return this.view(tx, replay.id);
      }
      const order = await tx.order.findUnique({ where: { id: orderId }, include: { attempts: true, invoice: true } });
      if (!order) throw missing();
      // A *partial* chargeback leaves money with us that the buyer may still be
      // owed, so `charged_back` is refundable in principle. What is left is
      // decided by the capacity below, which subtracts lost chargebacks — a
      // fully charged-back order therefore has nothing left to refund.
      if (order.payment_state !== 'paid' && order.payment_state !== 'refunded' &&
          order.payment_state !== 'charged_back') {
        throw apiError(409, 'ORDER_NOT_REFUNDABLE', 'Nur bezahlte Bestellungen können erstattet werden.');
      }
      const attempt = order.attempts.find(candidate => candidate.status === 'succeeded');
      if (!attempt) throw apiError(409, 'PAYMENT_NOT_TRACKED', 'Zu dieser Bestellung liegt kein bestätigter Zahlungsversuch vor.');
      // The provider decides how a refund happens: a transfer is confirmed by
      // the person who made it, a card refund by the provider's answer.
      const provider = attempt.provider === 'stripe' ? 'stripe' : 'invoice';
      // A card refund is never confirmed by us without the provider's reference:
      // doing so would claim that money moved.
      if (execute && provider === 'stripe' && !providerRefundId && !autoConfirm) {
        throw apiError(409, 'PROVIDER_REFUND_PENDING',
          'Kartenerstattungen werden beim Anbieter ausgelöst und danach mit dessen Referenz bestätigt.');
      }
      const capacity = await this.capacity(orderId, attempt.id, tx);
      if (!capacity || amount > capacity.refundable_cents) {
        throw apiError(409, 'REFUND_EXCEEDS_PAYMENT', 'Die Erstattung ist größer als der bestätigte Zahlbetrag.');
      }
      // Allocations must address positions of this order and never exceed what
      // is left of them across all refunds of the order.
      const positions = await tx.orderItem.findMany({ where: { order_id: orderId },
        select: { product_id: true, total_gross_cents: true } });
      const refundedByPosition = await tx.refundAllocation.groupBy({ by: ['order_item_product'],
        where: { order_id: orderId, refund: { status: { in: ['requested', 'pending', 'succeeded'] } } },
        _sum: { gross_cents: true } });
      const usedByPosition = new Map(refundedByPosition.map(row => [row.order_item_product, row._sum.gross_cents ?? 0n]));
      for (const allocation of allocations) {
        const position = positions.find(row => row.product_id === allocation.productId);
        if (!position) throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.',
          { allocations: 'Position gehört nicht zu dieser Bestellung.' });
        const used = usedByPosition.get(allocation.productId) ?? 0n;
        if (allocation.gross > position.total_gross_cents - used) {
          throw apiError(409, 'REFUND_EXCEEDS_POSITION',
            'Die Erstattung ist größer als der noch erstattbare Betrag dieser Position.');
        }
      }

      const now = new Date();
      // A proposal is 'requested'. Executing a transfer refund needs nothing from
      // a provider (the money is sent by hand), so it settles immediately; a
      // card refund settles only once the provider reference is known.
      const status = !execute ? 'requested'
        : provider === 'invoice' || providerRefundId || autoConfirm ? 'succeeded' : 'pending';
      // A confirmed refund must name the provider reference; the database
      // enforces this too, so a hand-written row cannot skip it either.
      const providerReference = provider === 'stripe'
        ? providerRefundId ?? (autoConfirm ? `manual-${key.slice(0, 40)}` : null) : null;
      const refundId = uuidv7();
      await tx.refund.create({ data: { id: refundId, order_id: orderId, payment_attempt_id: attempt.id,
        provider, environment: getConfig().appEnv === 'production' ? 'live' : 'test',
        provider_refund_id: providerReference, provider_idempotency_key: key, amount_cents: amount,
        currency: order.currency, status, reason_code: reason, note: note || null,
        requested_by: ctx.user.id, requested_at: now, confirmed_at: status === 'succeeded' ? now : null } });
      for (const allocation of allocations) {
        await tx.refundAllocation.create({ data: { refund_id: refundId, order_id: orderId,
          order_item_product: allocation.productId, gross_cents: allocation.gross } });
      }

      if (status === 'succeeded') {
        // The document first, then the booking: the buyer's mail names the
        // correction number, so it must exist before the mail is queued.
        await this.issueCreditNote(tx, refundId);
        await this.settle(tx, ctx, refundId);
        await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: ctx.user.id, origin: 'user',
          action: 'refund.confirmed', target_type: 'refund', target_ref: refundId,
          after_safe: { order_id: orderId, amount_cents: amountText, provider, reason_code: reason } } });
      } else {
        await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: ctx.user.id, origin: 'user',
          action: status === 'pending' ? 'refund.requested' : 'refund.proposed', target_type: 'refund',
          target_ref: refundId,
          after_safe: { order_id: orderId, amount_cents: amountText, provider, reason_code: reason } } });
      }
      return this.view(tx, refundId);
    });
  }

  /**
   * Confirm a refund the provider reported as done.
   *
   * Idempotent: confirming twice returns the settled state instead of issuing a
   * second credit note.
   */
  async confirm(ctx: SessionContext, refundIdInput: string, input: unknown) {
    const refundId = requireUuid(refundIdInput);
    const body = bodyObject(input, ['provider_refund_id']);
    const providerRefundId = body.provider_refund_id === undefined || body.provider_refund_id === null ? null
      : String(body.provider_refund_id).trim();
    if (providerRefundId !== null && !/^[A-Za-z0-9_-]{4,120}$/.test(providerRefundId)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { provider_refund_id: 'Ungültige Referenz.' });
    }
    return this.transaction(async tx => {
      await this.staffActor(tx, ctx, 'refunds.manage');
      const current = await tx.refund.findUnique({ where: { id: refundId } });
      if (!current) throw missing();
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${current.order_id}::uuid FOR UPDATE`;
      const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
      if (refund.status === 'succeeded') return this.view(tx, refundId);
      if (refund.status !== 'pending' && refund.status !== 'requested') {
        throw apiError(409, 'REFUND_NOT_OPEN', 'Diese Erstattung ist nicht mehr offen.');
      }
      // Executing somebody's proposal is the step that moves money: the card
      // path must name the provider reference, the transfer path needs nothing.
      if (refund.provider === 'stripe' && !providerRefundId && !refund.provider_refund_id) {
        throw apiError(409, 'PROVIDER_REFUND_REFERENCE_REQUIRED', 'Bitte die Referenz der Anbieter-Erstattung angeben.');
      }
      await tx.refund.update({ where: { id: refundId }, data: { status: 'succeeded', confirmed_at: new Date(),
        ...(providerRefundId ? { provider_refund_id: providerRefundId } : {}) } });
      await this.issueCreditNote(tx, refundId);
      await this.settle(tx, ctx, refundId);
      await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: ctx.user.id, origin: 'user',
        action: 'refund.confirmed', target_type: 'refund', target_ref: refundId,
        after_safe: { order_id: refund.order_id, amount_cents: String(refund.amount_cents) } } });
      return this.view(tx, refundId);
    });
  }

  /** Mark a refund as failed: no money moved, the capacity is free again. */
  async fail(ctx: SessionContext, refundIdInput: string, input: unknown) {
    const refundId = requireUuid(refundIdInput);
    const body = bodyObject(input, ['error_code']);
    const errorCode = typeof body.error_code === 'string' ? body.error_code.trim() : '';
    if (!/^[a-z_]{3,60}$/.test(errorCode)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { error_code: 'Bitte einen Fehlergrund angeben.' });
    }
    return this.transaction(async tx => {
      await this.staffActor(tx, ctx, 'refunds.manage');
      const current = await tx.refund.findUnique({ where: { id: refundId } });
      if (!current) throw missing();
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${current.order_id}::uuid FOR UPDATE`;
      const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
      if (refund.status === 'failed') return this.view(tx, refundId);
      if (refund.status !== 'pending' && refund.status !== 'requested') {
        throw apiError(409, 'REFUND_NOT_OPEN', 'Diese Erstattung ist nicht mehr offen.');
      }
      await tx.refund.update({ where: { id: refundId }, data: { status: 'failed', last_error_safe: errorCode } });
      await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: ctx.user.id, origin: 'user',
        action: 'refund.failed', target_type: 'refund', target_ref: refundId, after_safe: { error_code: errorCode } } });
      return this.view(tx, refundId);
    });
  }

  /**
   * Record what happens to the access an order created.
   *
   * Shared by refunds and disputes on purpose: the question is identical ("does
   * the learner keep the course?") and the answer must be recorded the same way,
   * whichever case triggered it. `kept` is a decision like any other and is
   * therefore stored — a missing row means "not decided yet", never "revoked".
   *
   * `revoked` and `suspended` touch the access rows; a grant that has not
   * started yet is suspended rather than revoked, because the money question may
   * still be clarified and the grant is not worthless — a cancelled future grant
   * cannot be resumed as easily as a suspended one.
   *
   * A **provisional** decision (a running chargeback) is either `kept` or
   * `suspended`, and it always suspends an exception: while the bank decides, the
   * money may be gone tomorrow, so no new access may start. Only a resolved case
   * may revoke.
   */
  async decideAccessFor(ctx: SessionContext, origin: { refundId?: string; disputeId?: string,
    orderId: string }, input: unknown, options: { provisional?: boolean } = {}) {
    const body = bodyObject(input, ['decision', 'reason', 'access_ids']);
    const decision = body.decision;
    if (decision !== 'revoked' && decision !== 'kept' && decision !== 'suspended') {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { decision: 'Bitte entscheiden.' });
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!/^[a-z_]{3,60}$/.test(reason)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { reason: 'Bitte einen Grund angeben.' });
    }
    const only = body.access_ids === undefined ? null : body.access_ids;
    if (only !== null && (!Array.isArray(only) || !only.every(id => typeof id === 'string'))) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { access_ids: 'Ungültige Auswahl.' });
    }
    return this.transaction(async tx => {
      await this.staffActor(tx, ctx, 'access.manage');
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${origin.orderId}::uuid FOR UPDATE`;
      const accesses = await tx.courseAccess.findMany({ where: { order_id: origin.orderId,
        ...(only === null ? {} : { id: { in: only as string[] } }) }, orderBy: { starts_at: 'asc' } });
      if (only !== null && accesses.length !== new Set(only).size) {
        throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { access_ids: 'Unbekannter Zugang.' });
      }
      const now = new Date();
      for (const access of accesses) {
        // The decision is written first and the access row second — the trigger
        // refuses a suspension/revocation that has no decision yet.
        await tx.orderAccessDecision.create({ data: { id: uuidv7(), order_id: origin.orderId,
          refund_id: origin.refundId ?? null, dispute_id: origin.disputeId ?? null, access_id: access.id,
          decision, reason, decided_by: ctx.user.id, decided_at: now } });
        if (decision === 'kept') {
          // `kept` lifts a previous suspension only once the case is over. During
          // a running case it records the intent to keep the access but leaves the
          // suspension in place: the money question is still open, so nothing
          // starts in the meantime.
          if (!options.provisional && (access.revoked_at || access.suspended_at)) {
            await tx.courseAccess.update({ where: { id: access.id },
              data: { suspended_at: null, suspend_reason: null } });
          } else if (options.provisional && !access.revoked_at && !access.suspended_at &&
                     access.starts_at > now) {
            await tx.courseAccess.update({ where: { id: access.id },
              data: { suspended_at: now, suspend_reason: reason } });
          }
        } else if (decision === 'suspended') {
          if (!access.revoked_at) {
            await tx.courseAccess.update({ where: { id: access.id },
              data: { suspended_at: access.suspended_at ?? now, suspend_reason: reason } });
          }
        } else if (!access.revoked_at) {
          // Suspension ends in revocation: the reason names both, so the history
          // of the row stays readable.
          await tx.courseAccess.update({ where: { id: access.id }, data: { revoked_at: now,
            revoke_reason: reason, suspended_at: null, suspend_reason: null } });
        }
      }
      if (!accesses.length) {
        // A decision without access is still a decision: it documents that the
        // question was asked and answered (e.g. a manual grant that never existed).
        await tx.orderAccessDecision.create({ data: { id: uuidv7(), order_id: origin.orderId,
          refund_id: origin.refundId ?? null, dispute_id: origin.disputeId ?? null, access_id: null,
          decision, reason, decided_by: ctx.user.id, decided_at: now } });
      }
      await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: ctx.user.id, origin: 'user',
        action: origin.disputeId ? 'access.decided_after_dispute' : 'access.decided_after_refund',
        target_type: origin.disputeId ? 'dispute' : 'refund', target_ref: origin.disputeId ?? origin.refundId!,
        after_safe: { decision, reason, access_count: accesses.length } } });
      return { order_id: origin.orderId, decision, reason, access_count: accesses.length };
    });
  }

  /** Access decision for a refund (the dispute path goes through `Disputes`). */
  async decideAccess(ctx: SessionContext, refundIdInput: string, input: unknown) {
    const refundId = requireUuid(refundIdInput);
    const refund = await this.db.refund.findUnique({ where: { id: refundId }, select: { order_id: true, status: true } });
    if (!refund) throw missing();
    if (refund.status !== 'succeeded') {
      throw apiError(409, 'REFUND_NOT_SETTLED', 'Erst nach bestätigter Erstattung wird über den Zugang entschieden.');
    }
    await this.decideAccessFor(ctx, { refundId, orderId: refund.order_id }, input);
    return this.view(this.db, refundId);
  }

  /** One refund with everything a support case needs. */
  async view(tx: Prisma.TransactionClient, refundId: string) {
    const refund = await tx.refund.findUnique({ where: { id: refundId }, include: {
      allocations: true, credit_notes: true,
      access_decisions: { orderBy: { decided_at: 'asc' } },
      order: { select: { id: true, order_number: true, total_gross_cents: true, payment_state: true,
        refunded_at: true, user_id: true, buyer_email_original: true } } } });
    if (!refund) throw missing();
    // Read through the caller's transaction: an uncommitted refund already moved
    // money from the perspective of this booking.
    const capacity = await this.capacity(refund.order_id, undefined, tx);
    return {
      id: refund.id, order_id: refund.order_id, order_number: refund.order.order_number,
      amount_cents: String(refund.amount_cents), currency: refund.currency, status: refund.status,
      provider: refund.provider, environment: refund.environment, reason_code: refund.reason_code,
      note: refund.note, requested_at: refund.requested_at, confirmed_at: refund.confirmed_at,
      provider_refund_id: refund.provider_refund_id, last_error_safe: refund.last_error_safe,
      payment: { paid_cents: String(capacity?.paid_cents ?? 0n), refunded_cents: String(capacity?.refunded_cents ?? 0n),
        charged_back_cents: String(capacity?.charged_back_cents ?? 0n),
        refundable_cents: String(capacity?.refundable_cents ?? 0n) },
      order: { id: refund.order.id, order_number: refund.order.order_number,
        payment_state: refund.order.payment_state, refunded_at: refund.order.refunded_at,
        total_gross_cents: String(refund.order.total_gross_cents) },
      allocations: refund.allocations.map(allocation => ({ order_item_product: allocation.order_item_product,
        gross_cents: String(allocation.gross_cents), net_cents: String(allocation.net_cents),
        tax_cents: String(allocation.tax_cents) })),
      credit_notes: refund.credit_notes.map(note => ({ id: note.id, document_number: note.document_number,
        issued_at: note.issued_at, total_gross_cents: String(note.total_gross_cents) })),
      access_decisions: refund.access_decisions.map(decision => ({ id: decision.id, access_id: decision.access_id,
        decision: decision.decision, reason: decision.reason, decided_at: decision.decided_at })),
    };
  }

  /**
   * Bookkeeping after the money moved.
   *
   * The order only becomes `refunded` when the confirmed refunds cover the whole
   * payment. A partial refund leaves `paid` — the order is still a paid order
   * that happens to have part of its money back, and the refund rows say so.
   */
  private async settle(tx: Prisma.TransactionClient, ctx: SessionContext, refundId: string) {
    const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId },
      include: { order: true } });
    const sum = await tx.refund.aggregate({ where: { order_id: refund.order_id, status: 'succeeded' },
      _sum: { amount_cents: true } });
    const refunded = sum._sum.amount_cents ?? 0n;
    const full = refunded >= refund.order.total_gross_cents;
    if (full && refund.order.payment_state !== 'refunded') {
      await tx.order.update({ where: { id: refund.order_id }, data: { payment_state: 'refunded',
        refunded_at: refund.confirmed_at ?? new Date() } });
    }
    // The buyer learns about the money and the correction document — a guest
    // through the address they proved at checkout, an account holder through
    // their own mail. Nothing here grants or revokes access; that stays a human
    // decision (`decideAccess`).
    const email = refund.order.buyer_email_original;
    if (email) {
      const owner = refund.order.user_id;
      const buyer = owner ? await tx.user.findUnique({ where: { id: owner }, select: { first_name: true } }) : null;
      const firstName = buyer?.first_name || refund.order.guest_participant_first_name || 'du';
      const variables = { order_number: refund.order.order_number, total: centsToText(refund.amount_cents),
        credit_note_number: (await tx.creditNote.findFirst({ where: { refund_id: refundId },
          select: { document_number: true } }))?.document_number ?? 'wird nachgereicht' };
      if (owner) await this.outbox.notify(tx, owner, email, firstName, 'refund_confirmed', variables);
      else await this.outbox.notifyGuest(tx, email, firstName, 'refund_confirmed', variables);
    }
    void ctx;
  }

  /**
   * The credit note for a settled refund.
   *
   * One per refund, numbered from its own sequence, with frozen snapshots: the
   * correction of an invoice must stay reconstructible even if the invoice
   * snapshot format changes later. Without an original invoice (card payment)
   * there is nothing to correct — the refund rows remain the record.
   */
  private async issueCreditNote(tx: Prisma.TransactionClient, refundId: string) {
    const existing = await tx.creditNote.findFirst({ where: { refund_id: refundId } });
    if (existing) return;
    const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId }, include: {
      allocations: true, order: { include: { invoice: true, items: { orderBy: { position: 'asc' } } } } } });
    const invoice = refund.order.invoice;
    if (!invoice) return;
    const numberRow = await tx.$queryRaw<{ number: string }[]>`SELECT trainerb_next_order_number('TB-GS-', 'credit_note_number_seq') AS number`;
    const allocated = new Map(refund.allocations.map(row => [row.order_item_product, row.gross_cents]));
    const items = refund.order.items.filter(item => allocated.size === 0 || allocated.has(item.product_id));
    const lines = items.map((item, index) => ({ position: index + 1, title: item.title_snapshot,
      variant: item.variant_snapshot, quantity: item.quantity,
      unit_gross_cents: String(allocated.get(item.product_id) ?? item.unit_gross_cents),
      discount_cents: '0', total_gross_cents: String(allocated.get(item.product_id) ?? item.total_gross_cents) }));
    await tx.creditNote.create({ data: { id: uuidv7(), order_id: refund.order_id, refund_id: refund.id,
      original_invoice_id: invoice.id, document_number: numberRow[0].number,
      issuer_snapshot: invoice.seller_snapshot as Prisma.InputJsonValue,
      buyer_snapshot: invoice.buyer_snapshot as Prisma.InputJsonValue,
      lines_snapshot: lines as Prisma.InputJsonValue,
      total_gross_cents: refund.amount_cents, currency: refund.currency,
      reason_code: refund.reason_code, note: refund.note,
      recipient_email: invoice.recipient_email } });
  }

  private render(creditNote: { document_number: string; issued_at: Date; issuer_snapshot: unknown;
    buyer_snapshot: unknown; lines_snapshot: unknown; total_gross_cents: bigint; currency: string;
    reason_code: string; note: string | null; recipient_email: string | null;
    original_invoice?: { invoice_number: string } | null }) {
    return renderInvoicePdf({
      invoice_number: creditNote.document_number, issued_at: creditNote.issued_at,
      seller_snapshot: creditNote.issuer_snapshot, buyer_snapshot: creditNote.buyer_snapshot,
      lines_snapshot: creditNote.lines_snapshot, total_gross_cents: creditNote.total_gross_cents,
      currency: creditNote.currency, due_at: null, payment_reference: null,
      recipient_email: creditNote.recipient_email,
      document: { kind: 'credit_note', title: 'Gutschrift',
        references: creditNote.original_invoice
          ? [{ label: 'Ursprungsrechnung', value: creditNote.original_invoice.invoice_number }] : [],
        note: `Grund: ${creditNote.reason_code.replace(/_/g, ' ')}` },
    });
  }

  /**
   * Credit notes of the signed-in account, newest first.
   *
   * Only a settled refund has a document, and only its owner or staff may see
   * it: a correction names an address and a return reason.
   */
  async listMine(ctx: SessionContext) {
    const rows = await this.db.creditNote.findMany({ where: { order: { user_id: ctx.user.id } },
      include: { order: { select: { order_number: true } }, refund: { select: { status: true } } },
      orderBy: [{ issued_at: 'desc' }, { id: 'desc' }], take: 100 });
    return { data: rows.map(note => ({ id: note.id, document_number: note.document_number,
      issued_at: note.issued_at, order_id: note.order_id, order_number: note.order.order_number,
      total_gross_cents: String(note.total_gross_cents), currency: note.currency,
      reason_code: note.reason_code, refund_status: note.refund.status })) };
  }

  async download(ctx: SessionContext, creditNoteIdInput: string) {
    const creditNoteId = requireUuid(creditNoteIdInput);
    const note = await this.db.creditNote.findUnique({ where: { id: creditNoteId },
      include: { original_invoice: { select: { invoice_number: true } },
        order: { select: { user_id: true } } } });
    if (!note) throw missing();
    const staff = ctx.session.kind === 'backoffice' && ctx.permissionKeys.has('orders.read');
    const owner = note.order.user_id !== null && note.order.user_id === ctx.user.id;
    if (!staff && !owner) throw missing();
    return { fileName: creditNoteFileName(note.document_number), content: this.render(note) };
  }

  async downloadForStaff(creditNoteIdInput: string) {
    const creditNoteId = requireUuid(creditNoteIdInput);
    const note = await this.db.creditNote.findUnique({ where: { id: creditNoteId },
      include: { original_invoice: { select: { invoice_number: true } } } });
    if (!note) throw missing();
    return { fileName: creditNoteFileName(note.document_number), content: this.render(note) };
  }
}
