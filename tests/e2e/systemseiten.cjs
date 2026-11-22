const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const listen = server => new Promise((resolve,reject) => {
  server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
});

// Nur synthetische Antworten am Loopback. Keine Datenbank, öffentliche Fehlerroute oder Produktionsschalter.
test('Produktionsbuild: Systemseiten, Kontozugang und Fußnavigation am Mobilviewport', {timeout:90_000}, async t => {
  let release, failing = true;
  const gate = new Promise(resolve => { release = resolve; });
  const api = http.createServer(async (req,res) => {
    if (req.url !== '/api/v1/pages') { res.writeHead(404).end(); return; }
    if (failing) { await gate; res.writeHead(503).end('Interne Testdiagnose'); return; }
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({data:[],next_cursor:null}));
  });
  process.env.API_INTERNAL_ORIGIN = await listen(api);
  process.env.PUBLIC_BASE_URL = 'https://akademie.example.invalid';
  t.after(() => { release(); api.closeAllConnections(); api.close(); });
  const web = require('next')({dev:false,dir:path.resolve('apps/web')});
  await web.prepare(); t.after(() => web.close());
  const handle = web.getRequestHandler();
  let navStatus = 200;
  const site = http.createServer((req,res) => {
    if (req.url === '/api/v1/navigation') return res.writeHead(navStatus,{'content-type':'application/json'}).end(JSON.stringify({
      header:[], footer:[{label:'Redaktionelle Testseite',href:'/seiten/testseite'}],
    }));
    return handle(req,res);
  });
  const origin = await listen(site);
  t.after(() => { site.closeAllConnections(); site.close(); });
  const browser = await chromium.launch({executablePath:process.env.E2E_CHROMIUM_PATH || undefined,
    args:process.env.E2E_SINGLE_PROCESS==='yes'?['--single-process','--no-zygote','--disable-dev-shm-usage']:[]});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:375,height:812}, reducedMotion:'reduce'});
  const outside=[], violations=[];
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    outside.push(route.request().resourceType()); return route.abort();
  });
  await page.exposeFunction('reportViolation', directive=>violations.push(directive));
  await page.addInitScript(()=>document.addEventListener('securitypolicyviolation',e=>window.reportViolation(e.effectiveDirective)));
  async function accessible() {
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.evaluate(require('axe-core').source);
    const issues=await page.evaluate(async()=> (await window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']}})).violations.map(v=>({rule:v.id,targets:v.nodes.map(n=>n.target)})));
    assert.deepEqual(issues,[]);
  }
  const missing = await page.goto(origin+'/nicht-vorhandene-testseite');
  assert.equal(missing.status(),404);
  await page.getByRole('heading',{name:'Seite nicht gefunden'}).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'),'de');
  await accessible();
  await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  assert.equal(new URL(page.url()).hash,'#inhalt');
  assert.equal(await page.locator('meta[property="og:image"]').getAttribute('content'),process.env.PUBLIC_BASE_URL+'/marke/vorschaubild.png');
  for(const url of ['/favicon.ico','/marke/zeichen.svg','/marke/app-180.png','/marke/app-192.png','/marke/app-512.png','/marke/vorschaubild.png']) {
    const res=await page.request.get(origin+url); assert.equal(res.status(),200); assert.match(res.headers()['content-type'],/^image\//);
  }
  await page.goto(origin+'/seiten',{waitUntil:'commit'});
  await page.getByRole('status').filter({hasText:'Bitte warte einen Moment.'}).waitFor();
  release();
  await page.getByRole('heading',{name:'Seite konnte nicht geladen werden'}).waitFor();
  assert.doesNotMatch(await page.locator('body').innerText(),/Interne Testdiagnose|Error:|digest/i);
  await accessible();
  failing=false;
  await page.getByRole('button',{name:'Seite neu laden'}).click();
  await page.getByRole('heading',{name:'Website-Seiten'}).waitFor();
  // Auch ohne redaktionelle Daten bleiben alle drei Gruppen und die Rechtswege benutzbar.
  navStatus=503;
  const navigationError=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/navigation' && r.status()===503);
  await page.goto(origin+'/anmelden'); await navigationError;
  const main=page.getByRole('main'), footer=page.getByRole('contentinfo');
  const academy=footer.getByRole('navigation',{name:'Akademie',exact:true});
  const legal=footer.getByRole('navigation',{name:'Rechtliches',exact:true});
  const account=footer.getByRole('navigation',{name:'Konto',exact:true});
  assert.equal(await main.locator('h1').innerText(),'Anmelden');
  assert.doesNotMatch(await main.innerText(),/Baustein|Wissen bewegt|Akademie befindet sich im Aufbau/);
  assert.deepEqual(await footer.getByRole('heading',{level:2}).allTextContents(),['Akademie','Rechtliches','Konto']);
  assert.equal(await academy.getByRole('link',{name:'Ausbildungen'}).getAttribute('href'),'/kurse');
  assert.equal(await legal.getByRole('link',{name:'Vertrag widerrufen'}).getAttribute('href'),'/widerruf');
  assert.equal(await legal.getByRole('link',{name:'Widerrufsbelehrung'}).getAttribute('href'),'/widerrufsbelehrung');
  assert.equal(await account.getByRole('link',{name:'Mein Konto'}).getAttribute('href'),'/konto');
  assert.equal(await footer.getByText(/Nur Testdaten verwenden/).count(),1);
  assert.equal(await footer.getByRole('navigation',{name:'Weitere Links im Fußbereich'}).count(),0);
  await accessible();
  navStatus=200;
  const register=main.getByRole('link',{name:'Jetzt registrieren'});
  await register.focus(); await page.keyboard.press('Enter');
  await main.getByRole('heading',{name:'Konto erstellen',level:1}).waitFor();
  await main.getByLabel('Vorname').focus(); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'last-name');
  await footer.getByRole('navigation',{name:'Weitere Links im Fußbereich'}).getByRole('link',{name:'Redaktionelle Testseite'}).waitFor();
  await accessible();
  assert.equal((await page.context().cookies()).length,0);
  assert.deepEqual(outside,[]); assert.deepEqual(violations,[]);
});
