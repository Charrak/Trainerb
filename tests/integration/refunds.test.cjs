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

/**
 * PAY-04: partial and full refunds before and after access is granted.
 *
 * The point of this suite is not that a row appears, but that three separate
 * truths stay separate: the payment (unchanged), the money returned (refunds)
 * and the access decision (an explicit row). Anything that silently collapses
 * them into one state would be a bookkeeping bug, so each is asserted.
 *
 * A second, smaller point: refunding *before* access was ever granted must not
 * grant anything afterwards.
 */
const origin = 'https://academy.test';
const password = 'Kranich!Sonne2026';
const iso = date => date.toISOString().slice(0, 16) + 'Z';
let app, db, server, redis, admin, adminUser, adminRecovery, support, supportUser, supportTotp;
let buyer, buyerUser, course, product, price, extras = [];

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
  async get(path) {
    const r = request(server).get(`/api/v1${path}`);
    if (this.cookies.size) r.set('Cookie', this.cookie());
    return this.collect(await r);
  }
  async change(method, path, body) {
    const token = await this.get('/auth/csrf');
    status(token, 200);
    const r = request(server)[method](`/api/v1${path}`).set('Origin', origin)
      .set('X-CSRF-Token', token.body.csrf_token);
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
  status(await new Browser().change('post', '/auth/activate', { token, password }), 204);
}
async function register(name) {
  const email = `${name}@example.invalid`, browser = new Browser();
  status(await browser.change('post', '/auth/register', { email, first_name: 'Test', last_name: name }), 202);
  const user = await db.user.findUniqueOrThrow({ where: { email_canonical: email } });
  await activate(user);
  return { user, email, browser };
}
async function login(user, browser) {
  status(await browser.change('post', '/auth/login', { email: user.email_canonical, password }), 200);
  return browser;
}
async function enroll(browser, user, label) {
  const logged = await browser.change('post', '/auth/login', { email: user.email_canonical, password });
  status(logged, 202); assert.equal(logged.body.status, 'mfa_enrollment_required');
  const setup = await browser.change('post', '/auth/mfa/enrollment/start', {}); status(setup, 200);
  const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30,
    secret: OTPAuth.Secret.fromBase32(setup.body.secret) });
  const confirmed = await browser.change('post', '/auth/mfa/enrollment/confirm', { code: totp.generate() });
  status(confirmed, 200);
  return { totp, recovery: confirmed.body.recovery_codes, label };
}
/** A fresh second factor per sensitive action, as the routes demand. */
async function freshReauth(admin, userId, totp, recovery) {
  await db.authSession.updateMany({ where: { user_id: userId, kind: 'backoffice', revoked_at: null },
    data: { reauthenticated_at: new Date(Date.now() - 10 * 60_000) } });
  await db.userMfaFactor.updateMany({ where: { user_id: userId, type: 'totp', status: 'active' },
    data: { last_accepted_step: null } });
  const keys = await redis.keys('trainerb:rl:reauth:*'); if (keys.length) await redis.del(...keys);
  const payload = recovery.length ? { password, recovery_code: recovery.shift() } : { password, code: totp.generate() };
  status(await admin.change('post', '/auth/reauth', payload), 204);
}
async function legalVersions() {
  const versions = await db.legalDocumentVersion.findMany({ where: { status: 'active' }, include: { document: true } });
  return Object.fromEntries(versions.map(version => [version.document.kind, version.id]));
}
const address = { company: null, first_name: 'Test', last_name: 'Käufer', street: 'Testweg 1', street_extra: null,
  postal_code: '52062', city: 'Aachen', region: null, country: 'DE', vat_id: null };
async function checkoutBody(extra = {}) {
  return { idempotency_key: `refund-${uuidv7().replace(/-/g, '')}`, billing_address: address,
    payment_method: 'invoice', legal_versions: await legalVersions(), terms_accepted: true,
    withdrawal_notice_seen: true, privacy_notice_seen: true, ...extra };
}
const key = () => `refund-${uuidv7().replace(/-/g, '')}`;

/**
 * A second, unrelated product on its own course. A refund concerns one order, so
 * the tests need several independent purchases for the same buyer — the
 * phase-3 rule "one active access per course" would otherwise refuse the cart.
 */
async function extraProduct(index) {
  // The suffix keeps slugs and SKUs unique even when an earlier attempt of this
  // helper failed half-way through.
  // Slugs are lowercase-with-dashes, SKUs uppercase-with-dashes: one tag each.
  const stamp = Date.now().toString(36);
  const tag = `${index}-${stamp.toUpperCase()}`;
  const slug = `refund-kurs-${index}-${stamp}`;
  const created = await admin.change('post', '/admin/courses', { slug, title: `Kurs ${tag}`, visibility: 'public' });
  status(created, 201);
  const version = await db.courseVersion.findFirstOrThrow({ where: { course_id: created.body.id, state: 'draft' } });
  status(await admin.change('patch', `/admin/course-versions/${version.id}`, { revision: version.revision,
    title: `Kurs ${tag}`, subtitle: 'Zweiter Kurs', duration_minutes: 45,
    expected_module_count: 1, expected_chapter_count: 1 }), 200);
  const moduleResponse = await admin.change('post', `/admin/course-versions/${version.id}/modules`,
    { title: `Modul ${tag}`, position: 1 }); status(moduleResponse, 201);
  const chapterResponse = await admin.change('post', `/admin/course-modules/${moduleResponse.body.id}/chapters`,
    { title: `Kapitel ${tag}`, position: 1 }); status(chapterResponse, 201);
  status(await admin.change('post', `/admin/course-chapters/${chapterResponse.body.id}/contents`,
    { block: { kind: 'paragraph', text: `Inhalt ${tag}.` }, position: 1 }), 201);
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const draft = await db.courseVersion.findUniqueOrThrow({ where: { id: version.id } });
  status(await admin.change('post', `/admin/courses/${created.body.id}/publish`,
    { version_id: draft.id, revision: draft.revision }), 200);
  const created2 = await admin.change('post', '/admin/products', { sku: `REFUND-${tag}`, type: 'single',
    title: `Kurs ${tag} (Produkt)`, description: 'Weiteres Testprodukt.',
    courses: [{ course_id: created.body.id, access_days_override: 365 }] });
  status(created2, 201);
  const createdPrice = await admin.change('post', `/admin/products/${created2.body.id}/prices`, { currency: 'EUR',
    gross_cents: '19900', tax_category: 'standard', valid_from: iso(new Date(Date.now() - 60_000)) });
  status(createdPrice, 201);
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const productDraft = await db.product.findUniqueOrThrow({ where: { id: created2.body.id } });
  status(await admin.change('post', `/admin/products/${created2.body.id}/activate`, { revision: productDraft.revision }), 200);
  const priceDraft = await db.price.findUniqueOrThrow({ where: { id: createdPrice.body.id } });
  status(await admin.change('post', `/admin/prices/${createdPrice.body.id}/activate`, { revision: priceDraft.revision }), 200);
  return { ...created2.body, course_id: created.body.id, slug };
}
/** The next purchasable product: the first one for the first order, extras after. */
async function nextProduct() {
  const next = await extraProduct(extras.length + 1);
  extras.push(next);
  return next;
}

/** Which course the order's product unlocked (needed to address the learning area). */
async function courseOf(order) {
  const item = await db.orderItemCourse.findFirstOrThrow({ where: { order_id: order.id } });
  assert.ok(item.course_id);
  return item.course_id;
}

/** Place an order for the buyer, confirm the transfer, return the paid order. */
async function paidOrder({ confirm = true } = {}) {
  const sellable = extras.length === 0 && !(await db.courseAccess.count({ where: { user_id: buyerUser.id } }))
    ? product : await nextProduct();
  status(await buyer.change('post', '/cart/items', { product_id: sellable.id }), 200);
  const placed = await buyer.change('post', '/orders', await checkoutBody());
  status(placed, 201);
  if (!confirm) return { ...placed.body, product_id: sellable.id };
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const paid = await admin.change('post', `/admin/orders/${placed.body.id}/confirm-payment`,
    { reference: `Kontoauszug ${Date.now()}` });
  status(paid, 200);
  assert.equal(paid.body.payment_state, 'paid');
  return { ...paid.body, product_id: sellable.id };
}

let adminTotp;
before(async () => {
  assert.equal(process.env.TRAINERB_DESTRUCTIVE_TEST_DATABASE, 'confirmed');
  assert.match(new URL(process.env.DATABASE_URL).pathname, /_test$/);
  app = await createApplication(); await app.listen(0, '127.0.0.1'); server = app.getHttpServer(); db = app.get(Database);
  await db.$executeRawUnsafe('TRUNCATE TABLE courses, users, roles, permissions, email_templates, ' +
    'email_template_versions, email_outbox, automation_jobs, automation_job_attempts RESTART IDENTITY CASCADE');
  await seedCatalog(db); await seedCommerce(db);
  redis = new Redis(process.env.REDIS_URL);
  const keys = await redis.keys('trainerb:rl:*'); if (keys.length) await redis.del(...keys);

  execFileSync(process.execPath, ['apps/api/dist/cli/bootstrap.js'], { env: { ...process.env,
    BOOTSTRAP_ADMIN_EMAIL: 'refund-admin@example.invalid', BOOTSTRAP_ADMIN_FIRST_NAME: 'Test',
    BOOTSTRAP_ADMIN_LAST_NAME: 'Admin' }, stdio: 'pipe' });
  adminUser = await db.user.findUniqueOrThrow({ where: { email_canonical: 'refund-admin@example.invalid' } });
  await activate(adminUser);
  admin = new Browser();
  const adminMfa = await enroll(admin, adminUser, 'admin'); adminTotp = adminMfa.totp; adminRecovery = adminMfa.recovery;

  // A support account: it may propose a refund but never execute one.
  const supportFixture = await register('refund-support'); supportUser = supportFixture.user;
  status(await admin.change('put', `/admin/users/${supportUser.id}/roles`,
    { role_keys: ['participant', 'support'], reason_code: 'staff_change' }), 200);
  support = new Browser();
  const supportMfa = await enroll(support, supportUser, 'support'); supportTotp = supportMfa.totp;

  const fixture = await register('refund-buyer'); buyerUser = fixture.user;
  buyer = await login({ email_canonical: fixture.email }, fixture.browser);

  // Published course with one chapter and a sellable product.
  const created = await admin.change('post', '/admin/courses', { slug: 'refund-kurs', title: 'Kurs für Erstattungen',
    visibility: 'public' });
  status(created, 201);
  const version = await db.courseVersion.findFirstOrThrow({ where: { course_id: created.body.id, state: 'draft' } });
  status(await admin.change('patch', `/admin/course-versions/${version.id}`, { revision: version.revision,
    title: 'Kurs für Erstattungen', subtitle: 'Mit Inhalt', duration_minutes: 60,
    expected_module_count: 1, expected_chapter_count: 1 }), 200);
  const moduleResponse = await admin.change('post', `/admin/course-versions/${version.id}/modules`,
    { title: 'Modul Erstattung', position: 1 }); status(moduleResponse, 201);
  const chapterResponse = await admin.change('post', `/admin/course-modules/${moduleResponse.body.id}/chapters`,
    { title: 'Kapitel Erstattung', position: 1 }); status(chapterResponse, 201);
  status(await admin.change('post', `/admin/course-chapters/${chapterResponse.body.id}/contents`,
    { block: { kind: 'paragraph', text: 'Inhalt für Erstattungen.' }, position: 1 }), 201);
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const draft = await db.courseVersion.findUniqueOrThrow({ where: { id: version.id } });
  status(await admin.change('post', `/admin/courses/${created.body.id}/publish`,
    { version_id: draft.id, revision: draft.revision }), 200);
  course = { id: created.body.id, version_id: version.id, chapter_id: chapterResponse.body.id };

  const productResponse = await admin.change('post', '/admin/products', { sku: 'REFUND-01', type: 'single',
    title: 'Kurs für Erstattungen (Produkt)', description: 'Buchbar für Erstattungstests.',
    courses: [{ course_id: course.id, access_days_override: 365 }] });
  status(productResponse, 201); product = productResponse.body;
  price = (await admin.change('post', `/admin/products/${product.id}/prices`, { currency: 'EUR',
    gross_cents: '19900', tax_category: 'standard', valid_from: iso(new Date(Date.now() - 60_000)) })).body;
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const productDraft = await db.product.findUniqueOrThrow({ where: { id: product.id } });
  status(await admin.change('post', `/admin/products/${product.id}/activate`, { revision: productDraft.revision }), 200);
  const priceDraft = await db.price.findUniqueOrThrow({ where: { id: price.id } });
  status(await admin.change('post', `/admin/prices/${price.id}/activate`, { revision: priceDraft.revision }), 200);

  for (const kind of ['terms', 'withdrawal', 'privacy']) {
    await admin.change('post', '/admin/commerce/legal', { kind, wording: `Geprüfter Wortlaut ${kind}.` });
    const document = await db.legalDocument.findFirstOrThrow({ where: { kind } });
    const latest = await db.legalDocumentVersion.findFirstOrThrow({ where: { document_id: document.id,
      status: 'draft' }, orderBy: { version: 'desc' } });
    await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
    status(await admin.change('post', `/admin/commerce/legal/${latest.id}/activate`, {}), 200);
  }
  await db.commerceSettings.update({ where: { id: 1 }, data: { sales_enabled: true } });
});
after(async () => { if (redis) redis.disconnect(); if (app) await app.close(); });

test('a partial refund leaves the payment standing and issues one credit note', async () => {
  const order = await paidOrder();
  const attempt = await db.paymentAttempt.findFirstOrThrow({ where: { order_id: order.id, status: 'succeeded' } });
  assert.equal(await db.courseAccess.count({ where: { order_id: order.id, revoked_at: null } }), 1);

  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const position = await db.orderItem.findFirstOrThrow({ where: { order_id: order.id } });
  const refund = await admin.change('post', `/admin/orders/${order.id}/refunds`, { amount_cents: '4900',
    reason_code: 'goodwill', note: 'Teilerstattung nach Absprache', idempotency_key: key(),
    allocations: [{ order_item_product: position.product_id, gross_cents: '4900' }] });
  status(refund, 201);
  assert.equal(refund.body.status, 'succeeded');
  assert.equal(refund.body.amount_cents, '4900');
  assert.equal(refund.body.payment.paid_cents, '19900');
  assert.equal(refund.body.payment.refunded_cents, '4900');
  assert.equal(refund.body.payment.refundable_cents, '15000');
  assert.equal(refund.body.credit_notes.length, 1);
  assert.match(refund.body.credit_notes[0].document_number, /^TB-GS-\d{4}-\d{6}$/);

  // The payment evidence is untouched: a partial refund is not a new truth
  // about the payment, only a row saying part of it came back.
  const stored = await db.order.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(stored.payment_state, 'paid');
  assert.equal(stored.refunded_at, null);
  assert.ok(stored.paid_at);
  const attemptAfter = await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
  assert.equal(attemptAfter.status, 'succeeded');
  assert.equal(attemptAfter.amount_cents, 19900n);
  // ... and the access the order granted is still active: money and access are
  // separate decisions.
  assert.equal(await db.courseAccess.count({ where: { order_id: order.id, revoked_at: null } }), 1);

  // The credit note is a real document for its owner, not for others.
  const noteId = refund.body.credit_notes[0].id;
  const mine = await buyer.get('/credit-notes'); status(mine, 200);
  assert.equal(mine.body.data.length, 1);
  assert.equal(mine.body.data[0].order_number, order.order_number);
  const pdf = await buyer.get(`/credit-notes/${noteId}/pdf`); status(pdf, 200);
  assert.match(pdf.headers['content-type'], /application\/pdf/);
  assert.match(pdf.headers['content-disposition'], /attachment; filename="Gutschrift-TB-GS-\d{4}-\d{6}\.pdf"/);
  const raw = pdf.body.toString('latin1');
  assert.ok(raw.startsWith('%PDF-1.4'));
  assert.ok(raw.includes('GS-'), 'the document number is printed');
  status(await new Browser().get(`/credit-notes/${noteId}/pdf`), 401);
  status(await support.get(`/credit-notes/${noteId}/pdf`), 404);
});

test('a refund can never exceed the payment, and a repeated key moves no second time', async () => {
  const order = await paidOrder();
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const idempotency = key();
  const first = await admin.change('post', `/admin/orders/${order.id}/refunds`, { amount_cents: '10000',
    reason_code: 'customer_request', idempotency_key: idempotency });
  status(first, 201);
  // Same key, same amount: the same refund comes back, no second row.
  const replay = await admin.change('post', `/admin/orders/${order.id}/refunds`, { amount_cents: '10000',
    reason_code: 'customer_request', idempotency_key: idempotency });
  status(replay, 201);
  assert.equal(replay.body.id, first.body.id);
  assert.equal(await db.refund.count({ where: { order_id: order.id } }), 1);
  // Same key, different amount is a conflict, not a third refund.
  status(await admin.change('post', `/admin/orders/${order.id}/refunds`, { amount_cents: '9000',
    reason_code: 'customer_request', idempotency_key: idempotency }), 409);

  // More than is left is refused by the API and by the database trigger.
  const over = await admin.change('post', `/admin/orders/${order.id}/refunds`, { amount_cents: '10000',
    reason_code: 'customer_request', idempotency_key: key() });
  status(over, 409); assert.equal(over.body.code, 'REFUND_EXCEEDS_PAYMENT');
  const attempt = await db.paymentAttempt.findFirstOrThrow({ where: { order_id: order.id, status: 'succeeded' } });
  await assert.rejects(db.refund.create({ data: { id: uuidv7(), order_id: order.id, payment_attempt_id: attempt.id,
    provider: 'invoice', environment: 'test', provider_idempotency_key: key(), amount_cents: 19900n,
    currency: 'EUR', status: 'succeeded', reason_code: 'customer_request', requested_by: adminUser.id,
    confirmed_at: new Date() } }), /REFUND_EXCEEDS_PAYMENT/);
  // A refund through a payment of a *different* order is impossible by schema.
  const other = await paidOrder();
  const otherAttempt = await db.paymentAttempt.findFirstOrThrow({ where: { order_id: other.id, status: 'succeeded' } });
  await assert.rejects(db.refund.create({ data: { id: uuidv7(), order_id: order.id,
    payment_attempt_id: otherAttempt.id, provider: 'invoice', environment: 'test',
    provider_idempotency_key: key(), amount_cents: 100n, currency: 'EUR', status: 'succeeded',
    reason_code: 'customer_request', requested_by: adminUser.id, confirmed_at: new Date() } }),
  /refunds_attempt_order_fkey/);
  // Zero or negative amounts never reach the ledger.
  status(await admin.change('post', `/admin/orders/${order.id}/refunds`, { amount_cents: '0',
    reason_code: 'goodwill', idempotency_key: key() }), 422);
});

test('a full refund marks the order refunded and keeps the payment evidence', async () => {
  const order = await paidOrder();
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const refund = await admin.change('post', `/admin/orders/${order.id}/refunds`, { amount_cents: '19900',
    reason_code: 'withdrawal', idempotency_key: key() });
  status(refund, 201);
  assert.equal(refund.body.order.payment_state, 'refunded');
  const stored = await db.order.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(stored.payment_state, 'refunded');
  assert.ok(stored.refunded_at);
  assert.ok(stored.paid_at, 'a refunded order still shows when the money arrived');
  assert.equal(stored.paid_via, 'admin');
  // A refunded order cannot pretend to be unpaid, and cancelling it would
  // release the books' payment evidence — both are refused.
  await assert.rejects(db.order.update({ where: { id: order.id }, data: { paid_at: null, paid_via: null,
    paid_confirmed_by: null } }), /orders_paid_via_check/);
  const detail = await admin.get(`/admin/orders/${order.id}`); status(detail, 200);
  assert.equal(detail.body.refundable.refundable_cents, '0');
  assert.equal(detail.body.refunds.length, 1);
  // Nothing is left to refund.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  status(await admin.change('post', `/admin/orders/${order.id}/refunds`, { amount_cents: '100',
    reason_code: 'goodwill', idempotency_key: key() }), 409);
});

test('access after a refund is an explicit decision, and suspending a future grant is not revoking it', async () => {
  const order = await paidOrder();
  // A grant from a *different* source for another course must stay untouched:
  // a refund concerns one order and one access row.
  const other = await register('refund-other');
  assert.ok(other.user);

  const future = await db.courseAccess.findFirstOrThrow({ where: { order_id: order.id } });
  await db.courseAccess.update({ where: { id: future.id }, data: { starts_at: new Date(Date.now() + 86_400_000) } });

  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const refund = await admin.change('post', `/admin/orders/${order.id}/refunds`, { amount_cents: '5000',
    reason_code: 'customer_request', idempotency_key: key() });
  status(refund, 201);
  const access = await db.courseAccess.findUniqueOrThrow({ where: { id: future.id } });
  assert.equal(access.revoked_at, null, 'the refund itself revokes nothing');
  assert.equal(access.suspended_at, null);

  // Revoking without a recorded decision is refused by the database.
  await assert.rejects(db.courseAccess.update({ where: { id: access.id },
    data: { revoked_at: new Date(), revoke_reason: 'refund_revoked' } }), /ACCESS_DECISION_REQUIRED/);
  await assert.rejects(db.courseAccess.update({ where: { id: access.id }, data: { revoked_at: new Date() } }),
    /ACCESS_REVOKE_REASON_REQUIRED/);

  // A future grant is suspended, not destroyed: the row resumes if the question
  // is settled in the buyer's favour.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const suspended = await admin.change('post', `/admin/refunds/${refund.body.id}/access-decision`,
    { decision: 'suspended', reason: 'refund_clarification' });
  status(suspended, 200);
  assert.equal(suspended.body.access_decisions.length, 1);
  assert.equal(suspended.body.access_decisions[0].decision, 'suspended');
  const afterSuspend = await db.courseAccess.findUniqueOrThrow({ where: { id: access.id } });
  assert.equal(afterSuspend.revoked_at, null);
  assert.ok(afterSuspend.suspended_at);
  assert.equal(afterSuspend.suspend_reason, 'refund_clarification');
  // The learning area says "suspended", not "not found": the purchase is known.
  const slug = (await db.course.findUniqueOrThrow({ where: { id: await courseOf(order) } })).slug;
  const blocked = await buyer.get(`/me/courses/${slug}`);
  status(blocked, 403); assert.equal(blocked.body.code, 'ACCESS_SUSPENDED');

  // "Kept" is a decision too and lifts the suspension.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  status(await admin.change('post', `/admin/refunds/${refund.body.id}/access-decision`,
    { decision: 'kept', reason: 'goodwill_decision' }), 200);
  const resumed = await db.courseAccess.findUniqueOrThrow({ where: { id: access.id } });
  assert.equal(resumed.suspended_at, null);
  assert.equal(await db.orderAccessDecision.count({ where: { refund_id: refund.body.id } }), 2);
  // An explicit revocation is the third, and it is final for this row.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  status(await admin.change('post', `/admin/refunds/${refund.body.id}/access-decision`,
    { decision: 'revoked', reason: 'refund_revoked' }), 200);
  const revoked = await db.courseAccess.findUniqueOrThrow({ where: { id: access.id } });
  assert.ok(revoked.revoked_at);
  assert.equal(revoked.revoke_reason, 'refund_revoked');
  status(await buyer.get(`/me/courses/${slug}`), 404);

  // An access decision needs a settled refund — a mere proposal is not enough.
  const second = await paidOrder();
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const proposal = await admin.change('post', `/admin/orders/${second.id}/refund-proposals`,
    { amount_cents: '1000', reason_code: 'customer_request', idempotency_key: key() });
  status(proposal, 201);
  assert.equal(proposal.body.status, 'requested');
  assert.equal(await db.refund.findUniqueOrThrow({ where: { id: proposal.body.id } }).then(r => r.status), 'requested');
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const early = await admin.change('post', `/admin/refunds/${proposal.body.id}/access-decision`,
    { decision: 'revoked', reason: 'refund_revoked' });
  status(early, 409); assert.equal(early.body.code, 'REFUND_NOT_SETTLED');
});

test('support may propose a refund but never execute one', async () => {
  const order = await paidOrder();
  const proposal = await support.change('post', `/admin/orders/${order.id}/refund-proposals`,
    { amount_cents: '2500', reason_code: 'customer_request', note: 'Kunde hat angerufen', idempotency_key: key() });
  status(proposal, 201);
  assert.equal(proposal.body.status, 'requested');
  assert.equal(proposal.body.credit_notes.length, 0, 'a proposal issues no document');
  assert.equal(await db.order.findUniqueOrThrow({ where: { id: order.id } }).then(r => r.payment_state), 'paid');
  // Executing is refused for a proposal-only role, with or without a body.
  const blocked = await support.change('post', `/admin/orders/${order.id}/refunds`,
    { amount_cents: '2500', reason_code: 'customer_request', idempotency_key: key() });
  status(blocked, 403);
  // And executing a proposal is the step that moves money, so it needs the
  // permission and a fresh second factor.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const executed = await admin.change('post', `/admin/refunds/${proposal.body.id}/confirm`, {});
  status(executed, 200);
  assert.equal(executed.body.status, 'succeeded');
  assert.equal(executed.body.credit_notes.length, 1);
  // Confirming again is idempotent: no second credit note, no second booking.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const again = await admin.change('post', `/admin/refunds/${proposal.body.id}/confirm`, {});
  status(again, 200);
  assert.equal(again.body.credit_notes.length, 1);
  assert.equal(await db.creditNote.count({ where: { refund_id: proposal.body.id } }), 1);
  // A failed refund frees its capacity again: no money moved.
  const third = await paidOrder();
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const open = await admin.change('post', `/admin/orders/${third.id}/refund-proposals`,
    { amount_cents: '19900', reason_code: 'customer_request', idempotency_key: key() });
  status(open, 201);
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  status(await admin.change('post', `/admin/refunds/${open.body.id}/fail`, { error_code: 'provider_rejected' }), 200);
  const freed = await db.refund.findUniqueOrThrow({ where: { id: open.body.id } });
  assert.equal(freed.status, 'failed');
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const retry = await admin.change('post', `/admin/orders/${third.id}/refunds`,
    { amount_cents: '19900', reason_code: 'customer_request', idempotency_key: key() });
  status(retry, 201);
  assert.equal(retry.body.status, 'succeeded');
});

test('refunding before fulfilment grants nothing afterwards, and the buyer is told', async () => {
  const order = await paidOrder({ confirm: false });
  // The order is still awaiting payment: nothing to refund yet.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const early = await admin.change('post', `/admin/orders/${order.id}/refunds`,
    { amount_cents: '100', reason_code: 'customer_request', idempotency_key: key() });
  status(early, 409); assert.equal(early.body.code, 'ORDER_NOT_REFUNDABLE');

  const paid = await paidOrder();
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const refund = await admin.change('post', `/admin/orders/${paid.id}/refunds`,
    { amount_cents: '19900', reason_code: 'withdrawal', idempotency_key: key() });
  status(refund, 201);
  assert.equal(refund.body.order.payment_state, 'refunded');
  // The buyer gets exactly one transactional mail with the correction number.
  const mails = await db.emailOutbox.findMany({ where: { user_id: buyerUser.id,
    template_version: { template: { key: 'refund_confirmed' } } } });
  // Other tests in this file refund other orders of the same buyer; the mail for
  // *this* correction must still exist exactly once.
  const forThisOrder = mails.filter(mail => mail.variables_public.order_number === paid.order_number);
  assert.equal(forThisOrder.length, 1);
  const [mail] = forThisOrder;
  assert.match(mail.variables_public.credit_note_number, /^TB-GS-/);
  assert.equal(mail.to_email, buyerUser.email_original);
  // The access stays until a human decides — a refunded order grants nothing
  // new, but it does not silently take the course away either.
  assert.equal(await db.courseAccess.count({ where: { order_id: paid.id, revoked_at: null } }), 1);
  // The order list shows the refunded order as its own state.
  const list = await admin.get('/admin/orders?state=refunded'); status(list, 200);
  assert.ok(list.body.data.some(row => row.id === paid.id));
  assert.ok(list.body.totals.refunded >= 1);
  // Refunds are listed for the back office with their own permission.
  const refunds = await admin.get('/admin/refunds'); status(refunds, 200);
  assert.ok(refunds.body.data.some(row => row.id === refund.body.id));
  status(await support.get('/admin/refunds'), 200);
});

// --------------------------------------------------------------------------
// Streitfälle (Rückbuchungen)
// --------------------------------------------------------------------------

test('a chargeback is not a refund: separate lifecycle, no credit note, payment evidence kept', async () => {
  const order = await paidOrder();
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const dispute = await admin.change('post', `/admin/orders/${order.id}/disputes`,
    { provider_dispute_id: `dp_${uuidv7().replace(/-/g, '').slice(0, 20)}`, amount_cents: '19900',
      status: 'open', reason_code: 'product_not_received' });
  status(dispute, 201);
  assert.equal(dispute.body.status, 'open');
  assert.equal(await db.creditNote.count({ where: { order_id: order.id } }), 0,
    'a chargeback never produces a credit note — we never issued the credit');
  // An open case is a claim, not a fact: the order stays paid and nothing moved.
  assert.equal(await db.order.findUniqueOrThrow({ where: { id: order.id } }).then(row => row.payment_state), 'paid');

  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const lost = await admin.change('post', `/admin/orders/${order.id}/disputes`,
    { provider_dispute_id: dispute.body.provider_dispute_id, amount_cents: '19900', status: 'lost',
      reason_code: 'product_not_received' });
  status(lost, 200);
  assert.equal(lost.body.status, 'lost');
  assert.ok(lost.body.resolved_at);
  const stored = await db.order.findUniqueOrThrow({ where: { id: order.id } });
  // Money gone, but not by our hand: a distinct state with its own timestamp.
  assert.equal(stored.payment_state, 'charged_back');
  assert.ok(stored.charged_back_at);
  assert.equal(stored.refunded_at, null, 'no refund happened');
  assert.ok(stored.paid_at, 'the payment evidence stays');
  assert.equal(stored.paid_via, 'admin');
  // The same provider case delivered twice is an update, never a second row.
  assert.equal(await db.dispute.count({ where: { order_id: order.id } }), 1);
  // A decided case never moves backwards.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const backwards = await admin.change('post', `/admin/orders/${order.id}/disputes`,
    { provider_dispute_id: dispute.body.provider_dispute_id, amount_cents: '19900', status: 'open' });
  status(backwards, 409); assert.equal(backwards.body.code, 'DISPUTE_ALREADY_RESOLVED');
  // And a changed amount is a provider disagreement, not an update.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const changed = await admin.change('post', `/admin/orders/${order.id}/disputes`,
    { provider_dispute_id: dispute.body.provider_dispute_id, amount_cents: '15000', status: 'lost' });
  status(changed, 409); assert.equal(changed.body.code, 'DISPUTE_AMOUNT_MISMATCH');
  // A charged-back order is not a cancellation, and it cannot become one.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const cancel = await admin.change('post', `/admin/orders/${order.id}/cancel`, { reason: 'customer_request' });
  status(cancel, 409); assert.equal(cancel.body.code, 'ORDER_CHARGED_BACK');
  // Support may see the case, but only with the refunds permission.
  const list = await admin.get('/admin/disputes'); status(list, 200);
  assert.ok(list.body.data.some(row => row.id === lost.body.id));
  status(await support.get('/admin/disputes'), 403);
});

test('a lost chargeback consumes the refund capacity, so the same money cannot leave twice', async () => {
  const order = await paidOrder();
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const dispute = await admin.change('post', `/admin/orders/${order.id}/disputes`,
    { provider_dispute_id: `dp_${uuidv7().replace(/-/g, '').slice(0, 20)}`, amount_cents: '19900', status: 'lost' });
  status(dispute, 201);
  assert.equal(dispute.body.payment.refundable_cents, '0');
  // The API refuses, and so does the database trigger.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  // A fully charged-back order has no capacity left, so the API refuses and the
  // money cannot leave a second time.
  const refund = await admin.change('post', `/admin/orders/${order.id}/refunds`,
    { amount_cents: '19900', reason_code: 'customer_request', idempotency_key: key() });
  status(refund, 409); assert.equal(refund.body.code, 'REFUND_EXCEEDS_PAYMENT');
  const attempt = await db.paymentAttempt.findFirstOrThrow({ where: { order_id: order.id, status: 'succeeded' } });
  await assert.rejects(db.refund.create({ data: { id: uuidv7(), order_id: order.id,
    payment_attempt_id: attempt.id, provider: 'invoice', environment: 'test',
    provider_idempotency_key: key(), amount_cents: 500n, currency: 'EUR', status: 'succeeded',
    reason_code: 'customer_request', requested_by: adminUser.id, confirmed_at: new Date() } }),
  /REFUND_EXCEEDS_PAYMENT/);
  // A partial chargeback only uses part of the capacity.
  const partial = await paidOrder();
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const half = await admin.change('post', `/admin/orders/${partial.id}/disputes`,
    { provider_dispute_id: `dp_${uuidv7().replace(/-/g, '').slice(0, 20)}`, amount_cents: '5000', status: 'lost' });
  status(half, 201);
  assert.equal(half.body.payment.refundable_cents, '14900');
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const rest = await admin.change('post', `/admin/orders/${partial.id}/refunds`,
    { amount_cents: '14900', reason_code: 'goodwill', idempotency_key: key() });
  status(rest, 201);
  // A dispute larger than the payment is refused by the trigger.
  const other = await paidOrder();
  await assert.rejects(db.dispute.create({ data: { id: uuidv7(), order_id: other.id,
    payment_attempt_id: (await db.paymentAttempt.findFirstOrThrow({ where: { order_id: other.id,
      status: 'succeeded' } })).id, provider: 'stripe', environment: 'test',
    provider_dispute_id: `dp_${uuidv7().replace(/-/g, '').slice(0, 20)}`, amount_cents: 99900n,
    currency: 'EUR', status: 'lost', opened_at: new Date(), resolved_at: new Date() } }),
  /DISPUTE_EXCEEDS_PAYMENT/);
});

test('a won chargeback restores the order state and never revokes access', async () => {
  const order = await paidOrder();
  const providerDisputeId = `dp_${uuidv7().replace(/-/g, '').slice(0, 20)}`;
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  status(await admin.change('post', `/admin/orders/${order.id}/disputes`,
    { provider_dispute_id: providerDisputeId, amount_cents: '19900', status: 'lost' }), 201);
  assert.equal(await db.order.findUniqueOrThrow({ where: { id: order.id } }).then(row => row.payment_state), 'charged_back');
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const won = await admin.change('post', `/admin/orders/${order.id}/disputes`,
    { provider_dispute_id: providerDisputeId, amount_cents: '19900', status: 'won' });
  status(won, 200);
  const stored = await db.order.findUniqueOrThrow({ where: { id: order.id } });
  // The bank reversed it: the order is a paid order again, with its evidence.
  assert.equal(stored.payment_state, 'paid');
  assert.equal(stored.charged_back_at, null);
  assert.ok(stored.paid_at);
  // We won and the customer keeps the course; revoking would need another reason.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const revoke = await admin.change('post', `/admin/refunds/${won.body.id}/access-decision`,
    { decision: 'revoked', reason: 'chargeback_lost' });
  status(revoke, 404);
  const revokeDispute = await admin.change('post', `/admin/disputes/${won.body.id}/access-decision`,
    { decision: 'revoked', reason: 'chargeback_lost' });
  status(revokeDispute, 409); assert.equal(revokeDispute.body.code, 'DISPUTE_WON');
  // "Kept" is allowed and documented against the dispute, not against a refund.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const kept = await admin.change('post', `/admin/disputes/${won.body.id}/access-decision`,
    { decision: 'kept', reason: 'goodwill_after_win' });
  status(kept, 200);
  assert.equal(kept.body.access_decisions.length, 1);
  assert.equal(kept.body.access_decisions[0].decision, 'kept');
  const decision = await db.orderAccessDecision.findFirstOrThrow({ where: { dispute_id: won.body.id } });
  assert.equal(decision.refund_id, null, 'the decision points at the case, not at a refund');
});

test('an open chargeback cannot decide the access question yet', async () => {
  const order = await paidOrder();
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const dispute = await admin.change('post', `/admin/orders/${order.id}/disputes`,
    { provider_dispute_id: `dp_${uuidv7().replace(/-/g, '').slice(0, 20)}`, amount_cents: '19900',
      status: 'warning' });
  status(dispute, 201);
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const early = await admin.change('post', `/admin/disputes/${dispute.body.id}/access-decision`,
    { decision: 'revoked', reason: 'chargeback_open' });
  status(early, 409); assert.equal(early.body.code, 'DISPUTE_NOT_RESOLVED');
  // An access decision always names exactly one origin — never both.
  await assert.rejects(db.orderAccessDecision.create({ data: { id: uuidv7(), order_id: order.id,
    refund_id: null, dispute_id: null, access_id: null, decision: 'kept', reason: 'x_reason',
    decided_by: adminUser.id } }), /order_access_decisions_origin/);
  assert.equal(await db.courseAccess.count({ where: { order_id: order.id, revoked_at: null } }), 1);
});

// --------------------------------------------------------------------------
// Widerruf
// --------------------------------------------------------------------------

test('a public withdrawal is a documented claim, never an automatic refund', async () => {
  const order = await paidOrder();
  const anonymous = new Browser();
  const before = { orders: await db.order.count(), refunds: await db.refund.count() };
  const response = await anonymous.change('post', '/withdrawal-requests', {
    contact_email: 'widerruf@example.invalid', customer_name: 'Gina Gast',
    order_number: order.order_number, message: 'Ich widerrufe meinen Kauf.' });
  status(response, 202);
  assert.deepEqual(response.body, { received: true }, 'the answer is neutral and carries no order data');
  assert.equal(await db.order.count(), before.orders);
  assert.equal(await db.refund.count(), before.refunds, 'a withdrawal never refunds by itself');
  const item = await db.withdrawalRequest.findFirstOrThrow({ where: { contact_email: 'widerruf@example.invalid' } });
  assert.equal(item.status, 'received');
  assert.equal(item.submitted_order_number, order.order_number, 'the typed number is stored as text, unverified');
  assert.equal(item.order_id, null, 'nothing is linked automatically');
  assert.ok(item.confirmation_outbox_id, 'the receipt is queued in the durable outbox');
  // The plain address is stored for answering, and a keyed hash for throttling.
  const mail = await db.emailOutbox.findUniqueOrThrow({ where: { id: item.confirmation_outbox_id } });
  assert.equal(mail.template_version_id !== null, true);
  assert.equal(mail.to_email, 'widerruf@example.invalid');
  assert.match(mail.variables_public.received_date, /^\d{2}\.\d{2}\.\d{4}$/);
});

test('a withdrawal never reveals whether an order or address exists', async () => {
  const anonymous = new Browser();
  const known = await anonymous.change('post', '/withdrawal-requests',
    { contact_email: buyerUser.email_original, order_number: 'TB-2026-000001', message: 'Test' });
  status(known, 202); assert.deepEqual(known.body, { received: true });
  const unknown = await anonymous.change('post', '/withdrawal-requests',
    { contact_email: 'niemand@example.invalid', order_number: 'TB-2099-999999', message: 'Test' });
  status(unknown, 202); assert.deepEqual(unknown.body, { received: true });
  const withoutNumber = await anonymous.change('post', '/withdrawal-requests',
    { contact_email: 'ohnenummer@example.invalid' });
  status(withoutNumber, 202); assert.deepEqual(withoutNumber.body, { received: true });
  // A malformed address is the sender's own error and may be named.
  status(await anonymous.change('post', '/withdrawal-requests', { contact_email: 'keine-adresse' }), 422);
  // The endpoint is throttled per address: a real person never hits this.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    status(await anonymous.change('post', '/withdrawal-requests',
      { contact_email: 'flut@example.invalid', message: `Versuch ${attempt}` }), 202);
  }
  const blocked = await anonymous.change('post', '/withdrawal-requests',
    { contact_email: 'flut@example.invalid', message: 'einer zu viel' });
  status(blocked, 429);
  assert.equal(await db.withdrawalRequest.count({ where: { contact_email: 'flut@example.invalid' } }), 5);
});

test('staff verify the identity before linking a withdrawal to an order', async () => {
  // Each test is its own day as far as the throttle is concerned.
  const keys = await redis.keys('trainerb:rl:withdrawal*'); if (keys.length) await redis.del(...keys);
  const order = await paidOrder();
  const anonymous = new Browser();
  status(await anonymous.change('post', '/withdrawal-requests',
    { contact_email: buyerUser.email_original, customer_name: 'Test Käufer',
      order_number: order.order_number, message: 'Bitte prüfen.' }), 202);
  const item = await db.withdrawalRequest.findFirstOrThrow({ where: { contact_email: buyerUser.email_original,
    status: 'received', submitted_order_number: order.order_number }, orderBy: { submitted_at: 'desc' } });
  // Only the withdrawal case workers may touch the file.
  status(await support.get('/admin/withdrawal-requests'), 200);

  // Linking before verification is refused: the claim is still a stranger's.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const early = await admin.change('post', `/admin/withdrawal-requests/${item.id}`, { order_id: order.id });
  status(early, 409); assert.equal(early.body.code, 'WITHDRAWAL_IDENTITY_REQUIRED');
  // A verification code proves the address, and the code reaches the sender only
  // once: it is consumed by the first correct use.
  const code = await admin.change('post', `/admin/withdrawal-requests/${item.id}/identity-code`, {});
  status(code, 201);
  const proofMail = await db.emailOutbox.findFirstOrThrow({ where: { to_email: buyerUser.email_original,
    template_version: { template: { key: 'withdrawal_verify' } } }, orderBy: { created_at: 'desc' } });
  // The link never sits in the row in clear: it is sealed and only the worker builds it.
  assert.equal(Object.hasOwn(proofMail.variables_public, 'verification_url'), false);
  const { token } = unseal(proofMail.variables_secret_ciphertext, `outbox:${proofMail.id}`, proofMail.secret_key_id);
  const verify = await anonymous.change('post', '/withdrawal-requests/verify', { token });
  status(verify, 200);
  assert.equal(verify.body.verified, true);
  // The same link never works twice.
  status(await anonymous.change('post', '/withdrawal-requests/verify', { token }), 409);

  const linked = await db.withdrawalRequest.findUniqueOrThrow({ where: { id: item.id } });
  assert.ok(linked.identity_verified_at, 'opening the link proves the address');
  assert.equal(linked.status, 'identity_check');
  // The proved address decides the link, not the number someone typed: a claim
  // with a proved address for another order stays unlinked.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const other = await paidOrder();
  const mismatch = await admin.change('post', `/admin/withdrawal-requests/${item.id}`, { order_id: order.id });
  status(mismatch, 200);
  assert.equal(mismatch.body.order.id, order.id);
  const foreign = await db.order.findFirstOrThrow({ where: { id: other.id } });
  assert.notEqual(foreign.buyer_email_canonical, 'widerruf@example.invalid');

  // Closing needs a reason, and accepting needs the order it cancels.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  status(await admin.change('post', `/admin/withdrawal-requests/${item.id}`, { status: 'completed' }), 422);
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const completed = await admin.change('post', `/admin/withdrawal-requests/${item.id}`,
    { status: 'completed', decision_reason: 'withdrawal_accepted' });
  status(completed, 200);
  assert.equal(completed.body.status, 'completed');
  assert.ok(completed.body.processed_at);
  assert.equal(completed.body.refund, null, 'accepted withdrawal still does not refund automatically');
  const decided = await db.emailOutbox.findFirstOrThrow({ where: { to_email: buyerUser.email_original,
    template_version: { template: { key: 'withdrawal_decided' } } }, orderBy: { created_at: 'desc' } });
  assert.equal(decided.variables_public.decision, 'angenommen');
  // A closed case is final.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const again = await admin.change('post', `/admin/withdrawal-requests/${item.id}`, { status: 'rejected',
    decision_reason: 'outside_statutory_period' });
  status(again, 409); assert.equal(again.body.code, 'WITHDRAWAL_CLOSED');
});


// --------------------------------------------------------------------------
// Sackgassen (Phase 4, Nachtrag)
// --------------------------------------------------------------------------

test('a withdrawal without a findable order can be closed, but never accepted', async () => {
  const keys0 = await redis.keys('trainerb:rl:withdrawal*'); if (keys0.length) await redis.del(...keys0);
  const anonymous = new Browser();
  // Someone withdraws without a number at all — the common telephone case.
  status(await anonymous.change('post', '/withdrawal-requests',
    { contact_email: 'ohne-nummer@example.invalid', customer_name: 'Ohne Nummer',
      message: 'Ich widerrufe, meine Bestellnummer habe ich nicht.' }), 202);
  const item = await db.withdrawalRequest.findFirstOrThrow({ where: {
    contact_email: 'ohne-nummer@example.invalid' } });
  assert.equal(item.order_id, null);

  // Accepting is refused: we cannot cancel a purchase we cannot name.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const accept = await admin.change('post', `/admin/withdrawal-requests/${item.id}`,
    { status: 'completed', decision_reason: 'withdrawal_accepted' });
  status(accept, 409); assert.equal(accept.body.code, 'WITHDRAWAL_ORDER_REQUIRED');

  // Declining with an unexplained reason is refused too.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const wrongReason = await admin.change('post', `/admin/withdrawal-requests/${item.id}`,
    { status: 'rejected', decision_reason: 'withdrawal_declined' });
  status(wrongReason, 409); assert.equal(wrongReason.body.code, 'WITHDRAWAL_CLOSE_REASON');

  // A free-text reason is not in the vocabulary the API offers.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const typo = await admin.change('post', `/admin/withdrawal-requests/${item.id}`,
    { status: 'rejected', decision_reason: 'kunde_hat_angerufen' });
  status(typo, 422); assert.equal(typo.body.code, 'INVALID_FIELD');

  // The honest way out closes the case and tells the person.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const closed = await admin.change('post', `/admin/withdrawal-requests/${item.id}`,
    { status: 'rejected', decision_reason: 'order_not_found' });
  status(closed, 200);
  assert.equal(closed.body.status, 'rejected');
  assert.equal(closed.body.order, null, 'closed without inventing an order');
  assert.equal(closed.body.decision_reason, 'order_not_found');
  const mail = await db.emailOutbox.findFirstOrThrow({ where: { to_email: 'ohne-nummer@example.invalid',
    template_version: { template: { key: 'withdrawal_decided' } } } });
  assert.equal(mail.variables_public.decision, 'abgelehnt');
  // The case is gone from the queue but not from the record.
  assert.equal(await db.withdrawalRequest.count({ where: { id: item.id, status: 'rejected' } }), 1);
  // The database refuses the same closing without a reason, even by hand.
  await assert.rejects(db.withdrawalRequest.update({ where: { id: item.id }, data: { status: 'completed' } }),
    /withdrawal_requests_completed_needs_order/);
});

test('a running chargeback parks the order instead of granting access', async () => {
  const keys = await redis.keys('trainerb:rl:guest-*'); if (keys.length) await redis.del(...keys);
  const order = await paidOrder({ confirm: false });
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  // The bank announces a case before the transfer is even confirmed.
  const dispute = await admin.change('post', `/admin/orders/${order.id}/disputes`,
    { provider_dispute_id: `dp_${uuidv7().replace(/-/g, '').slice(0, 20)}`, amount_cents: '19900',
      status: 'warning' });
  status(dispute, 201);

  // While the payment is not booked, a lost case would be a claim about money
  // that never arrived — it stays a notice instead of turning into "money gone".
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const early = await admin.change('post', `/admin/orders/${order.id}/disputes`,
    { provider_dispute_id: dispute.body.provider_dispute_id, amount_cents: '19900', status: 'lost' });
  status(early, 409); assert.equal(early.body.code, 'ORDER_NOT_PAID');

  // Confirming the payment must not hand out a course for money that may be gone.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const confirm = await admin.change('post', `/admin/orders/${order.id}/confirm-payment`,
    { reference: `Kontoauszug ${Date.now()}` });
  status(confirm, 200);
  const parked = await db.order.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(parked.payment_state, 'paid', 'the money did arrive and is recorded');
  assert.equal(parked.fulfillment_state, 'blocked', 'but the order is parked, not fulfilled');
  assert.equal(parked.fulfilled_at, null);
  assert.equal(await db.courseAccess.count({ where: { order_id: order.id } }), 0);
  // No "access is unlocked" mail, because it would be a lie. Scoped to this
  // order: earlier tests queue the same template for their own orders.
  assert.equal(await db.emailOutbox.count({ where: { to_email: buyerUser.email_original,
    template_version: { template: { key: 'order_paid' } },
    variables_public: { path: ['order_number'], equals: parked.order_number } } }), 0);
  // The archive knows why it is parked.
  const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'fulfilment.blocked_by_dispute',
    target_ref: order.id } });
  assert.equal(audit.after_safe.dispute_id, dispute.body.id);

  // A lost case stays lost: the order is charged back, access stays away.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  status(await admin.change('post', `/admin/orders/${order.id}/disputes`,
    { provider_dispute_id: dispute.body.provider_dispute_id, amount_cents: '19900', status: 'lost' }), 200);
  assert.equal(await db.courseAccess.count({ where: { order_id: order.id } }), 0);
  assert.equal(await db.order.findUniqueOrThrow({ where: { id: order.id } }).then(row => row.fulfillment_state),
    'blocked', 'a lost case does not silently fulfil anything');
});

test('a won chargeback releases the parked order and grants the access once', async () => {
  const keys = await redis.keys('trainerb:rl:*'); if (keys.length) await redis.del(...keys);
  const order = await paidOrder({ confirm: false });
  const providerDisputeId = `dp_${uuidv7().replace(/-/g, '').slice(0, 20)}`;
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  status(await admin.change('post', `/admin/orders/${order.id}/disputes`,
    { provider_dispute_id: providerDisputeId, amount_cents: '19900', status: 'open' }), 201);
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  status(await admin.change('post', `/admin/orders/${order.id}/confirm-payment`,
    { reference: `Kontoauszug ${Date.now()}` }), 200);
  assert.equal(await db.courseAccess.count({ where: { order_id: order.id } }), 0);

  // We win: the money stayed, so the buyer gets what was paid for.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const won = await admin.change('post', `/admin/orders/${order.id}/disputes`,
    { provider_dispute_id: providerDisputeId, amount_cents: '19900', status: 'won' });
  status(won, 200);
  const released = await db.order.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(released.fulfillment_state, 'fulfilled');
  assert.ok(released.fulfilled_at);
  assert.equal(await db.courseAccess.count({ where: { order_id: order.id, revoked_at: null } }), 1);
  // Delivering the same outcome again grants nothing twice.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  status(await admin.change('post', `/admin/orders/${order.id}/disputes`,
    { provider_dispute_id: providerDisputeId, amount_cents: '19900', status: 'won' }), 200);
  assert.equal(await db.courseAccess.count({ where: { order_id: order.id } }), 1);
});

test('during a running chargeback the access can be paused but not revoked', async () => {
  const keys = await redis.keys('trainerb:rl:*'); if (keys.length) await redis.del(...keys);
  const order = await paidOrder();
  const providerDisputeId = `dp_${uuidv7().replace(/-/g, '').slice(0, 20)}`;
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const dispute = await admin.change('post', `/admin/orders/${order.id}/disputes`,
    { provider_dispute_id: providerDisputeId, amount_cents: '19900', status: 'open' });
  status(dispute, 201);

  // Ending the access now would be a verdict on a case without an outcome.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const early = await admin.change('post', `/admin/disputes/${dispute.body.id}/access-decision`,
    { decision: 'revoked', reason: 'chargeback_open' });
  status(early, 409); assert.equal(early.body.code, 'DISPUTE_NOT_RESOLVED');

  // Pausing is exactly what "we do not know yet" means, and it is recorded.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const paused = await admin.change('post', `/admin/disputes/${dispute.body.id}/access-decision`,
    { decision: 'suspended', reason: 'chargeback_pending' });
  status(paused, 200);
  const access = await db.courseAccess.findFirstOrThrow({ where: { order_id: order.id } });
  assert.ok(access.suspended_at, 'the grant is paused, not erased');
  assert.equal(access.revoked_at, null);
  assert.equal(access.suspend_reason, 'chargeback_pending');
  const decision = await db.orderAccessDecision.findFirstOrThrow({ where: { dispute_id: dispute.body.id } });
  assert.equal(decision.decision, 'suspended');

  // After the case is lost, revoking is allowed — now there is an outcome.
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  status(await admin.change('post', `/admin/orders/${order.id}/disputes`,
    { provider_dispute_id: providerDisputeId, amount_cents: '19900', status: 'lost' }), 200);
  await freshReauth(admin, adminUser.id, adminTotp, adminRecovery);
  const revoked = await admin.change('post', `/admin/disputes/${dispute.body.id}/access-decision`,
    { decision: 'revoked', reason: 'chargeback_lost' });
  status(revoked, 200);
  const revokedAccess = await db.courseAccess.findFirstOrThrow({ where: { order_id: order.id } });
  assert.ok(revokedAccess.revoked_at);
  assert.equal(revokedAccess.suspended_at, null);
});

test('the decision reasons the API offers are the ones the database accepts', async () => {
  const reasons = await admin.get('/admin/withdrawal-requests/decision-reasons'); status(reasons, 200);
  const codes = reasons.body.data.map(entry => entry.code);
  assert.ok(codes.includes('order_not_found'));
  assert.ok(!codes.includes('kunde_hat_angerufen'));
  // A code outside the vocabulary is refused by the database, so a hand-written
  // row cannot introduce a reason that no filter knows about.
  // Two guards stand in the way of a hand-written row: the close-reason rule for
  // an order-less case, and the vocabulary itself.
  await assert.rejects(db.withdrawalRequest.create({ data: {
    id: uuidv7(), contact_email: 'reason-check@example.invalid',
    contact_email_hmac: Buffer.from('x'), status: 'rejected', submitted_at: new Date(),
    processed_by: adminUser.id, processed_at: new Date(), decision_reason: 'freitext_grund' } }),
  /withdrawal_requests_decision_reason_codes|WITHDRAWAL_CLOSE_REASON/);
  const withOrder = await db.withdrawalRequest.findFirstOrThrow({ where: { order_id: { not: null },
    status: 'completed' } });
  await assert.rejects(db.withdrawalRequest.update({ where: { id: withOrder.id },
    data: { decision_reason: 'freitext_grund' } }),
  /withdrawal_requests_decision_reason_codes/);
});
