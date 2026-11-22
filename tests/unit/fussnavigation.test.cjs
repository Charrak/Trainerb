const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
require('ts-node').register({transpileOnly:true,compilerOptions:{module:'CommonJS',moduleResolution:'Node',jsx:'react-jsx',esModuleInterop:true}});
const { Footer } = require('../../apps/web/components/site.tsx');

test('Feste Fußnavigation bleibt ohne CMS-Daten identisch; nur Nicht-Live zeigt den Testhinweis', () => {
  const render = live => renderToStaticMarkup(createElement(Footer,{live}));
  const live = render(true), staging = render(false);
  assert.doesNotMatch(live,/Testdaten|Testbetrieb|Entwicklungsversion/);
  assert.match(staging,/Nur Testdaten verwenden\. Zahlungen im Testbetrieb\./);
  const links = html => [...html.matchAll(/<a\b[^>]* href="([^"]+)"/g)].map(match => match[1]);
  const expected=['/','/kurse','/buchen','/seiten','/newsletter','/impressum','/datenschutz','/agb','/widerrufsbelehrung',
    '/widerruf','/zahlungsinformationen','/cookie-einstellungen','/datenrechte','/konto','/anmelden','/registrieren'];
  assert.deepEqual(links(live),expected); assert.deepEqual(links(staging),expected);
});
