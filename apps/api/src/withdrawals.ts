import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { Sessions, type SessionContext } from './sessions';
import { Outbox } from './outbox';
import { RateLimiter } from './limiter';
import { apiError, bodyObject, keyedHash, normalizeEmail, randomToken, requireUuid } from './security';
import { getConfig } from './config';

const missing = () => apiError(404, 'NOT_FOUND', 'Nicht gefunden.');

/** Every outcome of a decision; `received` is only the entry state. */
const CASE_STATUSES = ['received', 'identity_check', 'in_progress', 'completed', 'rejected'] as const;

/**
 * The only decision codes a closed case may carry.
 *
 * A free-text reason would be a data-quality trap: every filter, report and
 * export would quietly miss the cases whose reason happened to be spelled
 * differently. The database enforces the same list.
 */
export const DECISION_REASONS = {
  withdrawal_accepted: 'Widerruf angenommen',
  withdrawal_declined: 'Widerruf abgelehnt',
  order_not_found: 'Keine passende Bestellung auffindbar',
  outside_statutory_period: 'Frist abgelaufen',
  digital_content_started: 'Digitale Inhalte wurden bereits begonnen',
  duplicate_request: 'Doppelter Vorgang',
  identity_unconfirmed: 'Adresse blieb unbestätigt',
} as const;

const isDecisionReason = (value: string): boolean =>
  (Object.keys(DECISION_REASONS) as string[]).includes(value);

/** Reasons that may close a case that has no order — the honest way out. */
const CLOSABLE_WITHOUT_ORDER: readonly string[] =
  ['order_not_found', 'identity_unconfirmed', 'duplicate_request'];

/**
 * Withdrawals (Widerruf).
 *
 * This is the weakest input in the system: no session, an unverified address and
 * an order number that anyone could type. Three rules follow from that:
 *
 *  1. **The request is a claim, not a fact.** It never refunds, never changes an
 *     order and never links itself to one. Only staff link an order, and only
 *     after the identity is checked. A confirmation mail goes out to the
 *     submitting address — that is the "durable medium" the law asks for, and it
 *     goes through the same outbox as every other transactional mail.
 *  2. **The answer never leaks.** The public response is identical whether the
 *     address or order number is known, unknown or malformed. There is no "this
 *     order exists" signal between entering the address and proving it.
 *  3. **A withdrawal is not a refund.** Refunding stays a separate, explicit
 *     action by a person with `refunds.manage`; this module only records that a
 *     person withdrew and produces an auditable case file.
 */
@Injectable()
export class Withdrawals {
  constructor(private readonly db: Database, private readonly sessions: Sessions,
              private readonly outbox: Outbox, private readonly limiter: RateLimiter) {}

  private async staffActor(tx: Prisma.TransactionClient, ctx: SessionContext, permission: string) {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.user.id}::uuid FOR UPDATE`;
    await this.sessions.assertCurrent(tx, ctx);
    if (ctx.session.kind !== 'backoffice' || !ctx.permissionKeys.has(permission)) {
      throw apiError(403, 'FORBIDDEN', 'Kein Zugriff.');
    }
  }

  /**
   * Public submission. Always answers the same way, in the same shape.
   *
   * Throttled per address hash and per IP: without a login this endpoint is the
   * cheapest way to flood the queue or to probe for known addresses, so both
   * limits exist and neither reveals whether the address is known.
   */
  async submit(input: unknown, request: { ip: string }): Promise<{ received: true }> {
    const body = bodyObject(input, ['contact_email', 'customer_name', 'order_number', 'message']);
    const emailRaw = typeof body.contact_email === 'string' ? body.contact_email.trim() : '';
    if (emailRaw.length > 254) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { contact_email: 'Ungültige Adresse.' });
    }
    // `normalizeEmail` throws for a malformed address; the public answer must not
    // differ between "bad address" and "unknown address", but a malformed one is
    // the sender's own error and may be named.
    const email = normalizeEmail(emailRaw);
    const name = typeof body.customer_name === 'string' ? body.customer_name.trim() : '';
    if (name.length > 200 || /[\u0000-\u001f]/.test(name)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { customer_name: 'Ungültiger Name.' });
    }
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (message.length > 2000 || /[\u0000-\u001f]/.test(message)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { message: 'Ungültiger Text.' });
    }
    const orderNumber = typeof body.order_number === 'string' ? body.order_number.trim() : '';
    if (orderNumber.length > 40 || (orderNumber && !/^[A-Za-z0-9-]{3,40}$/.test(orderNumber))) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { order_number: 'Ungültige Bestellnummer.' });
    }

    const emailHmac = keyedHash(getConfig().auditKey, 'withdrawal-email', email.canonical);
    await this.limiter.hit('withdrawal-ip', request.ip, 10, 60 * 60_000);
    // Five per address per day is enough for a real person and stops someone
    // from turning a known address into a mail bomb.
    await this.limiter.hit('withdrawal-email', emailHmac.toString('hex'), 5, 24 * 60 * 60_000);

    await this.db.$transaction(async tx => {
      const id = uuidv7();
      const now = new Date();
      // The first name is only a greeting for the confirmation mail; it is not
      // taken from any account, because nothing here is verified yet.
      const firstName = name.split(/\s+/)[0] || 'du';
      const outboxId = await this.outbox.notifyGuest(tx, email.original, firstName, 'withdrawal_received', {
        received_date: `${String(now.getUTCDate()).padStart(2, '0')}.${String(now.getUTCMonth() + 1).padStart(2, '0')}.${now.getUTCFullYear()}`,
        received_time: `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`,
      });
      await tx.withdrawalRequest.create({ data: { id, submitted_order_number: orderNumber || null,
        contact_email: email.original, contact_email_hmac: emailHmac, customer_name: name || null,
        message: message || null, status: 'received', submitted_at: now, confirmation_outbox_id: outboxId } });
      await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: null, origin: 'user',
        action: 'withdrawal.received', target_type: 'withdrawal_request', target_ref: id,
        after_safe: { has_order_number: Boolean(orderNumber), has_message: Boolean(message) } } });
    });
    return { received: true };
  }

  /** Case file list for staff. */
  async list(statusInput: unknown, limitInput: unknown, cursorInput: unknown) {
    const status = statusInput === undefined || statusInput === '' ? null : String(statusInput);
    if (status !== null && !(CASE_STATUSES as readonly string[]).includes(status)) {
      throw apiError(422, 'INVALID_STATE', 'Unbekannter Status.');
    }
    const limit = limitInput === undefined ? 25 : Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw apiError(422, 'INVALID_LIMIT', 'Ungültige Seitengröße.');
    const cursor = cursorInput === undefined ? undefined : requireUuid(String(cursorInput));
    const rows = await this.db.withdrawalRequest.findMany({ where: status ? { status } : {},
      take: limit + 1, orderBy: [{ submitted_at: 'asc' }, { id: 'asc' }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { order: { select: { order_number: true, payment_state: true } } } });
    const data = rows.slice(0, limit).map(item => ({ id: item.id, contact_email: item.contact_email,
      customer_name: item.customer_name, message: item.message, status: item.status,
      submitted_at: item.submitted_at, submitted_order_number: item.submitted_order_number,
      order: item.order ? { order_number: item.order.order_number, payment_state: item.order.payment_state } : null,
      identity_verified_at: item.identity_verified_at, processed_at: item.processed_at,
      refund_id: item.refund_id }));
    // Oldest first: a withdrawal has a legal clock, so the queue is FIFO.
    return { data, next_cursor: rows.length > limit && data.length ? data[data.length - 1].id : null,
      totals: { received: await this.db.withdrawalRequest.count({ where: { status: 'received' } }),
        in_progress: await this.db.withdrawalRequest.count({ where: { status: { in: ['identity_check', 'in_progress'] } } }) } };
  }

  /** Reads through the caller's transaction, so a write sees its own result. */
  async view(caseId: string, tx: Prisma.TransactionClient | Database = this.db) {
    const item = await tx.withdrawalRequest.findUnique({ where: { id: caseId },
      include: { order: { select: { id: true, order_number: true, payment_state: true, total_gross_cents: true } },
        refund: { select: { id: true, status: true, amount_cents: true } },
        processor: { select: { id: true, first_name: true, last_name: true } } } });
    if (!item) throw missing();
    return { id: item.id, contact_email: item.contact_email, customer_name: item.customer_name,
      message: item.message, status: item.status, submitted_at: item.submitted_at,
      submitted_order_number: item.submitted_order_number,
      order: item.order ? { id: item.order.id, order_number: item.order.order_number,
        payment_state: item.order.payment_state, total_gross_cents: String(item.order.total_gross_cents) } : null,
      identity_verified_at: item.identity_verified_at,
      processed_at: item.processed_at, decision_reason: item.decision_reason,
      processor: item.processor ? `${item.processor.first_name} ${item.processor.last_name}` : null,
      refund: item.refund ? { id: item.refund.id, status: item.refund.status,
        amount_cents: String(item.refund.amount_cents) } : null };
  }

  /**
   * Send a single-use proof link to the address the person entered.
   *
   * Staff trigger this; the sender is the only one who can open the link. That
   * keeps the rule "the claim becomes real only after the address is proved"
   * while never trusting the address typed into a public form.
   */
  async sendIdentityCode(ctx: SessionContext, caseIdInput: string) {
    const caseId = requireUuid(caseIdInput);
    return this.db.$transaction(async tx => {
      await this.staffActor(tx, ctx, 'withdrawals.manage');
      await tx.$queryRaw`SELECT id FROM withdrawal_requests WHERE id = ${caseId}::uuid FOR UPDATE`;
      const item = await tx.withdrawalRequest.findUnique({ where: { id: caseId } });
      if (!item) throw missing();
      if (item.status === 'completed' || item.status === 'rejected') {
        throw apiError(409, 'WITHDRAWAL_CLOSED', 'Dieser Vorgang ist bereits abgeschlossen.');
      }
      if (item.identity_verified_at) {
        throw apiError(409, 'WITHDRAWAL_ALREADY_VERIFIED', 'Diese Adresse ist bereits bestätigt.');
      }
      const now = new Date();
      // A new link replaces the old one: two open proofs for one case would mean
      // two ways in.
      await tx.withdrawalVerification.updateMany({ where: { request_id: caseId, verified_at: null,
        consumed_at: null }, data: { consumed_at: now } });
      const token = randomToken();
      await tx.withdrawalVerification.create({ data: { id: uuidv7(), request_id: caseId,
        token_hash: keyedHash(getConfig().tokenKey, 'withdrawal-verify', token),
        expires_at: new Date(now.getTime() + 30 * 60_000) } });
      // `verification_url` is secret and sealed; the public variables carry the
      // submission facts only.
      const outboxId = await this.outbox.notifyGuestCoded(tx, item.contact_email, 'du',
        'withdrawal_verify', { request_reference: caseId.slice(0, 8) }, token,
        { purpose: 'withdrawal' });
      await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: ctx.user.id, origin: 'user',
        action: 'withdrawal.identity_code_sent', target_type: 'withdrawal_request', target_ref: caseId } });
      return { id: caseId, outbox_id: outboxId, expires_in_minutes: 30 };
    });
  }

  /**
   * The sender opens the link. This is the only place an address becomes
   * verified — and it verifies the address, not the order.
   */
  async verify(tokenInput: unknown): Promise<{ verified: true }> {
    const body = bodyObject(tokenInput, ['token']);
    const token = typeof body.token === 'string' ? body.token : '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw apiError(400, 'INVALID_TOKEN', 'Dieser Link ist ungültig.');
    return this.db.$transaction(async tx => {
      const proof = await tx.withdrawalVerification.findUnique({
        where: { token_hash: keyedHash(getConfig().tokenKey, 'withdrawal-verify', token) },
        include: { request: true } });
      if (!proof) throw apiError(400, 'INVALID_TOKEN', 'Dieser Link ist ungültig.');
      if (proof.consumed_at || proof.verified_at) {
        throw apiError(409, 'TOKEN_USED', 'Dieser Link wurde bereits verwendet.');
      }
      if (proof.expires_at <= new Date()) {
        throw apiError(409, 'TOKEN_EXPIRED', 'Dieser Link ist abgelaufen.');
      }
      await tx.$queryRaw`SELECT id FROM withdrawal_requests WHERE id = ${proof.request_id}::uuid FOR UPDATE`;
      const item = await tx.withdrawalRequest.findUniqueOrThrow({ where: { id: proof.request_id } });
      if (item.status === 'completed' || item.status === 'rejected') {
        throw apiError(409, 'WITHDRAWAL_CLOSED', 'Dieser Vorgang ist bereits abgeschlossen.');
      }
      const now = new Date();
      await tx.withdrawalVerification.update({ where: { id: proof.id },
        data: { verified_at: now, consumed_at: now } });
      // A proved address moves the case to the identity check; it links nothing.
      await tx.withdrawalRequest.update({ where: { id: proof.request_id },
        data: { identity_verified_at: now,
          ...(item.status === 'received' ? { status: 'identity_check' } : {}) } });
      await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: null, origin: 'user',
        action: 'withdrawal.identity_verified', target_type: 'withdrawal_request', target_ref: proof.request_id } });
      return { verified: true };
    });
  }

  /**
   * Move a case forward, verify the identity, or decide it.
   *
   * Linking an order is the step that turns a stranger's claim into a case about
   * a real purchase, so it needs the identity to be verified first. The link
   * itself changes nothing about the order — refunding is a separate action with
   * its own permission.
   */
  async update(ctx: SessionContext, caseIdInput: string, input: unknown) {
    const caseId = requireUuid(caseIdInput);
    const body = bodyObject(input, ['status', 'order_id', 'decision_reason']);
    const status = body.status === undefined ? null : body.status;
    if (status !== null && (typeof status !== 'string' || !(CASE_STATUSES as readonly string[]).includes(status))) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { status: 'Unbekannter Status.' });
    }
    const reason = body.decision_reason === undefined || body.decision_reason === null ? null
      : String(body.decision_reason).trim();
    if (reason !== null && !isDecisionReason(reason)) {
      // The catalogue is the API contract; an unknown code is a client bug, not a
      // note. Anything a person needs to say belongs in `message`, not here.
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.',
        { decision_reason: 'Unbekannter Entscheidungsgrund.' });
    }
    if ((status === 'completed' || status === 'rejected') && reason === null) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.',
        { decision_reason: 'Ein Abschluss braucht einen Grund.' });
    }
    return this.db.$transaction(async tx => {
      await this.staffActor(tx, ctx, 'withdrawals.manage');
      await tx.$queryRaw`SELECT id FROM withdrawal_requests WHERE id = ${caseId}::uuid FOR UPDATE`;
      const item = await tx.withdrawalRequest.findUnique({ where: { id: caseId } });
      if (!item) throw missing();
      if (item.status === 'completed' || item.status === 'rejected') {
        throw apiError(409, 'WITHDRAWAL_CLOSED', 'Dieser Vorgang ist bereits abgeschlossen.');
      }
      let orderId = item.order_id;
      const verifiedAt = item.identity_verified_at;
      if (body.order_id !== undefined && body.order_id !== null) {
        const linked = requireUuid(String(body.order_id));
        const order = await tx.order.findUnique({ where: { id: linked },
          select: { id: true, buyer_email_canonical: true, payment_state: true } });
        if (!order) throw missing();
        // The claim is still a stranger's until the address is proved. The link
        // is the step that would tie it to a real purchase, so it comes second.
        if (verifiedAt === null) {
          throw apiError(409, 'WITHDRAWAL_IDENTITY_REQUIRED',
            'Bitte zuerst die Adresse bestätigen lassen, bevor die Bestellung zugeordnet wird.');
        }
        // Compared canonically: the sender types their address in whatever shape
        // they like, and an order stores the normalized form.
        if (order.buyer_email_canonical !== normalizeEmail(item.contact_email).canonical) {
          // A proved address that does not belong to the linked order would turn
          // one person's claim into another person's case.
          throw apiError(409, 'WITHDRAWAL_ORDER_MISMATCH',
            'Die Bestellung gehört nicht zu der bestätigten Adresse.');
        }
        orderId = order.id;
      }
      const now = new Date();
      const nextStatus = status ?? (verifiedAt && item.status === 'received' ? 'identity_check' : item.status);
      const closing = nextStatus === 'completed' || nextStatus === 'rejected';
      // Accepting a withdrawal always names the purchase it cancels. Declining
      // does not: "I cannot find a matching order" is a legitimate outcome, and
      // without it such a case would sit in the queue forever. The database
      // limits which reasons may close a case without an order.
      if (closing && orderId === null && nextStatus === 'completed') {
        throw apiError(409, 'WITHDRAWAL_ORDER_REQUIRED',
          'Ein angenommener Widerruf braucht die zugehörige Bestellung. Ohne sie lässt er sich nur ablehnen.');
      }
      if (closing && orderId === null && reason !== null && !CLOSABLE_WITHOUT_ORDER.includes(reason)) {
        throw apiError(409, 'WITHDRAWAL_CLOSE_REASON',
          'Ohne Bestellung lässt sich der Vorgang nur mit einem Grund schließen, der das erklärt.');
      }
      await tx.withdrawalRequest.update({ where: { id: caseId }, data: { status: nextStatus,
        order_id: orderId, identity_verified_at: verifiedAt,
        ...(closing ? { processed_by: ctx.user.id, processed_at: now, decision_reason: reason } : {}) } });
      await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: ctx.user.id, origin: 'user',
        action: 'withdrawal.updated', target_type: 'withdrawal_request', target_ref: caseId,
        after_safe: { status: nextStatus, previous_status: item.status, order_linked: orderId !== null,
          identity_verified: verifiedAt !== null, decision_reason: reason } } });
      if (closing) {
        // The outcome is communicated on a durable medium, like the receipt.
        const variables = { decision: nextStatus === 'completed' ? 'angenommen' : 'abgelehnt' };
        const outboxId = await this.outbox.notifyGuest(tx, item.contact_email, 'du', 'withdrawal_decided', variables);
        await tx.withdrawalRequest.update({ where: { id: caseId }, data: { confirmation_outbox_id: outboxId } });
      }
      return this.view(caseId, tx);
    });
  }
}
