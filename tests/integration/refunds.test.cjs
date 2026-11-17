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
