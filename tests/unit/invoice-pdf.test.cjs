const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderInvoicePdf, formatEuroCents, formatDate, invoiceFileName } =
  require('../../apps/api/dist/invoice-pdf');

const seller = {
  name: 'Trainer B Akademie GmbH', street: 'Lernweg 12', postal_code: '10115', city: 'Berlin',
  country: 'DE', email: 'rechnung@example.invalid', vat_id: 'DE123456789',
  bank: { holder: 'Trainer B Akademie GmbH', iban: 'DE02120300000000202051', bic: 'BYLADEM1001', name: 'Testbank' },
};
const buyer = { company: 'Musterfirma GmbH', first_name: 'Gina', last_name: 'Gast', street: 'Gassenweg 7',
  street_extra: null, postal_code: '10115', city: 'Berlin', region: null, country: 'DE', vat_id: null };

const invoice = (overrides = {}) => ({
  invoice_number: 'TB-RE-2026-000042', issued_at: new Date('2026-11-15T10:30:00Z'),
  seller_snapshot: seller, buyer_snapshot: buyer,
  lines_snapshot: [
    { position: 1, title: 'Fitnesstrainer B-Lizenz', variant: null, quantity: 1,
      unit_gross_cents: '24900', discount_cents: '0', total_gross_cents: '24900', tax_category: 'standard' },
    { position: 2, title: 'Ernährungsberater Basics', variant: 'Kompakt', quantity: 1,
      unit_gross_cents: '19900', discount_cents: '1990', total_gross_cents: '17910', tax_category: 'standard' },
  ],
  total_gross_cents: 42810n, currency: 'EUR', due_at: new Date('2026-11-29T10:30:00Z'),
  payment_reference: 'TB-TB-2026-000042', recipient_email: 'gina@example.invalid', ...overrides,
});

/** The bytes 0x80-0x9F that WinAnsi gives a printable meaning, for decoding. */
const WIN_ANSI_HIGH = { 0x80: '€', 0x82: '‚', 0x84: '„', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“',
  0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x99: '™' };

/** Decode a WinAnsi byte string the way a PDF viewer would. */
const decode = buffer => [...buffer].map(byte => WIN_ANSI_HIGH[byte] ?? String.fromCharCode(byte)).join('');

/** Extract the literal strings a page draws (the `(...) Tj` operands). */
function drawnText(pdf) {
  const raw = pdf.toString('latin1');
  const strings = [...raw.matchAll(/\(((?:\\.|[^\\()])*)\) Tj/g)].map(match => match[1]);
  return strings.map(value => Buffer.from(value.replace(/\\([\\()])/g, '$1'), 'latin1'));
}

function pages(pdf) {
  return [...pdf.toString('latin1').matchAll(/\/Type \/Page[^s]/g)].length;
}

test('money and dates are formatted for a German invoice without a locale dependency', () => {
  assert.equal(formatEuroCents(0n), '0,00 €');
  assert.equal(formatEuroCents(5n), '0,05 €');
  assert.equal(formatEuroCents(24900n), '249,00 €');
  assert.equal(formatEuroCents(123456789n), '1.234.567,89 €');
  assert.equal(formatEuroCents(-1990n), '-19,90 €');
  assert.equal(formatEuroCents(1200n, 'CHF'), '12,00 CHF');
  assert.equal(formatDate(new Date('2026-11-15T23:59:59Z')), '15.11.2026');
  assert.equal(formatDate(null), '');
  assert.equal(invoiceFileName('TB-RE-2026-000042'), 'Rechnung-TB-RE-2026-000042.pdf');
  // A manipulated or odd number can never escape the file name.
  assert.equal(invoiceFileName('TB-RE/2026 ../../x'), 'Rechnung-TB-RE2026x.pdf');
});

test('the document is a valid PDF with an xref table, fonts and page objects', () => {
  const pdf = renderInvoicePdf(invoice());
  const raw = pdf.toString('latin1');
  assert.ok(raw.startsWith('%PDF-1.4'));
  assert.ok(raw.trimEnd().endsWith('%%EOF'));
  assert.match(raw, /\/Type \/Catalog/);
  assert.match(raw, /\/BaseFont \/Helvetica\b/);
  assert.match(raw, /\/BaseFont \/Helvetica-Bold\b/);
  assert.match(raw, /\/Encoding \/WinAnsiEncoding/);
  assert.equal(pages(pdf), 1);

  // Offsets in the xref table must point at the matching object headers.
  const startxref = Number(/startxref\s+(\d+)/.exec(raw)[1]);
  assert.equal(raw.slice(startxref, startxref + 4), 'xref');
  const count = Number(/xref\s+0 (\d+)/.exec(raw)[1]);
  // Entry 0 is the free-list head; entries 1..n must point at their objects.
  const entries = raw.slice(startxref).split('\n').slice(3, 1 + count);
  for (const [index, entry] of entries.entries()) {
    const offset = Number(entry.slice(0, 10));
    assert.equal(raw.slice(offset, offset + `${index + 1} 0 obj`.length), `${index + 1} 0 obj`,
      `xref entry ${index + 1} must point at its object`);
  }
});

test('every drawn string is WinAnsi-encoded and carries the German characters', () => {
  const pdf = renderInvoicePdf(invoice());
  const strings = drawnText(pdf);
  const joined = decode(Buffer.concat(strings));
  assert.ok(joined.includes('Rechnung'));
  assert.ok(joined.includes('TB-RE-2026-000042'));
  // Euro sign is 0x80 in WinAnsi, umlauts stay single bytes (ä = 0xE4).
  assert.ok(Buffer.concat(strings).includes(Buffer.from([0x80])), 'euro sign is encoded as 0x80');
  assert.ok(Buffer.concat(strings).includes(Buffer.from([0xe4])), 'ä is encoded as 0xE4');
  assert.ok(joined.includes('Gesamtbetrag (brutto): 428,10 €'));
  assert.ok(joined.includes('Ernährungsberater Basics – Kompakt'));
  assert.ok(joined.includes('Rabatt: -19,90 €'));
  // No network, no file system, no embedded asset: pure text and rules.
  assert.equal(/\/Subtype \/Image/.test(pdf.toString('latin1')), false);
  assert.equal(/\/(JavaScript|Launch|EmbeddedFile|URI)/.test(pdf.toString('latin1')), false);
});

test('characters outside WinAnsi never corrupt the document', () => {
  const pdf = renderInvoicePdf(invoice({ buyer_snapshot: { ...buyer, first_name: 'Gina 😀', last_name: 'Ǆ Gast' } }));
  const strings = drawnText(pdf);
  for (const value of strings) for (const byte of value) assert.ok(byte <= 0xff);
  assert.ok(decode(Buffer.concat(strings)).includes('Gina ? ? Gast'));
  // A NUL or newline in a snapshot cannot break out of the PDF string literal.
  const hostile = renderInvoicePdf(invoice({ buyer_snapshot: { ...buyer, company: 'A) Tj ET 1 0 0 1 0 0 Tm\nB' } }));
  assert.equal(pages(hostile), 1);
  assert.ok(decode(Buffer.concat(drawnText(hostile))).includes('A) Tj ET 1 0 0 1 0 0 Tm B'));
});

test('the same snapshot always renders the same bytes; nothing outside it is read', () => {
  const first = renderInvoicePdf(invoice());
  const second = renderInvoicePdf(invoice());
  assert.deepEqual(first, second);
  // The renderer is a pure function: it works without a database, clock or config.
  const other = renderInvoicePdf(invoice({ invoice_number: 'TB-RE-2026-000043' }));
  assert.notDeepEqual(first, other);
});

test('long content flows onto further pages and keeps the totals intact', () => {
  const many = Array.from({ length: 60 }, (_, index) => ({ position: index + 1,
    title: `Kursmodul ${index + 1} mit einer längeren Bezeichnung für den Zeilenumbruch`,
    variant: null, quantity: 1, unit_gross_cents: '1000', discount_cents: '0', total_gross_cents: '1000',
    tax_category: 'standard' }));
  const pdf = renderInvoicePdf(invoice({ lines_snapshot: many, total_gross_cents: 60000n }));
  assert.ok(pages(pdf) > 1, 'the table must paginate');
  const joined = decode(Buffer.concat(drawnText(pdf)));
  assert.ok(joined.includes('Seite 1 von '));
  assert.ok(joined.includes('Kursmodul 60'));
  assert.ok(joined.includes('Gesamtbetrag (brutto): 600,00 €'));
  // Every page carries the invoice number in its footer, so a stray page is traceable.
  const footers = [...joined.matchAll(/Seite \d+ von \d+/g)].length;
  assert.equal(footers, pages(pdf));
});

test('a minimal snapshot renders without inventing data', () => {
  const pdf = renderInvoicePdf({ invoice_number: 'TB-RE-2026-000001', issued_at: new Date('2026-01-02T00:00:00Z'),
    seller_snapshot: null, buyer_snapshot: null, lines_snapshot: null, total_gross_cents: 0n, currency: 'EUR',
    due_at: null, payment_reference: null, recipient_email: null });
  const joined = decode(Buffer.concat(drawnText(pdf)));
  assert.ok(joined.includes('TB-RE-2026-000001'));
  assert.ok(joined.includes('02.01.2026'));
  assert.ok(joined.includes('0,00 €'));
  // No tax rate, no net amount, no invented seller or bank data.
  assert.equal(/USt|MwSt|\b19\s*%|\b7\s*%|Netto/i.test(joined), false);
});
