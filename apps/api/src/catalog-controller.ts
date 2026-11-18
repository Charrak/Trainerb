import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { quarantineFile } from './quarantine';
import { Catalog } from './catalog';
import { RateLimiter } from './limiter';
import { Sessions, type ApiRequest } from './sessions';

@Controller()
export class CatalogController {
  constructor(private readonly catalog: Catalog, private readonly sessions: Sessions, private readonly limiter: RateLimiter) {}
  private ip(req: ApiRequest): string { return req.ip || req.socket.remoteAddress || 'unknown'; }

  @Get('courses') async publicCourses(@Req() req: ApiRequest, @Query('limit') limit: unknown, @Query('cursor') cursor: unknown) {
    await this.limiter.hit('public-courses-ip', this.ip(req), 180, 60_000);
    return this.catalog.publicCourses(limit, cursor);
  }
  @Get('courses/:slug') async publicCourse(@Req() req: ApiRequest, @Param('slug') slug: string) {
    await this.limiter.hit('public-course-ip', this.ip(req), 180, 60_000);
    return this.catalog.publicCourse(slug);
  }
  @Get('admin/courses') async list(@Req() req: ApiRequest, @Query('limit') limit: unknown, @Query('cursor') cursor: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'courses.read' });
    return this.catalog.list(ctx, limit, cursor);
  }
  @Get('admin/courses/:id') async detail(@Req() req: ApiRequest, @Param('id') id: string) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'courses.read' });
    return this.catalog.detail(ctx, id);
  }
  @Post('admin/courses/:id/media/uploads') async upload(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response, @Param('id') id: string) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'media.upload' });
    await this.sessions.verifyCsrf(req, ctx);
    await this.limiter.hit('media-upload', ctx.user.id, 20, 15 * 60_000);
    return this.catalog.quarantineUpload(ctx, id, () => quarantineFile(req, res));
  }
  @Post('admin/courses') async create(@Req() req: ApiRequest, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'courses.create' });
    await this.sessions.verifyCsrf(req, ctx); return this.catalog.create(ctx, body);
  }
  @Patch('admin/course-versions/:id') async updateVersion(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'courses.edit' });
    await this.sessions.verifyCsrf(req, ctx); return this.catalog.updateVersion(ctx, id, body);
  }
  @Post('admin/course-versions/:id/modules') async addModule(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'courses.edit' });
    await this.sessions.verifyCsrf(req, ctx); return this.catalog.addModule(ctx, id, body);
  }
  @Patch('admin/course-modules/:id') async updateModule(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'courses.edit' });
    await this.sessions.verifyCsrf(req, ctx); return this.catalog.updateModule(ctx, id, body);
  }
  @Delete('admin/course-modules/:id') @HttpCode(204)
  async deleteModule(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'courses.edit' });
    await this.sessions.verifyCsrf(req, ctx); return this.catalog.deleteModule(ctx, id, body);
  }
  @Post('admin/course-modules/:id/chapters') async addChapter(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'courses.edit' });
    await this.sessions.verifyCsrf(req, ctx); return this.catalog.addChapter(ctx, id, body);
  }
  @Patch('admin/course-chapters/:id') async updateChapter(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'courses.edit' });
    await this.sessions.verifyCsrf(req, ctx); return this.catalog.updateChapter(ctx, id, body);
  }
  @Delete('admin/course-chapters/:id') @HttpCode(204)
  async deleteChapter(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'courses.edit' });
    await this.sessions.verifyCsrf(req, ctx); return this.catalog.deleteChapter(ctx, id, body);
  }
  @Get('admin/course-chapters/:id/contents') async listContents(@Req() req: ApiRequest, @Param('id') id: string,
    @Query('limit') limit: unknown, @Query('cursor') cursor: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'courses.read' });
    return this.catalog.listContents(ctx, id, limit, cursor);
  }
  @Post('admin/course-chapters/:id/contents') async addContent(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'courses.edit' });
    await this.sessions.verifyCsrf(req, ctx); return this.catalog.addContent(ctx, id, body);
  }
  @Patch('admin/chapter-contents/:id') async updateContent(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'courses.edit' });
    await this.sessions.verifyCsrf(req, ctx); return this.catalog.updateContent(ctx, id, body);
  }
  @Delete('admin/chapter-contents/:id') @HttpCode(204)
  async deleteContent(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'courses.edit' });
    await this.sessions.verifyCsrf(req, ctx); return this.catalog.deleteContent(ctx, id, body);
  }
  @Put('admin/courses/:id/staff') async assign(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'courses.create', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.catalog.assign(ctx, id, body);
  }
  @Delete('admin/courses/:id/staff/:userId/:scope') @HttpCode(204)
  async unassign(@Req() req: ApiRequest, @Param('id') id: string, @Param('userId') userId: string, @Param('scope') scope: string) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'courses.create', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.catalog.unassign(ctx, id, userId, scope);
  }
}
