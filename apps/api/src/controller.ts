import { Controller, Get, Post, Put, Patch, Body, Req, Res, Query, Param, HttpCode } from '@nestjs/common';
import type { Response } from 'express';
import { Auth } from './auth';
import { Mfa } from './mfa';
import { Sessions, ApiRequest } from './sessions';
import { Admin } from './admin';
import { apiError } from './security';

@Controller()
export class IdentityController {
  constructor(private readonly auth: Auth, private readonly mfa: Mfa, private readonly sessions: Sessions, private readonly admin: Admin) {}
  private ip(req: ApiRequest): string { return req.ip || req.socket.remoteAddress || 'unknown'; }

  // Publication is available behind an explicit permission; commerce, learning
  // access, exams and certificates remain unavailable.
  @Get('health') health() { return { status: 'running', stage: 'phase-2-publication', commerce_enabled: false, publication_enabled: true }; }
  @Get('auth/csrf') async csrf(@Req() req: ApiRequest, @Res({passthrough:true}) res: Response) {
    return { csrf_token: await this.sessions.getCsrf(req, res) };
  }
  @Post('auth/register') @HttpCode(202)
  async register(@Req() req: ApiRequest, @Body() body: unknown) {
    await this.sessions.verifyCsrf(req); await this.auth.register(body, this.ip(req)); return { status: 'accepted' };
  }
  @Post('auth/activation/request') @HttpCode(202)
  async requestActivation(@Req() req: ApiRequest, @Body() body: unknown) {
    await this.sessions.verifyCsrf(req); await this.auth.requestToken(body, this.ip(req), 'activation'); return { status: 'accepted' };
  }
  @Post('auth/activate') @HttpCode(204)
  async activate(@Req() req: ApiRequest, @Body() body: unknown) {
    await this.sessions.verifyCsrf(req); await this.auth.activate(body, this.ip(req));
  }
  @Post('auth/login')
  async login(@Req() req: ApiRequest, @Res({passthrough:true}) res: Response, @Body() body: unknown) {
    await this.sessions.verifyCsrf(req); const status = await this.auth.login(body, this.ip(req), req, res);
    res.status(status === 'authenticated' ? 200 : 202); return { status };
  }
  @Post('auth/mfa/enrollment/start') @HttpCode(200)
  async mfaStart(@Req() req: ApiRequest) {
    const ctx = await this.sessions.requirePreauth(req); await this.sessions.verifyCsrf(req, ctx);
    return this.mfa.start(ctx, this.ip(req));
  }
  @Post('auth/mfa/enrollment/confirm') @HttpCode(200)
  async mfaConfirm(@Req() req: ApiRequest, @Res({passthrough:true}) res: Response, @Body() body: unknown) {
    const ctx = await this.sessions.requirePreauth(req); await this.sessions.verifyCsrf(req, ctx);
    return this.mfa.confirm(req, res, ctx, body, this.ip(req));
  }
  @Post('auth/mfa/challenge') @HttpCode(200)
  async mfaChallenge(@Req() req: ApiRequest, @Res({passthrough:true}) res: Response, @Body() body: unknown) {
    const ctx = await this.sessions.requirePreauth(req); await this.sessions.verifyCsrf(req, ctx);
    return this.mfa.challenge(req, res, ctx, body, this.ip(req));
  }
  @Post('auth/reauth') @HttpCode(204)
  async reauth(@Req() req: ApiRequest, @Body() body: unknown) {
    const ctx = await this.sessions.require(req); await this.sessions.verifyCsrf(req, ctx); await this.auth.reauthenticate(ctx, body, this.ip(req));
  }
  @Post('auth/logout') @HttpCode(204)
  async logout(@Req() req: ApiRequest, @Res({passthrough:true}) res: Response) {
    const ctx = await this.sessions.read(req); if (!ctx) throw apiError(401, 'UNAUTHENTICATED', 'Bitte melde dich an.');
    await this.sessions.verifyCsrf(req, ctx); await this.sessions.logout(req, res, ctx);
  }
  @Post('auth/password-reset/request') @HttpCode(202)
  async requestReset(@Req() req: ApiRequest, @Body() body: unknown) {
    await this.sessions.verifyCsrf(req); await this.auth.requestToken(body, this.ip(req), 'password_reset'); return { status: 'accepted' };
  }
  @Post('auth/password-reset/confirm') @HttpCode(204)
  async reset(@Req() req: ApiRequest, @Body() body: unknown) {
    await this.sessions.verifyCsrf(req); await this.auth.resetPassword(body, this.ip(req));
  }
  @Post('auth/email-change/confirm') @HttpCode(204)
  async confirmEmail(@Req() req: ApiRequest, @Body() body: unknown) {
    await this.sessions.verifyCsrf(req); await this.auth.confirmEmailChange(body, this.ip(req));
  }
  @Get('me') async me(@Req() req: ApiRequest) { return this.auth.profile(await this.sessions.require(req)); }
  @Patch('me') async updateMe(@Req() req: ApiRequest, @Body() body: unknown) {
    const ctx = await this.sessions.require(req); await this.sessions.verifyCsrf(req, ctx); return this.auth.updateProfile(ctx, body);
  }
  @Put('me/password') @HttpCode(204)
  async changePassword(@Req() req: ApiRequest, @Body() body: unknown) {
    const ctx = await this.sessions.require(req); await this.sessions.verifyCsrf(req, ctx); await this.auth.changePassword(ctx, body, this.ip(req));
  }
  @Post('me/email-change/request') @HttpCode(202)
  async changeEmail(@Req() req: ApiRequest, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { fresh:true }); await this.sessions.verifyCsrf(req, ctx);
    await this.auth.requestEmailChange(ctx, body, this.ip(req)); return { status:'accepted' };
  }
  @Get('admin/users') async users(@Req() req: ApiRequest, @Query('limit') limit: unknown, @Query('cursor') cursor: unknown) {
    await this.sessions.require(req, { backoffice:true, permission:'users.read' }); return this.admin.listUsers(limit, cursor);
  }
  @Put('admin/users/:id/roles') async roles(@Req() req: ApiRequest, @Param('id') id: string, @Body() body: unknown) {
    const ctx = await this.sessions.require(req, { backoffice:true, permission:'roles.manage', fresh:true });
    await this.sessions.verifyCsrf(req, ctx); return this.admin.changeRoles(ctx, id, body);
  }
}
