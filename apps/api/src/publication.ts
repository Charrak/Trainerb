import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { Sessions, type SessionContext } from './sessions';
import { apiError, bodyObject, requireUuid } from './security';
import { priceValues, productRevision, utcMinuteString } from './product-validation';

const missing = () => apiError(404, 'NOT_FOUND', 'Nicht gefunden.');
const stale = () => apiError(409, 'STALE_DRAFT', 'Der Entwurf wurde zwischenzeitlich geändert. Bitte lade ihn neu und prüfe deine Eingaben.');
const VERSION_NOT_DRAFT = () => apiError(409, 'VERSION_NOT_DRAFT', 'Veröffentlichte Versionen sind unveränderlich. Lege eine neue Entwurfsversion an.');

/** A publication check result: blocking reasons, never silently ignored. */
export type PublicationBlocker = { code: string; message: string };

@Injectable()
export class Publication {
  constructor(private readonly db: Database, private readonly sessions: Sessions) {}

  // Publication and activation are global catalogue decisions and therefore
  // require a global role that itself grants the permission, plus a fresh
  // second factor. Scoped course staff can never publish.
  private async actor(tx: Prisma.TransactionClient, ctx: SessionContext, permission: 'courses.publish' | 'products.manage') {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.user.id}::uuid FOR UPDATE`;
    const actor = await tx.user.findUnique({ where: { id: ctx.user.id },
      include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } } });
    const session = await this.sessions.assertCurrent(tx, ctx);
    const roles = actor?.roles.filter(item => item.role.permissions.some(link => link.permission.key === permission))
      .map(item => item.role.key) || [];
    if (!actor || actor.status !== 'active' || session.kind !== 'backoffice' || !session.mfa_verified_at ||
        !roles.some(role => role === 'admin' || role === 'superadmin')) throw apiError(403, 'FORBIDDEN', 'Kein Zugriff.');
    if (!session.reauthenticated_at || Date.now() - session.reauthenticated_at.getTime() > 5 * 60_000) {
      throw apiError(403, 'REAUTH_REQUIRED', 'Bitte bestätige deine Anmeldung erneut.');
    }
    return roles;
  }
  private async lockCourse(tx: Prisma.TransactionClient, ctx: SessionContext, courseId: string, permission: 'courses.publish' | 'products.manage') {
    await this.actor(tx, ctx, permission);
    await tx.$queryRaw`SELECT id FROM courses WHERE id = ${courseId}::uuid FOR UPDATE`;
    const course = await tx.course.findUnique({ where: { id: courseId } });
    if (!course) throw missing();
    return course;
  }
  /** Translate a database guard into a stable, safe API error. */
  private dbError(error: unknown): never {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('PRODUCT_INCOMPLETE')) throw apiError(409, 'PRODUCT_INCOMPLETE', 'Ein aktives Produkt braucht vollständige, veröffentlichte Kurszuordnungen (Einzelprodukt: genau ein Kurs, Paket: mindestens zwei verschiedene).');
    if (message.includes('COURSE_STILL_IN_ACTIVE_PRODUCT')) throw apiError(409, 'COURSE_STILL_IN_ACTIVE_PRODUCT', 'Der Kurs wird noch von einem aktiven Produkt verwendet. Deaktiviere das Produkt zuerst.');
    if (message.includes('PRICE_PRODUCT_INACTIVE')) throw apiError(409, 'PRICE_PRODUCT_INACTIVE', 'Bitte aktiviere zuerst das Produkt.');
    if (message.includes('prices_no_overlapping_active_ranges')) throw apiError(409, 'PRICE_OVERLAP', 'Aktive Preiszeiträume desselben Produkts und derselben Währung dürfen sich nicht überschneiden.');
    if (message.includes('LAST_PUBLISHED_VERSION')) throw apiError(409, 'LAST_PUBLISHED_VERSION', 'Die letzte veröffentlichte Version kann nicht zurückgezogen werden, solange der Kurs veröffentlicht ist.');
    throw error;
  }
  private async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try { return await this.db.$transaction(work, { timeout: 15_000 }); } catch (error) { this.dbError(error); }
  }
  private async audit(tx: Prisma.TransactionClient, ctx: SessionContext, action: string, targetType: string, target: string,
                      details?: Prisma.InputJsonValue) {
    await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: ctx.user.id, origin: 'user', action,
      target_type: targetType, target_ref: target, ...(details ? { after_safe: details } : {}) } });
  }

  /**
   * Deterministic readiness check for one draft version. Nothing here invents
   * content: missing modules, chapters or lesson blocks are reported, not filled
   * in, and releases never bypass exam or media work that does not exist yet.
   */
  async readiness(tx: Prisma.TransactionClient, courseId: string, versionId: string): Promise<PublicationBlocker[]> {
    const version = await tx.courseVersion.findFirst({ where: { id: versionId, course_id: courseId },
      include: { modules: { orderBy: { position: 'asc' }, include: { chapters: { orderBy: { position: 'asc' },
        include: { _count: { select: { contents: true } } } } } } } });
    if (!version) throw missing();
    const blockers: PublicationBlocker[] = [];
    const modules = version.modules.length;
    const chapters = version.modules.reduce((sum, module) => sum + module.chapters.length, 0);
    if (!modules) blockers.push({ code: 'NO_MODULES', message: 'Der Entwurf enthält keine Module.' });
    if (!chapters) blockers.push({ code: 'NO_CHAPTERS', message: 'Der Entwurf enthält keine Kapitel.' });
    if (version.modules.some(module => !module.chapters.length)) {
      blockers.push({ code: 'EMPTY_MODULE', message: 'Mindestens ein Modul enthält keine Kapitel.' });
    }
    // Chapters without any lesson block would publish an empty lesson.
    if (version.modules.some(module => module.chapters.some(chapter => chapter._count.contents === 0))) {
      blockers.push({ code: 'EMPTY_CHAPTER', message: 'Mindestens ein Kapitel enthält keine Inhaltsbausteine.' });
    }
    // Planned numbers are a promise to the participant; a mismatch blocks release.
    if (version.expected_module_count !== null && version.expected_module_count !== modules) {
      blockers.push({ code: 'MODULE_COUNT_MISMATCH', message: `Geplant sind ${version.expected_module_count} Module, angelegt sind ${modules}.` });
    }
    if (version.expected_chapter_count !== null && version.expected_chapter_count !== chapters) {
      blockers.push({ code: 'CHAPTER_COUNT_MISMATCH', message: `Geplant sind ${version.expected_chapter_count} Kapitel, angelegt sind ${chapters}.` });
    }
    if (version.expected_exams_per_chapter !== null) {
      // Exams are not implemented; a version that requires them must not be
      // published as if it were examinable.
      blockers.push({ code: 'EXAMS_NOT_IMPLEMENTED', message: 'Für diese Version sind Prüfungen geplant, das Prüfungssystem ist aber noch nicht implementiert.' });
    }
    if (!version.subtitle) blockers.push({ code: 'MISSING_SUBTITLE', message: 'Bitte ergänze einen Untertitel.' });
    if (version.duration_minutes === null && version.modules.every(module => module.chapters.every(chapter => chapter.estimated_minutes === null))) {
      blockers.push({ code: 'MISSING_DURATION', message: 'Bitte gib eine Gesamtdauer oder Kapiteldauern an.' });
    }
    return blockers;
  }

  async courseState(ctx: SessionContext, courseId: string) {
    requireUuid(courseId);
    return this.transaction(async tx => {
      await this.actor(tx, ctx, 'courses.publish');
      const course = await tx.course.findUnique({ where: { id: courseId }, include: {
        versions: { orderBy: { version: 'desc' }, select: { id: true, version: true, state: true, title: true, revision: true,
          published_at: true, expected_module_count: true, expected_chapter_count: true } },
        publications: { orderBy: [{ created_at: 'desc' }, { id: 'desc' }], take: 20 } } });
      if (!course) throw missing();
      const draft = course.versions.find(version => version.state === 'draft');
      return { course_id: course.id, status: course.status, visibility: course.visibility,
        versions: course.versions, publications: course.publications,
        readiness: draft ? await this.readiness(tx, course.id, draft.id) : [] };
    });
  }

  async publishCourse(ctx: SessionContext, courseId: string, input: unknown) {
    requireUuid(courseId);
    const body = bodyObject(input, ['version_id', 'revision', 'visibility']);
    if (typeof body.version_id !== 'string') throw apiError(422, 'INVALID_PUBLICATION', 'Bitte gib die zu veröffentlichende Version an.');
    const versionId = requireUuid(body.version_id), expectedRevision = productRevision(body.revision);
    if (body.visibility !== undefined && !['public', 'unlisted'].includes(String(body.visibility))) {
      throw apiError(422, 'INVALID_PUBLICATION', 'Veröffentlichte Kurse sind öffentlich oder nicht gelistet.');
    }
    return this.transaction(async tx => {
      const course = await this.lockCourse(tx, ctx, courseId, 'courses.publish');
      const version = await tx.courseVersion.findFirst({ where: { id: versionId, course_id: courseId } });
      if (!version) throw missing();
      if (version.state !== 'draft') throw VERSION_NOT_DRAFT();
      if (version.revision !== expectedRevision) throw stale();
      const blockers = await this.readiness(tx, courseId, versionId);
      if (blockers.length) {
        throw apiError(409, 'PUBLICATION_BLOCKED', 'Der Entwurf ist noch nicht veröffentlichungsfähig.',
          Object.fromEntries(blockers.map(blocker => [blocker.code, blocker.message])));
      }
      const visibility = body.visibility === undefined ? (course.visibility === 'private' ? 'public' : course.visibility) : String(body.visibility);
      const now = new Date();
      // Retire the previous published version only after its successor is fixed,
      // so a reader never sees a course without a published version.
      await tx.courseVersion.updateMany({ where: { course_id: courseId, state: 'published' },
        data: { state: 'retired', published_by: null, published_at: null } });
      const published = await tx.courseVersion.update({ where: { id: versionId }, data: { state: 'published', published_by: ctx.user.id, published_at: now } });
      await tx.course.update({ where: { id: courseId }, data: { status: 'published', visibility } });
      await tx.coursePublication.create({ data: { id: uuidv7(), course_id: courseId, course_version_id: versionId,
        version: version.version, action: 'published', actor_user_id: ctx.user.id } });
      await this.audit(tx, ctx, 'course.published', 'course', courseId, { version_id: versionId, version: version.version, visibility });
      return { course_id: courseId, status: 'published', visibility, version: published.version };
    });
  }

  async unpublishCourse(ctx: SessionContext, courseId: string, input: unknown) {
    requireUuid(courseId);
    const body = bodyObject(input, ['revision']);
    void productRevision(body.revision); // body shape is checked before any lock
    return this.transaction(async tx => {
      const course = await this.lockCourse(tx, ctx, courseId, 'courses.publish');
      if (course.status !== 'published') throw apiError(409, 'NOT_PUBLISHED', 'Der Kurs ist nicht veröffentlicht.');
      const version = await tx.courseVersion.findFirst({ where: { course_id: courseId, state: 'published' } });
      // Order matters: the guard triggers reject a published course without a
      // published version and a published version without publisher metadata,
      // so the course leaves publication first, then the version is retired.
      await tx.course.update({ where: { id: courseId }, data: { status: 'draft', visibility: 'private' } });
      await tx.courseVersion.updateMany({ where: { course_id: courseId, state: 'published' },
        data: { state: 'retired', published_by: null, published_at: null } });
      if (version) await tx.coursePublication.create({ data: { id: uuidv7(), course_id: courseId, course_version_id: version.id,
        version: version.version, action: 'unpublished', actor_user_id: ctx.user.id } });
      await this.audit(tx, ctx, 'course.unpublished', 'course', courseId, { version_id: version?.id ?? null, version: version?.version ?? null });
      return { course_id: courseId, status: 'draft' };
    });
  }

  /** Create the next draft version from the currently published one. */
  async newDraftVersion(ctx: SessionContext, courseId: string, input: unknown) {
    requireUuid(courseId);
    bodyObject(input, []);
    return this.transaction(async tx => {
      await this.lockCourse(tx, ctx, courseId, 'courses.publish');
      const published = await tx.courseVersion.findFirst({ where: { course_id: courseId, state: 'published' },
        include: { modules: { orderBy: { position: 'asc' }, include: { chapters: { orderBy: { position: 'asc' },
          include: { contents: { orderBy: { position: 'asc' } } } } } } } });
      if (!published) throw apiError(409, 'NO_PUBLISHED_VERSION', 'Es gibt keine veröffentlichte Version, aus der ein Entwurf entstehen könnte.');
      if (await tx.courseVersion.findFirst({ where: { course_id: courseId, state: 'draft' } })) {
        throw apiError(409, 'DRAFT_EXISTS', 'Es existiert bereits ein Entwurf. Bearbeite diesen weiter.');
      }
      const latest = await tx.courseVersion.findFirst({ where: { course_id: courseId }, orderBy: { version: 'desc' }, select: { version: true } });
      const versionId = uuidv7(), nextVersion = (latest?.version ?? 0) + 1;
      await tx.courseVersion.create({ data: { id: versionId, course_id: courseId, version: nextVersion, state: 'draft',
        title: published.title, subtitle: published.subtitle, description: published.description as Prisma.InputJsonValue,
        duration_minutes: published.duration_minutes, default_access_days: published.default_access_days,
        chapter_completion_mode: published.chapter_completion_mode, expected_module_count: published.expected_module_count,
        expected_chapter_count: published.expected_chapter_count, expected_exams_per_chapter: published.expected_exams_per_chapter,
        created_by: ctx.user.id } });
      // Copy the lesson structure so the new draft is editable without touching
      // the immutable published version. Copies keep their own new IDs.
      for (const module of published.modules) {
        const moduleId = uuidv7();
        await tx.courseModule.create({ data: { id: moduleId, course_version_id: versionId, title: module.title,
          description: module.description, position: module.position } });
        for (const chapter of module.chapters) {
          const chapterId = uuidv7();
          await tx.courseChapter.create({ data: { id: chapterId, course_version_id: versionId, module_id: moduleId,
            title: chapter.title, summary: chapter.summary, estimated_minutes: chapter.estimated_minutes, position: chapter.position } });
          for (const content of chapter.contents) {
            const contentId = uuidv7();
            const body = content.body as Prisma.JsonObject;
            const blocks = Array.isArray(body.blocks) ? body.blocks : [];
            // The block id inside the document must stay identical to the row id.
            const rewritten = blocks.map(block => block && typeof block === 'object' && !Array.isArray(block) && 'id' in block
              ? { ...(block as Prisma.JsonObject), id: contentId } : block);
            await tx.chapterContent.create({ data: { id: contentId, course_version_id: versionId, chapter_id: chapterId,
              kind: content.kind, title: content.title, position: content.position,
              body: { ...body, blocks: rewritten } as Prisma.InputJsonValue } });
          }
        }
      }
      await this.audit(tx, ctx, 'course.draft_version_created', 'course', courseId,
        { version_id: versionId, version: nextVersion, from_version_id: published.id });
      return { course_id: courseId, version_id: versionId, version: nextVersion };
    });
  }

  // --- Product activation -------------------------------------------------

  private async productReadiness(tx: Prisma.TransactionClient, productId: string) {
    const product = await tx.product.findUnique({ where: { id: productId }, include: {
      courses: { include: { course: { select: { id: true, status: true } } } }, prices: true } });
    if (!product) throw missing();
    const blockers: PublicationBlocker[] = [];
    const links = product.courses.length;
    if (product.type === 'single' && links !== 1) blockers.push({ code: 'SINGLE_COURSE_COUNT', message: 'Ein Einzelprodukt braucht genau einen Kurs.' });
    if (product.type === 'bundle' && links < 2) blockers.push({ code: 'BUNDLE_COURSE_COUNT', message: 'Ein Paket braucht mindestens zwei verschiedene Kurse.' });
    if (product.courses.some(link => link.course.status !== 'published')) {
      blockers.push({ code: 'COURSE_NOT_PUBLISHED', message: 'Alle zugeordneten Kurse müssen veröffentlicht sein.' });
    }
    if (!product.prices.length) blockers.push({ code: 'NO_PRICE', message: 'Es ist kein Preiszeitraum hinterlegt.' });
    const now = new Date();
    if (product.prices.length && !product.prices.some(price => price.valid_from <= now && (price.valid_until === null || price.valid_until > now))) {
      blockers.push({ code: 'NO_CURRENT_PRICE', message: 'Kein Preiszeitraum gilt derzeit; bitte einen gültigen Zeitraum vorbereiten.' });
    }
    if (!product.description) blockers.push({ code: 'MISSING_DESCRIPTION', message: 'Bitte ergänze eine Produktbeschreibung.' });
    return { product, blockers };
  }

  async productState(ctx: SessionContext, productId: string) {
    requireUuid(productId);
    return this.transaction(async tx => {
      await this.actor(tx, ctx, 'products.manage');
      const { product, blockers } = await this.productReadiness(tx, productId);
      return { product_id: product.id, status: product.status, activated_at: product.activated_at,
        blockers, prices: product.prices.map(price => ({ id: price.id, status: price.status, gross_cents: String(price.gross_cents),
          currency: price.currency, valid_from: price.valid_from, valid_until: price.valid_until })) };
    });
  }

  async activateProduct(ctx: SessionContext, productId: string, input: unknown) {
    requireUuid(productId);
    const body = bodyObject(input, ['revision']);
    const expectedRevision = productRevision(body.revision);
    return this.transaction(async tx => {
      await this.actor(tx, ctx, 'products.manage');
      await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId}::uuid FOR UPDATE`;
      const { product, blockers } = await this.productReadiness(tx, productId);
      if (product.revision !== expectedRevision) throw stale();
      if (product.status === 'active') throw apiError(409, 'ALREADY_ACTIVE', 'Das Produkt ist bereits aktiv.');
      if (blockers.length) throw apiError(409, 'ACTIVATION_BLOCKED', 'Das Produkt ist noch nicht aktivierbar.',
        Object.fromEntries(blockers.map(blocker => [blocker.code, blocker.message])));
      const updated = await tx.product.update({ where: { id: productId }, data: { status: 'active',
        activated_at: new Date(), activated_by: ctx.user.id, revision: { increment: 1 } } });
      await this.audit(tx, ctx, 'product.activated', 'product', productId,
        { course_ids: product.courses.map(link => link.course_id), price_ids: product.prices.map(price => price.id) });
      return { product_id: productId, status: updated.status };
    });
  }

  async deactivateProduct(ctx: SessionContext, productId: string, input: unknown) {
    requireUuid(productId);
    const body = bodyObject(input, ['revision']);
    const expectedRevision = productRevision(body.revision);
    return this.transaction(async tx => {
      await this.actor(tx, ctx, 'products.manage');
      await tx.$queryRaw`SELECT id FROM products WHERE id = ${productId}::uuid FOR UPDATE`;
      const product = await tx.product.findUnique({ where: { id: productId } });
      if (!product) throw missing();
      if (product.revision !== expectedRevision) throw stale();
      if (product.status !== 'active') throw apiError(409, 'NOT_ACTIVE', 'Das Produkt ist nicht aktiv.');
      // Active prices are retired with the product; historical rows stay.
      await tx.price.updateMany({ where: { product_id: productId, status: 'active' }, data: { status: 'retired' } });
      const updated = await tx.product.update({ where: { id: productId }, data: { status: 'inactive',
        activated_at: null, activated_by: null, revision: { increment: 1 } } });
      await this.audit(tx, ctx, 'product.deactivated', 'product', productId, {});
      return { product_id: productId, status: updated.status };
    });
  }

  async activatePrice(ctx: SessionContext, priceId: string, input: unknown) {
    requireUuid(priceId);
    const body = bodyObject(input, ['revision']);
    const expectedRevision = productRevision(body.revision);
    return this.transaction(async tx => {
      await this.actor(tx, ctx, 'products.manage');
      const current = await tx.price.findUnique({ where: { id: priceId } });
      if (!current) throw missing();
      await tx.$queryRaw`SELECT id FROM products WHERE id = ${current.product_id}::uuid FOR UPDATE`;
      const product = await tx.product.findUnique({ where: { id: current.product_id } });
      if (!product) throw missing();
      if (current.revision !== expectedRevision) throw stale();
      if (current.status !== 'draft') throw apiError(409, 'PRICE_NOT_DRAFT', 'Nur Preisentwürfe lassen sich aktivieren.');
      // Re-validate the stored row before it becomes chargeable: an active price
      // must be a positive, internally consistent amount.
      priceValues({ currency: current.currency, gross_cents: String(current.gross_cents),
        sale_gross_cents: current.sale_gross_cents === null ? null : String(current.sale_gross_cents),
        sale_starts_at: current.sale_starts_at ? utcMinuteString(current.sale_starts_at) : null,
        sale_ends_at: current.sale_ends_at ? utcMinuteString(current.sale_ends_at) : null,
        tax_category: current.tax_category, valid_from: utcMinuteString(current.valid_from),
        valid_until: current.valid_until ? utcMinuteString(current.valid_until) : null });
      const updated = await tx.price.update({ where: { id: priceId }, data: { status: 'active', revision: { increment: 1 } } });
      await this.audit(tx, ctx, 'price.activated', 'price', priceId, { product_id: current.product_id,
        valid_from: current.valid_from.toISOString() });
      return { price_id: priceId, status: updated.status };
    });
  }

  async retirePrice(ctx: SessionContext, priceId: string, input: unknown) {
    requireUuid(priceId);
    const body = bodyObject(input, ['revision']);
    const expectedRevision = productRevision(body.revision);
    return this.transaction(async tx => {
      await this.actor(tx, ctx, 'products.manage');
      const current = await tx.price.findUnique({ where: { id: priceId } });
      if (!current) throw missing();
      await tx.$queryRaw`SELECT id FROM products WHERE id = ${current.product_id}::uuid FOR UPDATE`;
      if (current.revision !== expectedRevision) throw stale();
      if (current.status !== 'active') throw apiError(409, 'PRICE_NOT_ACTIVE', 'Der Preiszeitraum ist nicht aktiv.');
      const updated = await tx.price.update({ where: { id: priceId }, data: { status: 'retired', revision: { increment: 1 } } });
      await this.audit(tx, ctx, 'price.retired', 'price', priceId, { product_id: current.product_id });
      return { price_id: priceId, status: updated.status };
    });
  }
}
