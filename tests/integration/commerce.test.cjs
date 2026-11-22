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

const origin = 'https://academy.test';
const password = 'Kranich!Sonne2026';
let app, db, server, redis, admin, adminUser, adminRecovery, buyer, buyerUser, course, product, price;
const now = () => new Date();
const iso = date => date.toISOString().slice(0, 16) + 'Z';

class Browser {
  constructor() { this.cookies = new Map(); }
  collect(response) {
    for (const line of response.headers['set-cookie'] || []) {
      const pair = line.split(';', 1)[0], at = pair.indexOf('=');
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
  async change(method, path, body, options = {}) {
    let csrf;
    if (!options.noCsrf) { const response = await this.get('/auth/csrf'); status(response, 200); csrf = response.body.csrf_token; }
    const r = request(server)[method](`/api/v1${path}`).set('Origin', options.origin || origin);
    if (this.cookies.size) r.set('Cookie', this.cookie());
    if (csrf) r.set('X-CSRF-Token', csrf);
    if (body !== undefined) r.send(body);
    return this.collect(await r);
  }
}
function status(response, expected) { assert.equal(response.status, expected, JSON.stringify(response.body)); }
async function activate(user) {
  const mail = await db.emailOutbox.findFirstOrThrow({ where: { user_id: user.id, template_version: { template: { key: 'activation' } } } });
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
async function grant(userId, roleKeys) {
  status(await admin.change('put', `/admin/users/${userId}/roles`, { role_keys: roleKeys, reason_code: 'staff_change' }), 200);
}
// Each reauthentication needs an unused second factor: a TOTP step can only be
// consumed once, so the suite spends one recovery code per sensitive action.
let recoveryIndex = 0;
async function freshReauth(browser, userId) {
  await db.authSession.updateMany({ where: { user_id: userId, kind: 'backoffice', revoked_at: null },
    data: { reauthenticated_at: new Date(Date.now() - 10 * 60_000) } });
  const recovery_code = adminRecovery[recoveryIndex++];
  assert.ok(recovery_code, 'no recovery code left for this test run');
  status(await browser.change('post', '/auth/reauth', { password, recovery_code }), 204);
}
/** Legal versions currently active, as the checkout form would send them. */
async function legalVersions() {
  const versions = await db.legalDocumentVersion.findMany({ where: { status: 'active' }, include: { document: true } });
  return Object.fromEntries(versions.map(version => [version.document.kind, version.id]));
}
const address = { company: null, first_name: 'Test', last_name: 'Käufer', street: 'Testweg 1', street_extra: null,
  postal_code: '52062', city: 'Aachen', region: null, country: 'DE', vat_id: null };
async function checkoutBody(extra = {}) {
  return { idempotency_key: `test-${uuidv7()}`, billing_address: address, payment_method: 'invoice',
    legal_versions: await legalVersions(), terms_accepted: true, withdrawal_notice_seen: true,
    privacy_notice_seen: true, ...extra };
}

before(async () => {
  assert.equal(process.env.TRAINERB_DESTRUCTIVE_TEST_DATABASE, 'confirmed');
  assert.match(new URL(process.env.DATABASE_URL).pathname, /_test$/);
  app = await createApplication(); await app.listen(0, '127.0.0.1'); server = app.getHttpServer(); db = app.get(Database);
  await db.$executeRawUnsafe('TRUNCATE TABLE courses, users, roles, permissions, email_templates, email_template_versions, email_outbox, automation_jobs, automation_job_attempts RESTART IDENTITY CASCADE');
  await seedCatalog(db); await seedCommerce(db);
  redis = new Redis(process.env.REDIS_URL);
  const keys = await redis.keys('trainerb:rl:*'); if (keys.length) await redis.del(...keys);
  execFileSync(process.execPath, ['apps/api/dist/cli/bootstrap.js'], { env: { ...process.env,
    BOOTSTRAP_ADMIN_EMAIL: 'commerce-admin@example.invalid', BOOTSTRAP_ADMIN_FIRST_NAME: 'Test',
    BOOTSTRAP_ADMIN_LAST_NAME: 'Admin' }, stdio: 'pipe' });
  adminUser = await db.user.findUniqueOrThrow({ where: { email_canonical: 'commerce-admin@example.invalid' } });
  await activate(adminUser);
  admin = new Browser();
  const logged = await admin.change('post', '/auth/login', { email: adminUser.email_canonical, password });
  status(logged, 202); assert.equal(logged.body.status, 'mfa_enrollment_required');
  const setup = await admin.change('post', '/auth/mfa/enrollment/start', {}); status(setup, 200);
  const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(setup.body.secret) });
  const confirmed = await admin.change('post', '/auth/mfa/enrollment/confirm', { code: totp.generate() });
  status(confirmed, 200); adminRecovery = confirmed.body.recovery_codes;

  const fixture = await register('commerce-buyer'); buyerUser = fixture.user;
  status(await fixture.browser.change('post', '/auth/login', { email: fixture.email, password }), 200);
  buyer = fixture.browser;

  // A published course with a chapter and a content block: the learning area
  // needs real content, and the guards require a published version.
  const created = await admin.change('post', '/admin/courses', { slug: 'commerce-kurs', title: 'Kurs für Buchung',
    visibility: 'public' });
  status(created, 201);
  const version = await db.courseVersion.findFirstOrThrow({ where: { course_id: created.body.id, state: 'draft' } });
  status(await admin.change('patch', `/admin/course-versions/${version.id}`, { revision: version.revision,
    title: 'Kurs für Buchung', subtitle: 'Mit Inhalt', duration_minutes: 120, expected_module_count: 1,
    expected_chapter_count: 1 }), 200);
  const moduleResponse = await admin.change('post', `/admin/course-versions/${version.id}/modules`, { title: 'Modul Eins',
    position: 1 });
  status(moduleResponse, 201);
  const chapterResponse = await admin.change('post', `/admin/course-modules/${moduleResponse.body.id}/chapters`,
    { title: 'Kapitel Eins', summary: 'Kurz', position: 1 });
  status(chapterResponse, 201);
  status(await admin.change('post', `/admin/course-chapters/${chapterResponse.body.id}/contents`,
    { block: { kind: 'paragraph', text: 'Inhalt des Kapitels.' }, position: 1 }), 201);
  course = { id: created.body.id, version_id: version.id, chapter_id: chapterResponse.body.id };
  await freshReauth(admin, adminUser.id);
  const draftVersion = await db.courseVersion.findFirstOrThrow({ where: { course_id: course.id, state: 'draft' } });
  status(await admin.change('post', `/admin/courses/${course.id}/publish`,
    { version_id: draftVersion.id, revision: draftVersion.revision }), 200);

  const productResponse = await admin.change('post', '/admin/products', { sku: 'COMMERCE-01', type: 'single',
    title: 'Kurs für Buchung (Produkt)', description: 'Buchbares Testprodukt mit einem Kurs.',
    courses: [{ course_id: course.id, access_days_override: 365 }] });
  status(productResponse, 201); product = productResponse.body;
  const priceResponse = await admin.change('post', `/admin/products/${product.id}/prices`, { currency: 'EUR',
    gross_cents: '19900', tax_category: 'standard', valid_from: iso(new Date(Date.now() - 60_000)) });
  status(priceResponse, 201); price = priceResponse.body;
  await freshReauth(admin, adminUser.id);
  const productDraft = await db.product.findUniqueOrThrow({ where: { id: product.id } });
  status(await admin.change('post', `/admin/products/${product.id}/activate`, { revision: productDraft.revision }), 200);
  const priceDraft = await db.price.findUniqueOrThrow({ where: { id: price.id } });
  status(await admin.change('post', `/admin/prices/${price.id}/activate`, { revision: priceDraft.revision }), 200);
});
after(async () => { if (redis) redis.disconnect(); if (app) await app.close(); });

test('selling stays disabled until an operator enables it, and legal texts must be activated', async () => {
  const anonymous = new Browser();
  const config = await anonymous.get('/shop/config'); status(config, 200);
  assert.equal(config.body.sales_enabled, false);
  assert.deepEqual(config.body.legal, {}); // only drafts exist after the seed
  const catalog = await anonymous.get('/shop/products'); status(catalog, 200);
  assert.equal(catalog.body.sales_enabled, false); assert.deepEqual(catalog.body.data, []);
  status(await anonymous.get(`/shop/products/${product.id}`), 404);
  // Nothing can be added to a cart while sales are disabled, and an incomplete
  // consent block is rejected before any order exists.
  status(await buyer.change('post', '/cart/items', { product_id: product.id }), 409);
  const incomplete = await buyer.change('post', '/orders', await checkoutBody());
  status(incomplete, 422); assert.equal(incomplete.body.code, 'LEGAL_REQUIRED');
  assert.equal(await db.order.count(), 0);

  await db.commerceSettings.update({ where: { id: 1 }, data: { sales_enabled: true } });
  const cfg=require('../../apps/api/dist/config').getConfig(),saved=cfg.appEnv;
  try {cfg.appEnv='production'; // isolated DB is intentionally enabled; no production sign-off is present
    assert.equal((await anonymous.get('/shop/config')).body.sales_enabled,false);
    assert.deepEqual((await anonymous.get('/shop/products')).body.data,[]);
    status(await anonymous.get(`/shop/products/${product.id}`),404);
    status(await buyer.change('post','/cart/items',{product_id:product.id}),409);
  }finally{cfg.appEnv=saved;}
  const sellable = await anonymous.get('/shop/products'); status(sellable, 200);
  assert.equal(sellable.body.sales_enabled, true);
  assert.equal(sellable.body.data.length, 1);
  assert.equal(sellable.body.data[0].gross_cents, '19900');
  const detail = await anonymous.get(`/shop/products/${product.id}`); status(detail, 200);
  assert.equal(detail.body.courses[0].slug, 'commerce-kurs');

  // Cart works, but checkout refuses while no legally binding wording exists.
  status(await buyer.change('post', '/cart/items', { product_id: product.id }), 200);
  const blocked = await buyer.change('post', '/orders', await checkoutBody());
  status(blocked, 422); assert.equal(blocked.body.code, 'LEGAL_REQUIRED');
  assert.equal(await db.order.count(), 0);
});

test('invoice checkout creates an immutable order, and access appears only after confirmed payment', async () => {
  // Activate one wording per document kind.
  for (const kind of ['terms', 'withdrawal', 'privacy']) {
    const document = await db.legalDocument.findFirstOrThrow({ where: { kind } });
    const version = await db.legalDocumentVersion.findFirstOrThrow({ where: { document_id: document.id, status: 'draft' } });
    await admin.change('post', `/admin/commerce/legal`, { kind, wording: `Wortlaut ${kind} (geprüft).` }).then(r => status(r, 201));
    const drafts = await db.legalDocumentVersion.findMany({ where: { document_id: document.id, status: 'draft' },
      orderBy: { version: 'desc' } });
    await freshReauth(admin, adminUser.id);
    status(await admin.change('post', `/admin/commerce/legal/${drafts[0].id}/activate`, {}), 200);
    assert.ok(version);
  }
  const versions = await legalVersions();
  assert.deepEqual(Object.keys(versions).sort(), ['privacy', 'terms', 'withdrawal']);

  const before = await buyer.get('/me/courses'); status(before, 200); assert.deepEqual(before.body.data, []);
  status(await buyer.get('/me/courses/commerce-kurs'), 404);
  status(await buyer.get(`/me/courses/commerce-kurs/chapters/${course.chapter_id}`), 404);

  // A stale legal version is rejected instead of silently accepted.
  const stale = await checkoutBody({ legal_versions: { ...versions, terms: versions.privacy } });
  const staleResponse = await buyer.change('post', '/orders', stale);
  status(staleResponse, 409); assert.equal(staleResponse.body.code, 'LEGAL_CHANGED');

  // An unsupported country, a bad IBAN-free address or a missing consent fails.
  status(await buyer.change('post', '/orders', await checkoutBody({ billing_address: { ...address, country: 'US' } })), 422);
  status(await buyer.change('post', '/orders', await checkoutBody({ terms_accepted: false })), 422);

  const body = await checkoutBody();
  const placed = await buyer.change('post', '/orders', body); status(placed, 201);
  assert.equal(placed.body.payment_state, 'awaiting');
  assert.equal(placed.body.payment_method, 'invoice');
  assert.equal(placed.body.total_gross_cents, '19900');
  assert.match(placed.body.order_number, /^TB-\d{4}-\d{6}$/);
  assert.ok(placed.body.invoice.invoice_number.startsWith('TB-RE-'));
  assert.equal(placed.body.invoice.total_gross_cents, '19900');
  assert.ok(placed.body.bank.iban); // payment instructions are shown to the buyer
  assert.equal(placed.body.items[0].courses[0].course_id, course.id);
  // The tax split is stored per position and adds up exactly: 19 % of 199,00 €
  // are 31,77 € with 167,23 € net — not a rounded percentage of a float.
  const item = await db.orderItem.findFirstOrThrow({ where: { order_id: placed.body.id } });
  assert.equal(item.tax_rate_bp, 1900);
  assert.equal(item.total_gross_cents, 19900n);
  assert.equal(item.net_cents, 16723n);
  assert.equal(item.tax_cents, 3177n);
  assert.equal(item.tax_label, '19 %');
  const frozen = await db.invoice.findFirstOrThrow({ where: { order_id: placed.body.id } });
  assert.equal(frozen.lines_snapshot[0].tax_rate_bp, 1900);
  assert.equal(frozen.lines_snapshot[0].net_cents, '16723');
  assert.equal(frozen.lines_snapshot[0].tax_cents, '3177');
  // The database refuses a position whose three numbers do not add up, and one
  // whose split does not match its rate — a hand-written row cannot fake a tax
  // breakdown either.
  await assert.rejects(db.$executeRawUnsafe(
    `UPDATE order_items SET net_cents = net_cents + 1 WHERE order_id = '${placed.body.id}'::uuid`));
  await assert.rejects(db.$executeRawUnsafe(
    `UPDATE order_items SET tax_rate_bp = 700 WHERE order_id = '${placed.body.id}'::uuid`));
  // The rate is data with a period: it can be closed, and afterwards no sale may
  // silently fall back to zero percent.
  const rate = await db.taxRate.findFirstOrThrow({ where: { category: 'standard', valid_until: null } });
  const closed = await admin.change('post', `/admin/commerce/tax-rates/${rate.id}/close`, {});
  status(closed, 200);
  const rates = await admin.get('/admin/commerce/tax-rates'); status(rates, 200);
  assert.equal(rates.body.data.find(row => row.id === rate.id).current, false);
  // Reopening the same period is an overlap, not a new row with the same start.
  const overlap = await admin.change('post', '/admin/commerce/tax-rates',
    { category: 'standard', rate_bp: '1900', label: '19 %', valid_from: '2021-01-01T00:00:00Z' });
  status(overlap, 409); assert.equal(overlap.body.code, 'TAX_RATE_OVERLAP');
  // A rate of 100 % or a malformed one never becomes a row.
  status(await admin.change('post', '/admin/commerce/tax-rates',
    { category: 'standard', rate_bp: '9901', label: 'x' }), 422);
  status(await admin.change('post', '/admin/commerce/tax-rates',
    { category: 'standard', rate_bp: '19,5', label: 'x' }), 422);
  // New sales need a current rate again: restore one for the rest of the suite.
  await admin.change('post', '/admin/commerce/tax-rates',
    { category: 'standard', rate_bp: '1900', label: '19 %', is_default: true });

  // Idempotency: the same key returns the same order instead of a second one.
  const replay = await buyer.change('post', '/orders', body); status(replay, 201);
  assert.equal(replay.body.id, placed.body.id);
  assert.equal(await db.order.count(), 1);

  // Unpaid order grants nothing — neither in the learning area nor in the DB.
  const unpaid = await buyer.get('/me/courses'); assert.deepEqual(unpaid.body.data, []);
  status(await buyer.get('/me/courses/commerce-kurs'), 404);
  assert.equal(await db.courseAccess.count(), 0);
  // The cart is consumed by the order.
  const emptyCart = await buyer.get('/cart'); status(emptyCart, 200); assert.deepEqual(emptyCart.body.items, []);
  // The database itself refuses a paid transition without payment evidence.
  await assert.rejects(db.order.update({ where: { id: placed.body.id }, data: { payment_state: 'paid',
    paid_at: now(), paid_confirmed_by: adminUser.id } }));
  // And a transition that pays and fulfils at once is refused as well.
  await assert.rejects(db.order.update({ where: { id: placed.body.id }, data: { payment_state: 'paid',
    paid_at: now(), paid_confirmed_by: adminUser.id, fulfillment_state: 'fulfilled', fulfilled_at: now() } }));
  const stillUnpaid = await db.order.findUniqueOrThrow({ where: { id: placed.body.id } });
  assert.equal(stillUnpaid.payment_state, 'awaiting');
  assert.equal(stillUnpaid.fulfillment_state, 'waiting');

  // Confirming the transfer needs a fresh second factor.
  await db.authSession.updateMany({ where: { user_id: adminUser.id, kind: 'backoffice', revoked_at: null },
    data: { reauthenticated_at: new Date(Date.now() - 30 * 60_000) } });
  const denied = await admin.change('post', `/admin/orders/${placed.body.id}/confirm-payment`, { reference: 'Kontoauszug 1' });
  status(denied, 403); assert.equal(denied.body.code, 'REAUTH_REQUIRED');
  await freshReauth(admin, adminUser.id);
  status(await admin.change('post', `/admin/orders/${placed.body.id}/confirm-payment`, { reference: '' }), 422);
  const paid = await admin.change('post', `/admin/orders/${placed.body.id}/confirm-payment`, { reference: 'Kontoauszug 1',
    note: 'Überweisung eingegangen' });
  status(paid, 200);
  assert.equal(paid.body.payment_state, 'paid');
  assert.equal(paid.body.fulfillment_state, 'fulfilled');
  assert.equal(paid.body.access.length, 1);
  assert.equal(paid.body.access[0].revoked, false);

  // Now the buyer can actually learn: outline, chapter body and completion.
  const mine = await buyer.get('/me/courses'); status(mine, 200);
  assert.equal(mine.body.data.length, 1); assert.equal(mine.body.data[0].chapter_count, 1);
  const outline = await buyer.get('/me/courses/commerce-kurs'); status(outline, 200);
  assert.equal(outline.body.modules[0].chapters[0].content_count, 1);
  const chapter = await buyer.get(`/me/courses/commerce-kurs/chapters/${course.chapter_id}`); status(chapter, 200);
  assert.equal(chapter.body.contents[0].body.blocks[0].text, 'Inhalt des Kapitels.');
  const completed = await buyer.change('post', `/me/courses/commerce-kurs/chapters/${course.chapter_id}/complete`, {});
  status(completed, 200); assert.ok(completed.body.completed_at);
  const again = await buyer.change('post', `/me/courses/commerce-kurs/chapters/${course.chapter_id}/complete`, {});
  status(again, 200);
  assert.equal(await db.chapterProgress.count(), 1);

  // A second, unrelated account never sees that content.
  const strangerFixture = await register('commerce-stranger');
  status(await strangerFixture.browser.change('post', '/auth/login', { email: strangerFixture.email, password }), 200);
  status(await strangerFixture.browser.get('/me/courses/commerce-kurs'), 404);
  status(await strangerFixture.browser.get(`/me/courses/commerce-kurs/chapters/${course.chapter_id}`), 404);
  status(await strangerFixture.browser.get('/admin/orders'), 403);
  status(await strangerFixture.browser.get(`/orders/${placed.body.id}`), 404);
});

test('the invoice is an immutable document: issued once, downloaded only by its owner', async () => {
  const order = await db.order.findFirstOrThrow({ where: { user_id: { not: null }, payment_state: 'paid' } });
  const buyer = new Browser();
  const owner = await db.user.findUniqueOrThrow({ where: { id: order.user_id } });
  status(await buyer.change('post', '/auth/login', { email: owner.email_canonical, password }), 200);

  const list = await buyer.get('/invoices'); status(list, 200);
  const entry = list.body.data.find(row => row.order_id === order.id);
  assert.ok(entry, 'the paid order appears in the invoice list');
  assert.match(entry.invoice_number, /^TB-RE-\d{4}-\d{6}$/);
  assert.equal(entry.total_gross_cents, String(order.total_gross_cents));
  assert.equal(entry.payment_state, 'paid');

  const pdf = await buyer.get(`/invoices/${entry.id}/pdf`);
  status(pdf, 200);
  assert.match(pdf.headers['content-type'], /application\/pdf/);
  assert.match(pdf.headers['content-disposition'], /attachment; filename="Rechnung-TB-RE-\d{4}-\d{6}\.pdf"/);
  assert.match(pdf.headers['cache-control'], /no-store/);
  assert.equal(pdf.headers['x-content-type-options'], 'nosniff');
  const raw = pdf.body.toString('latin1');
  assert.ok(raw.startsWith('%PDF-1.4'));
  assert.ok(raw.trimEnd().endsWith('%%EOF'));
  // The document is rebuilt from the snapshot, so a later change to the product
  // or the settings must not alter an already issued invoice.
  const stored = await db.invoice.findUniqueOrThrow({ where: { id: entry.id } });
  const before = pdf.body;
  await db.commerceSettings.update({ where: { id: 1 }, data: { invoice_seller_name: 'Anderer Steller' } });
  const second = await buyer.get(`/invoices/${entry.id}/pdf`); status(second, 200);
  assert.deepEqual(second.body, before);
  assert.ok(!second.body.toString('latin1').includes('Anderer Steller'));
  await db.commerceSettings.update({ where: { id: 1 }, data: { invoice_seller_name: 'Trainer B Akademie (Platzhalter – bitte ergänzen)' } });

  // Another account and an anonymous caller get the same `404` as for any id.
  const stranger = await register('invoice-stranger');
  status(await stranger.browser.change('post', '/auth/login', { email: stranger.email, password }), 200);
  status(await stranger.browser.get(`/invoices/${entry.id}/pdf`), 404);
  status(await request(server).get(`/api/v1/invoices/${entry.id}/pdf`), 401);
  // A random id is indistinguishable from a foreign one.
  status(await buyer.get(`/invoices/${uuidv7()}/pdf`), 404);

  // Staff support access requires the order permission, not the buyer session.
  status(await buyer.get(`/admin/invoices/${entry.id}/pdf`), 403);
  const staffPdf = await admin.get(`/admin/invoices/${entry.id}/pdf`); status(staffPdf, 200);
  assert.deepEqual(staffPdf.body, before);
  // A paid order links to its document; an unpaid transfer order does not.
  const detail = await buyer.get(`/orders/${order.id}`); status(detail, 200);
  assert.equal(detail.body.invoice.pdf_href, `/invoices/${entry.id}/pdf`);
  const pending = await db.order.create({ data: { id: uuidv7(),
    order_number: `TB-2026-${String(Date.now()).slice(-6)}`, checkout_idempotency_key: `inv-${uuidv7()}`,
    user_id: order.user_id, buyer_email_original: owner.email_original,
    buyer_email_canonical: owner.email_canonical, currency: 'EUR', payment_method: 'invoice',
    payment_state: 'awaiting', fulfillment_state: 'waiting', subtotal_gross_cents: 1000n, discount_cents: 0n,
    total_gross_cents: 1000n, billing_snapshot: { first_name: 'Gina', last_name: 'Gast', country: 'DE' },
    due_at: new Date(), created_by: order.user_id } });
  // The numbering format is fixed at six digits; `% 100000` alone can produce
  // fewer and trip the format check on a slow day.
  await db.invoice.create({ data: { id: uuidv7(), order_id: pending.id,
    invoice_number: `TB-RE-2026-9${String(Date.now() % 100000).padStart(5, '0')}`,
    seller_snapshot: { name: 'X' }, buyer_snapshot: { first_name: 'Gina' }, lines_snapshot: [], total_gross_cents: 1000n,
    currency: 'EUR' } });
  const pendingView = await buyer.get(`/orders/${pending.id}`); status(pendingView, 200);
  assert.equal(pendingView.body.invoice.pdf_href, null, 'an unpaid order never offers a document link');
  assert.ok(stored.lines_snapshot.length >= 1);
});

test('coupons are validated, cannot be reused and are released on cancellation', async () => {
  await db.commerceSettings.update({ where: { id: 1 }, data: { sales_enabled: true } });
  const created = await admin.change('post', '/admin/coupons', { code: 'Willkommen10', type: 'percent', value: 1000,
    active: true });
  status(created, 201); assert.equal(created.body.code, 'WILLKOMMEN10');

  // The buyer already owns the course, so a second purchase is refused instead
  // of silently granting nothing.
  status(await buyer.change('post', '/cart/items', { product_id: product.id }), 409);

  const secondFixture = await register('commerce-coupon');
  status(await secondFixture.browser.change('post', '/auth/login', { email: secondFixture.email, password }), 200);
  const second = secondFixture.browser;
  const cart = await second.change('post', '/cart/items', { product_id: product.id }); status(cart, 200);
  const discounted = await second.change('post', '/cart/coupon', { coupon_code: 'willkommen10' });
  status(discounted, 200);
  assert.equal(discounted.body.discount_cents, '1990');
  assert.equal(discounted.body.total_gross_cents, '17910');
  status(await second.change('post', '/cart/coupon', { coupon_code: 'GIBTESNICHT' }), 422);

  const placed = await second.change('post', '/orders', await checkoutBody({ coupon_code: 'WILLKOMMEN10' }));
  status(placed, 201);
  assert.equal(placed.body.discount_cents, '1990');
  assert.equal(placed.body.total_gross_cents, '17910');
  assert.equal(placed.body.coupon_code, 'WILLKOMMEN10');
  // The same person cannot reserve the coupon twice.
  status(await second.change('post', '/cart/items', { product_id: product.id }), 200);
  const reused = await second.change('post', '/orders', await checkoutBody({ coupon_code: 'WILLKOMMEN10' }));
  status(reused, 422); assert.equal(reused.body.code, 'COUPON_ALREADY_USED');
  const reservation = await db.couponReservation.findFirstOrThrow({ where: { order_id: placed.body.id } });
  assert.equal(reservation.status, 'reserved');

  // Cancelling releases the coupon and leaves the order without access.
  await freshReauth(admin, adminUser.id);
  const cancelled = await admin.change('post', `/admin/orders/${placed.body.id}/cancel`, { reason: 'customer_request' });
  status(cancelled, 200);
  assert.equal(cancelled.body.payment_state, 'cancelled');
  const released = await db.couponReservation.findFirstOrThrow({ where: { order_id: placed.body.id } });
  assert.equal(released.status, 'released');
  assert.equal(await db.courseAccess.count({ where: { order_id: placed.body.id } }), 0);
});

test('stripe is unavailable without keys and the webhook rejects unsigned callbacks', async () => {
  const anonymous = new Browser();
  const config = await anonymous.get('/shop/config'); status(config, 200);
  assert.equal(config.body.stripe_enabled, false);
  const body = await request(server).post('/api/v1/payments/stripe/webhook').set('Content-Type', 'application/json')
    .send({ id: 'evt_test', type: 'checkout.session.completed' });
  assert.equal(body.status, 409);
  assert.equal(body.body.code, 'STRIPE_UNAVAILABLE');
});

test('manual access grants are audited and never create an order or invoice', async () => {
  const fixture = await register('commerce-manual');
  const ordersBefore = await db.order.count(), invoicesBefore = await db.invoice.count();
  await freshReauth(admin, adminUser.id);
  const granted = await admin.change('post', '/admin/accesses', { user_id: fixture.user.id, course_id: course.id,
    access_days: 30, reason: 'goodwill' });
  status(granted, 201);
  assert.equal(await db.order.count(), ordersBefore);
  assert.equal(await db.invoice.count(), invoicesBefore);
  const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'access.granted_manually' } });
  assert.equal(audit.target_ref, granted.body.id);
  status(await fixture.browser.change('post', '/auth/login', { email: fixture.email, password }), 200);
  const mine = await fixture.browser.get('/me/courses'); status(mine, 200);
  assert.equal(mine.body.data.length, 1);
  // A second active access for the same course is refused.
  await freshReauth(admin, adminUser.id);
  status(await admin.change('post', '/admin/accesses', { user_id: fixture.user.id, course_id: course.id,
    access_days: 30, reason: 'goodwill' }), 409);
  const revoked = await admin.change('post', `/admin/accesses/${granted.body.id}/revoke`, { reason: 'goodwill' });
  status(revoked, 200);
  status(await fixture.browser.get('/me/courses/commerce-kurs'), 404);
});

test('imprint review pins provider data; changing identity pauses new sales without modifying historical wording', async () => {
  const audience = new Browser(), path='/admin/provider-profile', legal='/admin/commerce/legal';
  const state=async()=>(await admin.get(path)).body;
  const edit=(revision,details,who=admin,opts)=>who.change('patch',path,{revision,details},opts);
  const draft=(revision,wording)=>admin.change('post',legal,{kind:'imprint',wording,provider_revision:revision});
  const activate=id=>admin.change('post',`${legal}/${id}/activate`,{});
  const config=async()=>(await audience.get('/shop/config')).body;
  const settings=await db.commerceSettings.findUniqueOrThrow({where:{id:1}});
  const {id,updated_at,updated_by,currency,...operatorFields}=settings;
  const enable=()=>admin.change('post','/admin/commerce/settings',{...operatorFields,sales_enabled:true});
  const current=await state();
  const details={responsible_name:'Test Redaktion',legal_provider_name:'Synthetischer Anbieter '+uuidv7(),street:'Testweg 1',postal_code:'12345',city:'Teststadt',country:'de',contact_email:'kontakt@example.invalid'};
  status(await audience.get(path),401); status(await buyer.get(path),403);status(await edit(current.revision,details,buyer),403);
  status(await edit(current.revision,details,admin,{noCsrf:true}),403);
  status(await edit(current.revision,{...details,legal_provider_name:''}),422);
  status(await edit(current.revision,{...details,private_bank_key:'NO'}),400);
  const firstEdit=await Promise.all([edit(current.revision,details),edit(current.revision,details)]);
  assert.deepEqual(firstEdit.map(r=>r.status).sort(),[200,409]);const first=firstEdit.find(r=>r.status===200).body;
  assert.equal((await config()).sales_enabled,false);assert.equal((await config()).legal.imprint,undefined);
  status(await enable(),409);status(await draft(current.revision,'Synthetische Angaben'),409);
  const v1=await draft(first.revision,'Synthetische Angaben'); status(v1,201);status(await activate(v1.body.id),200);
  const snapshot=(await config()).legal.imprint.provider_snapshot;
  assert.equal(snapshot.country,'DE');assert.equal(snapshot.responsible_name,details.responsible_name);
  assert.equal((await config()).sales_enabled,false);status(await enable(),200);
  status(await edit(first.revision,details),200);assert.equal((await config()).sales_enabled,true);
  const stale=await draft(first.revision,'Synthetische Nachfolgefassung');status(stale,201);
  const next=await edit(first.revision,{...details,city:'Anderer Testort'});status(next,200);
  const paused=await config();assert.equal(paused.sales_enabled,false);assert.deepEqual(paused.legal.imprint.provider_snapshot,snapshot);
  status(await activate(stale.body.id),409);status(await enable(),409);
  await assert.rejects(db.legalDocumentVersion.update({where:{id:v1.body.id},data:{provider_snapshot:{city:'overwrite'}}}),/PROVIDER_SNAPSHOT_IMMUTABLE/);
  const v2=await draft(next.body.revision,'Synthetische Nachfolgefassung');status(v2,201);status(await activate(v2.body.id),200);
  assert.equal((await config()).legal.imprint.provider_snapshot.city,'Anderer Testort');assert.equal((await config()).sales_enabled,false);
  const history=(await admin.get('/admin/legal-documents/imprint')).body.versions;
  assert.deepEqual(history.find(v=>v.id===v1.body.id).provider_snapshot,snapshot);
  const audit=await db.auditEvent.findFirstOrThrow({where:{action:'provider_profile.updated'},orderBy:{id:'desc'}});
  assert.deepEqual(audit.after_safe,{revision:next.body.revision,sales_paused:true});
});

test('expired purchase can be bought again without overwriting its grant or learning history', async () => {
  await db.commerceSettings.update({ where: { id: 1 }, data: { sales_enabled: true } });
  const old = await db.courseAccess.findFirstOrThrow({ where: { user_id: buyerUser.id, source: 'order' } });
  const cart = () => buyer.change('post', '/cart/items', { product_id: product.id });
  assert.equal((await cart()).body.code, 'ALREADY_OWNED');
  await db.courseAccess.update({ where: { id: old.id }, data: { starts_at: new Date(Date.now()-86400000), ends_at: new Date(Date.now()-1000) } });
  assert.equal((await buyer.get('/me/courses/commerce-kurs')).body.code, 'ACCESS_EXPIRED');
  status(await cart(), 200);
  const placed = await buyer.change('post', '/orders', await checkoutBody()); status(placed, 201);
  status(await admin.change('post', `/admin/orders/${placed.body.id}/confirm-payment`, { reference: 'Wiederkauf' }), 200);
  const renewed = await db.courseAccess.findFirstOrThrow({ where: { order_id: placed.body.id } });
  assert.notEqual(old.id, renewed.id);
  assert.equal((await db.courseAccess.findUniqueOrThrow({ where: { id: old.id } })).revoked_at, null);
  await assert.rejects(db.courseAccess.update({ where: { id: old.id }, data: { ends_at: null } }));
  const chapter = await buyer.get(`/me/courses/commerce-kurs/chapters/${course.chapter_id}`); status(chapter, 200);
  assert.equal(chapter.body.access_id, renewed.id);
  assert.equal(await db.chapterProgress.count({ where: { access_id: old.id } }), 1);
});

test('a coupon restricted to products only applies when every cart line is covered', async () => {
  await db.commerceSettings.update({ where: { id: 1 }, data: { sales_enabled: true } });
  // Ein zweites Produkt auf demselben Kurs, damit ein Warenkorb entstehen kann,
  // der nicht vollständig abgedeckt ist.
  const second = await admin.change('post', '/admin/products', { sku: 'COMMERCE-02', type: 'single',
    title: 'Zweites Produkt', description: 'Für die Gutscheinprüfung.', courses: [{ course_id: course.id }] });
  status(second, 201);
  const secondPrice = await admin.change('post', `/admin/products/${second.body.id}/prices`, { currency: 'EUR',
    gross_cents: '5000', tax_category: 'standard', valid_from: iso(new Date(Date.now() - 60_000)) });
  status(secondPrice, 201);
  await freshReauth(admin, adminUser.id);
  status(await admin.change('post', `/admin/products/${second.body.id}/activate`,
    { revision: (await db.product.findUniqueOrThrow({ where: { id: second.body.id } })).revision }), 200);
  status(await admin.change('post', `/admin/prices/${secondPrice.body.id}/activate`,
    { revision: (await db.price.findUniqueOrThrow({ where: { id: secondPrice.body.id } })).revision }), 200);

  // Eine Beschränkung auf ein nicht aktives Produkt wäre ein Rabatt, der nie
  // greift. Das zweite Produkt ist aktiv, hat aber keinen aktiven Preis.
  const draft = await admin.change('post', '/admin/products', { sku: 'COMMERCE-DRAFT', type: 'single',
    title: 'Noch im Entwurf', courses: [{ course_id: course.id }] });
  status(draft, 201);
  assert.equal((await db.product.findUniqueOrThrow({ where: { id: draft.body.id } })).status, 'draft');
  const draftCoupon = await admin.change('post', '/admin/coupons', { code: 'nurentwurf', type: 'percent',
    value: 1000, active: true, product_ids: [draft.body.id] });
  assert.equal(draftCoupon.status, 422,
    `Beschränkung nur auf aktive Produkte mit aktivem Preis: ${JSON.stringify(draftCoupon.body)}`);
  status(await admin.change('post', '/admin/coupons', { code: 'nurbekannt', type: 'percent', value: 1000,
    active: true, product_ids: ['00000000-0000-4000-8000-000000000000'] }), 422);

  const restricted = await admin.change('post', '/admin/coupons', { code: 'nurkurs', type: 'percent', value: 1000,
    active: true, product_ids: [product.id] });
  status(restricted, 201);
  assert.deepEqual(restricted.body.product_ids, [product.id]);
  const listed = (await admin.get('/admin/coupons')).body.data.find(c => c.id === restricted.body.id);
  assert.deepEqual(listed.product_ids, [product.id]);
  assert.equal(listed.products[0].title, product.title, 'das Backoffice sieht den Produktnamen, keine UUID');
  assert.equal(listed.products[0].sku, product.sku);

  const fixture = await register('commerce-scope');
  status(await fixture.browser.change('post', '/auth/login', { email: fixture.email, password }), 200);
  const shopper = fixture.browser;

  // Nur das freigegebene Produkt im Warenkorb: der Code gilt.
  status(await shopper.change('post', '/cart/items', { product_id: product.id }), 200);
  const applied = await shopper.change('post', '/cart/coupon', { coupon_code: 'NURKURS' });
  status(applied, 200);
  assert.equal(applied.body.discount_cents, '1990');

  // Zweites, nicht freigegebenes Produkt dazu: der Rabatt gilt nicht mehr, und
  // die Meldung nennt genau den Artikel statt nur „ungültig“.
  status(await shopper.change('post', '/cart/items', { product_id: second.body.id }), 200);
  const mixed = await shopper.change('post', '/cart/coupon', { coupon_code: 'NURKURS' });
  status(mixed, 422);
  assert.equal(mixed.body.code, 'COUPON_NOT_APPLICABLE');
  assert.match(mixed.body.message, /Zweites Produkt/);
  assert.doesNotMatch(mixed.body.message, new RegExp(product.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'der abgedeckte Artikel wird nicht als Problem genannt');

  // Auch der Checkout mit Code entscheidet erneut und lehnt den gemischten
  // Warenkorb ab, damit die Bestellung nicht an der Prüfung im Warenkorb vorbeikommt.
  const blocked = await shopper.change('post', '/orders', await checkoutBody({ coupon_code: 'NURKURS' }));
  assert.equal(blocked.status, 422, `Checkout mit gemischtem Warenkorb: ${JSON.stringify(blocked.body)}`);
  assert.equal(blocked.body.code, 'COUPON_NOT_APPLICABLE');

  // Nach dem Entfernen des zweiten Artikels greift der Code wieder.
  status(await shopper.change('delete', `/cart/items/${second.body.id}`), 200);
  const placed = await shopper.change('post', '/orders', await checkoutBody({ coupon_code: 'NURKURS' }));
  status(placed, 201);
  assert.equal(placed.body.discount_cents, '1990');
  assert.equal(placed.body.total_gross_cents, '17910');
  const reservation = await db.couponReservation.findFirstOrThrow({ where: { order_id: placed.body.id } });
  assert.equal(reservation.coupon_id, restricted.body.id);

  // Datenbankgegenprobe: die Beschränkung steht als eigene Zeile und lässt
  // sich nicht über eine zweite, doppelte Zeile umgehen.
  assert.deepEqual((await db.couponProduct.findMany({ where: { coupon_id: restricted.body.id } }))
    .map(link => link.product_id), [product.id]);
  // Die Kombination ist der Primärschlüssel: eine zweite Zeile ist unmöglich,
  // und eine Einlösung verhindert das Löschen des Gutscheinbelegs.
  await assert.rejects(db.couponProduct.create({ data: { coupon_id: restricted.body.id, product_id: product.id } }));
  await assert.rejects(db.coupon.delete({ where: { id: restricted.body.id } }));
});
