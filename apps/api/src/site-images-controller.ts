import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { uuidv7 } from 'uuidv7';
import { Database } from './database';
import { Sessions, type ApiRequest } from './sessions';
import { RateLimiter } from './limiter';
import { quarantineFile } from './quarantine';
import { assertBackofficeWrite, backofficeWrite } from './backoffice-write';
import { bodyObject, apiError, requireUuid } from './security';
const perm = 'cms.edit',
  changed = () =>
    apiError(
      409,
      'IMAGE_STATE_CHANGED',
      'Scan, Berechtigung und Freigabestand prüfen. Eigenfreigabe ist ausgeschlossen.',
    );
@Controller('admin/site-image-uploads')
export class SiteImagesController {
  constructor(
    private readonly db: Database,
    private readonly sessions: Sessions,
    private readonly limiter: RateLimiter,
  ) {}
  @Post() async upload(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: perm, fresh: true });
    await this.sessions.verifyCsrf(req, ctx);
    await this.limiter.hit('site-image-upload', ctx.user.id, 20);
    const meta = await quarantineFile(req, res, true);
    return this.db.$transaction(async (tx) => {
      await assertBackofficeWrite(tx, this.sessions, ctx, perm);
      const r = await tx.courseMediaUpload.create({
        data: { id: uuidv7(), intended_use: 'website', uploaded_by: ctx.user.id, ...meta },
        select: { id: true, status: true },
      });
      await tx.auditEvent.create({
        data: {
          id: uuidv7(),
          actor_user_id: ctx.user.id,
          origin: 'user',
          action: 'cms.image_submitted',
          target_type: 'course_media_upload',
          target_ref: r.id,
        },
      });
      return r;
    });
  }
  @Get() async list(@Req() req: ApiRequest, @Query('before') before?: string) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: perm });
    const rows = await this.db.courseMediaUpload.findMany({
      where: { intended_use: 'website', ...(before ? { id: { lt: requireUuid(before) } } : {}) },
      orderBy: { id: 'desc' },
      take: 51,
      select: {
        id: true,
        uploaded_by: true,
        original_name: true,
        sha256: true,
        status: true,
        approved_at: true,
        promotion_error: true,
        promoted_asset: { select: { status: true } },
        rights_ref: true,
      },
    });
    return {
      data: rows
        .slice(0, 50)
        .map(({ uploaded_by, sha256, promoted_asset, ...r }) => ({
          ...r,
          own: uploaded_by === ctx.user.id,
          sha256: Buffer.from(sha256).toString('hex'),
          asset_status: promoted_asset?.status,
        })),
      next_cursor: rows.length > 50 ? rows[49].id : null,
    };
  }
  @Post(':id/approve') @HttpCode(200) approve(@Req() req: ApiRequest, @Param('id') id: string, @Body() input: unknown) {
    return backofficeWrite(this.db, this.sessions, req, perm, async (tx, actor) => {
      const b = bodyObject(input, ['sha256', 'rights_ref', 'public_use_confirmed']);
      if (
        b.public_use_confirmed !== true ||
        typeof b.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(b.sha256) ||
        typeof b.rights_ref !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]{2,79}$/.test(b.rights_ref)
      )
        throw apiError(422, 'RIGHTS_REQUIRED', 'Dateiabgleich und internen Rechtenachweis angeben.');
      const r = await tx.courseMediaUpload.updateMany({
        where: {
          id: requireUuid(id),
          intended_use: 'website',
          status: 'clean',
          uploaded_by: { not: actor },
          sha256: Buffer.from(b.sha256, 'hex'),
          approved_at: null,
        },
        data: { approved_at: new Date(), approved_by: actor, rights_ref: b.rights_ref },
      });
      if (!r.count) throw changed();
      await tx.auditEvent.create({
        data: {
          id: uuidv7(),
          actor_user_id: actor,
          origin: 'user',
          action: 'cms.image_approved',
          target_ref: id,
          target_type: 'course_media_upload',
        },
      });
      return { approved: true };
    });
  }
  @Post(':id/withdraw') @HttpCode(200) withdraw(
    @Req() req: ApiRequest,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return backofficeWrite(this.db, this.sessions, req, perm, async (tx, actor) => {
      bodyObject(input, []);
      const r = await tx.courseMediaUpload.findFirst({
        where: { id: requireUuid(id), intended_use: 'website' },
        select: { promoted_asset_id: true },
      });
      if (!r?.promoted_asset_id) throw changed();
      const n = await tx.mediaAsset.updateMany({
        where: { id: r.promoted_asset_id, visibility: 'public', status: 'ready' },
        data: { visibility: 'private', status: 'rejected' },
      });
      if (!n.count) throw changed();
      await tx.auditEvent.create({
        data: {
          id: uuidv7(),
          actor_user_id: actor,
          origin: 'user',
          action: 'cms.image_withdrawn',
          target_ref: id,
          target_type: 'course_media_upload',
        },
      });
      return { withdrawn: true };
    });
  }
}
