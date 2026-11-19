import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { deliverable, deliveryFields, signLessonGet } from './lesson-media';
import { getConfig } from './config';
import { Database } from './database';
import { Sessions, type SessionContext } from './sessions';
import { apiError, requireUuid } from './security';

const missing = () => apiError(404, 'NOT_FOUND', 'Nicht gefunden.');

/**
 * The learning area. Everything here is derived from an active `course_access`
 * row that itself can only come from a paid order (or an audited manual grant).
 * Chapter content of a course version is readable only through such a row — the
 * public catalogue never exposes lesson bodies.
 */
@Injectable()
export class Learning {
  constructor(private readonly db: Database, private readonly sessions: Sessions) {}

  private async activeAccess(userId: string, courseSlug: string) {
    if (typeof courseSlug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(courseSlug) || courseSlug.length > 100) throw missing();
    const access = await this.db.courseAccess.findFirst({ where: { user_id: userId, revoked_at: null,
      course: { slug: courseSlug } }, include: { course: true, version: true } });
    if (!access) throw missing();
    // A suspended grant (open refund or dispute) stops access without deleting
    // the grant: the same row resumes if the question is settled in the buyer's
    // favour. A plain 404 would look like "never bought it".
    if (access.suspended_at) {
      throw apiError(403, 'ACCESS_SUSPENDED', 'Der Zugang zu dieser Ausbildung ist vorübergehend gesperrt.');
    }
    const now = new Date();
    if (access.starts_at > now || (access.ends_at && access.ends_at <= now)) {
      throw apiError(403, 'ACCESS_EXPIRED', 'Der Zugang zu dieser Ausbildung ist abgelaufen.');
    }
    return access;
  }

  /** In-range grants stay visible while suspended; content still requires activeAccess. */
  async myCourses(ctx: SessionContext) {
    const now = new Date();
    const accesses = await this.db.courseAccess.findMany({ where: { user_id: ctx.user.id, revoked_at: null,
      starts_at: { lte: now }, OR: [{ ends_at: null }, { ends_at: { gt: now } }] },
      orderBy: { created_at: 'desc' }, include: { course: true, version: true,
        progress: { select: { chapter_id: true } } } });
    const data = [];
    for (const access of accesses) {
      const chapters = await this.db.courseChapter.count({ where: { course_version_id: access.course_version_id } });
      data.push({ course_id: access.course_id, slug: access.course.slug, title: access.version.title,
        subtitle: access.version.subtitle, duration_minutes: access.version.duration_minutes,
        starts_at: access.starts_at, ends_at: access.ends_at, chapter_count: chapters,
        completed_count: access.progress.length, suspended: access.suspended_at !== null });
    }
    return { data };
  }

  /** Course outline for the learning area, including which chapters are done. */
  async course(ctx: SessionContext, slug: string) {
    const access = await this.activeAccess(ctx.user.id, slug);
    const version = await this.db.courseVersion.findUniqueOrThrow({ where: { id: access.course_version_id },
      include: { modules: { orderBy: { position: 'asc' }, include: { chapters: { orderBy: { position: 'asc' },
        include: { _count: { select: { contents: true } } } } } } } });
    const progress = await this.db.chapterProgress.findMany({ where: { access_id: access.id },
      select: { chapter_id: true, completed_at: true } });
    const done = new Map(progress.map(row => [row.chapter_id, row.completed_at]));
    return { course_id: access.course_id, slug, title: version.title, subtitle: version.subtitle,
      description: version.description, duration_minutes: version.duration_minutes,
      starts_at: access.starts_at, ends_at: access.ends_at,
      modules: version.modules.map(module => ({ id: module.id, title: module.title, description: module.description,
        chapters: module.chapters.map(chapter => ({ id: chapter.id, title: chapter.title, summary: chapter.summary,
          estimated_minutes: chapter.estimated_minutes, content_count: chapter._count.contents,
          completed_at: done.get(chapter.id) ?? null })) })) };
  }

  /** One chapter with its typed lesson blocks. Access is re-checked per request. */
  async chapter(ctx: SessionContext, slug: string, chapterIdInput: string) {
    const chapterId = requireUuid(chapterIdInput);
    const access = await this.activeAccess(ctx.user.id, slug);
    const chapter = await this.db.courseChapter.findFirst({ where: { id: chapterId,
      course_version_id: access.course_version_id }, include: { contents: { orderBy: { position: 'asc' },
        include: { media_asset: { select: deliveryFields } } },
      exams: { orderBy: { position: 'asc' }, select: { id: true, title: true } }, module: { select: { title: true } } } });
    if (!chapter) throw missing();
    const progress = await this.db.chapterProgress.findFirst({ where: { access_id: access.id, chapter_id: chapterId } });
    return { access_id: access.id, exams: chapter.exams, can_self_complete: access.version.chapter_completion_mode !== 'all_chapter_exams', id: chapter.id, title: chapter.title, summary: chapter.summary, module_title: chapter.module.title,
      estimated_minutes: chapter.estimated_minutes, completed_at: progress?.completed_at ?? null,
      contents: chapter.contents.map(content => ({ id: content.id, kind: content.kind, title: content.title,
        body: content.body, ...(content.media_asset_id ? { media_available: !!getConfig().mediaStore && deliverable(content.kind, content.media_asset) } : {}) })) };
  }

  async mediaLink(ctx: SessionContext, slug: string, chapterId: string, contentId: string) {
    const access = await this.activeAccess(ctx.user.id, slug);
    const row = await this.db.chapterContent.findFirst({ where: { id: requireUuid(contentId), chapter_id: requireUuid(chapterId),
      course_version_id: access.course_version_id }, select: { kind: true, media_asset: { select: deliveryFields } } });
    if (!row || !deliverable(row.kind, row.media_asset)) throw missing();
    const store = getConfig().mediaStore;
    if (!store) throw apiError(503, 'MEDIA_STORAGE_UNAVAILABLE', 'Der Medienspeicher ist nicht verfügbar.');
    const ttl = access.ends_at ? Math.min(60, Math.floor((access.ends_at.getTime() - Date.now()) / 1000)) : 60;
    if (ttl < 1) throw apiError(403, 'ACCESS_EXPIRED', 'Der Zugang zu dieser Ausbildung ist abgelaufen.');
    return signLessonGet(store, row.media_asset.storage_key, row.kind, row.media_asset.mime_detected, ttl);
  }

  /** Completing a chapter is idempotent per access row. */
  async complete(ctx: SessionContext, slug: string, chapterIdInput: string) {
    const chapterId = requireUuid(chapterIdInput);
    const access = await this.activeAccess(ctx.user.id, slug);
    const chapter = await this.db.courseChapter.findFirst({ where: { id: chapterId,
      course_version_id: access.course_version_id }, select: { id: true } });
    if (!chapter) throw missing();
    if (access.version.chapter_completion_mode === 'all_chapter_exams') throw apiError(409, 'EXAMS_REQUIRED', 'Dieses Kapitel wird durch bestandene Prüfungen abgeschlossen.');
    await this.db.chapterProgress.upsert({ where: { access_id_chapter_id: { access_id: access.id, chapter_id: chapterId } },
      create: { id: uuidv7(), access_id: access.id, course_version_id: access.course_version_id,
        chapter_id: chapterId }, update: {} });
    return this.chapter(ctx, slug, chapterId);
  }
}

/** Staff-facing access administration: manual grants and revocations. */
@Injectable()
export class Accesses {
  constructor(private readonly db: Database, private readonly sessions: Sessions) {}

  private async staffActor(tx: Prisma.TransactionClient, ctx: SessionContext) {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.user.id}::uuid FOR UPDATE`;
    await this.sessions.assertCurrent(tx, ctx);
    if (ctx.session.kind !== 'backoffice' || !ctx.permissionKeys.has('access.manage')) {
      throw apiError(403, 'FORBIDDEN', 'Kein Zugriff.');
    }
  }

  /**
   * A manual grant is an explicit, audited decision (for example a goodwill
   * extension). It creates no order and no invoice, so it can never be mistaken
   * for a purchase.
   */
  async grant(ctx: SessionContext, input: unknown) {
    const body = (input ?? {}) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw apiError(400, 'INVALID_REQUEST', 'Ungültige Anfrage.');
    const userId = requireUuid(typeof body.user_id === 'string' ? body.user_id.toLowerCase() : '');
    const courseId = requireUuid(typeof body.course_id === 'string' ? body.course_id.toLowerCase() : '');
    const days = body.access_days === undefined || body.access_days === null ? null : Number(body.access_days);
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 36500)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { access_days: 'Ungültige Dauer.' });
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!/^[a-z_]{3,60}$/.test(reason)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { reason: 'Bitte einen Grund angeben.' });
    }
    return this.db.$transaction(async tx => {
      await this.staffActor(tx, ctx);
      const course = await tx.course.findUnique({ where: { id: courseId }, include: {
        versions: { where: { state: 'published' }, take: 1 } } });
      if (!course || course.status !== 'published' || !course.versions[0]) throw missing();
      const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, status: true } });
      if (!user || user.status !== 'active') throw missing();
      const existing = await tx.courseAccess.findFirst({ where: { user_id: userId, course_id: courseId, revoked_at: null } });
      if (existing) throw apiError(409, 'ACCESS_EXISTS', 'Für diesen Kurs besteht bereits ein Zugang.');
      const now = new Date();
      const access = await tx.courseAccess.create({ data: { id: uuidv7(), user_id: userId, course_id: courseId,
        course_version_id: course.versions[0].id, source: 'manual', granted_by: ctx.user.id, starts_at: now,
        ends_at: days ? new Date(now.getTime() + days * 24 * 60 * 60_000) : null } });
      await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: ctx.user.id, origin: 'user',
        action: 'access.granted_manually', target_type: 'course_access', target_ref: access.id,
        after_safe: { user_id: userId, course_id: courseId, access_days: days, reason } } });
      return { id: access.id, user_id: userId, course_id: courseId, ends_at: access.ends_at };
    });
  }

  async revoke(ctx: SessionContext, accessIdInput: string, input: unknown) {
    const accessId = requireUuid(accessIdInput);
    const body = (input ?? {}) as Record<string, unknown>;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!/^[a-z_]{3,60}$/.test(reason)) {
      throw apiError(422, 'INVALID_FIELD', 'Bitte prüfe deine Eingaben.', { reason: 'Bitte einen Grund angeben.' });
    }
    return this.db.$transaction(async tx => {
      await this.staffActor(tx, ctx);
      await tx.$queryRaw`SELECT id FROM course_access WHERE id = ${accessId}::uuid FOR UPDATE`;
      const access = await tx.courseAccess.findUnique({ where: { id: accessId } });
      if (!access) throw missing();
      if (access.revoked_at) return { id: access.id, revoked_at: access.revoked_at };
      const now = new Date();
      // Purchased access may only be revoked when the decision is on record; a
      // manual grant carries its own history and needs no order decision.
      if (access.source === 'order' && access.order_id) {
        await tx.orderAccessDecision.create({ data: { id: uuidv7(), order_id: access.order_id,
          access_id: access.id, decision: 'revoked', reason, decided_by: ctx.user.id } });
      }
      await tx.courseAccess.update({ where: { id: accessId }, data: { revoked_at: now, revoke_reason: reason,
        suspended_at: null, suspend_reason: null } });
      await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: ctx.user.id, origin: 'user',
        action: 'access.revoked', target_type: 'course_access', target_ref: accessId,
        after_safe: { source: access.source, reason } } });
      return { id: accessId, revoked_at: now };
    });
  }
}
