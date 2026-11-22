const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const Redis = require('ioredis');
const OTPAuth = require('otpauth');
const { uuidv7 } = require('uuidv7');
const { createApplication } = require('../../apps/api/dist/application');
const { Database } = require('../../apps/api/dist/database');
const { seedCatalog } = require('../../apps/api/dist/cli/catalog');
const { seedCommerce } = require('../../apps/api/dist/cli/commerce');
const { unseal } = require('../../apps/api/dist/security');
const { documentHash } = require('../../apps/api/dist/document-seal');

/**
 * GoBD-Härtung der Belege: was ein Beleg nach deutschem Recht enthalten und was
 * er aushalten muss.
 *
 * Die Tests prüfen bewusst die Grenzen, an denen eine Buchhaltungsprüfung
 * ansetzt: Pflichtangaben (Steuernummer, Leistungszeitpunkt), Unveränderbarkeit
 * auf Datenbankebene (nicht nur im Code), die Prüfsummenkette, den Nummernkreis
 * über einen Jahreswechsel und die Ausgabe, die tatsächlich beim Steuerberater
 * landet.
 */
const origin = 'https://academy.test';
const password = 'Kranich!Sonne2026';
const iso = date => date.toISOString().slice(0, 16) + 'Z';
let app, db, server, redis, admin, adminUser, adminTotp, adminRecovery;
let buyer, buyerUser, course, product, price;

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
async function enroll(browser, user) {
  const logged = await browser.change('post', '/auth/login', { email: user.email_canonical, password });
  status(logged, 202); assert.equal(logged.body.status, 'mfa_enrollment_required');
  const setup = await browser.change('post', '/auth/mfa/enrollment/start', {}); status(setup, 200);
  const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30,
    secret: OTPAuth.Secret.fromBase32(setup.body.secret) });
  const confirmed = await browser.change('post', '/auth/mfa/enrollment/confirm', { code: totp.generate() });
  status(confirmed, 200);
  return { totp, recovery: confirmed.body.recovery_codes };
}
async function freshReauth() {
  await db.authSession.updateMany({ where: { user_id: adminUser.id, kind: 'backoffice', revoked_at: null },
    data: { reauthenticated_at: new Date(Date.now() - 10 * 60_000) } });
  await db.userMfaFactor.updateMany({ where: { user_id: adminUser.id, type: 'totp', status: 'active' },
    data: { last_accepted_step: null } });
  const keys = await redis.keys('trainer:rl:reauth:*'); if (keys.length) await redis.del(...keys);
  const keys2 = await redis.keys('trainerb:rl:reauth:*'); if (keys2.length) await redis.del(...keys2);
  const payload = adminRecovery.length ? { password, recovery_code: adminRecovery.shift() } : { password, code: adminTotp.generate() };
  status(await admin.change('post', '/auth/reauth', payload), 204);
}
async function legalVersions() {
  const versions = await db.legalDocumentVersion.findMany({ where: { status: 'active' }, include: { document: true } });
  return Object.fromEntries(versions.map(version => [version.document.kind, version.id]));
}
const address = { company: 'Belegfirma GmbH', first_name: 'Test', last_name: 'Käufer', street: 'Testweg 1',
  street_extra: null, postal_code: '52062', city: 'Aachen', region: null, country: 'DE', vat_id: null };
const checkoutBody = async (extra = {}) => ({ idempotency_key: `belege-${uuidv7().replace(/-/g, '')}`,
  billing_address: address, payment_method: 'invoice', legal_versions: await legalVersions(),
  terms_accepted: true, withdrawal_notice_seen: true, privacy_notice_seen: true, ...extra });

let extraIndex = 0;
/**
 * Ein weiteres Produkt auf einem eigenen Kurs.
 *
 * Die Regel "ein aktiver Zugang pro Kurs" verhindert sonst den zweiten Kauf
 * desselben Produkts — die Tests brauchen aber mehrere unabhängige Belege.
 */
async function extraProduct(index) {
  const stamp = `${Date.now().toString(36)}-${index}`;
  const created = await admin.change('post', '/admin/courses', { slug: `belege-kurs-${stamp}`,
    title: `Kurs für Belege ${index}`, visibility: 'public' });
  status(created, 201);
  const version = await db.courseVersion.findFirstOrThrow({ where: { course_id: created.body.id, state: 'draft' } });
  status(await admin.change('patch', `/admin/course-versions/${version.id}`, { revision: version.revision,
    title: `Kurs für Belege ${index}`, subtitle: 'Mit Inhalt', duration_minutes: 60,
    expected_module_count: 1, expected_chapter_count: 1 }), 200);
  const moduleResponse = await admin.change('post', `/admin/course-versions/${version.id}/modules`,
    { title: `Modul ${index}`, position: 1 }); status(moduleResponse, 201);
  const chapter = await admin.change('post', `/admin/course-modules/${moduleResponse.body.id}/chapters`,
    { title: `Kapitel ${index}`, position: 1 }); status(chapter, 201);
  status(await admin.change('post', `/admin/course-chapters/${chapter.body.id}/contents`,
    { block: { kind: 'paragraph', text: 'Inhalt.' }, position: 1 }), 201);
  await freshReauth();
  const draft = await db.courseVersion.findUniqueOrThrow({ where: { id: version.id } });
  status(await admin.change('post', `/admin/courses/${created.body.id}/publish`,
    { version_id: draft.id, revision: draft.revision }), 200);
  const created_product = await admin.change('post', '/admin/products', { sku: `BELEGE-${stamp}`.toUpperCase(),
    type: 'single', title: `Produkt ${index}`, description: 'Buchbar für Belegtests.',
    courses: [{ course_id: created.body.id, access_days_override: 365 }] });
  status(created_product, 201);
  const created_price = await admin.change('post', `/admin/products/${created_product.body.id}/prices`,
    { currency: 'EUR', gross_cents: '11900', tax_category: 'standard',
      valid_from: iso(new Date(Date.now() - 60_000)) });
  status(created_price, 201);
  await freshReauth();
  status(await admin.change('post', `/admin/products/${created_product.body.id}/activate`,
    { revision: (await db.product.findUniqueOrThrow({ where: { id: created_product.body.id } })).revision }), 200);
  status(await admin.change('post', `/admin/prices/${created_price.body.id}/activate`,
    { revision: (await db.price.findUniqueOrThrow({ where: { id: created_price.body.id } })).revision }), 200);
  return created_product.body.id;
}

/** Place an invoice order and confirm the money, so a real document exists. */
async function paidOrder() {
  // Jede Bestellung braucht einen eigenen Kurs: ein zweiter Kauf desselben
  // Kurses wird (zu Recht) mit "bereits im Besitz" abgelehnt.
  const itemId = await extraProduct(++extraIndex);
  status(await buyer.change('post', '/cart/items', { product_id: itemId }), 200);
  const placed = await buyer.change('post', '/orders', await checkoutBody());
  status(placed, 201);
  await freshReauth();
  status(await admin.change('post', `/admin/orders/${placed.body.id}/confirm-payment`,
    { reference: `Kontoauszug ${Date.now()}` }), 200);
  return db.order.findUniqueOrThrow({ where: { id: placed.body.id }, include: { invoice: true } });
}

before(async () => {
  assert.equal(process.env.TRAINERB_DESTRUCTIVE_TEST_DATABASE, 'confirmed');
  assert.match(new URL(process.env.DATABASE_URL).pathname, /_test$/);
  app = await createApplication(); await app.listen(0, '127.0.0.1'); server = app.getHttpServer(); db = app.get(Database);
  await db.$executeRawUnsafe('TRUNCATE TABLE courses, users, roles, permissions, email_templates, email_template_versions, email_outbox, automation_jobs, automation_job_attempts RESTART IDENTITY CASCADE');
  await seedCatalog(db); await seedCommerce(db);
  redis = new Redis(process.env.REDIS_URL);
  const keys = await redis.keys('trainerb:rl:*'); if (keys.length) await redis.del(...keys);

  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, ['apps/api/dist/cli/bootstrap.js'], { env: { ...process.env,
    BOOTSTRAP_ADMIN_EMAIL: 'belege-admin@example.invalid', BOOTSTRAP_ADMIN_FIRST_NAME: 'Test',
    BOOTSTRAP_ADMIN_LAST_NAME: 'Admin' }, stdio: 'pipe' });
  adminUser = await db.user.findUniqueOrThrow({ where: { email_canonical: 'belege-admin@example.invalid' } });
  await activate(adminUser);
  admin = new Browser();
  const mfa = await enroll(admin, adminUser); adminTotp = mfa.totp; adminRecovery = mfa.recovery;

  const fixture = await register('belege-buyer'); buyerUser = fixture.user;
  buyer = fixture.browser;
  status(await buyer.change('post', '/auth/login', { email: fixture.email, password }), 200);

  const created = await admin.change('post', '/admin/courses', { slug: 'belege-kurs', title: 'Kurs für Belege',
    visibility: 'public' });
  status(created, 201);
  const version = await db.courseVersion.findFirstOrThrow({ where: { course_id: created.body.id, state: 'draft' } });
  status(await admin.change('patch', `/admin/course-versions/${version.id}`, { revision: version.revision,
    title: 'Kurs für Belege', subtitle: 'Mit Inhalt', duration_minutes: 60,
    expected_module_count: 1, expected_chapter_count: 1 }), 200);
  const moduleResponse = await admin.change('post', `/admin/course-versions/${version.id}/modules`,
    { title: 'Modul Belege', position: 1 }); status(moduleResponse, 201);
  const chapterResponse = await admin.change('post', `/admin/course-modules/${moduleResponse.body.id}/chapters`,
    { title: 'Kapitel Belege', position: 1 }); status(chapterResponse, 201);
  status(await admin.change('post', `/admin/course-chapters/${chapterResponse.body.id}/contents`,
    { block: { kind: 'paragraph', text: 'Inhalt für Belege.' }, position: 1 }), 201);
  await freshReauth();
  const draft = await db.courseVersion.findUniqueOrThrow({ where: { id: version.id } });
  status(await admin.change('post', `/admin/courses/${created.body.id}/publish`,
    { version_id: draft.id, revision: draft.revision }), 200);
  course = { id: created.body.id, version_id: version.id };

  const productResponse = await admin.change('post', '/admin/products', { sku: 'BELEGE-01', type: 'single',
    title: 'Kurs für Belege (Produkt)', description: 'Buchbar für Belegtests.',
    courses: [{ course_id: course.id, access_days_override: 365 }] });
  status(productResponse, 201); product = productResponse.body;
  price = (await admin.change('post', `/admin/products/${product.id}/prices`, { currency: 'EUR',
    gross_cents: '11900', tax_category: 'standard', valid_from: iso(new Date(Date.now() - 60_000)) })).body;
  await freshReauth();
  status(await admin.change('post', `/admin/products/${product.id}/activate`,
    { revision: (await db.product.findUniqueOrThrow({ where: { id: product.id } })).revision }), 200);
  status(await admin.change('post', `/admin/prices/${price.id}/activate`,
    { revision: (await db.price.findUniqueOrThrow({ where: { id: price.id } })).revision }), 200);

  for (const kind of ['terms', 'withdrawal', 'privacy']) {
    await admin.change('post', '/admin/commerce/legal', { kind, wording: `Geprüfter Wortlaut ${kind}.` });
    const document = await db.legalDocument.findFirstOrThrow({ where: { kind } });
    const latest = await db.legalDocumentVersion.findFirstOrThrow({ where: { document_id: document.id,
      status: 'draft' }, orderBy: { version: 'desc' } });
    await freshReauth();
    status(await admin.change('post', `/admin/commerce/legal/${latest.id}/activate`, {}), 200);
  }
  await db.commerceSettings.update({ where: { id: 1 }, data: { sales_enabled: true } });
});
after(async () => { if (redis) redis.disconnect(); if (app) await app.close(); });

test('settings require a tax number or a VAT id before an invoice can be complete', async () => {
  const settings = await db.commerceSettings.findUniqueOrThrow({ where: { id: 1 } });
  const { id, updated_at, updated_by, currency, ...fields } = settings;
  // Der Verkauf bleibt aus: das Freischalten verlangt zusätzlich die
  // Impressumsfreigabe und gehört nicht zu diesem Test.
  await freshReauth();
  // § 14 Abs. 4 Nr. 2 UStG: eine Rechnung ohne Steuernummer und ohne USt-IdNr.
  // ist keine vollständige Rechnung. Der Server nimmt das nicht an.
  const incomplete = await admin.change('post', '/admin/commerce/settings', { ...fields,
    sales_enabled: false, invoice_seller_tax_number: null, invoice_seller_vat_id: null });
  status(incomplete, 422);
  assert.ok(incomplete.body.details.invoice_seller_tax_number);
  await freshReauth();
  status(await admin.change('post', '/admin/commerce/settings', { ...fields, sales_enabled: false,
    invoice_seller_tax_number: '27/815/08155' }), 200);
  await db.commerceSettings.update({ where: { id: 1 }, data: { sales_enabled: true } });
  const stored = await db.commerceSettings.findUniqueOrThrow({ where: { id: 1 } });
  assert.equal(stored.invoice_seller_tax_number, '27/815/08155');
  const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'commerce.settings_updated' },
    orderBy: { created_at: 'desc' } });
  assert.equal(audit.after_safe.tax_identity, 'tax_number');
});

test('an issued invoice keeps number, service period, tax identity and its fingerprint', async () => {
  const order = await paidOrder();
  const invoice = order.invoice;
  assert.ok(invoice.invoice_number.startsWith('TB-RE-'));
  // Der Leistungszeitpunkt ist gesetzt und nicht erfunden: der Kurs hat 365 Tage
  // Laufzeit, also ist die Leistung ein Zeitraum.
  assert.ok(invoice.service_date instanceof Date);
  assert.ok(invoice.service_end_date instanceof Date);
  assert.ok(invoice.service_end_date > invoice.service_date);
  assert.equal(invoice.content_hash.length, 32);
  assert.equal(invoice.previous_hash, null, 'the first sealed document has no predecessor');
  // Steuernummer und USt-IdNr. sind im Snapshot eingefroren.
  assert.equal(invoice.seller_snapshot.tax_number, '27/815/08155');

  // Die Prüfsumme ist nachrechenbar — sonst wäre sie wertlos.
  const recomputed = documentHash({ kind: 'invoice', number: invoice.invoice_number,
    issued_at: invoice.issued_at, service_date: invoice.service_date,
    service_end_date: invoice.service_end_date, seller_snapshot: invoice.seller_snapshot,
    buyer_snapshot: invoice.buyer_snapshot, lines_snapshot: invoice.lines_snapshot,
    total_gross_cents: invoice.total_gross_cents, currency: invoice.currency,
    due_at: invoice.due_at, payment_reference: invoice.payment_reference }, invoice.previous_hash);
  assert.deepEqual(Buffer.from(recomputed), Buffer.from(invoice.content_hash));

  // Der Beleg trägt Steuernummer, Leistungszeitraum und Prüfsumme.
  const pdf = await admin.get(`/admin/invoices/${invoice.id}/pdf`); status(pdf, 200);
  // Klammern sind im PDF-Stream maskiert; deshalb wird auf die Wörter geprüft,
  // nicht auf eine dekorierte Klammerfolge.
  const text = pdf.text ?? pdf.body.toString('latin1');
  assert.ok(text.includes('Steuernummer: 27/815/08155'));
  assert.ok(text.includes('Leistungszeitraum'));
  assert.ok(text.includes('Prüfsumme') && text.includes('SHA-256'));
});

test('an issued document cannot be changed or deleted — not even by a direct SQL statement', async () => {
  const invoice = await db.invoice.findFirstOrThrow({ orderBy: { issued_at: 'desc' } });
  const total = invoice.total_gross_cents;
  for (const statement of [
    `UPDATE invoices SET total_gross_cents = total_gross_cents + 1 WHERE id = '${invoice.id}'::uuid`,
    `UPDATE invoices SET buyer_snapshot = '{"company":"Andere Firma"}'::jsonb WHERE id = '${invoice.id}'::uuid`,
    `UPDATE invoices SET invoice_number = 'TB-RE-2026-999999' WHERE id = '${invoice.id}'::uuid`,
    `UPDATE invoices SET content_hash = sha256('x'::bytea) WHERE id = '${invoice.id}'::uuid`,
    `DELETE FROM invoices WHERE id = '${invoice.id}'::uuid`,
  ]) {
    await assert.rejects(db.$executeRawUnsafe(statement), /IMMUTABLE/, statement);
  }
  const after = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  assert.equal(after.total_gross_cents, total);
  assert.equal(after.buyer_snapshot.company, invoice.buyer_snapshot.company);
  // Ein versiegelter Beleg lässt sich auch nicht "neu" versiegeln.
  await assert.rejects(db.$executeRawUnsafe(
    `UPDATE invoices SET content_hash = NULL, previous_hash = NULL WHERE id = '${invoice.id}'::uuid`), /IMMUTABLE/);
});

test('the archive is a chain: the next document names its predecessor', async () => {
  const before = await db.invoice.findFirstOrThrow({ orderBy: { invoice_number: 'desc' } });
  const order = await paidOrder();
  const next = order.invoice;
  assert.notEqual(next.invoice_number, before.invoice_number);
  assert.deepEqual(Buffer.from(next.previous_hash), Buffer.from(before.content_hash));

  const report = await admin.get('/admin/documents/verify'); status(report, 200);
  assert.equal(report.body.intact, true);
  assert.deepEqual(report.body.broken, []);
  assert.ok(report.body.checked >= 2);
  // Die Prüfung behauptet nicht mehr, als sie kann.
  assert.match(report.body.note, /keine Signatur/);
});

test('changing a document behind the application breaks its fingerprint, and the check notices', async () => {
  // Der Trigger verhindert das Ändern. Für den Beweis, dass die Prüfsumme eine
  // Änderung *anzeigt*, wird er für einen Moment ausgesetzt — genau so, wie ein
  // Eingriff an der Datenbank es täte.
  const invoice = await db.invoice.findFirstOrThrow({ orderBy: { invoice_number: 'asc' } });
  await db.$executeRawUnsafe('ALTER TABLE invoices DISABLE TRIGGER invoices_immutable');
  try {
    await db.$executeRawUnsafe(
      `UPDATE invoices SET buyer_snapshot = jsonb_set(buyer_snapshot, '{city}', '"Manipuliert"') WHERE id = '${invoice.id}'::uuid`);
  } finally {
    await db.$executeRawUnsafe('ALTER TABLE invoices ENABLE TRIGGER invoices_immutable');
  }
  try {
    const report = await admin.get('/admin/documents/verify'); status(report, 200);
    assert.equal(report.body.intact, false);
    assert.ok(report.body.broken.some(entry => entry.number === invoice.invoice_number
      && entry.reason === 'hash_mismatch'));
  } finally {
    await db.$executeRawUnsafe('ALTER TABLE invoices DISABLE TRIGGER invoices_immutable');
    await db.$executeRawUnsafe(
      `UPDATE invoices SET buyer_snapshot = jsonb_set(buyer_snapshot, '{city}', '"Aachen"') WHERE id = '${invoice.id}'::uuid`);
    await db.$executeRawUnsafe('ALTER TABLE invoices ENABLE TRIGGER invoices_immutable');
  }
  const restored = await admin.get('/admin/documents/verify'); status(restored, 200);
  assert.equal(restored.body.intact, true);
});

test('invoice numbers run per calendar year, never across a year boundary', async () => {
  const year = Number((await db.invoice.findFirstOrThrow({ orderBy: { invoice_number: 'desc' } }))
    .invoice_number.split('-')[2]);
  // Ein Jahr, in dem noch nichts ausgestellt wurde: der Zähler muss dort bei 1
  // beginnen, egal wie viele Belege es in anderen Jahren gibt.
  const [{ year: fresh }] = await db.$queryRaw`SELECT GREATEST(COALESCE(MAX(year), 0), 2100) + 1 AS year
    FROM document_number_counters`;
  const inYear = await db.$queryRaw`SELECT trainerb_next_document_number('TB-RE-', 'invoice',
    (${`${year}-06-01T10:00:00Z`})::timestamptz) AS number`;
  const nextYear = await db.$queryRaw`SELECT trainerb_next_document_number('TB-RE-', 'invoice',
    (${`${fresh}-01-01T10:00:00Z`})::timestamptz) AS number`;
  assert.match(inYear[0].number, new RegExp(`^TB-RE-${year}-\\d{6}$`));
  assert.match(nextYear[0].number, new RegExp(`^TB-RE-${fresh}-000001$`),
    'a new year starts at 1 in its own counter');
  // Zweimal im selben Jahr: fortlaufend, nicht zufällig.
  const again = await db.$queryRaw`SELECT trainerb_next_document_number('TB-RE-', 'invoice',
    (${`${year}-06-02T10:00:00Z`})::timestamptz) AS number`;
  assert.equal(Number(again[0].number.split('-')[3]), Number(inYear[0].number.split('-')[3]) + 1);
  // Die Gutschrift hat ihren eigenen Zähler und kollidiert nicht mit Rechnungen.
  const credit = await db.$queryRaw`SELECT trainerb_next_document_number('TB-GS-', 'credit_note',
    (${`${year}-06-02T10:00:00Z`})::timestamptz) AS number`;
  assert.match(credit[0].number, new RegExp(`^TB-GS-${year}-\\d{6}$`));
});

test('the bookkeeping export lists every mandatory field and matches the documents', async () => {
  const list = await admin.get('/admin/documents?from=2020-01-01&to=2099-12-31'); status(list, 200);
  assert.ok(list.body.counts.invoices >= 2);
  for (const row of list.body.rows) {
    assert.ok(row.number); assert.ok(row.issued_at); assert.ok(row.service_date);
    assert.ok(row.content_hash, 'every row names its fingerprint');
    assert.equal(row.currency, 'EUR');
  }
  // Summen stimmen mit den Belegen überein, nicht mit einer zweiten Rechnung.
  const invoices = await db.invoice.findMany();
  const gross = invoices.reduce((sum, invoice) => sum + invoice.total_gross_cents, 0n);
  assert.equal(list.body.totals.gross_cents, gross.toString());
  assert.match(list.body.retention_note, /zehn Jahren/);
  assert.match(list.body.note, /kein Hauptbuch/);

  // Ein verdrehter Zeitraum wird abgelehnt statt stillschweigend leer geliefert.
  status(await admin.get('/admin/documents?from=2026-12-31&to=2026-01-01'), 422);
  // Ein einzelner Tag ist ein gültiger Zeitraum und enthält Belege dieses Tages.
  const today = new Date().toISOString().slice(0, 10);
  const single = await admin.get(`/admin/documents?from=${today}&to=${today}`); status(single, 200);
  assert.ok(single.body.counts.invoices >= 1, 'the day of issue is included');
  status(await admin.get('/admin/documents?from=31.12.2026'), 422);

  // Der CSV-Export ist eine Datei, kein HTML, und trägt die Prüfsummen.
  const csv = await admin.get('/admin/documents.csv?from=2020-01-01&to=2099-12-31'); status(csv, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.headers['content-disposition'], /attachment; filename="Belege-2020-01-01-bis-2099-12-31\.csv"/);
  const text = csv.text ?? csv.body.toString('utf8');
  assert.ok(text.startsWith('\ufeff'));
  assert.match(text, /Belegart;Belegnummer;Rechnungsdatum;Leistungsdatum;Leistungsende/);
  assert.match(text, /Rechnung;TB-RE-\d{4}-\d{6};\d{4}-\d{2}-\d{2};\d{4}-\d{2}-\d{2};\d{4}-\d{2}-\d{2}/);
  assert.match(text, /Prüfsumme \(SHA-256\)/);
});

test('the bundle is one valid PDF containing the cover and every document page', async () => {
  const bundle = await admin.get('/admin/documents.pdf?from=2020-01-01&to=2099-12-31'); status(bundle, 200);
  assert.match(bundle.headers['content-type'], /application\/pdf/);
  const pdf = bundle.body;
  assert.equal(pdf.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.match(pdf.toString('latin1'), /%%EOF\s*$/);
  const source = pdf.toString('latin1');
  assert.match(source, /Belegsammlung/);
  // Eine gültige Seitenliste: jede Seite zeigt auf die Sammel-Seitenliste.
  const kids = /\/Type \/Pages \/Count (\d+) \/Kids \[([^\]]+)\]/.exec(source);
  assert.ok(kids, 'the bundle has one page tree');
  const count = Number(kids[1]);
  const invoices = await db.invoice.count();
  assert.ok(count >= invoices + 1, 'cover page plus at least one page per invoice');
  // Das xref verweist auf echte Objekte: die Startadresse liegt im Dokument.
  const startxref = Number(/startxref\s+(\d+)/.exec(source)[1]);
  assert.ok(startxref > 0 && startxref < pdf.length);
  assert.match(source.slice(startxref, startxref + 4), /xref/);
});

test('a credit note carries the corrected service period and joins its own chain', async () => {
  const order = await paidOrder();
  await freshReauth();
  const refund = await admin.change('post', `/admin/orders/${order.id}/refunds`, { amount_cents: '11900',
    reason_code: 'goodwill', note: 'Vollständige Erstattung im Test', idempotency_key: `belege-${uuidv7()}` });
  status(refund, 201);
  const note = await db.creditNote.findFirstOrThrow({ where: { order_id: order.id } });
  assert.equal(note.service_date.toISOString().slice(0, 10),
    order.invoice.service_date.toISOString().slice(0, 10));
  assert.equal(note.content_hash.length, 32);
  assert.ok(note.previous_hash === null || note.previous_hash.length === 32);
  const list = await admin.get('/admin/documents?from=2020-01-01&to=2099-12-31'); status(list, 200);
  const row = list.body.rows.find(entry => entry.number === note.document_number);
  assert.equal(row.kind, 'Gutschrift');
  assert.equal(row.original_number, order.invoice.invoice_number);
  assert.equal(row.service_date, order.invoice.service_date.toISOString().slice(0, 10));
  const verify = await admin.get('/admin/documents/verify'); status(verify, 200);
  assert.equal(verify.body.intact, true);
});

test('the court-proof export refuses everyone without the global report permission', async () => {
  status(await new Browser().get('/admin/documents'), 401);
  status(await buyer.get('/admin/documents'), 403);
  status(await buyer.get('/admin/documents.csv'), 403);
  status(await buyer.get('/admin/documents.pdf'), 403);
  status(await buyer.get('/admin/documents/verify'), 403);
});

test('existing documents from before the fingerprint can be sealed exactly once', async () => {
  const invoice = await db.invoice.findFirstOrThrow({ orderBy: { invoice_number: 'asc' } });
  // Zustand "vor der Einführung": keine Prüfsumme. Der Trigger erlaubt genau
  // diesen einen Übergang, und nur ihn.
  await db.$executeRawUnsafe('ALTER TABLE invoices DISABLE TRIGGER invoices_immutable');
  try {
    await db.$executeRawUnsafe(`UPDATE invoices SET content_hash = NULL, previous_hash = NULL
      WHERE id = '${invoice.id}'::uuid`);
  } finally {
    await db.$executeRawUnsafe('ALTER TABLE invoices ENABLE TRIGGER invoices_immutable');
  }
  await assert.rejects(db.$executeRawUnsafe(
    `UPDATE invoices SET issued_at = issued_at WHERE id = '${invoice.id}'::uuid`), /IMMUTABLE/);
  // Erlaubt: von NULL auf einen Wert, ohne sonst etwas zu ändern.
  await db.$executeRawUnsafe(`UPDATE invoices SET content_hash = sha256('resiegelt'::bytea),
    previous_hash = NULL WHERE id = '${invoice.id}'::uuid`);
  const sealed = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  assert.equal(sealed.content_hash.length, 32);
});

test('the retention period is calculated, not asserted, and the check leaves a trace', async () => {
  const { documentRetentionReport, retentionCheck, retentionWindow } =
    require('../../apps/api/dist/document-retention');
  const list = await admin.get('/admin/documents?from=2020-01-01&to=2099-12-31'); status(list, 200);
  // Die Zusammenfassung im Export nennt einen echten Tag, keinen festen Satz.
  const releases = list.body.rows.map(row => retentionWindow(row.issued_at).releaseDay).sort();
  assert.equal(list.body.retention.latest_release, releases.at(-1));
  assert.equal(list.body.retention.earliest_release, releases[0]);
  assert.match(list.body.retention_note, /\d{4}-\d{2}-\d{2}/);
  assert.match(list.body.retention_note, /Trigger/);

  const report = await db.$transaction(tx => documentRetentionReport(tx));
  assert.equal(report.documents.total, await db.invoice.count() + await db.creditNote.count());
  assert.equal(report.rule.years, 10);
  assert.equal(report.expired.length, 0, 'ein Beleg aus diesem Jahr ist nicht entbehrlich');
  assert.equal(report.retained, report.documents.total);
  assert.ok(report.newest && report.newest.retention_until.endsWith('-12-31'));
  // Der Bericht ändert nichts.
  const before = await db.invoice.count();

  // Ein Prüflauf schreibt sich ins Audit — das ist der Nachweis.
  const auditBefore = await db.auditEvent.count({ where: { action: 'documents.retention_checked' } });
  const recorded = await retentionCheck(db);
  assert.equal(recorded.documents.total, report.documents.total);
  assert.equal(await db.invoice.count(), before);
  assert.equal(await db.auditEvent.count({ where: { action: 'documents.retention_checked' } }), auditBefore + 1);

  // Eine Frist, die abgelaufen ist, wird nicht stillschweigend hingenommen:
  // ohne ausdrückliche Freigabe bricht der Lauf ab und protokolliert den Befund.
  const future = new Date('2045-06-01T10:00:00Z');
  const expiredReport = await db.$transaction(tx => documentRetentionReport(tx, { asOf: future }));
  assert.ok(expiredReport.expired.length >= 1);
  assert.equal(expiredReport.retained, 0);
  const expiredBefore = await db.auditEvent.count({ where: { action: 'documents.retention_expired' } });
  await assert.rejects(retentionCheck(db, { asOf: future }), /RETENTION_EXPIRED/);
  assert.equal(await db.auditEvent.count({ where: { action: 'documents.retention_expired' } }), expiredBefore + 1);
  // Und selbst mit Freigabe wird nichts gelöscht — der Trigger bleibt stärker.
  await retentionCheck(db, { asOf: future, release: true });
  assert.equal(await db.invoice.count(), before);
  await assert.rejects(db.$executeRaw`DELETE FROM invoices WHERE id = ${(await db.invoice.findFirstOrThrow()).id}::uuid`,
    /INVOICES_IMMUTABLE/);
});
