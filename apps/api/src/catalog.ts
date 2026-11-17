import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { Sessions, type SessionContext } from './sessions';
import { apiError, bodyObject, requireUuid } from './security';
import { contentDocument, supportedContentDocument } from './chapter-content';

const missing = () => apiError(404, 'NOT_FOUND', 'Nicht gefunden.');
const conflict = () => apiError(409, 'CATALOG_CONFLICT', 'Diese Kennung oder Position wird bereits verwendet.');
const stale = () => apiError(409, 'STALE_DRAFT', 'Der Entwurf wurde zwischenzeitlich geändert. Bitte lade ihn neu und prüfe deine Eingaben.');
function uniqueFailure(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'P2002';
}
function fail(field: string): never {
  throw apiError(422, 'INVALID_CATALOG_FIELD', 'Bitte prüfe die Angaben.', { [field]: 'Ungültiger Wert.' });
}
function text(value: unknown, field: string, max: number, optional = false, multiline = false): string | null {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string') return fail(field);
  const normalized = value.normalize('NFC').trim();
  if (!normalized && optional) return null;
  const controls = Array.from(normalized).some(character => /\p{Cc}/u.test(character) && !(multiline && ['\n', '\r', '\t'].includes(character)));
  if (!normalized || !normalized.replace(/[\p{White_Space}\u200b-\u200d\u2060\ufeff]/gu, '') ||
      Array.from(normalized).length > max || /[\p{Cs}]/u.test(normalized) || controls ||
      (!multiline && /[\u2028\u2029]/u.test(normalized))) return fail(field);
  return normalized;
}
function slug(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return fail('slug');
  return value;
}
function integer(value: unknown, field: string, options: { nullable?: boolean; min?: number; max?: number } = {}): number | null {
  if (options.nullable && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (options.min ?? 0) || value > (options.max ?? 1_000_000)) return fail(field);
  return value;
}
function revision(value: unknown): number {
  return integer(value, 'revision', { min: 1, max: 2_147_483_646 })!;
}
function description(value: unknown): Prisma.InputJsonValue {
  const content = text(value, 'description', 8000, true, true);
  return { schema_version: 1, blocks: content ? [{ id: uuidv7(), kind: 'paragraph', text: content }] : [] };
}
function completionMode(value: unknown): string {
  if (value === undefined) return 'self_confirm';
  if (typeof value !== 'string' || !['self_confirm', 'all_chapter_exams', 'self_or_all_chapter_exams'].includes(value)) return fail('chapter_completion_mode');
  return value;
}
function visibility(value: unknown): string {
  if (value === undefined) return 'private';
  if (typeof value !== 'string' || !['public', 'unlisted', 'private'].includes(value)) return fail('visibility');
  return value;
}
function publicText(value: Prisma.JsonValue): string {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema_version !== 1 || !Array.isArray(value.blocks)) return '';
  // Only the currently supported text blocks are exposed; arbitrary stored
  // HTML, links, media and unknown schemas are never interpreted.
  return value.blocks.filter((block): block is Prisma.JsonObject => !!block && typeof block === 'object' && !Array.isArray(block))
    .filter(block => block.kind === 'paragraph' && typeof block.text === 'string')
    .map(block => String(block.text)).join('\n\n');
}
function scopeRoles(roleKeys: readonly string[]): string[] {
  return [...(roleKeys.includes('course_manager') ? ['manager'] : []), ...(roleKeys.includes('instructor') ? ['instructor'] : [])];
}
function globalRole(roleKeys: readonly string[]): boolean { return roleKeys.includes('admin') || roleKeys.includes('superadmin'); }
function scopeWhere(userId: string, roleKeys: readonly string[]): Prisma.CourseWhereInput {
  return globalRole(roleKeys) ? {} : { staff: { some: { user_id: userId, scope_role: { in: scopeRoles(roleKeys) } } } };
}

@Injectable()
export class Catalog {
  constructor(private readonly db: Database, private readonly sessions: Sessions) {}

  // Permissions, current session and course assignment are checked again
  // inside every mutation, under locks shared with role/session changes.
  private async currentActor(tx: Prisma.TransactionClient, ctx: SessionContext, permission: string, globalOnly = false, fresh = false): Promise<string[]> {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.user.id}::uuid FOR UPDATE`;
    const actor = await tx.user.findUnique({ where: { id: ctx.user.id }, include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } } });
    const session = await this.sessions.assertCurrent(tx, ctx);
    // Scope must come from a role that itself grants this permission. An
    // unrelated global role must not turn a scoped permission into global access.
    const roles = actor?.roles.filter(item => item.role.permissions.some(link => link.permission.key === permission))
      .map(item => item.role.key) || [];
    if (!actor || actor.status !== 'active' || session.kind !== 'backoffice' || !session.mfa_verified_at ||
        !roles.length || (globalOnly && !globalRole(roles))) {
      throw apiError(403, 'FORBIDDEN', 'Kein Zugriff.');
    }
    if (fresh && (!session.reauthenticated_at || Date.now() - session.reauthenticated_at.getTime() > 5 * 60_000)) {
      throw apiError(403, 'REAUTH_REQUIRED', 'Bitte bestätige deine Anmeldung erneut.');
    }
    return roles;
  }
  private async lockCourse(tx: Prisma.TransactionClient, ctx: SessionContext, courseId: string, permission: string,
                           globalOnly = false, fresh = false, targetUserId?: string) {
    const roles = await this.currentActor(tx, ctx, permission, globalOnly, fresh);
    // Assignment and role changes share an advisory lock. Lock the target
    // before the course so its concurrent draft edits cannot deadlock with us.
    if (targetUserId && targetUserId !== ctx.user.id) await tx.$queryRaw`SELECT id FROM users WHERE id = ${targetUserId}::uuid FOR UPDATE`;
    return this.lockAuthorizedCourse(tx, ctx.user.id, courseId, roles);
  }
  private async lockAuthorizedCourse(tx: Prisma.TransactionClient, userId: string, courseId: string, roles: string[]) {
    await tx.$queryRaw`SELECT id FROM courses WHERE id = ${courseId}::uuid FOR UPDATE`;
    const course = await tx.course.findFirst({ where: { id: courseId, ...scopeWhere(userId, roles) } });
    if (!course) throw missing();
    return course;
  }
  private async lockChapter(tx: Prisma.TransactionClient, ctx: SessionContext, chapterId: string, permission: string) {
    const roles = await this.currentActor(tx, ctx, permission);
    const item = await tx.courseChapter.findUnique({ where: { id: chapterId }, include: { course_version: { select: { course_id: true } } } });
    if (!item) throw missing();
    const courseId = item.course_version.course_id;
    await this.lockAuthorizedCourse(tx, ctx.user.id, courseId, roles);
    const chapter = await this.lockDraftChapter(tx, chapterId, courseId);
    return { courseId, chapter };
  }
  private async lockContent(tx: Prisma.TransactionClient, ctx: SessionContext, contentId: string) {
    const roles = await this.currentActor(tx, ctx, 'courses.edit');
    const item = await tx.chapterContent.findUnique({ where: { id: contentId }, include: { course_version: { select: { course_id: true } } } });
    if (!item) throw missing();
    const courseId = item.course_version.course_id;
    await this.lockAuthorizedCourse(tx, ctx.user.id, courseId, roles);
    const content = await tx.chapterContent.findFirst({ where: { id: contentId, course_version: { course_id: courseId } } });
    if (!content) throw missing();
    await this.assertDraftVersion(tx, content.course_version_id);
    return { courseId, content };
  }
  /** Published versions are immutable; only drafts may be edited. */
  private async assertDraftVersion(tx: Prisma.TransactionClient, versionId: string) {
    const version = await tx.courseVersion.findUnique({ where: { id: versionId }, select: { state: true } });
    if (!version) throw missing();
    if (version.state !== 'draft') throw apiError(409, 'VERSION_NOT_DRAFT', 'Veröffentlichte Versionen sind unveränderlich. Lege eine neue Entwurfsversion an.');
  }
  private async lockDraftChapter(tx: Prisma.TransactionClient, chapterId: string, courseId: string) {
    const chapter = await tx.courseChapter.findFirst({ where: { id: chapterId, course_version: { course_id: courseId } } });
    if (!chapter) throw missing();
    await this.assertDraftVersion(tx, chapter.course_version_id);
    return chapter;
  }
  private async audit(tx: Prisma.TransactionClient, ctx: SessionContext, action: string, target: string, details?: Prisma.InputJsonValue) {
    await tx.course.update({ where: { id: target }, data: { updated_at: new Date() } });
    await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: ctx.user.id, origin: 'user', action,
      target_type: 'course', target_ref: target, ...(details ? { after_safe: details } : {}) } });
  }
  private async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try { return await this.db.$transaction(work, { timeout: 15_000 }); } catch (error) { if (uniqueFailure(error)) throw conflict(); throw error; }
  }

  async publicCourses(limitInput: unknown, cursorInput: unknown) {
    const limit = limitInput === undefined ? 25 : Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw apiError(422, 'INVALID_LIMIT', 'Ungültige Seitengröße.');
    const where: Prisma.CourseWhereInput = { status: 'published', visibility: 'public', versions: { some: { state: 'published' } } };
    const cursor = cursorInput === undefined ? undefined : String(cursorInput);
    if (cursor !== undefined && (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cursor) || cursor.length > 100 ||
        !(await this.db.course.findFirst({ where: { ...where, slug: cursor }, select: { id: true } })))) throw missing();
    const courses = await this.db.course.findMany({ where, orderBy: [{ sort_order: 'asc' }, { id: 'asc' }], take: limit + 1,
      ...(cursor ? { cursor: { slug: cursor }, skip: 1 } : {}),
      select: { slug: true, versions: { where: { state: 'published' }, take: 1,
        select: { title: true, subtitle: true, description: true, duration_minutes: true } } } });
    const data = courses.slice(0, limit).flatMap(course => course.versions.map(version => ({ slug: course.slug, title: version.title,
      subtitle: version.subtitle, description: publicText(version.description), duration_minutes: version.duration_minutes })));
    return { data, next_cursor: courses.length > limit && data.length ? data[data.length - 1].slug : null };
  }
  async publicCourse(courseSlug: string) {
    // Invalid and non-public slugs are indistinguishable.
    if (typeof courseSlug !== 'string' || courseSlug.length > 100 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(courseSlug)) throw missing();
    const course = await this.db.course.findFirst({ where: { slug: courseSlug, status: 'published', visibility: 'public',
      versions: { some: { state: 'published' } } }, select: { slug: true, versions: { where: { state: 'published' }, take: 1,
        select: { title: true, subtitle: true, description: true, duration_minutes: true } } } });
    const version = course?.versions[0];
    if (!course || !version) throw missing();
    return { slug: course.slug, title: version.title, subtitle: version.subtitle,
      description: publicText(version.description), duration_minutes: version.duration_minutes };
  }

  async list(ctx: SessionContext, limitInput: unknown, cursorInput: unknown) {
    const limit = limitInput === undefined ? 25 : Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw apiError(422, 'INVALID_LIMIT', 'Ungültige Seitengröße.');
    const cursor = cursorInput === undefined ? undefined : requireUuid(String(cursorInput));
    return this.transaction(async tx => {
      const roles = await this.currentActor(tx, ctx, 'courses.read');
      const where = scopeWhere(ctx.user.id, roles);
      if (cursor && !(await tx.course.findFirst({ where: { id: cursor, ...where }, select: { id: true } }))) throw missing();
      const rows = await tx.course.findMany({ where,
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }], take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, slug: true, status: true, visibility: true, updated_at: true,
          // Published courses have no draft until an editor creates one, but the
          // overview must still name them. The draft always wins over the
          // published version here, so the label never shows stale text.
          versions: { where: { state: { in: ['draft', 'published'] } }, orderBy: { version: 'desc' }, take: 2,
            select: { id: true, version: true, title: true, state: true } } } });
      const data = rows.slice(0, limit).map(course => {
        const draft = course.versions.find(version => version.state === 'draft');
        const published = course.versions.find(version => version.state === 'published');
        const current = draft || published;
        return { id: course.id, slug: course.slug, status: course.status, visibility: course.visibility,
          updated_at: course.updated_at, draft: current ? { id: current.id, version: current.version, title: current.title } : null,
          needs_draft: course.status === 'published' && !draft };
      });
      return { data, next_cursor: rows.length > limit && data.length ? data[data.length - 1].id : null };
    });
  }
  async detail(ctx: SessionContext, courseId: string) {
    requireUuid(courseId);
    return this.transaction(async tx => {
      const roles = await this.currentActor(tx, ctx, 'courses.read');
      const course = await tx.course.findFirst({ where: { id: courseId, ...scopeWhere(ctx.user.id, roles) },
        include: { versions: { where: { state: 'draft' }, orderBy: { version: 'desc' }, include: { modules: { orderBy: { position: 'asc' },
          include: { chapters: { orderBy: { position: 'asc' }, include: { _count: { select: { contents: true } } } } } } } },
          ...(globalRole(roles) ? { staff: { select: { user_id: true, scope_role: true }, orderBy: [{ user_id: 'asc' }, { scope_role: 'asc' }] } } : {}) } });
      if (!course) throw missing();
      return course;
    });
  }
  async create(ctx: SessionContext, input: unknown) {
    const body = bodyObject(input, ['slug', 'title', 'subtitle', 'description', 'visibility', 'chapter_completion_mode',
      'expected_module_count', 'expected_chapter_count', 'expected_exams_per_chapter']);
    const values = { slug: slug(body.slug), title: text(body.title, 'title', 160)!, subtitle: text(body.subtitle, 'subtitle', 240, true),
      description: description(body.description), visibility: visibility(body.visibility), completion: completionMode(body.chapter_completion_mode),
      modules: integer(body.expected_module_count, 'expected_module_count', { nullable: true, min: 1, max: 500 }),
      chapters: integer(body.expected_chapter_count, 'expected_chapter_count', { nullable: true, min: 1, max: 5000 }),
      exams: integer(body.expected_exams_per_chapter, 'expected_exams_per_chapter', { nullable: true, min: 1, max: 100 }) };
    return this.transaction(async tx => {
      await this.currentActor(tx, ctx, 'courses.create', true);
      const courseId = uuidv7(), versionId = uuidv7();
      await tx.course.create({ data: { id: courseId, slug: values.slug, status: 'draft', visibility: values.visibility } });
      await tx.courseVersion.create({ data: { id: versionId, course_id: courseId, version: 1, state: 'draft', title: values.title,
        subtitle: values.subtitle, description: values.description, chapter_completion_mode: values.completion,
        expected_module_count: values.modules, expected_chapter_count: values.chapters, expected_exams_per_chapter: values.exams,
        created_by: ctx.user.id } });
      await this.audit(tx, ctx, 'course.created', courseId, { version_id: versionId });
      return { id: courseId, version_id: versionId, status: 'draft' };
    });
  }
  async updateVersion(ctx: SessionContext, versionId: string, input: unknown) {
    requireUuid(versionId);
    const body = bodyObject(input, ['revision', 'title', 'subtitle', 'description', 'chapter_completion_mode', 'expected_module_count',
      'expected_chapter_count', 'expected_exams_per_chapter', 'duration_minutes', 'default_access_days']);
    const expectedRevision = revision(body.revision);
    if (Object.keys(body).length < 2) return fail('body');
    const data: Prisma.CourseVersionUpdateInput = { revision: { increment: 1 } };
    if ('title' in body) data.title = text(body.title, 'title', 160)!;
    if ('subtitle' in body) data.subtitle = text(body.subtitle, 'subtitle', 240, true);
    if ('description' in body) data.description = description(body.description);
    if ('chapter_completion_mode' in body) data.chapter_completion_mode = completionMode(body.chapter_completion_mode);
    for (const key of ['duration_minutes', 'default_access_days'] as const) {
      if (key in body) data[key] = integer(body[key], key, { nullable: true, min: 1, max: 1_000_000 });
    }
    for (const key of ['expected_module_count', 'expected_chapter_count', 'expected_exams_per_chapter'] as const) {
      if (key in body) data[key] = integer(body[key], key, { nullable: true, min: 1,
        max: key === 'expected_exams_per_chapter' ? 100 : key === 'expected_module_count' ? 500 : 5000 });
    }
    return this.transaction(async tx => {
      const roles = await this.currentActor(tx, ctx, 'courses.edit');
      const existing = await tx.courseVersion.findUnique({ where: { id: versionId }, select: { course_id: true } });
      if (!existing) throw missing();
      await this.lockAuthorizedCourse(tx, ctx.user.id, existing.course_id, roles);
      const version = await tx.courseVersion.findFirst({ where: { id: versionId, course_id: existing.course_id } });
      if (!version) throw missing();
      if (version.state !== 'draft') throw apiError(409, 'VERSION_NOT_DRAFT', 'Veröffentlichte Versionen sind unveränderlich. Lege eine neue Entwurfsversion an.');
      if (version.revision !== expectedRevision) throw stale();
      const updated = await tx.courseVersion.update({ where: { id: versionId }, data });
      await this.audit(tx, ctx, 'course.draft_updated', existing.course_id, { version_id: versionId });
      return updated;
    });
  }
  async addModule(ctx: SessionContext, versionId: string, input: unknown) {
    requireUuid(versionId);
    const body = bodyObject(input, ['title', 'description', 'position']);
    const title = text(body.title, 'title', 160)!, note = text(body.description, 'description', 4000, true, true);
    const position = integer(body.position, 'position', { max: 100_000 })!;
    return this.transaction(async tx => {
      const roles = await this.currentActor(tx, ctx, 'courses.edit');
      const existing = await tx.courseVersion.findUnique({ where: { id: versionId }, select: { course_id: true } });
      if (!existing) throw missing();
      await this.lockAuthorizedCourse(tx, ctx.user.id, existing.course_id, roles);
      const version = await tx.courseVersion.findFirst({ where: { id: versionId, course_id: existing.course_id } });
      if (!version) throw missing();
      if (version.state !== 'draft') throw apiError(409, 'VERSION_NOT_DRAFT', 'Veröffentlichte Versionen sind unveränderlich. Lege eine neue Entwurfsversion an.');
      if (await tx.courseModule.count({ where: { course_version_id: versionId } }) >= 500) return fail('modules');
      const item = await tx.courseModule.create({ data: { id: uuidv7(), course_version_id: versionId, title, description: note, position } });
      await this.audit(tx, ctx, 'course.module_created', existing.course_id, { version_id: versionId, module_id: item.id });
      return item;
    });
  }
  async updateModule(ctx: SessionContext, moduleId: string, input: unknown) {
    requireUuid(moduleId);
    const body = bodyObject(input, ['revision', 'title', 'description', 'position']);
    const expectedRevision = revision(body.revision);
    if (Object.keys(body).length < 2) return fail('body');
    const data: Prisma.CourseModuleUpdateInput = { revision: { increment: 1 } };
    if ('title' in body) data.title = text(body.title, 'title', 160)!;
    if ('description' in body) data.description = text(body.description, 'description', 4000, true, true);
    if ('position' in body) data.position = integer(body.position, 'position', { max: 100_000 })!;
    return this.transaction(async tx => {
      const roles = await this.currentActor(tx, ctx, 'courses.edit');
      const item = await tx.courseModule.findUnique({ where: { id: moduleId }, include: { course_version: { select: { course_id: true } } } });
      if (!item) throw missing();
      const courseId = item.course_version.course_id;
      await this.lockAuthorizedCourse(tx, ctx.user.id, courseId, roles);
      const current = await tx.courseModule.findFirst({ where: { id: moduleId, course_version: { course_id: courseId } } });
      if (!current) throw missing();
      await this.assertDraftVersion(tx, current.course_version_id);
      if (current.revision !== expectedRevision) throw stale();
      const updated = await tx.courseModule.update({ where: { id: moduleId }, data });
      await this.audit(tx, ctx, 'course.module_updated', courseId, { module_id: moduleId });
      return updated;
    });
  }
  async addChapter(ctx: SessionContext, moduleId: string, input: unknown) {
    requireUuid(moduleId);
    const body = bodyObject(input, ['title', 'summary', 'estimated_minutes', 'position']);
    const title = text(body.title, 'title', 160)!, summary = text(body.summary, 'summary', 4000, true, true);
    const minutes = integer(body.estimated_minutes, 'estimated_minutes', { nullable: true, min: 1, max: 100_000 });
    const position = integer(body.position, 'position', { max: 100_000 })!;
    return this.transaction(async tx => {
      const roles = await this.currentActor(tx, ctx, 'courses.edit');
      const item = await tx.courseModule.findUnique({ where: { id: moduleId }, include: { course_version: { select: { course_id: true } } } });
      if (!item) throw missing();
      const courseId = item.course_version.course_id;
      await this.lockAuthorizedCourse(tx, ctx.user.id, courseId, roles);
      const current = await tx.courseModule.findFirst({ where: { id: moduleId, course_version: { course_id: courseId } } });
      if (!current) throw missing();
      await this.assertDraftVersion(tx, current.course_version_id);
      if (await tx.courseChapter.count({ where: { course_version_id: current.course_version_id } }) >= 5000) return fail('chapters');
      const chapter = await tx.courseChapter.create({ data: { id: uuidv7(), course_version_id: current.course_version_id,
        module_id: moduleId, title, summary, estimated_minutes: minutes, position } });
      await this.audit(tx, ctx, 'course.chapter_created', courseId, { module_id: moduleId, chapter_id: chapter.id });
      return chapter;
    });
  }
  async updateChapter(ctx: SessionContext, chapterId: string, input: unknown) {
    requireUuid(chapterId);
    const body = bodyObject(input, ['revision', 'title', 'summary', 'estimated_minutes', 'position']);
    const expectedRevision = revision(body.revision);
    if (Object.keys(body).length < 2) return fail('body');
    const data: Prisma.CourseChapterUpdateInput = { revision: { increment: 1 } };
    if ('title' in body) data.title = text(body.title, 'title', 160)!;
    if ('summary' in body) data.summary = text(body.summary, 'summary', 4000, true, true);
    if ('estimated_minutes' in body) data.estimated_minutes = integer(body.estimated_minutes, 'estimated_minutes', { nullable: true, min: 1, max: 100_000 });
    if ('position' in body) data.position = integer(body.position, 'position', { max: 100_000 })!;
    return this.transaction(async tx => {
      const roles = await this.currentActor(tx, ctx, 'courses.edit');
      const item = await tx.courseChapter.findUnique({ where: { id: chapterId }, include: { course_version: { select: { course_id: true } } } });
      if (!item) throw missing();
      const courseId = item.course_version.course_id;
      await this.lockAuthorizedCourse(tx, ctx.user.id, courseId, roles);
      const current = await tx.courseChapter.findFirst({ where: { id: chapterId, course_version: { course_id: courseId } } });
      if (!current) throw missing();
      await this.assertDraftVersion(tx, current.course_version_id);
      if (current.revision !== expectedRevision) throw stale();
      const updated = await tx.courseChapter.update({ where: { id: chapterId }, data });
      await this.audit(tx, ctx, 'course.chapter_updated', courseId, { chapter_id: chapterId });
      return updated;
    });
  }
  async deleteModule(ctx: SessionContext, moduleId: string, input: unknown) {
    requireUuid(moduleId);
    const expectedRevision = revision(bodyObject(input, ['revision']).revision);
    return this.transaction(async tx => {
      const roles = await this.currentActor(tx, ctx, 'courses.edit');
      const item = await tx.courseModule.findUnique({ where: { id: moduleId }, include: { course_version: { select: { course_id: true } } } });
      if (!item) throw missing();
      const courseId = item.course_version.course_id;
      await this.lockAuthorizedCourse(tx, ctx.user.id, courseId, roles);
      const current = await tx.courseModule.findFirst({ where: { id: moduleId, course_version: { course_id: courseId } } });
      if (!current) throw missing();
      await this.assertDraftVersion(tx, current.course_version_id);
      if (current.revision !== expectedRevision) throw stale();
      if (await tx.courseChapter.count({ where: { module_id: moduleId } })) {
        throw apiError(409, 'MODULE_NOT_EMPTY', 'Bitte entferne zuerst die Kapitel dieses Moduls.');
      }
      await tx.courseModule.delete({ where: { id: moduleId } });
      await this.audit(tx, ctx, 'course.module_deleted', courseId, { module_id: moduleId });
    });
  }
  async deleteChapter(ctx: SessionContext, chapterId: string, input: unknown) {
    requireUuid(chapterId);
    const expectedRevision = revision(bodyObject(input, ['revision']).revision);
    return this.transaction(async tx => {
      const roles = await this.currentActor(tx, ctx, 'courses.edit');
      const item = await tx.courseChapter.findUnique({ where: { id: chapterId }, include: { course_version: { select: { course_id: true } } } });
      if (!item) throw missing();
      const courseId = item.course_version.course_id;
      await this.lockAuthorizedCourse(tx, ctx.user.id, courseId, roles);
      const current = await tx.courseChapter.findFirst({ where: { id: chapterId, course_version: { course_id: courseId } } });
      if (!current) throw missing();
      await this.assertDraftVersion(tx, current.course_version_id);
      if (current.revision !== expectedRevision) throw stale();
      if (await tx.chapterContent.count({ where: { chapter_id: chapterId } })) {
        throw apiError(409, 'CHAPTER_NOT_EMPTY', 'Bitte entferne zuerst die Inhaltsbausteine dieses Kapitels.');
      }
      await tx.courseChapter.delete({ where: { id: chapterId } });
      await this.audit(tx, ctx, 'course.chapter_deleted', courseId, { module_id: current.module_id, chapter_id: chapterId });
    });
  }
  async listContents(ctx: SessionContext, chapterId: string, limitInput: unknown, cursorInput: unknown) {
    requireUuid(chapterId);
    const limit = limitInput === undefined ? 20 : Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw apiError(422, 'INVALID_LIMIT', 'Ungültige Seitengröße.');
    const cursor = cursorInput === undefined ? undefined : requireUuid(String(cursorInput));
    return this.transaction(async tx => {
      // Keep the scope lock until after the read: an unassignment cannot race
      // between authorization and retrieving a chapter's private lesson text.
      await this.lockChapter(tx, ctx, chapterId, 'courses.read');
      if (cursor && !(await tx.chapterContent.findFirst({ where: { id: cursor, chapter_id: chapterId }, select: { id: true } }))) {
        throw apiError(409, 'STALE_CURSOR', 'Die Inhaltsliste hat sich geändert. Bitte lade sie neu.');
      }
      const rows = await tx.chapterContent.findMany({ where: { chapter_id: chapterId },
        orderBy: [{ position: 'asc' }, { id: 'asc' }], take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, kind: true, title: true, body: true, position: true, revision: true } });
      const data = rows.slice(0, limit).map(row => ({ ...row,
        editable: row.kind === 'text' && supportedContentDocument(row.body, row.id) }));
      const total = await tx.chapterContent.count({ where: { chapter_id: chapterId } });
      return { data, total, next_cursor: rows.length > limit && data.length ? data[data.length - 1].id : null };
    });
  }
  async addContent(ctx: SessionContext, chapterId: string, input: unknown) {
    requireUuid(chapterId);
    const body = bodyObject(input, ['title', 'block', 'position']);
    const id = uuidv7(), document = contentDocument(body.block, id);
    const title = text(body.title, 'title', 160, true);
    const position = 'position' in body ? integer(body.position, 'position', { max: 100_000 }) : null;
    return this.transaction(async tx => {
      const { courseId, chapter } = await this.lockChapter(tx, ctx, chapterId, 'courses.edit');
      if (await tx.chapterContent.count({ where: { chapter_id: chapterId } }) >= 200) return fail('contents');
      if (await tx.chapterContent.count({ where: { course_version_id: chapter.course_version_id } }) >= 10_000) return fail('contents');
      const last = position === null ? await tx.chapterContent.findFirst({ where: { chapter_id: chapterId }, orderBy: { position: 'desc' }, select: { position: true } }) : null;
      const chosen = position ?? ((last?.position ?? 0) + 1);
      if (chosen > 100_000) throw apiError(409, 'POSITION_EXHAUSTED', 'Bitte ordne die Positionen neu, bevor du einen weiteren Baustein anhängst.');
      const created = await tx.chapterContent.create({ data: { id, course_version_id: chapter.course_version_id,
        chapter_id: chapterId, kind: 'text', title, body: document, position: chosen } });
      await this.audit(tx, ctx, 'course.content_created', courseId, { chapter_id: chapterId, content_id: id });
      return created;
    });
  }
  async updateContent(ctx: SessionContext, contentId: string, input: unknown) {
    requireUuid(contentId);
    const body = bodyObject(input, ['revision', 'title', 'position', 'block']);
    const expectedRevision = revision(body.revision);
    if (Object.keys(body).length < 2) return fail('body');
    const data: Prisma.ChapterContentUpdateInput = { revision: { increment: 1 } };
    if ('title' in body) data.title = text(body.title, 'title', 160, true);
    if ('position' in body) data.position = integer(body.position, 'position', { max: 100_000 })!;
    if ('block' in body) data.body = contentDocument(body.block, contentId);
    return this.transaction(async tx => {
      const { courseId, content } = await this.lockContent(tx, ctx, contentId);
      if (content.revision !== expectedRevision) throw stale();
      if (content.kind !== 'text' || !supportedContentDocument(content.body, contentId)) {
        throw apiError(409, 'UNSUPPORTED_CONTENT', 'Dieses Inhaltsformat kann hier nicht verändert werden.');
      }
      const updated = await tx.chapterContent.update({ where: { id: contentId }, data });
      await this.audit(tx, ctx, 'course.content_updated', courseId, { chapter_id: content.chapter_id, content_id: contentId });
      return updated;
    });
  }
  async deleteContent(ctx: SessionContext, contentId: string, input: unknown) {
    requireUuid(contentId);
    const expectedRevision = revision(bodyObject(input, ['revision']).revision);
    return this.transaction(async tx => {
      const { courseId, content } = await this.lockContent(tx, ctx, contentId);
      if (content.revision !== expectedRevision) throw stale();
      if (content.kind !== 'text' || !supportedContentDocument(content.body, contentId)) {
        throw apiError(409, 'UNSUPPORTED_CONTENT', 'Dieses Inhaltsformat kann hier nicht entfernt werden.');
      }
      await tx.chapterContent.delete({ where: { id: contentId } });
      await this.audit(tx, ctx, 'course.content_deleted', courseId, { chapter_id: content.chapter_id, content_id: contentId });
    });
  }

  async assign(ctx: SessionContext, courseId: string, input: unknown) {
    requireUuid(courseId);
    const body = bodyObject(input, ['user_id', 'scope_role']);
    if (typeof body.user_id !== 'string') return fail('user_id');
    const userId = requireUuid(body.user_id);
    if (typeof body.scope_role !== 'string' || !['manager', 'instructor'].includes(body.scope_role)) return fail('scope_role');
    const role = body.scope_role;
    return this.transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('trainerb_role_changes'))::text`;
      await this.lockCourse(tx, ctx, courseId, 'courses.create', true, true, userId);
      const user = await tx.user.findUnique({ where: { id: userId }, include: { roles: { include: { role: true } } } });
      const needed = role === 'manager' ? 'course_manager' : 'instructor';
      if (!user || user.status !== 'active' || !user.roles.some(item => item.role.key === needed)) return fail('user_id');
      const where = { course_id_user_id_scope_role: { course_id: courseId, user_id: userId, scope_role: role } };
      const old = await tx.courseStaff.findUnique({ where });
      if (!old) {
        await tx.courseStaff.create({ data: { course_id: courseId, user_id: userId, scope_role: role, assigned_by: ctx.user.id } });
        await this.audit(tx, ctx, 'course.staff_assigned', courseId, { user_id: userId, scope_role: role });
      }
      return { course_id: courseId, user_id: userId, scope_role: role };
    });
  }
  async unassign(ctx: SessionContext, courseId: string, userId: string, scope: string) {
    requireUuid(courseId); requireUuid(userId);
    if (!['manager', 'instructor'].includes(scope)) throw missing();
    return this.transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('trainerb_role_changes'))::text`;
      await this.lockCourse(tx, ctx, courseId, 'courses.create', true, true);
      const removed = await tx.courseStaff.deleteMany({ where: { course_id: courseId, user_id: userId, scope_role: scope } });
      if (!removed.count) throw missing();
      await this.audit(tx, ctx, 'course.staff_removed', courseId, { user_id: userId, scope_role: scope });
    });
  }
}
