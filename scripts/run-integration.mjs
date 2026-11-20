import { config } from 'dotenv';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

config({ quiet: true });
const mode = process.argv[2];
if (process.argv.length > 3 || (mode && !['--certificate-browser', '--certificate-restore'].includes(mode))) throw new Error('Unknown integration test mode.');
const certificateBrowser = mode === '--certificate-browser';
const certificateRestore = mode === '--certificate-restore';
const database = process.env.TEST_DATABASE_URL;
const redis = process.env.TEST_REDIS_URL;
if (!database || !redis) throw new Error('Set TEST_DATABASE_URL and TEST_REDIS_URL for isolated integration tests.');
const dbUrl = new URL(database), redisUrl = new URL(redis);
if (!['postgres:', 'postgresql:'].includes(dbUrl.protocol) || !/_test$/.test(decodeURIComponent(dbUrl.pathname.slice(1)))) {
  throw new Error('The integration database name must end in _test. Its application data will be deleted.');
}
if (!['redis:', 'rediss:'].includes(redisUrl.protocol) || !/^\/(?:[1-9]|1[0-5])$/.test(redisUrl.pathname)) {
  throw new Error('Use a separate Redis test database numbered 1 through 15.');
}
if (process.env.APP_ENV === 'production') throw new Error('Integration tests cannot run with APP_ENV=production.');
const host = url => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? 'loopback' : url.hostname;
const sameEndpoint = (left, right, fallbackPort) => host(left) === host(right) &&
  (left.port || fallbackPort) === (right.port || fallbackPort) && left.pathname === right.pathname;
if (process.env.DATABASE_URL && sameEndpoint(dbUrl, new URL(process.env.DATABASE_URL), '5432')) {
  throw new Error('TEST_DATABASE_URL must not point to the application database.');
}
if (process.env.REDIS_URL && sameEndpoint(redisUrl, new URL(process.env.REDIS_URL), '6379')) {
  throw new Error('TEST_REDIS_URL must not point to the application Redis database.');
}
if (certificateBrowser && (process.env.E2E_ALLOW_TEST_DATA !== 'yes' || host(dbUrl) !== 'loopback' || host(redisUrl) !== 'loopback'
    || !dbUrl.pathname.endsWith('_e2e_test') || process.env.NODE_ENV === 'production')) {
  throw new Error('Browser acceptance requires explicit E2E_ALLOW_TEST_DATA=yes, isolated loopback services and a *_e2e_test database.');
}
// pg_dump and the application must interpret exactly the same local endpoint.
// Reject URI query overrides (e.g. host/dbname) before migrating/truncating anything.
if (certificateRestore && (process.env.E2E_ALLOW_TEST_DATA !== 'yes' || process.env.NODE_ENV === 'production' ||
    host(dbUrl) !== 'loopback' || host(redisUrl) !== 'loopback' || dbUrl.search || dbUrl.hash || redisUrl.search || redisUrl.hash ||
    !/^\/[a-z0-9_]+_drill_test$/.test(dbUrl.pathname))) {
  throw new Error('Restore drill requires E2E_ALLOW_TEST_DATA=yes, loopback test services without URI options, and a disposable *_drill_test database.');
}
const env = { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DATABASE_URL: database, REDIS_URL: redis,
  PUBLIC_BASE_URL: 'https://academy.test', DATA_ENCRYPTION_KEY_ID: 'integration-ephemeral',
  MAIL_FROM: 'test@example.invalid', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025', SMTP_SECURE: 'false',
  TRAINERB_EMBEDDED_PREVIEW_COOKIES: 'false', TRAINERB_DESTRUCTIVE_TEST_DATABASE: 'confirmed' };
env.TRAINERB_CERTIFICATE_BROWSER = certificateBrowser ? 'yes' : 'no';
delete env.DATABASE_MIGRATION_URL;
// Never import operator key history or real provider credentials into a disposable suite.
for (const k of ['DATA_DECRYPTION_KEYS_FILE','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','STRIPE_PUBLISHABLE_KEY']) env[k] = '';
// Do not inherit operator storage credentials from .env into a destructive test.
for (const key of Object.keys(env)) if (/^MEDIA_(?:QUARANTINE|SCAN|PROMOTE|S3)_/.test(key)) env[key] = '';
for (const key of ['SESSION_HMAC_KEY', 'CSRF_HMAC_KEY', 'TOKEN_HMAC_KEY', 'DATA_ENCRYPTION_KEY', 'AUDIT_PSEUDONYMIZATION_KEY']) {
  env[key] = randomBytes(32).toString('base64');
}
function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(['scripts/migrate.mjs']);
run(['scripts/migrate.mjs']);
// A Prisma model that the SQL migrations do not back is a runtime 500 waiting
// to happen; fail the suite before any test runs.
run(['scripts/check-schema-drift.mjs']);
if (certificateBrowser) run(['--test', '--test-name-pattern=^qualification completion|^browser certificate acceptance', 'tests/integration/catalog.test.cjs']);
else if (certificateRestore) {
  run(['--test', '--test-name-pattern=^qualification completion|^certificate queue:', 'tests/integration/catalog.test.cjs']);
  run(['tests/restore/certificate-drill.cjs']);
} else run(['--test', '--test-concurrency=1', 'tests/integration/runtime-role.test.cjs', 'tests/integration/identity.test.cjs', 'tests/integration/catalog.test.cjs',
  'tests/integration/commerce.test.cjs', 'tests/integration/guest-checkout.test.cjs',
  'tests/integration/refunds.test.cjs', 'tests/integration/retention.test.cjs',
  'tests/integration/stripe-webhook.test.cjs']);
