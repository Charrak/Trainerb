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

// Test-only dependency, never shipped to the website. Do not log page text or form values.
async function checkAccessibility(page,label){
  await page.evaluate(require('axe-core').source);
  const violations=await page.evaluate(async()=>{
    const run=await window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}});
    return run.violations.map(v=>({rule:v.id,targets:v.nodes.map(n=>n.target)}));
  });
  for(const v of violations)console.log(`A11Y_DIAGNOSTIC ${label}: ${v.rule} ${JSON.stringify(v.targets).slice(0,500)}`);
  assert.deepEqual(violations,[],`Accessibility regression (${label}): ${JSON.stringify(violations)}`);
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
    const cspViolations=[];
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
      // Keine URLs, Nonces oder Skriptinhalte protokollieren (Links können Tokens enthalten).
      await context.exposeFunction('recordCspViolation', directive=>{ cspViolations.push(directive); });
      await context.addInitScript(()=>document.addEventListener('securitypolicyviolation', e=>window.recordCspViolation(e.effectiveDirective)));
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
    // Anonymous public pages do not introduce optional tracking, third-party requests or local storage.
    const outside=[]; const monitor=req=>{if(new URL(req.url()).origin!==origin)outside.push(new URL(req.url()).origin);};
    visitor.on('request',monitor);
    await visitor.goto(`${origin}/cookie-einstellungen`);await visitor.getByRole('heading',{name:'Cookie-Einstellungen'}).waitFor();
    await checkAccessibility(visitor,'cookie information');
    await visitor.getByRole('main').getByRole('link',{name:'Meine Datenrechte'}).click();
    await visitor.getByRole('heading',{name:'Meine Datenrechte',exact:true}).waitFor();
    await visitor.waitForFunction(()=>document.title==='Meine Datenrechte · Trainer B Akademie');
    await checkAccessibility(visitor,'privacy request form');
    await visitor.getByLabel('Kontaktadresse').fill('datenrechte-browser@example.invalid');await visitor.getByLabel('Art der Anfrage').selectOption('access');
    await visitor.getByRole('button',{name:'Anfrage senden'}).click();await visitor.getByRole('status').filter({hasText:'Deine Anfrage ist eingegangen'}).waitFor();
    assert.deepEqual(outside,[]);assert.ok((await visitor.context().cookies()).every(c=>c.name==='__Host-csrf'&&c.secure));
    assert.equal(await visitor.evaluate(()=>localStorage.length),0);visitor.off('request',monitor);
    const productId=await visitor.evaluate(async()=> (await (await fetch('/api/v1/shop/products')).json()).data[0].id);
    // Nur Chromium kennt die isolierte HTTPS-Testorigin (host-resolver-rules).
    const [robots, sitemap] = await visitor.evaluate(() => Promise.all(['/robots.txt', '/sitemap.xml'].map(async path => {
      const response = await fetch(path, { credentials: 'omit', cache: 'no-store' });
      return { status: response.status, text: await response.text() };
    })));
    assert.equal(robots.status, 200); assert.match(robots.text, /^Disallow: \/$/m); assert.doesNotMatch(robots.text, /Sitemap:|^Allow:/m);
    assert.equal(sitemap.status, 200); assert.match(sitemap.text, /<urlset /); assert.doesNotMatch(sitemap.text, /<loc>/);
    const usedNonces=new Set();
    await visitor.goto(origin+'/');
    await visitor.getByRole('heading',{level:1,name:/Wissen, das weiterbringt/}).waitFor();
    await checkAccessibility(visitor,'start page');
    assert.equal(await visitor.getByRole('contentinfo').getByText(/Nur Testdaten verwenden/).count(),1,'Testhinweis außerhalb des Live-Betriebs');
    assert.equal(await visitor.getByRole('link',{name:/Anmelden/}).first().isVisible(),true);
    for (const path of ['/','/anmelden','/registrieren','/passwort-vergessen','/aktivierung-erneut','/konto/aktivieren',
      '/konto/email-bestaetigen','/konto/passwort-zuruecksetzen','/mfa','/mfa/einrichten','/kurse','/kurse/abschluss-fixture',
      '/buchen','/buchen/'+productId,'/warenkorb','/kasse/gast','/kasse/bestaetigen','/newsletter','/newsletter/bestaetigen',
      '/newsletter/abmelden','/agb','/datenschutz','/widerruf','/widerrufsbelehrung','/widerruf/bestaetigen','/anmelden']) {
      const res=await visitor.goto(origin+path);
      assert.equal(res.status(),200,`Dokument: ${path}`);
      const h=res.headers(), nonce=h['content-security-policy']?.match(/'nonce-([^']+)'/)?.[1];
      assert.equal(h['x-robots-tag'],'noindex, nofollow');
      assert.match(await visitor.locator('meta[name=robots]').getAttribute('content'),/noindex, nofollow/);
      if(path==='/kurse/abschluss-fixture') await checkAccessibility(visitor,'Kursdetail');
      assert.ok(nonce && !usedNonces.has(nonce),'Neue Dokument-Nonce fehlt');usedNonces.add(nonce);
      assert.match(h['cache-control'],/no-store/);assert.match(h['content-security-policy'],/frame-ancestors 'none'/);
      assert.equal(h['cross-origin-opener-policy'],'same-origin');assert.match(h['permissions-policy'],/camera=\(\)/);
      assert.ok(await visitor.evaluate(value=>{
        const inline=[...document.scripts].filter(s=>!s.src && (!s.type || s.type==='text/javascript') && s.textContent.trim());
        return inline.length>0 && inline.every(s=>s.nonce===value);
      },nonce),'Inline-Bootstrap stimmt nicht mit dem Header überein');
    }
    await owner.goto(`${origin}/kasse`);
    await staff.goto(`${origin}/admin/datenschutzanfragen`);await staff.getByLabel('Vorgang auswählen').locator('option').filter({hasText:'Auskunft'}).waitFor({state:'attached'});
    await staff.goto(`${origin}/admin/newsletter`);await staff.getByText(/Der Kampagnenversand ist in dieser Umgebung ausgeschaltet/).waitFor();
    await checkAccessibility(staff,'newsletter workspace');
    await owner.setViewportSize({width:390,height:844});
    await owner.goto(`${origin}/lernen/abschluss-fixture`);
    await owner.getByText(/Alle 84 Prüfungen bestanden/).waitFor();
    await owner.getByRole('button',{name:/K1/}).first().click();
    await owner.getByText('Synthetischer Lerninhalt.',{exact:true}).waitFor();
    // Anzeigeprobe im mobilen Player; echte Sperrentscheidungen prüft der API-Integrationstest.
    const resumePattern='**/exams/*/attempts/current';
    const unlockAt=new Date(Date.now()+60000).toISOString();
    await owner.route(resumePattern, route=>route.fulfill({json:{attempt:{status:'failed',id:'fixture'},cooldown:{retry_at:unlockAt,retry_after_ms:'60000'}}}));
    await owner.getByText('Prüfung: P1',{exact:true}).first().click();
    const wait=owner.getByRole('status').filter({hasText:'Nächster Versuch ab'});await wait.waitFor();
    assert.equal(await wait.locator('time').getAttribute('datetime'),unlockAt);
    assert.ok(await owner.getByRole('button',{name:'Erneut versuchen'}).isDisabled());
    await owner.unroute(resumePattern);
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
    await staff.getByLabel('Berichtszeitraum').selectOption('all');
    await staff.getByText(/Seit Aufzeichnungsbeginn/).waitFor();
    await staff.getByText('Nicht erfasst', {exact:true}).waitFor();
    await staff.goto(`${origin}/admin/mailauftraege`);
    await staff.getByLabel('Status').selectOption('succeeded');
    await staff.locator('li').filter({hasText:'Abgeschlossen'}).first().waitFor();
    await staff.goto(`${origin}/admin/urkundenmail`);
    await staff.getByLabel('Betreff').fill('Urkunde im Testkonto');
    await staff.getByRole('button', {name:'Als Entwurf speichern'}).click();
    await staff.getByRole('status').filter({hasText:'Entwurf gespeichert'}).waitFor();
    await staff.getByRole('button', {name:'Gespeicherten Entwurf für den Versand freigeben'}).click();
    await staff.getByRole('status').filter({hasText:'für künftige Urkundenmails freigegeben'}).waitFor();
    await staff.goto(`${origin}/admin/website`);
    await staff.getByLabel('Seitenpfad unter /seiten/').fill('browser-fassung');
    await staff.getByLabel('Seitentitel', {exact:true}).fill('Testseite Redaktion');
    assert.equal(await staff.getByLabel('Seiteninhalt',{exact:true}).getAttribute('maxlength'),'100000');
    await staff.getByLabel('Seiteninhalt', {exact:true}).fill('## Zwischenüberschrift\n\nAbsatz im Browsertest.\n\n'+'Testabsatz. '.repeat(5000)+'\n\nEnde des langen Testtexts.');
    await staff.getByLabel('Bannertext (optional)').fill('Synthetischer Hinweis');
    await staff.getByLabel('Buttonziel').selectOption('/kurse');
    await staff.getByLabel('Buttontext').fill('Zum Kursangebot');
    await staff.getByRole('button',{name:'Entwurf speichern',exact:true}).click();
    await staff.getByRole('button',{name:'Gespeicherten Entwurf veröffentlichen'}).click();
    await staff.getByRole('status').filter({hasText:'Gespeicherte Fassung veröffentlicht'}).waitFor();
    const menu=await staff.context().newPage();
    await menu.goto(`${origin}/admin/navigation`);
    for (const [area,label] of [['header','Informationen zur Testseite'],['footer','Redaktioneller Fußlink']]) {
      await menu.getByLabel('Menübereich').selectOption(area);
      await menu.getByLabel('Website-Seite hinzufügen').selectOption({label:'browser-fassung'});
      await menu.getByRole('button',{name:'Link hinzufügen'}).click();
      await menu.getByLabel('Linktext').fill(label);
      await menu.getByRole('button',{name:'Menü speichern'}).click();
      await menu.getByRole('status').filter({hasText:'Menü gespeichert'}).waitFor();
    }
    await menu.close();
    await visitor.goto(`${origin}/seiten`);
    const footlink=visitor.getByRole('contentinfo').getByRole('link',{name:'Redaktioneller Fußlink'});
    await footlink.waitFor(); assert.equal(await footlink.getAttribute('href'),'/seiten/browser-fassung');
    await visitor.getByRole('navigation',{name:'Weitere Website-Seiten'}).getByRole('link',{name:'Informationen zur Testseite'}).click();
    await visitor.getByRole('heading',{name:'Zwischenüberschrift'}).waitFor();
    await visitor.getByText('Ende des langen Testtexts.',{exact:true}).waitFor();
    await visitor.getByText('Synthetischer Hinweis',{exact:true}).waitFor();
    assert.equal(await visitor.getByRole('link',{name:'Zum Kursangebot'}).getAttribute('href'),'/kurse');
    await staff.getByRole('button',{name:'Veröffentlichte Seite zurücknehmen'}).click();
    await staff.getByRole('status').filter({hasText:'Seite zurückgenommen'}).waitFor();
    await staff.goto(`${origin}/admin/rechtstexte`);
    await staff.getByLabel('Rechtsdokument').selectOption('payment_info');
    assert.equal(await staff.getByLabel('Wortlaut',{exact:true}).getAttribute('maxlength'),'100000');
    await staff.getByLabel('Wortlaut',{exact:true}).fill('Synthetischer Browser-Wortlaut.');
    await staff.getByRole('button',{name:'Neue Fassung als Entwurf speichern'}).click();
    await staff.getByRole('checkbox').check();
    await staff.getByRole('button',{name:'Geprüfte Fassung aktivieren'}).click();
    await staff.getByRole('status').filter({hasText:'Gespeicherte Fassung aktiviert'}).waitFor();
    await visitor.goto(`${origin}/zahlungsinformationen`);
    await visitor.getByText('Synthetischer Browser-Wortlaut.',{exact:true}).waitFor();
    await staff.getByRole('link',{name:'Anbieterprofil bearbeiten'}).click();
    const providerName=`Testanbieter ${Date.now()}`;
    for(const [label,value] of [['Rechtliche Anbieterbezeichnung',providerName],['Verantwortliche Person','Synthetische Redaktion'],['Straße und Hausnummer','Testweg 1'],['Postleitzahl','12345'],['Ort *','Teststadt'],['Land (zweistelliger Code)','DE'],['Kontakt-E-Mail','redaktion@example.invalid']]) {
      await staff.getByLabel(label).fill(value);
    }
    await staff.getByRole('button',{name:'Anbieterprofil speichern'}).click();
    await staff.getByRole('status').filter({hasText:'Profil gespeichert'}).waitFor();
    await staff.getByRole('link',{name:'Zum Rechtstexteditor'}).click();
    await staff.getByLabel('Rechtsdokument').selectOption('imprint');
    await staff.getByLabel('Wortlaut',{exact:true}).fill('Synthetischer Impressumstest.');
    await staff.getByRole('button',{name:'Neue Fassung als Entwurf speichern'}).click();
    await staff.getByRole('checkbox').check();
    await staff.getByRole('button',{name:'Geprüfte Fassung aktivieren'}).click();
    await staff.getByRole('status').filter({hasText:'Gespeicherte Fassung aktiviert'}).waitFor();
    await visitor.goto(`${origin}/impressum`);
    await visitor.getByText(providerName,{exact:true}).waitFor();
    await visitor.getByText('Synthetische Redaktion',{exact:true}).waitFor();
    await owner.goto(`${origin}/admin/urkundenmail`);
    await owner.getByRole('alert').filter({hasText:'Kein Zugriff'}).waitFor();
    assert.equal(await owner.getByLabel('Betreff').count(), 0);
    assert.deepEqual(cspViolations,[],'CSP-Verletzung im Browserlauf');
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
