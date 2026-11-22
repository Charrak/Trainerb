const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canonicalContent, documentHash, hashHex, isoDate, calendarDate } =
  require('../../apps/api/dist/document-seal');
const { renderInvoicePdf, servicePeriod } = require('../../apps/api/dist/invoice-pdf');

/**
 * Die Prüfsumme ist nur so viel wert wie ihre Stabilität. Diese Tests halten
 * beides fest: dass derselbe Beleg immer denselben Hash ergibt (sonst wäre jede
 * Prüfung falsch-positiv) und dass eine relevante Änderung ihn ändert.
 */

const base = {
  kind: 'invoice', number: 'TB-RE-2026-000001', issued_at: new Date('2026-11-15T10:30:00Z'),
  service_date: new Date('2026-11-15T00:00:00Z'), service_end_date: null,
  seller_snapshot: { name: 'Trainer B Akademie GmbH', street: 'Lernweg 12', postal_code: '10115',
    city: 'Berlin', country: 'DE', email: 'rechnung@example.invalid', vat_id: 'DE123456789',
    tax_number: '27/815/08155', bank: { holder: 'Trainer B', iban: 'DE02120300000000202051', bic: null, name: null } },
  buyer_snapshot: { company: 'Musterfirma GmbH', first_name: null, last_name: 'Gast', street: 'Gassenweg 7',
    street_extra: null, postal_code: '10115', city: 'Berlin', region: null, country: 'DE', vat_id: null },
  lines_snapshot: [{ position: 1, title: 'Fitnesstrainer B-Lizenz', variant: null, quantity: 1,
    unit_gross_cents: '24900', discount_cents: '0', total_gross_cents: '24900',
    tax_rate_bp: 1900, tax_label: '19 %', net_cents: '20924', tax_cents: '3976' }],
  total_gross_cents: 24900n, currency: 'EUR', due_at: new Date('2026-11-29T10:30:00Z'),
  payment_reference: 'TB-TB-2026-000001',
};

const decode = buffer => [...buffer].map(byte => ({ 0x80: '€', 0x84: '„', 0x94: '”', 0x96: '–', 0x9f: 'ÿ' }[byte]
  ?? String.fromCharCode(byte))).join('');

test('derselbe Beleg ergibt immer dieselbe Prüfsumme — unabhängig von der Schlüsselreihenfolge', () => {
  const first = documentHash(base, null);
  const reordered = { ...base, seller_snapshot: Object.fromEntries(Object.entries(base.seller_snapshot).reverse()),
    lines_snapshot: base.lines_snapshot.map(line => Object.fromEntries(Object.entries(line).reverse())) };
  assert.deepEqual(Buffer.from(first), Buffer.from(documentHash(reordered, null)));
  assert.equal(Buffer.from(first).length, 32);
  assert.match(hashHex(first), /^[0-9a-f]{64}$/);
});

test('jede inhaltlich relevante Änderung ändert die Prüfsumme', () => {
  const original = Buffer.from(documentHash(base, null));
  const variants = [
    { total_gross_cents: 24901n },
    { number: 'TB-RE-2026-000002' },
    { issued_at: new Date('2026-11-15T10:30:01Z') },
    { service_date: new Date('2026-11-16T00:00:00Z') },
    { currency: 'CHF' },
    { payment_reference: null },
    { buyer_snapshot: { ...base.buyer_snapshot, city: 'Potsdam' } },
    { lines_snapshot: [{ ...base.lines_snapshot[0], tax_cents: '3975' }] },
  ];
  for (const variant of variants) {
    const changed = Buffer.from(documentHash({ ...base, ...variant }, null));
    assert.notDeepEqual(changed, original, `Änderung nicht erkannt: ${JSON.stringify(Object.keys(variant))}`);
  }
});

test('der Vorgänger ist Teil der Formel: Umsortieren bricht die Kette', () => {
  const genesis = documentHash(base, null);
  const second = { ...base, number: 'TB-RE-2026-000002' };
  const withChain = documentHash(second, genesis);
  const withoutChain = documentHash(second, null);
  assert.notDeepEqual(Buffer.from(withChain), Buffer.from(withoutChain));
  // Ein anderer Vorgänger ergibt ein anderes Ergebnis, auch wenn der Beleg gleich ist.
  const otherPrevious = documentHash({ ...base, number: 'TB-RE-2026-000009' }, null);
  assert.notDeepEqual(Buffer.from(documentHash(second, otherPrevious)), Buffer.from(withChain));
});

test('der kanonische Inhalt ist stabil und nennt seine Version', () => {
  const text = canonicalContent(base);
  assert.equal(text, canonicalContent({ ...base }));
  assert.match(text, /"schema":"trainerb\.document\.v1"/);
  // Geld bleibt ein Dezimalstring, damit keine Gleitkommazahl in den Hash gerät.
  assert.match(text, /"total_gross_cents":"24900"/);
  // Der Tag der Leistung wird als Kalendertag geführt, nicht als Zeitstempel.
  assert.match(text, /"service_date":"2026-11-15"/);
});

test('Datumsgrenzen: ein Beleg um Mitternacht gehört zum richtigen Tag in deutscher Zeit', () => {
  assert.equal(isoDate(new Date('2026-12-31T22:59:00Z')), '2026-12-31');
  assert.equal(isoDate(new Date('2026-12-31T23:30:00Z')), '2027-01-01');
  assert.equal(isoDate(null), null);
  assert.equal(calendarDate(new Date('2026-11-15T00:00:00Z')), '2026-11-15');
  assert.equal(calendarDate('2026-11-15'), '2026-11-15');
  assert.equal(servicePeriod(new Date('2026-11-15T00:00:00Z'), null), '15.11.2026');
  assert.equal(servicePeriod(new Date('2026-11-15T00:00:00Z'), new Date('2026-12-14T00:00:00Z')),
    '15.11.2026 – 14.12.2026');
});

test('die Rechnung trägt Steuernummer, Leistungsdatum und die Prüfsumme', () => {
  const hash = Buffer.alloc(32, 7);
  const pdf = renderInvoicePdf({ invoice_number: base.number, issued_at: base.issued_at,
    service_date: base.service_date, service_end_date: null,
    seller_snapshot: base.seller_snapshot, buyer_snapshot: base.buyer_snapshot,
    lines_snapshot: base.lines_snapshot, total_gross_cents: base.total_gross_cents,
    currency: 'EUR', due_at: base.due_at, payment_reference: base.payment_reference,
    recipient_email: null, content_hash: hash, previous_hash: null });
  const text = [...bufferStrings(pdf)].join(' | ');
  assert.match(text, /Steuernummer: 27\/815\/08155/);
  assert.match(text, /USt-IdNr\.: DE123456789/);
  assert.match(text, /Leistungsdatum/);
  assert.match(text, /15\.11\.2026/);
  assert.match(text, /Prüfsumme \(SHA-256\): 07070707070707070707070707070707/);
});

test('Kleinunternehmer: kein Steuersatz-Ausweis, dafür der § 19-Hinweis', () => {
  const render = (smallBusiness) => {
    const pdf = renderInvoicePdf({ invoice_number: base.number, issued_at: base.issued_at,
      service_date: base.service_date, seller_snapshot: { ...base.seller_snapshot, small_business: smallBusiness },
      buyer_snapshot: base.buyer_snapshot, lines_snapshot: base.lines_snapshot,
      total_gross_cents: base.total_gross_cents, currency: 'EUR', due_at: null,
      payment_reference: null, recipient_email: null });
    return [...bufferStrings(pdf)].join(' | ');
  };
  const normal = render(false);
  const small = render(true);
  assert.match(normal, /Umsatzsteuer 19 %/);
  assert.doesNotMatch(normal, /Kleinunternehmerregelung/);
  assert.doesNotMatch(small, /Umsatzsteuer 19 %/);
  assert.match(small, /§ 19 Abs\. 1 UStG/);
  // Der Gesamtbetrag bleibt in beiden Fällen derselbe.
  assert.match(small, /249,00 €/);
});

/** The literal strings a page draws, decoded from WinAnsi. */
function bufferStrings(pdf) {
  const raw = pdf.toString('latin1');
  return [...raw.matchAll(/\(((?:\\.|[^\\()])*)\) Tj/g)]
    .map(match => decode(Buffer.from(match[1].replace(/\\([\\()])/g, '$1'), 'latin1')));
}

test('ein Beleg ohne gespeichertes Leistungsdatum behauptet keines', () => {
  const pdf = renderInvoicePdf({ invoice_number: base.number, issued_at: base.issued_at,
    service_date: null, service_end_date: null, seller_snapshot: base.seller_snapshot,
    buyer_snapshot: base.buyer_snapshot, lines_snapshot: base.lines_snapshot,
    total_gross_cents: base.total_gross_cents, currency: 'EUR', due_at: null,
    payment_reference: null, recipient_email: null });
  assert.match([...bufferStrings(pdf)].join(' | '), /entspricht dem Rechnungsdatum/);
});

// ------------------------------------------------------- Aufbewahrungsfrist --
const { retentionWindow, isRetained, RETENTION_RULE } =
  require('../../apps/api/dist/document-retention');

test('the retention period starts at the end of the calendar year of issue', () => {
  // § 147 Abs. 3 AO: die Frist beginnt mit dem Ende des Kalenderjahres, nicht am
  // Ausstellungstag. Ein Beleg vom 02.01.2026 und einer vom 31.12.2026 sind
  // deshalb am selben Tag entbehrlich — das ist der Punkt, an dem eine
  // Tagesrechnung still falsch wäre.
  assert.deepEqual(retentionWindow('2026-01-02'), { lastDay: '2036-12-31', releaseDay: '2037-01-01', year: 2026 });
  assert.deepEqual(retentionWindow('2026-12-31'), { lastDay: '2036-12-31', releaseDay: '2037-01-01', year: 2026 });
  assert.deepEqual(retentionWindow(new Date('2026-12-31T10:00:00Z')),
    { lastDay: '2036-12-31', releaseDay: '2037-01-01', year: 2026 });
  // 23:30 UTC am 31.12. ist in Berlin schon der 01.01. — derselbe Tag, den auch
  // die Nummernvergabe sieht. Die Frist verschiebt sich deshalb um ein Jahr.
  assert.deepEqual(retentionWindow(new Date('2026-12-31T23:30:00Z')),
    { lastDay: '2037-12-31', releaseDay: '2038-01-01', year: 2027 });
  assert.equal(retentionWindow('2030-06-15').lastDay, '2040-12-31');
  assert.equal(RETENTION_RULE.years, 10);
});

test('the retention window is inclusive on its last day and open afterwards', () => {
  assert.equal(isRetained('2026-11-22', '2036-12-31'), true, 'am letzten Tag gilt die Sperre noch');
  assert.equal(isRetained('2026-11-22', '2037-01-01'), false, 'erst danach entbehrlich');
  assert.equal(isRetained('2026-11-22', '2026-11-23'), true);
  // Eine kürzere Frist ist eine bewusste Konfiguration, keine stille Änderung.
  assert.equal(isRetained('2026-11-22', '2031-01-01', { years: 4, startsAt: 'end_of_calendar_year', basis: 'Test' }), false);
  assert.equal(isRetained('2026-11-22', '2030-12-31', { years: 4, startsAt: 'end_of_calendar_year', basis: 'Test' }), true);
});
