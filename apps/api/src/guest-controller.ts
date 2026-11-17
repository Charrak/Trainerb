import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { GuestCheckout } from './guest';
import { Shop } from './shop';
import { Sessions, type ApiRequest } from './sessions';
import { RateLimiter } from './limiter';
import { Outbox } from './outbox';
import { Database } from './database';

/**
 * Guest checkout routes.
 *
 * These are deliberately separate from the account cart: a guest proves control
 * of the cart through a `__Host-` cookie and of the address through a single-use
 * e-mail token. All state-changing calls still require the CSRF token and a
 * matching origin, exactly like the rest of the API.
 */
@Controller()
export class GuestController {
  constructor(private readonly guest: GuestCheckout, private readonly shop: Shop, private readonly sessions: Sessions,
              private readonly limiter: RateLimiter, private readonly outbox: Outbox,
              private readonly db: Database) {}
  private ip(req: ApiRequest): string { return req.ip || req.socket.remoteAddress || 'unknown'; }

  @Get('guest/cart') @Header('Cache-Control', 'no-store')
  async cart(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    // Reading is safe and idempotent: only the browser's own cart cookie decides
    // what is returned, so no CSRF token is needed here.
    return this.guest.getCart(req, res);
  }

  @Post('guest/cart/items') @HttpCode(200) @Header('Cache-Control', 'no-store')
  async add(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    await this.sessions.verifyCsrf(req);
    return this.guest.addItem(req, res, body);
  }

  @Delete('guest/cart/items/:productId') @Header('Cache-Control', 'no-store')
  async remove(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response, @Param('productId') productId: string) {
    await this.sessions.verifyCsrf(req);
    return this.guest.removeItem(req, res, productId);
  }

  @Get('guest/email') @Header('Cache-Control', 'no-store')
  async proofStatus(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    return this.guest.proofStatus(req, res);
  }

  @Post('guest/email/verify/request') @HttpCode(202) @Header('Cache-Control', 'no-store')
  async requestProof(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    await this.sessions.verifyCsrf(req);
    await this.limiter.hit('guest-proof-ip', this.ip(req), 10, 60 * 60_000);
    return this.guest.requestProof(req, res, body, this.ip(req));
  }

  @Post('guest/email/verify/confirm') @HttpCode(200) @Header('Cache-Control', 'no-store')
  async confirmProof(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    await this.sessions.verifyCsrf(req);
    await this.limiter.hit('guest-proof-confirm-ip', this.ip(req), 30, 60 * 60_000);
    return this.guest.confirmProof(req, res, body);
  }

  @Post('guest/orders') @HttpCode(201) @Header('Cache-Control', 'no-store')
  async checkout(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    await this.sessions.verifyCsrf(req);
    await this.limiter.hit('guest-checkout-ip', this.ip(req), 10, 60 * 60_000);
    return this.guest.checkout(req, res, body, { ip: this.ip(req), userAgent: req.get('user-agent') || 'unknown' });
  }

  @Get('guest/orders/:id') @Header('Cache-Control', 'no-store')
  async order(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response, @Param('id') id: string) {
    return this.guest.myOrder(req, res, id);
  }

  /**
   * A guest order that was paid and linked to a brand-new account is claimed
   * from the logged-in session. The address on the order must match the account,
   * so a guessed order id never transfers anything.
   */
  @Post('orders/:id/claim') @HttpCode(200)
  async claim(@Req() req: ApiRequest, @Param('id') id: string) {
    const ctx = await this.sessions.require(req);
    await this.sessions.verifyCsrf(req, ctx);
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.user.id}::uuid FOR UPDATE`;
      await this.guest.claimOrder(tx, ctx.user.id, id, this.outbox);
    });
    return this.shop.orderDetail(ctx, id);
  }
}
