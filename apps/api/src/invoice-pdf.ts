/**
 * Invoice PDF rendering, without any third-party library.
 *
 * Two rules shape this file:
 *
 *  1. **Only snapshots.** A rendered invoice is a function of `invoices` alone —
 *     seller, buyer and lines as they were frozen at issue time. No product,
 *     price or settings row is read here, so re-rendering next year produces
 *     the same document. That is also why there is no "generated at" stamp:
 *     the issue date is part of the snapshot, the render time is not.
 *  2. **Tax is snapshot data, never recomputed.** The split (rate, net, tax) was
 *     determined at checkout and frozen in `lines_snapshot`; this renderer only
 *     prints it. A document from 2026 must not change because a rate changed in
 *     2027. Positions without a split (older rows, credit notes derived from
 *     them) fall back to a gross-only statement — the renderer never invents a
 *     rate.
 *
 * The output is a PDF 1.4 file with the standard Helvetica fonts and
 * `WinAnsiEncoding`, which covers the German characters (ä ö ü ß € – „ “).
 */

/**
 * What kind of document this is. A credit note (Gutschrift) is the same letter
 * with a different title, extra references and no payment instruction — keeping
 * one renderer means an invoice and its correction can never drift apart.
 */
export type DocumentMeta = {
  kind?: 'invoice' | 'credit_note';
  /** heading on the document; defaults to "Rechnung"/"Gutschrift" */
  title?: string;
  /** extra key facts next to number and date, e.g. the original invoice */
  references?: Array<{ label: string; value: string }>;
  /** a sentence that belongs on the document itself (e.g. refund route) */
  note?: string;
};

export type InvoiceSnapshot = {
  invoice_number: string;
  issued_at: Date;
  seller_snapshot: unknown;
  buyer_snapshot: unknown;
  lines_snapshot: unknown;
  total_gross_cents: bigint;
  currency: string;
  due_at: Date | null;
  payment_reference: string | null;
  recipient_email: string | null;
  document?: DocumentMeta;
};

type Seller = {
  name?: unknown; street?: unknown; postal_code?: unknown; city?: unknown; country?: unknown;
  email?: unknown; vat_id?: unknown; bank?: { holder?: unknown; iban?: unknown; bic?: unknown; name?: unknown };
};
type Buyer = {
  company?: unknown; first_name?: unknown; last_name?: unknown; street?: unknown; street_extra?: unknown;
  postal_code?: unknown; city?: unknown; region?: unknown; country?: unknown; vat_id?: unknown;
};
type Line = { position?: unknown; title?: unknown; variant?: unknown; quantity?: unknown;
  unit_gross_cents?: unknown; discount_cents?: unknown; total_gross_cents?: unknown;
  /** basis points, e.g. 1900 for 19 % — present once the split is stored */
  tax_rate_bp?: unknown; tax_label?: unknown;
  net_cents?: unknown; tax_cents?: unknown };

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 50;
const BODY_SIZE = 10;
const LINE_HEIGHT = 13;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
const RIGHT_COLUMN_X = 340;
const FOOTER_Y = MARGIN - 18;

const clean = (value: unknown, limit = 200): string => {
  if (value === null || value === undefined) return '';
  const raw = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return raw.length > limit ? `${raw.slice(0, limit - 1)}…` : raw;
};

/** Cents to German currency text, e.g. 123456 -> "1.234,56 €". */
export function formatEuroCents(cents: bigint | number, currency = 'EUR'): string {
  const value = typeof cents === 'bigint' ? cents : BigInt(Math.trunc(cents));
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  const grouped = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const symbol = currency === 'EUR' ? '€' : currency;
  return `${negative ? '-' : ''}${grouped},${fraction} ${symbol}`;
}

/** German date without a locale dependency (the process may run in any locale). */
export function formatDate(value: Date | null): string {
  if (!value) return '';
  const day = String(value.getUTCDate()).padStart(2, '0');
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  return `${day}.${month}.${value.getUTCFullYear()}`;
}

/**
 * PDF strings are byte strings and we emit WinAnsiEncoding (Windows-1252). Any
 * character outside that table would silently corrupt the document, so it
 * becomes "?" on purpose instead of being dropped or mangled.
 */
const WIN_ANSI: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87,
  'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
  '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};

function winAnsiBytes(input: string): Buffer {
  const bytes: number[] = [];
  for (const character of input) {
    const code = character.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) bytes.push(code);
    else bytes.push(WIN_ANSI[character] ?? 0x3f);
  }
  return Buffer.from(bytes);
}

/** A literal PDF string: escaped, then encoded as WinAnsi bytes. */
function pdfString(input: string): Buffer {
  return winAnsiBytes(input.replace(/([\\()])/g, '\\$1'));
}

/**
 * Rough Helvetica advance widths. Exactness is not needed — this only decides
 * where a column ends and whether a word must wrap.
 */
function textWidth(input: string, size: number): number {
  let units = 0;
  for (const character of input) {
    if ('ilj.,:;!|()[]\'’'.includes(character)) units += 278;
    else if ('ftrI -'.includes(character)) units += 333;
    else if ('mw'.includes(character)) units += 833;
    else if ('WM'.includes(character)) units += 944;
    else if (/[A-ZÄÖÜ]/.test(character)) units += 667;
    else units += 556;
  }
  return (units / 1000) * size;
}

/** Greedy word wrap; a single oversized word is cut instead of overflowing. */
function wrap(value: string, size: number, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of value.split(' ').filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(candidate, size) <= width) { current = candidate; continue; }
    if (current) lines.push(current);
    if (textWidth(word, size) <= width) { current = word; continue; }
    let rest = word;
    while (textWidth(rest, size) > width) {
      let take = rest.length;
      while (take > 1 && textWidth(rest.slice(0, take), size) > width) take -= 1;
      lines.push(rest.slice(0, take));
      rest = rest.slice(take);
    }
    current = rest;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

type TextCommand = { kind: 'text'; x: number; y: number; size: number; bold: boolean; text: string };
type RuleCommand = { kind: 'rule'; x1: number; x2: number; y: number; thickness: number };
type Command = TextCommand | RuleCommand;
type Page = { commands: Command[] };

/**
 * Cursor layout. Fixed blocks (letterhead, address, key facts) are placed at
 * absolute positions; the flowing part below them uses the cursor and opens a
 * new page when it runs out of room.
 */
class Layout {
  readonly pages: Page[] = [{ commands: [] }];
  y = PAGE_HEIGHT - MARGIN;

  private page(): Page { return this.pages[this.pages.length - 1]; }

  at(x: number, y: number, value: string, options: { size?: number; bold?: boolean; alignRightAt?: number } = {}): void {
    if (!value) return;
    const size = options.size ?? BODY_SIZE;
    const x0 = options.alignRightAt === undefined ? x : options.alignRightAt - textWidth(value, size);
    this.page().commands.push({ kind: 'text', x: x0, y, size, bold: options.bold ?? false, text: value });
  }

  /** Write one flowing line at the cursor and advance. */
  line(value: string, options: { x?: number; size?: number; bold?: boolean; gap?: number;
    alignRightAt?: number; keepWith?: number } = {}): void {
    const height = options.gap ?? LINE_HEIGHT;
    if (this.y - Math.max(height, options.keepWith ?? 0) < MARGIN) {
      this.pages.push({ commands: [] });
      this.y = PAGE_HEIGHT - MARGIN;
    }
    this.at(options.x ?? MARGIN, this.y, value, { size: options.size, bold: options.bold,
      alignRightAt: options.alignRightAt });
    this.y -= height;
  }

  paragraph(value: string, options: { x?: number; width?: number; size?: number } = {}): void {
    const size = options.size ?? BODY_SIZE;
    for (const part of wrap(value, size, options.width ?? CONTENT_WIDTH - ((options.x ?? MARGIN) - MARGIN))) {
      this.line(part, { x: options.x, size });
    }
  }

  rule(gap = 8, thickness = 0.6, y = this.y + 4): void {
    this.page().commands.push({ kind: 'rule', x1: MARGIN, x2: PAGE_WIDTH - MARGIN, y, thickness });
    this.y -= gap;
  }

  space(height: number): void { this.y -= height; }

  /** Make sure `height` fits; a row and its first description line stay together. */
  ensure(height: number): void {
    if (this.y - height >= MARGIN) return;
    this.pages.push({ commands: [] });
    this.y = PAGE_HEIGHT - MARGIN;
  }
}

function sellerLines(seller: Seller): string[] {
  const vatId = clean(seller.vat_id, 30);
  return [
    clean(seller.name, 160),
    clean(seller.street, 160),
    [clean(seller.postal_code, 16), clean(seller.city, 120)].filter(Boolean).join(' '),
    clean(seller.country, 2),
    clean(seller.email, 254),
    vatId ? `USt-IdNr.: ${vatId}` : '',
  ].filter(Boolean);
}

function addressLines(buyer: Buyer): string[] {
  const lines = [clean(buyer.company, 120)];
  const name = [clean(buyer.first_name, 120), clean(buyer.last_name, 120)].filter(Boolean).join(' ');
  if (name) lines.push(name);
  lines.push(clean(buyer.street, 160), clean(buyer.street_extra, 160));
  const country = clean(buyer.country, 2);
  const city = [clean(buyer.postal_code, 16), clean(buyer.city, 120)].filter(Boolean).join(' ');
  // A destination outside Germany must name the country on the invoice.
  if (city) lines.push(country && country !== 'DE' ? `${country}-${city}` : city);
  else if (country && country !== 'DE') lines.push(country);
  const vatId = clean(buyer.vat_id, 30);
  if (vatId) lines.push(`USt-IdNr.: ${vatId}`);
  return lines.filter(Boolean);
}

function bankLines(seller: Seller): string[] {
  const bank = seller.bank ?? {};
  return [
    clean(bank.holder, 120) ? `Kontoinhaber: ${clean(bank.holder, 120)}` : '',
    clean(bank.iban, 40) ? `IBAN: ${clean(bank.iban, 40)}` : '',
    clean(bank.bic, 20) ? `BIC: ${clean(bank.bic, 20)}` : '',
    clean(bank.name, 80) ? `Bank: ${clean(bank.name, 80)}` : '',
  ].filter(Boolean);
}

const columnX = { title: MARGIN, description: MARGIN + 34, quantity: 330, unit: 405, total: PAGE_WIDTH - MARGIN };

function writeLetterhead(layout: Layout, seller: Seller, title: string): void {
  let y = PAGE_HEIGHT - MARGIN;
  layout.at(RIGHT_COLUMN_X, y - 10, title, { size: 20, bold: true });
  for (const line of sellerLines(seller)) {
    layout.at(RIGHT_COLUMN_X, y, line, { size: 9 });
    y -= 11;
  }
}

function writeFacts(layout: Layout, invoice: InvoiceSnapshot, top: number): number {
  const creditNote = invoice.document?.kind === 'credit_note';
  const rows: Array<[string, string]> = [
    [creditNote ? 'Gutschriftnummer' : 'Rechnungsnummer', clean(invoice.invoice_number, 60)],
    [creditNote ? 'Gutschriftdatum' : 'Rechnungsdatum', formatDate(invoice.issued_at)],
    ...(invoice.document?.references ?? []).map(reference => [clean(reference.label, 60), clean(reference.value, 60)] as [string, string]),
    ['Zahlungsreferenz', clean(invoice.payment_reference, 60)],
    ['Fällig am', formatDate(invoice.due_at)],
  ];
  let y = top;
  for (const [label, value] of rows.filter(row => row[1])) {
    layout.at(RIGHT_COLUMN_X, y, label, { size: 9 });
    layout.at(RIGHT_COLUMN_X + 92, y, value, { size: 9, bold: true });
    y -= 12;
  }
  return y;
}

function writeLineTable(layout: Layout, lines: Line[], currency: string): void {
  const headerY = layout.y;
  layout.at(columnX.title, headerY, 'Pos.', { size: 9, bold: true });
  layout.at(columnX.description, headerY, 'Bezeichnung', { size: 9, bold: true });
  layout.at(columnX.quantity, headerY, 'Menge', { size: 9, bold: true });
  layout.at(columnX.unit, headerY, 'Einzelpreis', { size: 9, bold: true });
  layout.at(columnX.total, headerY, 'Gesamt', { size: 9, bold: true, alignRightAt: columnX.total });
  layout.y -= 6;
  layout.rule(10, 0.6);

  for (const line of lines) {
    const title = clean(line.title, 120) || 'Position';
    const variant = clean(line.variant, 120);
    const description = variant ? `${title} – ${variant}` : title;
    const quantity = Number(line.quantity ?? 1);
    const unit = formatEuroCents(BigInt(String(line.unit_gross_cents ?? '0')), currency);
    const total = formatEuroCents(BigInt(String(line.total_gross_cents ?? '0')), currency);
    const discountCents = BigInt(String(line.discount_cents ?? '0'));

    // The numbers must never end up alone at the bottom of a page.
    layout.ensure(LINE_HEIGHT * 2 + 5);
    const rowY = layout.y;
    layout.at(columnX.title, rowY, String(Number(line.position ?? 0)), { size: BODY_SIZE });
    layout.at(columnX.quantity, rowY, String(quantity), { size: BODY_SIZE });
    layout.at(columnX.unit, rowY, unit, { size: BODY_SIZE });
    layout.at(columnX.total, rowY, total, { size: BODY_SIZE, alignRightAt: columnX.total });
    layout.y -= LINE_HEIGHT;
    for (const part of wrap(description, BODY_SIZE, columnX.quantity - columnX.description - 20)) {
      layout.line(part, { x: columnX.description });
    }
    if (discountCents > 0n) {
      layout.line(`Rabatt: -${formatEuroCents(discountCents, currency)}`, { x: columnX.description, size: 9 });
    }
    layout.space(5);
  }
}

type TaxGroup = { rate_bp: number; label: string; net: bigint; tax: bigint; gross: bigint };

/** The tax block of a document: one line per rate, never a blended average. */
function taxGroups(lines: Line[]): TaxGroup[] {
  const groups = new Map<string, TaxGroup>();
  for (const line of lines) {
    const rate = Number(line.tax_rate_bp);
    if (!Number.isFinite(rate)) continue;
    const key = `${rate}:${String(line.tax_label ?? '')}`;
    const group = groups.get(key) ?? { rate_bp: rate, label: String(line.tax_label ?? `${rate / 100} %`),
      net: 0n, tax: 0n, gross: 0n };
    group.net += BigInt(String(line.net_cents ?? '0'));
    group.tax += BigInt(String(line.tax_cents ?? '0'));
    group.gross += BigInt(String(line.total_gross_cents ?? '0'));
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => right.rate_bp - left.rate_bp);
}

function writeTotals(layout: Layout, invoice: InvoiceSnapshot, currency: string): void {
  layout.rule(14, 0.9);
  const lines = Array.isArray(invoice.lines_snapshot) ? invoice.lines_snapshot as Line[] : [];
  const groups = taxGroups(lines);
  if (groups.length) {
    // Net, tax and gross per rate — the three numbers a German invoice needs.
    for (const group of groups) {
      layout.line(`Nettobetrag (${group.label})`, { size: 9, alignRightAt: columnX.total - 110 });
      layout.at(columnX.total, layout.y, formatEuroCents(group.net, currency),
        { size: 9, alignRightAt: columnX.total });
      layout.y -= LINE_HEIGHT;
      layout.line(`Umsatzsteuer ${group.label}`, { size: 9, alignRightAt: columnX.total - 110 });
      layout.at(columnX.total, layout.y, formatEuroCents(group.tax, currency),
        { size: 9, alignRightAt: columnX.total });
      layout.y -= LINE_HEIGHT;
    }
    layout.space(4);
  }
  const label = invoice.document?.kind === 'credit_note' ? 'Gutschriftbetrag (brutto)' : 'Gesamtbetrag (brutto)';
  layout.line(`${label}: ${formatEuroCents(invoice.total_gross_cents, currency)}`,
    { size: 12, bold: true, gap: 22, alignRightAt: columnX.total });
}

function writePaymentNotice(layout: Layout, invoice: InvoiceSnapshot, seller: Seller): void {
  const creditNote = invoice.document?.kind === 'credit_note';
  const bank = creditNote ? [] : bankLines(seller);
  if (creditNote) {
    layout.line('Erstattung', { size: BODY_SIZE, bold: true });
    layout.paragraph('Der Betrag wurde bzw. wird auf dem ursprünglichen Zahlungsweg zurückgezahlt. ' +
      'Diese Gutschrift ist kein neuer Zahlungsanspruch.', { size: 9 });
    if (invoice.document?.note) layout.paragraph(clean(invoice.document.note, 500), { size: 9 });
    layout.space(6);
  }
  if (bank.length) {
    layout.line('Zahlung per Überweisung', { size: BODY_SIZE, bold: true });
    for (const line of bank) layout.line(line, { size: 9 });
    if (invoice.payment_reference) layout.line(`Verwendungszweck: ${clean(invoice.payment_reference, 60)}`, { size: 9 });
    if (invoice.due_at) layout.line(`Bitte überweisen Sie den Betrag bis ${formatDate(invoice.due_at)}.`, { size: 9 });
    layout.space(6);
  }
  // The notice must describe what the document actually shows. With a stored
  // split it names the rate; without one it says so instead of implying zero.
  const lines = Array.isArray(invoice.lines_snapshot) ? invoice.lines_snapshot as Line[] : [];
  const groups = taxGroups(lines);
  const notice = groups.length
    ? 'Alle Beträge sind Bruttobeträge. Die Umsatzsteuer ist je Steuersatz ausgewiesen und im Gesamtbetrag enthalten.'
    : 'Alle Beträge sind Bruttobeträge. Für diese Positionen ist kein Steuersatz hinterlegt; eine Aufteilung ' +
      'erfolgt daher nicht.';
  layout.paragraph(notice, { size: 8 });
  if (clean(invoice.recipient_email, 254)) {
    layout.line(`Rechnung bereitgestellt an ${clean(invoice.recipient_email, 254)}.`, { size: 8 });
  }
}

/** Footer on every page: seller, invoice number, page number. */
function writeFooters(layout: Layout, seller: Seller, invoiceNumber: string): void {
  const total = layout.pages.length;
  for (const [index, page] of layout.pages.entries()) {
    page.commands.push({ kind: 'rule', x1: MARGIN, x2: PAGE_WIDTH - MARGIN, y: FOOTER_Y + 12, thickness: 0.4 });
    const label = `${clean(seller.name, 80)} · ${clean(invoiceNumber, 60)} · Seite ${index + 1} von ${total}`;
    page.commands.push({ kind: 'text', x: MARGIN, y: FOOTER_Y, size: 8, bold: false, text: label });
  }
}

/** Serialise the commands of one page into a PDF content stream. */
function contentStream(page: Page): Buffer {
  const ops: Buffer[] = [];
  for (const command of page.commands) {
    if (command.kind === 'rule') {
      ops.push(Buffer.from(`${command.thickness} w ${command.x1.toFixed(2)} ${command.y.toFixed(2)} m ` +
        `${command.x2.toFixed(2)} ${command.y.toFixed(2)} l S\n`, 'latin1'));
      continue;
    }
    ops.push(Buffer.concat([
      Buffer.from(`BT /${command.bold ? 'F2' : 'F1'} ${command.size} Tf 1 0 0 1 ${command.x.toFixed(2)} ` +
        `${command.y.toFixed(2)} Tm (`, 'latin1'),
      pdfString(command.text),
      Buffer.from(') Tj ET\n', 'latin1'),
    ]));
  }
  return Buffer.concat(ops);
}

/** Assemble a complete PDF file from the laid-out pages. */
function assemble(pages: Page[]): Buffer {
  const objects: Buffer[] = [];
  const add = (body: Buffer): number => { objects.push(body); return objects.length; };

  const catalogId = add(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'));
  const pagesId = add(Buffer.alloc(0)); // placeholder, filled once the page ids are known
  const regularFontId = add(Buffer.from(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'latin1'));
  const boldFontId = add(Buffer.from(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>', 'latin1'));

  const pageIds: number[] = [];
  for (const page of pages) {
    const content = contentStream(page);
    const contentId = add(Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'latin1'), content, Buffer.from('endstream', 'latin1'),
    ]));
    pageIds.push(add(Buffer.from(`<< /Type /Page /Parent ${pagesId} 0 R ` +
      `/MediaBox [0 0 ${PAGE_WIDTH.toFixed(2)} ${PAGE_HEIGHT.toFixed(2)}] ` +
      `/Resources << /Font << /F1 ${regularFontId} 0 R /F2 ${boldFontId} 0 R >> >> ` +
      `/Contents ${contentId} 0 R >>`, 'latin1')));
  }
  objects[pagesId - 1] = Buffer.from(`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds
    .map(id => `${id} 0 R`).join(' ')}] >>`, 'latin1');

  const header = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const chunks: Buffer[] = [header];
  const offsets: number[] = [];
  let offset = header.length;
  for (const [index, body] of objects.entries()) {
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    offsets.push(offset);
    chunks.push(object);
    offset += object.length;
  }
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, 'latin1'));
  for (const value of offsets) chunks.push(Buffer.from(`${String(value).padStart(10, '0')} 00000 n \n`, 'latin1'));
  chunks.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n` +
    `startxref\n${offset}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

/**
 * Build the invoice document. Deterministic: the same snapshot yields the same
 * bytes, which makes "an issued document never changes" testable.
 */
export function renderInvoicePdf(invoice: InvoiceSnapshot): Buffer {
  const seller = (invoice.seller_snapshot ?? {}) as Seller;
  const buyer = (invoice.buyer_snapshot ?? {}) as Buyer;
  const lines = Array.isArray(invoice.lines_snapshot) ? invoice.lines_snapshot as Line[] : [];
  const currency = invoice.currency || 'EUR';
  const layout = new Layout();
  const title = clean(invoice.document?.title ?? (invoice.document?.kind === 'credit_note' ? 'Gutschrift' : 'Rechnung'), 40) ||
    'Rechnung';

  writeLetterhead(layout, seller, title);

  // Address block (top left) and key facts (top right) share the upper area.
  const blockTop = PAGE_HEIGHT - MARGIN - 46;
  let addressY = blockTop;
  for (const line of addressLines(buyer)) {
    layout.at(MARGIN, addressY, line, { size: BODY_SIZE });
    addressY -= LINE_HEIGHT;
  }
  const factsBottom = writeFacts(layout, invoice, blockTop);

  layout.y = Math.min(addressY, factsBottom) - 24;
  layout.rule(16, 1);
  writeLineTable(layout, lines, currency);
  writeTotals(layout, invoice, currency);
  writePaymentNotice(layout, invoice, seller);
  writeFooters(layout, seller, invoice.invoice_number);

  return assemble(layout.pages);
}

/** File name for the download; the number is already server-generated. */
export function invoiceFileName(invoiceNumber: string): string {
  return `Rechnung-${invoiceNumber.replace(/[^A-Za-z0-9-]/g, '')}.pdf`;
}

/** File name for a credit note; never mistakable for an invoice download. */
export function creditNoteFileName(documentNumber: string): string {
  return `Gutschrift-${documentNumber.replace(/[^A-Za-z0-9-]/g, '')}.pdf`;
}
