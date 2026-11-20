import { EDITORIAL_TEXT_LIMIT } from '@trainerb/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { getConfig } from './config';
import { signLessonGet } from './lesson-media';
import type { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { Sessions, type ApiRequest } from './sessions';
import { apiError, bodyObject, requireUuid } from './security';
import { backofficeWrite } from './backoffice-write';
import { plainText } from './commerce-validation';

const missing = () => apiError(404, 'NOT_FOUND', 'Seite nicht gefunden.');
const conflict = () => apiError(409, 'EDITORIAL_CONFLICT', 'Der Seitenstand hat sich geändert. Bitte neu laden.');
const presentation = { banner: true, button_label: true, button_path: true, image_id: true, image_alt: true } as const;
const availableImage = {
  source: 's3',
  status: 'ready',
  visibility: 'public',
  mime_detected: { in: ['image/png', 'image/jpeg'] },
};
const noImage = () => apiError(422, 'PAGE_IMAGE_UNAVAILABLE', 'Das Bild ist nicht für öffentliche Seiten verfügbar.');
const view = {
  ...presentation,
  id: true,
  version: true,
  state: true,
  title: true,
  body: true,
  description: true,
} as const;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function validSlug(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 80 && slugPattern.test(s);
}
function values(b: Record<string, unknown>) {
  return {
    title: plainText(b.title, 'title', 160)!,
    body: plainText(b.body, 'body', EDITORIAL_TEXT_LIMIT, false, true)!,
    description: plainText(b.description, 'description', 300, true) ?? '',
  };
}
async function design(tx: Prisma.TransactionClient, b: Record<string, unknown>) {
  const banner = plainText(b.banner, 'banner', 240, true),
    button_label = plainText(b.button_label, 'button_label', 80, true),
    button_path = plainText(b.button_path, 'button_path', 32, true),
    image_alt = plainText(b.image_alt, 'image_alt', 180, true),
    image_id = plainText(b.image_id, 'image_id', 36, true);
  if (
    !!button_label !== !!button_path ||
    (button_path && !['/kurse', '/buchen', '/seiten', '/registrieren'].includes(button_path))
  )
    throw apiError(422, 'INVALID_BUTTON', 'Bitte Linktext und ein vorhandenes internes Ziel wählen.');
  if (!!image_alt !== !!image_id) throw apiError(422, 'INVALID_IMAGE', 'Ein Bild benötigt einen Alternativtext.');
  if (image_id) await lockImage(tx, requireUuid(image_id));
  return { banner, button_label, button_path, image_id, image_alt };
}
async function lockImage(tx: Prisma.TransactionClient, id: string) {
  if (!getConfig().mediaStore) throw noImage();
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM media_assets WHERE id=${id}::uuid AND source='s3' AND status='ready'
    AND visibility='public' AND mime_detected IN ('image/png','image/jpeg') FOR SHARE`;
  if (!rows.length) throw noImage();
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
      select: {
        version: true,
        title: true,
        body: true,
        description: true,
        banner: true,
        button_label: true,
        button_path: true,
        image_alt: true,
        image: { select: { id: true, status: true, visibility: true, mime_detected: true } },
      },
    });
    if (!v) throw missing();
    const { image, image_alt, banner, button_label, button_path, ...text } = v;
    return {
      ...text,
      ...(banner && { banner }),
      ...(button_label && { button_label, button_path }),
      ...(image &&
        getConfig().mediaStore &&
        image.status === 'ready' &&
        image.visibility === 'public' &&
        availableImage.mime_detected.in.includes(image.mime_detected) && {
          image_alt,
          image_url: `/api/v1/pages/${slug}/image/${v.version}`,
        }),
    };
  }
  @Get('pages/:slug/image/:version') async image(
    @Param('slug') slug: string,
    @Param('version') version: string,
    @Res() res: Response,
  ) {
    const store = getConfig().mediaStore;
    if (!store || !validSlug(slug) || !/^[1-9]\d{0,8}$/.test(version)) throw missing();
    const row = await this.db.pageVersion.findFirst({
      where: { page: { slug }, state: 'published', version: Number(version), image: availableImage },
      select: { image: { select: { storage_key: true, mime_detected: true } } },
    });
    if (!row?.image?.storage_key) throw missing();
    return res.redirect(302, await signLessonGet(store, row.image.storage_key, 'image', row.image.mime_detected, 60));
  }
  @Get('admin/page-images/:id') async previewImage(
    @Req() req: ApiRequest,
    @Res() res: Response,
    @Param('id') id: string,
  ) {
    await this.sessions.require(req, { backoffice: true, permission: 'cms.edit' });
    const store = getConfig().mediaStore;
    if (!store) throw missing();
    const asset = await this.db.mediaAsset.findFirst({
      where: { ...availableImage, id: requireUuid(id) },
      select: { storage_key: true, mime_detected: true },
    });
    if (!asset?.storage_key) throw missing();
    return res.redirect(302, await signLessonGet(store, asset.storage_key, 'image', asset.mime_detected, 60));
  }
  @Get('admin/page-images') async images(@Req() req: ApiRequest, @Query() query: unknown) {
    await this.sessions.require(req, { backoffice: true, permission: 'cms.edit' });
    const { after } = bodyObject(query, ['after']);
    if (after !== undefined && typeof after !== 'string') throw noImage();
    const rows = getConfig().mediaStore
      ? await this.db.mediaAsset.findMany({
          where: { ...availableImage, id: { gt: after === undefined ? undefined : requireUuid(after) } },
          select: { id: true, original_name: true },
          orderBy: { id: 'asc' },
          take: 51,
        })
      : [];
    return { data: rows.slice(0, 50), next_cursor: rows.length > 50 ? rows[49].id : null };
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
      const b = bodyObject(input, ['slug', 'title', 'description', 'body', ...Object.keys(presentation)]);
      if (!validSlug(b.slug))
        throw apiError(422, 'INVALID_SLUG', 'Kurzer Pfad aus Kleinbuchstaben, Ziffern und Bindestrichen erforderlich.');
      const id = uuidv7();
      const { count } = await tx.page.createMany({ data: [{ id, slug: b.slug }], skipDuplicates: true });
      if (!count) throw apiError(409, 'SLUG_TAKEN', 'Dieser Seitenpfad ist bereits belegt.');
      await tx.pageVersion.create({
        data: {
          ...values(b),
          ...(await design(tx, b)),
          id: uuidv7(),
          page_id: id,
          version: 1,
          state: 'draft',
          created_by: actor,
        },
      });
      await audit(tx, actor, 'drafted', id, 1);
      return { id };
    });
  }
  @Post('admin/pages/:id/drafts') draft(@Req() req: ApiRequest, @Param('id') id: string, @Body() input: unknown) {
    return backofficeWrite(this.db, this.sessions, req, 'cms.edit', async (tx, actor) => {
      const b = bodyObject(input, ['revision', 'title', 'description', 'body', ...Object.keys(presentation)]);
      await lock(tx, id, b.revision);
      const last = await tx.pageVersion.findFirstOrThrow({
        where: { page_id: id },
        orderBy: { version: 'desc' },
        select: { version: true, ...presentation },
      });
      await tx.pageVersion.updateMany({ where: { page_id: id, state: 'draft' }, data: { state: 'retired' } });
      await tx.pageVersion.create({
        data: {
          ...values(b),
          ...(await design(tx, { ...last, ...b })),
          id: uuidv7(),
          page_id: id,
          version: last.version + 1,
          state: 'draft',
          created_by: actor,
        },
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
      if (publish && v.image_id) await lockImage(tx, v.image_id);
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
