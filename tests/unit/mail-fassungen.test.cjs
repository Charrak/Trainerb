const { test } = require('node:test');
const assert = require('node:assert/strict');

require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'CommonJS', moduleResolution: 'Node', esModuleInterop: true, target: 'ES2022' },
});
const { renderMailParts, escapeHtml, linkValues } = require('../../apps/api/src/mail-fassung.ts');
const { templates } = require('../../apps/api/src/mail-catalog.ts');

const samples = {
  first_name: 'Mila', course_title: 'Fitnesstrainer B-Lizenz', ends_at: '01.12.2026',
  activation_url: 'https://academy.test/konto/aktivieren#token=abc', reset_url: 'https://academy.test/konto/passwort-zuruecksetzen#token=abc',
  email_change_url: 'https://academy.test/konto/email-bestaetigen#token=abc',
  order_number: 'TB-2026-0001', total: '1.900,00', payment_reference: 'TB-2026-0001',
  credit_note_number: 'TB-GS-2026-0001', received_date: '17.11.2026', received_time: '12:00',
  decision: 'angenommen', verification_url: 'https://academy.test/widerruf/bestaetigen#token=abc',
  request_reference: 'ab12cd34', verify_url: 'https://academy.test/kasse/bestaetigen#token=abc', code: '123456',
  amount: '1.900,00', reason: 'fraudulent', status: 'warning', topic: 'Kurse', wording: 'Ich möchte den Newsletter.',
  confirm_url: 'https://academy.test/newsletter/bestaetigen#token=abc', subject: 'Neues aus der Akademie',
  body: 'Kurzer Text.\n\nZweiter Absatz.', leave_url: 'https://academy.test/newsletter/abmelden#token=abc',
};

test('jede eingebaute Vorlage rendert beide Fassungen ohne Restplatzhalter', () => {
  for (const [key, content] of Object.entries(templates)) {
    const parts = renderMailParts(content.subject, content.text, samples);
    assert.equal(typeof parts.html, 'string');
    assert.ok(parts.html.startsWith('<!doctype html>'), key);
    assert.doesNotMatch(parts.html, /\{\{|\}\}/, key);
    assert.equal(parts.text.includes('{{'), false, key);
    assert.ok(parts.subject.length > 0 && !/[\r\n]/.test(parts.subject), key);
    // Der Textteil bleibt unverändert; er enthält keinen Rahmen und kein Markup.
    assert.doesNotMatch(parts.text, /<(?:p|div|a|h1)\b/, key);
    assert.doesNotMatch(parts.html, /<script|<img|@import|url\(/i, key);
  }
});

test('Platzhalter werden escaped und nur echte Webadressen verlinkt', () => {
  const parts = renderMailParts('Hallo {{first_name}}', 'Text {{first_name}}.\n\n{{activation_url}}', {
    first_name: '<b>Mila</b> & Co', activation_url: 'https://academy.test/konto/aktivieren#token=abc',
  });
  assert.match(parts.text, /<b>Mila<\/b> & Co/);
  assert.match(parts.html, /&lt;b&gt;Mila&lt;\/b&gt; &amp; Co/);
  assert.match(parts.html, /<a href="https:\/\/academy\.test\/konto\/aktivieren#token=abc" rel="noopener noreferrer">/);
  assert.equal((parts.html.match(/<a /g) || []).length, 1);
});

test('keine Verlinkung von Werten, die keine Webadresse sind', () => {
  assert.deepEqual([...linkValues('{{channel_url}}', { channel_url: 'javascript:alert(1)' })], []);
  assert.deepEqual([...linkValues('{{ activation_url }}', { activation_url: 'javascript:alert(1)' })], []);
  const parts = renderMailParts('Betreff', '{{activation_url}}', { activation_url: 'javascript:alert(1)' });
  assert.doesNotMatch(parts.html, /<a /);
  assert.match(parts.html, /javascript:alert\(1\)/);
  assert.deepEqual([...linkValues('{{activation_url}}', { activation_url: 'ftp://academy.test/x' })], []);
});

test('Unbekannte Platzhalter und freie Klammern werden abgelehnt', () => {
  assert.throws(() => renderMailParts('Betreff', 'Hallo {{unbekannt}}', {}), /Unknown template variable/);
  assert.throws(() => renderMailParts('Betreff', 'Hallo {name}', { name: 'Mila' }), /Invalid template/);
  assert.throws(() => renderMailParts('Betreff {{first_name}}', 'Text', { first_name: 'a\nb' }), /Invalid subject/);
});

test('escapeHtml deckt alle HTML-Sonderzeichen ab', () => {
  assert.equal(escapeHtml(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;');
});

test('Absätze bleiben erhalten, Leerzeilen erzeugen keine leeren Links', () => {
  const parts = renderMailParts('Betreff', 'Erster Absatz.\n\nhttps://academy.test/x#token=abc\n\nLetzter.', {
    channel_url: 'https://academy.test/x#token=abc',
  });
  const body = parts.html.slice(parts.html.indexOf('<h1>'), parts.html.indexOf('<div class="fuss">'));
  assert.equal((body.match(/<p>/g) || []).length, 3);
  assert.doesNotMatch(parts.html, /<p><\/p>/);
});
