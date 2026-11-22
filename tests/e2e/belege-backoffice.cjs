const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const request = require('supertest');
const Redis = require('ioredis');
const OTPAuth = require('otpauth');
const { createApplication } = require('../../apps/api/dist/application');
const { Database } = require('../../apps/api/dist/database');
const { seedCatalog } = require('../../apps/api/dist/cli/catalog');
const { seedCommerce } = require('../../apps/api/dist/cli/commerce');
const { unseal } = require('../../apps/api/dist/security');

/**
 * Browser-Abnahme der Belegausgabe im Backoffice.
 *
 * Der Test prüft nicht die API (das tun die Integrationstests), sondern die
 * Strecke, die ein Mensch tatsächlich geht: anmelden, Kennzahlen öffnen, den
 * Zeitraum setzen, die Liste lesen, die Kettenprüfung sehen und die beiden
 * Downloads wirklich erhalten. Er läuft gegen den Produktionsbuild von
 * `apps/web` und eine echte API mit isolierter Datenbank.
 */
const origin = 'https://academy.test';
const password = 'Kranich!Sonne2026';
const iso = date => date.toISOString().slice(0, 16) + 'Z';
let app, db, server, redis, apiOrigin, web, webServer, webOrigin, browser, recoveryCode;
const listen = srv => new Promise((resolve, reject) => {
  srv.once('error', reject); srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${srv.address().port}`));
});

/**
 * Cookie-Handhabung wie in den Integrationstests: `__Host-`-Cookies werden über
 * HTTP von einem supertest-Agenten nicht zuverlässig weitergegeben.
 */
class Api {
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
  async get(route) {
    const r = request(server).get(`/api/v1${route}`);
    if (this.cookies.size) r.set('Cookie', this.cookie());
    return this.collect(await r);
  }
  async change(method, route, body) {
    const token = await this.get('/auth/csrf');
    const r = request(server)[method](`/api/v1${route}`).set('Origin', origin)
      .set('X-CSRF-Token', token.body.csrf_token);
    if (this.cookies.size) r.set('Cookie', this.cookie());
    if (body !== undefined) r.send(body);
    return this.collect(await r);
  }
}

before(async () => {
  assert.equal(process.env.TRAINERB_DESTRUCTIVE_TEST_DATABASE, 'confirmed');
  app = await createApplication(); await app.listen(0, '127.0.0.1'); server = app.getHttpServer(); db = app.get(Database);
  apiOrigin = await new Promise(resolve => { const address = server.address(); resolve(`http://127.0.0.1:${address.port}`); });
  await db.$executeRawUnsafe('TRUNCATE TABLE courses, users, roles, permissions, email_templates, email_template_versions, email_outbox, automation_jobs, automation_job_attempts RESTART IDENTITY CASCADE');
  await seedCatalog(db); await seedCommerce(db);
  redis = new Redis(process.env.REDIS_URL);

  execFileSync(process.execPath, ['apps/api/dist/cli/bootstrap.js'], { env: { ...process.env,
    BOOTSTRAP_ADMIN_EMAIL: 'beleg-browser@example.invalid', BOOTSTRAP_ADMIN_FIRST_NAME: 'Beleg',
    BOOTSTRAP_ADMIN_LAST_NAME: 'Admin' }, stdio: 'pipe' });
  const adminUser = await db.user.findUniqueOrThrow({ where: { email_canonical: 'beleg-browser@example.invalid' } });
  const mail = await db.emailOutbox.findFirstOrThrow({ where: { user_id: adminUser.id,
    template_version: { template: { key: 'activation' } } } });
  const { token } = unseal(mail.variables_secret_ciphertext, `outbox:${mail.id}`, mail.secret_key_id);
  const activated = await new Api().change('post', '/auth/activate', { token, password });
  assert.equal(activated.status, 204, JSON.stringify(activated.body));

  const administer = new Api();
  const login = await administer.change('post', '/auth/login', { email: adminUser.email_canonical, password });
  assert.equal(login.status, 202, JSON.stringify(login.body));
  assert.equal(login.body.status, 'mfa_enrollment_required');
  const setup = await administer.change('post', '/auth/mfa/enrollment/start', {});
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30,
    secret: OTPAuth.Secret.fromBase32(setup.body.secret) });
  const confirmed = await administer.change('post', '/auth/mfa/enrollment/confirm', { code: totp.generate() });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  // Ein Wiederherstellungscode statt eines zweiten TOTP-Schritts: der erste
  // Schritt ist beim Bestätigen verbraucht, und ein Code gilt nur einmal.
  recoveryCode = confirmed.body.recovery_codes[0];

  await db.commerceSettings.update({ where: { id: 1 }, data: { sales_enabled: true } });
  const course = await administer.change('post', '/admin/courses', { slug: 'beleg-browser-kurs',
    title: 'Kurs für die Belegansicht', visibility: 'public' });
  assert.equal(course.status, 201, JSON.stringify(course.body));
  const version = await db.courseVersion.findFirstOrThrow({ where: { course_id: course.body.id, state: 'draft' } });
  await db.courseVersion.update({ where: { id: version.id }, data: { state: 'published',
    published_at: new Date(), published_by: adminUser.id } });
  await db.course.update({ where: { id: course.body.id }, data: { status: 'published' } });

  // Ein Beleg direkt über die Anwendungslogik, mit denselben Regeln wie im Verkauf.
  // `users_activation_check` verlangt für `active` Passwort-Hash und bestätigte
  // Adresse; der Käufer wird hier nur als Beleg-Empfänger gebraucht.
  const buyer = await db.user.create({ data: { id: require('uuidv7').uuidv7(), email_original: 'beleg-browser-kunde@example.invalid',
    email_canonical: 'beleg-browser-kunde@example.invalid', first_name: 'Beleg', last_name: 'Kunde',
    locale: 'de-DE', status: 'active', password_hash: 'synthetic-not-a-login', email_verified_at: new Date() } });
  // Erst als Entwurf mit Kursverknüpfung, dann aktivieren: der Trigger
  // `products_activation_guard` verlangt einen veröffentlichten Kurs.
  const product = await db.product.create({ data: { id: require('uuidv7').uuidv7(), sku: 'BELEG-BROWSER',
    type: 'single', status: 'draft', title: 'Produkt für Belege', description: 'Für die Ansicht',
    revision: 1, created_by: adminUser.id } });
  await db.productCourse.create({ data: { product_id: product.id, course_id: course.body.id, position: 1 } });
  await db.product.update({ where: { id: product.id }, data: { status: 'active',
    activated_at: new Date(), activated_by: adminUser.id } });
  const price = await db.price.create({ data: { id: require('uuidv7').uuidv7(), product_id: product.id,
    currency: 'EUR', gross_cents: 11900n, tax_category: 'standard', status: 'active',
    // Minutenpräzision ist eine Datenbankregel; Sekunden wären ein Verstoß.
    valid_from: new Date(Math.floor((Date.now() - 60_000) / 60_000) * 60_000),
    created_by: adminUser.id, revision: 1 } });
  const cart = await db.cart.create({ data: { id: require('uuidv7').uuidv7(), user_id: buyer.id,
    expires_at: new Date(Date.now() + 3_600_000) } });
  await db.cartItem.create({ data: { cart_id: cart.id, product_id: product.id, price_id: price.id,
    added_at: new Date() } });
  const order = await db.order.create({ data: { id: require('uuidv7').uuidv7(),
    order_number: `TB-${new Date().getFullYear()}-900001`, cart_id: cart.id,
    checkout_idempotency_key: `browser-${Date.now()}`, user_id: buyer.id, currency: 'EUR',
    buyer_email_original: buyer.email_original, buyer_email_canonical: buyer.email_canonical,
    payment_method: 'invoice', payment_state: 'paid', fulfillment_state: 'waiting',
    subtotal_gross_cents: 11900n, discount_cents: 0n, total_gross_cents: 11900n,
    billing_snapshot: { company: 'Belegfirma GmbH', first_name: 'Beleg', last_name: 'Kunde',
      street: 'Belegweg 1', street_extra: null, postal_code: '52062', city: 'Aachen', region: null,
      country: 'DE', vat_id: null },
    // Kauf auf Rechnung braucht ein Zahlungsziel (`orders_invoice_term`).
    placed_at: new Date(), paid_at: new Date(), due_at: new Date(Date.now() + 14 * 86_400_000),
    payment_reference: 'TB-TB-BROWSER', created_by: buyer.id } });
  const settings = await db.commerceSettings.findUniqueOrThrow({ where: { id: 1 } });
  await db.commerceSettings.update({ where: { id: 1 }, data: { invoice_seller_tax_number: '27/815/08155' } });
  const { Invoices } = require('../../apps/api/dist/invoices');
  const invoices = app.get(Invoices);
  await db.$transaction(async tx => {
    await tx.orderItem.create({ data: { order_id: order.id, product_id: product.id, price_id: price.id,
      position: 1, title_snapshot: product.title, variant_snapshot: null,
      unit_gross_cents: 11900n, discount_cents: 0n, total_gross_cents: 11900n,
      tax_rate_bp: 1900, net_cents: 10000n, tax_cents: 1900n, tax_label: '19 %' } });
    await invoices.issue(tx, order.id, { ...settings, invoice_seller_tax_number: '27/815/08155' }, buyer.email_original);
  });

  // Die Web-App gegen die echte API; der Browser sieht nur die Web-Origin.
  // Der Rewrite aus `next.config.ts` steht erst im Build und zeigt auf den dort
  // konfigurierten Port; deshalb proxyt der Testserver `/api/v1` selbst.
  process.env.API_INTERNAL_ORIGIN = apiOrigin;
  process.env.PUBLIC_BASE_URL = 'https://akademie.example.invalid';
  web = require('next')({ dev: false, dir: path.resolve('apps/web') });
  await web.prepare();
  const handle = web.getRequestHandler();
  webServer = http.createServer((req, res) => {
    if (!req.url.startsWith('/api/v1')) return handle(req, res);
    const upstream = new URL(req.url, apiOrigin);
    const proxied = http.request({ host: upstream.hostname, port: upstream.port, path: upstream.pathname + upstream.search,
      method: req.method, headers: { ...req.headers, host: upstream.host } }, answer => {
      res.writeHead(answer.statusCode, answer.headers); answer.pipe(res);
    });
    proxied.on('error', error => res.writeHead(502, { 'content-type': 'text/plain' }).end(String(error)));
    req.pipe(proxied);
  });
  webOrigin = await listen(webServer);
  // Wie in den übrigen Browserläufen: das gepackte Chromium der CI braucht
  // Sandbox- und shm-Schalter; `--single-process` nur, wo es ausdrücklich gesetzt ist.
  browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM_PATH || undefined,
    args: process.env.E2E_CHROMIUM_PATH
      ? ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        ...(process.env.E2E_SINGLE_PROCESS === 'yes' ? ['--single-process', '--no-zygote'] : [])]
      : [] });
});
after(async () => {
  if (browser) await browser.close();
  if (webServer) { webServer.closeAllConnections(); webServer.close(); }
  if (web) await web.close();
  if (redis) redis.disconnect();
  if (app) await app.close();
});

test('the bookkeeping export is usable in the browser: list, chain check and both downloads',
  { timeout: 180_000 }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    const netFailures = [];
    page.on('response', response => { if (response.url().includes('/api/v1/') && response.status() >= 400)
      netFailures.push(`${response.status()} ${response.url()}`); });
    // Same-origin: der Browser spricht nur mit der Web-Origin, die Web-App proxyt zur API.
    const api = origin;
    const csrf = async () => {
      const response = await page.request.get(`${webOrigin}/api/v1/auth/csrf`, { headers: { Origin: api } });
      const body = await response.text();
      if (response.status() !== 200) throw new Error(`csrf ${response.status()}: ${body.slice(0, 500)}`);
      return JSON.parse(body).csrf_token;
    };
    const login = await page.request.post(`${webOrigin}/api/v1/auth/login`, { headers: { Origin: api,
      'X-CSRF-Token': await csrf() }, data: { email: 'beleg-browser@example.invalid', password } });
    const loginBody = await login.text();
    assert.equal(login.status(), 202, loginBody);
    assert.equal(JSON.parse(loginBody).status, 'mfa_required');
    // Das Backoffice verlangt den zweiten Faktor wirklich: der Browser löst ihn
    // mit einem Wiederherstellungscode ein, nicht mit einem Eingriff in die Sitzung.
    const challenge = await page.request.post(`${webOrigin}/api/v1/auth/mfa/challenge`, { headers: { Origin: api,
      'X-CSRF-Token': await csrf() }, data: { recovery_code: recoveryCode } });
    assert.equal(challenge.status(), 200, await challenge.text());

    await page.goto(`${webOrigin}/admin/kennzahlen`, { waitUntil: 'networkidle' });
    const heading = page.getByRole('heading', { name: 'Belege für die Buchhaltung' });
    try { await heading.waitFor({ timeout: 30_000 }); }
    catch (error) { console.error('URL:', page.url(), 'NET:', netFailures, 'ERRORS:', errors); throw error; }
    try { await page.getByRole('status').filter({ hasText: 'Kettenprüfung' }).waitFor({ timeout: 30_000 }); }
    catch (error) { console.error('NET:', netFailures, 'ERRORS:', errors); throw error; }

    const table = page.locator('table', { has: page.getByRole('columnheader', { name: 'Prüfsumme' }) });
    await table.waitFor({ timeout: 30_000 });
    // Die Tabelle setzt Überschriften in Versalien (CSS); der Text ist es nicht.
    assert.match(await table.innerText(), /Rechnung TB-RE-\d{4}-\d{6}/i);
    assert.match(await page.locator('section', { has: heading }).innerText(), /Kettenprüfung: \d+ Belege geprüft/);
    const section = await page.locator('section', { has: heading }).innerText();
    assert.match(section, /Prüfsummen und Verkettung stimmen|Abweichung gefunden/);
    // Die Aufbewahrungsfrist steht mit echtem Datum im Backoffice, nicht als Satz.
    assert.match(section, /Aufbewahrung: bis \d{2}\.\d{2}\.\d{4} aufzubewahren/);
    assert.match(section, /entbehrlich/);

    const csv = await page.request.get(`${webOrigin}/api/v1/admin/documents.csv?from=2020-01-01&to=2099-12-31`);
    assert.equal(csv.status(), 200);
    assert.match(csv.headers()['content-type'], /text\/csv/);
    const text = await csv.text();
    assert.match(text, /Belegart;Belegnummer/);
    assert.match(text, /Rechnung;TB-RE-\d{4}-\d{6}/);

    const pdf = await page.request.get(`${webOrigin}/api/v1/admin/documents.pdf?from=2020-01-01&to=2099-12-31`);
    assert.equal(pdf.status(), 200);
    assert.match(pdf.headers()['content-type'], /application\/pdf/);
    assert.equal((await pdf.body()).subarray(0, 8).toString('latin1'), '%PDF-1.4');

    assert.deepEqual(errors, []);
    await context.close();
  });
