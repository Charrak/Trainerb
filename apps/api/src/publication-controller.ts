import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { Publication } from './publication';
import { Sessions, type ApiRequest } from './sessions';

// Release actions are separate from draft editing: they need their own global
// permission and a fresh second-factor confirmation. They return 200 (201 is
// reserved for creating draft resources).
@Controller()
export class PublicationController {
  constructor(private readonly publication: Publication, private readonly sessions: Sessions) {}

  @Get('admin/courses/:id/publication') async courseState(@Req() req: ApiRequest, @Param('id') id: string) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'courses.publish' });
    return this.publication.courseState(ctx, id);
  }
  @HttpCode(200)
  @Post('admin/courses/:id/publish') async publish(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'courses.publish', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.publication.publishCourse(ctx, id, body);
  }
  @HttpCode(200)
  @Post('admin/courses/:id/unpublish') async unpublish(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'courses.publish', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.publication.unpublishCourse(ctx, id, body);
  }
  @Post('admin/courses/:id/versions') async newVersion(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'courses.publish', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.publication.newDraftVersion(ctx, id, body);
  }
  @Get('admin/products/:id/activation') async productState(@Req() req: ApiRequest, @Param('id') id: string) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'products.manage' });
    return this.publication.productState(ctx, id);
  }
  @HttpCode(200)
  @Post('admin/products/:id/activate') async activate(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'products.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.publication.activateProduct(ctx, id, body);
  }
  @HttpCode(200)
  @Post('admin/products/:id/deactivate') async deactivate(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'products.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.publication.deactivateProduct(ctx, id, body);
  }
  @HttpCode(200)
  @Post('admin/prices/:id/activate') async activatePrice(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'prices.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.publication.activatePrice(ctx, id, body);
  }
  @HttpCode(200)
  @Post('admin/prices/:id/retire') async retirePrice(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'prices.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.publication.retirePrice(ctx, id, body);
  }
}
