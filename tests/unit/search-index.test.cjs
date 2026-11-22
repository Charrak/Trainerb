const { test } = require('node:test');
const assert = require('node:assert/strict');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS', moduleResolution: 'Node' } });
const { crawlerRules, publishedUrls, indexOrigin } = require('../../apps/web/lib/search-index.ts');
const origin = 'https://akademie.example.invalid';

test('Ohne Live-Build und gültige HTTPS-Origin werden keine URLs oder Listen angefordert', async () => {
  assert.equal(indexOrigin(false, origin), null);
  for (const base of [undefined, '', '/relativ', 'http://localhost', origin+'/konto', origin+'?x', 'https://name@akademie.example.invalid'])
    assert.equal(indexOrigin(true, base), null);
  assert.deepEqual(crawlerRules(null), { rules: { userAgent: '*', disallow: '/' } });
  assert.deepEqual(await publishedUrls(null, assert.fail), []);
});

test('Live-Allowlist und Sitemap verwenden nur die feste Origin und beide paginierten öffentlichen Listen', async () => {
  assert.equal(indexOrigin(true, origin+'/'), origin);
  const {rules,sitemap} = crawlerRules(origin);
  assert.equal(sitemap,origin+'/sitemap.xml'); assert.equal(rules.disallow,'/');
  assert.deepEqual(rules.allow, ['/$', '/seiten$', '/seiten/', '/kurse$', '/kurse/', '/_next/static/', '/sitemap.xml$', '/marke/', '/favicon.ico$']);
  const pages = new Map([['pages',['seite-a','seite-a']],['pages?after=seite-a',['seite-b',null]],
    ['courses?limit=100',['kurs-a','kurs-a']],['courses?limit=100&cursor=kurs-a',['kurs-b',null]]]);
  const urls=await publishedUrls(origin, async path => { const [slug,next_cursor]=pages.get(path); return {data:[{slug}],next_cursor}; });
  assert.deepEqual(urls.map(x=>x.url),['/','/seiten','/kurse','/seiten/seite-a','/seiten/seite-b','/kurse/kurs-a','/kurse/kurs-b'].map(p=>origin+p));
});

test('Fehler, fremde Pfade und nicht fortschreitende Seitenmarken ergeben keine Teilsitemap',async()=>{
  await assert.rejects(publishedUrls(origin,async()=>{throw new Error('nicht verfügbar');}));
  for(const page of [{data:[{slug:'../konto'}],next_cursor:null},{data:[],next_cursor:'weiter'},
    {data:[{slug:'schleife'}],next_cursor:'schleife'}]) await assert.rejects(publishedUrls(origin,async()=>page));
});

test('Auch die Übersichten zählen zur Sitemap-Protokollgrenze', async () => {
  const data = Array.from({ length: 49_999 }, (_, i) => ({ slug: `seite-${i}` }));
  await assert.rejects(publishedUrls(origin, async path => ({ data: path === 'pages' ? data : [], next_cursor: null })));
});
