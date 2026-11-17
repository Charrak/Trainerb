const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS', moduleResolution: 'Node' } });
const { testInboxEnabled, localTestAction } = require('../../apps/web/lib/test-inbox.ts');

test('the test inbox is off by default and cannot be enabled in production', () => {
  const previous = { NODE_ENV: process.env.NODE_ENV, TRAINERB_TEST_INBOX: process.env.TRAINERB_TEST_INBOX };
  try {
    process.env.NODE_ENV = 'development'; delete process.env.TRAINERB_TEST_INBOX;
    assert.equal(testInboxEnabled(), false);
    process.env.TRAINERB_TEST_INBOX = 'true';
    assert.equal(testInboxEnabled(), true);
    for (const env of ['test', 'production']) { process.env.NODE_ENV = env; assert.equal(testInboxEnabled(), false); }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('test mail links can only target known actions on the current origin', () => {
  const token = 'A'.repeat(43);
  assert.equal(localTestAction(`Link: https://elsewhere.invalid/konto/aktivieren#token=${token}`), `/konto/aktivieren#token=${token}`);
  assert.equal(localTestAction(`https://example.invalid/konto/passwort-zuruecksetzen#token=${token}`), `/konto/passwort-zuruecksetzen#token=${token}`);
  assert.equal(localTestAction(`https://example.invalid/konto/email-bestaetigen#token=${token}`), `/konto/email-bestaetigen#token=${token}`);
  for (const text of [`https://example.invalid/other#token=${token}`,
    `https://example.invalid/konto/aktivieren?next=https://bad.invalid#token=${token}`,
    `https://example.invalid/konto/aktivieren#token=too-short`, `javascript://example.invalid/konto/aktivieren#token=${token}`]) {
    assert.equal(localTestAction(text), null);
  }
});

function cookieProbe(overrides = {}) {
  const script = `
    require('reflect-metadata');
    try {
      const config = require('./apps/api/dist/config').getConfig();
      const { Sessions } = require('./apps/api/dist/sessions');
      const cookies = [];
      new Sessions(null).setCookies({cookie:(name, value, options) => cookies.push({name, options})},
        {token:'synthetic', csrf:'synthetic', duration:10000});
      process.stdout.write(JSON.stringify({preview:config.embeddedPreviewCookies, cookies}));
    } catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
  `;
  const env = { ...process.env, APP_ENV: 'development', NODE_ENV: 'test', PUBLIC_BASE_URL: 'https://academy.test',
    DATABASE_URL: 'postgresql://dev@127.0.0.1:5432/dev', REDIS_URL: 'redis://127.0.0.1:6379/0',
    COMMON_PASSWORDS_FILE: path.resolve('packages/database/data/common-passwords.txt'),
    DATA_ENCRYPTION_KEY_ID: 'test-key', MAIL_FROM: 'test@example.invalid', TRAINERB_EMBEDDED_PREVIEW_COOKIES: 'false',
    ...overrides };
  ['SESSION_HMAC_KEY', 'CSRF_HMAC_KEY', 'TOKEN_HMAC_KEY', 'DATA_ENCRYPTION_KEY', 'AUDIT_PSEUDONYMIZATION_KEY']
    .forEach((key, index) => { env[key] = Buffer.alloc(32, index + 1).toString('base64'); });
  return spawnSync(process.execPath, ['-e', script], { cwd: path.resolve('.'), env, encoding: 'utf8' });
}

test('preview cookies are partitioned only with explicit HTTPS development opt-in', () => {
  const normal = cookieProbe(); assert.equal(normal.status, 0, normal.stderr);
  const defaultPolicy = JSON.parse(normal.stdout); assert.equal(defaultPolicy.preview, false);
  for (const cookie of defaultPolicy.cookies) {
    assert.equal(cookie.options.sameSite, 'lax'); assert.equal(cookie.options.secure, true);
    assert.equal(cookie.options.partitioned, undefined); assert.equal(cookie.options.path, '/');
    assert.equal(cookie.options.domain, undefined);
  }
  const enabled = cookieProbe({ TRAINERB_EMBEDDED_PREVIEW_COOKIES: 'true' }); assert.equal(enabled.status, 0, enabled.stderr);
  const policy = JSON.parse(enabled.stdout); assert.equal(policy.preview, true);
  assert.deepEqual(policy.cookies.map(cookie => cookie.name), ['__Host-session', '__Host-csrf']);
  for (const cookie of policy.cookies) {
    assert.equal(cookie.options.sameSite, 'none'); assert.equal(cookie.options.partitioned, true);
    assert.equal(cookie.options.secure, true); assert.equal(cookie.options.path, '/'); assert.equal(cookie.options.domain, undefined);
  }
  assert.equal(policy.cookies[0].options.httpOnly, true);
  assert.equal(policy.cookies[1].options.httpOnly, false);
  for (const overrides of [
    { APP_ENV: 'production', TRAINERB_EMBEDDED_PREVIEW_COOKIES: 'true' },
    { APP_ENV: 'test', TRAINERB_EMBEDDED_PREVIEW_COOKIES: 'true' },
    { PUBLIC_BASE_URL: 'http://localhost:3000', ALLOW_INSECURE_LOCAL_HTTP: 'true', TRAINERB_EMBEDDED_PREVIEW_COOKIES: 'true' },
  ]) {
    const invalid = cookieProbe(overrides); assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /only for HTTPS development/);
  }
});
