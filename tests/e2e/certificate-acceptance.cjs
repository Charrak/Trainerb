const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { SMTPServer } = require('smtp-server');
const { chromium } = require('playwright');

const origin = 'https://academy.test';
async function until(predicate, message) {
  for (let n = 0; n < 150; n++) {
    if (predicate()) return;
    await delay(200);
  }
  throw new Error(message);
}

// Shared integration fixture supplies real, already-authenticated sessions. No
// cookie, PDF, mail body or verification token belongs in a persistent report.
async function exercise({ admin, participant, ownerEmail }) {
  assert.equal(process.env.APP_ENV, 'test');
  assert.equal(process.env.PUBLIC_BASE_URL, origin);
  const rewrites = require('../../apps/web/.next/routes-manifest.json').rewrites.afterFiles;
  assert.ok(
    rewrites.some((r) => r.source === '/api/v1/:path*' && r.destination === 'http://127.0.0.1:4000/api/v1/:path*'),
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'certificate-acceptance-'));
  const browsers = [];
  let smtp,
    site,
    web,
    worker,
    workerDone,
    notices = 0;
  try {
    // SMTP sink: loopback, no relay, synthetic recipients only. Discard the
    // messages immediately and keep only the count for the intended recipient.
    smtp = new SMTPServer({
      disabledCommands: ['AUTH', 'STARTTLS'],
      authOptional: true,
      logger: false,
      onRcptTo(address, session, cb) {
        cb(address.address.endsWith('@example.invalid') ? null : new Error('Test recipients only'));
      },
      onData(stream, session, cb) {
        let headers = '',
          complete = false;
        stream.on('data', (chunk) => {
          if (complete) return;
          headers = (headers + chunk.toString()).slice(0, 8192);
          const end = headers.indexOf('\r\n\r\n');
          if (end >= 0) {
            headers = headers.slice(0, end);
            complete = true;
          } else if (headers.length === 8192) complete = true;
        });
        stream.on('end', () => {
          if (
            /^Subject: Deine Urkunde steht bereit\r?$/m.test(headers) &&
            session.envelope.rcptTo.length === 1 &&
            session.envelope.rcptTo[0].address === ownerEmail
          )
            notices++;
          cb();
        });
        stream.on('error', cb);
      },
    });
    await new Promise((resolve, reject) => {
      smtp.once('error', reject);
      smtp.listen(0, '127.0.0.1', resolve);
    });
    worker = spawn(process.execPath, ['apps/api/dist/worker.js'], {
      env: {
        ...process.env,
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(smtp.server.address().port),
        SMTP_USER: '',
        SMTP_PASSWORD: '',
        SMTP_SECURE: 'false',
      },
      stdio: 'ignore',
    });
    workerDone = once(worker, 'exit');
    web = require('next')({ dev: false, dir: path.resolve('apps/web') });
    await web.prepare();
    const key = path.join(dir, 'private.key'),
      crt = path.join(dir, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=academy.test',
        '-keyout',
        key,
        '-out',
        crt,
      ],
      { stdio: 'ignore' },
    );
    const handle = web.getRequestHandler();
    site = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) }, (req, res) => {
      if (req.headers.host !== 'academy.test') {
        res.writeHead(404);
        return res.end();
      }
      handle(req, res);
    });
    await new Promise((resolve, reject) => {
      site.once('error', reject);
      site.listen(0, '127.0.0.1', resolve);
    });
    async function pageFor(session) {
      const browser = await chromium.launch({
        executablePath: process.env.E2E_CHROMIUM_PATH || undefined,
        args: [
          `--host-resolver-rules=MAP academy.test 127.0.0.1:${site.address().port}, MAP * ~NOTFOUND`,
          '--no-proxy-server',
          ...(process.env.E2E_SINGLE_PROCESS === 'yes'
            ? ['--single-process', '--no-zygote', '--disable-dev-shm-usage']
            : []),
        ],
      });
      browsers.push(browser);
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      if (session)
        await context.addCookies(
          [...session.cookies].map(([name, value]) => ({
            name,
            value,
            url: origin,
            secure: true,
            sameSite: 'Lax',
            httpOnly: name === '__Host-session',
          })),
        );
      return context.newPage();
    }
    const owner = await pageFor(participant),
      staff = await pageFor(admin),
      visitor = await pageFor();
    await until(() => notices === 1, 'Initial certificate mail not received via SMTP');
    async function download() {
      await owner.goto(`${origin}/konto/urkunden`);
      const link = owner.getByRole('link', { name: 'Urkunde als PDF herunterladen' });
      const [file] = await Promise.all([owner.waitForEvent('download'), link.click()]);
      const number = /^Zertifikat-([0-9a-f-]{36})\.pdf$/.exec(file.suggestedFilename())?.[1];
      assert.ok(number, 'Missing certificate number');
      const pdf = path.join(dir, 'download.pdf');
      await file.saveAs(pdf);
      const token = execFileSync('python3', [path.join(__dirname, 'inspect-certificate.py'), pdf, number], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      return { number, token };
    }
    async function verify(token, label) {
      await visitor.goto(`${origin}/zertifikat-pruefen`);
      await visitor.getByLabel('Prüfcode').fill(token);
      await visitor.getByRole('button', { name: 'Gültigkeit prüfen' }).click();
      await visitor.getByRole('status').filter({ hasText: label }).waitFor();
    }
    const first = await download();
    await verify(first.token, 'Gültig');
    await staff.goto(`${origin}/admin/urkunden`);
    const foreignStatus = await staff.evaluate(
      async (number) => (await fetch(`/api/v1/me/certificates/${number}/download`)).status,
      first.number,
    );
    assert.equal(foreignStatus, 404);
    const original = staff.locator('article').filter({ hasText: first.number });
    await original.getByLabel('Widerrufsgrund').fill('Synthetische Abnahme');
    await original.getByRole('button', { name: 'Urkunde widerrufen' }).click();
    const replace = original.getByRole('button', { name: 'Neuausstellung anfordern' });
    await replace.waitFor();
    await verify(first.token, 'Widerrufen');
    await owner.reload();
    await owner.getByText(/Abgeschlossen am .*Widerrufen/).waitFor();
    assert.equal(await owner.getByRole('link', { name: 'Urkunde als PDF herunterladen' }).count(), 0);
    await replace.click();
    await until(() => notices === 2, 'Replacement certificate mail not received via SMTP');
    const second = await download();
    assert.notEqual(first.number, second.number);
    assert.ok(first.token !== second.token, 'Reused verification code');
    await verify(second.token, 'Gültig');
    await verify(first.token, 'Widerrufen');
    await staff.goto(`${origin}/admin/protokoll`);
    await staff.getByLabel('Bereich').selectOption('certificates');
    await staff.locator('article').filter({hasText:first.number}).getByText('Urkunde widerrufen', {exact:true}).waitFor();
    await staff.goto(`${origin}/admin/kennzahlen`);
    await staff.getByRole('heading', {name:'Alle Kurse'}).waitFor();
    await staff.goto(`${origin}/admin/mailauftraege`);
    await staff.getByLabel('Status').selectOption('succeeded');
    await staff.locator('li').filter({hasText:'Abgeschlossen'}).first().waitFor();
    await staff.goto(`${origin}/admin/urkundenmail`);
    await staff.getByLabel('Betreff').fill('Urkunde im Testkonto');
    await staff.getByRole('button', {name:'Als Entwurf speichern'}).click();
    await staff.getByRole('status').filter({hasText:'Entwurf gespeichert'}).waitFor();
    await staff.getByRole('button', {name:'Gespeicherten Entwurf für den Versand freigeben'}).click();
    await staff.getByRole('status').filter({hasText:'für künftige Urkundenmails freigegeben'}).waitFor();
    await owner.goto(`${origin}/admin/urkundenmail`);
    await owner.getByRole('alert').filter({hasText:'Kein Zugriff'}).waitFor();
    assert.equal(await owner.getByLabel('Betreff').count(), 0);
  } finally {
    await Promise.all(browsers.map((b) => b.close()));
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      worker.kill('SIGTERM');
      const timer = setTimeout(() => worker.kill('SIGKILL'), 8000);
      try {
        await workerDone;
      } finally {
        clearTimeout(timer);
      }
    }
    if (smtp) await new Promise((resolve) => smtp.close(resolve));
    if (site) {
      site.closeAllConnections();
      await new Promise((resolve) => site.close(resolve));
    }
    if (web) await web.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
module.exports = { exercise };
