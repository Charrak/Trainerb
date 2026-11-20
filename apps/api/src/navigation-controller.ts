import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { Sessions, type ApiRequest } from './sessions';
import { backofficeWrite } from './backoffice-write';
import { apiError, bodyObject, requireUuid, requireString } from './security';
import { plainText } from './commerce-validation';

function area(location: string) {
  if (location !== 'header' && location !== 'footer') throw apiError(404, 'NOT_FOUND', 'Menü nicht gefunden.');
  return location;
}
const invalid = () =>
  apiError(422, 'INVALID_MENU', 'Bitte höchstens zwölf unterschiedliche Seiten mit einer Beschriftung angeben.');
@Controller()
export class NavigationController {
  constructor(
    private readonly db: Database,
    private readonly sessions: Sessions,
  ) {}
  @Get('navigation') async published() {
    const rows = await this.db.$queryRaw<{ location: 'header' | 'footer'; slug: string; label: string }[]>`
      SELECT n.location,p.slug,n.label FROM navigation_items n JOIN pages p ON p.id=n.page_id
      JOIN page_versions v ON v.page_id=p.id AND v.state='published'
      WHERE n.visible ORDER BY n.location,n.position`;
    const menus: { header: { href: string; label: string }[]; footer: { href: string; label: string }[] } = {
      header: [],
      footer: [],
    };
    for (const r of rows) menus[r.location].push({ href: `/seiten/${r.slug}`, label: r.label });
    return menus;
  }
  @Get('admin/navigation/:location') async read(@Req() req: ApiRequest, @Param('location') location: string) {
    await this.sessions.require(req, { backoffice: true, permission: 'cms.edit' });
    // A revision and the list it describes must be from the same snapshot.
    return this.db.$transaction(
      async (tx) => {
        const menu = await tx.navigationMenu.findUniqueOrThrow({
          where: { location: area(location) },
          select: {
            revision: true,
            items: {
              orderBy: { position: 'asc' },
              select: {
                page_id: true,
                label: true,
                visible: true,
                page: {
                  select: { slug: true, versions: { where: { state: 'published' }, take: 1, select: { id: true } } },
                },
              },
            },
          },
        });
        return {
          revision: menu.revision,
          items: menu.items.map(({ page, ...row }) => ({
            ...row,
            slug: page.slug,
            published: page.versions.length > 0,
          })),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  @Put('admin/navigation/:location') save(
    @Req() req: ApiRequest,
    @Param('location') location: string,
    @Body() input: unknown,
  ) {
    return backofficeWrite(this.db, this.sessions, req, 'cms.edit', async (tx, actor) => {
      area(location);
      const { revision, items } = bodyObject(input, ['revision', 'items']);
      if (
        typeof revision !== 'number' ||
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        !Array.isArray(items) ||
        items.length > 12
      )
        throw invalid();
      const rows = items.map((item, i) => {
        const b = bodyObject(item, ['page_id', 'label', 'visible']);
        if (typeof b.visible !== 'boolean') throw invalid();
        return {
          location,
          position: i + 1,
          page_id: requireUuid(requireString(b.page_id, 'page_id', 36)).toLowerCase(),
          label: plainText(b.label, 'label', 60)!,
          visible: b.visible,
        };
      });
      const ids = rows.map((r) => r.page_id);
      if (new Set(ids).size !== ids.length || (await tx.page.count({ where: { id: { in: ids } } })) !== ids.length)
        throw invalid();
      const saved = await tx.navigationMenu.updateMany({
        where: { location, revision },
        data: { revision: { increment: 1 } },
      });
      if (saved.count !== 1)
        throw apiError(409, 'MENU_CHANGED', 'Das Menü wurde zwischenzeitlich geändert. Bitte neu laden.');
      await tx.navigationItem.deleteMany({ where: { location } });
      if (rows.length) await tx.navigationItem.createMany({ data: rows });
      await tx.auditEvent.create({
        data: {
          id: uuidv7(),
          origin: 'user',
          actor_user_id: actor,
          action: 'navigation.updated',
          target_type: 'navigation_menu',
          target_ref: location,
          after_safe: { revision: revision + 1, count: rows.length },
        },
      });
      return { revision: revision + 1 };
    });
  }
}
