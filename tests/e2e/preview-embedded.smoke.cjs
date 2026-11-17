const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright');

// The local TLS gateway simulates a cross-site iframe without contacting the
// actual preview hostname or bypassing any platform access control. This test
// writes a synthetic account and must only run against a disposable database.
const enabled = process.env.E2E_EMBEDDED_PREVIEW === 'yes';
const parentHost = 'trainerb-preview-parent.invalid';
let base, preview;
if (enabled) {
  if (process.env.E2E_ALLOW_TEST_DATA !== 'yes' || !process.env.E2E_BASE_URL || !process.env.E2E_PREVIEW_ORIGIN) {
    throw new Error('Set E2E_ALLOW_TEST_DATA=yes, E2E_BASE_URL and E2E_PREVIEW_ORIGIN for an isolated preview test.');
  }
  base = new URL(process.env.E2E_BASE_URL);
  preview = new URL(process.env.E2E_PREVIEW_ORIGIN);
  if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) ||
      base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('E2E_BASE_URL must be a local HTTP origin.');
  }
  if (preview.protocol !== 'https:' || preview.port || preview.username || preview.password ||
      preview.pathname !== '/' || preview.search || preview.hash || preview.hostname === parentHost) {
    throw new Error('E2E_PREVIEW_ORIGIN must be a separate HTTPS origin on the default port.');
  }
}

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
});

test('embedded preview: registration, test inbox, activation and login', { skip: !enabled, timeout: 120000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trainerb-preview-test-'));
  let gateway, tunnel, browser;
  try {
    const keyPath = path.join(directory, 'key.pem'), certPath = path.join(directory, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
      '-out', certPath, '-days', '1', '-subj', '/CN=local-preview-test.invalid'], { stdio: 'ignore' });
    gateway = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, (req, res) => {
      if (req.headers.host === parentHost) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body><iframe title="Vorschau" src="${preview.origin}/registrieren"></iframe></body></html>`);
        return;
      }
      if (req.headers.host !== preview.host) { res.writeHead(404); res.end(); return; }
      const target = http.request({ hostname: base.hostname.replace(/^\[|\]$/g, ''), port: base.port || 80,
        path: req.url, method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      target.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(target);
    });
    // Next's development client uses a WebSocket for HMR and its React debug
    // stream; forwarding the upgrade is necessary for realistic hydration.
    gateway.on('upgrade', (req, client, head) => {
      if (process.env.E2E_BLOCK_HMR === 'yes' || req.headers.host !== preview.host || !req.url.startsWith('/_next/hmr')) {
        client.destroy(); return;
      }
      const target = http.request({ hostname: base.hostname.replace(/^\[|\]$/g, ''), port: base.port || 80,
        path: req.url, method: req.method, headers: req.headers });
      target.on('upgrade', (response, socket, responseHead) => {
        const headers = response.rawHeaders.reduce((lines, value, index, all) =>
          index % 2 === 0 ? `${lines}${value}: ${all[index + 1]}\r\n` : lines, '');
        client.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${headers}\r\n`);
        if (responseHead.length) client.write(responseHead);
        if (head.length) socket.write(head);
        client.pipe(socket); socket.pipe(client);
        client.on('error', () => socket.destroy()); socket.on('error', () => client.destroy());
      });
      target.on('error', () => client.destroy());
      target.on('response', () => client.destroy());
      target.end();
    });
    await listen(gateway);

    // The proxy is bound to loopback and permits exactly these two hostnames;
    // every preview request is forwarded to the local TLS gateway above.
    tunnel = http.createServer();
    tunnel.on('connect', (req, client, head) => {
      if (![`${preview.host}:443`, `${parentHost}:443`].includes(req.url)) {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return;
      }
      const target = net.connect(gateway.address().port, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) target.write(head);
        client.pipe(target); target.pipe(client);
      });
      target.on('error', () => client.destroy()); client.on('error', () => target.destroy());
    });
    await listen(tunnel);
    const specialArgs = process.env.E2E_SINGLE_PROCESS === 'yes' ? ['--single-process', '--no-zygote', '--no-sandbox', '--disable-dev-shm-usage'] : [];
    browser = await chromium.launch({ headless: true, ...(process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}),
      proxy: { server: `http://127.0.0.1:${tunnel.address().port}` }, args: specialArgs });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1200, height: 900 } });
    const page = await context.newPage();
    const email = `preview-${randomUUID()}@example.invalid`;
    const password = 'NurTest!Wolke2026';
    await page.goto(`https://${parentHost}/`);
    await page.frameLocator('iframe').locator('#first-name').waitFor();
    const frame = page.frames().find(item => item.url().startsWith(preview.origin));
    assert.ok(frame, 'The cross-site iframe should load.');
    await frame.waitForLoadState('networkidle');
    await frame.locator('#first-name').fill('Mila');
    await frame.locator('#last-name').fill('Beispiel');
    await frame.locator('#email').fill(email);
    await frame.getByRole('button', { name: 'Konto erstellen' }).click();
    await frame.getByText('Fast geschafft.').waitFor();
    await frame.getByRole('link', { name: 'Test-Postfach öffnen' }).click();
    await frame.getByRole('heading', { name: 'Test-Postfach.' }).waitFor();

    let message;
    for (let attempt = 0; attempt < 30; attempt++) {
      const found = frame.locator('.test-inbox-message').filter({ hasText: email });
      if (await found.count()) { message = found.first(); break; }
      await delay(1000);
      await frame.getByRole('link', { name: 'Aktualisieren' }).click();
    }
    assert.ok(message, 'The test mailbox should receive the activation message.');
    const action = message.getByRole('link', { name: 'Bestätigungslink öffnen' });
    const href = await action.getAttribute('href');
    assert.ok(/^\/konto\/aktivieren#token=[A-Za-z0-9_-]{43}$/.test(href || ''), 'The activation link must stay on the preview origin.');
    await action.click();
    await frame.locator('#new-password').waitFor();
    assert.equal(await frame.evaluate(() => location.hash), '', 'The activation token must leave browser history.');
    await frame.locator('#new-password').fill(password);
    await frame.locator('#repeat-password').fill(password);
    await frame.getByRole('button', { name: 'Konto aktivieren' }).click();
    await frame.getByText(/Dein Konto ist aktiviert/).waitFor();
    await frame.getByRole('link', { name: /Zur Anmeldung/ }).last().click();
    await frame.locator('#email').fill(email);
    await frame.locator('#password').fill(password);
    await frame.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await frame.getByRole('heading', { name: /Hallo, Mila/ }).waitFor();
    const cookie = (await context.cookies()).find(item => item.name === '__Host-session');
    assert.ok(cookie && cookie.secure && cookie.httpOnly && cookie.sameSite === 'None' && cookie.partitionKey,
      'The embedded session cookie must be secure, HttpOnly and partitioned.');
    await frame.getByRole('button', { name: 'Abmelden' }).click();
    await frame.waitForURL(/\/anmelden$/);
    assert.ok(!(await context.cookies()).some(item => item.name === '__Host-session'), 'Logout must clear the embedded session.');
  } finally {
    if (browser) await browser.close();
    if (tunnel) { tunnel.closeAllConnections(); tunnel.close(); }
    if (gateway) { gateway.closeAllConnections(); gateway.close(); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
