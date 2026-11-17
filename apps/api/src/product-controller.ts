import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Products } from './products';
import { RateLimiter } from './limiter';
import { Sessions, type ApiRequest } from './sessions';

// Every route is back-office only. There is deliberately no public product or
// price route, no activation route and no checkout route.
@Controller()
export class ProductController {
  constructor(private readonly products: Products, private readonly sessions: Sessions, private readonly limiter: RateLimiter) {}
  private ip(req: ApiRequest): string { return req.ip || req.socket.remoteAddress || 'unknown'; }

  @Get('admin/products') async list(@Req() req: ApiRequest, @Query('limit') limit: unknown, @Query('cursor') cursor: unknown) {
    await this.limiter.hit('admin-products-ip', this.ip(req), 240, 60_000);
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'products.manage' });
    return this.products.list(ctx, limit, cursor);
  }
  @Get('admin/products/:id') async detail(@Req() req: ApiRequest, @Param('id') id: string) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'products.manage' });
    return this.products.detail(ctx, id);
  }
  @Post('admin/products') async create(@Req() req: ApiRequest, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'products.manage' });
    await this.sessions.verifyCsrf(req, ctx); return this.products.create(ctx, body);
  }
  @Patch('admin/products/:id') async update(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'products.manage' });
    await this.sessions.verifyCsrf(req, ctx); return this.products.update(ctx, id, body);
  }
  @Delete('admin/products/:id') @HttpCode(204)
  async remove(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'products.manage' });
    await this.sessions.verifyCsrf(req, ctx); return this.products.remove(ctx, id, body);
  }
  @Post('admin/products/:id/prices') async addPrice(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'prices.manage' });
    await this.sessions.verifyCsrf(req, ctx); return this.products.addPrice(ctx, id, body);
  }
  @Patch('admin/prices/:id') async updatePrice(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'prices.manage' });
    await this.sessions.verifyCsrf(req, ctx); return this.products.updatePrice(ctx, id, body);
  }
  @Delete('admin/prices/:id') @HttpCode(204)
  async removePrice(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'prices.manage' });
    await this.sessions.verifyCsrf(req, ctx); return this.products.removePrice(ctx, id, body);
  }
}
