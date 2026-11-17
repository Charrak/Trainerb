import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { Sessions, type SessionContext } from './sessions';
import { apiError, bodyObject, keyedHash, normalizeEmail, requireUuid } from './security';
import { billingAddress, couponCode, discountFor, idempotencyKey, optionalCouponCode, paymentMethod,
  type BillingAddress } from './commerce-validation';
import { getConfig } from './config';
import { Outbox } from './outbox';

const missing = () => apiError(404, 'NOT_FOUND', 'Nicht gefunden.');
const CART_TTL_MS = 24 * 60 * 60_000;

/** Money in mails is a German decimal string, never a raw integer. */
export function centsToText(cents: bigint): string {
  const padded = cents.toString().padStart(3, '0');
  return `${padded.slice(0, -2)},${padded.slice(-2)}`;
}

/** The effective price at `now`: a running sale wins, otherwise the list price. */
export function effectivePrice(price: { gross_cents: bigint; sale_gross_cents: bigint | null;
  sale_starts_at: Date | null; sale_ends_at: Date | null }, now: Date): bigint {
  if (price.sale_gross_cents === null || !price.sale_starts_at || !price.sale_ends_at) return price.gross_cents;
  return price.sale_starts_at <= now && now < price.sale_ends_at ? price.sale_gross_cents : price.gross_cents;
}

/** A price row is currently buyable only inside its own validity window. */
const activeWindow = (now: Date): Prisma.PriceWhereInput => ({ status: 'active', valid_from: { lte: now },
  OR: [{ valid_until: null }, { valid_until: { gt: now } }] });

export type CartLine = { product_id: string; price_id: string; sku: string; title: string; variant_name: string | null;
  gross_cents: string; list_gross_cents: string; currency: string };

@Injectable()
export class Shop {
  constructor(private readonly db: Database, private readonly sessions: Sessions, private readonly outbox: Outbox) {}
  /** Read-only access for controllers that only need an order view. */
  get client(): Database { return this.db; }

  private async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try { return await this.db.$transaction(work, { timeout: 20_000 }); } catch (error) { this.dbError(error); }
  }
  /** Translate database guards into stable API errors instead of a 500. */
  private dbError(error: unknown): never {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('CART_PRODUCT_NOT_SELLABLE')) throw apiError(409, 'PRODUCT_NOT_SELLABLE', 'Dieses Produkt ist derzeit nicht käuflich.');
    if (message.includes('CART_PRICE_MISMATCH')) throw apiError(409, 'PRODUCT_NOT_SELLABLE', 'Dieses Produkt ist derzeit nicht käuflich.');
    if (message.includes('ACCESS_COURSE_NOT_PUBLISHED')) throw apiError(409, 'COURSE_NOT_PUBLISHED', 'Für diesen Kurs kann kein Zugang vergeben werden.');
    if (message.includes('ORDER_PAYMENT_EVIDENCE_MISSING')) throw apiError(409, 'PAYMENT_EVIDENCE_REQUIRED', 'Eine Zahlung kann erst nach bestätigtem Zahlungseingang gebucht werden.');
    if (message.includes('ORDER_CANCEL_WITH_ACTIVE_ACCESS')) throw apiError(409, 'ORDER_HAS_ACTIVE_ACCESS', 'Der Zugang muss vor der Stornierung entzogen werden.');
    if (message.includes('ORDER_FULFILMENT_WITHOUT_ACCESS')) throw apiError(409, 'FULFILMENT_INCOMPLETE', 'Die Bestellung kann ohne Zugang nicht als erfüllt markiert werden.');
    if (message.includes('course_access_one_active')) throw apiError(409, 'ACCESS_EXISTS', 'Für diesen Kurs besteht bereits ein Zugang.');
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      throw apiError(409, 'CONFLICT', 'Dieser Eintrag existiert bereits.');
    }
    throw error;
  }
  private async audit(tx: Prisma.TransactionClient, actorId: string | null, action: string, targetType: string,
                      target: string, details?: Prisma.InputJsonValue) {
    await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: actorId, origin: 'user', action,
      target_type: targetType, target_ref: target, ...(details ? { after_safe: details } : {}) } });
  }
  /** Settings row; created lazily so a fresh installation can be configured. */
  async settings(tx: Prisma.TransactionClient = this.db) {
    return tx.commerceSettings.findUnique({ where: { id: 1 } });
  }
  /** Cart access is always scoped to the session user; no cart id is trusted from the browser. */
  private async openCart(tx: Prisma.TransactionClient, userId: string, create: boolean) {
    const existing = await tx.cart.findFirst({ where: { user_id: userId, status: 'open' } });
    if (existing || !create) return existing;
    return tx.cart.create({ data: { id: uuidv7(), user_id: userId, status: 'open',
      expires_at: new Date(Date.now() + CART_TTL_MS) } });
  }
  private async cartView(tx: Prisma.TransactionClient, cartId: string | null) {
    if (!cartId) return { id: null, items: [] as CartLine[], subtotal_gross_cents: '0', currency: 'EUR' };
    const now = new Date();
    const cart = await tx.cart.findUniqueOrThrow({ where: { id: cartId },
      include: { items: { orderBy: { added_at: 'asc' }, include: { product: true,
        price: true } } } });
    const items = cart.items.map(item => ({ product_id: item.product_id, price_id: item.price_id, sku: item.product.sku,
      title: item.product.title, variant_name: item.product.variant_name,
      gross_cents: String(effectivePrice(item.price, now)), list_gross_cents: String(item.price.gross_cents),
      currency: item.price.currency }));
    const subtotal = items.reduce((sum, item) => sum + BigInt(item.gross_cents), 0n);
    return { id: cart.id, items, subtotal_gross_cents: String(subtotal), currency: cart.currency };
  }

  async getCart(ctx: SessionContext) {
    return this.transaction(async tx => this.cartView(tx, (await this.openCart(tx, ctx.user.id, false))?.id ?? null));
  }

  async addToCart(ctx: SessionContext, input: unknown) {
    const body = bodyObject(input, ['product_id']);
    const productId = requireUuid(typeof body.product_id === 'string' ? body.product_id.toLowerCase() : '');
    return this.transaction(async tx => {
      // Serialize cart mutations per account so the single-open-cart rule holds.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.user.id}::uuid FOR UPDATE`;
      const settings = await this.settings(tx);
      if (!settings?.sales_enabled) throw apiError(409, 'SALES_DISABLED', 'Der Verkauf ist derzeit nicht freigeschaltet.');
      const now = new Date();
      const product = await tx.product.findUnique({ where: { id: productId },
        include: { prices: { where: activeWindow(now), orderBy: { valid_from: 'desc' }, take: 1 } } });
      const price = product?.prices[0];
      if (!product || product.status !== 'active' || !price) throw apiError(409, 'PRODUCT_NOT_SELLABLE', 'Dieses Produkt ist derzeit nicht käuflich.');
      if ((await tx.productCourse.count({ where: { product_id: productId, course: { status: 'published' } } })) === 0) {
        throw apiError(409, 'PRODUCT_NOT_SELLABLE', 'Dieses Produkt ist derzeit nicht käuflich.');
      }
      const cart = await this.openCart(tx, ctx.user.id, true);
      // Owning the course already means a second purchase would grant nothing.
      const owned = await tx.courseAccess.findFirst({ where: { user_id: ctx.user.id, revoked_at: null,
        course: { products: { some: { product_id: productId } } } }, select: { id: true } });
      if (owned) throw apiError(409, 'ALREADY_OWNED', 'Du hast bereits Zugang zu diesem Inhalt.');
      await tx.cartItem.upsert({ where: { cart_id_product_id: { cart_id: cart!.id, product_id: productId } },
        create: { cart_id: cart!.id, product_id: productId, price_id: price.id }, update: { price_id: price.id } });
      await tx.cart.update({ where: { id: cart!.id }, data: { expires_at: new Date(Date.now() + CART_TTL_MS) } });
      return this.cartView(tx, cart!.id);
    });
  }

  async removeFromCart(ctx: SessionContext, productIdInput: string) {
    const productId = requireUuid(productIdInput);
    return this.transaction(async tx => {
      const cart = await this.openCart(tx, ctx.user.id, false);
      if (!cart) throw missing();
      await tx.cartItem.deleteMany({ where: { cart_id: cart.id, product_id: productId } });
      return this.cartView(tx, cart.id);
    });
  }

  async clearCart(ctx: SessionContext) {
    return this.transaction(async tx => {
      const cart = await this.openCart(tx, ctx.user.id, false);
      if (!cart) return this.cartView(tx, null);
      await tx.cartItem.deleteMany({ where: { cart_id: cart.id } });
      return this.cartView(tx, cart.id);
    });
  }

  /** Public, price-aware product detail. Nothing is exposed that is not sellable. */
  async publicProduct(productIdInput: string) {
    const productId = requireUuid(productIdInput);
    const now = new Date();
    const settings = await this.settings();
    if (!settings?.sales_enabled) throw missing();
    const product = await this.db.product.findUnique({ where: { id: productId },
      include: { prices: { where: activeWindow(now), orderBy: { valid_from: 'desc' }, take: 1 },
        courses: { orderBy: { position: 'asc' }, include: { course: { select: { slug: true, status: true,
          versions: { where: { state: 'published' }, take: 1, select: { title: true, subtitle: true, duration_minutes: true } } } } } } } });
    if (!product || product.status !== 'active' || !product.prices[0]) throw missing();
    const courses = product.courses.filter(link => link.course.status === 'published' && link.course.versions[0])
      .map(link => ({ slug: link.course.slug, title: link.course.versions[0]!.title,
        subtitle: link.course.versions[0]!.subtitle, duration_minutes: link.course.versions[0]!.duration_minutes,
        access_days: link.access_days_override ?? null }));
    if (!courses.length) throw missing();
    return { id: product.id, sku: product.sku, type: product.type, title: product.title,
      variant_name: product.variant_name, description: product.description,
      gross_cents: String(effectivePrice(product.prices[0], now)), currency: product.prices[0].currency,
      courses };
  }

  /** Sellable products for the public shop overview. */
  async publicProducts() {
    const now = new Date();
    const settings = await this.settings();
    if (!settings?.sales_enabled) return { data: [], sales_enabled: false };
    const products = await this.db.product.findMany({ where: { status: 'active',
      prices: { some: activeWindow(now) }, courses: { some: { course: { status: 'published' } } } },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
      include: { prices: { where: activeWindow(now), orderBy: { valid_from: 'desc' }, take: 1 },
        _count: { select: { courses: true } } } });
    return { data: products.map(product => ({ id: product.id, sku: product.sku, type: product.type, title: product.title,
      variant_name: product.variant_name, course_count: product._count.courses,
      gross_cents: String(effectivePrice(product.prices[0]!, now)), currency: product.prices[0]!.currency })),
      sales_enabled: true };
  }

  /** Validate a coupon for the current cart without reserving it. */
  private async resolveCoupon(tx: Prisma.TransactionClient, code: string, userId: string, productIds: string[], now: Date) {
    const coupon = await tx.coupon.findUnique({ where: { code_canonical: code }, include: { products: true, _count: { select: { reservations: { where: { status: 'redeemed' } } } } } });
    if (!coupon || !coupon.active || coupon.valid_from > now || (coupon.valid_until && coupon.valid_until <= now)) {
      throw apiError(422, 'COUPON_INVALID', 'Dieser Gutscheincode ist ungültig oder abgelaufen.');
    }
    if (coupon.max_redemptions !== null && coupon._count.reservations >= coupon.max_redemptions) {
      throw apiError(422, 'COUPON_EXHAUSTED', 'Dieser Gutscheincode wurde bereits vollständig eingelöst.');
    }
    if (coupon.products.length && !productIds.every(id => coupon.products.some(link => link.product_id === id))) {
      throw apiError(422, 'COUPON_NOT_APPLICABLE', 'Dieser Gutscheincode gilt nicht für alle Produkte im Warenkorb.');
    }
    const own = await tx.couponReservation.findFirst({ where: { coupon_id: coupon.id, user_id: userId,
      status: { in: ['reserved', 'redeemed'] } } });
    if (own) throw apiError(422, 'COUPON_ALREADY_USED', 'Dieser Gutscheincode wurde bereits verwendet.');
    return coupon;
  }

  async cartWithCoupon(ctx: SessionContext, input: unknown) {
    const body = bodyObject(input, ['coupon_code']);
    const code = optionalCouponCode(body.coupon_code);
    const cart = await this.getCart(ctx);
    if (!code) return { ...cart, discount_cents: '0', total_gross_cents: cart.subtotal_gross_cents, coupon_code: null };
    const coupon = await this.resolveCoupon(this.db, code, ctx.user.id,
      cart.items.map(item => item.product_id), new Date());
    const subtotal = BigInt(cart.subtotal_gross_cents);
    const discount = discountFor(coupon.type, coupon.value, subtotal);
    return { ...cart, discount_cents: String(discount), total_gross_cents: String(subtotal - discount),
      coupon_code: coupon.code_canonical };
  }

  /**
   * Place an order. Everything that determines the amount is recomputed from the
   * database inside the transaction: prices, coupon validity and course links.
   * The browser only contributes the address, the accepted legal versions, the
   * payment method and an idempotency key.
   */
  async checkout(ctx: SessionContext, input: unknown, request: { ip: string; userAgent: string }) {
    const body = bodyObject(input, ['idempotency_key', 'billing_address', 'coupon_code', 'payment_method',
      'legal_versions', 'terms_accepted', 'withdrawal_notice_seen', 'privacy_notice_seen']);
    const key = idempotencyKey(body.idempotency_key);
    const address = billingAddress(body.billing_address);
    const method = paymentMethod(body.payment_method);
    const code = optionalCouponCode(body.coupon_code);
    const accepted = body.legal_versions;
    if (!accepted || typeof accepted !== 'object' || Array.isArray(accepted)) {
      throw apiError(422, 'LEGAL_REQUIRED', 'Bitte bestätige die rechtlichen Hinweise.');
    }
    const versions = accepted as Record<string, unknown>;
    const required = ['terms', 'withdrawal', 'privacy'] as const;
    if (required.some(kind => typeof versions[kind] !== 'string')) {
      throw apiError(422, 'LEGAL_REQUIRED', 'Bitte bestätige die rechtlichen Hinweise.');
    }
    for (const flag of ['terms_accepted', 'withdrawal_notice_seen', 'privacy_notice_seen'] as const) {
      if (body[flag] !== true) throw apiError(422, 'LEGAL_REQUIRED', 'Bitte bestätige die rechtlichen Hinweise.');
    }
    const rawEmail = ctx.user.email_original;
    if (!rawEmail) throw apiError(409, 'ACCOUNT_INCOMPLETE', 'Für diese Bestellung fehlt eine bestätigte E-Mail-Adresse.');
    const email = normalizeEmail(rawEmail);
    const ipHmac = keyedHash(getConfig().auditKey, 'checkout-ip', request.ip);
    const agentHmac = keyedHash(getConfig().auditKey, 'checkout-agent', request.userAgent);

    return this.transaction(async tx => {
      // Idempotency: the second identical submission returns the first order.
      const previous = await tx.order.findUnique({ where: { user_id_checkout_idempotency_key:
        { user_id: ctx.user.id, checkout_idempotency_key: key } }, select: { id: true } });
      if (previous) return this.orderView(tx, ctx, previous.id);
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.user.id}::uuid FOR UPDATE`;
      const settings = await this.settings(tx);
      if (!settings?.sales_enabled) throw apiError(409, 'SALES_DISABLED', 'Der Verkauf ist derzeit nicht freigeschaltet.');
      const now = new Date();
      const cart = await this.openCart(tx, ctx.user.id, false);
      if (!cart) throw apiError(409, 'CART_EMPTY', 'Der Warenkorb ist leer.');
      const items = await tx.cartItem.findMany({ where: { cart_id: cart.id }, include: { product: true, price: true },
        orderBy: { added_at: 'asc' } });
      if (!items.length) throw apiError(409, 'CART_EMPTY', 'Der Warenkorb ist leer.');
      if (items.length > 20) throw apiError(422, 'CART_TOO_LARGE', 'Der Warenkorb enthält zu viele Positionen.');

      // Re-price every line, then freeze product, price and course versions.
      const lines: { productId: string; priceId: string; title: string; variant: string | null; unit: bigint;
        courses: { course_id: string; course_version_id: string; title: string; access_days: number | null }[] }[] = [];
      for (const item of items) {
        const current = item.price;
        const inWindow = current.status === 'active' && current.valid_from <= now &&
          (!current.valid_until || current.valid_until > now);
        const links = await tx.productCourse.findMany({ where: { product_id: item.product_id }, orderBy: { position: 'asc' },
          include: { course: { include: { versions: { where: { state: 'published' }, take: 1 } } } } });
        const published = links.filter(link => link.course.status === 'published' && link.course.versions[0]);
        if (!inWindow || item.product.status !== 'active' || !published.length) {
          throw apiError(409, 'PRICE_CHANGED', `„${item.product.title}“ ist nicht mehr zum hinterlegten Preis verfügbar. Bitte entferne das Produkt und füge es erneut hinzu.`);
        }
        const unit = effectivePrice(current, now);
        if (unit <= 0n) throw apiError(409, 'PRICE_CHANGED', `„${item.product.title}“ hat keinen gültigen Preis.`);
        lines.push({ productId: item.product_id, priceId: item.price_id, title: item.product.title,
          variant: item.product.variant_name, unit,
          courses: published.map(link => ({ course_id: link.course_id, course_version_id: link.course.versions[0]!.id,
            title: link.course.versions[0]!.title,
            access_days: link.access_days_override ?? link.course.versions[0]!.default_access_days ?? null })) });
      }
      const subtotal = lines.reduce((sum, line) => sum + line.unit, 0n);
      let discount = 0n;
      let couponId: string | null = null;
      if (code) {
        const coupon = await this.resolveCoupon(tx, code, ctx.user.id, lines.map(line => line.productId), now);
        // Lock the coupon so concurrent checkouts cannot exceed max_redemptions.
        await tx.$queryRaw`SELECT id FROM coupons WHERE id = ${coupon.id}::uuid FOR UPDATE`;
        const reserved = await tx.couponReservation.count({ where: { coupon_id: coupon.id,
          status: { in: ['reserved', 'redeemed'] } } });
        if (coupon.max_redemptions !== null && reserved >= coupon.max_redemptions) {
          throw apiError(422, 'COUPON_EXHAUSTED', 'Dieser Gutscheincode wurde bereits vollständig eingelöst.');
        }
        discount = discountFor(coupon.type, coupon.value, subtotal);
        couponId = coupon.id;
      }
      const total = subtotal - discount;
      if (total <= 0n) throw apiError(409, 'TOTAL_NOT_PAYABLE', 'Der zu zahlende Betrag muss positiv sein.');

      // Legal versions must be the ones currently active — a stale tab cannot
      // accept a wording that has already been replaced.
      const active = await tx.legalDocumentVersion.findMany({ where: { status: 'active' }, include: { document: true } });
      const wanted = new Map(active.map(version => [version.document.kind, version]));
      for (const kind of required) {
        const version = wanted.get(kind);
        if (!version || version.id !== versions[kind]) {
          throw apiError(409, 'LEGAL_CHANGED', 'Die rechtlichen Hinweise wurden aktualisiert. Bitte lade die Seite neu und bestätige erneut.');
        }
      }

      const orderId = uuidv7();
      const numberRow = await tx.$queryRaw<{ number: string }[]>`SELECT trainerb_next_order_number('TB-', 'order_number_seq') AS number`;
      const orderNumber = numberRow[0].number;
      const dueAt = method === 'invoice' ? new Date(now.getTime() + settings.payment_term_days * 24 * 60 * 60_000) : null;
      const paymentReference = `TB-${orderNumber}`;
      await tx.order.create({ data: { id: orderId, order_number: orderNumber, cart_id: cart.id,
        checkout_idempotency_key: key, user_id: ctx.user.id, buyer_email_original: email.original,
        buyer_email_canonical: email.canonical, currency: 'EUR', payment_method: method,
        payment_state: 'awaiting', fulfillment_state: 'waiting', subtotal_gross_cents: subtotal,
        discount_cents: discount, total_gross_cents: total,
        billing_snapshot: address as unknown as Prisma.InputJsonValue, placed_at: now, due_at: dueAt,
        payment_reference: paymentReference, created_by: ctx.user.id } });
      for (const [index, line] of lines.entries()) {
        await tx.orderItem.create({ data: { order_id: orderId, product_id: line.productId, price_id: line.priceId,
          position: index + 1, title_snapshot: line.title, variant_snapshot: line.variant, unit_gross_cents: line.unit,
          discount_cents: 0n, total_gross_cents: line.unit } });
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
          user_id: ctx.user.id, status: 'reserved' } });
      }
      if (method === 'invoice') {
        // The invoice attempt stays open until an administrator confirms the
        // bank transfer. It never becomes 'succeeded' on its own.
        await tx.paymentAttempt.create({ data: { id: uuidv7(), order_id: orderId, provider: 'invoice',
          environment: getConfig().appEnv === 'production' ? 'live' : 'test',
          provider_idempotency_key: `invoice-${orderId}`, status: 'pending', amount_cents: total,
          currency: 'EUR' } });
        await this.issueInvoice(tx, orderId, settings);
      }
      await tx.cartItem.deleteMany({ where: { cart_id: cart.id } });
      await tx.cart.update({ where: { id: cart.id }, data: { status: 'converted' } });
      await this.audit(tx, ctx.user.id, 'order.placed', 'order', orderId,
        { order_number: orderNumber, total_gross_cents: String(total), payment_method: method,
          coupon: couponId ? code : null });
      if (ctx.user.first_name && ctx.user.email_original) {
        await this.outbox.notify(tx, ctx.user.id, ctx.user.email_original, ctx.user.first_name, 'order_placed',
          { order_number: orderNumber, total: centsToText(total), payment_reference: paymentReference });
      }
      return this.orderView(tx, ctx, orderId);
    });
  }

  private async issueInvoice(tx: Prisma.TransactionClient, orderId: string,
                             settings: NonNullable<Awaited<ReturnType<Shop['settings']>>>) {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: {
      items: { orderBy: { position: 'asc' } }, user: true } });
    const numberRow = await tx.$queryRaw<{ number: string }[]>`SELECT trainerb_next_order_number('TB-RE-', 'invoice_number_seq') AS number`;
    const buyer = order.billing_snapshot as unknown as BillingAddress;
    await tx.invoice.create({ data: { id: uuidv7(), order_id: orderId, invoice_number: numberRow[0].number,
      seller_snapshot: { name: settings.invoice_seller_name, street: settings.invoice_seller_street,
        postal_code: settings.invoice_seller_postal, city: settings.invoice_seller_city,
        country: settings.invoice_seller_country, email: settings.invoice_seller_email,
        vat_id: settings.invoice_seller_vat_id } as Prisma.InputJsonValue,
      buyer_snapshot: buyer as unknown as Prisma.InputJsonValue,
      lines_snapshot: order.items.map(item => ({ position: item.position, title: item.title_snapshot,
        variant: item.variant_snapshot, quantity: item.quantity, unit_gross_cents: String(item.unit_gross_cents),
        discount_cents: String(item.discount_cents), total_gross_cents: String(item.total_gross_cents) })) as Prisma.InputJsonValue,
      total_gross_cents: order.total_gross_cents, currency: order.currency, due_at: order.due_at,
      payment_reference: order.payment_reference } });
  }

  /** Order view for its owner or for staff with order permissions. */
  async orderView(tx: Prisma.TransactionClient, ctx: SessionContext, orderId: string) {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: {
      items: { orderBy: { position: 'asc' }, include: { courses: true } },
      acceptances: { select: { kind: true, wording_snapshot: true, legal_document_version_id: true } },
      invoice: true, attempts: { orderBy: { created_at: 'desc' } }, coupon: { include: { coupon: true } },
      accesses: { select: { course_id: true, revoked_at: true } } } });
    if (!order) throw missing();
    const staff = ctx.permissionKeys.has('orders.read') && ctx.session.kind === 'backoffice';
    if (order.user_id !== ctx.user.id && !staff) throw missing();
    const settings = await this.settings(tx);
    return {
      id: order.id, order_number: order.order_number, placed_at: order.placed_at,
      payment_method: order.payment_method, payment_state: order.payment_state,
      fulfillment_state: order.fulfillment_state, subtotal_gross_cents: String(order.subtotal_gross_cents),
      discount_cents: String(order.discount_cents), total_gross_cents: String(order.total_gross_cents),
      currency: order.currency, due_at: order.due_at, paid_at: order.paid_at,
      payment_reference: order.payment_reference, billing_snapshot: order.billing_snapshot,
      items: order.items.map(item => ({ product_id: item.product_id, title: item.title_snapshot,
        variant: item.variant_snapshot, unit_gross_cents: String(item.unit_gross_cents),
        total_gross_cents: String(item.total_gross_cents), courses: item.courses.map(course => ({
          course_id: course.course_id, title: course.course_title_snapshot, access_days: course.access_days })) })),
      acceptances: order.acceptances, coupon_code: order.coupon?.coupon.code_canonical ?? null,
      invoice: order.invoice ? { id: order.invoice.id, invoice_number: order.invoice.invoice_number,
        issued_at: order.invoice.issued_at, seller: order.invoice.seller_snapshot, buyer: order.invoice.buyer_snapshot,
        lines: order.invoice.lines_snapshot, total_gross_cents: String(order.invoice.total_gross_cents),
        due_at: order.invoice.due_at, payment_reference: order.invoice.payment_reference } : null,
      bank: order.payment_method === 'invoice' && order.payment_state === 'awaiting' && settings ? {
        holder: settings.bank_account_holder, iban: settings.bank_iban, bic: settings.bank_bic,
        bank: settings.bank_name, reference: order.payment_reference } : null,
      access: order.accesses.map(access => ({ course_id: access.course_id, revoked: access.revoked_at !== null })),
    };
  }

  /** Owner or staff view of a single order. */
  async orderDetail(ctx: SessionContext, orderIdInput: string) {
    const orderId = requireUuid(orderIdInput);
    return this.orderView(this.db, ctx, orderId);
  }

  async listOrders(ctx: SessionContext, limitInput: unknown, cursorInput: unknown) {
    const limit = limitInput === undefined ? 20 : Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw apiError(422, 'INVALID_LIMIT', 'Ungültige Seitengröße.');
    const cursor = cursorInput === undefined ? undefined : requireUuid(String(cursorInput));
    return this.transaction(async tx => {
      const rows = await this.db.order.findMany({ where: { user_id: ctx.user.id }, take: limit + 1,
        orderBy: [{ placed_at: 'desc' }, { id: 'desc' }], ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      const data = rows.slice(0, limit).map(order => ({ id: order.id, order_number: order.order_number,
        placed_at: order.placed_at, payment_state: order.payment_state,
        fulfillment_state: order.fulfillment_state, total_gross_cents: String(order.total_gross_cents),
        currency: order.currency }));
      return { data, next_cursor: rows.length > limit && data.length ? data[data.length - 1].id : null };
    });
  }

  /** Admin: all orders with an optional state filter. */
  async adminOrders(ctx: SessionContext, stateInput: unknown, limitInput: unknown, cursorInput: unknown) {
    const state = stateInput === undefined || stateInput === '' ? null : String(stateInput);
    if (state !== null && !['awaiting', 'paid', 'cancelled', 'review'].includes(state)) {
      throw apiError(422, 'INVALID_STATE', 'Unbekannter Status.');
    }
    const limit = limitInput === undefined ? 25 : Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw apiError(422, 'INVALID_LIMIT', 'Ungültige Seitengröße.');
    const cursor = cursorInput === undefined ? undefined : requireUuid(String(cursorInput));
    const where: Prisma.OrderWhereInput = state ? { payment_state: state } : {};
    const rows = await this.db.order.findMany({ where, take: limit + 1, orderBy: [{ placed_at: 'desc' }, { id: 'desc' }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { user: { select: { id: true, first_name: true, last_name: true, email_canonical: true } },
        items: { select: { title_snapshot: true } } } });
    const data = rows.slice(0, limit).map(order => ({ id: order.id, order_number: order.order_number,
      placed_at: order.placed_at, buyer: { name: `${order.user.first_name ?? ''} ${order.user.last_name ?? ''}`.trim(),
        email: order.user.email_canonical }, payment_method: order.payment_method, payment_state: order.payment_state,
      fulfillment_state: order.fulfillment_state, total_gross_cents: String(order.total_gross_cents),
      currency: order.currency, items: order.items.map(item => item.title_snapshot) }));
    return { data, next_cursor: rows.length > limit && data.length ? data[data.length - 1].id : null,
      totals: { awaiting: await this.db.order.count({ where: { payment_state: 'awaiting' } }),
        paid: await this.db.order.count({ where: { payment_state: 'paid' } }) } };
  }

  private async staffActor(tx: Prisma.TransactionClient, ctx: SessionContext, permission: string) {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.user.id}::uuid FOR UPDATE`;
    await this.sessions.assertCurrent(tx, ctx);
    if (ctx.session.kind !== 'backoffice' || !ctx.permissionKeys.has(permission)) {
      throw apiError(403, 'FORBIDDEN', 'Kein Zugriff.');
    }
  }

  /**
   * Confirm a bank transfer that actually arrived. This is the only path that
   * turns an invoice into a paid order, and it grants access + redeems the
   * coupon in the same transaction.
   */
  async confirmPayment(ctx: SessionContext, orderIdInput: string, input: unknown) {
    const orderId = requireUuid(orderIdInput);
    const body = bodyObject(input, ['reference', 'received_at', 'note']);
    const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
    if (!/^[A-Za-z0-9 -]{3,60}$/.test(reference)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { reference: 'Bitte die Referenz des Zahlungseingangs angeben.' });
    }
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length > 500 || /[\u0000-\u001f]/.test(note)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { note: 'Ungültige Notiz.' });
    }
    return this.transaction(async tx => {
      await this.staffActor(tx, ctx, 'orders.manage');
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw missing();
      if (order.payment_state === 'paid') return this.orderView(tx, ctx, orderId);
      if (order.payment_state !== 'awaiting') {
        throw apiError(409, 'ORDER_NOT_PAYABLE', 'Diese Bestellung kann nicht mehr als bezahlt gebucht werden.');
      }
      const attempt = await tx.paymentAttempt.findFirst({ where: { order_id: orderId, provider: 'invoice',
        status: { in: ['pending', 'created'] } }, orderBy: { created_at: 'desc' } });
      const now = new Date();
      if (attempt) {
        await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'succeeded', confirmed_at: now,
          provider_payment_id: reference } });
      } else {
        await tx.paymentAttempt.create({ data: { id: uuidv7(), order_id: orderId, provider: 'invoice',
          environment: getConfig().appEnv === 'production' ? 'live' : 'test',
          provider_idempotency_key: `invoice-${orderId}-confirm`, status: 'succeeded', amount_cents: order.total_gross_cents,
          currency: order.currency, confirmed_at: now, provider_payment_id: reference } });
      }
      await tx.order.update({ where: { id: orderId }, data: { payment_state: 'paid', paid_at: now,
        paid_confirmed_by: ctx.user.id } });
      await this.grantAccess(tx, orderId);
      await tx.couponReservation.updateMany({ where: { order_id: orderId, status: 'reserved' },
        data: { status: 'redeemed', resolved_at: now } });
      await this.audit(tx, ctx.user.id, 'order.payment_confirmed', 'order', orderId, { reference, note: note || null });
      if (order.buyer_email_original) {
        const buyer = await tx.user.findUnique({ where: { id: order.user_id }, select: { first_name: true } });
        await this.outbox.notify(tx, order.user_id, order.buyer_email_original, buyer?.first_name || 'du', 'order_paid',
          { order_number: order.order_number, total: centsToText(order.total_gross_cents),
            payment_reference: order.payment_reference || order.order_number });
      }
      return this.orderView(tx, ctx, orderId);
    });
  }

  /** Access is derived from the frozen order snapshot, never from current product links. */
  private async grantAccess(tx: Prisma.TransactionClient, orderId: string) {
    const items = await tx.orderItemCourse.findMany({ where: { order_id: orderId }, include: { item: true },
      orderBy: [{ order_item_product: 'asc' }] });
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (!items.length) throw apiError(409, 'FULFILMENT_INCOMPLETE', 'Diese Bestellung enthält keine Kurszuordnung.');
    const now = new Date();
    for (const item of items) {
      const existing = await tx.courseAccess.findFirst({ where: { user_id: order.user_id, course_id: item.course_id,
        revoked_at: null } });
      if (existing) {
        // Buying the same course twice would silently extend nothing; the second
        // order still gets fulfilled, but the existing access stays untouched.
        continue;
      }
      const endsAt = item.access_days ? new Date(now.getTime() + item.access_days * 24 * 60 * 60_000) : null;
      await tx.courseAccess.create({ data: { id: uuidv7(), user_id: order.user_id, course_id: item.course_id,
        course_version_id: item.course_version_id, source: 'order', order_id: orderId, starts_at: now, ends_at: endsAt } });
    }
    await tx.order.update({ where: { id: orderId }, data: { fulfillment_state: 'fulfilled', fulfilled_at: now } });
  }

  async cancelOrder(ctx: SessionContext, orderIdInput: string, input: unknown) {
    const orderId = requireUuid(orderIdInput);
    const body = bodyObject(input, ['reason']);
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!/^[a-z_]{3,60}$/.test(reason)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { reason: 'Bitte einen Grund angeben.' });
    }
    return this.transaction(async tx => {
      await this.staffActor(tx, ctx, 'orders.manage');
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw missing();
      if (order.payment_state === 'cancelled') return this.orderView(tx, ctx, orderId);
      const now = new Date();
      const accesses = await tx.courseAccess.findMany({ where: { order_id: orderId, revoked_at: null } });
      for (const access of accesses) {
        await tx.courseAccess.update({ where: { id: access.id }, data: { revoked_at: now,
          revoke_reason: `order_cancelled:${reason}` } });
      }
      await tx.order.update({ where: { id: orderId }, data: { payment_state: 'cancelled', cancelled_at: now,
        cancelled_reason: reason, fulfillment_state: 'blocked' } });
      await tx.paymentAttempt.updateMany({ where: { order_id: orderId, status: { in: ['created', 'pending'] } },
        data: { status: 'cancelled', failure_code: 'cancelled_by_staff' } });
      await this.audit(tx, ctx.user.id, 'order.cancelled', 'order', orderId, { reason });
      return this.orderView(tx, ctx, orderId);
    });
  }
}
