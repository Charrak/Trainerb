import { unexpiredGrant } from './access-period';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import type { Request, Response } from 'express';
import { Database } from './database';
import { Sessions, type ApiRequest, type SessionContext } from './sessions';
import { Outbox } from './outbox';
import { Invoices } from './invoices';
import { requireRates, splitGross } from './tax';
import { apiError, bodyObject, keyedHash, normalizeEmail, randomToken, requireName, requireString, seal } from './security';
import { billingAddress, idempotencyKey, optionalCouponCode, paymentMethod, type BillingAddress } from './commerce-validation';
import { getConfig } from './config';
import { fulfilPaidOrder } from './fulfilment';

const GUEST_CART_COOKIE = '__Host-guest-cart';
const GUEST_ORDER_COOKIE = '__Host-guest-order';
const CART_TTL_MS = 24 * 60 * 60_000;
const PROOF_TTL_MS = 30 * 60_000;
const missing = () => apiError(404, 'NOT_FOUND', 'Nicht gefunden.');

/**
 * Guest checkout.
 *
 * A visitor without an account can buy, but only after proving control of the
 * address the order is bound to. Two independent pieces of state make that safe:
 *
 *  - `guest_cart`  — an opaque random secret in a `__Host-` cookie. The database
 *    only stores its HMAC, so a leaked row cannot be replayed as a cart.
 *  - the e-mail proof — a single-use token bound to exactly that cart.
 *
 * Nothing about an existing account is revealed: the proof request always
 * answers the same way, and the account linkage only happens after the payment
 * is real (see `fulfilment.ts`).
 */
@Injectable()
export class GuestCheckout {
  constructor(private readonly db: Database, private readonly sessions: Sessions, private readonly outbox: Outbox,
              private readonly invoices: Invoices) {}

  private cookieOptions(expires: Date) {
    const preview = getConfig().embeddedPreviewCookies;
    return { httpOnly: true, secure: true, sameSite: (preview ? 'none' : 'lax') as 'none' | 'lax', path: '/',
      ...(preview ? { partitioned: true } : {}), expires };
  }
  private readCookie(req: ApiRequest, name: string): string | undefined {
    const value = req.cookies?.[name];
    return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
  }
  private secretHash(secret: string): Buffer<ArrayBuffer> {
    return keyedHash(getConfig().tokenKey, 'guest-cart', secret);
  }
  private issueSecret(res: Response): string {
    const secret = randomToken();
    res.cookie(GUEST_CART_COOKIE, secret, this.cookieOptions(new Date(Date.now() + CART_TTL_MS)));
    return secret;
  }

  /**
   * Resolve the guest cart for this browser, creating one on demand. A cart is
   * only ever returned for the secret that owns it.
   */
  private async cartFor(req: ApiRequest, res: Response, create: boolean,
                        tx: Prisma.TransactionClient = this.db) {
    let secret = this.readCookie(req, GUEST_CART_COOKIE);
    if (!secret) {
      if (!create) return null;
      secret = this.issueSecret(res);
    }
    const now = new Date();
    let cart = await tx.cart.findFirst({ where: { guest_secret_hash: this.secretHash(secret) },
      include: { email_verifications: { where: { consumed_at: null }, orderBy: { created_at: 'desc' } } } });
    if (cart && (cart.status !== 'open' || cart.expires_at <= now)) {
      if (cart.status === 'open') {
        await tx.cart.update({ where: { id: cart.id }, data: { status: 'abandoned' } });
      }
      // A converted or expired cart keeps the browser's secret (it is still the
      // proof for that order), so the next cart is created under the same one
      // instead of minting a second identity for the same browser.
      cart = null;
    }
    if (!cart && create) {
      const id = uuidv7();
      await tx.cart.create({ data: { id, user_id: null, guest_secret_hash: this.secretHash(secret),
        guest_secret_key_id: getConfig().encryptionKeyId, status: 'open',
        expires_at: new Date(now.getTime() + CART_TTL_MS) } });
      cart = await tx.cart.findUniqueOrThrow({ where: { id },
        include: { email_verifications: { where: { consumed_at: null }, orderBy: { created_at: 'desc' } } } });
    }
    if (!cart) return null;
    // Re-issue the cookie so an existing cart keeps its lifetime in sync.
    res.cookie(GUEST_CART_COOKIE, secret, this.cookieOptions(cart.expires_at));
    return cart;
  }

  /**
   * The cart a closed checkout left behind: after `POST guest/orders` the cart is
   * `converted`, so the open-cart lookup no longer finds it. The buyer still has
   * to reach *their* order and invoice with the cookie they bought with, so this
   * lookup deliberately accepts the converted state — and only that.
   */
  private async settledCartId(req: ApiRequest): Promise<string | null> {
    const secret = this.readCookie(req, GUEST_CART_COOKIE);
    if (!secret) return null;
    const cart = await this.db.cart.findFirst({ where: { guest_secret_hash: this.secretHash(secret),
      status: 'converted' }, orderBy: { created_at: 'desc' }, select: { id: true } });
    return cart?.id ?? null;
  }

  /** Cart view: identical shape to the account cart so the UI can reuse it. */
  private async view(tx: Prisma.TransactionClient, cartId: string) {
    const now = new Date();
    const cart = await tx.cart.findUniqueOrThrow({ where: { id: cartId },
      include: { items: { orderBy: { added_at: 'asc' }, include: { product: true, price: true } } } });
    const items = cart.items.map(item => {
      const price = item.price;
      const onSale = price.sale_gross_cents !== null && price.sale_starts_at && price.sale_ends_at &&
        price.sale_starts_at <= now && now < price.sale_ends_at;
      return { product_id: item.product_id, price_id: item.price_id, sku: item.product.sku, title: item.product.title,
        variant_name: item.product.variant_name, gross_cents: String(onSale ? price.sale_gross_cents! : price.gross_cents),
        list_gross_cents: String(price.gross_cents), currency: price.currency };
    });
    const subtotal = items.reduce((sum, item) => sum + BigInt(item.gross_cents), 0n);
    const proof = await tx.checkoutEmailVerification.findFirst({ where: { cart_id: cartId } });
    return { id: cart.id, items, subtotal_gross_cents: String(subtotal), currency: cart.currency,
      email_verified: cart.email_verified_at !== null,
      email_verification_pending: !!proof && proof.verified_at === null };
  }

  async getCart(req: ApiRequest, res: Response) {
    const cart = await this.cartFor(req, res, false);
    if (!cart) return { id: null, items: [], subtotal_gross_cents: '0', currency: 'EUR',
      email_verified: false, email_verification_pending: false };
    return this.view(this.db, cart.id);
  }

  async addItem(req: ApiRequest, res: Response, input: unknown) {
    const body = bodyObject(input, ['product_id']);
    const productId = requireString(body.product_id, 'product_id', 36);
    if (!/^[0-9a-f-]{36}$/i.test(productId)) throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Auswahl.');
    return this.db.$transaction(async tx => {
      const settings = await tx.commerceSettings.findUnique({ where: { id: 1 } });
      if (!settings?.sales_enabled) throw apiError(409, 'SALES_DISABLED', 'Der Verkauf ist derzeit nicht freigeschaltet.');
      const cart = await this.cartFor(req, res, true, tx);
      if (!cart) throw missing();
      await tx.$queryRaw`SELECT id FROM carts WHERE id = ${cart.id}::uuid FOR UPDATE`;
      const now = new Date();
      const product = await tx.product.findUnique({ where: { id: productId },
        include: { prices: { where: { status: 'active', valid_from: { lte: now },
          OR: [{ valid_until: null }, { valid_until: { gt: now } }] }, orderBy: { valid_from: 'desc' }, take: 1 } } });
      const price = product?.prices[0];
      if (!product || product.status !== 'active' || !price) {
        throw apiError(409, 'PRODUCT_NOT_SELLABLE', 'Dieses Produkt ist derzeit nicht käuflich.');
      }
      if ((await tx.productCourse.count({ where: { product_id: productId, course: { status: 'published' } } })) === 0) {
        throw apiError(409, 'PRODUCT_NOT_SELLABLE', 'Dieses Produkt ist derzeit nicht käuflich.');
      }
      // A guest may already own the course if an earlier purchase was linked to
      // this address; owning it again would grant nothing.
      if (cart.email_verified_at) {
        const proof = await tx.checkoutEmailVerification.findFirst({ where: { cart_id: cart.id,
          verified_at: { not: null } }, orderBy: { created_at: 'desc' } });
        if (proof) {
          const owned = await tx.courseAccess.findFirst({ where: { ...unexpiredGrant(now),
            user: { email_canonical: proof.email_canonical },
            course: { products: { some: { product_id: productId } } } }, select: { id: true } });
          if (owned) throw apiError(409, 'ALREADY_OWNED', 'Du hast bereits Zugang zu diesem Inhalt.');
        }
      }
      await tx.cartItem.upsert({ where: { cart_id_product_id: { cart_id: cart.id, product_id: productId } },
        create: { cart_id: cart.id, product_id: productId, price_id: price.id }, update: { price_id: price.id } });
      await tx.cart.update({ where: { id: cart.id }, data: { expires_at: new Date(now.getTime() + CART_TTL_MS) } });
      return this.view(tx, cart.id);
    }, { timeout: 20_000 });
  }

  async removeItem(req: ApiRequest, res: Response, productId: string) {
    const id = requireString(productId, 'product_id', 36);
    const cart = await this.cartFor(req, res, false);
    if (!cart) throw missing();
    return this.db.$transaction(async tx => {
      await tx.cartItem.deleteMany({ where: { cart_id: cart.id, product_id: id } });
      return this.view(tx, cart.id);
    });
  }

  /**
   * Ask for the e-mail proof. The answer is identical for every syntactically
   * valid address, so this cannot be used to discover accounts.
   */
  async requestProof(req: ApiRequest, res: Response, input: unknown, ip: string): Promise<{ status: string }> {
    const body = bodyObject(input, ['email']);
    const email = normalizeEmail(body.email);
    const cart = await this.cartFor(req, res, true);
    if (!cart) throw missing();
    // An empty cart cannot prove anything; the mail would be pure noise.
    if (!(await this.db.cartItem.count({ where: { cart_id: cart.id } }))) {
      throw apiError(409, 'CART_EMPTY', 'Der Warenkorb ist leer.');
    }
    const now = new Date();
    const token = randomToken();
    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM carts WHERE id = ${cart.id}::uuid FOR UPDATE`;
      // A new request supersedes the previous one for this cart.
      await tx.checkoutEmailVerification.deleteMany({ where: { cart_id: cart.id, consumed_at: null, verified_at: null } });
      const id = uuidv7();
      const expiresAt = new Date(now.getTime() + PROOF_TTL_MS);
      await tx.checkoutEmailVerification.create({ data: { id, cart_id: cart.id, email_original: email.original,
        email_canonical: email.canonical, token_hash: keyedHash(getConfig().tokenKey, 'checkout-email', token),
        code_hash: keyedHash(getConfig().tokenKey, 'checkout-email-code', `${id}\0${code}`),
        expires_at: expiresAt } });
      // The mail intentionally goes through the same durable outbox as every
      // other transactional message; no token is ever stored in clear text.
      const version = await tx.emailTemplateVersion.findFirst({ where: { state: 'published',
        template: { key: 'checkout_email_verify', locale: 'de-DE', status: 'active' } } });
      if (!version) throw new Error('Required mail template not configured: checkout_email_verify');
      const outboxId = uuidv7();
      // The link token is sealed like an account token: `variables_public` is
      // only for the non-secret parts (greeting, six-digit code) and is what an
      // operator could legitimately inspect. The URL itself is rebuilt from the
      // sealed payload when the mail is rendered, so a database dump does not
      // contain a working login to someone's checkout.
      await tx.emailOutbox.create({ data: { id: outboxId, template_version_id: version.id, purpose: 'transaction',
        user_id: null, to_email: email.original, variables_public: { first_name: 'du', code },
        variables_secret_ciphertext: seal({ token, purpose: 'checkout_email_verify' }, `outbox:${outboxId}`),
        secret_key_id: getConfig().encryptionKeyId, secret_delete_after: expiresAt,
        idempotency_key: `outbox-${outboxId}`, status: 'queued', scheduled_at: now } });
      await tx.automationJob.create({ data: { id: uuidv7(), kind: 'email.send', ref_type: 'email_outbox',
        ref_id: outboxId, payload_schema_version: 1, payload: { schema_version: 1 },
        idempotency_key: `email-${outboxId}`, status: 'queued', max_attempts: 8, run_after: now } });
    });
    return { status: 'accepted' };
  }

  /** Confirm the proof with the token from the mail (optionally plus the code). */
  async confirmProof(req: ApiRequest, res: Response, input: unknown): Promise<{ verified: boolean }> {
    const body = bodyObject(input, ['token', 'code']);
    const token = requireString(body.token, 'token', 128);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw apiError(410, 'TOKEN_INVALID', 'Der Link ist ungültig oder abgelaufen.');
    const code = typeof body.code === 'string' ? body.code.replace(/\s+/g, '') : '';
    return this.db.$transaction(async tx => {
      const proof = await tx.checkoutEmailVerification.findUnique({
        where: { token_hash: keyedHash(getConfig().tokenKey, 'checkout-email', token) } });
      if (!proof || proof.consumed_at || proof.expires_at <= new Date()) {
        throw apiError(410, 'TOKEN_INVALID', 'Der Link ist ungültig oder abgelaufen.');
      }
      await tx.$queryRaw`SELECT id FROM checkout_email_verifications WHERE id = ${proof.id}::uuid FOR UPDATE`;
      const current = await tx.checkoutEmailVerification.findUniqueOrThrow({ where: { id: proof.id } });
      if (current.verified_at) return { verified: true };
      // Rate-limit guessing here, under the same row lock that guards the counter.
      if (current.attempts >= 10) throw apiError(429, 'TOO_MANY_ATTEMPTS', 'Zu viele Versuche. Bitte fordere einen neuen Link an.');
      await tx.checkoutEmailVerification.update({ where: { id: current.id }, data: { attempts: { increment: 1 } } });
      const now = new Date();
      await tx.checkoutEmailVerification.update({ where: { id: current.id }, data: { verified_at: now } });
      await tx.cart.update({ where: { id: current.cart_id }, data: { email_verified_at: now } });
      await tx.auditEvent.create({ data: { id: uuidv7(), origin: 'user', action: 'checkout_email.verified',
        target_type: 'cart', target_ref: current.cart_id } });
      // Two independent proofs are needed to order: this token (the address) and
      // the cart cookie (the basket). Confirming on a second device therefore
      // marks the cart as proven without touching the first device's cookie.
      void code;
      return { verified: true };
    });
  }

  /** Status of the proof bound to this browser's cart. */
  async proofStatus(req: ApiRequest, res: Response) {
    const cart = await this.cartFor(req, res, false);
    if (!cart) return { email_verified: false, email_verification_pending: false, email: null };
    const proof = await cart.email_verifications[0] ?? await this.db.checkoutEmailVerification.findFirst({
      where: { cart_id: cart.id }, orderBy: { created_at: 'desc' } });
    return { email_verified: cart.email_verified_at !== null, email_verification_pending: !!proof && !proof.verified_at,
      email: proof?.email_original ?? null };
  }

  /**
   * Turn the guest cart into an order.
   *
   * The amount, the course versions and the legal wordings are all resolved
   * server-side. The buyer only provides address, payment method, consent and an
   * idempotency key — exactly like the account checkout.
   */
  async checkout(req: ApiRequest, res: Response, input: unknown, request: { ip: string; userAgent: string }) {
    const body = bodyObject(input, ['idempotency_key', 'billing_address', 'coupon_code', 'payment_method',
      'legal_versions', 'terms_accepted', 'withdrawal_notice_seen', 'privacy_notice_seen', 'participant_first_name',
      'participant_last_name']);
    const key = idempotencyKey(body.idempotency_key);
    const address = billingAddress(body.billing_address);
    const method = paymentMethod(body.payment_method);
    const code = optionalCouponCode(body.coupon_code);
    const participantFirst = requireName(body.participant_first_name, 'first_name');
    const participantLast = requireName(body.participant_last_name, 'last_name');
    const versionsInput = body.legal_versions;
    if (!versionsInput || typeof versionsInput !== 'object' || Array.isArray(versionsInput)) {
      throw apiError(422, 'LEGAL_REQUIRED', 'Bitte bestätige die rechtlichen Hinweise.');
    }
    const versions = versionsInput as Record<string, unknown>;
    const required = ['terms', 'withdrawal', 'privacy'] as const;
    if (required.some(kind => typeof versions[kind] !== 'string')) {
      throw apiError(422, 'LEGAL_REQUIRED', 'Bitte bestätige die rechtlichen Hinweise.');
    }
    for (const flag of ['terms_accepted', 'withdrawal_notice_seen', 'privacy_notice_seen'] as const) {
      if (body[flag] !== true) throw apiError(422, 'LEGAL_REQUIRED', 'Bitte bestätige die rechtlichen Hinweise.');
    }
    const cart = await this.cartFor(req, res, false);
    if (!cart) throw apiError(409, 'CART_EMPTY', 'Der Warenkorb ist leer.');
    const ipHmac = keyedHash(getConfig().auditKey, 'checkout-ip', request.ip);
    const agentHmac = keyedHash(getConfig().auditKey, 'checkout-agent', request.userAgent);

    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM carts WHERE id = ${cart.id}::uuid FOR UPDATE`;
      const current = await tx.cart.findUniqueOrThrow({ where: { id: cart.id } });
      if (current.status !== 'open' || current.expires_at <= new Date()) {
        throw apiError(409, 'CART_EMPTY', 'Der Warenkorb ist leer oder abgelaufen.');
      }
      const proof = await tx.checkoutEmailVerification.findFirst({ where: { cart_id: cart.id,
        verified_at: { not: null }, consumed_at: null }, orderBy: { created_at: 'desc' } });
      if (!proof) throw apiError(409, 'EMAIL_NOT_VERIFIED', 'Bitte bestätige zuerst deine E-Mail-Adresse.');
      const previous = await tx.order.findFirst({ where: { checkout_email_verification_id: proof.id,
        checkout_idempotency_key: key }, select: { id: true } });
      if (previous) return this.orderView(tx, previous.id, cart.id);
      const settings = await tx.commerceSettings.findUnique({ where: { id: 1 } });
      if (!settings?.sales_enabled) throw apiError(409, 'SALES_DISABLED', 'Der Verkauf ist derzeit nicht freigeschaltet.');
      const now = new Date();
      const items = await tx.cartItem.findMany({ where: { cart_id: cart.id }, include: { product: true, price: true },
        orderBy: { added_at: 'asc' } });
      if (!items.length) throw apiError(409, 'CART_EMPTY', 'Der Warenkorb ist leer.');
      if (items.length > 20) throw apiError(422, 'CART_TOO_LARGE', 'Der Warenkorb enthält zu viele Positionen.');
      const lines: { productId: string; priceId: string; title: string; variant: string | null; unit: bigint;
        taxCategory: string; courses: { course_id: string; course_version_id: string; title: string;
          access_days: number | null }[] }[] = [];
      for (const item of items) {
        const price = item.price;
        const inWindow = price.status === 'active' && price.valid_from <= now &&
          (!price.valid_until || price.valid_until > now);
        const links = await tx.productCourse.findMany({ where: { product_id: item.product_id }, orderBy: { position: 'asc' },
          include: { course: { include: { versions: { where: { state: 'published' }, take: 1 } } } } });
        const published = links.filter(link => link.course.status === 'published' && link.course.versions[0]);
        if (!inWindow || item.product.status !== 'active' || !published.length) {
          throw apiError(409, 'PRICE_CHANGED', `„${item.product.title}“ ist nicht mehr zum hinterlegten Preis verfügbar.`);
        }
        const onSale = price.sale_gross_cents !== null && price.sale_starts_at && price.sale_ends_at &&
          price.sale_starts_at <= now && now < price.sale_ends_at;
        const unit = onSale ? price.sale_gross_cents! : price.gross_cents;
        if (unit <= 0n) throw apiError(409, 'PRICE_CHANGED', `„${item.product.title}“ hat keinen gültigen Preis.`);
        lines.push({ productId: item.product_id, priceId: item.price_id, title: item.product.title, taxCategory: price.tax_category,
          variant: item.product.variant_name, unit,
          courses: published.map(link => ({ course_id: link.course_id, course_version_id: link.course.versions[0]!.id,
            title: link.course.versions[0]!.title,
            access_days: link.access_days_override ?? link.course.versions[0]!.default_access_days ?? null })) });
      }
      // The rate is looked up per category for today and stored on the position
      // with the split. A category without a configured rate stops the sale.
      const rates = await requireRates(tx, lines.map(line => line.taxCategory), now);
      // The split is attached to the position, not recomputed later: the row and
      // the document must show the same three numbers forever.
      const splits = new Map(lines.map(line => [line.productId,
        splitGross(line.unit, rates.get(line.taxCategory)!)]));
      const subtotal = lines.reduce((sum, line) => sum + line.unit, 0n);
      let discount = 0n, couponId: string | null = null;
      const identityHmac = keyedHash(getConfig().auditKey, 'coupon-guest', proof.email_canonical);
      if (code) {
        const coupon = await tx.coupon.findUnique({ where: { code_canonical: code },
          include: { products: true, _count: { select: { reservations: { where: { status: 'redeemed' } } } } } });
        if (!coupon || !coupon.active || coupon.valid_from > now || (coupon.valid_until && coupon.valid_until <= now)) {
          throw apiError(422, 'COUPON_INVALID', 'Dieser Gutscheincode ist ungültig oder abgelaufen.');
        }
        await tx.$queryRaw`SELECT id FROM coupons WHERE id = ${coupon.id}::uuid FOR UPDATE`;
        const used = await tx.couponReservation.count({ where: { coupon_id: coupon.id,
          status: { in: ['reserved', 'redeemed'] } } });
        if (coupon.max_redemptions !== null && used >= coupon.max_redemptions) {
          throw apiError(422, 'COUPON_EXHAUSTED', 'Dieser Gutscheincode wurde bereits vollständig eingelöst.');
        }
        if (coupon.products.length && !lines.every(line => coupon.products.some(link => link.product_id === line.productId))) {
          throw apiError(422, 'COUPON_NOT_APPLICABLE', 'Dieser Gutscheincode gilt nicht für alle Produkte im Warenkorb.');
        }
        const own = await tx.couponReservation.findFirst({ where: { coupon_id: coupon.id,
          OR: [{ identity_hmac: identityHmac }, { user: { email_canonical: proof.email_canonical } }],
          status: { in: ['reserved', 'redeemed'] } } });
        if (own) throw apiError(422, 'COUPON_ALREADY_USED', 'Dieser Gutscheincode wurde bereits verwendet.');
        discount = couponDiscount(coupon.type, coupon.value, subtotal);
        couponId = coupon.id;
      }
      const total = subtotal - discount;
      if (total <= 0n) throw apiError(409, 'TOTAL_NOT_PAYABLE', 'Der zu zahlende Betrag muss positiv sein.');
      const active = await tx.legalDocumentVersion.findMany({ where: { status: 'active' }, include: { document: true } });
      const wanted = new Map(active.map(version => [version.document.kind, version]));
      for (const kind of required) {
        const version = wanted.get(kind);
        if (!version || version.id !== versions[kind]) {
          throw apiError(409, 'LEGAL_CHANGED', 'Die rechtlichen Hinweise wurden aktualisiert. Bitte lade die Seite neu.');
        }
      }
      const orderId = uuidv7();
      const numberRow = await tx.$queryRaw<{ number: string }[]>`SELECT trainerb_next_order_number('TB-', 'order_number_seq') AS number`;
      const orderNumber = numberRow[0].number;
      const dueAt = method === 'invoice' ? new Date(now.getTime() + settings.payment_term_days * 24 * 60 * 60_000) : null;
      const paymentReference = `TB-${orderNumber}`;
      await tx.order.create({ data: { id: orderId, order_number: orderNumber, cart_id: cart.id,
        checkout_idempotency_key: key, user_id: null, identity_kind: 'guest',
        checkout_email_verification_id: proof.id,
        buyer_email_original: proof.email_original, buyer_email_canonical: proof.email_canonical,
        guest_participant_first_name: participantFirst, guest_participant_last_name: participantLast,
        currency: 'EUR', payment_method: method, payment_state: 'awaiting', fulfillment_state: 'waiting',
        subtotal_gross_cents: subtotal, discount_cents: discount, total_gross_cents: total,
        billing_snapshot: address as unknown as Prisma.InputJsonValue, placed_at: now, due_at: dueAt,
        payment_reference: paymentReference } });
      for (const [index, line] of lines.entries()) {
        await tx.orderItem.create({ data: { order_id: orderId, product_id: line.productId, price_id: line.priceId,
          position: index + 1, title_snapshot: line.title, variant_snapshot: line.variant, unit_gross_cents: line.unit,
          discount_cents: 0n, total_gross_cents: line.unit,
          tax_rate_bp: splits.get(line.productId)!.rate_bp, net_cents: splits.get(line.productId)!.net_cents,
          tax_cents: splits.get(line.productId)!.tax_cents, tax_label: splits.get(line.productId)!.label } });
        for (const course of line.courses) {
          await tx.orderItemCourse.create({ data: { order_id: orderId, order_item_product: line.productId,
            course_id: course.course_id, course_version_id: course.course_version_id,
            course_title_snapshot: course.title, access_days: course.access_days } });
        }
      }
      const kinds = [['terms', 'terms_accepted'], ['withdrawal', 'withdrawal_notice_seen'], ['privacy', 'privacy_notice_seen']] as const;
      for (const [documentKind, acceptanceKind] of kinds) {
        const version = wanted.get(documentKind)!;
        await tx.orderLegalAcceptance.create({ data: { id: uuidv7(), order_id: orderId,
          legal_document_version_id: version.id, kind: acceptanceKind, wording_snapshot: version.wording,
          affirmed: true, ip_hmac: ipHmac, user_agent_hmac: agentHmac } });
      }
      if (couponId) {
        await tx.couponReservation.create({ data: { id: uuidv7(), coupon_id: couponId, order_id: orderId,
          user_id: null, identity_hmac: identityHmac, status: 'reserved' } });
      }
      if (method === 'invoice') {
        await tx.paymentAttempt.create({ data: { id: uuidv7(), order_id: orderId, provider: 'invoice',
          environment: getConfig().appEnv === 'production' ? 'live' : 'test',
          provider_idempotency_key: `invoice-${orderId}`, status: 'pending', amount_cents: total, currency: 'EUR' } });
        await this.invoices.issue(tx, orderId, settings, proof.email_original);
      }
      await tx.checkoutEmailVerification.update({ where: { id: proof.id }, data: { consumed_at: now } });
      await tx.cartItem.deleteMany({ where: { cart_id: cart.id } });
      await tx.cart.update({ where: { id: cart.id }, data: { status: 'converted' } });
      await tx.auditEvent.create({ data: { id: uuidv7(), origin: 'user', action: 'order.placed_guest', target_type: 'order',
        target_ref: orderId, after_safe: { order_number: orderNumber, total_gross_cents: String(total) } } });
      await this.outbox.notifyGuest(tx, proof.email_original, participantFirst, 'order_placed',
        { order_number: orderNumber, total: centsToTextGuest(total), payment_reference: paymentReference });
      // The cookie stays: it is the buyer's only proof for *this* order. It no
      // longer points at an open cart (the cart is `converted`), so nothing can
      // be added to it — but the status page and the invoice stay reachable
      // until the cookie expires, exactly like any other receipt link.
      return this.orderView(tx, orderId);
    }, { timeout: 20_000 });
  }

  /** Guest view of an order, addressed by the guest-order cookie. */
  async orderView(tx: Prisma.TransactionClient, orderId: string, cartId?: string) {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: {
      items: { orderBy: { position: 'asc' }, include: { courses: true } },
      acceptances: { select: { kind: true, wording_snapshot: true, legal_document_version_id: true } },
      invoice: true, attempts: { orderBy: { created_at: 'desc' } }, coupon: { include: { coupon: true } },
      accesses: { select: { course_id: true, revoked_at: true } } } });
    if (!order) throw missing();
    // A guest sees only the order of their own cart; the verified proof is the
    // only link, so a guessed order id is worthless.
    if (cartId !== undefined && order.cart_id !== cartId) throw missing();
    const settings = await tx.commerceSettings.findUnique({ where: { id: 1 } });
    return {
      id: order.id, order_number: order.order_number, placed_at: order.placed_at,
      identity_kind: order.identity_kind, buyer_email: order.buyer_email_canonical,
      payment_method: order.payment_method, payment_state: order.payment_state,
      fulfillment_state: order.fulfillment_state, subtotal_gross_cents: String(order.subtotal_gross_cents),
      discount_cents: String(order.discount_cents), total_gross_cents: String(order.total_gross_cents),
      currency: order.currency, due_at: order.due_at, paid_at: order.paid_at,
      payment_reference: order.payment_reference, billing_snapshot: order.billing_snapshot,
      account_linked: order.user_id !== null,
      items: order.items.map(item => ({ product_id: item.product_id, title: item.title_snapshot,
        variant: item.variant_snapshot, unit_gross_cents: String(item.unit_gross_cents),
        total_gross_cents: String(item.total_gross_cents), courses: item.courses.map(course => ({
          course_id: course.course_id, title: course.course_title_snapshot, access_days: course.access_days })) })),
      acceptances: order.acceptances, coupon_code: order.coupon?.coupon.code_canonical ?? null,
      invoice: order.invoice ? { id: order.invoice.id, invoice_number: order.invoice.invoice_number,
        issued_at: order.invoice.issued_at, seller: order.invoice.seller_snapshot, buyer: order.invoice.buyer_snapshot,
        lines: order.invoice.lines_snapshot, total_gross_cents: String(order.invoice.total_gross_cents),
        due_at: order.invoice.due_at, payment_reference: order.invoice.payment_reference,
        // Only a paid order has a document to download, and only while the cart
        // cookie still proves who is asking.
        pdf_href: order.payment_state === 'paid' ? `/guest/invoices/${order.invoice.id}/pdf` : null } : null,
      bank: order.payment_method === 'invoice' && order.payment_state === 'awaiting' && settings ? {
        holder: settings.bank_account_holder, iban: settings.bank_iban, bic: settings.bank_bic,
        bank: settings.bank_name, reference: order.payment_reference } : null,
      access: order.accesses.map(access => ({ course_id: access.course_id, revoked: access.revoked_at !== null })),
    };
  }

  /**
   * Staff resolution for a paid guest order whose address belongs to a blocked
   * account: decide explicitly whether the course is still granted, or cancel and
   * refund outside the system. Never automatic, always audited.
   */
  async resolveUnlinked(ctx: SessionContext, orderIdInput: string, input: unknown) {
    const orderId = requireString(orderIdInput, 'order_id', 36);
    const body = bodyObject(input, ['decision', 'note']);
    const decision = body.decision === 'grant' || body.decision === 'cancel' ? body.decision : null;
    if (!decision) throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { decision: 'Bitte entscheiden.' });
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length > 500) throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { note: 'Zu lang.' });
    return this.db.$transaction(async tx => {
      await this.sessions.assertCurrent(tx, ctx);
      if (ctx.session.kind !== 'backoffice' || !ctx.permissionKeys.has('orders.manage')) {
        throw apiError(403, 'FORBIDDEN', 'Kein Zugriff.');
      }
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw missing();
      if (order.payment_state !== 'paid' || order.user_id !== null) {
        throw apiError(409, 'ORDER_NOT_PENDING_LINK', 'Diese Bestellung wartet nicht auf eine Zuordnung.');
      }
      const now = new Date();
      if (decision === 'grant') {
        // Explicit override: grant to the existing account even though it is
        // blocked, because the customer paid. Documented in the audit trail.
        const user = await tx.user.findUnique({ where: { email_canonical: order.buyer_email_canonical } });
        if (!user) throw apiError(409, 'ORDER_NO_ACCOUNT', 'Zu dieser Adresse besteht kein Konto.');
        await tx.order.update({ where: { id: orderId }, data: { user_id: user.id } });
        const outcome = await fulfilPaidOrder(tx, orderId, this.outbox, { staffApprovedBlockedBuyer: true });
        if (outcome.status !== 'fulfilled') throw apiError(409, 'FULFILMENT_BLOCKED', 'Die Freischaltung ist weiterhin blockiert.');
        await tx.auditEvent.create({ data: { id: uuidv7(), origin: 'user', actor_user_id: ctx.user.id,
          action: 'order.guest_granted_manually', target_type: 'order', target_ref: orderId,
          after_safe: { user_id: user.id, note: note || null } } });
      } else {
        await tx.order.update({ where: { id: orderId }, data: { payment_state: 'cancelled', cancelled_at: now,
          cancelled_reason: 'buyer_account_blocked', fulfillment_state: 'blocked' } });
        await tx.couponReservation.updateMany({ where: { order_id: orderId, status: 'reserved' },
          data: { status: 'released', resolved_at: now } });
        await tx.auditEvent.create({ data: { id: uuidv7(), origin: 'user', actor_user_id: ctx.user.id,
          action: 'order.guest_cancelled_manually', target_type: 'order', target_ref: orderId,
          after_safe: { note: note || null } } });
      }
      return this.orderView(tx, orderId);
    });
  }

  /**
   * Guest order status after the checkout (and after a Stripe redirect). The
   * cookie is the only proof, and it must still work once the cart was closed by
   * the order — otherwise the buyer would lose their own receipt.
   */
  async myOrder(req: ApiRequest, res: Response, orderIdInput: string) {
    const orderId = requireString(orderIdInput, 'order_id', 36);
    const cart = await this.cartFor(req, res, false);
    const cartId = cart?.id ?? await this.settledCartId(req);
    if (!cartId) throw missing();
    return this.orderView(this.db, orderId, cartId);
  }

  /**
   * After a successful login, fold a guest cart into the account cart.
   *
   * Without this the basket would silently vanish at the very moment the buyer
   * signs in to pay — the most expensive possible moment to lose it. The existing
   * item wins on price conflicts: a negotiated cart price is never overwritten by
   * a guest session, and the guest cart is simply closed.
   */
  async mergeIntoAccount(req: ApiRequest, res: Response, userId: string): Promise<number> {
    const secret = this.readCookie(req, GUEST_CART_COOKIE);
    if (!secret) return 0;
    const hash = this.secretHash(secret);
    const moved = await this.db.$transaction(async tx => {
      const guestCart = await tx.cart.findFirst({ where: { guest_secret_hash: hash, status: 'open' },
        include: { items: true } });
      if (!guestCart) return 0;
      await tx.$queryRaw`SELECT id FROM carts WHERE id = ${guestCart.id}::uuid FOR UPDATE`;
      let accountCart = await tx.cart.findFirst({ where: { user_id: userId, status: 'open' } });
      if (!accountCart) {
        accountCart = await tx.cart.create({ data: { id: uuidv7(), user_id: userId, status: 'open',
          expires_at: new Date(Date.now() + CART_TTL_MS) } });
      }
      let count = 0;
      for (const item of guestCart.items) {
        const existing = await tx.cartItem.findUnique({ where: { cart_id_product_id:
          { cart_id: accountCart.id, product_id: item.product_id } } });
        if (existing) continue;
        await tx.cartItem.create({ data: { cart_id: accountCart.id, product_id: item.product_id,
          price_id: item.price_id } });
        count += 1;
      }
      await tx.cartItem.deleteMany({ where: { cart_id: guestCart.id } });
      await tx.cart.update({ where: { id: guestCart.id }, data: { status: 'abandoned' } });
      return count;
    });
    res.clearCookie(GUEST_CART_COOKIE, this.cookieOptions(new Date(0)));
    return moved;
  }

  /**
   * Claim an order after the account was activated and logged in.
   *
   * This is the bridge between the guest purchase and the normal learning area:
   * the buyer proves control by being logged in *and* by the address on the
   * order matching the account. Afterwards the order is linked and, if it was
   * already paid, access is granted by the shared fulfilment path.
   */
  async claimOrder(tx: Prisma.TransactionClient, userId: string, orderId: string, outbox: Outbox) {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) throw missing();
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user || user.email_canonical !== order.buyer_email_canonical) throw missing();
    if (order.user_id === userId) return;
    await tx.order.update({ where: { id: orderId }, data: { user_id: userId } });
    await tx.auditEvent.create({ data: { id: uuidv7(), origin: 'user', actor_user_id: userId, action: 'order.claimed',
      target_type: 'order', target_ref: orderId } });
    if (order.payment_state === 'paid' && order.fulfillment_state !== 'fulfilled') {
      await fulfilPaidOrder(tx, orderId, outbox);
    }
  }
}

function centsToTextGuest(cents: bigint): string {
  const padded = cents.toString().padStart(3, '0');
  return `${padded.slice(0, -2)},${padded.slice(-2)}`;
}

/** Same integer arithmetic as the account checkout. */
function couponDiscount(type: string, value: bigint, subtotal: bigint): bigint {
  if (subtotal <= 0n) return 0n;
  const raw = type === 'percent' ? (subtotal * value) / 10_000n : value;
  if (raw >= subtotal) return subtotal - 1n;
  return raw > 0n ? raw : 0n;
}
