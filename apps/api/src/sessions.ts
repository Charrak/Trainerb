import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CookieOptions, Request, Response } from 'express';
import { uuidv7 } from 'uuidv7';
import { BACKOFFICE_ROLES } from '@trainerb/contracts';
import { Database } from './database';
import { getConfig } from './config';
import { apiError, keyedHash, randomToken, safeEqual } from './security';

const SESSION_COOKIE = '__Host-session';
const CSRF_COOKIE = '__Host-csrf';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const userInclude = { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } } satisfies Prisma.UserInclude;
const idleDuration = (kind: string) => kind === 'backoffice' ? 30 * MINUTE : kind === 'preauth' ? 5 * MINUTE : DAY;
export type SessionContext = {
  session: Prisma.AuthSessionGetPayload<Record<string, never>>;
  user: Prisma.UserGetPayload<{ include: typeof userInclude }>;
  roleKeys: string[];
  permissionKeys: Set<string>;
};
export type ApiRequest = Request & { requestId?: string };

@Injectable()
export class Sessions {
  constructor(private readonly db: Database) {}
  private sessionHash(token: string): Buffer<ArrayBuffer> { return keyedHash(getConfig().sessionKey, 'session', token); }
  private csrfHash(token: string): Buffer<ArrayBuffer> { return keyedHash(getConfig().csrfKey, 'session-csrf', token); }
  private options(httpOnly: boolean, maxAge?: number): CookieOptions {
    const preview = getConfig().embeddedPreviewCookies;
    return { httpOnly, secure: true, sameSite: preview ? 'none' : 'lax', path: '/',
      ...(preview ? { partitioned: true } : {}), ...(maxAge ? { maxAge } : {}) };
  }
  private getCookie(req: ApiRequest, name: string): string | undefined {
    const value = req.cookies?.[name];
    return typeof value === 'string' && value.length <= 512 ? value : undefined;
  }
  async read(req: ApiRequest): Promise<SessionContext | null> {
    const raw = this.getCookie(req, SESSION_COOKIE);
    if (!raw) return null;
    const found = await this.db.authSession.findUnique({
      where: { token_hash: this.sessionHash(raw) },
      include: { user: { include: userInclude } },
    });
    if (!found || found.revoked_at || found.user.status !== 'active') return null;
    const now = Date.now();
    if (found.expires_at.getTime() <= now || found.last_seen_at.getTime() + idleDuration(found.kind) <= now) return null;
    const roleKeys = found.user.roles.map(x => x.role.key);
    const privileged = roleKeys.some(role => (BACKOFFICE_ROLES as readonly string[]).includes(role));
    if ((found.kind === 'participant' && privileged) || (found.kind === 'preauth' && !privileged) ||
        (found.kind === 'backoffice' && (!privileged || !found.mfa_verified_at))) return null;
    if (now - found.last_seen_at.getTime() >= MINUTE) {
      const touched = await this.db.authSession.updateMany({ where: { id: found.id, revoked_at: null,
        expires_at: { gt: new Date(now) } }, data: { last_seen_at: new Date(now) } });
      if (!touched.count) return null;
    }
    const permissionKeys = new Set(found.user.roles.flatMap(x => x.role.permissions.map(y => y.permission.key)));
    return { session: found, user: found.user, roleKeys, permissionKeys };
  }
  async require(req: ApiRequest, options: { backoffice?: boolean; permission?: string; fresh?: boolean } = {}): Promise<SessionContext> {
    const ctx = await this.read(req);
    if (!ctx) throw apiError(401, 'UNAUTHENTICATED', 'Bitte melde dich an.');
    if (ctx.session.kind === 'preauth') throw apiError(403, 'MFA_REQUIRED', 'Bitte bestätige die Zwei-Faktor-Anmeldung.');
    if (options.backoffice && ctx.session.kind !== 'backoffice') throw apiError(403, 'FORBIDDEN', 'Kein Zugriff.');
    if (options.permission && !ctx.permissionKeys.has(options.permission)) throw apiError(403, 'FORBIDDEN', 'Kein Zugriff.');
    if (options.fresh && (!ctx.session.reauthenticated_at || Date.now() - ctx.session.reauthenticated_at.getTime() > 5 * MINUTE)) {
      throw apiError(403, 'REAUTH_REQUIRED', 'Bitte bestätige deine Anmeldung erneut.');
    }
    return ctx;
  }
  async requirePreauth(req: ApiRequest): Promise<SessionContext> {
    const ctx = await this.read(req);
    if (!ctx || ctx.session.kind !== 'preauth') throw apiError(401, 'UNAUTHENTICATED', 'Bitte melde dich erneut an.');
    return ctx;
  }
  // Call after locking the user row, before performing a sensitive mutation.
  // Revocations also lock the user first, so a revoked session cannot race it.
  async assertCurrent(tx: Prisma.TransactionClient, ctx: SessionContext) {
    // Login as a different user can revoke this session without locking its
    // owner; locking the session itself serializes that revocation too.
    await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${ctx.session.id}::uuid FOR UPDATE`;
    const now = new Date();
    const session = await tx.authSession.findFirst({ where: {
      id: ctx.session.id, user_id: ctx.user.id, kind: ctx.session.kind, revoked_at: null,
      expires_at: { gt: now }, last_seen_at: { gt: new Date(now.getTime() - idleDuration(ctx.session.kind)) },
    } });
    if (!session) throw apiError(401, 'UNAUTHENTICATED', 'Bitte melde dich erneut an.');
    return session;
  }
  async prepare(tx: Prisma.TransactionClient, req: ApiRequest, userId: string,
                kind: 'preauth' | 'participant' | 'backoffice', requiredOldSessionId?: string) {
    const old = this.getCookie(req, SESSION_COOKIE);
    if (requiredOldSessionId) {
      await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${requiredOldSessionId}::uuid FOR UPDATE`;
      const valid = await tx.authSession.findFirst({ where: {
        id: requiredOldSessionId, user_id: userId, kind: 'preauth', revoked_at: null,
        expires_at: { gt: new Date() }, ...(old ? { token_hash: this.sessionHash(old) } : {}),
      } });
      if (!old || !valid) throw apiError(401, 'UNAUTHENTICATED', 'Bitte melde dich erneut an.');
    }
    if (old) await tx.authSession.updateMany({ where: { token_hash: this.sessionHash(old), revoked_at: null }, data: { revoked_at: new Date() } });
    const token = randomToken(); const csrf = randomToken(); const now = new Date();
    const duration = kind === 'preauth' ? 5 * MINUTE : kind === 'backoffice' ? 8 * 60 * MINUTE : 7 * DAY;
    await tx.authSession.create({ data: {
      id: uuidv7(), user_id: userId, kind, token_hash: this.sessionHash(token), csrf_secret_hash: this.csrfHash(csrf),
      last_seen_at: now, expires_at: new Date(now.getTime() + duration),
      mfa_verified_at: kind === 'backoffice' ? now : null,
      reauthenticated_at: kind === 'backoffice' ? now : null,
    } });
    return { token, csrf, duration };
  }
  setCookies(res: Response, cookies: { token: string; csrf: string; duration: number }): void {
    res.cookie(SESSION_COOKIE, cookies.token, this.options(true, cookies.duration));
    res.cookie(CSRF_COOKIE, cookies.csrf, this.options(false, cookies.duration));
  }
  async create(res: Response, req: ApiRequest, userId: string, kind: 'preauth' | 'participant' | 'backoffice'): Promise<void> {
    const cookies = await this.db.$transaction(tx => this.prepare(tx, req, userId, kind));
    this.setCookies(res, cookies);
  }
  private anonymousToken(): string {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const value = `${timestamp}.${randomToken()}`;
    return `${value}.${keyedHash(getConfig().csrfKey, 'anonymous-csrf', value).toString('base64url')}`;
  }
  private validAnonymousToken(token: string): boolean {
    const parts = token.split('.');
    if (parts.length !== 3 || !/^\d{10}$/.test(parts[0])) return false;
    const time = Number(parts[0]) * 1000;
    if (time > Date.now() + MINUTE || Date.now() - time > DAY) return false;
    const value = `${parts[0]}.${parts[1]}`;
    return safeEqual(parts[2], keyedHash(getConfig().csrfKey, 'anonymous-csrf', value).toString('base64url'));
  }
  async getCsrf(req: ApiRequest, res: Response): Promise<string> {
    const context = await this.read(req);
    let token = this.getCookie(req, CSRF_COOKIE);
    if (context) {
      if (!token || !Buffer.from(context.session.csrf_secret_hash).equals(this.csrfHash(token))) {
        token = randomToken();
        await this.db.authSession.updateMany({ where: { id: context.session.id, revoked_at: null }, data: { csrf_secret_hash: this.csrfHash(token) } });
      }
    } else if (!token || !this.validAnonymousToken(token)) token = this.anonymousToken();
    res.cookie(CSRF_COOKIE, token, this.options(false, DAY));
    return token;
  }
  async verifyCsrf(req: ApiRequest, context?: SessionContext | null): Promise<void> {
    if (req.get('origin') !== getConfig().publicBaseUrl) throw apiError(403, 'CSRF_FAILED', 'Die Anfrage konnte nicht bestätigt werden.');
    const cookie = this.getCookie(req, CSRF_COOKIE);
    const header = req.get('x-csrf-token');
    if (!cookie || !header || !safeEqual(cookie, header)) throw apiError(403, 'CSRF_FAILED', 'Die Anfrage konnte nicht bestätigt werden.');
    const ctx = context === undefined ? await this.read(req) : context;
    const valid = ctx ? Buffer.from(ctx.session.csrf_secret_hash).equals(this.csrfHash(cookie)) : this.validAnonymousToken(cookie);
    if (!valid) throw apiError(403, 'CSRF_FAILED', 'Die Anfrage konnte nicht bestätigt werden.');
  }
  async logout(_req: ApiRequest, res: Response, context: SessionContext): Promise<void> {
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${context.user.id}::uuid FOR UPDATE`;
      await tx.authSession.updateMany({ where: { id: context.session.id, revoked_at: null }, data: { revoked_at: new Date() } });
    });
    res.clearCookie(SESSION_COOKIE, this.options(true));
    res.clearCookie(CSRF_COOKIE, this.options(false));
  }
}
