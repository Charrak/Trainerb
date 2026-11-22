import { EDITORIAL_TEXT_LIMIT } from '@trainerb/contracts';
import {approvedForNewSales} from './release-approval';
import { lockProvider, reviewRequired } from './provider-profile';
import { assertBackofficeWrite } from './backoffice-write';
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

  /**
   * Tax rates: read them, add a period, retire one early.
   *
   * A rate is never edited in place. Changing a percentage means inserting a new
   * row from a date and closing the old period the day before — otherwise an
   * invoice issued last year would silently claim a different rate today.
   */
  async taxRates() {
    const rows = await this.db.taxRate.findMany({ orderBy: [{ category: 'asc' }, { valid_from: 'desc' }] });
    return { data: rows.map(row => ({ id: row.id, category: row.category, rate_bp: row.rate_bp,
      label: row.label, note: row.note, valid_from: row.valid_from, valid_until: row.valid_until,
      is_default: row.is_default, current: row.valid_until === null })) };
  }

  async createTaxRate(ctx: SessionContext, input: unknown) {
    const body = bodyObject(input, ['category', 'rate_bp', 'label', 'note', 'valid_from', 'is_default']);
    const category = typeof body.category === 'string' ? body.category.trim() : '';
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(category)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { category: 'Ungültige Kategorie.' });
    }
    // Basis points as a string, so "19" and "19.0" cannot silently become 19 %.
    const rawRate = String(body.rate_bp ?? '');
    if (!/^[0-9]{1,4}$/.test(rawRate) || Number(rawRate) > 9900) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.',
        { rate_bp: 'Satz in Basispunkten angeben (1900 = 19 %).' });
    }
    const rateBp = Number(rawRate);
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    if (!label || label.length > 60) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { label: 'Bezeichnung angeben.' });
    }
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length > 500) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { note: 'Notiz zu lang.' });
    }
    const validFrom = body.valid_from === undefined ? new Date()
      : new Date(String(body.valid_from));
    if (Number.isNaN(validFrom.getTime())) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { valid_from: 'Datum ungültig.' });
    }
    return this.db.$transaction(async tx => {
      await this.staffActor(tx, ctx, 'settings.manage');
      await tx.$queryRaw`SELECT id FROM tax_rates WHERE category = ${category} FOR UPDATE`;
      const overlapping = await tx.taxRate.findFirst({ where: { category,
        valid_from: { lte: validFrom }, OR: [{ valid_until: null }, { valid_until: { gt: validFrom } }] } });
      if (overlapping) {
        // A gap or an overlap would make "the rate on that day" ambiguous.
        throw apiError(409, 'TAX_RATE_OVERLAP',
          'Für diesen Zeitraum ist bereits ein Steuersatz hinterlegt. Beende den bisherigen Zeitraum zuerst.');
      }
      const isDefault = body.is_default === true;
      if (isDefault) {
        await tx.taxRate.updateMany({ where: { is_default: true }, data: { is_default: false } });
      }
      const id = uuidv7();
      await tx.taxRate.create({ data: { id, category, rate_bp: rateBp, label,
        note: note || null, valid_from: validFrom, is_default: isDefault, created_by: ctx.user.id } });
      await this.audit(tx, ctx, 'tax_rate.created', 'tax_rate', id,
        { category, rate_bp: rateBp, valid_from: validFrom.toISOString(), is_default: isDefault });
      return { id, category, rate_bp: rateBp, label, valid_from: validFrom, is_default: isDefault };
    });
  }

  /**
   * End a rate's period. Rows are never deleted: an old invoice may still point
   * at the rate it was issued with.
   */
  async closeTaxRate(ctx: SessionContext, idInput: string, input: unknown) {
    const id = requireUuid(idInput);
    const body = bodyObject(input, ['valid_until']);
    const validUntil = body.valid_until === undefined ? new Date() : new Date(String(body.valid_until));
    if (Number.isNaN(validUntil.getTime())) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { valid_until: 'Datum ungültig.' });
    }
    return this.db.$transaction(async tx => {
      await this.staffActor(tx, ctx, 'settings.manage');
      const row = await tx.taxRate.findUnique({ where: { id } });
      if (!row) throw apiError(404, 'NOT_FOUND', 'Nicht gefunden.');
      if (row.valid_until !== null) {
        throw apiError(409, 'TAX_RATE_CLOSED', 'Dieser Zeitraum ist bereits beendet.');
      }
      if (validUntil <= row.valid_from) {
        throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.',
          { valid_until: 'Das Ende muss nach dem Beginn liegen.' });
      }
      await tx.taxRate.update({ where: { id }, data: { valid_until: validUntil,
        is_default: false } });
      await this.audit(tx, ctx, 'tax_rate.closed', 'tax_rate', id, { valid_until: validUntil.toISOString() });
      return { id, valid_until: validUntil };
    });
  }

  /** Public configuration facts the checkout needs; no internal numbers leak. */
  async publicConfig() {
    const settings = await this.db.commerceSettings.findUnique({ where: { id: 1 } });
    const legal = await this.db.legalDocumentVersion.findMany({ where: { status: 'active' },
      include: { document: { select: { kind: true } } } });
    return {
      sales_enabled: !!settings?.sales_enabled && await approvedForNewSales(),
      payment_term_days: settings?.payment_term_days ?? null,
      stripe_enabled: !!getConfig().stripePublishableKey,
      legal: Object.fromEntries(legal.map(version => [version.document.kind, {
        id: version.id, version: version.version, wording: version.wording, ...(version.document.kind === 'imprint' && version.provider_snapshot ? { provider_snapshot:version.provider_snapshot } : {}) }])),
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
      if(values.sales_enabled){
        if(!await approvedForNewSales())throw apiError(409,'RELEASE_APPROVAL_REQUIRED','Für neue Verkäufe fehlt die gültige Betriebsfreigabe.');
        const profile=await lockProvider(tx);
        if(!profile.revision || !await tx.legalDocumentVersion.count({where:{document:{kind:'imprint'},status:'active',provider_revision:profile.revision}})) throw reviewRequired();
      }
      const { id: _ignored, ...update } = values;
      const saved = await tx.commerceSettings.upsert({ where: { id: 1 }, create: { id: 1, ...values }, update });
      await this.audit(tx, ctx, 'commerce.settings_updated', 'commerce_settings', '1',
        { sales_enabled: saved.sales_enabled, payment_term_days: saved.payment_term_days });
      return saved;
    });
  }

  async editorialLegal(kind:string) {
    if(!['terms','privacy','withdrawal','imprint','payment_info'].includes(kind)) throw apiError(404,'NOT_FOUND','Dokument nicht gefunden.');
    const versions=await this.db.legalDocumentVersion.findMany({where:{document:{kind}},orderBy:{version:'desc'},take:20,
      select:{id:true,version:true,wording:true,status:true,activated_at:true,provider_revision:true,provider_snapshot:true}});
    const active=await this.db.legalDocumentVersion.findFirst({where:{document:{kind},status:'active'},select:{version:true}});
    return {versions,active_version:active?.version ?? null};
  }

  /** A new legal version starts as a draft; only activation makes it binding. */
  async createLegalVersion(ctx: SessionContext, input: unknown) {
    const body = bodyObject(input, ['kind', 'wording', 'base_id', 'provider_revision']);
    const kind = body.kind;
    if (kind !== 'terms' && kind !== 'withdrawal' && kind !== 'privacy' && kind !== 'imprint' && kind !== 'payment_info') {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { kind: 'Unbekanntes Dokument.' });
    }
    const wording = plainText(body.wording, 'wording', EDITORIAL_TEXT_LIMIT, false, true);
    if (!wording) throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { wording: 'Pflichtfeld.' });
    return this.db.$transaction(async tx => {
      await assertBackofficeWrite(tx,this.sessions,ctx,'legal.manage');
      await tx.legalDocument.createMany({data:[{id:uuidv7(),kind}],skipDuplicates:true});
      const [document]=await tx.$queryRaw<{id:string}[]>`SELECT id FROM legal_documents WHERE kind=${kind} FOR UPDATE`;
      const last = await tx.legalDocumentVersion.findFirst({ where: { document_id: document.id }, orderBy:{version:'desc'} });
      if ('base_id' in body && body.base_id !== (last?.id ?? null)) throw apiError(409,'LEGAL_VERSION_CHANGED','Es gibt eine neuere Fassung. Bitte neu laden.');
      const profile=kind==='imprint'?await lockProvider(tx):null;
      if(profile && (!profile.details || body.provider_revision!==profile.revision))throw reviewRequired();
      if(!profile && 'provider_revision' in body)throw apiError(422,'INVALID_FIELD','Anbieterprofil nur für das Impressum angeben.');
      const version = await tx.legalDocumentVersion.create({ data: { id: uuidv7(), document_id: document.id,
        version: (last?.version ?? 0) + 1, wording, status: 'draft', ...(profile ? {provider_revision:profile.revision,provider_snapshot:profile.details as Prisma.JsonObject} : {}) } });
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
      await assertBackofficeWrite(tx,this.sessions,ctx,'legal.manage');
      await tx.$queryRaw`SELECT d.id FROM legal_documents d JOIN legal_document_versions v ON v.document_id=d.id WHERE v.id=${versionId}::uuid FOR UPDATE OF d`;
      const version = await tx.legalDocumentVersion.findUnique({ where: { id: versionId },include:{document:{select:{kind:true}}} });
      if (!version) throw apiError(404, 'NOT_FOUND', 'Nicht gefunden.');
      if(version.document.kind==='imprint' && (!version.provider_revision || (await lockProvider(tx)).revision!==version.provider_revision))throw reviewRequired();
      if (version.status === 'active') return { id: version.id, status: version.status };
      if (version.status === 'retired') throw apiError(409, 'LEGAL_VERSION_RETIRED', 'Diese Fassung ist bereits abgelöst.');
      if (await tx.legalDocumentVersion.count({where:{document_id:version.document_id,version:{gt:version.version}}})) {
        throw apiError(409,'LEGAL_VERSION_CHANGED','Nur der neueste Entwurf kann freigegeben werden.');
      }
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
        include: { products: { select: { product_id: true, product: { select: { title: true, sku: true } } },
          orderBy: { created_at: 'asc' } },
          _count: { select: { reservations: { where: { status: { in: ['reserved', 'redeemed'] } } } } } } });
      return { data: coupons.map(coupon => ({ id: coupon.id, code: coupon.code_canonical, type: coupon.type,
        value: String(coupon.value), currency: coupon.currency, valid_from: coupon.valid_from,
        valid_until: coupon.valid_until, max_redemptions: coupon.max_redemptions, active: coupon.active,
        redeemed: coupon._count.reservations, product_ids: coupon.products.map(link => link.product_id),
        // Ohne Namen wäre die Liste im Backoffice nur eine Sammlung von UUIDs.
        products: coupon.products.map(link => ({ id: link.product_id, title: link.product.title,
          sku: link.product.sku })) })) };
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
        { code: coupon.code_canonical, type: coupon.type, value: String(coupon.value), active: coupon.active,
          // Die Beschränkung steht im Audit, damit ein späterer Rabatt nachvollziehbar bleibt.
          product_ids: productIds });
      return { id: coupon.id, code: coupon.code_canonical, active: coupon.active, product_ids: productIds };
    });
  }

  /**
   * Eine Beschränkung darf nur auf Produkte zeigen, die es gibt und die heute
   * verkäuflich sind. Ein Gutschein auf ein zurückgezogenes Produkt wäre ein
   * Rabatt, der nie greifen kann.
   */
  private async checkCouponProducts(tx: Prisma.TransactionClient, ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const products = await tx.product.findMany({ where: { id: { in: ids } },
      select: { id: true, status: true, prices: { where: { status: 'active' }, select: { id: true }, take: 1 } } });
    if (products.length !== new Set(ids).size) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { product_ids: 'Unbekanntes Produkt.' });
    }
    if (products.some(product => product.status !== 'active' || product.prices.length === 0)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.',
        { product_ids: 'Nur aktive Produkte mit einem aktiven Preis können eingeschränkt werden.' });
    }
    return products.map(product => product.id);
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
