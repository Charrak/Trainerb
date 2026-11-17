import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { Sessions, type SessionContext } from './sessions';
import { apiError, bodyObject, requireUuid } from './security';
import { courseAssignments, priceValues, productInteger, productRevision, productSku, productText, productType,
  utcMinuteString } from './product-validation';

const missing = () => apiError(404, 'NOT_FOUND', 'Nicht gefunden.');
const stale = () => apiError(409, 'STALE_DRAFT', 'Der Entwurf wurde zwischenzeitlich geändert. Bitte lade ihn neu und prüfe deine Eingaben.');
const duplicate = () => apiError(409, 'PRODUCT_CONFLICT', 'Diese SKU, Preis-ID oder Position wird bereits verwendet.');
const invalid = (field: string): never => {
  throw apiError(422, 'INVALID_PRODUCT_FIELD', 'Bitte prüfe die Produkt- und Preisangaben.', { [field]: 'Ungültiger Wert.' });
};
function uniqueFailure(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'P2002';
}
/** Prices at rest are exposed as decimal strings, never as JSON floating point. */
export function priceOut(row: any) {
  return { ...row, gross_cents: String(row.gross_cents),
    sale_gross_cents: row.sale_gross_cents === null || row.sale_gross_cents === undefined ? null : String(row.sale_gross_cents) };
}

@Injectable()
export class Products {
  constructor(private readonly db: Database, private readonly sessions: Sessions) {}

  // Mirrors the catalog pattern: the actor's roles and the current session are
  // re-read under locks, so a revoked session or role cannot finish a mutation.
  private async currentActor(tx: Prisma.TransactionClient, ctx: SessionContext, permission: string) {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.user.id}::uuid FOR UPDATE`;
    const actor = await tx.user.findUnique({ where: { id: ctx.user.id },
      include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } } });
    const session = await this.sessions.assertCurrent(tx, ctx);
    const roles = actor?.roles.filter(item => item.role.permissions.some(link => link.permission.key === permission))
      .map(item => item.role.key) || [];
    // Only globally authorized back-office roles may touch products; a course
    // manager or instructor role never grants catalog-wide access.
    if (!actor || actor.status !== 'active' || session.kind !== 'backoffice' || !session.mfa_verified_at ||
        !roles.some(role => role === 'admin' || role === 'superadmin')) throw apiError(403, 'FORBIDDEN', 'Kein Zugriff.');
    return roles;
  }
  private async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try { return await this.db.$transaction(work, { timeout: 15_000 }); } catch (error) { if (uniqueFailure(error)) throw duplicate(); throw error; }
  }
  private async audit(tx: Prisma.TransactionClient, ctx: SessionContext, action: string, targetType: string, target: string,
                      productId: string, details?: Prisma.InputJsonValue) {
    await tx.product.update({ where: { id: productId }, data: { updated_at: new Date() } });
    await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: ctx.user.id, origin: 'user', action,
      target_type: targetType, target_ref: target, ...(details ? { after_safe: details } : {}) } });
  }
  private async lockProduct(tx: Prisma.TransactionClient, ctx: SessionContext, productId: string, permission: 'products.manage' | 'prices.manage') {
    await this.currentActor(tx, ctx, permission);
    await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId}::uuid FOR UPDATE`;
    const product = await tx.product.findUnique({ where: { id: productId },
      include: { courses: { orderBy: { position: 'asc' }, include: { course: { select: { id: true, slug: true, status: true, visibility: true } } } },
        prices: { select: { id: true } } } });
    if (!product) throw missing();
    return product;
  }
  /** Validate course links while holding the product lock; courses are locked in id order. */
  private async resolveCourses(tx: Prisma.TransactionClient, productId: string, productTypeValue: string,
                               assignments: { course_id: string; access_days_override: number | null }[]) {
    if (productTypeValue === 'single' && assignments.length > 1) return invalid('courses');
    if (assignments.length) {
      const ids = [...assignments.map(item => item.course_id)].sort();
      await tx.$queryRaw(Prisma.sql`SELECT id FROM courses WHERE id IN (${Prisma.join(ids.map(id => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`);
      const found = await tx.course.count({ where: { id: { in: ids } } });
      if (found !== ids.length) throw invalid('courses');
    }
    // Package completeness (at least two *different* courses) becomes a release
    // requirement only when activation exists; incomplete drafts stay savable.
    void productId;
    return assignments;
  }
  private async replaceCourses(tx: Prisma.TransactionClient, productId: string,
                               assignments: { course_id: string; access_days_override: number | null }[]) {
    await tx.productCourse.deleteMany({ where: { product_id: productId } });
    if (assignments.length) await tx.productCourse.createMany({ data: assignments.map((item, index) => ({
      product_id: productId, course_id: item.course_id, position: index + 1, access_days_override: item.access_days_override })) });
  }

  async list(ctx: SessionContext, limitInput: unknown, cursorInput: unknown) {
    const limit = limitInput === undefined ? 25 : Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw apiError(422, 'INVALID_LIMIT', 'Ungültige Seitengröße.');
    const cursor = cursorInput === undefined ? undefined : requireUuid(String(cursorInput));
    return this.transaction(async tx => {
      await this.currentActor(tx, ctx, 'products.manage');
      if (cursor && !(await tx.product.findUnique({ where: { id: cursor }, select: { id: true } }))) throw missing();
      const rows = await tx.product.findMany({ orderBy: [{ created_at: 'asc' }, { id: 'asc' }], take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: { _count: { select: { courses: true, prices: true } }, prices: { where: { status: 'draft' }, orderBy: { valid_from: 'desc' }, take: 1 } } });
      const data = rows.slice(0, limit).map(row => ({ id: row.id, sku: row.sku, type: row.type, title: row.title,
        variant_name: row.variant_name, status: row.status, revision: row.revision, updated_at: row.updated_at,
        course_count: row._count.courses, price_count: row._count.prices,
        latest_price: row.prices[0] ? { id: row.prices[0].id, gross_cents: String(row.prices[0].gross_cents),
          currency: row.prices[0].currency, valid_from: row.prices[0].valid_from } : null }));
      return { total: await tx.product.count(), data, next_cursor: rows.length > limit && data.length ? data[data.length - 1].id : null };
    });
  }
  async detail(ctx: SessionContext, productId: string) {
    requireUuid(productId);
    return this.transaction(async tx => {
      await this.currentActor(tx, ctx, 'products.manage');
      const product = await tx.product.findUnique({ where: { id: productId },
        include: { courses: { orderBy: { position: 'asc' }, include: { course: { select: { id: true, slug: true, status: true, visibility: true,
          versions: { where: { state: 'draft' }, orderBy: { version: 'desc' }, take: 1, select: { title: true } } } } } },
          prices: { orderBy: [{ valid_from: 'desc' }, { id: 'asc' }] } } });
      if (!product) throw missing();
      return { ...product, courses: product.courses.map(link => ({ course_id: link.course_id, position: link.position,
        access_days_override: link.access_days_override, slug: link.course.slug, status: link.course.status,
        visibility: link.course.visibility, title: link.course.versions[0]?.title ?? null })),
        prices: product.prices.map(priceOut) };
    });
  }
  async create(ctx: SessionContext, input: unknown) {
    const body = bodyObject(input, ['sku', 'type', 'title', 'variant_name', 'description', 'sort_order', 'courses']);
    const type = productType(body.type);
    const values = { sku: productSku(body.sku), type, title: productText(body.title, 'title', 160)!,
      variant_name: productText(body.variant_name, 'variant_name', 160, true),
      description: productText(body.description, 'description', 4000, true, true),
      sort_order: productInteger(body.sort_order, 'sort_order', 0, 100000) ?? 0 };
    const assignments = body.courses === undefined ? [] : courseAssignments(body.courses);
    const id = uuidv7();
    return this.transaction(async tx => {
      await this.currentActor(tx, ctx, 'products.manage');
      const product = await tx.product.create({ data: { id, ...values, status: 'draft', created_by: ctx.user.id } });
      await this.resolveCourses(tx, id, type, assignments);
      await this.replaceCourses(tx, id, assignments);
      await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: ctx.user.id, origin: 'user',
        action: 'product.created', target_type: 'product', target_ref: id, after_safe: { sku: values.sku, type, course_ids: assignments.map(item => item.course_id) } } });
      return { ...product, courses: assignments.length };
    });
  }
  async update(ctx: SessionContext, productId: string, input: unknown) {
    requireUuid(productId);
    const body = bodyObject(input, ['revision', 'title', 'variant_name', 'description', 'sort_order', 'courses']);
    const rev = productRevision(body.revision);
    return this.transaction(async tx => {
      const product = await this.lockProduct(tx, ctx, productId, 'products.manage');
      if (product.revision !== rev) throw stale();
      const changes: Prisma.ProductUpdateInput = {};
      if (body.title !== undefined) changes.title = productText(body.title, 'title', 160)!;
      if (body.variant_name !== undefined) changes.variant_name = productText(body.variant_name, 'variant_name', 160, true);
      if (body.description !== undefined) changes.description = productText(body.description, 'description', 4000, true, true);
      if (body.sort_order !== undefined) changes.sort_order = productInteger(body.sort_order, 'sort_order', 0, 100000)!;
      const assignments = body.courses === undefined ? undefined : courseAssignments(body.courses);
      if (assignments) await this.resolveCourses(tx, productId, product.type, assignments);
      // SKU and type are immutable while any price or course link exists; a
      // bundle must never silently become a single product or vice versa.
      const updated = await tx.product.update({ where: { id: productId }, data: { ...changes, revision: { increment: 1 } } });
      if (assignments) await this.replaceCourses(tx, productId, assignments);
      await this.audit(tx, ctx, 'product.updated', 'product', productId, productId, { changed: Object.keys(changes).sort(), ...(assignments ? { course_ids: assignments.map(item => item.course_id) } : {}) });
      return { ...updated, courses: assignments ? assignments.length : product.courses.length };
    });
  }
  async remove(ctx: SessionContext, productId: string, input: unknown) {
    requireUuid(productId);
    const body = bodyObject(input, ['revision']);
    const rev = productRevision(body.revision);
    return this.transaction(async tx => {
      const product = await this.lockProduct(tx, ctx, productId, 'products.manage');
      if (product.revision !== rev) throw stale();
      if (product.prices.length) throw apiError(409, 'PRODUCT_HAS_PRICES', 'Entferne zuerst alle Preiszeiträume dieses Produkts.');
      await tx.productCourse.deleteMany({ where: { product_id: productId } });
      await tx.product.delete({ where: { id: productId } });
      await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: ctx.user.id, origin: 'user', action: 'product.deleted',
        target_type: 'product', target_ref: productId, after_safe: { sku: product.sku, course_ids: product.courses.map(item => item.course_id) } } });
    });
  }

  async addPrice(ctx: SessionContext, productId: string, input: unknown) {
    requireUuid(productId);
    const body = bodyObject(input, ['currency', 'gross_cents', 'sale_gross_cents', 'sale_starts_at', 'sale_ends_at',
      'tax_category', 'valid_from', 'valid_until']);
    const values = priceValues(body);
    const id = uuidv7();
    return this.transaction(async tx => {
      await this.lockProduct(tx, ctx, productId, 'prices.manage');
      const price = await tx.price.create({ data: { id, ...values, product_id: productId, status: 'draft', created_by: ctx.user.id } });
      await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: ctx.user.id, origin: 'user', action: 'price.created',
        target_type: 'price', target_ref: id, after_safe: { product_id: productId, valid_from: values.valid_from.toISOString() } } });
      return priceOut(price);
    });
  }
  async updatePrice(ctx: SessionContext, priceId: string, input: unknown) {
    requireUuid(priceId);
    const body = bodyObject(input, ['revision', 'currency', 'gross_cents', 'sale_gross_cents', 'sale_starts_at', 'sale_ends_at',
      'tax_category', 'valid_from', 'valid_until']);
    const rev = productRevision(body.revision);
    return this.transaction(async tx => {
      const current = await tx.price.findUnique({ where: { id: priceId } });
      if (!current) throw missing();
      await this.lockProduct(tx, ctx, current.product_id, 'prices.manage');
      if (current.revision !== rev) throw stale();
      // Merge with the stored draft so a partial update cannot bypass a rule.
      const merged: Record<string, unknown> = { currency: current.currency, gross_cents: String(current.gross_cents),
        sale_gross_cents: current.sale_gross_cents === null ? null : String(current.sale_gross_cents),
        sale_starts_at: current.sale_starts_at ? utcMinuteString(current.sale_starts_at) : null,
        sale_ends_at: current.sale_ends_at ? utcMinuteString(current.sale_ends_at) : null,
        tax_category: current.tax_category, valid_from: utcMinuteString(current.valid_from),
        valid_until: current.valid_until ? utcMinuteString(current.valid_until) : null };
      for (const [key, value] of Object.entries(body)) if (key !== 'revision' && value !== undefined) merged[key] = value;
      const values = priceValues(merged);
      const price = await tx.price.update({ where: { id: priceId }, data: { ...values, revision: { increment: 1 } } });
      await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: ctx.user.id, origin: 'user', action: 'price.updated',
        target_type: 'price', target_ref: priceId, after_safe: { product_id: current.product_id, valid_from: values.valid_from.toISOString() } } });
      return priceOut(price);
    });
  }
  async removePrice(ctx: SessionContext, priceId: string, input: unknown) {
    requireUuid(priceId);
    const body = bodyObject(input, ['revision']);
    const rev = productRevision(body.revision);
    return this.transaction(async tx => {
      const current = await tx.price.findUnique({ where: { id: priceId } });
      if (!current) throw missing();
      await this.lockProduct(tx, ctx, current.product_id, 'prices.manage');
      if (current.revision !== rev) throw stale();
      await tx.price.delete({ where: { id: priceId } });
      await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: ctx.user.id, origin: 'user', action: 'price.deleted',
        target_type: 'price', target_ref: priceId, after_safe: { product_id: current.product_id, valid_from: current.valid_from.toISOString() } } });
    });
  }
}
