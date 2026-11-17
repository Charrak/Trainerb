import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { Sessions, type SessionContext } from './sessions';
import { apiError, bodyObject, requireUuid } from './security';
import { couponValues, plainText } from './commerce-validation';
import { getConfig } from './config';

@Injectable()
export class Commerce {
  constructor(private readonly db: Database, private readonly sessions: Sessions) {}

  private async staffActor(tx: Prisma.TransactionClient, ctx: SessionContext, permission: string) {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.user.id}::uuid FOR UPDATE`;
    await this.sessions.assertCurrent(tx, ctx);
    if (ctx.session.kind !== 'backoffice' || !ctx.permissionKeys.has(permission)) {
      throw apiError(403, 'FORBIDDEN', 'Kein Zugriff.');
    }
  }
  private async audit(tx: Prisma.TransactionClient, ctx: SessionContext, action: string, targetType: string,
                      target: string, details?: Prisma.InputJsonValue) {
    await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: ctx.user.id, origin: 'user', action,
      target_type: targetType, target_ref: target, ...(details ? { after_safe: details } : {}) } });
  }

  /** Public configuration facts the checkout needs; no internal numbers leak. */
  async publicConfig() {
    const settings = await this.db.commerceSettings.findUnique({ where: { id: 1 } });
    const legal = await this.db.legalDocumentVersion.findMany({ where: { status: 'active' },
      include: { document: { select: { kind: true } } } });
    return {
      sales_enabled: settings?.sales_enabled ?? false,
      payment_term_days: settings?.payment_term_days ?? null,
      stripe_enabled: !!getConfig().stripePublishableKey,
      legal: Object.fromEntries(legal.map(version => [version.document.kind, {
        id: version.id, version: version.version, wording: version.wording }])),
    };
  }

  async adminState(ctx: SessionContext) {
    return this.db.$transaction(async tx => {
      await this.staffActor(tx, ctx, 'settings.manage');
      const settings = await tx.commerceSettings.findUnique({ where: { id: 1 } });
      const documents = await tx.legalDocument.findMany({ include: { versions: { orderBy: { version: 'desc' } } },
        orderBy: { kind: 'asc' } });
      return { settings, documents: documents.map(document => ({ kind: document.kind,
        versions: document.versions.map(version => ({ id: version.id, version: version.version, status: version.status,
          wording: version.wording, activated_at: version.activated_at })) })) };
    });
  }

  /** Settings are all-or-nothing: a half-configured invoice must not exist. */
  async updateSettings(ctx: SessionContext, input: unknown) {
    const body = bodyObject(input, ['sales_enabled', 'invoice_seller_name', 'invoice_seller_street',
      'invoice_seller_postal', 'invoice_seller_city', 'invoice_seller_country', 'invoice_seller_email',
      'invoice_seller_vat_id', 'bank_account_holder', 'bank_iban', 'bank_bic', 'bank_name', 'payment_term_days']);
    if (typeof body.sales_enabled !== 'boolean') throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { sales_enabled: 'Pflichtfeld.' });
    const term = body.payment_term_days === undefined ? 14 : Number(body.payment_term_days);
    if (!Number.isInteger(term) || term < 1 || term > 90) throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { payment_term_days: '1 bis 90 Tage.' });
    const country = typeof body.invoice_seller_country === 'string' ? body.invoice_seller_country.trim().toUpperCase() : '';
    if (!/^[A-Z]{2}$/.test(country)) throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { invoice_seller_country: 'Ländercode (2 Buchstaben).' });
    const ibanRaw = typeof body.bank_iban === 'string' ? body.bank_iban.replace(/\s+/g, '').toUpperCase() : '';
    if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(ibanRaw)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { bank_iban: 'Ungültige IBAN.' });
    }
    const email = plainText(body.invoice_seller_email, 'invoice_seller_email', 254);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { invoice_seller_email: 'Ungültige E-Mail-Adresse.' });
    }
    const values: Prisma.CommerceSettingsUncheckedCreateInput = {
      sales_enabled: body.sales_enabled as boolean,
      invoice_seller_name: plainText(body.invoice_seller_name, 'invoice_seller_name', 160)!,
      invoice_seller_street: plainText(body.invoice_seller_street, 'invoice_seller_street', 160)!,
      invoice_seller_postal: plainText(body.invoice_seller_postal, 'invoice_seller_postal', 16)!,
      invoice_seller_city: plainText(body.invoice_seller_city, 'invoice_seller_city', 120)!,
      invoice_seller_country: country,
      invoice_seller_email: email,
      invoice_seller_vat_id: plainText(body.invoice_seller_vat_id, 'invoice_seller_vat_id', 20, true),
      bank_account_holder: plainText(body.bank_account_holder, 'bank_account_holder', 160)!,
      bank_iban: ibanRaw,
      bank_bic: plainText(body.bank_bic, 'bank_bic', 11, true),
      bank_name: plainText(body.bank_name, 'bank_name', 120, true),
      payment_term_days: term,
      updated_by: ctx.user.id,
    };
    return this.db.$transaction(async tx => {
      await this.staffActor(tx, ctx, 'settings.manage');
      const { id: _ignored, ...update } = values;
      const saved = await tx.commerceSettings.upsert({ where: { id: 1 }, create: { id: 1, ...values }, update });
      await this.audit(tx, ctx, 'commerce.settings_updated', 'commerce_settings', '1',
        { sales_enabled: saved.sales_enabled, payment_term_days: saved.payment_term_days });
      return saved;
    });
  }

  /** A new legal version starts as a draft; only activation makes it binding. */
  async createLegalVersion(ctx: SessionContext, input: unknown) {
    const body = bodyObject(input, ['kind', 'wording']);
    const kind = body.kind;
    if (kind !== 'terms' && kind !== 'withdrawal' && kind !== 'privacy') {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { kind: 'Unbekanntes Dokument.' });
    }
    const wording = plainText(body.wording, 'wording', 20_000);
    if (!wording) throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { wording: 'Pflichtfeld.' });
    return this.db.$transaction(async tx => {
      await this.staffActor(tx, ctx, 'legal.manage');
      const document = (await tx.legalDocument.findFirst({ where: { kind } })) ??
        await tx.legalDocument.create({ data: { id: uuidv7(), kind } });
      const last = await tx.legalDocumentVersion.findFirst({ where: { document_id: document.id },
        orderBy: { version: 'desc' } });
      const version = await tx.legalDocumentVersion.create({ data: { id: uuidv7(), document_id: document.id,
        version: (last?.version ?? 0) + 1, wording, status: 'draft' } });
      await this.audit(tx, ctx, 'legal.version_created', 'legal_document_version', version.id, { kind, version: version.version });
      return { id: version.id, kind, version: version.version, status: version.status, wording: version.wording };
    });
  }

  /**
   * Activation replaces the previous version atomically, so there is never a
   * moment without exactly one binding wording.
   */
  async activateLegalVersion(ctx: SessionContext, versionIdInput: string) {
    const versionId = requireUuid(versionIdInput);
    return this.db.$transaction(async tx => {
      await this.staffActor(tx, ctx, 'legal.manage');
      await tx.$queryRaw`SELECT id FROM legal_document_versions WHERE id = ${versionId}::uuid FOR UPDATE`;
      const version = await tx.legalDocumentVersion.findUnique({ where: { id: versionId } });
      if (!version) throw apiError(404, 'NOT_FOUND', 'Nicht gefunden.');
      if (version.status === 'active') return { id: version.id, status: version.status };
      if (version.status === 'retired') throw apiError(409, 'LEGAL_VERSION_RETIRED', 'Diese Fassung ist bereits abgelöst.');
      const now = new Date();
      await tx.legalDocumentVersion.updateMany({ where: { document_id: version.document_id, status: 'active' },
        data: { status: 'retired' } });
      await tx.legalDocumentVersion.update({ where: { id: version.id }, data: { status: 'active',
        activated_at: now, activated_by: ctx.user.id } });
      await this.audit(tx, ctx, 'legal.version_activated', 'legal_document_version', version.id, { version: version.version });
      return { id: version.id, status: 'active' };
    });
  }

  async listCoupons(ctx: SessionContext) {
    return this.db.$transaction(async tx => {
      await this.staffActor(tx, ctx, 'coupons.manage');
      const coupons = await tx.coupon.findMany({ orderBy: { created_at: 'desc' }, take: 100,
        include: { products: { select: { product_id: true } }, _count: { select: { reservations: {
          where: { status: { in: ['reserved', 'redeemed'] } } } } } } });
      return { data: coupons.map(coupon => ({ id: coupon.id, code: coupon.code_canonical, type: coupon.type,
        value: String(coupon.value), currency: coupon.currency, valid_from: coupon.valid_from,
        valid_until: coupon.valid_until, max_redemptions: coupon.max_redemptions, active: coupon.active,
        redeemed: coupon._count.reservations, product_ids: coupon.products.map(link => link.product_id) })) };
    });
  }

  async createCoupon(ctx: SessionContext, input: unknown) {
    const values = couponValues(input);
    return this.db.$transaction(async tx => {
      await this.staffActor(tx, ctx, 'coupons.manage');
      const productIds = await this.checkCouponProducts(tx, values.product_ids);
      const coupon = await tx.coupon.create({ data: { id: uuidv7(), code_original: values.code_original,
        code_canonical: values.code_canonical, type: values.type, value: values.value, currency: values.currency,
        valid_from: values.valid_from, valid_until: values.valid_until, max_redemptions: values.max_redemptions,
        active: values.active, created_by: ctx.user.id } });
      if (productIds.length) await tx.couponProduct.createMany({ data: productIds.map(product_id => ({
        coupon_id: coupon.id, product_id })) });
      await this.audit(tx, ctx, 'coupon.created', 'coupon', coupon.id,
        { code: coupon.code_canonical, type: coupon.type, value: String(coupon.value), active: coupon.active });
      return { id: coupon.id, code: coupon.code_canonical, active: coupon.active };
    });
  }

  private async checkCouponProducts(tx: Prisma.TransactionClient, ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const found = await tx.product.count({ where: { id: { in: ids } } });
    if (found !== new Set(ids).size) throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { product_ids: 'Unbekanntes Produkt.' });
    return [...new Set(ids)];
  }

  async updateCoupon(ctx: SessionContext, couponIdInput: string, input: unknown) {
    const couponId = requireUuid(couponIdInput);
    const body = bodyObject(input, ['active']);
    if (typeof body.active !== 'boolean') throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { active: 'Pflichtfeld.' });
    const active = body.active;
    return this.db.$transaction(async tx => {
      await this.staffActor(tx, ctx, 'coupons.manage');
      await tx.$queryRaw`SELECT id FROM coupons WHERE id = ${couponId}::uuid FOR UPDATE`;
      const existing = await tx.coupon.findUnique({ where: { id: couponId } });
      if (!existing) throw apiError(404, 'NOT_FOUND', 'Nicht gefunden.');
      await tx.coupon.update({ where: { id: couponId }, data: { active } });
      await this.audit(tx, ctx, 'coupon.updated', 'coupon', couponId, { active });
      return { id: couponId, active };
    });
  }
}
