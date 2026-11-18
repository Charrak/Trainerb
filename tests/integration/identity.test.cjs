const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const request = require('supertest');
const Redis = require('ioredis');
const OTPAuth = require('otpauth');
const argon2 = require('argon2');
const { Queue, Worker } = require('bullmq');
const { dispatchDueMail } = require('../../apps/api/dist/mail-dispatcher');
const { createApplication } = require('../../apps/api/dist/application');
const { Database } = require('../../apps/api/dist/database');
const { RateLimiter } = require('../../apps/api/dist/limiter');
const { MailWorker } = require('../../apps/api/dist/mail-worker');
const { seedCatalog } = require('../../apps/api/dist/cli/catalog');
const { getConfig } = require('../../apps/api/dist/config');
const { unseal } = require('../../apps/api/dist/security');
const { normalizePersonName } = require('@trainerb/contracts');

const origin = 'https://academy.test';
let app, db, server, redis;
const address = n => `${n}@example.invalid`;
const PASSWORD = 'Kranich!Sonne2026';
const PASSWORD2 = 'Lavendel!Wolke2027';

class Browser {
  constructor() { this.cookies = new Map(); }
  collect(response) {
    for (const line of response.headers['set-cookie'] || []) {
      const pair = line.split(';', 1)[0]; const at = pair.indexOf('=');
      const name = pair.slice(0, at), value = pair.slice(at + 1);
      if (!value || /max-age=0/i.test(line)) this.cookies.delete(name); else this.cookies.set(name, value);
    }
    return response;
  }
  cookie() { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '); }
  async get(path) {
    const r = request(server).get(`/api/v1${path}`);
    if (this.cookies.size) r.set('Cookie', this.cookie());
    return this.collect(await r);
  }
  async csrf() { const response = await this.get('/auth/csrf'); assert.equal(response.status, 200); return response.body.csrf_token; }
  async change(method, path, body, options = {}) {
    const csrf = options.noCsrf ? '' : await this.csrf();
    const r = request(server)[method](`/api/v1${path}`).set('Origin', options.origin || origin);
    if (this.cookies.size) r.set('Cookie', this.cookie());
    if (csrf) r.set('X-CSRF-Token', csrf);
    if (body !== undefined) r.send(body);
    return this.collect(await r);
  }
}
async function count(table) { return db[table].count(); }
async function outboxToken(userId, purpose) {
  const outbox = await db.emailOutbox.findFirst({ where: { user_id: userId, template_version: { template: { key: purpose } } }, orderBy: { created_at: 'desc' } });
  assert.ok(outbox?.variables_secret_ciphertext, `missing ${purpose} token`);
  return { raw: unseal(outbox.variables_secret_ciphertext, `outbox:${outbox.id}`, outbox.secret_key_id).token, outbox };
}
async function register(email, first = 'Mila', last = 'Beispiel') {
  const browser = new Browser();
  const response = await browser.change('post', '/auth/register', { email, first_name: first, last_name: last });
  assert.equal(response.status, 202, JSON.stringify(response.body));
  const user = await db.user.findUniqueOrThrow({ where: { email_canonical: email.toLowerCase() } });
  return { user, browser };
}
async function activate(user, password = PASSWORD) {
  const { raw } = await outboxToken(user.id, 'activation');
  const browser = new Browser();
  const response = await browser.change('post', '/auth/activate', { token: raw, password });
  assert.equal(response.status, 204, JSON.stringify(response.body));
  return { browser, token: raw };
}
async function login(browser, email, password = PASSWORD) {
  return browser.change('post', '/auth/login', { email, password });
}

before(async () => {
  assert.equal(process.env.TRAINERB_DESTRUCTIVE_TEST_DATABASE, 'confirmed');
  assert.match(new URL(process.env.DATABASE_URL).pathname, /_test$/);
  app = await createApplication();
  // Keep one loopback listener open for the suite; supertest must not close an
  // ephemeral server while another concurrent request is still in flight.
  await app.listen(0, '127.0.0.1'); server = app.getHttpServer(); db = app.get(Database);
  await db.$executeRawUnsafe('TRUNCATE TABLE courses, users, roles, permissions, email_templates, email_template_versions, email_outbox, automation_jobs, automation_job_attempts RESTART IDENTITY CASCADE');
  await seedCatalog(db);
  redis = new Redis(process.env.REDIS_URL);
  const keys = await redis.keys('trainerb:rl:*');
  if (keys.length) await redis.del(...keys);
});
after(async () => { if (redis) redis.disconnect(); if (app) await app.close(); });

test('documented name rule agrees with PostgreSQL and invalid registrations leave no records', async () => {
  const beforeCounts = await Promise.all(['user', 'accountToken', 'emailOutbox'].map(count));
  const browser = new Browser();
  for (const bad of [undefined, null, '', ' \u00a0\u200b\u202f ', '\u200c\u200d\u2060', 'a\nb', '😀'.repeat(121)]) {
    for (const field of ['first_name', 'last_name']) {
      const body = { email: address('invalid'), first_name: 'Mila', last_name: 'Beispiel', [field]: bad };
      const result = await browser.change('post', '/auth/register', body);
      assert.equal(result.status, 422, `${field} ${String(bad)}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.code, 'INVALID_NAME');
    }
  }
  assert.deepEqual(await Promise.all(['user', 'accountToken', 'emailOutbox'].map(count)), beforeCounts);
  for (const sample of ['Ada', 'Özlem', 'محمد\u200cرضا', '😀'.repeat(120), '😀'.repeat(121),
    ' ', '\u200b', '\u200c\u2060', 'A\nB', '\u00a0Ada\u00a0', 'A\u2028B']) {
    const result = normalizePersonName(sample);
    const [{ valid }] = await db.$queryRaw`SELECT valid_person_name(${sample}::text) AS valid`;
    const expectedStored = result.ok && result.value === sample;
    assert.equal(valid, expectedStored, `DB rule differs for ${JSON.stringify(sample)}`);
    if (result.ok) {
      const [{ valid: normalized }] = await db.$queryRaw`SELECT valid_person_name(${result.value}::text) AS valid`;
      assert.equal(normalized, true);
    }
  }
  await assert.rejects(db.$executeRaw`INSERT INTO users (id, email_original, email_canonical, first_name, last_name, status)
    VALUES ('018e0000-0000-7000-8000-000000000001'::uuid, 'x@example.invalid', 'x@example.invalid', NULL, 'Valid', 'pending_activation')`);
});

test('bootstrap validates all fields, is one-time and never sets a fixed password', async () => {
  const beforeCounts = await Promise.all(['user', 'accountToken', 'emailOutbox', 'userRole'].map(count));
  const env = { ...process.env, BOOTSTRAP_ADMIN_EMAIL: address('super'), BOOTSTRAP_ADMIN_FIRST_NAME: 'Lea', BOOTSTRAP_ADMIN_LAST_NAME: 'Beispiel' };
  for (const [field, value] of [['BOOTSTRAP_ADMIN_EMAIL', ''], ['BOOTSTRAP_ADMIN_FIRST_NAME', ''],
    ['BOOTSTRAP_ADMIN_LAST_NAME', ''], ['BOOTSTRAP_ADMIN_FIRST_NAME', '\u200b\u00a0'], ['BOOTSTRAP_ADMIN_LAST_NAME', '😀'.repeat(121)]]) {
    assert.throws(() => execFileSync(process.execPath, ['apps/api/dist/cli/bootstrap.js'], { env: { ...env, [field]: value }, stdio: 'pipe' }));
    assert.deepEqual(await Promise.all(['user', 'accountToken', 'emailOutbox', 'userRole'].map(count)), beforeCounts);
  }
  execFileSync(process.execPath, ['apps/api/dist/cli/bootstrap.js'], { env, stdio: 'pipe' });
  execFileSync(process.execPath, ['apps/api/dist/cli/bootstrap.js'], { env, stdio: 'pipe' });
  const user = await db.user.findUniqueOrThrow({ where: { email_canonical: address('super') }, include: { roles: { include: { role: true } } } });
  assert.equal(user.password_hash, null);
  assert.deepEqual(user.roles.map(x => x.role.key).sort(), ['participant', 'superadmin']);
  assert.equal(await db.user.count({ where: { email_canonical: address('super') } }), 1);
  assert.equal(await db.accountToken.count({ where: { user_id: user.id } }), 1);
  assert.throws(() => execFileSync(process.execPath, ['apps/api/dist/cli/bootstrap.js'], { env: { ...env, BOOTSTRAP_ADMIN_EMAIL: address('other') }, stdio: 'pipe' }));
});

test('concurrent registration, one-use activation, cookies, CSRF and profile protection', async () => {
  const a = new Browser(), b = new Browser();
  const body1 = { email: 'MILA@example.invalid', first_name: 'Mila', last_name: 'Beispiel' };
  const body2 = { email: 'mila@example.invalid', first_name: 'Fremd', last_name: 'Name' };
  const [first, second] = await Promise.all([a.change('post', '/auth/register', body1), b.change('post', '/auth/register', body2)]);
  assert.deepEqual([first.status, second.status], [202, 202]);
  assert.deepEqual(first.body, second.body);
  const users = await db.user.findMany({ where: { email_canonical: address('mila') } });
  assert.equal(users.length, 1);
  const user = users[0];
  assert.ok(['Mila', 'Fremd'].includes(user.first_name));
  assert.equal(await db.accountToken.count({ where: { user_id: user.id } }), 1);
  assert.equal(await db.emailOutbox.count({ where: { user_id: user.id } }), 1);
  const { token, browser } = await activate(user);
  assert.equal((await browser.change('post', '/auth/activate', { token, password: PASSWORD })).status, 410);
  assert.equal((await browser.change('post', '/auth/login', { email: address('mila'), password: PASSWORD }, { noCsrf: true })).status, 403);
  assert.equal((await browser.change('post', '/auth/login', { email: address('mila'), password: PASSWORD }, { origin: 'https://evil.invalid' })).status, 403);
  const signedIn = await login(browser, address('mila'));
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.body.status, 'authenticated');
  const setCookies = signedIn.headers['set-cookie'];
  assert.ok(setCookies.some(c => c.startsWith('__Host-session=') && /Secure/i.test(c) && /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c) && !/Domain=/i.test(c)));
  const me = await browser.get('/me');
  assert.equal(me.status, 200); assert.equal(me.body.email, user.email_original);
  assert.equal(Object.hasOwn(me.body, 'password_hash'), false);
  assert.equal((await browser.get('/admin/users')).status, 403);
  const changed = await browser.change('patch', '/me', { first_name: '  José\u00a0', last_name: 'Example' });
  assert.equal(changed.status, 200); assert.equal(changed.body.first_name, 'José');
  const rejected = await browser.change('patch', '/me', { first_name: 'Changed', last_name: null });
  assert.equal(rejected.status, 422);
  const after = await browser.get('/me'); assert.equal(after.body.first_name, 'José'); assert.equal(after.body.last_name, 'Example');
  await assert.rejects(db.user.update({ where: { id: user.id }, data: { first_name: null } }));
  assert.equal((await browser.change('post', '/auth/logout')).status, 204);
  assert.equal((await browser.get('/me')).status, 401);
});

test('expired activation links are rejected and opening a link does not activate an account', async () => {
  const { user } = await register(address('expired-activation'));
  const expired = (await outboxToken(user.id, 'activation')).raw;
  await db.accountToken.updateMany({ where: { user_id: user.id, purpose: 'activation' }, data: { expires_at: new Date(Date.now() - 1000) } });
  assert.equal((await new Browser().get('/auth/activate')).status, 404);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: user.id } })).status, 'pending_activation');
  assert.equal((await new Browser().change('post', '/auth/activate', { token: expired, password: PASSWORD })).status, 410);
  assert.equal((await new Browser().change('post', '/auth/activation/request', { email: address('expired-activation') })).status, 202);
  const fresh = (await outboxToken(user.id, 'activation')).raw;
  assert.notEqual(fresh, expired);
  assert.equal((await new Browser().change('post', '/auth/activate', { token: fresh, password: PASSWORD })).status, 204);
});

test('reset is single-use, revokes sessions and creates a notification', async () => {
  const { user } = await register(address('reset')); await activate(user);
  const browser = new Browser(); assert.equal((await login(browser, address('reset'))).status, 200);
  const beforeSessions = await db.authSession.count({ where: { user_id: user.id, revoked_at: null } }); assert.equal(beforeSessions, 1);
  const requester = new Browser();
  const known = await requester.change('post', '/auth/password-reset/request', { email: address('reset') });
  const unknown = await requester.change('post', '/auth/password-reset/request', { email: address('unknown-reset') });
  assert.equal(known.status, 202); assert.deepEqual(known.body, unknown.body);
  const { raw } = await outboxToken(user.id, 'password_reset');
  const [one, two] = await Promise.all([
    new Browser().change('post', '/auth/password-reset/confirm', { token: raw, password: PASSWORD2 }),
    new Browser().change('post', '/auth/password-reset/confirm', { token: raw, password: PASSWORD2 }),
  ]);
  assert.deepEqual([one.status, two.status].sort(), [204, 410]);
  assert.equal((await browser.get('/me')).status, 401);
  assert.equal((await login(new Browser(), address('reset'), PASSWORD)).status, 401);
  assert.equal((await login(new Browser(), address('reset'), PASSWORD2)).status, 200);
  assert.equal(await db.emailOutbox.count({ where: { user_id: user.id, template_version: { template: { key: 'password_changed' } } } }), 1);
});

test('email changes reauthenticate, resolve a parallel collision and invalidate old reset links', async () => {
  const a = await register(address('change-a')); const b = await register(address('change-b'));
  await activate(a.user); await activate(b.user);
  const ba = new Browser(), bb = new Browser();
  assert.equal((await login(ba, address('change-a'))).status, 200);
  assert.equal((await login(bb, address('change-b'))).status, 200);
  assert.equal((await ba.change('post', '/me/email-change/request', { new_email: address('shared') })).status, 403);
  await new Browser().change('post', '/auth/password-reset/request', { email: address('change-a') });
  const oldReset = (await outboxToken(a.user.id, 'password_reset')).raw;
  assert.equal((await ba.change('post', '/auth/reauth', { password: PASSWORD })).status, 204);
  assert.equal((await bb.change('post', '/auth/reauth', { password: PASSWORD })).status, 204);
  assert.equal((await ba.change('post', '/me/email-change/request', { new_email: address('shared') })).status, 202);
  assert.equal((await bb.change('post', '/me/email-change/request', { new_email: address('shared') })).status, 202);
  const ta = (await outboxToken(a.user.id, 'email_change')).raw, tb = (await outboxToken(b.user.id, 'email_change')).raw;
  const [ra, rb] = await Promise.all([
    new Browser().change('post', '/auth/email-change/confirm', { token: ta }),
    new Browser().change('post', '/auth/email-change/confirm', { token: tb }),
  ]);
  assert.deepEqual([ra.status, rb.status].sort(), [204, 409], `${ra.status} ${rb.status}`);
  assert.equal(await db.user.count({ where: { email_canonical: address('shared') } }), 1);
  if (ra.status === 204) {
    assert.equal((await new Browser().change('post', '/auth/password-reset/confirm', { token: oldReset, password: PASSWORD2 })).status, 410);
    assert.equal((await ba.get('/me')).status, 401);
    assert.equal(await db.emailOutbox.count({ where: { user_id: a.user.id, to_email: address('change-a'), template_version: { template: { key: 'email_changed_old' } } } }), 1);
  }
  // Also verify deterministically, regardless of which concurrent update won.
  const c = await register(address('change-c')); await activate(c.user);
  const bc = new Browser(); await login(bc, address('change-c'));
  await new Browser().change('post', '/auth/password-reset/request', { email: address('change-c') });
  const cReset = (await outboxToken(c.user.id, 'password_reset')).raw;
  assert.equal((await bc.change('post', '/auth/reauth', { password: PASSWORD })).status, 204);
  assert.equal((await bc.change('post', '/me/email-change/request', { new_email: address('change-c-new') })).status, 202);
  const cChange = (await outboxToken(c.user.id, 'email_change')).raw;
  assert.equal((await new Browser().change('post', '/auth/email-change/confirm', { token: cChange })).status, 204);
  assert.equal((await new Browser().change('post', '/auth/password-reset/confirm', { token: cReset, password: PASSWORD2 })).status, 410);
  assert.equal((await bc.get('/me')).status, 401);
  assert.equal(await db.emailOutbox.count({ where: { user_id: c.user.id, to_email: address('change-c'), template_version: { template: { key: 'email_changed_old' } } } }), 1);
});

test('password changes revoke every session and pending reset token', async () => {
  const { user } = await register(address('password-change')); await activate(user);
  const first = new Browser(), second = new Browser();
  assert.equal((await login(first, address('password-change'))).status, 200);
  assert.equal((await login(second, address('password-change'))).status, 200);
  await new Browser().change('post', '/auth/password-reset/request', { email: address('password-change') });
  const token = (await outboxToken(user.id, 'password_reset')).raw;
  assert.equal((await first.change('put', '/me/password', { current_password: PASSWORD, new_password: PASSWORD2 })).status, 204);
  assert.equal((await first.get('/me')).status, 401); assert.equal((await second.get('/me')).status, 401);
  assert.equal((await new Browser().change('post', '/auth/password-reset/confirm', { token, password: PASSWORD })).status, 410);
  assert.equal((await login(new Browser(), address('password-change'), PASSWORD)).status, 401);
  assert.equal((await login(new Browser(), address('password-change'), PASSWORD2)).status, 200);
});

test('successful login upgrades an outdated Argon2id hash', async () => {
  const { user } = await register(address('rehash')); await activate(user);
  const oldHash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 8192, timeCost: 2, parallelism: 1 });
  await db.user.update({ where: { id: user.id }, data: { password_hash: oldHash } });
  assert.equal((await login(new Browser(), address('rehash'))).status, 200);
  const updated = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.notEqual(updated.password_hash, oldHash);
  assert.equal(argon2.needsRehash(updated.password_hash, { memoryCost: 65536, timeCost: 3, parallelism: 1 }), false);
  assert.equal(await argon2.verify(updated.password_hash, PASSWORD), true);
});

test('login rotates cookies, rejects old and idle sessions, and blocked accounts cannot log in', async () => {
  const { user } = await register(address('session')); await activate(user);
  const browser = new Browser(); assert.equal((await login(browser, address('session'))).status, 200);
  const oldCookies = new Map(browser.cookies);
  assert.equal((await login(browser, address('session'))).status, 200);
  assert.notEqual(browser.cookies.get('__Host-session'), oldCookies.get('__Host-session'));
  const old = new Browser(); old.cookies = oldCookies; assert.equal((await old.get('/me')).status, 401);
  await db.authSession.updateMany({ where: { user_id: user.id, revoked_at: null }, data: { last_seen_at: new Date(Date.now() - 25 * 60 * 60_000) } });
  assert.equal((await browser.get('/me')).status, 401);
  await db.user.update({ where: { id: user.id }, data: { status: 'blocked' } });
  assert.equal((await login(new Browser(), address('session'))).status, 401);
  const tokens = await db.accountToken.count({ where: { user_id: user.id } });
  assert.equal((await new Browser().change('post', '/auth/password-reset/request', { email: address('session') })).status, 202);
  assert.equal(await db.accountToken.count({ where: { user_id: user.id } }), tokens);
});

test('login failure limit is enforced per email and IP without a permanent account lock', async () => {
  const { user } = await register(address('limit')); await activate(user);
  const browser = new Browser();
  for (let i = 0; i < 5; i++) assert.equal((await login(browser, address('limit'), 'wrong-password')).status, 401);
  assert.equal((await login(browser, address('limit'))).status, 429);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: user.id } })).status, 'active');
});

test('a login validated before a concurrent reset cannot create a session afterwards', async () => {
  const { user } = await register(address('race')); await activate(user);
  await new Browser().change('post', '/auth/password-reset/request', { email: address('race') });
  const token = (await outboxToken(user.id, 'password_reset')).raw;
  const limiter = app.get(RateLimiter); const original = limiter.checkLogin.bind(limiter);
  let validated, resume; const reached = new Promise(resolve => { validated = resolve; }); const gate = new Promise(resolve => { resume = resolve; });
  limiter.checkLogin = async (email, ip, callback) => {
    const result = await original(email, ip, callback);
    if (email === address('race') && result) { validated(); await gate; }
    return result;
  };
  try {
    const loginPromise = login(new Browser(), address('race'));
    await Promise.race([reached, new Promise((_, reject) => setTimeout(() => reject(new Error('login did not reach barrier')), 10_000))]);
    const reset = await new Browser().change('post', '/auth/password-reset/confirm', { token, password: PASSWORD2 });
    assert.equal(reset.status, 204);
    resume();
    assert.equal((await loginPromise).status, 401);
    assert.equal(await db.authSession.count({ where: { user_id: user.id, revoked_at: null } }), 0);
  } finally { resume(); limiter.checkLogin = original; }
});

test('backoffice requires MFA, protects the last superadmin and uses recovery codes only once', async () => {
  const superUser = await db.user.findUniqueOrThrow({ where: { email_canonical: address('super') } });
  await activate(superUser);
  const admin = new Browser();
  const firstLogin = await login(admin, address('super'));
  assert.equal(firstLogin.status, 202); assert.equal(firstLogin.body.status, 'mfa_enrollment_required');
  assert.equal((await admin.get('/me')).status, 403);
  assert.equal((await admin.get('/admin/users')).status, 403);
  const setup = await admin.change('post', '/auth/mfa/enrollment/start', {});
  assert.equal(setup.status, 200);
  const totp = new OTPAuth.TOTP({ issuer: 'Online-Akademie', label: address('super'), algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(setup.body.secret) });
  const usedCode = totp.generate();
  const confirmed = await admin.change('post', '/auth/mfa/enrollment/confirm', { code: usedCode });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.recovery_codes.length, 10);
  const factor = await db.userMfaFactor.findFirstOrThrow({ where: { user_id: superUser.id, status: 'active' } });
  assert.equal(Buffer.from(factor.secret_ciphertext).includes(Buffer.from(setup.body.secret)), false);
  const firstPage = await admin.get('/admin/users?limit=3');
  assert.equal(firstPage.status, 200); assert.equal(firstPage.body.data.length, 3); assert.ok(firstPage.body.next_cursor);
  assert.equal(Object.hasOwn(firstPage.body.data[0], 'password_hash'), false);
  const nextPage = await admin.get(`/admin/users?limit=3&cursor=${firstPage.body.next_cursor}`);
  assert.equal(nextPage.status, 200);
  assert.ok(nextPage.body.data.every(x => !firstPage.body.data.some(y => y.id === x.id)));
  assert.equal((await admin.get('/admin/users?limit=101')).status, 422);
  const noLast = await admin.change('put', `/admin/users/${superUser.id}/roles`, { role_keys: ['participant'], reason_code: 'staff_change' });
  assert.equal(noLast.status, 409);
  // An unactivated superadmin does not permit removing the only active one.
  const pending = await register(address('pending-super'));
  assert.equal((await admin.change('put', `/admin/users/${pending.user.id}/roles`, { role_keys: ['participant', 'superadmin'], reason_code: 'staff_change' })).status, 200);
  assert.equal((await admin.change('put', `/admin/users/${superUser.id}/roles`, { role_keys: ['participant'], reason_code: 'staff_change' })).status, 409);
  assert.equal((await admin.change('put', `/admin/users/${pending.user.id}/roles`, { role_keys: ['participant'], reason_code: 'correction' })).status, 200);
  const target = await db.user.findUniqueOrThrow({ where: { email_canonical: address('reset') } });
  const targetBrowser = new Browser(); assert.equal((await login(targetBrowser, address('reset'), PASSWORD2)).status, 200);
  const grant = await admin.change('put', `/admin/users/${target.id}/roles`, { role_keys: ['participant', 'admin'], reason_code: 'staff_change' });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  assert.equal((await targetBrowser.get('/me')).status, 401);
  assert.equal((await login(new Browser(), address('reset'), PASSWORD2)).body.status, 'mfa_enrollment_required');
  assert.equal(await db.auditEvent.count({ where: { action: 'roles.changed', target_ref: target.id } }), 1);
  assert.equal((await admin.change('post', '/auth/logout')).status, 204);
  assert.equal((await login(admin, address('super'))).body.status, 'mfa_required');
  assert.equal((await admin.change('post', '/auth/mfa/challenge', { code: usedCode })).status, 401);
  assert.equal((await admin.change('post', '/auth/mfa/challenge', { recovery_code: confirmed.body.recovery_codes[0] })).status, 200);
  assert.equal((await admin.change('post', '/auth/logout')).status, 204);
  assert.equal((await login(admin, address('super'))).body.status, 'mfa_required');
  assert.equal((await admin.change('post', '/auth/mfa/challenge', { recovery_code: confirmed.body.recovery_codes[0] })).status, 401);
  const another = new Browser(); assert.equal((await login(another, address('super'))).status, 202);
  const [r1, r2] = await Promise.all([
    admin.change('post', '/auth/mfa/challenge', { recovery_code: confirmed.body.recovery_codes[1] }),
    another.change('post', '/auth/mfa/challenge', { recovery_code: confirmed.body.recovery_codes[1] }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 401]);
});

test('durable outbox retries delivery, suppresses revoked tokens and removes secret material', async () => {
  const sent = [];
  const okTransport = { sendMail: async message => { sent.push(message); return { accepted: [message.to], messageId: message.messageId }; } };
  const worker = new MailWorker(db, okTransport);
  while (await worker.runOne()) { /* drain earlier test jobs */ }
  sent.length = 0;
  const { user } = await register(address('mail'));
  const original = await outboxToken(user.id, 'activation');
  assert.equal(Buffer.from(original.outbox.variables_secret_ciphertext).includes(Buffer.from(original.raw)), false);
  assert.equal(Buffer.from((await db.accountToken.findFirstOrThrow({ where: { user_id: user.id } })).token_hash).includes(Buffer.from(original.raw)), false);
  await new Browser().change('post', '/auth/activation/request', { email: address('mail') });
  const newest = await outboxToken(user.id, 'activation');
  assert.notEqual(newest.raw, original.raw);
  assert.equal(await worker.runOne(), true); // old revoked token is suppressed
  assert.equal((await db.emailOutbox.findUniqueOrThrow({ where: { id: original.outbox.id } })).status, 'suppressed');
  const failing = new MailWorker(db, { sendMail: async () => { throw new Error('sensitive transport failure'); } });
  assert.equal(await failing.runOne(), true);
  let job = await db.automationJob.findFirstOrThrow({ where: { ref_id: newest.outbox.id } });
  assert.equal(job.status, 'queued'); assert.equal(job.attempts, 1); assert.equal(job.last_error_safe, 'MAIL_DELIVERY_FAILED');
  let pending = await db.emailOutbox.findUniqueOrThrow({ where: { id: newest.outbox.id } });
  assert.ok(pending.variables_secret_ciphertext);
  await db.automationJob.update({ where: { id: job.id }, data: { run_after: new Date(0) } });
  assert.equal(await worker.runOne(), true);
  job = await db.automationJob.findUniqueOrThrow({ where: { id: job.id } });
  pending = await db.emailOutbox.findUniqueOrThrow({ where: { id: newest.outbox.id } });
  assert.equal(job.status, 'succeeded'); assert.equal(job.attempts, 2);
  assert.equal(pending.status, 'accepted'); assert.equal(pending.variables_secret_ciphertext, null);
  assert.equal(await db.automationJobAttempt.count({ where: { automation_job_id: job.id } }), 2);
  assert.equal(sent.length, 1); assert.ok(sent[0].text.includes(`/konto/aktivieren#token=${newest.raw}`));
  assert.ok(!sent[0].text.includes(original.raw));
});

test('an expired mail lease is retried and expired secrets are purged', async () => {
  const sent = [];
  const worker = new MailWorker(db, { sendMail: async message => { sent.push(message); return { accepted: [message.to], messageId: message.messageId }; } });
  const lease = await register(address('lease'));
  const { outbox } = await outboxToken(lease.user.id, 'activation');
  const job = await db.automationJob.findFirstOrThrow({ where: { ref_id: outbox.id } });
  await db.automationJob.update({ where: { id: job.id }, data: { status: 'running', attempts: 1, lease_until: new Date(Date.now() - 1000) } });
  await db.emailOutbox.update({ where: { id: outbox.id }, data: { status: 'sending', attempts: 1 } });
  assert.equal(await worker.runOne(job.id), true);
  assert.equal((await db.automationJob.findUniqueOrThrow({ where: { id: job.id } })).status, 'succeeded');
  const attempts = await db.automationJobAttempt.findMany({ where: { automation_job_id: job.id }, orderBy: { attempt_no: 'asc' } });
  assert.deepEqual(attempts.map(x => x.result), ['failed', 'succeeded']);
  assert.equal(attempts[0].error_safe, 'LEASE_EXPIRED_DELIVERY_OUTCOME_UNKNOWN');
  const expiring = await register(address('expired-mail'));
  const expired = await outboxToken(expiring.user.id, 'activation');
  await db.emailOutbox.update({ where: { id: expired.outbox.id }, data: { secret_delete_after: new Date(Date.now() - 1000) } });
  await worker.purgeExpiredSecrets();
  const expiredJob = await db.automationJob.findFirstOrThrow({ where: { ref_id: expired.outbox.id } });
  await worker.runOne(expiredJob.id);
  const suppressed = await db.emailOutbox.findUniqueOrThrow({ where: { id: expired.outbox.id } });
  assert.equal(suppressed.status, 'suppressed'); assert.equal(suppressed.variables_secret_ciphertext, null);
  assert.equal(sent.length, 1);
});

test('a lost BullMQ item is reconstructed from the durable PostgreSQL job', async () => {
  const { user } = await register(address('queue'));
  const { outbox } = await outboxToken(user.id, 'activation');
  const name = `integration-mail-${Date.now()}`;
  const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue(name, { connection, prefix: 'trainerb-test' });
  const sent = [];
  const mailer = new MailWorker(db, { sendMail: async message => { sent.push(message); return { accepted: [message.to], messageId: message.messageId }; } });
  let consumer;
  try {
    const enqueue = jobId => queue.add('email.send', { job_id: jobId }, { jobId, removeOnComplete: true, removeOnFail: true });
    await dispatchDueMail(db, enqueue);
    await queue.drain(); // simulate Redis losing its ephemeral queue items
    assert.equal((await db.emailOutbox.findUniqueOrThrow({ where: { id: outbox.id } })).status, 'queued');
    await dispatchDueMail(db, enqueue);
    const done = new Promise((resolve, reject) => {
      consumer = new Worker(name, job => mailer.runOne(job.data.job_id), { connection, prefix: 'trainerb-test' });
      consumer.on('completed', () => resolve()); consumer.on('error', reject); consumer.on('failed', (_job, error) => reject(error));
      setTimeout(() => reject(new Error('BullMQ did not process the job')), 10_000).unref();
    });
    await done;
    assert.equal(sent.length, 1);
    const delivered = await db.emailOutbox.findUniqueOrThrow({ where: { id: outbox.id } });
    assert.equal(delivered.status, 'accepted'); assert.equal(delivered.variables_secret_ciphertext, null);
  } finally {
    if (consumer) await consumer.close();
    await queue.obliterate({ force: true }); await queue.close(); connection.disconnect();
  }
});

test('authentication rate limit fails closed if Redis is unavailable', async () => {
  const cfg = getConfig(), originalUrl = cfg.redisUrl;
  cfg.redisUrl = 'redis://127.0.0.1:1/15';
  const limiter = new RateLimiter(); cfg.redisUrl = originalUrl;
  try {
    await assert.rejects(limiter.hit('test', 'identity', 1), error => error.getStatus?.() === 503);
  } finally { await limiter.onModuleDestroy(); }
});

test('customer support can find and block participant accounts without gaining staff access', async () => {
  const staff = await register(address('customer-support')); await activate(staff.user);
  const role = await db.role.findUniqueOrThrow({ where: { key: 'support' } });
  await db.userRole.create({ data: { user_id: staff.user.id, role_id: role.id } });
  const agent = staff.browser;
  assert.equal((await login(agent, staff.user.email_original)).status, 202);
  const setup = await agent.change('post', '/auth/mfa/enrollment/start', {});
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(setup.body.secret) });
  const confirmed = await agent.change('post', '/auth/mfa/enrollment/confirm', { code: totp.generate() });
  assert.equal(confirmed.status, 200);

  const { user, browser } = await register(address('customer-block'), 'Mara', 'Kundenbeispiel');
  await activate(user); assert.equal((await login(browser, user.email_original)).status, 200);
  const find = (query, status) => agent.change('post', '/admin/customers/search', { query, status });
  const path = `/admin/customers/${user.id}/status`, block = { status: 'blocked', reason_code: 'security' };
  assert.equal((await browser.change('post', '/admin/customers/search', { query: 'Mara' })).status, 403);
  assert.equal((await browser.change('put', path, block)).status, 403);
  assert.equal((await agent.get('/admin/users')).status, 403);
  assert.equal((await find('x')).status, 422);
  assert.deepEqual((await find('%%')).body.data, []);
  assert.deepEqual((await find('customer-support')).body.data, []);
  assert.deepEqual((await find('MARA Kundenbeispiel', 'active')).body.data, [{ id: user.id, first_name: 'Mara',
    last_name: 'Kundenbeispiel', email_original: user.email_original, status: 'active' }]);
  assert.equal((await agent.change('put', `/admin/customers/${staff.user.id}/status`, block)).status, 404);
  assert.equal((await agent.change('put', path, block, { noCsrf: true })).status, 403);
  assert.equal((await agent.change('put', path, { ...block, reason_code: 'other' })).status, 422);
  await db.authSession.updateMany({ where: { user_id: staff.user.id }, data: { reauthenticated_at: null } });
  assert.equal((await agent.change('put', path, block)).body.code, 'REAUTH_REQUIRED');
  assert.equal((await agent.change('post', '/auth/reauth', { password: PASSWORD, recovery_code: confirmed.body.recovery_codes[0] })).status, 204);

  assert.equal((await agent.change('put', path, block)).status, 200);
  assert.equal((await browser.get('/me')).status, 401);
  assert.equal((await login(new Browser(), user.email_original)).status, 401);
  assert.equal((await find(user.email_original, 'blocked')).body.data[0].id, user.id);
  assert.deepEqual((await find(user.email_original, 'active')).body.data, []);
  const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'customer.blocked', target_ref: user.id } });
  assert.equal(audit.actor_user_id, staff.user.id); assert.equal(audit.reason_code, 'security');
  assert.deepEqual(audit.before_safe, { status: 'active' }); assert.deepEqual(audit.after_safe, { status: 'blocked' });
  assert.equal((await agent.change('put', path, { status: 'active', reason_code: 'correction' })).status, 200);
  assert.equal((await browser.get('/me')).status, 401, 'unblocking must not revive a revoked session');
  assert.equal((await login(new Browser(), user.email_original)).status, 200);
});
