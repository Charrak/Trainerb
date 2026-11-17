import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Shop } from './shop';
import { Learning, Accesses } from './learning';
import { Commerce } from './commerce';
import { StripePayments } from './stripe';
import { GuestCheckout } from './guest';
import { RateLimiter } from './limiter';
import { Invoices } from './invoices';
import { pdfResponse } from './invoice-response';
import { Sessions, type ApiRequest } from './sessions';
import { apiError } from './security';
import { getConfig } from './config';

// Public commerce is deliberately small: configuration, sellable products and
// the buyer's own cart/orders. Nothing here exposes an admin view.
@Controller()
export class ShopController {
  constructor(private readonly shop: Shop, private readonly learning: Learning, private readonly accesses: Accesses,
              private readonly commerce: Commerce, private readonly stripe: StripePayments,
              private readonly sessions: Sessions, private readonly limiter: RateLimiter,
              private readonly invoices: Invoices) {}
  private ip(req: ApiRequest): string { return req.ip || req.socket.remoteAddress || 'unknown'; }

  @Get('shop/config') async config() { return this.commerce.publicConfig(); }
  @Get('shop/products') async products(@Req() req: ApiRequest) {
    await this.limiter.hit('shop-products-ip', this.ip(req), 180, 60_000);
    return this.shop.publicProducts();
  }
  @Get('shop/products/:id') async product(@Req() req: ApiRequest, @Param('id') id: string) {
    await this.limiter.hit('shop-product-ip', this.ip(req), 180, 60_000);
    return this.shop.publicProduct(id);
  }

  @Get('cart') async cart(@Req() req: ApiRequest) {
    const ctx = await this.sessions.require(req);
    return this.shop.getCart(ctx);
  }
  @Post('cart/items') @HttpCode(200) async add(@Req() req: ApiRequest, @Body() body: unknown) {
    const ctx = await this.sessions.require(req);
    await this.sessions.verifyCsrf(req, ctx); return this.shop.addToCart(ctx, body);
  }
  @Delete('cart/items/:productId') async remove(@Req() req: ApiRequest, @Param('productId') productId: string) {
    const ctx = await this.sessions.require(req);
    await this.sessions.verifyCsrf(req, ctx); return this.shop.removeFromCart(ctx, productId);
  }
  @Delete('cart') async clear(@Req() req: ApiRequest) {
    const ctx = await this.sessions.require(req);
    await this.sessions.verifyCsrf(req, ctx); return this.shop.clearCart(ctx);
  }
  @Post('cart/coupon') @HttpCode(200) async coupon(@Req() req: ApiRequest, @Body() body: unknown) {
    const ctx = await this.sessions.require(req);
    await this.sessions.verifyCsrf(req, ctx); return this.shop.cartWithCoupon(ctx, body);
  }

  @Post('orders') @HttpCode(201) async checkout(@Req() req: ApiRequest, @Body() body: unknown) {
    const ctx = await this.sessions.require(req);
    await this.sessions.verifyCsrf(req, ctx);
    await this.limiter.hit('checkout-user', ctx.user.id, 20, 60 * 60_000);
    return this.shop.checkout(ctx, body, { ip: this.ip(req), userAgent: req.get('user-agent') || 'unknown' });
  }
  @Get('orders') async orders(@Req() req: ApiRequest, @Query('limit') limit: unknown, @Query('cursor') cursor: unknown) {
    const ctx = await this.sessions.require(req);
    return this.shop.listOrders(ctx, limit, cursor);
  }
  @Get('orders/:id') async order(@Req() req: ApiRequest, @Param('id') id: string) {
    const ctx = await this.sessions.require(req);
    return this.shop.orderDetail(ctx, id);
  }
  /** The account's invoice list; the document itself is one link per row. */
  @Get('invoices') @Header('Cache-Control', 'no-store') async myInvoices(@Req() req: ApiRequest) {
    const ctx = await this.sessions.require(req);
    return this.invoices.listMine(ctx);
  }

  /**
   * Invoice download for the buyer. Wrong owner, unknown id and a guest invoice
   * all produce the same `404` — the answer never reveals that an invoice exists.
   */
  @Get('invoices/:id/pdf') @Header('Cache-Control', 'no-store')
  async invoicePdf(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response, @Param('id') id: string) {
    const ctx = await this.sessions.require(req);
    return pdfResponse(res, await this.invoices.download(ctx, id));
  }

  @Post('orders/:id/pay') @HttpCode(200) async pay(@Req() req: ApiRequest, @Param('id') id: string) {
    const ctx = await this.sessions.require(req);
    await this.sessions.verifyCsrf(req, ctx);
    const order = await this.shop.orderDetail(ctx, id);
    if (order.payment_method !== 'stripe') throw apiError(409, 'WRONG_PAYMENT_METHOD', 'Diese Bestellung ist nicht für Kartenzahlung vorgesehen.');
    if (!ctx.user.email_original) throw apiError(409, 'ACCOUNT_INCOMPLETE', 'Für die Zahlung fehlt eine bestätigte E-Mail-Adresse.');
    return this.stripe.startSession(order.id, ctx.user.email_original);
  }

  // Signature-verified provider callback. It is intentionally unauthenticated
  // (Stripe cannot hold a session) and therefore verifies the signature first.
  @Post('payments/stripe/webhook') @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async webhook(@Req() req: ApiRequest) {
    return this.stripe.handleWebhook((req as ApiRequest & { rawBody?: Buffer }).rawBody, req.get('stripe-signature'));
  }

  @Get('me/courses') async myCourses(@Req() req: ApiRequest) {
    const ctx = await this.sessions.require(req);
    return this.learning.myCourses(ctx);
  }
  @Get('me/courses/:slug') async myCourse(@Req() req: ApiRequest, @Param('slug') slug: string) {
    const ctx = await this.sessions.require(req);
    return this.learning.course(ctx, slug);
  }
  @Get('me/courses/:slug/chapters/:chapterId') async chapter(@Req() req: ApiRequest, @Param('slug') slug: string,
    @Param('chapterId') chapterId: string) {
    const ctx = await this.sessions.require(req);
    return this.learning.chapter(ctx, slug, chapterId);
  }
  @Post('me/courses/:slug/chapters/:chapterId/complete') @HttpCode(200)
  async complete(@Req() req: ApiRequest, @Param('slug') slug: string, @Param('chapterId') chapterId: string) {
    const ctx = await this.sessions.require(req);
    await this.sessions.verifyCsrf(req, ctx); return this.learning.complete(ctx, slug, chapterId);
  }
}

// Back-office commerce: orders, payments, settings, legal texts, coupons and
// manual access. Every route needs a global permission and a backoffice session.
@Controller()
export class CommerceAdminController {
  constructor(private readonly shop: Shop, private readonly commerce: Commerce, private readonly accesses: Accesses,
              private readonly sessions: Sessions, private readonly guest: GuestCheckout,
              private readonly invoices: Invoices) {}

  @Get('admin/orders') async orders(@Req() req: ApiRequest, @Query('state') state: unknown,
    @Query('limit') limit: unknown, @Query('cursor') cursor: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'orders.read' });
    return this.shop.adminOrders(ctx, state, limit, cursor);
  }
  @Get('admin/orders/:id') async order(@Req() req: ApiRequest, @Param('id') id: string) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'orders.read' });
    return this.shop.orderDetail(ctx, id);
  }
  /** Support download: staff with `orders.read` may fetch any invoice document. */
  @Get('admin/invoices/:id/pdf') @Header('Cache-Control', 'no-store')
  async invoicePdf(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response, @Param('id') id: string) {
    await this.sessions.require(req, { backoffice: true, permission: 'orders.read' });
    return pdfResponse(res, await this.invoices.downloadForStaff(id));
  }

  @Post('admin/orders/:id/confirm-payment') @HttpCode(200)
  async confirm(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'orders.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.shop.confirmPayment(ctx, id, body);
  }
  @Post('admin/orders/:id/cancel') @HttpCode(200)
  async cancel(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'orders.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.shop.cancelOrder(ctx, id, body);
  }
  /** Resolve a paid guest order whose address belongs to a blocked account. */
  @Post('admin/orders/:id/resolve-link') @HttpCode(200)
  async resolveLink(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'orders.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.guest.resolveUnlinked(ctx, id, body);
  }
  @Get('admin/commerce') async commerceState(@Req() req: ApiRequest) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'settings.manage' });
    return this.commerce.adminState(ctx);
  }
  @Post('admin/commerce/settings') @HttpCode(200)
  async settings(@Req() req: ApiRequest, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'settings.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.commerce.updateSettings(ctx, body);
  }
  @Post('admin/commerce/legal') @HttpCode(201)
  async legal(@Req() req: ApiRequest, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'legal.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.commerce.createLegalVersion(ctx, body);
  }
  @Post('admin/commerce/legal/:id/activate') @HttpCode(200)
  async activateLegal(@Req() req: ApiRequest, @Param('id') id: string) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'legal.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.commerce.activateLegalVersion(ctx, id);
  }
  @Get('admin/coupons') async coupons(@Req() req: ApiRequest) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'coupons.manage' });
    return this.commerce.listCoupons(ctx);
  }
  @Post('admin/coupons') @HttpCode(201)
  async createCoupon(@Req() req: ApiRequest, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'coupons.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.commerce.createCoupon(ctx, body);
  }
  @Post('admin/coupons/:id/active') @HttpCode(200)
  async updateCoupon(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'coupons.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.commerce.updateCoupon(ctx, id, body);
  }
  @Post('admin/accesses') @HttpCode(201)
  async grant(@Req() req: ApiRequest, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'access.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.accesses.grant(ctx, body);
  }
  @Post('admin/accesses/:id/revoke') @HttpCode(200)
  async revoke(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'access.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.accesses.revoke(ctx, id, body);
  }
}

export const stripeWebhookUrl = () => `${getConfig().publicBaseUrl}/api/v1/payments/stripe/webhook`;
