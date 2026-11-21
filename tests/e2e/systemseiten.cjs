const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const listen = server => new Promise((resolve,reject) => {
  server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
});

// Nur synthetische Antworten am Loopback. Keine Datenbank, öffentliche Fehlerroute oder Produktionsschalter.
test('Produktionsbuild: 404, Ladezustand, API-Ausfall und Wiederholung am Mobilviewport', {timeout:90_000}, async t => {
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
  const site = http.createServer((req,res) => {
    if (req.url === '/api/v1/navigation') return res.writeHead(200,{'content-type':'application/json'}).end('{"header":[],"footer":[]}');
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
  assert.equal((await page.context().cookies()).length,0);
  assert.deepEqual(outside,[]); assert.deepEqual(violations,[]);
});
