import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as argon2 from 'argon2';
import type { Response } from 'express';
import { setTimeout as delay } from 'node:timers/promises';
import { uuidv7 } from 'uuidv7';
import { BACKOFFICE_ROLES } from '@trainerb/contracts';
import { Database } from './database';
import { RateLimiter } from './limiter';
import { Outbox, TokenPurpose } from './outbox';
import { Sessions, ApiRequest, SessionContext } from './sessions';
import { Mfa } from './mfa';
import { getConfig } from './config';
import { apiError, bodyObject, keyedHash, normalizeEmail, randomToken, requireName, requirePassword, requireString } from './security';

const argonOptions: argon2.HashOptions = { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 };
const invalidLogin = () => apiError(401, 'INVALID_CREDENTIALS', 'E-Mail oder Passwort ist ungültig oder die Anmeldung ist nicht möglich.');
const invalidToken = () => apiError(410, 'TOKEN_INVALID', 'Der Link ist ungültig oder abgelaufen.');
const isUniqueError = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'P2002';
async function neutralDelay(started: number): Promise<void> { const ms = 250 - (Date.now() - started); if (ms > 0) await delay(ms); }

@Injectable()
export class Auth {
  private readonly dummyHash = argon2.hash(randomToken(), argonOptions);
  constructor(private readonly db: Database, private readonly limiter: RateLimiter,
              private readonly outbox: Outbox, private readonly sessions: Sessions, private readonly mfa: Mfa) {}

  async register(body: unknown, ip: string): Promise<void> {
    const started = Date.now();
    const data = bodyObject(body, ['email', 'first_name', 'last_name']);
    const firstName = requireName(data.first_name, 'first_name');
    const lastName = requireName(data.last_name, 'last_name');
    const email = normalizeEmail(data.email);
    await this.limiter.hit('register-ip', ip, 30);
    await this.limiter.hit('register-pair', `${email.canonical}\0${ip}`, 5);
    try {
      await this.db.$transaction(async tx => {
        const existing = await tx.user.findUnique({ where: { email_canonical: email.canonical } });
        if (existing) return;
        const role = await tx.role.findUnique({ where: { key: 'participant' } });
        if (!role) throw new Error('Role catalog is not initialized.');
        const id = uuidv7();
        const user = await tx.user.create({ data: {
          id, email_original: email.original, email_canonical: email.canonical,
          first_name: firstName, last_name: lastName, locale: 'de-DE', status: 'pending_activation',
        } });
        // The system assigns only the participant role; the self reference is a
        // non-null actor for this automatic assignment, not a public role choice.
        await tx.userRole.create({ data: { user_id: id, role_id: role.id, granted_by: id } });
        await tx.auditEvent.create({ data: { id: uuidv7(), origin: 'system', action: 'account.registered', target_type: 'user', target_ref: id } });
        await this.outbox.issueToken(tx, user, 'activation');
      });
    } catch (error) {
      // A concurrent registration of the same address must not create a second account or reveal it.
      if (!isUniqueError(error)) throw error;
    }
    await neutralDelay(started);
  }

  async requestToken(body: unknown, ip: string, purpose: 'activation' | 'password_reset'): Promise<void> {
    const started = Date.now();
    const data = bodyObject(body, ['email']);
    const email = normalizeEmail(data.email);
    await this.limiter.hit(`${purpose}-request-ip`, ip, 30);
    await this.limiter.hit(`${purpose}-request-pair`, `${email.canonical}\0${ip}`, 5);
    await this.db.$transaction(async tx => {
      const user = await tx.user.findUnique({ where: { email_canonical: email.canonical } });
      if (!user || (purpose === 'activation' ? user.status !== 'pending_activation' : user.status !== 'active')) return;
      // Serializes reissues so that only the most recent token remains usable.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`;
      const current = await tx.user.findUnique({ where: { id: user.id } });
      if (!current || current.email_canonical !== email.canonical ||
          (purpose === 'activation' ? current.status !== 'pending_activation' : current.status !== 'active')) return;
      await this.outbox.issueToken(tx, current, purpose);
    });
    await neutralDelay(started);
  }

  private async consumeToken(tx: Prisma.TransactionClient, raw: string, purpose: TokenPurpose) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw invalidToken();
    const token = await tx.accountToken.findUnique({ where: { token_hash: keyedHash(getConfig().tokenKey, 'account-token', raw) } });
    if (!token || token.purpose !== purpose) throw invalidToken();
    // All identity mutations lock the user before tokens and sessions. This
    // avoids deadlocks with reissues and prevents stale credentials from racing
    // a password or email change.
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${token.user_id}::uuid FOR UPDATE`;
    const now = new Date();
    const claimed = await tx.accountToken.updateMany({
      where: { id: token.id, purpose, used_at: null, revoked_at: null, expires_at: { gt: now } },
      data: { used_at: now },
    });
    if (claimed.count !== 1) throw invalidToken();
    return token;
  }

  async activate(body: unknown, ip: string): Promise<void> {
    const data = bodyObject(body, ['token', 'password']);
    const token = requireString(data.token, 'token', 128);
    const password = requirePassword(data.password);
    await this.limiter.hit('activate-ip', ip, 30);
    const hash = await argon2.hash(password, argonOptions);
    await this.db.$transaction(async tx => {
      const record = await this.consumeToken(tx, token, 'activation');
      const updated = await tx.user.updateMany({ where: { id: record.user_id, status: 'pending_activation' },
        data: { status: 'active', password_hash: hash, email_verified_at: new Date() } });
      if (updated.count !== 1) throw invalidToken();
      await tx.accountToken.updateMany({ where: { user_id: record.user_id, purpose: 'activation', used_at: null, revoked_at: null }, data: { revoked_at: new Date() } });
      await tx.auditEvent.create({ data: { id: uuidv7(), origin: 'user', actor_user_id: record.user_id,
        action: 'account.activated', target_type: 'user', target_ref: record.user_id } });
    });
  }

  async login(body: unknown, ip: string, req: ApiRequest, res: Response): Promise<'authenticated' | 'mfa_required' | 'mfa_enrollment_required'> {
    const data = bodyObject(body, ['email', 'password']);
    const email = normalizeEmail(data.email);
    const password = typeof data.password === 'string' && Buffer.byteLength(data.password, 'utf8') <= 1024 ? data.password : '';
    const user = await this.limiter.checkLogin(email.canonical, ip, async () => {
      const found = await this.db.user.findUnique({ where: { email_canonical: email.canonical },
        include: { roles: { include: { role: true } }, mfa_factors: { where: { type: 'totp', status: 'active' } } } });
      let valid = false;
      try { valid = await argon2.verify(found?.password_hash || await this.dummyHash, password); } catch { valid = false; }
      if (!valid || !found || found.status !== 'active' || !found.email_verified_at) return null;
      return found;
    });
    if (!user) throw invalidLogin();
    const upgradedHash = user.password_hash && argon2.needsRehash(user.password_hash, argonOptions)
      ? await argon2.hash(password, argonOptions) : null;
    const result = await this.db.$transaction(async tx => {
      // Password resets and role changes serialize on the user row. Old credentials
      // cannot create a fresh session after a concurrent reset has committed.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`;
      const current = await tx.user.findUnique({ where: { id: user.id },
        include: { roles: { include: { role: true } }, mfa_factors: { where: { type: 'totp', status: 'active' } } } });
      if (!current || current.status !== 'active' || current.password_hash !== user.password_hash ||
          current.email_canonical !== email.canonical || !current.email_verified_at) throw invalidLogin();
      const privileged = current.roles.some(item => (BACKOFFICE_ROLES as readonly string[]).includes(item.role.key));
      await tx.user.update({ where: { id: current.id }, data: { last_login_at: new Date(), ...(upgradedHash ? { password_hash: upgradedHash } : {}) } });
      const cookies = await this.sessions.prepare(tx, req, current.id, privileged ? 'preauth' : 'participant');
      const status = privileged ? (current.mfa_factors.length ? 'mfa_required' : 'mfa_enrollment_required') : 'authenticated';
      return { cookies, status } as const;
    });
    this.sessions.setCookies(res, result.cookies);
    return result.status;
  }

  async resetPassword(body: unknown, ip: string): Promise<void> {
    const data = bodyObject(body, ['token', 'password']);
    const token = requireString(data.token, 'token', 128);
    const password = requirePassword(data.password);
    await this.limiter.hit('password-reset-confirm-ip', ip, 30);
    const hash = await argon2.hash(password, argonOptions);
    await this.db.$transaction(async tx => {
      const record = await this.consumeToken(tx, token, 'password_reset');
      const user = await tx.user.findUnique({ where: { id: record.user_id } });
      if (!user || user.status !== 'active' || !user.email_original || !user.first_name) throw invalidToken();
      await tx.user.update({ where: { id: user.id }, data: { password_hash: hash } });
      await tx.authSession.updateMany({ where: { user_id: user.id, revoked_at: null }, data: { revoked_at: new Date() } });
      await tx.accountToken.updateMany({ where: { user_id: user.id, used_at: null, revoked_at: null }, data: { revoked_at: new Date() } });
      await this.outbox.notify(tx, user.id, user.email_original, user.first_name, 'password_changed');
      await tx.auditEvent.create({ data: { id: uuidv7(), origin: 'user', actor_user_id: user.id,
        action: 'password.reset', target_type: 'user', target_ref: user.id } });
    });
  }

  profile(ctx: SessionContext) {
    return { id: ctx.user.id, first_name: ctx.user.first_name, last_name: ctx.user.last_name,
      email: ctx.user.email_original, locale: ctx.user.locale, permissions: [...ctx.permissionKeys].sort(), roles: ctx.roleKeys.sort() };
  }

  async updateProfile(ctx: SessionContext, body: unknown) {
    const data = bodyObject(body, ['first_name', 'last_name', 'locale']);
    const changes: Prisma.UserUpdateInput = {};
    if ('first_name' in data) changes.first_name = requireName(data.first_name, 'first_name');
    if ('last_name' in data) changes.last_name = requireName(data.last_name, 'last_name');
    if ('locale' in data) {
      if (typeof data.locale !== 'string' || data.locale.length > 35) throw apiError(422, 'INVALID_LOCALE', 'Ungültige Sprache.');
      try { changes.locale = Intl.getCanonicalLocales(data.locale)[0]; } catch { throw apiError(422, 'INVALID_LOCALE', 'Ungültige Sprache.'); }
    }
    const user = await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.user.id}::uuid FOR UPDATE`;
      await this.sessions.assertCurrent(tx, ctx);
      const updated = await tx.user.updateMany({ where: { id: ctx.user.id, status: 'active' }, data: changes });
      if (updated.count !== 1) throw apiError(401, 'UNAUTHENTICATED', 'Bitte melde dich erneut an.');
      if (Object.keys(changes).length) await tx.auditEvent.create({ data: { id: uuidv7(), origin:'user', actor_user_id:ctx.user.id,
        action:'profile.updated', target_type:'user', target_ref:ctx.user.id, after_safe:{ changed_fields:Object.keys(changes) } } });
      return tx.user.findUniqueOrThrow({ where: { id: ctx.user.id } });
    });
    return { ...this.profile(ctx), first_name: user.first_name, last_name: user.last_name, locale: user.locale };
  }

  async reauthenticate(ctx: SessionContext, body: unknown, ip: string): Promise<void> {
    const data = bodyObject(body, ['password', 'code', 'recovery_code']);
    const password = requireString(data.password, 'password');
    await this.limiter.hit('reauth', `${ctx.user.id}\0${ip}`, 10);
    if (!ctx.user.password_hash || !(await argon2.verify(ctx.user.password_hash, password))) throw invalidLogin();
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.user.id}::uuid FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: ctx.user.id } });
      if (!user || user.status !== 'active' || user.password_hash !== ctx.user.password_hash) throw invalidLogin();
      await this.sessions.assertCurrent(tx, ctx);
      if (ctx.session.kind === 'backoffice') await this.mfa.consumeFactor(tx, user.id, user.email_original || 'Konto', data);
      const now = new Date();
      const updated = await tx.authSession.updateMany({ where: { id: ctx.session.id, user_id: user.id, revoked_at: null, expires_at: { gt: now } },
        data: { reauthenticated_at: now, ...(ctx.session.kind === 'backoffice' ? { mfa_verified_at: now } : {}) } });
      if (updated.count !== 1) throw apiError(401, 'UNAUTHENTICATED', 'Bitte melde dich erneut an.');
    });
  }

  async changePassword(ctx: SessionContext, body: unknown, ip: string): Promise<void> {
    const data = bodyObject(body, ['current_password', 'new_password']);
    const current = requireString(data.current_password, 'current_password');
    const next = requirePassword(data.new_password, 'new_password');
    await this.limiter.hit('change-password', `${ctx.user.id}\0${ip}`, 10);
    if (!ctx.user.password_hash || !(await argon2.verify(ctx.user.password_hash, current))) throw invalidLogin();
    const hash = await argon2.hash(next, argonOptions);
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.user.id}::uuid FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: ctx.user.id } });
      if (!user || user.status !== 'active' || user.password_hash !== ctx.user.password_hash || !user.email_original || !user.first_name) throw invalidLogin();
      const now = new Date();
      const validSession = await this.sessions.assertCurrent(tx, ctx);
      if (validSession.kind === 'backoffice' && (!validSession.reauthenticated_at || now.getTime() - validSession.reauthenticated_at.getTime() > 5 * 60_000)) {
        throw apiError(403, 'REAUTH_REQUIRED', 'Bitte bestätige deine Anmeldung erneut.');
      }
      await tx.user.update({ where: { id: user.id }, data: { password_hash: hash } });
      await tx.authSession.updateMany({ where: { user_id: user.id, revoked_at: null }, data: { revoked_at: now } });
      await tx.accountToken.updateMany({ where: { user_id: user.id, used_at: null, revoked_at: null }, data: { revoked_at: now } });
      await this.outbox.notify(tx, user.id, user.email_original, user.first_name, 'password_changed');
      await tx.auditEvent.create({ data: { id: uuidv7(), origin: 'user', actor_user_id: user.id,
        action: 'password.changed', target_type: 'user', target_ref: user.id } });
    });
  }

  async requestEmailChange(ctx: SessionContext, body: unknown, ip: string): Promise<void> {
    const data = bodyObject(body, ['new_email']);
    const email = normalizeEmail(data.new_email);
    await this.limiter.hit('email-change', `${ctx.user.id}\0${ip}`, 5);
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.user.id}::uuid FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: ctx.user.id } });
      const session = await this.sessions.assertCurrent(tx, ctx);
      if (!user || user.status !== 'active' || !session.reauthenticated_at || Date.now() - session.reauthenticated_at.getTime() > 5 * 60_000) {
        throw apiError(403, 'REAUTH_REQUIRED', 'Bitte bestätige deine Anmeldung erneut.');
      }
      await this.outbox.issueToken(tx, user, 'email_change', email);
    });
  }

  async confirmEmailChange(body: unknown, ip: string): Promise<void> {
    const data = bodyObject(body, ['token']);
    const raw = requireString(data.token, 'token', 128);
    await this.limiter.hit('email-change-confirm-ip', ip, 30);
    try {
      await this.db.$transaction(async tx => {
        const record = await this.consumeToken(tx, raw, 'email_change');
        const user = await tx.user.findUnique({ where: { id: record.user_id } });
        if (!user || user.status !== 'active' || !user.email_original || !user.first_name || !record.target_email_original || !record.target_email_canonical) throw invalidToken();
        await tx.user.update({ where: { id: user.id }, data: {
          email_original: record.target_email_original, email_canonical: record.target_email_canonical, email_verified_at: new Date(),
        } });
        const now = new Date();
        await tx.authSession.updateMany({ where: { user_id: user.id, revoked_at: null }, data: { revoked_at: now } });
        // Previously issued links to the old address must not survive an email
        // change, including password-reset links that have not yet been used.
        await tx.accountToken.updateMany({ where: { user_id: user.id, used_at: null, revoked_at: null }, data: { revoked_at: now } });
        await this.outbox.notify(tx, user.id, user.email_original, user.first_name, 'email_changed_old');
        await tx.auditEvent.create({ data: { id: uuidv7(), origin: 'user', actor_user_id: user.id,
          action: 'email.changed', target_type: 'user', target_ref: user.id } });
      });
    } catch (error) {
      if (isUniqueError(error)) throw apiError(409, 'EMAIL_UNAVAILABLE', 'Die E-Mail-Adresse konnte nicht übernommen werden.');
      throw error;
    }
  }
}
