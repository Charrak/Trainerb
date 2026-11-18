import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Shop } from './shop';
import { Learning, Accesses } from './learning';
import { Commerce } from './commerce';
import { StripePayments } from './stripe';
import { GuestCheckout } from './guest';
import { RateLimiter } from './limiter';
import { Invoices } from './invoices';
import { Refunds } from './refunds';
import { Disputes } from './disputes';
import { Withdrawals, DECISION_REASONS } from './withdrawals';
import { pdfResponse } from './invoice-response';
import { Sessions, type ApiRequest } from './sessions';
import { apiError, requireUuid } from './security';
import { getConfig } from './config';

// Public commerce is deliberately small: configuration, sellable products and
// the buyer's own cart/orders. Nothing here exposes an admin view.
@Controller()
export class ShopController {
  constructor(private readonly shop: Shop, private readonly learning: Learning, private readonly accesses: Accesses,
              private readonly commerce: Commerce, private readonly stripe: StripePayments,
              private readonly sessions: Sessions, private readonly limiter: RateLimiter,
              private readonly invoices: Invoices, private readonly refunds: Refunds,
              private readonly disputes: Disputes, private readonly withdrawals: Withdrawals) {}
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
  @Get('credit-notes') @Header('Cache-Control', 'no-store') async myCreditNotes(@Req() req: ApiRequest) {
    return this.refunds.listMine(await this.sessions.require(req));
  }
  @Get('credit-notes/:id/pdf') @Header('Cache-Control', 'no-store')
  async creditNotePdf(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response, @Param('id') id: string) {
    return pdfResponse(res, await this.refunds.download(await this.sessions.require(req), id));
  }
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
  @Get('me/courses/:slug/chapters/:chapterId/media/:contentId')
  async media(@Req() req: ApiRequest, @Res() res: Response, @Param('slug') slug: string,
    @Param('chapterId') chapterId: string, @Param('contentId') contentId: string) {
    const ctx = await this.sessions.require(req);
    res.status(302).set('Location', await this.learning.mediaLink(ctx, slug, chapterId, contentId)).end();
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
              private readonly invoices: Invoices, private readonly refunds: Refunds,
              private readonly disputes: Disputes, private readonly withdrawals: Withdrawals) {}

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
  @Get('admin/commerce/tax-rates')
  async taxRates(@Req() req: ApiRequest) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'settings.manage' });
    void ctx; return this.commerce.taxRates();
  }
  @Post('admin/commerce/tax-rates') @HttpCode(201)
  async createTaxRate(@Req() req: ApiRequest, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'settings.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.commerce.createTaxRate(ctx, body);
  }
  @Post('admin/commerce/tax-rates/:id/close') @HttpCode(200)
  async closeTaxRate(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'settings.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.commerce.closeTaxRate(ctx, id, body);
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

  // ---- Erstattungen -------------------------------------------------------
  // Money going back is its own permission (`refunds.manage`), so support can
  // read orders without being able to move money.
  @Get('admin/refunds') async listRefunds(@Req() req: ApiRequest, @Query('status') status: unknown,
    @Query('limit') limit: unknown, @Query('cursor') cursor: unknown) {
    // Support may see proposals; the order view is guarded by `orders.read`.
    const ctx = await this.sessions.require(req, { backoffice: true });
    if (!ctx.permissionKeys.has('refunds.manage') && !ctx.permissionKeys.has('refunds.propose')) {
      throw apiError(403, 'FORBIDDEN', 'Kein Zugriff.');
    }
    return this.refunds.list(status, limit, cursor);
  }
  /** Support may propose; a proposal moves no money. */
  @Post('admin/orders/:id/refund-proposals') @HttpCode(201)
  async proposeRefund(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'refunds.propose' });
    await this.sessions.verifyCsrf(req, ctx); return this.refunds.propose(ctx, id, body, false);
  }
  /** Executing a refund moves money: own permission plus a fresh second factor. */
  @Post('admin/orders/:id/refunds') @HttpCode(201)
  async executeRefund(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'refunds.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.refunds.propose(ctx, id, body, true);
  }
  @Get('admin/refunds/:id') async refund(@Req() req: ApiRequest, @Param('id') id: string) {
    const ctx = await this.sessions.require(req, { backoffice: true });
    if (!ctx.permissionKeys.has('refunds.manage') && !ctx.permissionKeys.has('refunds.propose')) {
      throw apiError(403, 'FORBIDDEN', 'Kein Zugriff.');
    }
    return this.refunds.view(this.shop.client, requireUuid(id));
  }
  @Post('admin/refunds/:id/confirm') @HttpCode(200)
  async confirmRefund(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'refunds.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.refunds.confirm(ctx, id, body);
  }
  @Post('admin/refunds/:id/fail') @HttpCode(200)
  async failRefund(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'refunds.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.refunds.fail(ctx, id, body);
  }
  /** Does the learner keep the course after the refund? Always an explicit answer. */
  @Post('admin/refunds/:id/access-decision') @HttpCode(200)
  async decideAccess(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'access.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.refunds.decideAccess(ctx, id, body);
  }
  // ---- Streitfälle (Rückbuchungen) ---------------------------------------
  // A chargeback is reported by the provider; staff may record a case that was
  // announced by mail, but the state changes are the same ones a webhook makes.
  @Get('admin/disputes') async listDisputes(@Req() req: ApiRequest, @Query('status') status: unknown,
    @Query('limit') limit: unknown, @Query('cursor') cursor: unknown) {
    await this.sessions.require(req, { backoffice: true, permission: 'refunds.manage' });
    return this.disputes.list(status, limit, cursor);
  }
  @Get('admin/disputes/:id') async dispute(@Req() req: ApiRequest, @Param('id') id: string) {
    await this.sessions.require(req, { backoffice: true, permission: 'refunds.manage' });
    return this.disputes.view(this.shop.client, requireUuid(id));
  }
  @Post('admin/orders/:id/disputes') @HttpCode(201) @Header('Cache-Control', 'no-store')
  async recordDispute(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response,
                      @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'refunds.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx);
    const meta = { created: false };
    const result = await this.disputes.record(ctx, id, body, {}, meta);
    // Recording the same provider case again is an update, and says so.
    if (!meta.created) res.status(200);
    return result;
  }
  /** The bank's outcome never revokes access by itself — a human decides. */
  @Post('admin/disputes/:id/access-decision') @HttpCode(200)
  async decideDisputeAccess(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'access.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.disputes.decideAccess(ctx, id, body);
  }

  // ---- Widerrufsvorgänge -------------------------------------------------
  /**
   * The decision vocabulary the back office offers, taken from the same table the
   * API validates against — so the drop-down and the validator cannot drift.
   */
  @Get('admin/withdrawal-requests/decision-reasons') async withdrawalReasons(@Req() req: ApiRequest) {
    await this.sessions.require(req, { backoffice: true, permission: 'withdrawals.manage' });
    return { data: Object.entries(DECISION_REASONS).map(([code, label]) => ({ code, label,
      closes_without_order: ['order_not_found', 'identity_unconfirmed', 'duplicate_request'].includes(code) })) };
  }

  @Get('admin/withdrawal-requests') async listWithdrawals(@Req() req: ApiRequest, @Query('status') status: unknown,
    @Query('limit') limit: unknown, @Query('cursor') cursor: unknown) {
    await this.sessions.require(req, { backoffice: true, permission: 'withdrawals.manage' });
    return this.withdrawals.list(status, limit, cursor);
  }
  @Get('admin/withdrawal-requests/:id') async withdrawal(@Req() req: ApiRequest, @Param('id') id: string) {
    await this.sessions.require(req, { backoffice: true, permission: 'withdrawals.manage' });
    return this.withdrawals.view(requireUuid(id));
  }
  /** Sends the one-time proof link to the address the sender entered. */
  @Post('admin/withdrawal-requests/:id/identity-code') @HttpCode(201)
  async withdrawalIdentityCode(@Req() req: ApiRequest, @Param('id') id: string) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'withdrawals.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.withdrawals.sendIdentityCode(ctx, id);
  }
  @Post('admin/withdrawal-requests/:id') @HttpCode(200)
  async updateWithdrawal(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice: true, permission: 'withdrawals.manage', fresh: true });
    await this.sessions.verifyCsrf(req, ctx); return this.withdrawals.update(ctx, id, body);
  }

  @Get('admin/credit-notes/:id/pdf') @Header('Cache-Control', 'no-store')
  async creditNotePdf(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response, @Param('id') id: string) {
    await this.sessions.require(req, { backoffice: true, permission: 'orders.read' });
    return pdfResponse(res, await this.refunds.downloadForStaff(id));
  }
}

export const stripeWebhookUrl = () => `${getConfig().publicBaseUrl}/api/v1/payments/stripe/webhook`;
