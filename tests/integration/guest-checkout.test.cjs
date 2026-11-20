const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const request = require('supertest');
const Redis = require('ioredis');
const OTPAuth = require('otpauth');
const { uuidv7 } = require('uuidv7');
const { createApplication } = require('../../apps/api/dist/application');
const { Database } = require('../../apps/api/dist/database');
const { seedCatalog } = require('../../apps/api/dist/cli/catalog');
const { seedCommerce } = require('../../apps/api/dist/cli/commerce');
const { unseal } = require('../../apps/api/dist/security');
const { MailWorker } = require('../../apps/api/dist/mail-worker');

const origin = 'https://academy.test';
const password = 'Kranich!Sonne2026';
let app, db, server, redis, admin, adminUser, adminRecovery, course, product, price, proofToken, totp;

class Browser {
  constructor() { this.cookies = new Map(); }
  collect(response) {
    for (const line of response.headers['set-cookie'] || []) {
      const pair = line.split(';', 1)[0], at = pair.indexOf('=');
      const name = pair.slice(0, at), value = pair.slice(at + 1);
      if (!value || /max-age=0|expires=thu, 01 jan 1970/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }
  cookie() { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '); }
  has(name) { return this.cookies.has(name); }
  async get(path) {
    const r = request(server).get(`/api/v1${path}`);
    if (this.cookies.size) r.set('Cookie', this.cookie());
    return this.collect(await r);
  }
  async change(method, path, body) {
    let csrf;
    const token = await this.get('/auth/csrf'); status(token, 200); csrf = token.body.csrf_token;
    const r = request(server)[method](`/api/v1${path}`).set('Origin', origin).set('X-CSRF-Token', csrf);
    if (this.cookies.size) r.set('Cookie', this.cookie());
    if (body !== undefined) r.send(body);
    return this.collect(await r);
  }
}
function status(response, expected) {
  assert.equal(response.status, expected, JSON.stringify(response.body));
}
async function activate(user) {
  const mail = await db.emailOutbox.findFirstOrThrow({ where: { user_id: user.id,
    template_version: { template: { key: 'activation' } } }, orderBy: { created_at: 'desc' } });
  const { token } = unseal(mail.variables_secret_ciphertext, `outbox:${mail.id}`, mail.secret_key_id);
  return new Browser().change('post', '/auth/activate', { token, password });
}
async function freshReauth(browser, userId) {
  await db.authSession.updateMany({ where: { user_id: userId, kind: 'backoffice', revoked_at: null },
    data: { reauthenticated_at: new Date(Date.now() - 10 * 60_000) } });
  // A TOTP step can only be accepted once; the tests re-authenticate many times
  // within the same 30 s step, so the replay counter is rewound deliberately.
  await db.userMfaFactor.updateMany({ where: { user_id: userId, type: 'totp', status: 'active' },
    data: { last_accepted_step: null } });
  // The re-authentication limiter allows ten attempts per quarter hour; this
  // suite deliberately re-authenticates more often than a human ever would.
  const keys = await redis.keys('trainerb:rl:reauth:*'); if (keys.length) await redis.del(...keys);
  status(await browser.change('post', '/auth/reauth', { password, code: totp.generate() }), 204);
}
async function legalVersions() {
  const versions = await db.legalDocumentVersion.findMany({ where: { status: 'active' }, include: { document: true } });
  return Object.fromEntries(versions.map(version => [version.document.kind, version.id]));
}
const address = { company: null, first_name: 'Gast', last_name: 'Käufer', street: 'Gassenweg 7', street_extra: null,
  postal_code: '10115', city: 'Berlin', region: null, country: 'DE', vat_id: null };
/**
 * The guest proof request is limited per IP address (10 per hour). These tests
 * share one loopback address, so each proof request clears that counter first —
 * the limit itself is asserted in its own test below.
 */
async function proofRequest(browser, email, expected = 202) {
  const keys = await redis.keys('trainerb:rl:guest-proof-ip:*'); if (keys.length) await redis.del(...keys);
  const response = await browser.change('post', '/guest/email/verify/request', { email });
  if (expected !== null) status(response, expected);
  return response;
}
async function guestBody(extra = {}) {
  return { idempotency_key: `guest-${uuidv7()}`, billing_address: address, payment_method: 'invoice',
    legal_versions: await legalVersions(), terms_accepted: true, withdrawal_notice_seen: true,
    privacy_notice_seen: true, participant_first_name: 'Gina', participant_last_name: 'Gast', ...extra };
}
/**
 * Read the raw proof token out of the outbox row. The token is sealed, never
 * public: the row itself must not contain a usable link.
 */
async function proofFromOutbox() {
  const mail = await db.emailOutbox.findFirstOrThrow({ where: { user_id: null,
    template_version: { template: { key: 'checkout_email_verify' } } }, orderBy: { created_at: 'desc' } });
  assert.equal(Object.hasOwn(mail.variables_public, 'verify_url'), false, 'no link in public variables');
  const { token } = unseal(mail.variables_secret_ciphertext, `outbox:${mail.id}`, mail.secret_key_id);
  return { token, code: mail.variables_public.code, mail };
}

before(async () => {
  assert.equal(process.env.TRAINERB_DESTRUCTIVE_TEST_DATABASE, 'confirmed');
  assert.match(new URL(process.env.DATABASE_URL).pathname, /_test$/);
  // The card acceptance case uses the real signature verifier, an in-process session provider and no network.
  Object.assign(process.env,{STRIPE_SECRET_KEY:'sk_test_guest_fixture',STRIPE_PUBLISHABLE_KEY:'pk_test_guest_fixture',STRIPE_WEBHOOK_SECRET:'whsec_guest_fixture'});
  app = await createApplication(); await app.listen(0, '127.0.0.1'); server = app.getHttpServer(); db = app.get(Database);
  await db.$executeRawUnsafe('TRUNCATE TABLE courses, users, roles, permissions, email_templates, email_template_versions, email_outbox, automation_jobs, automation_job_attempts RESTART IDENTITY CASCADE');
  await seedCatalog(db); await seedCommerce(db);
  redis = new Redis(process.env.REDIS_URL);
  const keys = await redis.keys('trainerB:rl:*'); if (keys.length) await redis.del(...keys);
  const allKeys = await redis.keys('trainerb:rl:*'); if (allKeys.length) await redis.del(...allKeys);

  execFileSync(process.execPath, ['apps/api/dist/cli/bootstrap.js'], { env: { ...process.env,
    BOOTSTRAP_ADMIN_EMAIL: 'phase4-admin@example.invalid', BOOTSTRAP_ADMIN_FIRST_NAME: 'Test',
    BOOTSTRAP_ADMIN_LAST_NAME: 'Admin' }, stdio: 'pipe' });
  adminUser = await db.user.findUniqueOrThrow({ where: { email_canonical: 'phase4-admin@example.invalid' } });
  await activate(adminUser);
  admin = new Browser();
  const logged = await admin.change('post', '/auth/login', { email: adminUser.email_canonical, password });
  status(logged, 202); assert.equal(logged.body.status, 'mfa_enrollment_required');
  const setup = await admin.change('post', '/auth/mfa/enrollment/start', {}); status(setup, 200);
  totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(setup.body.secret) });
  const confirmed = await admin.change('post', '/auth/mfa/enrollment/confirm', { code: totp.generate() });
  status(confirmed, 200);
  assert.equal(confirmed.body.recovery_codes.length, 10);

  // Published course with one chapter, plus a sellable product.
  const created = await admin.change('post', '/admin/courses', { slug: 'gast-kurs', title: 'Kurs für Gäste',
    visibility: 'public' });
  status(created, 201);
  const version = await db.courseVersion.findFirstOrThrow({ where: { course_id: created.body.id, state: 'draft' } });
  status(await admin.change('patch', `/admin/course-versions/${version.id}`, { revision: version.revision,
    subtitle: 'Mit Inhalt', duration_minutes: 90, expected_module_count: 1, expected_chapter_count: 1 }), 200);
  const moduleResponse = await admin.change('post', `/admin/course-versions/${version.id}/modules`,
    { title: 'Modul Gast', position: 1 }); status(moduleResponse, 201);
  const chapterResponse = await admin.change('post', `/admin/course-modules/${moduleResponse.body.id}/chapters`,
    { title: 'Kapitel Gast', position: 1 }); status(chapterResponse, 201);
  status(await admin.change('post', `/admin/course-chapters/${chapterResponse.body.id}/contents`,
    { block: { kind: 'paragraph', text: 'Inhalt für Gäste.' }, position: 1 }), 201);
  await freshReauth(admin, adminUser.id);
  const draft = await db.courseVersion.findUniqueOrThrow({ where: { id: version.id } });
  status(await admin.change('post', `/admin/courses/${created.body.id}/publish`,
    { version_id: draft.id, revision: draft.revision }), 200);
  course = { id: created.body.id, version_id: version.id, chapter_id: chapterResponse.body.id };

  const productResponse = await admin.change('post', '/admin/products', { sku: 'GUEST-01', type: 'single',
    title: 'Kurs für Gäste (Produkt)', description: 'Buchbar ohne Konto.', courses: [{ course_id: course.id,
      access_days_override: 90 }] });
  status(productResponse, 201);
  price = (await admin.change('post', `/admin/products/${productResponse.body.id}/prices`, { currency: 'EUR',
    gross_cents: '24900', tax_category: 'standard', valid_from: new Date(Date.now() - 60_000).toISOString().slice(0, 16) + 'Z' })).body;
  await freshReauth(admin, adminUser.id);
  const productDraft = await db.product.findUniqueOrThrow({ where: { id: productResponse.body.id } });
  status(await admin.change('post', `/admin/products/${productResponse.body.id}/activate`,
    { revision: productDraft.revision }), 200);
  const priceDraft = await db.price.findUniqueOrThrow({ where: { id: price.id } });
  status(await admin.change('post', `/admin/prices/${price.id}/activate`, { revision: priceDraft.revision }), 200);
  product = productResponse.body;

  // Legal wordings must be active before anything can be ordered.
  for (const kind of ['terms', 'withdrawal', 'privacy']) {
    await admin.change('post', '/admin/commerce/legal', { kind, wording: `Geprüfter Wortlaut ${kind}.` });
    const document = await db.legalDocument.findFirstOrThrow({ where: { kind } });
    const latest = await db.legalDocumentVersion.findFirstOrThrow({ where: { document_id: document.id,
      status: 'draft' }, orderBy: { version: 'desc' } });
    await freshReauth(admin, adminUser.id);
    status(await admin.change('post', `/admin/commerce/legal/${latest.id}/activate`, {}), 200);
  }
  await db.commerceSettings.update({ where: { id: 1 }, data: { sales_enabled: true } });
});
after(async () => { if (redis) redis.disconnect(); if (app) await app.close(); });

test('a guest cart is bound to a browser secret, never to an account', async () => {
  const guest = new Browser();
  // The cart cookie is only set once something is actually in the basket; a
  // browser without a cart gets `200` with an empty basket, never a new cart row.
  const empty = await guest.get('/guest/cart'); status(empty, 200);
  assert.deepEqual(empty.body.items, []);
  assert.equal(guest.has('__Host-guest-cart'), false);
  assert.equal(await db.cart.count(), 0);

  const added = await guest.change('post', '/guest/cart/items', { product_id: product.id });
  status(added, 200);
  assert.equal(added.body.items.length, 1);
  assert.equal(added.body.subtotal_gross_cents, '24900');
  assert.equal(guest.has('__Host-guest-cart'), true);
  assert.equal(await db.cart.count({ where: { user_id: null } }), 1);
  // The database never stores the raw secret.
  const cart = await db.cart.findFirstOrThrow({ where: { user_id: null } });
  assert.ok(cart.guest_secret_hash);
  assert.notEqual(Buffer.from(cart.guest_secret_hash).toString('base64url'), guest.cookies.get('__Host-guest-cart'));

  // A different browser sees its own, empty basket.
  const other = new Browser();
  const otherCart = await other.get('/guest/cart'); status(otherCart, 200);
  assert.deepEqual(otherCart.body.items, []);
  // Removing works on the owner's cart only.
  const stolen = await other.change('delete', `/guest/cart/items/${product.id}`);
  assert.equal(stolen.status, 404);
  const removed = await guest.change('delete', `/guest/cart/items/${product.id}`); status(removed, 200);
  assert.deepEqual(removed.body.items, []);
});

test('checkout without a proven address is impossible, and the proof is single-use', async () => {
  const guest = new Browser();
  status(await guest.change('post', '/guest/cart/items', { product_id: product.id }), 200);
  const blocked = await guest.change('post', '/guest/orders', await guestBody());
  status(blocked, 409); assert.equal(blocked.body.code, 'EMAIL_NOT_VERIFIED');
  assert.equal(await db.order.count(), 0);

  // Empty carts cannot trigger a proof mail.
  const emptyGuest = new Browser();
  const keys = await redis.keys('trainerb:rl:guest-proof-ip:*'); if (keys.length) await redis.del(...keys);
  status(await emptyGuest.change('post', '/guest/email/verify/request', { email: 'leer@example.invalid' }), 409);

  const requested = await proofRequest(guest, 'gina@example.invalid');
  const proof = await proofFromOutbox();
  assert.match(proof.code, /^\d{6}$/);
  // The response is the same for a known and an unknown address (no enumeration).
  const other = new Browser();
  status(await other.change('post', '/guest/cart/items', { product_id: product.id }), 200);
  const secondRequest = await proofRequest(other, 'unbekannt@example.invalid');
  assert.deepEqual(secondRequest.body, requested.body);

  // A bogus token is rejected.
  status(await guest.change('post', '/guest/email/verify/confirm', { token: 'A'.repeat(43) }), 410);
  const confirmed = await guest.change('post', '/guest/email/verify/confirm', { token: proof.token });
  status(confirmed, 200); assert.equal(confirmed.body.verified, true);
  // Ordering needs both proofs: the token for the address and the cart cookie
  // for the basket. Confirming never steals the basket from another device.
  assert.equal(guest.has('__Host-guest-cart'), true);
  const proofState = await guest.get('/guest/email'); status(proofState, 200);
  assert.equal(proofState.body.email_verified, true);
  assert.equal(proofState.body.email, 'gina@example.invalid');
  // A browser without any cart cookie learns nothing about the proof.
  const noCookie = await new Browser().get('/guest/email');
  assert.equal(noCookie.body.email, null);
});

test('proof mails are limited per client so the endpoint cannot be used as a mail cannon', async () => {
  const keys = await redis.keys('trainerb:rl:guest-proof-ip:*'); if (keys.length) await redis.del(...keys);
  const browser = new Browser();
  status(await browser.change('post', '/guest/cart/items', { product_id: product.id }), 200);
  // Deliberately bypass the resetting helper: the limit must accumulate here.
  for (let index = 0; index < 10; index += 1) {
    status(await browser.change('post', '/guest/email/verify/request',
      { email: `menge-${index}@example.invalid` }), 202);
  }
  // The eleventh request in the same hour is refused, and no further mail is queued.
  const queuedBefore = await db.emailOutbox.count({ where: { user_id: null,
    template_version: { template: { key: 'checkout_email_verify' } } } });
  const limited = await browser.change('post', '/guest/email/verify/request', { email: 'menge-11@example.invalid' });
  status(limited, 429); assert.equal(limited.body.code, 'RATE_LIMITED');
  assert.equal(await db.emailOutbox.count({ where: { user_id: null,
    template_version: { template: { key: 'checkout_email_verify' } } } }), queuedBefore);
});

test('a proven guest order is created without an account and grants nothing until paid', async () => {
  const guest = new Browser();
  status(await guest.change('post', '/guest/cart/items', { product_id: product.id }), 200);
  status(await proofRequest(guest, 'gina@example.invalid'), 202);
  proofToken = (await proofFromOutbox()).token;
  status(await guest.change('post', '/guest/email/verify/confirm', { token: proofToken }), 200);

  const body = await guestBody();
  const placed = await guest.change('post', '/guest/orders', body);
  status(placed, 201);
  assert.equal(placed.body.identity_kind, 'guest');
  assert.equal(placed.body.payment_state, 'awaiting');
  assert.equal(placed.body.account_linked, false);
  assert.equal(placed.body.total_gross_cents, '24900');
  assert.equal(placed.body.buyer_email, 'gina@example.invalid');
  assert.match(placed.body.order_number, /^TB-\d{4}-\d{6}$/);
  assert.ok(placed.body.invoice.invoice_number.startsWith('TB-RE-'));
  assert.ok(placed.body.bank.iban);

  // No account exists yet, so nothing was granted and nothing could be.
  assert.equal(await db.user.count({ where: { email_canonical: 'gina@example.invalid' } }), 0);
  assert.equal(await db.courseAccess.count(), 0);
  const orderRow = await db.order.findUniqueOrThrow({ where: { id: placed.body.id } });
  assert.equal(orderRow.user_id, null);
  assert.equal(orderRow.fulfillment_state, 'waiting');
  // The database refuses fulfilment for an unlinked guest order.
  await assert.rejects(db.order.update({ where: { id: placed.body.id }, data: { fulfillment_state: 'fulfilled',
    fulfilled_at: new Date() } }));

  // Another browser cannot read the order, even with the id.
  const stranger = new Browser();
  assert.equal((await stranger.get(`/guest/orders/${placed.body.id}`)).status, 404);
});

test('confirming the transfer creates the account, grants access and sends the activation mail', async () => {
  const order = await db.order.findFirstOrThrow({ where: { identity_kind: 'guest' } });
  await freshReauth(admin, adminUser.id);
  const paid = await admin.change('post', `/admin/orders/${order.id}/confirm-payment`, { reference: 'Kontoauszug 42' });
  status(paid, 200);
  assert.equal(paid.body.payment_state, 'paid');
  assert.equal(paid.body.fulfillment_state, 'fulfilled');
  assert.equal(paid.body.account_linked, true);

  const created = await db.user.findUniqueOrThrow({ where: { email_canonical: 'gina@example.invalid' } });
  assert.equal(created.status, 'pending_activation');
  // The participant name from the order became the profile name — not the
  // invoice address holder.
  assert.equal(created.first_name, 'Gina');
  assert.equal(created.last_name, 'Gast');
  const access = await db.courseAccess.findFirstOrThrow({ where: { user_id: created.id } });
  assert.equal(access.course_id, course.id);
  assert.ok(access.ends_at);
  // An activation mail was queued for the new account.
  const activation = await db.emailOutbox.findFirst({ where: { user_id: created.id,
    template_version: { template: { key: 'activation' } } } });
  assert.ok(activation, 'the buyer must be able to set a password');

  // The buyer activates and can learn.
  status(await activate(created), 204);
  const buyer = new Browser();
  status(await buyer.change('post', '/auth/login', { email: 'gina@example.invalid', password }), 200);
  const mine = await buyer.get('/me/courses'); status(mine, 200);
  assert.equal(mine.body.data.length, 1);
  const chapter = await buyer.get(`/me/courses/gast-kurs/chapters/${course.chapter_id}`); status(chapter, 200);
  assert.equal(chapter.body.contents[0].body.blocks[0].text, 'Inhalt für Gäste.');
});

test('an existing account is reused, a blocked one is never granted silently', async () => {
  // A registered account that has not bought anything yet.
  const existingEmail = 'bestehend@example.invalid';
  const registered = new Browser();
  status(await registered.change('post', '/auth/register', { email: existingEmail, first_name: 'Bo',
    last_name: 'Bestand' }), 202);
  const existingUser = await db.user.findUniqueOrThrow({ where: { email_canonical: existingEmail } });
  status(await activate(existingUser), 204);

  const guest = new Browser();
  // A second product so the same course is not owned twice.
  status(await guest.change('post', '/guest/cart/items', { product_id: product.id }), 200);
  status(await proofRequest(guest, existingEmail), 202);
  status(await guest.change('post', '/guest/email/verify/confirm',
    { token: (await proofFromOutbox()).token }), 200);
  const placed = await guest.change('post', '/guest/orders', await guestBody());
  status(placed, 201);
  assert.equal(placed.body.account_linked, false);

  await freshReauth(admin, adminUser.id);
  const paid = await admin.change('post', `/admin/orders/${placed.body.id}/confirm-payment`,
    { reference: 'Kontoauszug 43' });
  status(paid, 200);
  // No second account was created and the order joined the existing one.
  assert.equal(await db.user.count({ where: { email_canonical: existingEmail } }), 1);
  const linked = await db.order.findUniqueOrThrow({ where: { id: placed.body.id } });
  assert.equal(linked.user_id, existingUser.id);
  assert.equal(linked.fulfillment_state, 'fulfilled');
  // Its profile name was not overwritten by the guest participant name.
  const untouched = await db.user.findUniqueOrThrow({ where: { id: existingUser.id } });
  assert.equal(untouched.first_name, 'Bo');
});

test('a blocked buyer is not granted access by a payment', async () => {
  const blockedEmail = 'gesperrt@example.invalid';
  const browser = new Browser();
  status(await browser.change('post', '/auth/register', { email: blockedEmail, first_name: 'Ge',
    last_name: 'Sperrt' }), 202);
  const blockedUser = await db.user.findUniqueOrThrow({ where: { email_canonical: blockedEmail } });
  await db.user.update({ where: { id: blockedUser.id }, data: { status: 'blocked' } });

  const guest = new Browser();
  status(await guest.change('post', '/guest/cart/items', { product_id: product.id }), 200);
  status(await proofRequest(guest, blockedEmail), 202);
  status(await guest.change('post', '/guest/email/verify/confirm',
    { token: (await proofFromOutbox()).token }), 200);
  const placed = await guest.change('post', '/guest/orders', await guestBody());
  status(placed, 201);

  await freshReauth(admin, adminUser.id);
  const refused = await admin.change('post', `/admin/orders/${placed.body.id}/confirm-payment`,
    { reference: 'Kontoauszug 44' });
  status(refused, 200);
  const order = await db.order.findUniqueOrThrow({ where: { id: placed.body.id } });
  assert.equal(order.payment_state, 'paid');
  assert.equal(order.fulfillment_state, 'blocked');
  assert.equal(order.user_id, null);
  const audit = await db.auditEvent.findFirstOrThrow({ where: { target_ref: order.id, action: 'fulfilment.needs_review' } });
  assert.equal(audit.after_safe.reason, 'ACCOUNT_BLOCKED');
  assert.equal(await db.courseAccess.count({ where: { user_id: blockedUser.id } }), 0);
});

test('a paid guest order with a blocked address can be resolved explicitly', async () => {
  const order = await db.order.findFirstOrThrow({ where: { identity_kind: 'guest', payment_state: 'paid',
    user: null, buyer_email_canonical: 'gesperrt@example.invalid' } });
  const filter = await admin.get('/admin/orders?state=unlinked'); status(filter, 200);
  assert.ok(filter.body.data.some(row => row.id === order.id && row.buyer.has_account === false));

  // The explicit decision cancels, keeps the payment evidence and releases the coupon.
  await freshReauth(admin, adminUser.id);
  const cancelled = await admin.change('post', `/admin/orders/${order.id}/resolve-link`,
    { decision: 'cancel', note: 'Konto gesperrt, Betrag erstattet' });
  status(cancelled, 200);
  assert.equal(cancelled.body.payment_state, 'cancelled');
  const kept = await db.order.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(kept.paid_via, 'admin', 'the payment evidence survives the refund');
  assert.ok(kept.paid_at);
  assert.equal(await db.courseAccess.count({ where: { user: { email_canonical: 'gesperrt@example.invalid' } } }), 0);
  const audit = await db.auditEvent.findFirst({ where: { action: 'order.guest_cancelled_manually' } });
  assert.ok(audit);
});

test('a proven cart merges into the account at login instead of vanishing', async () => {
  const mergeEmail = 'merge@example.invalid';
  const account = new Browser();
  status(await account.change('post', '/auth/register', { email: mergeEmail, first_name: 'Me',
    last_name: 'Rge' }), 202);
  const user = await db.user.findUniqueOrThrow({ where: { email_canonical: mergeEmail } });
  status(await activate(user), 204);

  const guest = new Browser();
  status(await guest.change('post', '/guest/cart/items', { product_id: product.id }), 200);
  assert.equal(guest.has('__Host-guest-cart'), true);
  // The same browser now logs in: the guest item must survive.
  const loggedIn = await guest.change('post', '/auth/login', { email: mergeEmail, password });
  status(loggedIn, 200);
  assert.equal(loggedIn.body.merged_items, 1);
  assert.equal(guest.has('__Host-guest-cart'), false, 'the guest cookie is consumed');
  const cart = await guest.get('/cart'); status(cart, 200);
  assert.equal(cart.body.items.length, 1);
  assert.equal(cart.body.subtotal_gross_cents, '24900');
  assert.equal(await db.cart.count({ where: { user_id: user.id, status: 'open' } }), 1);
});

test('guest coupons are limited per proven address, not per account', async () => {
  await freshReauth(admin, adminUser.id);
  status(await admin.change('post', '/admin/coupons', { code: 'GAST10', type: 'percent', value: 1000,
    active: true }), 201);
  const email = 'gutschein@example.invalid';
  const first = new Browser();
  status(await first.change('post', '/guest/cart/items', { product_id: product.id }), 200);
  status(await proofRequest(first, email), 202);
  status(await first.change('post', '/guest/email/verify/confirm', { token: (await proofFromOutbox()).token }), 200);
  const placed = await first.change('post', '/guest/orders', await guestBody({ coupon_code: 'GAST10' }));
  status(placed, 201);
  assert.equal(placed.body.discount_cents, '2490');
  assert.equal(placed.body.total_gross_cents, '22410');
  const reservation = await db.couponReservation.findFirstOrThrow({ where: { order_id: placed.body.id } });
  assert.equal(reservation.user_id, null, 'no account exists yet');
  assert.ok(reservation.identity_hmac);

  // The same address cannot use the code a second time.
  const second = new Browser();
  status(await second.change('post', '/guest/cart/items', { product_id: product.id }), 200);
  status(await proofRequest(second, email), 202);
  const proofs = await db.emailOutbox.findMany({ where: { user_id: null,
    template_version: { template: { key: 'checkout_email_verify' } } }, orderBy: { created_at: 'desc' } });
  const newest = unseal(proofs[0].variables_secret_ciphertext, `outbox:${proofs[0].id}`,
    proofs[0].secret_key_id).token;
  status(await second.change('post', '/guest/email/verify/confirm', { token: newest }), 200);
  const reused = await second.change('post', '/guest/orders', await guestBody({ coupon_code: 'GAST10' }));
  status(reused, 422); assert.equal(reused.body.code, 'COUPON_ALREADY_USED');
});

test('a guest can download the invoice of a paid order, and only with its cart cookie', async () => {
  const email = 'beleg@example.invalid';
  const guest = new Browser();
  status(await guest.change('post', '/guest/cart/items', { product_id: product.id }), 200);
  status(await proofRequest(guest, email), 202);
  status(await guest.change('post', '/guest/email/verify/confirm',
    { token: (await proofFromOutbox()).token }), 200);
  const placed = await guest.change('post', '/guest/orders', await guestBody());
  status(placed, 201);
  const invoice = await db.invoice.findFirstOrThrow({ where: { order_id: placed.body.id } });
  // Unpaid: the document exists for the buyer, but there is no download yet.
  const unpaid = await guest.get(`/guest/orders/${placed.body.id}`); status(unpaid, 200);
  assert.equal(unpaid.body.invoice.pdf_href, null);
  status(await guest.get(`/guest/invoices/${invoice.id}/pdf`), 404);

  // Pay the transfer; afterwards the cookie is the only proof needed.
  await freshReauth(admin, adminUser.id);
  status(await admin.change('post', `/admin/orders/${placed.body.id}/confirm-payment`,
    { reference: 'Kontoauszug 77' }), 200);
  const paid = await guest.get(`/guest/orders/${placed.body.id}`); status(paid, 200);
  assert.equal(paid.body.invoice.pdf_href, `/guest/invoices/${invoice.id}/pdf`);
  const pdf = await guest.get(`/guest/invoices/${invoice.id}/pdf`);
  status(pdf, 200);
  assert.match(pdf.headers['content-type'], /application\/pdf/);
  assert.match(pdf.headers['content-disposition'], /attachment; filename="Rechnung-/);
  assert.ok(pdf.body.toString('latin1').startsWith('%PDF-1.4'));

  // The payment also created the account — but the buyer has not activated it
  // yet, so the cookie must keep working for their receipt.
  const linked = await db.order.findUniqueOrThrow({ where: { id: placed.body.id } });
  assert.ok(linked.user_id, 'a paid guest order is linked to an account');
  status(await guest.get(`/guest/invoices/${invoice.id}/pdf`), 200);

  // A different browser without the cookie never gets the document.
  const stranger = new Browser();
  status(await stranger.get(`/guest/invoices/${invoice.id}/pdf`), 404);
  status(await request(server).get(`/api/v1/guest/invoices/${invoice.id}/pdf`), 404);
  // And the linked buyer reaches the same document through the account route.
  const buyer = new Browser();
  const user = await db.user.findUniqueOrThrow({ where: { id: linked.user_id } });
  status(await activate(user), 204);
  status(await buyer.change('post', '/auth/login', { email: user.email_canonical, password }), 200);
  const accountPdf = await buyer.get(`/invoices/${invoice.id}/pdf`);
  status(accountPdf, 200);
  assert.deepEqual(accountPdf.body, pdf.body, 'the document is identical for every entitled viewer');
});

test('a repeated payment confirmation grants access exactly once', async () => {
  const order = await db.order.findFirstOrThrow({ where: { identity_kind: 'guest', payment_state: 'paid',
    buyer_email_canonical: 'gina@example.invalid' } });
  const before = await db.courseAccess.count({ where: { order_id: order.id } });
  assert.equal(before, 1);
  // Double-clicking "Zahlungseingang buchen", or a provider retry after a
  // timeout, must be harmless: the order is already paid and fulfilled.
  await freshReauth(admin, adminUser.id);
  const again = await admin.change('post', `/admin/orders/${order.id}/confirm-payment`, { reference: 'Kontoauszug 42' });
  status(again, 200);
  assert.equal(again.body.payment_state, 'paid');
  assert.equal(await db.courseAccess.count({ where: { order_id: order.id } }), 1);
  assert.equal(await db.paymentAttempt.count({ where: { order_id: order.id, status: 'succeeded' } }), 1);
  // One invoice per order, with an immutable snapshot and a gap-free number.
  const invoices = await db.invoice.findMany({ where: { order_id: order.id } });
  assert.equal(invoices.length, 1);
  assert.match(invoices[0].invoice_number, /^TB-RE-\d{4}-\d{6}$/);
  assert.equal(invoices[0].recipient_email, 'gina@example.invalid');
  assert.equal(invoices[0].buyer_snapshot.city, 'Berlin');
});

test('a guest cannot buy the same course twice once the address is proven', async () => {
  const email = 'gina@example.invalid';
  const browser = new Browser();
  status(await browser.change('post', '/guest/cart/items', { product_id: product.id }), 200);
  status(await proofRequest(browser, email), 202);
  status(await browser.change('post', '/guest/email/verify/confirm',
    { token: (await proofFromOutbox()).token }), 200);
  const refused = await browser.change('post', '/guest/cart/items', { product_id: product.id });
  status(refused, 409); assert.equal(refused.body.code, 'ALREADY_OWNED');
  // Still exactly one access row for this address — the refused attempt granted
  // nothing, even though other test buyers own the same course.
  assert.equal(await db.courseAccess.count({ where: { course_id: course.id,
    user: { email_canonical: email } } }), 1);
  await db.courseAccess.updateMany({ where: { course_id: course.id, user: { email_canonical: email } },
    data: { starts_at: new Date(Date.now() - 86400000), ends_at: new Date(Date.now() - 1000) } });
  status(await browser.change('post', '/guest/cart/items', { product_id: product.id }), 200);
});

test('a guest mail survives a transport failure and never leaks its link into the database', async () => {
  const email = 'wiederholung@example.invalid';
  const browser = new Browser();
  status(await browser.change('post', '/guest/cart/items', { product_id: product.id }), 200);
  status(await proofRequest(browser, email), 202);
  const mail = await db.emailOutbox.findFirstOrThrow({ where: { to_email: email,
    template_version: { template: { key: 'checkout_email_verify' } } } });
  const { token } = unseal(mail.variables_secret_ciphertext, `outbox:${mail.id}`, mail.secret_key_id);
  // Neither the row nor the token table contains the usable link.
  const row = await db.emailOutbox.findUniqueOrThrow({ where: { id: mail.id } });
  assert.equal(JSON.stringify(row.variables_public).includes(token), false);
  assert.equal(Buffer.from(row.variables_secret_ciphertext).includes(Buffer.from(token)), false);
  const proof = await db.checkoutEmailVerification.findFirstOrThrow({ where: { email_canonical: email } });
  assert.equal(Buffer.from(proof.token_hash).includes(Buffer.from(token)), false);

  const job = await db.automationJob.findFirstOrThrow({ where: { kind: 'email.send', ref_id: mail.id } });
  const failing = new MailWorker(db, { sendMail: async () => { throw new Error('SMTP 421 try later'); } });
  assert.equal(await failing.runOne(job.id), true);
  let queued = await db.emailOutbox.findUniqueOrThrow({ where: { id: mail.id } });
  assert.equal(queued.status, 'queued');
  assert.ok(queued.variables_secret_ciphertext, 'the sealed link is kept for the retry');
  const afterFailure = await db.automationJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(afterFailure.attempts, 1);
  assert.equal(afterFailure.last_error_safe, 'MAIL_DELIVERY_FAILED');

  const sent = [];
  const working = new MailWorker(db, { sendMail: async message => {
    sent.push(message); return { accepted: [message.to], messageId: message.messageId }; } });
  await db.automationJob.update({ where: { id: job.id }, data: { run_after: new Date(0) } });
  assert.equal(await working.runOne(job.id), true);
  const accepted = await db.emailOutbox.findUniqueOrThrow({ where: { id: mail.id } });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.variables_secret_ciphertext, null, 'the sealed link is removed after delivery');
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes(`/kasse/bestaetigen#token=${token}`));
  assert.equal(sent[0].to, email);

  // The retried link still works and is single-use for the order.
  status(await browser.change('post', '/guest/email/verify/confirm', { token }), 200);
});

test('the identity guard refuses contradictions the API would never produce', async () => {
  const order = await db.order.findFirstOrThrow({ where: { identity_kind: 'guest', user_id: { not: null } } });
  const other = await db.user.findFirstOrThrow({ where: { email_canonical: { not: order.buyer_email_canonical },
    status: 'active' } });
  // Linking an order to an account with a different address is impossible.
  await assert.rejects(db.order.update({ where: { id: order.id }, data: { user_id: other.id } }));
  // A guest order without the two participant names is refused at insert time.
  await assert.rejects(db.order.create({ data: { id: uuidv7(), order_number: 'TB-2026-999999',
    cart_id: null, checkout_idempotency_key: `x-${uuidv7()}`, user_id: null, identity_kind: 'guest',
    checkout_email_verification_id: null, buyer_email_original: 'x@example.invalid',
    buyer_email_canonical: 'x@example.invalid', currency: 'EUR', payment_method: 'invoice',
    payment_state: 'awaiting', fulfillment_state: 'waiting', subtotal_gross_cents: 100n, discount_cents: 0n,
    total_gross_cents: 100n, billing_snapshot: {}, due_at: new Date(), created_by: null } }));
});


test('verified guest card order: cookie-bound session, payment replay, invoice PDF and read-only provider reconciliation',async()=>{
  for(const kind of ['guest-proof-ip','guest-checkout-ip']) {const keys=await redis.keys(`trainerb:rl:${kind}:*`);if(keys.length)await redis.del(...keys);}
  await require('../helpers/guest-card-purchase.cjs').exerciseGuestCard({app,db,server,Browser,product,body:await guestBody({payment_method:'stripe'}),email:'karte@example.invalid'});
});
