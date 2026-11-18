import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

loadEnv({ path: resolve(__dirname, '../../../.env'), quiet: true });

type AppEnv = 'development' | 'test' | 'production';
export type Config = {
  appEnv: AppEnv;
  databaseUrl: string;
  redisUrl: string;
  publicBaseUrl: string;
  embeddedPreviewCookies: boolean;
  sessionKey: Buffer;
  csrfKey: Buffer;
  tokenKey: Buffer;
  encryptionKey: Buffer;
  encryptionKeyId: string;
  auditKey: Buffer;
  mailFrom: string;
  smtpHost?: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser?: string;
  smtpPassword?: string;
  commonPasswords: Set<string>;
  trustProxy: string | false;
  quarantineStore?: Config['mediaStore'];
  mediaStore?: { origin: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string };
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  stripePublishableKey?: string;
  /** Derived from APP_ENV only: a production process never accepts test payments. */
  paymentEnvironment: 'test' | 'live';
};

let cached: Config | undefined;
const required = (name: string): string => {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error(`Missing configuration: ${name}`);
  return value;
};
const key = (name: string): Buffer => {
  const value = required(name);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error(`${name} must be a base64-encoded 32-byte key.`);
  const result = Buffer.from(value, 'base64');
  if (result.length !== 32 || result.toString('base64') !== value) throw new Error(`${name} must be a base64-encoded 32-byte key.`);
  return result;
};

export function getConfig(): Config {
  if (cached) return cached;
  const appEnv = (process.env.APP_ENV || 'development') as AppEnv;
  if (!['development', 'test', 'production'].includes(appEnv)) throw new Error('Invalid APP_ENV.');
  const publicUrl = new URL(required('PUBLIC_BASE_URL'));
  const localHttp = appEnv !== 'production' && process.env.ALLOW_INSECURE_LOCAL_HTTP === 'true' &&
    publicUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname);
  if ((publicUrl.protocol !== 'https:' && !localHttp) || publicUrl.username || publicUrl.password ||
      publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
    throw new Error('PUBLIC_BASE_URL must be an HTTPS origin (local HTTP needs explicit development opt-in).');
  }
  // Embedded previews need partitioned third-party cookies. This is explicitly
  // opt-in for HTTPS development only; never loosen the production policy.
  const embeddedPreviewCookies = process.env.TRAINERB_EMBEDDED_PREVIEW_COOKIES === 'true';
  if (embeddedPreviewCookies && (appEnv !== 'development' || publicUrl.protocol !== 'https:')) {
    throw new Error('Embedded preview cookies are permitted only for HTTPS development.');
  }
  const databaseUrl = required('DATABASE_URL');
  const redisUrl = required('REDIS_URL');
  if (!['postgresql:', 'postgres:'].includes(new URL(databaseUrl).protocol)) throw new Error('Invalid DATABASE_URL.');
  if (!['redis:', 'rediss:'].includes(new URL(redisUrl).protocol)) throw new Error('Invalid REDIS_URL.');
  const keyValues = [key('SESSION_HMAC_KEY'), key('CSRF_HMAC_KEY'), key('TOKEN_HMAC_KEY'),
    key('DATA_ENCRYPTION_KEY'), key('AUDIT_PSEUDONYMIZATION_KEY')];
  if (new Set(keyValues.map(x => x.toString('hex'))).size !== keyValues.length) throw new Error('Security keys must be independent.');
  const root = resolve(__dirname, '../../..');
  const passwordFile = resolve(root, process.env.COMMON_PASSWORDS_FILE || 'packages/database/data/common-passwords.txt.gz');
  const file = readFileSync(passwordFile);
  const entries = (text: string) => text.split(/\r?\n/).map(x => x.trim().normalize('NFC').toLowerCase()).filter(x => x && !x.startsWith('#'));
  const commonPasswords = new Set(entries((passwordFile.endsWith('.gz') ? gunzipSync(file) : file).toString('utf8')));
  if (!commonPasswords.size || (appEnv === 'production' && commonPasswords.size < 10000)) {
    throw new Error('Configure an adequate locally managed common-password list before production.');
  }
  for (const word of entries(readFileSync(resolve(root, 'packages/database/data/common-passwords.txt'), 'utf8'))) commonPasswords.add(word);
  const smtpPort = Number(process.env.SMTP_PORT || '1025');
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) throw new Error('Invalid SMTP_PORT.');
  const smtpSecure = process.env.SMTP_SECURE === 'true';
  const smtpHost = process.env.SMTP_HOST;
  if (appEnv === 'production' && (!smtpHost || !smtpSecure)) throw new Error('Production SMTP must be configured with TLS.');
  // Stripe is optional: without both keys the invoice path remains the only
  // payment method, and the API never pretends a card payment is possible.
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim() || undefined;
  const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim() || undefined;
  const stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY?.trim() || undefined;
  if ((stripeSecretKey || stripeWebhookSecret || stripePublishableKey) &&
      !(stripeSecretKey && stripeWebhookSecret && stripePublishableKey)) {
    throw new Error('Stripe needs STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PUBLISHABLE_KEY together.');
  }
  if (appEnv === 'production' && stripeSecretKey && !stripeSecretKey.startsWith('sk_live_')) {
    throw new Error('Production requires live Stripe credentials (sk_live_…).');
  }
  let mediaStore: Config['mediaStore'];
  if (['ENDPOINT', 'BUCKET', 'REGION', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY'].some(k => process.env[`MEDIA_S3_${k}`])) {
    const origin = new URL(required('MEDIA_S3_ENDPOINT'));
    const bucket = required('MEDIA_S3_BUCKET'), region = required('MEDIA_S3_REGION');
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
        origin.origin === publicUrl.origin || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !/^[a-z0-9-]+$/.test(region)) {
      throw new Error('Configure a separate HTTPS media storage origin, bucket and region.');
    }
    mediaStore = { origin: origin.origin, bucket, region, accessKeyId: required('MEDIA_S3_ACCESS_KEY_ID'),
      secretAccessKey: required('MEDIA_S3_SECRET_ACCESS_KEY') };
  }
  let quarantineStore: Config['mediaStore'];
  if (['BUCKET', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY'].some(k => process.env[`MEDIA_QUARANTINE_${k}`])) {
    const bucket = required('MEDIA_QUARANTINE_BUCKET'), accessKeyId = required('MEDIA_QUARANTINE_ACCESS_KEY_ID');
    if (!mediaStore || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
        bucket === mediaStore.bucket || accessKeyId === mediaStore.accessKeyId) {
      throw new Error('Quarantine requires a separate private bucket and writer identity on the media store.');
    }
    quarantineStore = { ...mediaStore, bucket, accessKeyId, secretAccessKey: required('MEDIA_QUARANTINE_SECRET_ACCESS_KEY') };
  }
  const paymentEnvironment: 'test' | 'live' = appEnv === 'production' ? 'live' : 'test';
  cached = {
    appEnv, databaseUrl, redisUrl, publicBaseUrl: publicUrl.origin, embeddedPreviewCookies,
    sessionKey: keyValues[0], csrfKey: keyValues[1], tokenKey: keyValues[2],
    encryptionKey: keyValues[3], encryptionKeyId: required('DATA_ENCRYPTION_KEY_ID'), auditKey: keyValues[4],
    mailFrom: required('MAIL_FROM'), smtpHost, smtpPort, smtpSecure,
    smtpUser: process.env.SMTP_USER || undefined, smtpPassword: process.env.SMTP_PASSWORD || undefined,
    commonPasswords, trustProxy: process.env.TRUST_PROXY_CIDRS || false,
    stripeSecretKey, stripeWebhookSecret, stripePublishableKey, paymentEnvironment, mediaStore, quarantineStore,
  };
  return cached;
}
