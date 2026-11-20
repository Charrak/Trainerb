import { randomBytes } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { BACKOFFICE_ROLES } from '@trainerb/contracts';
import type { Database } from './database';
import { getConfig } from './config';
import { seal } from './security';
import { matchingStep, recoveryHash } from './mfa';
/** Local operations tool only. No controller, HTTP capability or password reset. */
export async function replaceLostFactor(
  db: Database,
  target: string,
  expectedFactor: string,
  incident: string,
  secret: string,
  code: string,
) {
  if (!/^[A-Z2-7]{32}$/.test(secret) || !/^IR-[0-9]{4}-[0-9]{4,10}$/.test(incident))
    throw Error('Invalid recovery evidence.');
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id=${target}::uuid FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: target }, include: { roles: { include: { role: true } } } });
    if (
      !user?.email_verified_at ||
      user.status !== 'active' ||
      !user.password_hash ||
      !user.roles.some((x) => (BACKOFFICE_ROLES as readonly string[]).includes(x.role.key))
    )
      throw Error('Not eligible.');
    const step = matchingStep(secret, 'Offline', code);
    if (step === null) throw Error('Invalid device proof.');
    const existing = await tx.userMfaFactor.findFirst({ where: { user_id: target, status: 'active', type: 'totp' } });
    if (existing?.id !== expectedFactor) throw Error('Factor changed.');
    const now = new Date(),
      id = uuidv7(),
      codes = Array.from({ length: 10 }, () => randomBytes(12).toString('hex').match(/.{6}/g)!.join('-'));
    await tx.userMfaFactor.updateMany({
      where: { user_id: target, status: { in: ['pending', 'active'] } },
      data: { status: 'revoked' },
    });
    await tx.mfaRecoveryCode.deleteMany({ where: { factor: { user_id: target } } });
    await tx.authSession.updateMany({ where: { user_id: target, revoked_at: null }, data: { revoked_at: now } });
    await tx.accountToken.updateMany({
      where: { user_id: target, revoked_at: null, used_at: null },
      data: { revoked_at: now },
    });
    await tx.userMfaFactor.create({
      data: {
        id,
        user_id: target,
        type: 'totp',
        status: 'active',
        confirmed_at: now,
        last_accepted_step: step,
        last_used_at: now,
        secret_ciphertext: seal({ secret }, `mfa:${id}`),
        key_id: getConfig().encryptionKeyId,
      },
    });
    await tx.mfaRecoveryCode.createMany({
      data: codes.map((c) => ({ id: uuidv7(), factor_id: id, code_hash: recoveryHash(c) })),
    });
    await tx.auditEvent.create({
      data: {
        id: uuidv7(),
        origin: 'system',
        action: 'mfa.offline_replaced',
        target_type: 'user',
        target_ref: target,
        after_safe: { incident },
      },
    });
    return codes;
  });
}
