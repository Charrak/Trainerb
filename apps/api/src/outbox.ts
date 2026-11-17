import { Injectable } from '@nestjs/common';
import type { Prisma, User } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { getConfig } from './config';
import { keyedHash, randomToken, seal } from './security';

export type TokenPurpose = 'activation' | 'password_reset' | 'email_change';

@Injectable()
export class Outbox {
  private async template(tx: Prisma.TransactionClient, key: string) {
    const template = await tx.emailTemplate.findUnique({ where: { key_locale: { key, locale: 'de-DE' } },
      include: { versions: { where: { state: 'published' }, take: 1 } } });
    if (!template || template.status !== 'active' || !template.versions[0]) throw new Error(`Required mail template not configured: ${key}`);
    return template.versions[0];
  }
  async issueToken(tx: Prisma.TransactionClient, user: User, purpose: TokenPurpose,
                   target?: { original: string; canonical: string }): Promise<void> {
    if (!user.email_original || !user.first_name) throw new Error('Account is missing required identity data.');
    const now = new Date();
    const duration = purpose === 'activation' ? 24 * 60 * 60_000 : 30 * 60_000;
    const expiresAt = new Date(now.getTime() + duration);
    const token = randomToken();
    await tx.accountToken.updateMany({ where: { user_id: user.id, purpose, used_at: null, revoked_at: null }, data: { revoked_at: now } });
    await tx.accountToken.create({ data: {
      id: uuidv7(), user_id: user.id, purpose, token_hash: keyedHash(getConfig().tokenKey, 'account-token', token),
      expires_at: expiresAt, target_email_original: target?.original, target_email_canonical: target?.canonical,
    } });
    const version = await this.template(tx, purpose);
    const outboxId = uuidv7();
    await tx.emailOutbox.create({ data: {
      id: outboxId, template_version_id: version.id, purpose: 'transaction', user_id: user.id,
      to_email: target?.original || user.email_original, variables_public: { first_name: user.first_name },
      variables_secret_ciphertext: seal({ token, purpose }, `outbox:${outboxId}`),
      secret_key_id: getConfig().encryptionKeyId, secret_delete_after: expiresAt,
      idempotency_key: `outbox-${outboxId}`, status: 'queued', scheduled_at: now,
    } });
    await tx.automationJob.create({ data: {
      id: uuidv7(), kind: 'email.send', ref_type: 'email_outbox', ref_id: outboxId,
      payload_schema_version: 1, payload: { schema_version: 1 }, idempotency_key: `email-${outboxId}`,
      status: 'queued', max_attempts: 8, run_after: now,
    } });
  }
  async notify(tx: Prisma.TransactionClient, userId: string, toEmail: string, firstName: string, templateKey: string,
               variables: Record<string, string> = {}): Promise<void> {
    const version = await this.template(tx, templateKey);
    const id = uuidv7(); const now = new Date();
    await tx.emailOutbox.create({ data: {
      id, template_version_id: version.id, purpose: 'transaction', user_id: userId, to_email: toEmail,
      variables_public: { first_name: firstName, ...variables }, idempotency_key: `outbox-${id}`, status: 'queued',
      scheduled_at: now,
    } });
    await tx.automationJob.create({ data: {
      id: uuidv7(), kind: 'email.send', ref_type: 'email_outbox', ref_id: id, payload_schema_version: 1,
      payload: { schema_version: 1 }, idempotency_key: `email-${id}`, status: 'queued', max_attempts: 8, run_after: now,
    } });
  }
}
