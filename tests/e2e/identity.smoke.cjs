const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright');

// Only explicitly opted-in, isolated development environments may be used.
const base = process.env.E2E_BASE_URL;
const mail = process.env.E2E_MAILPIT_URL;
if (process.env.E2E_ALLOW_TEST_DATA !== 'yes' || !base || !mail) {
  throw new Error('Set E2E_ALLOW_TEST_DATA=yes, E2E_BASE_URL and E2E_MAILPIT_URL for a disposable development environment.');
}
const baseUrl = new URL(base), mailUrl = new URL(mail);
if (!['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname) || !['localhost', '127.0.0.1', '[::1]'].includes(mailUrl.hostname)) {
  throw new Error('Browser smoke tests run only against local disposable services.');
}

async function activationLink(email) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const list = await fetch(new URL('/api/v1/messages', mailUrl)).then(r => r.json());
    const summary = list.messages?.find(m => m.To?.some(a => a.Address?.toLowerCase() === email.toLowerCase()));
    if (summary) {
      const message = await fetch(new URL(`/api/v1/message/${encodeURIComponent(summary.ID)}`, mailUrl)).then(r => r.json());
      const url = message.Text?.match(/https?:\/\/[^\s]+#token=[A-Za-z0-9_-]+/)?.[0];
      if (url) {
        const parsed = new URL(url);
        assert.equal(parsed.origin, baseUrl.origin, 'Activation link must use the configured web origin.');
        return url;
      }
    }
    await delay(1000);
  }
  throw new Error('The local mail catcher did not receive the activation message.');
}

test('browser registration, activation, login, profile and logout', { timeout: 90000 }, async () => {
  const email = `browser-${randomUUID()}@example.invalid`;
  const password = 'NurTest!Wolke2026';
  const specialArgs = process.env.E2E_SINGLE_PROCESS === 'yes' ? ['--single-process', '--no-zygote', '--no-sandbox', '--disable-dev-shm-usage'] : [];
  const browser = await chromium.launch({ headless: true, ...(process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}), args: specialArgs });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  try {
    await page.goto(new URL('/registrieren', baseUrl).href);
    await page.locator('#first-name').fill('   ');
    await page.locator('#last-name').fill('Beispiel');
    await page.locator('#email').fill(email);
    await page.getByRole('button', { name: 'Konto erstellen' }).click();
    await page.getByRole('alert').getByText(/Vorname/).waitFor();
    await page.locator('#first-name').fill('Éva');
    await page.getByRole('button', { name: 'Konto erstellen' }).click();
    await page.getByText('Fast geschafft.').waitFor();
    const url = await activationLink(email);
    await page.goto(url);
    await page.locator('#new-password').waitFor();
    assert.equal(await page.evaluate(() => location.hash), '', 'Token should be removed from browser history.');
    await page.locator('#new-password').fill(password);
    await page.locator('#repeat-password').fill(password);
    await page.getByRole('button', { name: 'Konto aktivieren' }).click();
    await page.getByText(/Dein Konto ist aktiviert/).waitFor();
    await page.getByRole('link', { name: /Zur Anmeldung/ }).last().click();
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await page.getByRole('heading', { name: /Hallo, Éva/ }).waitFor();
    await page.locator('#profile-first').fill('Éva-Marie');
    await page.getByRole('button', { name: 'Änderungen speichern' }).click();
    await page.getByText('Deine Angaben wurden gespeichert.').waitFor();
    await page.getByRole('button', { name: 'Abmelden' }).click();
    await page.waitForURL(/\/anmelden$/);
    await page.goto(new URL('/konto', baseUrl).href);
    await page.getByText(/Bitte melde dich an/).waitFor();
  } finally { await browser.close(); }
});
