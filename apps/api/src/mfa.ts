import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import { uuidv7 } from 'uuidv7';
import { BACKOFFICE_ROLES } from '@trainerb/contracts';
import { Database } from './database';
import { RateLimiter } from './limiter';
import { getConfig } from './config';
import { apiError, bodyObject, keyedHash, seal, unseal } from './security';
import { ApiRequest, SessionContext, Sessions } from './sessions';
import { GuestCheckout } from './guest';

const fail = () => apiError(401, 'MFA_FAILED', 'Der Bestätigungscode ist ungültig oder abgelaufen.');
export const recoveryHash = (code: string) => keyedHash(getConfig().tokenKey, 'mfa-recovery', code.replace(/-/g, '').toLowerCase());
function totp(secret: string, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({ issuer: 'Online-Akademie', label, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
}
export function matchingStep(secret: string, label: string, code: string): bigint | null {
  if (!/^\d{6}$/.test(code)) return null;
  const timestamp = Date.now();
  const delta = totp(secret, label).validate({ token: code, timestamp, window: 1 });
  return delta === null ? null : BigInt(Math.floor(timestamp / 30_000) + delta);
}

@Injectable()
export class Mfa {
  constructor(private readonly db: Database, private readonly limiter: RateLimiter, private readonly sessions: Sessions,
              private readonly guest: GuestCheckout) {}

  // The caller holds the user row lock, which serializes role changes, resets,
  // logout and the creation of a full backoffice session.
  private async assertPreauth(tx: Prisma.TransactionClient, ctx: SessionContext) {
    const user = await tx.user.findUnique({ where: { id: ctx.user.id }, include: { roles: { include: { role: true } } } });
    if (!user || user.status !== 'active' || !user.roles.some(x => (BACKOFFICE_ROLES as readonly string[]).includes(x.role.key))) {
      throw apiError(401, 'UNAUTHENTICATED', 'Bitte melde dich erneut an.');
    }
    await this.sessions.assertCurrent(tx, ctx);
  }

  async start(ctx: SessionContext, ip: string) {
    await this.limiter.hit('mfa-start', `${ctx.user.id}\0${ip}`, 10);
    const id = uuidv7(); const secret = new OTPAuth.Secret({ size: 20 }).base32;
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.user.id}::uuid FOR UPDATE`;
      await this.assertPreauth(tx, ctx);
      const active = await tx.userMfaFactor.findFirst({ where: { user_id: ctx.user.id, status: 'active', type: 'totp' } });
      if (active) throw apiError(409, 'MFA_ALREADY_CONFIGURED', 'Die Zwei-Faktor-Anmeldung ist bereits eingerichtet.');
      await tx.userMfaFactor.updateMany({ where: { user_id: ctx.user.id, type: 'totp', status: 'pending' }, data: { status: 'revoked' } });
      await tx.userMfaFactor.create({ data: {
        id, user_id: ctx.user.id, type: 'totp', status: 'pending',
        secret_ciphertext: seal({ secret }, `mfa:${id}`), key_id: getConfig().encryptionKeyId,
      } });
    });
    return { secret, otpauth_uri: totp(secret, ctx.user.email_original || 'Konto').toString() };
  }

  async confirm(req: ApiRequest, res: Response, ctx: SessionContext, body: unknown, ip: string) {
    await this.limiter.hit('mfa-confirm', `${ctx.user.id}\0${ip}`, 10);
    const data = bodyObject(body, ['code']);
    if (typeof data.code !== 'string') throw fail();
    const codes = Array.from({ length: 10 }, () => randomBytes(12).toString('hex').match(/.{1,6}/g)!.join('-'));
    const cookies = await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.user.id}::uuid FOR UPDATE`;
      await this.assertPreauth(tx, ctx);
      const factor = await tx.userMfaFactor.findFirst({ where: { user_id: ctx.user.id, type: 'totp', status: 'pending' } });
      if (!factor) throw fail();
      const { secret } = unseal<{ secret: string }>(factor.secret_ciphertext, `mfa:${factor.id}`, factor.key_id);
      const step = matchingStep(secret, ctx.user.email_original || 'Konto', data.code as string);
      if (step === null) throw fail();
      const changed = await tx.userMfaFactor.updateMany({ where: { id: factor.id, status: 'pending' },
        data: { status: 'active', confirmed_at: new Date(), last_used_at: new Date(), last_accepted_step: step } });
      if (changed.count !== 1) throw fail();
      for (const code of codes) await tx.mfaRecoveryCode.create({ data: { id: uuidv7(), factor_id: factor.id, code_hash: recoveryHash(code) } });
      await tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: ctx.user.id, origin: 'user', action: 'mfa.enrolled', target_type: 'user', target_ref: ctx.user.id } });
      return this.sessions.prepare(tx, req, ctx.user.id, 'backoffice', ctx.session.id);
    });
    this.sessions.setCookies(res, cookies);
    return { recovery_codes: codes };
  }

  async consumeFactor(tx: Prisma.TransactionClient, userId: string, email: string, body: Record<string, unknown>,
): Promise<void> {
    const factor = await tx.userMfaFactor.findFirst({ where: { user_id: userId, type: 'totp', status: 'active' } });
    if (!factor) throw fail();
    const hasCode = typeof body.code === 'string' && body.code.length > 0;
    const hasRecovery = typeof body.recovery_code === 'string' && body.recovery_code.length > 0;
    if (hasCode === hasRecovery) throw fail();
    if (hasCode) {
      const { secret } = unseal<{ secret: string }>(factor.secret_ciphertext, `mfa:${factor.id}`, factor.key_id);
      const step = matchingStep(secret, email, body.code as string);
      if (step === null) throw fail();
      const changed = await tx.userMfaFactor.updateMany({ where: {
        id: factor.id, status: 'active', OR: [{ last_accepted_step: null }, { last_accepted_step: { lt: step } }],
      }, data: { last_accepted_step: step, last_used_at: new Date() } });
      if (changed.count !== 1) throw fail();
    } else {
      const code = String(body.recovery_code).replace(/-/g, '').toLowerCase();
      if (!/^[0-9a-f]{24}$/.test(code)) throw fail();
      const changed = await tx.mfaRecoveryCode.updateMany({ where: {
        factor_id: factor.id, code_hash: recoveryHash(code), used_at: null,
        OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
      }, data: { used_at: new Date() } });
      if (changed.count !== 1) throw fail();
      await tx.userMfaFactor.update({ where: { id: factor.id }, data: { last_used_at: new Date() } });
    }
  }
  async challenge(req: ApiRequest, res: Response, ctx: SessionContext, body: unknown, ip: string) {
    await this.limiter.hit('mfa-challenge', `${ctx.user.id}\0${ip}`, 10);
    const data = bodyObject(body, ['code', 'recovery_code']);
    const cookies = await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${ctx.user.id}::uuid FOR UPDATE`;
      await this.assertPreauth(tx, ctx);
      await this.consumeFactor(tx, ctx.user.id, ctx.user.email_original || 'Konto', data);
      return this.sessions.prepare(tx, req, ctx.user.id, 'backoffice', ctx.session.id);
    });
    this.sessions.setCookies(res, cookies);
    // A basket collected before login follows the buyer into the backoffice too.
    const merged_items = await this.guest.mergeIntoAccount(req, res, ctx.user.id);
    return { status: 'authenticated', merged_items };
  }
}
