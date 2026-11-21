const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
require('ts-node').register({transpileOnly:true, compilerOptions:{module:'CommonJS',moduleResolution:'Node',jsx:'react-jsx'}});
const { brandMetadata } = require('../../apps/web/lib/brand-metadata.ts');

test('Markenmetadaten: lokale Icons, Vorschau nur mit konfigurierter HTTPS-Origin', () => {
  const base = 'https://akademie.example.invalid';
  for (const bad of [undefined,'http://localhost',base+'/pfad',base+'?token=test']) assert.equal(brandMetadata(bad).openGraph, undefined);
  const { icons, openGraph } = brandMetadata(base);
  const image = openGraph.images[0];
  assert.equal(image.url, base+'/marke/vorschaubild.png'); assert.ok(image.alt);
  const read = url => fs.readFileSync(path.join(__dirname,'../../apps/web/public',url));
  for (const {url,sizes} of [...icons.icon, icons.apple, {url:new URL(image.url).pathname, sizes:`${image.width}x${image.height}`}]) {
    const buf = read(url);
    if (url.endsWith('.ico')) {
      assert.equal(buf.readUInt16LE(2),1);
      const frames = Array.from({length:buf.readUInt16LE(4)},(_,i)=>`${buf[6+16*i]}x${buf[7+16*i]}`);
      assert.deepEqual(frames.sort(),sizes.split(' ').sort());
    } else {
      assert.equal(buf.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
      assert.equal(`${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`,sizes);
    }
  }
});

test('Globaler Fehler ersetzt das Dokument ohne Layout, Router oder interne Fehlermeldung', () => {
  const Page = require('../../apps/web/app/global-error.tsx').default;
  const html = renderToStaticMarkup(createElement(Page, {error:new Error('Interne Testdiagnose')}));
  for (const expected of ['<html lang="de"','<title>Seitenfehler','noindex, nofollow','<main id="inhalt"','<h1>Seite konnte nicht geladen werden',
    'Seite neu laden','href="/"']) assert.ok(html.includes(expected),expected);
  assert.doesNotMatch(html,/Interne Testdiagnose/);
});
