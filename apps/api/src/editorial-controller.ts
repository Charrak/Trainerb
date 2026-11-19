import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { Sessions, type ApiRequest } from './sessions';
import { apiError, bodyObject, requireUuid } from './security';
import { backofficeWrite } from './backoffice-write';
import { plainText } from './commerce-validation';

const missing = () => apiError(404, 'NOT_FOUND', 'Seite nicht gefunden.');
const conflict = () => apiError(409, 'EDITORIAL_CONFLICT', 'Der Seitenstand hat sich geändert. Bitte neu laden.');
const view = { id: true, version: true, state: true, title: true, body: true, description: true } as const;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function validSlug(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 80 && slugPattern.test(s);
}
function values(b: Record<string, unknown>) {
  return {
    title: plainText(b.title, 'title', 160)!,
    body: plainText(b.body, 'body', 20000, false, true)!,
    description: plainText(b.description, 'description', 300, true) ?? '',
  };
}
function audit(tx: Prisma.TransactionClient, actor: string, action: string, id: string, version: number) {
  return tx.auditEvent.create({
    data: {
      id: uuidv7(),
      origin: 'user',
      actor_user_id: actor,
      action: `page.${action}`,
      target_type: 'page',
      target_ref: id,
      after_safe: { version },
    },
  });
}
async function lock(tx: Prisma.TransactionClient, id: string, revision: unknown) {
  const [p] = await tx.$queryRaw<
    { revision: number }[]
  >`SELECT revision FROM pages WHERE id=${requireUuid(id)}::uuid FOR UPDATE`;
  if (!p) throw missing();
  if (p.revision !== revision) throw conflict();
}
function cursor(query: unknown) {
  const { after } = bodyObject(query, ['after']);
  if (after === undefined) return undefined;
  if (!validSlug(after)) throw apiError(422, 'INVALID_CURSOR', 'Ungültige Seitenmarke.');
  return after;
}
function page<T extends { slug: string }>(rows: T[]) {
  return { data: rows.slice(0, 50), next_cursor: rows.length > 50 ? rows[49].slug : null };
}

@Controller()
export class EditorialController {
  constructor(
    private readonly db: Database,
    private readonly sessions: Sessions,
  ) {}
  @Get('pages') async publicList(@Query() q: unknown) {
    const after = cursor(q);
    const rows = await this.db.pageVersion.findMany({
      where: { state: 'published', page: { slug: { gt: after } } },
      orderBy: { page: { slug: 'asc' } },
      take: 51,
      select: { title: true, page: { select: { slug: true } } },
    });
    return page(rows.map((r) => ({ slug: r.page.slug, title: r.title })));
  }
  @Get('pages/:slug') async publicPage(@Param('slug') slug: string) {
    if (!validSlug(slug)) throw missing();
    const v = await this.db.pageVersion.findFirst({
      where: { page: { slug }, state: 'published' },
      select: { version: true, title: true, body: true, description: true },
    });
    if (!v) throw missing();
    return v;
  }
  @Get('admin/pages') async list(@Req() req: ApiRequest, @Query() q: unknown) {
    await this.sessions.require(req, { backoffice: true, permission: 'cms.edit' });
    const after = cursor(q);
    return page(
      await this.db.page.findMany({
        where: { slug: { gt: after } },
        orderBy: { slug: 'asc' },
        take: 51,
        select: { id: true, slug: true },
      }),
    );
  }
  @Get('admin/pages/:id') async detail(@Req() req: ApiRequest, @Param('id') id: string) {
    await this.sessions.require(req, { backoffice: true, permission: 'cms.edit' });
    const p = await this.db.page.findUnique({
      where: { id: requireUuid(id) },
      select: {
        id: true,
        slug: true,
        revision: true,
        versions: { orderBy: { version: 'desc' }, take: 1, select: view },
      },
    });
    if (!p) throw missing();
    const published = await this.db.pageVersion.findFirst({
      where: { page_id: id, state: 'published' },
      select: { id: true, version: true },
    });
    return { id: p.id, slug: p.slug, revision: p.revision, latest: p.versions[0], published };
  }
  @Post('admin/pages') create(@Req() req: ApiRequest, @Body() input: unknown) {
    return backofficeWrite(this.db, this.sessions, req, 'cms.edit', async (tx, actor) => {
      const b = bodyObject(input, ['slug', 'title', 'description', 'body']);
      if (!validSlug(b.slug))
        throw apiError(422, 'INVALID_SLUG', 'Kurzer Pfad aus Kleinbuchstaben, Ziffern und Bindestrichen erforderlich.');
      const id = uuidv7();
      const { count } = await tx.page.createMany({ data: [{ id, slug: b.slug }], skipDuplicates: true });
      if (!count) throw apiError(409, 'SLUG_TAKEN', 'Dieser Seitenpfad ist bereits belegt.');
      await tx.pageVersion.create({
        data: { ...values(b), id: uuidv7(), page_id: id, version: 1, state: 'draft', created_by: actor },
      });
      await audit(tx, actor, 'drafted', id, 1);
      return { id };
    });
  }
  @Post('admin/pages/:id/drafts') draft(@Req() req: ApiRequest, @Param('id') id: string, @Body() input: unknown) {
    return backofficeWrite(this.db, this.sessions, req, 'cms.edit', async (tx, actor) => {
      const b = bodyObject(input, ['revision', 'title', 'description', 'body']);
      await lock(tx, id, b.revision);
      const last = await tx.pageVersion.findFirstOrThrow({
        where: { page_id: id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      await tx.pageVersion.updateMany({ where: { page_id: id, state: 'draft' }, data: { state: 'retired' } });
      await tx.pageVersion.create({
        data: { ...values(b), id: uuidv7(), page_id: id, version: last.version + 1, state: 'draft', created_by: actor },
      });
      await tx.page.update({ where: { id }, data: { revision: { increment: 1 } } });
      await audit(tx, actor, 'drafted', id, last.version + 1);
      return { id };
    });
  }
  @Post('admin/pages/:id/publish') @HttpCode(200) publish(
    @Req() req: ApiRequest,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return this.transition(req, id, input, true);
  }
  @Post('admin/pages/:id/withdraw') @HttpCode(200) withdraw(
    @Req() req: ApiRequest,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return this.transition(req, id, input, false);
  }
  private transition(req: ApiRequest, id: string, input: unknown, publish: boolean) {
    return backofficeWrite(this.db, this.sessions, req, 'cms.edit', async (tx, actor) => {
      const b = bodyObject(input, ['revision', 'version_id']);
      await lock(tx, id, b.revision);
      const v = await tx.pageVersion.findFirst({ where: { page_id: id, state: publish ? 'draft' : 'published' } });
      if (!v || v.id !== b.version_id) throw conflict();
      await tx.pageVersion.updateMany({ where: { page_id: id, state: 'published' }, data: { state: 'retired' } });
      if (publish)
        await tx.pageVersion.update({
          where: { id: v.id },
          data: { state: 'published', published_by: actor, published_at: new Date() },
        });
      await tx.page.update({ where: { id }, data: { revision: { increment: 1 } } });
      await audit(tx, actor, publish ? 'published' : 'withdrawn', id, v.version);
      return { id };
    });
  }
}
