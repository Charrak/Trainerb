const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { chromium } = require('playwright');
const OTPAuth = require('otpauth');

const enabled = process.env.E2E_CATALOG_SMOKE === 'yes';
let baseUrl;
if (enabled) {
  require('dotenv').config({ quiet: true });
  if (process.env.E2E_ALLOW_TEST_DATA !== 'yes' || !process.env.E2E_BASE_URL || !process.env.E2E_CATALOG_DATABASE_URL) {
    throw new Error('Use an isolated environment and set E2E_ALLOW_TEST_DATA=yes, E2E_BASE_URL and E2E_CATALOG_DATABASE_URL.');
  }
  if (process.env.APP_ENV === 'production' || process.env.NODE_ENV === 'production') throw new Error('Never run this test in production.');
  baseUrl = new URL(process.env.E2E_BASE_URL);
  const databaseUrl = new URL(process.env.E2E_CATALOG_DATABASE_URL);
  const local = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);
  if (!['http:', 'https:'].includes(baseUrl.protocol) || !local(baseUrl.hostname) || baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash || baseUrl.username || baseUrl.password ||
      !['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || !local(databaseUrl.hostname) || !/_e2e_test$/.test(decodeURIComponent(databaseUrl.pathname.slice(1)))) {
    throw new Error('Use a local web origin and a separate local database named *_e2e_test.');
  }
  process.env.DATABASE_URL = databaseUrl.toString();
  process.env.PUBLIC_BASE_URL = baseUrl.origin;
  process.env.APP_ENV = 'development';
  process.env.ALLOW_INSECURE_LOCAL_HTTP = 'true';
  process.env.TRAINERB_EMBEDDED_PREVIEW_COOKIES = 'false';
}

async function activate(page, db, email, password) {
  const { unseal } = require('../../apps/api/dist/security');
  const user = await db.user.findUniqueOrThrow({ where: { email_canonical: email } });
  const mail = await db.emailOutbox.findFirstOrThrow({ where: { user_id: user.id, template_version: { template: { key: 'activation' } } } });
  const { token } = unseal(mail.variables_secret_ciphertext, `outbox:${mail.id}`, mail.secret_key_id);
  await page.goto(new URL(`/konto/aktivieren#token=${token}`, baseUrl).href);
  await page.locator('#new-password').fill(password); await page.locator('#repeat-password').fill(password);
  await page.getByRole('button', { name: 'Konto aktivieren' }).click();
  await page.getByText(/Dein Konto ist aktiviert/).waitFor();
  return user;
}
async function loginAndEnroll(page, email, password) {
  await page.goto(new URL('/anmelden', baseUrl).href);
  await page.locator('#email').fill(email); await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
  await page.waitForURL(/\/mfa\/einrichten$/);
  await page.getByRole('button', { name: 'Einrichtung starten' }).click();
  const secret = await page.locator('.secret-code').innerText();
  const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
  await page.locator('#mfa-code').fill(totp.generate());
  await page.getByRole('button', { name: 'Bestätigen', exact: true }).click();
  await page.getByRole('heading', { name: 'Gut aufbewahren.' }).waitFor();
  await page.getByRole('link', { name: 'Weiter zum Konto' }).click();
  await page.getByRole('heading', { name: /Hallo,/ }).waitFor();
}

test('browser: protected course drafts, typed chapter content, staff scope and an empty public catalog', { skip: !enabled, timeout: 180000 }, async () => {
  const { Database } = require('../../apps/api/dist/database');
  const { seedCatalog } = require('../../apps/api/dist/cli/catalog');
  const db = new Database(); await db.$connect();
  let adminBrowser, staffBrowser, mobileBrowser;
  try {
    assert.equal(await db.user.count(), 0, 'Use a fresh, empty *_e2e_test database.');
    assert.equal(await db.course.count(), 0, 'Use a fresh, empty *_e2e_test database.');
    assert.equal(await db.auditEvent.count({ where: { action: 'bootstrap.superadmin_created' } }), 0, 'Bootstrap must not have run.');
    await seedCatalog(db);
    const adminEmail = `e2e-admin-${randomUUID()}@example.invalid`;
    const staffEmail = `e2e-staff-${randomUUID()}@example.invalid`;
    const password = 'NurTest!Wolke2026';
    execFileSync(process.execPath, ['apps/api/dist/cli/bootstrap.js'], { env: { ...process.env,
      BOOTSTRAP_ADMIN_EMAIL: adminEmail, BOOTSTRAP_ADMIN_FIRST_NAME: 'Test', BOOTSTRAP_ADMIN_LAST_NAME: 'Admin' }, stdio: 'pipe' });
    const specialArgs = process.env.E2E_SINGLE_PROCESS === 'yes' ? ['--single-process', '--no-zygote', '--no-sandbox', '--disable-dev-shm-usage'] : [];
    const launch = () => chromium.launch({ headless: true, ...(process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}), args: specialArgs });
    // Some restricted single-process Chromium builds leak cookies between
    // contexts, so each identity gets a separate browser process.
    adminBrowser = await launch();
    const adminContext = await adminBrowser.newContext({ viewport: { width: 1200, height: 900 } });
    const admin = await adminContext.newPage(); admin.on('dialog', dialog => dialog.accept());
    const adminUser = await activate(admin, db, adminEmail, password);
    await loginAndEnroll(admin, adminEmail, password);
    // The enrollment consumed the current 30-second TOTP step; a release
    // confirmation needs a step that was not used yet.
    const enrollStep = Math.floor(Date.now() / 30_000);
    await admin.getByRole('link', { name: 'Kursverwaltung' }).click();
    await admin.getByRole('heading', { name: 'Kursentwürfe.' }).waitFor();
    await admin.getByRole('button', { name: 'Vorgaben für Fitnesstrainer B-Lizenz übernehmen' }).click();
    assert.equal(await admin.locator('#new-course-modules').inputValue(), '14');
    assert.equal(await admin.locator('#new-course-chapters').inputValue(), '42');
    assert.equal(await admin.locator('#new-course-exams').inputValue(), '2');
    await admin.locator('#new-course-visibility').selectOption('public');
    await admin.getByRole('button', { name: 'Entwurf anlegen' }).click();
    await admin.waitForURL(/\/admin\/kurse\/[0-9a-f-]+$/);
    const detailUrl = admin.url();
    await admin.getByText(/NICHT VERÖFFENTLICHT/).waitFor();
    await admin.locator('#course-description').fill('Synthetischer Testentwurf.');
    await admin.getByRole('button', { name: 'Kursangaben speichern' }).click();
    await admin.getByText('Kursangaben gespeichert.').waitFor();
    await admin.getByText('+ Modul hinzufügen', { exact: true }).click();
    await admin.locator('#new-module-title').fill('Synthetisches Modul');
    await admin.getByRole('button', { name: 'Modul anlegen' }).click();
    await admin.getByText('Modul angelegt.').waitFor();
    let module = admin.locator('.module-item').filter({ hasText: 'Synthetisches Modul' });
    await module.getByText('+ Kapitel hinzufügen', { exact: true }).click();
    await module.getByLabel('Kapiteltitel').fill('Synthetisches Kapitel');
    await module.getByLabel('Dauer in Minuten (optional)').fill('15');
    await module.getByRole('button', { name: 'Kapitel anlegen' }).click();
    await admin.getByText('Kapitel angelegt.').waitFor();
    await module.getByText('Synthetisches Kapitel', { exact: true }).waitFor();
    let chapter = module.locator('.chapter-item').filter({ hasText: 'Synthetisches Kapitel' });
    await chapter.locator('.chapter-content-panel > summary').click();
    await chapter.getByText('Noch keine Inhaltsbausteine angelegt.').waitFor();
    await chapter.getByText('+ Inhaltsbaustein hinzufügen', { exact: true }).click();
    const addForm = chapter.locator('.add-content form');
    const scriptText = 'Testtext <script>window.__trainerbXss=1</script>';
    await addForm.getByLabel('Text', { exact: true }).fill(scriptText);
    await addForm.getByRole('button', { name: 'Baustein anlegen' }).click();
    await chapter.locator('.content-preview-text').getByText(scriptText, { exact: true }).waitFor();
    assert.equal(await chapter.locator('.content-preview-text script').count(), 0);
    assert.equal(await admin.evaluate(() => window.__trainerbXss ?? null), null);
    await addForm.getByLabel('Art des Bausteins').selectOption('heading');
    await addForm.getByLabel('Überschrift', { exact: true }).fill('Lernziele im Test');
    await addForm.getByLabel('Gliederungsebene').selectOption('3');
    await addForm.getByRole('button', { name: 'Baustein anlegen' }).click();
    await chapter.locator('.content-preview-heading').getByText('Lernziele im Test', { exact: true }).waitFor();
    await addForm.getByLabel('Art des Bausteins').selectOption('list');
    await addForm.getByLabel('Einträge').fill('Erster Testpunkt\nZweiter Testpunkt');
    await addForm.getByRole('button', { name: 'Baustein anlegen' }).click();
    await chapter.locator('.content-preview-list').getByText('Erster Testpunkt', { exact: true }).waitFor();
    await addForm.getByLabel('Art des Bausteins').selectOption('link');
    await addForm.getByLabel('Linktext').fill('Beispiel-Link');
    await addForm.getByLabel('Linkziel').fill('javascript:alert(1)');
    await addForm.getByRole('button', { name: 'Baustein anlegen' }).click();
    await admin.getByText('Bitte prüfe den Inhaltsbaustein.', { exact: true }).waitFor();
    await addForm.getByLabel('Linkziel').fill('https://example.org/test');
    await addForm.getByRole('button', { name: 'Baustein anlegen' }).click();
    await chapter.locator('.content-preview-link').getByText('Beispiel-Link', { exact: false }).waitFor();
    assert.equal(await chapter.locator('.content-preview-link a').count(), 0, 'Draft links are shown as text, not executed.');
    await chapter.getByText('Kapitel bearbeiten', { exact: true }).click();
    assert.equal(await chapter.getByRole('button', { name: 'Kapitel löschen' }).isDisabled(), true);
    await admin.setViewportSize({ width: 375, height: 812 });
    assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Content editor must fit a mobile viewport.');
    await admin.setViewportSize({ width: 1200, height: 900 });

    staffBrowser = await launch();
    const staffContext = await staffBrowser.newContext({ viewport: { width: 1000, height: 800 } });
    const staff = await staffContext.newPage(); staff.on('dialog', dialog => dialog.accept());
    await staff.goto(new URL('/registrieren', baseUrl).href);
    await staff.locator('#first-name').fill('Test'); await staff.locator('#last-name').fill('Kursmanager');
    await staff.locator('#email').fill(staffEmail); await staff.getByRole('button', { name: 'Konto erstellen' }).click();
    await staff.getByText('Fast geschafft.').waitFor();
    const staffUser = await activate(staff, db, staffEmail, password);
    await admin.goto(new URL('/admin', baseUrl).href);
    const userRow = admin.getByRole('row').filter({ hasText: staffEmail });
    await userRow.getByRole('button', { name: 'Bearbeiten' }).click();
    await admin.getByRole('checkbox', { name: 'Kursmanager' }).check();
    await admin.getByRole('button', { name: 'Rollen speichern' }).click();
    await admin.getByText('Die Rollen wurden gespeichert. Betroffene Sitzungen wurden abgemeldet.').waitFor();
    await admin.goto(detailUrl);
    await admin.locator('#staff-user-select').locator('option').filter({ hasText: staffEmail }).waitFor({ state: 'attached' });
    await admin.locator('#staff-user-select').selectOption({ label: `Test Kursmanager · ${staffEmail}` });
    await admin.getByRole('button', { name: 'Person zuordnen' }).click();
    await admin.getByText('Kurszuordnung gespeichert.').waitFor();
    await admin.locator('.staff-row').filter({ hasText: staffEmail }).waitFor();
    module = admin.locator('.module-item').filter({ hasText: 'Synthetisches Modul' });
    chapter = module.locator('.chapter-item').filter({ hasText: 'Synthetisches Kapitel' });
    await chapter.locator('.chapter-content-panel > summary').click();
    await chapter.locator('.content-preview-text').getByText(scriptText, { exact: true }).waitFor();
    const staleBlock = chapter.locator('.content-block').filter({ hasText: scriptText });
    await staleBlock.getByText('Baustein bearbeiten', { exact: true }).click();
    await staleBlock.getByLabel('Text', { exact: true }).fill('Ungespeicherte Admin-Änderung');

    await loginAndEnroll(staff, staffEmail, password);
    const adminProfile = await admin.evaluate(() => fetch('/api/v1/me', { cache: 'no-store' }).then(response => response.json()));
    assert.equal(adminProfile.id, adminUser.id, 'Browser identities must stay isolated.');
    await staff.getByRole('link', { name: 'Kursverwaltung' }).click();
    await staff.getByRole('link', { name: /Fitnesstrainer B-Lizenz/ }).click();
    await staff.getByText('Synthetisches Kapitel', { exact: true }).waitFor();
    const staffModule = staff.locator('.module-item').filter({ hasText: 'Synthetisches Modul' });
    const staffChapter = staffModule.locator('.chapter-item').filter({ hasText: 'Synthetisches Kapitel' });
    await staffChapter.locator('.chapter-content-panel > summary').click();
    await staffChapter.locator('.content-preview-text').getByText(scriptText, { exact: true }).waitFor();
    const staffBlock = staffChapter.locator('.content-block').filter({ hasText: scriptText });
    await staffBlock.getByText('Baustein bearbeiten', { exact: true }).click();
    await staffBlock.getByLabel('Text', { exact: true }).fill('Vom Mitarbeiter überarbeitet');
    await staffBlock.getByRole('button', { name: 'Baustein speichern' }).click();
    await staffChapter.locator('.content-preview-text').getByText('Vom Mitarbeiter überarbeitet', { exact: true }).waitFor();
    const staleResponse = admin.waitForResponse(response => response.request().method() === 'PATCH' && response.url().includes('/chapter-contents/'));
    await staleBlock.getByRole('button', { name: 'Baustein speichern' }).click();
    assert.equal((await staleResponse).status(), 409);
    await admin.getByText(/Der Entwurf wurde zwischenzeitlich geändert/).waitFor();
    assert.equal(await staleBlock.getByLabel('Text', { exact: true }).inputValue(), 'Ungespeicherte Admin-Änderung');
    // Saving a different block must not discard an open, concurrently stale editor.
    const headingBlock = chapter.locator('.content-block').filter({ hasText: 'Lernziele im Test' });
    await headingBlock.getByText('Baustein bearbeiten', { exact: true }).click();
    await headingBlock.getByLabel('Überschrift', { exact: true }).fill('Lernziele aktualisiert');
    await headingBlock.getByRole('button', { name: 'Baustein speichern' }).click();
    await chapter.locator('.content-preview-heading').getByText('Lernziele aktualisiert', { exact: true }).waitFor();
    assert.equal(await staleBlock.getByLabel('Text', { exact: true }).inputValue(), 'Ungespeicherte Admin-Änderung');
    // A different staff member can add a block; explicit refresh also updates the count.
    await staffChapter.getByText('+ Inhaltsbaustein hinzufügen', { exact: true }).click();
    const staffAdd = staffChapter.locator('.add-content form');
    await staffAdd.getByLabel('Text', { exact: true }).fill('Vom Team hinzugefügt');
    await staffAdd.getByRole('button', { name: 'Baustein anlegen' }).click();
    await staffChapter.locator('.content-preview-text').getByText('Vom Team hinzugefügt', { exact: true }).waitFor();
    assert.equal(await chapter.locator('.chapter-content-panel > summary > span').innerText(), '4 Bausteine');
    const staleAgain = admin.waitForResponse(response => response.request().method() === 'PATCH' && response.url().includes('/chapter-contents/'));
    await staleBlock.getByRole('button', { name: 'Baustein speichern' }).click();
    assert.equal((await staleAgain).status(), 409);
    await admin.getByText(/Der Entwurf wurde zwischenzeitlich geändert/).waitFor();
    await chapter.getByRole('button', { name: 'Inhalte neu laden' }).click();
    await chapter.locator('.content-preview-text').getByText('Vom Mitarbeiter überarbeitet', { exact: true }).waitFor();
    assert.equal(await chapter.locator('.chapter-content-panel > summary > span').innerText(), '5 Bausteine');
    await admin.getByText(/Der Entwurf wurde zwischenzeitlich geändert/).waitFor({ state: 'hidden' });
    await staffModule.getByText('Modul bearbeiten', { exact: true }).click();
    await staffModule.getByLabel('Modultitel').fill('Überarbeitetes Modul');
    await staffModule.getByRole('button', { name: 'Modul speichern' }).click();
    await staff.getByText('Modul gespeichert.').waitFor();
    const updatedStaffChapter = staff.locator('.module-item').filter({ hasText: 'Überarbeitetes Modul' }).locator('.chapter-item');
    await updatedStaffChapter.locator('.content-preview-text').getByText('Vom Mitarbeiter überarbeitet', { exact: true }).waitFor();
    const removedResponse = admin.waitForResponse(response => response.request().method() === 'DELETE' && response.url().includes('/staff/'));
    await admin.locator('.staff-row').filter({ hasText: staffEmail }).getByRole('button', { name: 'Entfernen' }).click();
    const removal = await removedResponse;
    assert.equal(removal.status(), 204, removal.status() === 204 ? undefined : await removal.text());
    await admin.getByText('Kurszuordnung entfernt.', { exact: true }).waitFor();
    assert.equal(await db.courseStaff.count({ where: { user_id: staffUser.id } }), 0);
    const deniedRead = staff.waitForResponse(response => response.request().method() === 'GET' && response.url().includes('/contents'));
    await updatedStaffChapter.getByRole('button', { name: 'Inhalte neu laden' }).click();
    assert.equal((await deniedRead).status(), 404);
    await staff.getByText('Der Entwurf ist nicht verfügbar oder du hast keinen Zugriff.').waitFor();
    assert.equal(await staff.locator('.content-preview-text').count(), 0, 'Loaded draft content is cleared on access loss.');
    const staffProducts = await staff.evaluate(() => fetch('/api/v1/admin/products', { cache: 'no-store' }).then(response => response.status));
    assert.equal(staffProducts, 403, 'Course managers have no product access.');
    await staff.reload(); await staff.getByText('Der Entwurf ist nicht verfügbar oder du hast keinen Zugriff.').waitFor();

    module = admin.locator('.module-item').filter({ hasText: 'Überarbeitetes Modul' });
    chapter = module.locator('.chapter-item').filter({ hasText: 'Synthetisches Kapitel' });
    await chapter.getByText('Kapitel bearbeiten', { exact: true }).click();
    assert.equal(await chapter.getByRole('button', { name: 'Kapitel löschen' }).isDisabled(), true);
    await chapter.locator('.content-preview-text').getByText('Vom Mitarbeiter überarbeitet', { exact: true }).waitFor();
    for (const text of ['Vom Mitarbeiter überarbeitet', 'Lernziele aktualisiert', 'Erster Testpunkt', 'Beispiel-Link', 'Vom Team hinzugefügt']) {
      const item = chapter.locator('.content-block').filter({ hasText: text });
      await item.getByText('Baustein bearbeiten', { exact: true }).click();
      const response = admin.waitForResponse(result => result.request().method() === 'DELETE' && result.url().includes('/chapter-contents/'));
      await item.getByRole('button', { name: 'Baustein löschen' }).click();
      assert.equal((await response).status(), 204);
      await item.waitFor({ state: 'detached' });
    }
    assert.equal(await db.chapterContent.count(), 0);
    await chapter.getByRole('button', { name: 'Kapitel löschen' }).click();
    await admin.getByText('Kapitel gelöscht.').waitFor();
    await module.getByText('Modul bearbeiten', { exact: true }).click();
    await module.getByRole('button', { name: 'Modul löschen' }).click();
    await admin.getByText('Modul gelöscht.').waitFor();

    // Seed a longer synthetic list through the same authenticated API, then
    // exercise pagination and stale cursors in the actual browser UI.
    const version = await db.courseVersion.findFirstOrThrow();
    const paged = await admin.evaluate(async versionId => {
      const csrf = await fetch('/api/v1/auth/csrf', { cache: 'no-store' }).then(response => response.json());
      async function post(path, body) {
        const response = await fetch(`/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json',
          'X-CSRF-Token': csrf.csrf_token }, body: JSON.stringify(body), cache: 'no-store' });
        if (!response.ok) throw new Error(`Fixture POST failed: ${response.status}`);
        return response.json();
      }
      const module = await post(`/admin/course-versions/${versionId}/modules`, { title: 'Seitentest Modul', position: 1 });
      const chapter = await post(`/admin/course-modules/${module.id}/chapters`, { title: 'Seitentest Kapitel', position: 1 });
      for (let n = 1; n <= 22; n++) {
        await post(`/admin/course-chapters/${chapter.id}/contents`, { block: { kind: 'paragraph', text: `Seitentest ${String(n).padStart(2, '0')}` } });
      }
      return { chapterId: chapter.id };
    }, version.id);
    // A future/unknown format is an explicit test fixture and must stay read-only.
    const unknownId = randomUUID();
    await db.chapterContent.create({ data: { id: unknownId, course_version_id: version.id, chapter_id: paged.chapterId,
      kind: 'text', title: 'Format der Zukunft', position: 999,
      body: { schema_version: 1, blocks: [{ id: unknownId, kind: 'paragraph', text: 'Nicht anzeigen', future_field: 'keep' }] } } });
    await admin.reload();
    const pagedChapter = admin.locator('.chapter-item').filter({ hasText: 'Seitentest Kapitel' });
    await pagedChapter.locator('.chapter-content-panel > summary').click();
    await pagedChapter.locator('.content-preview-text').getByText('Seitentest 01', { exact: true }).waitFor();
    assert.equal(await pagedChapter.locator('.chapter-content-panel > summary > span').innerText(), '23 Bausteine');
    assert.equal(await pagedChapter.locator('.content-block').count(), 20);
    const unsaved = pagedChapter.locator('.content-block').filter({ hasText: 'Seitentest 01' });
    await unsaved.getByText('Baustein bearbeiten', { exact: true }).click();
    await unsaved.getByLabel('Text', { exact: true }).fill('Ungespeicherter Seitentest');
    await pagedChapter.getByRole('button', { name: 'Weitere Inhalte laden' }).click();
    await pagedChapter.locator('.content-preview-text').getByText('Seitentest 22', { exact: true }).waitFor();
    const unsupported = pagedChapter.locator('.content-block').filter({ hasText: 'Format der Zukunft' });
    await unsupported.getByText('Dieses Format wird hier nicht unterstützt und kann nicht verändert oder gelöscht werden.').waitFor();
    assert.equal(await unsupported.getByText('Baustein bearbeiten', { exact: true }).count(), 0);
    assert.equal(await unsaved.getByLabel('Text', { exact: true }).inputValue(), 'Ungespeicherter Seitentest');
    await pagedChapter.getByText('+ Inhaltsbaustein hinzufügen', { exact: true }).click();
    const pagedAdd = pagedChapter.locator('.add-content form');
    await pagedAdd.getByLabel('Text', { exact: true }).fill('Seitentest neu');
    await pagedAdd.getByRole('button', { name: 'Baustein anlegen' }).click();
    await pagedChapter.locator('.content-preview-text').getByText('Seitentest neu', { exact: true }).waitFor();
    assert.equal(await unsaved.getByLabel('Text', { exact: true }).inputValue(), 'Ungespeicherter Seitentest');
    await pagedChapter.getByRole('button', { name: 'Inhalte neu laden' }).click();
    await pagedChapter.locator('.content-preview-text').getByText('Seitentest neu', { exact: true }).waitFor({ state: 'detached' });
    const cursorItem = (await db.chapterContent.findMany({ where: { chapter_id: paged.chapterId }, orderBy: { position: 'asc' }, take: 20 }))[19];
    const externalDelete = await admin.evaluate(async ({ id, revision }) => {
      const csrf = await fetch('/api/v1/auth/csrf', { cache: 'no-store' }).then(response => response.json());
      return (await fetch(`/api/v1/admin/chapter-contents/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json',
        'X-CSRF-Token': csrf.csrf_token }, body: JSON.stringify({ revision }), cache: 'no-store' })).status;
    }, { id: cursorItem.id, revision: cursorItem.revision });
    assert.equal(externalDelete, 204);
    const cursorResponse = admin.waitForResponse(response => response.request().method() === 'GET' && response.url().includes('/contents?') && response.url().includes('cursor='));
    await pagedChapter.getByRole('button', { name: 'Weitere Inhalte laden' }).click();
    assert.equal((await cursorResponse).status(), 409);
    await pagedChapter.getByText('Die Inhaltsliste hat sich geändert. Bitte lade sie neu.').waitFor();
    assert.equal(await unsaved.getByLabel('Text', { exact: true }).inputValue(), 'Ungespeicherter Seitentest');
    await pagedChapter.getByRole('button', { name: 'Inhalte neu laden' }).click();
    await pagedChapter.locator('.content-preview-text').getByText('Seitentest 21', { exact: true }).waitFor();
    assert.equal(await pagedChapter.locator('.chapter-content-panel > summary > span').innerText(), '23 Bausteine');
    const moved = pagedChapter.locator('.content-block').filter({ hasText: 'Seitentest 02' });
    await moved.getByText('Baustein bearbeiten', { exact: true }).click();
    await moved.getByLabel('Position', { exact: true }).fill('2000');
    await moved.getByRole('button', { name: 'Baustein speichern' }).click();
    await pagedChapter.getByText('Die Reihenfolge wurde geändert. Lade die Inhalte neu, bevor du weiterblätterst.').waitFor();
    assert.equal(await unsaved.getByLabel('Text', { exact: true }).inputValue(), 'Ungespeicherter Seitentest');
    assert.equal(await pagedChapter.getByRole('button', { name: 'Weitere Inhalte laden' }).count(), 0);
    await pagedChapter.getByRole('button', { name: 'Inhalte neu laden' }).click();
    await pagedChapter.locator('.content-preview-text').getByText('Seitentest 22', { exact: true }).waitFor();
    await pagedChapter.getByRole('button', { name: 'Weitere Inhalte laden' }).click();
    await pagedChapter.locator('.content-preview-text').getByText('Seitentest 02', { exact: true }).waitFor();
    assert.equal(await pagedChapter.locator('.content-block').count(), 23);
    await moved.getByText('Baustein bearbeiten', { exact: true }).click();
    await moved.getByLabel('Position', { exact: true }).fill('1');
    const conflict = admin.waitForResponse(response => response.request().method() === 'PATCH' && response.url().includes('/chapter-contents/'));
    await moved.getByRole('button', { name: 'Baustein speichern' }).click();
    assert.equal((await conflict).status(), 409);
    await admin.getByText('Diese Kennung oder Position wird bereits verwendet.').waitFor();
    await admin.getByRole('button', { name: 'Entwurf neu laden' }).click();
    await pagedChapter.locator('.content-preview-text').getByText('Seitentest 01', { exact: true }).waitFor({ state: 'detached' });
    assert.equal(await pagedChapter.locator('.chapter-content-panel').evaluate(element => element.open), false);
    await pagedChapter.locator('.chapter-content-panel > summary').click();
    await pagedChapter.locator('.content-preview-text').getByText('Seitentest 01', { exact: true }).waitFor();
    await admin.getByText('Diese Kennung oder Position wird bereits verwendet.').waitFor({ state: 'hidden' });

    // Product and price drafts: private, admin-only, no activation or checkout.
    await admin.goto(new URL('/admin/produkte', baseUrl).href);
    await admin.getByRole('heading', { name: /Produktentwürfe/ }).waitFor();
    await admin.getByText('Noch keine Produktentwürfe vorhanden.').waitFor();
    await admin.locator('#new-product-sku').fill('E2E-SINGLE-01');
    await admin.locator('#new-product-title').fill('Synthetisches Einzelprodukt');
    await admin.locator('#new-product-course option').filter({ hasText: 'Fitnesstrainer B-Lizenz' }).waitFor({ state: 'attached' });
    await admin.locator('#new-product-course').selectOption({ index: 1 });
    await admin.getByRole('button', { name: 'Produktentwurf anlegen' }).click();
    await admin.waitForURL(/\/admin\/produkte\/[0-9a-f-]+$/);
    const productUrl = admin.url();
    await admin.getByText('NICHT AKTIV · NICHT KAUFBAR').waitFor();
    assert.equal(await admin.locator('#product-title').inputValue(), 'Synthetisches Einzelprodukt');
    await admin.locator('#price-gross').fill('199,00');
    await admin.locator('#price-valid-from').fill('2027-01-01T09:30');
    await admin.getByRole('button', { name: 'Preiszeitraum hinzufügen' }).click();
    await admin.getByText('Preiszeitraum als Entwurf gespeichert.').waitFor();
    const priceRow = admin.getByRole('row').filter({ hasText: '199.00 EUR' });
    await priceRow.waitFor();
    assert.equal(await priceRow.getByText('Entwurf', { exact: false }).count() > 0, true);
    await admin.locator('#price-gross').fill('199.999');
    await admin.locator('#price-valid-from').fill('2027-02-01T09:30');
    await admin.getByRole('button', { name: 'Preiszeitraum hinzufügen' }).click();
    await admin.getByText('Bitte gib einen Bruttobetrag mit höchstens zwei Nachkommastellen an.').waitFor();
    assert.equal(await db.price.count(), 1);
    const productId = productUrl.split('/').pop();
    const draftStatus = await db.product.findUniqueOrThrow({ where: { id: productId } });
    assert.equal(draftStatus.status, 'draft');
    assert.equal(draftStatus.sku, 'E2E-SINGLE-01');
    await assert.rejects(db.product.update({ where: { id: productId }, data: { status: 'active' } }));
    for (const path of ['/api/v1/products', `/api/v1/products/${productId}`, '/api/v1/prices']) {
      assert.equal(await admin.evaluate(url => fetch(url, { cache: 'no-store' }).then(response => response.status), path), 404);
    }
    assert.equal(await admin.evaluate(() => fetch('/api/v1/checkout', { method: 'POST', cache: 'no-store' })
      .then(response => response.status)), 404);
    await admin.goto(new URL('/konto', baseUrl).href);
    await admin.getByRole('link', { name: /Produkte/ }).waitFor();
    await admin.setViewportSize({ width: 375, height: 812 });
    await admin.goto(new URL('/admin/produkte', baseUrl).href);
    await admin.getByRole('heading', { name: /Produktentwürfe/ }).waitFor();
    const productOverflow = await admin.evaluate(() => [...document.querySelectorAll('body *')]
      .filter(element => element.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 6).map(element => `${element.tagName}.${element.className}`));
    assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
      `Product admin must fit a mobile viewport: ${productOverflow.join(', ')}`);
    await admin.setViewportSize({ width: 1200, height: 900 });
    // Release UI: managers never see it, the admin prepares and publishes a
    // complete draft, and only the course text becomes publicly readable.
    await admin.goto(new URL('/admin/kurse', baseUrl).href);
    await admin.getByRole('link', { name: /Fitnesstrainer B-Lizenz/ }).click();
    await admin.getByRole('heading', { name: 'Veröffentlichung' }).waitFor();
    assert.equal(await admin.getByRole('button', { name: 'Veröffentlichen' }).isDisabled(), true, 'An incomplete draft cannot be published.');
    await admin.getByText('MISSING_DURATION', { exact: false }).waitFor();
    assert.equal(await staff.getByRole('heading', { name: 'Veröffentlichung' }).count(), 0, 'Course managers never see the release panel.');
    // Complete the draft through the same authenticated API the page uses.
    const released = await admin.evaluate(async () => {
      const csrf = await fetch('/api/v1/auth/csrf', { cache: 'no-store' }).then(response => response.json());
      const header = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrf_token };
      const courseId = new URL(location.href).pathname.split('/').pop();
      const state = await fetch(`/api/v1/admin/courses/${courseId}/publication`, { cache: 'no-store' }).then(response => response.json());
      const draft = state.versions.find(version => version.state === 'draft');
      // A subtitle and a total duration are required; planned exams block the
      // release because the exam system does not exist yet.
      const response = await fetch(`/api/v1/admin/course-versions/${draft.id}`, { method: 'PATCH', headers: header,
        body: JSON.stringify({ revision: draft.revision, subtitle: 'Synthetischer Untertitel', duration_minutes: 240,
          expected_exams_per_chapter: null }), cache: 'no-store' });
      // Planned module and chapter counts are promises; align them with reality.
      const second = await fetch(`/api/v1/admin/course-versions/${draft.id}`, { method: 'PATCH', headers: header,
        body: JSON.stringify({ revision: draft.revision + 1, expected_module_count: 1, expected_chapter_count: 1 }), cache: 'no-store' });
      return { courseId, patch: response.status, aligned: second.status };
    });
    assert.equal(released.patch, 200); assert.equal(released.aligned, 200);
    await admin.reload();
    await admin.getByRole('heading', { name: 'Veröffentlichung' }).waitFor();
    assert.equal(await admin.getByRole('button', { name: 'Veröffentlichen' }).isDisabled(), false);
    await admin.locator('#publish-visibility').selectOption('public');
    // A confirmation older than five minutes is refused and explained.
    await db.authSession.updateMany({ where: { user_id: adminUser.id, kind: 'backoffice', revoked_at: null },
      data: { reauthenticated_at: new Date(Date.now() - 6 * 60_000) } });
    await admin.getByRole('button', { name: 'Veröffentlichen' }).click();
    await admin.getByText(/Bitte bestätige deine Anmeldung erneut/).waitFor();
    assert.equal((await db.course.findUniqueOrThrow({ where: { id: released.courseId } })).status, 'draft');
    // Confirm with a currently valid app code, then publish for real.
    const factor = await db.userMfaFactor.findFirstOrThrow({ where: { user_id: adminUser.id, status: 'active' } });
    const { unseal: unsealSecret } = require('../../apps/api/dist/security');
    const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30,
      secret: OTPAuth.Secret.fromBase32(unsealSecret(factor.secret_ciphertext, `mfa:${factor.id}`, factor.key_id).secret) });
    await admin.locator('#freigabe details summary').click();
    while (Math.floor(Date.now() / 30_000) === enrollStep) await new Promise(resolve => setTimeout(resolve, 1000));
    const releaseReauth = admin.locator('#freigabe #freigabe-reauth-password');
    await releaseReauth.fill(password);
    await admin.locator('#freigabe-reauth-code').fill(totp.generate());
    await admin.locator('#freigabe').getByRole('button', { name: 'Identität bestätigen', exact: true }).click();
    await admin.locator('#freigabe').getByText(/Identität bestätigt/).waitFor();
    await admin.getByRole('button', { name: 'Veröffentlichen' }).click();
    await admin.getByText(/veröffentlicht\./).waitFor();
    const publicRow = await db.course.findUniqueOrThrow({ where: { id: released.courseId } });
    assert.equal(publicRow.status, 'published'); assert.equal(publicRow.visibility, 'public');
    assert.equal(await db.courseVersion.count({ where: { course_id: released.courseId, state: 'published' } }), 1);
    await admin.goto(new URL('/admin/kurse', baseUrl).href);
    await admin.getByRole('link', { name: /Fitnesstrainer B-Lizenz/ }).click();
    await admin.locator('.future-note span').filter({ hasText: /^VERÖFFENTLICHT/ }).waitFor();
    await admin.getByRole('heading', { name: 'Verlauf', exact: true }).waitFor();
    const publicCatalog = await admin.evaluate(() => fetch('/api/v1/courses', { cache: 'no-store' }).then(response => response.json()));
    assert.ok(publicCatalog.data.length >= 1);
    assert.deepEqual(Object.keys(publicCatalog.data[0]).sort(), ['description', 'duration_minutes', 'slug', 'subtitle', 'title']);
    assert.equal(JSON.stringify(publicCatalog).includes('Synthetisches Modul'), false, 'Lesson structure stays private after publication.');
    // The published course stays visible in the mobile catalog after the test.
    await admin.goto(new URL('/kurse/fitnesstrainer-b-lizenz', baseUrl).href);
    await admin.getByRole('heading', { name: /Fitnesstrainer B-Lizenz/ }).waitFor();

    await staffBrowser.close(); staffBrowser = undefined;
    await adminBrowser.close(); adminBrowser = undefined;
    mobileBrowser = await launch();
    const mobileContext = await mobileBrowser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true });
    const mobile = await mobileContext.newPage();
    await mobile.goto(new URL('/', baseUrl).href);
    await mobile.getByRole('link', { name: 'Ausbildungen', exact: true }).first().click();
    await mobile.getByText('Fitnesstrainer B-Lizenz', { exact: false }).first().waitFor();
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Public catalog must fit a mobile viewport.');
    await mobile.goto(new URL('/kurse/nicht-veroeffentlicht', baseUrl).href);
    await mobile.getByText('Diese Ausbildung ist nicht verfügbar.').waitFor();
    await mobile.goto(detailUrl);
    await mobile.getByText('Bitte melde dich an.').waitFor();
    assert.equal(await mobile.getByText('Synthetisches Kapitel', { exact: true }).count(), 0);
  } finally {
    if (mobileBrowser) await mobileBrowser.close();
    if (staffBrowser) await staffBrowser.close();
    if (adminBrowser) await adminBrowser.close();
    await db.$disconnect();
  }
});
