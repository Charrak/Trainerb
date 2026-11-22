import type { Database } from './database';
import { apiError } from './security';
import { calendarDate, documentHash, hashHex, type SealedDocument } from './document-seal';
import { renderInvoicePdf, servicePeriod } from './invoice-pdf';
import { getConfig } from './config';
import { retentionWindow } from './document-retention';

/**
 * Belegausgabe für die Buchhaltung: Liste, Sammel-PDF und Kettenprüfung.
 *
 * Die drei Ausgaben beantworten drei verschiedene Fragen:
 *
 *  - **Liste (CSV)** — „was liegt in dem Zeitraum?“ Eine Zeile je Beleg mit den
 *    Pflichtangaben, den Steuerbeträgen je Satz und der Prüfsumme. Das ist die
 *    Datei, die in eine Buchhaltung importiert oder an eine Steuerberatung
 *    gegeben wird.
 *  - **Sammel-PDF** — „wie sehen die Belege aus?“ Genau die Dokumente, die
 *    einzeln herunterladbar sind, in einer Datei, damit eine Prüfung nicht
 *    hunderte Downloads braucht.
 *  - **Kettenprüfung** — „sind die Belege noch die, die ausgestellt wurden?“
 *    Rechnet jede Prüfsumme nach und prüft die Verkettung.
 *
 * Was hier ausdrücklich **nicht** passiert: keine Buchung, keine Kontierung,
 * keine Umsatzsteuer-Voranmeldung und kein Urteil über die steuerliche
 * Behandlung. Die Ausgabe ist eine Arbeitsgrundlage und sagt das selbst.
 */

export type DocumentPeriod = {
  /** Beginn, inklusive. Ohne Angabe: seit Aufzeichnungsbeginn. */
  from?: Date;
  /** Ende, exklusiv. Ohne Angabe: bis jetzt. */
  to?: Date;
};

type Row = {
  kind: 'Rechnung' | 'Gutschrift';
  number: string;
  issued_at: Date;
  service_date: string | null;
  service_end_date: string | null;
  order_number: string | null;
  buyer_name: string;
  buyer_city: string;
  buyer_country: string;
  buyer_vat_id: string;
  net_cents: bigint;
  tax_cents: bigint;
  gross_cents: bigint;
  currency: string;
  tax_rates: string;
  payment_state: string | null;
  content_hash: string | null;
  previous_hash: string | null;
  original_number: string | null;
};

export type DocumentList = {
  period: { from: string | null; to: string };
  counts: { invoices: number; credit_notes: number };
  rows: Array<Omit<Row, 'net_cents' | 'tax_cents' | 'gross_cents'> & {
    net_cents: string; tax_cents: string; gross_cents: string }>;
  totals: { net_cents: string; tax_cents: string; gross_cents: string;
    credit_net_cents: string; credit_tax_cents: string; credit_gross_cents: string };
  retention_note: string;
  retention: { years: number; basis: string; earliest_release: string | null;
    latest_release: string | null; documents: number };
  note: string;
};

/** Pflichtangaben aus dem Snapshot, ohne eine zweite Wahrheit zu erfinden. */
const snapshotText = (snapshot: unknown, keys: string[]): string => {
  const source = (snapshot ?? {}) as Record<string, unknown>;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};

const buyerName = (snapshot: unknown): string => {
  const source = (snapshot ?? {}) as Record<string, unknown>;
  const company = snapshotText(source, ['company']);
  const name = [snapshotText(source, ['first_name']), snapshotText(source, ['last_name'])]
    .filter(Boolean).join(' ');
  return company || name;
};

/** Summen je Steuersatz als lesbarer Text, z. B. „19 %: 119,00 / 19,00“. */
function taxRateSummary(lines: unknown): string {
  if (!Array.isArray(lines)) return '';
  const groups = new Map<string, { net: bigint; tax: bigint }>();
  for (const line of lines as Array<Record<string, unknown>>) {
    const rate = Number(line.tax_rate_bp);
    if (!Number.isFinite(rate)) continue;
    const label = typeof line.tax_label === 'string' && line.tax_label ? line.tax_label : `${rate / 100} %`;
    const group = groups.get(label) ?? { net: 0n, tax: 0n };
    group.net += BigInt(String(line.net_cents ?? '0'));
    group.tax += BigInt(String(line.tax_cents ?? '0'));
    groups.set(label, group);
  }
  return [...groups.entries()].map(([label, group]) =>
    `${label}=${(Number(group.net) / 100).toFixed(2)}/${(Number(group.tax) / 100).toFixed(2)}`).join(' ');
}

const centsToNumber = (lines: unknown, key: 'net_cents' | 'tax_cents' | 'total_gross_cents'): bigint => {
  if (!Array.isArray(lines)) return 0n;
  return (lines as Array<Record<string, unknown>>)
    .reduce((sum, line) => sum + BigInt(String(line[key] ?? '0')), 0n);
};

/**
 * Alle Belege eines Zeitraums, Rechnungen und Gutschriften zusammen.
 *
 * Sortiert wird nach Art, Jahr und laufender Nummer — also so, wie die Kette
 * verläuft. `issued_at` wäre die falsche Sortierung: nach einer Korrektur in
 * einem späteren Jahr stünde die Gutschrift sonst zwischen den Rechnungen des
 * alten Jahres.
 */
export async function listDocuments(db: Database, period: DocumentPeriod): Promise<DocumentList> {
  const to = period.to ?? new Date();
  const from = period.from ?? null;
  if (from && from > to) throw apiError(422, 'INVALID_PERIOD', 'Der Zeitraum ist verdreht.');
  const rows = await db.$queryRaw<Array<{
    kind: string; number: string; issued_at: Date; service_date: Date | string | null;
    service_end_date: Date | string | null; order_number: string | null;
    buyer_snapshot: unknown; lines_snapshot: unknown; total_gross_cents: bigint; currency: string;
    payment_state: string | null; content_hash: Uint8Array | null; previous_hash: Uint8Array | null;
    original_number: string | null;
  }>>`
    WITH documents AS (
      SELECT 'invoice'::text AS kind, i.invoice_number AS number_part, i.issued_at, i.service_date,
        i.service_end_date, o.order_number, i.buyer_snapshot, i.lines_snapshot,
        i.total_gross_cents, i.currency, o.payment_state, i.content_hash, i.previous_hash,
        NULL::text AS original_number
      FROM invoices i JOIN orders o ON o.id = i.order_id
      UNION ALL
      SELECT 'credit_note'::text, c.document_number, c.issued_at, c.service_date, c.service_end_date,
        o.order_number, c.buyer_snapshot, c.lines_snapshot, c.total_gross_cents, c.currency,
        o.payment_state, c.content_hash, c.previous_hash, i.invoice_number
      FROM credit_notes c JOIN orders o ON o.id = c.order_id
      JOIN invoices i ON i.id = c.original_invoice_id
    )
    SELECT kind, number_part AS number, issued_at, service_date, service_end_date, order_number,
      buyer_snapshot, lines_snapshot, total_gross_cents, currency, payment_state,
      content_hash, previous_hash, original_number
    FROM documents
    WHERE issued_at >= COALESCE(${from}::timestamptz, '-infinity'::timestamptz)
      AND issued_at <= ${to}::timestamptz
    ORDER BY kind, split_part(number_part,'-',3)::int, split_part(number_part,'-',4)::bigint`;
  const mapped: Row[] = rows.map(row => ({
    kind: row.kind === 'invoice' ? 'Rechnung' : 'Gutschrift',
    number: row.number,
    issued_at: row.issued_at,
    service_date: calendarDate(row.service_date),
    service_end_date: calendarDate(row.service_end_date),
    order_number: row.order_number,
    buyer_name: buyerName(row.buyer_snapshot),
    buyer_city: snapshotText(row.buyer_snapshot, ['city']),
    buyer_country: snapshotText(row.buyer_snapshot, ['country']),
    buyer_vat_id: snapshotText(row.buyer_snapshot, ['vat_id']),
    net_cents: centsToNumber(row.lines_snapshot, 'net_cents'),
    tax_cents: centsToNumber(row.lines_snapshot, 'tax_cents'),
    gross_cents: row.total_gross_cents,
    currency: row.currency.trim(),
    tax_rates: taxRateSummary(row.lines_snapshot),
    payment_state: row.payment_state,
    content_hash: hashHex(row.content_hash),
    previous_hash: hashHex(row.previous_hash),
    original_number: row.original_number,
  }));
  const sum = (kind: Row['kind'], key: 'net_cents' | 'tax_cents' | 'gross_cents') =>
    mapped.filter(row => row.kind === kind).reduce((total, row) => total + row[key], 0n).toString();
  // Die Frist wird je Beleg gerechnet und hier nur zusammengefasst: der früheste
  // und der späteste Tag, an dem einer der Belege entbehrlich würde. Ein fester
  // Satz („zehn Jahre“) wäre bei einem Zeitraum über mehrere Jahre falsch.
  const releases = mapped.map(row => retentionWindow(row.issued_at).releaseDay).sort();
  const years = new Set(mapped.map(row => retentionWindow(row.issued_at).year));
  return {
    period: { from: from ? from.toISOString() : null, to: to.toISOString() },
    counts: {
      invoices: mapped.filter(row => row.kind === 'Rechnung').length,
      credit_notes: mapped.filter(row => row.kind === 'Gutschrift').length,
    },
    rows: mapped.map(row => ({ ...row, net_cents: row.net_cents.toString(),
      tax_cents: row.tax_cents.toString(), gross_cents: row.gross_cents.toString() })),
    totals: {
      net_cents: sum('Rechnung', 'net_cents'), tax_cents: sum('Rechnung', 'tax_cents'),
      gross_cents: sum('Rechnung', 'gross_cents'),
      credit_net_cents: sum('Gutschrift', 'net_cents'), credit_tax_cents: sum('Gutschrift', 'tax_cents'),
      credit_gross_cents: sum('Gutschrift', 'gross_cents'),
    },
    retention_note: 'Belege werden nicht gelöscht. Die Aufbewahrungsfrist von zehn Jahren '
      + '(§ 147 Abs. 3 AO, § 14b Abs. 1 UStG) beginnt mit dem Ende des Kalenderjahres der Ausstellung; '
      + 'diese Ausgabe ist darauf ausgelegt, den Zeitraum vollständig abzubilden. '
      + (releases.length
        ? `Die Belege dieses Zeitraums (Ausstellungsjahr ${[...years].sort().join(', ')}) sind bis `
          + `${releases.at(-1)} aufzubewahren; entbehrlich wären sie frühestens ab ${releases[0]}. `
          + 'Das ist eine Rechnung, keine Freigabe: ein Trigger verweigert Änderung und Löschung.'
        : 'Der gewählte Zeitraum enthält keine Belege.'),
    retention: { years: 10, basis: '§ 147 Abs. 3 AO, § 14b Abs. 1 UStG',
      earliest_release: releases[0] ?? null, latest_release: releases.at(-1) ?? null,
      documents: mapped.length },
    note: 'Arbeitsgrundlage für die Buchhaltung, kein Hauptbuch. Steuerbeträge stammen aus den '
      + 'eingefrorenen Belegpositionen; es wird nichts neu berechnet. Keine Kontierung, keine '
      + 'Umsatzsteuer-Voranmeldung, keine Aussage über die steuerliche Behandlung im Einzelfall.',
  };
}

const csvCell = (value: string | null): string => {
  if (value === null) return '';
  // A leading =, +, - or @ makes a spreadsheet treat the text as a formula.
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[";\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
};

/** Euro text for a cell: the export is read by people, not only by machines. */
const euro = (cents: string): string => {
  const negative = cents.startsWith('-');
  const digits = (negative ? cents.slice(1) : cents).padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2)},${digits.slice(-2)}`;
};

/**
 * Die CSV-Fassung der Liste.
 *
 * Semikolon und deutsches Dezimalkomma, weil die Datei in Deutschland in
 * Tabellenprogrammen geöffnet wird; UTF-8 mit BOM, damit Umlaute in Excel
 * ankommen. Jede Zeile trägt ihre Prüfsumme, damit die Datei gegen die Belege
 * abgleichbar bleibt.
 */
export function documentsCsv(list: DocumentList, generatedAt = new Date()): Buffer {
  const header = ['Belegart', 'Belegnummer', 'Rechnungsdatum', 'Leistungsdatum', 'Leistungsende',
    'Bestellnummer', 'Empfänger', 'Ort', 'Land', 'USt-IdNr. Empfänger', 'Netto', 'Umsatzsteuer',
    'Brutto', 'Währung', 'Steuersätze (Satz=Netto/Steuer)', 'Zahlungsstatus', 'Ursprungsrechnung',
    'Prüfsumme (SHA-256)', 'Vorgänger (SHA-256)'];
  const lines = [header.map(csvCell).join(';')];
  for (const row of list.rows) {
    lines.push([
      row.kind, row.number, calendarDate(row.issued_at) ?? '', row.service_date ?? '',
      row.service_end_date ?? '', row.order_number, row.buyer_name, row.buyer_city,
      row.buyer_country, row.buyer_vat_id, euro(row.net_cents), euro(row.tax_cents),
      euro(row.gross_cents), row.currency, row.tax_rates, row.payment_state ?? '',
      row.original_number, row.content_hash, row.previous_hash,
    ].map(value => csvCell(value ?? null)).join(';'));
  }
  // Der Kopf der Datei nennt Herkunft und Grenzen der Ausgabe, ohne Tabellen
  // unlesbar zu machen: zwei Kommentarzeilen, danach die reine Tabelle.
  const meta = [
    `# Belegausgabe Trainer B Akademie; Zeitraum ${list.period.from ?? 'Anfang'} bis ${list.period.to}`,
    `# Erzeugt ${generatedAt.toISOString()}; ${list.counts.invoices} Rechnungen, `
      + `${list.counts.credit_notes} Gutschriften. ${list.note}`,
  ];
  return Buffer.concat([
    // BOM für Excel, sonst werden Umlaute als Steuerzeichen gelesen.
    Buffer.from('\ufeff', 'utf8'),
    Buffer.from(`${meta.join('\r\n')}\r\n${lines.join('\r\n')}\r\n`, 'utf8'),
  ]);
}

/** Die Tage, wie sie im Dateinamen stehen — die Eingabe des Operators, nicht die Grenze der Abfrage. */
export type PeriodLabel = { fromDay: string | null; toDay: string };

/** Date name for the CSV; the period is in the name so two exports cannot collide. */
export function documentsCsvName(period: PeriodLabel): string {
  return `Belege-${period.fromDay ?? 'Anfang'}-bis-${period.toDay}.csv`;
}

/**
 * Ein PDF mit allen Belegen des Zeitraums.
 *
 * Die einzelnen Dokumente werden unverändert aneinandergehängt (jedes ist ein
 * vollständiges PDF), es wird nichts neu gerendert: das Sammel-PDF zeigt exakt
 * die Bytes, die auch einzeln herunterladbar sind. Ein Deckblatt nennt Zeitraum,
 * Anzahl und Prüfsummen, damit die Datei ohne externe Liste prüfbar ist.
 */
export async function documentsBundle(db: Database, period: DocumentPeriod): Promise<Buffer> {
  const to = period.to ?? new Date();
  const from = period.from ?? null;
  const invoices = await db.invoice.findMany({
    where: { issued_at: { ...(from ? { gte: from } : {}), lt: to } },
    orderBy: [{ issued_at: 'asc' }, { invoice_number: 'asc' }],
    include: { order: { select: { order_number: true } } },
  });
  const notes = await db.creditNote.findMany({
    where: { issued_at: { ...(from ? { gte: from } : {}), lt: to } },
    orderBy: [{ issued_at: 'asc' }, { document_number: 'asc' }],
    include: { order: { select: { order_number: true } },
      original_invoice: { select: { invoice_number: true } } },
  });
  const pages: Array<{ title: string; subtitle: string; pdf: Buffer }> = [];
  for (const invoice of invoices) {
    pages.push({ title: `Rechnung ${invoice.invoice_number}`,
      subtitle: `${servicePeriod(invoice.service_date, invoice.service_end_date)}`
        + `${invoice.order?.order_number ? ` · Bestellung ${invoice.order.order_number}` : ''}`
        + `${invoice.content_hash ? ` · ${hashHex(invoice.content_hash)?.slice(0, 16)}…` : ''}`,
      pdf: renderInvoicePdf({ ...invoice, recipient_email: invoice.recipient_email }) });
  }
  for (const note of notes) {
    pages.push({ title: `Gutschrift ${note.document_number}`,
      subtitle: `zu ${note.original_invoice?.invoice_number ?? '—'}`
        + `${note.content_hash ? ` · ${hashHex(note.content_hash)?.slice(0, 16)}…` : ''}`,
      pdf: renderInvoicePdf({ invoice_number: note.document_number, issued_at: note.issued_at,
        seller_snapshot: note.issuer_snapshot, buyer_snapshot: note.buyer_snapshot,
        lines_snapshot: note.lines_snapshot, total_gross_cents: note.total_gross_cents,
        currency: note.currency, due_at: null, payment_reference: null,
        recipient_email: note.recipient_email, service_date: note.service_date,
        service_end_date: note.service_end_date, content_hash: note.content_hash,
        previous_hash: note.previous_hash,
        document: { kind: 'credit_note', title: 'Gutschrift',
          references: note.original_invoice
            ? [{ label: 'Ursprungsrechnung', value: note.original_invoice.invoice_number }] : [],
          note: `Grund: ${note.reason_code.replace(/_/g, ' ')}` } }) });
  }
  return renderBundle(pages, {
    from: from ? from.toISOString() : null, to: to.toISOString(),
    environment: getConfig().paymentEnvironment });
}

export function documentsBundleName(period: PeriodLabel): string {
  return `Belege-${period.fromDay ?? 'Anfang'}-bis-${period.toDay}.pdf`;
}

/**
 * Ein PDF, das fertige PDFs aneinanderhängt — ohne Bibliothek.
 *
 * Jedes Dokument ist bereits ein gültiges PDF 1.4 mit eigener Seitenliste. Diese
 * Funktion übernimmt seine Seiten in ein neues Dokument, hängt ein Deckblatt
 * davor und schreibt ein neues xref. Eine Datei-an-Datei-Verkettung wäre kein
 * gültiges PDF; ein einzelnes mit allen Seiten schon.
 */
function renderBundle(documents: Array<{ title: string; subtitle: string; pdf: Buffer }>,
                      meta: { from: string | null; to: string; environment: 'test' | 'live' }): Buffer {
  const objects: Array<{ body: Buffer }> = [];
  const add = (body: Buffer | string): number => {
    objects.push({ body: typeof body === 'string' ? Buffer.from(body, 'latin1') : body });
    return objects.length;
  };

  const catalogId = add('');
  const pagesId = add('');
  const regularFontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const boldFontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pages: number[] = [];

  // Deckblatt: eine Textseite, die ohne die Belege erklärt, was in der Datei ist.
  const cover: string[] = [];
  const line = (x: number, y: number, size: number, bold: boolean, value: string) => {
    cover.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${escapePdf(value)}) Tj ET`);
  };
  line(50, 780, 18, true, 'Belegsammlung');
  line(50, 758, 10, false, `Zeitraum: ${meta.from ? meta.from.slice(0, 10) : 'Anfang'} bis ${meta.to.slice(0, 10)}`);
  line(50, 743, 10, false, `Umgebung: ${meta.environment === 'live' ? 'Livebetrieb' : 'Testbetrieb'}`);
  line(50, 728, 10, false, `${documents.length} Belege (Rechnungen und Gutschriften)`);
  let coverY = 700;
  const perPage = Math.floor((700 - 60) / 12);
  for (const [index, document] of documents.entries()) {
    if (index >= perPage) break;
    line(50, coverY, 9, false, document.title);
    line(200, coverY, 9, false, document.subtitle.slice(0, 90));
    coverY -= 12;
  }
  if (documents.length > perPage) line(50, coverY - 6, 9, false, '… weitere Belege siehe Einzeldokumente');
  const coverContent = cover.join('\n');
  const coverId = add(`<< /Length ${Buffer.byteLength(coverContent, 'latin1')} >>\nstream\n${coverContent}\nendstream`);
  pages.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595.28 841.89] ` +
    `/Resources << /Font << /F1 ${regularFontId} 0 R /F2 ${boldFontId} 0 R >> >> /Contents ${coverId} 0 R >>`));

  for (const document of documents) {
    pages.push(...importPdf(document.pdf, { pagesId, regularFontId, boldFontId, add }));
  }
  objects[catalogId - 1].body = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, 'latin1');
  objects[pagesId - 1].body = Buffer.from(`<< /Type /Pages /Count ${pages.length} /Kids [${pages
    .map(id => `${id} 0 R`).join(' ')}] >>`, 'latin1');

  const header = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const chunks: Buffer[] = [header];
  const offsets: number[] = [];
  let offset = header.length;
  for (const [index, object] of objects.entries()) {
    const body = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), object.body,
      Buffer.from('\nendobj\n', 'latin1')]);
    offsets.push(offset);
    chunks.push(body);
    offset += body.length;
  }
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, 'latin1'));
  for (const value of offsets) chunks.push(Buffer.from(`${String(value).padStart(10, '0')} 00000 n \n`, 'latin1'));
  chunks.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n` +
    `startxref\n${offset}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

/** WinAnsi-safe literal string for the cover page. */
function escapePdf(value: string): string {
  return value.replace(/[\\()]/g, match => `\\${match}`).replace(/[^\x20-\x7e\x80-\xff\u20ac]/g, '?');
}

/**
 * Copy the pages of an already rendered document into the bundle.
 *
 * Only what this repository's renderer produces is understood on purpose: page
 * objects, their content streams and the two built-in fonts. A general PDF
 * merger would have to handle arbitrary files; this bundle only ever contains
 * documents this application rendered itself, whose structure is known and
 * tested.
 */
function importPdf(pdf: Buffer, target: { pagesId: number; regularFontId: number; boldFontId: number;
  add: (body: Buffer | string) => number }): number[] {
  const source = pdf.toString('latin1');
  const imported: number[] = [];
  // Every page object in the source, taken between its `obj` and `endobj` so a
  // nested dictionary (the resources) cannot truncate the search.
  for (const match of source.matchAll(/(\d+) 0 obj\n<< \/Type \/Page \/[\s\S]*?endobj/g)) {
    const objectText = match[0];
    const contents = /\/Contents (\d+) 0 R/.exec(objectText);
    if (!contents) continue;
    const stream = extractStream(pdf, source, Number(contents[1]));
    if (!stream) continue;
    const contentId = target.add(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'latin1'),
      stream, Buffer.from('\nendstream', 'latin1')]));
    imported.push(target.add(`<< /Type /Page /Parent ${target.pagesId} 0 R /MediaBox [0 0 595.28 841.89] ` +
      `/Resources << /Font << /F1 ${target.regularFontId} 0 R /F2 ${target.boldFontId} 0 R >> >> ` +
      `/Contents ${contentId} 0 R >>`));
  }
  return imported;
}

/** Read one content stream out of a rendered document by its object number. */
function extractStream(pdf: Buffer, source: string, objectNumber: number): Buffer | null {
  const start = source.indexOf(`${objectNumber} 0 obj\n<< /Length`);
  if (start < 0) return null;
  const lengthMatch = /<< \/Length (\d+) >>\nstream\n/.exec(source.slice(start));
  if (!lengthMatch) return null;
  const dataStart = start + lengthMatch.index + lengthMatch[0].length;
  return pdf.subarray(dataStart, dataStart + Number(lengthMatch[1]));
}

/**
 * Die Prüfkette: rechnet jede Prüfsumme nach und prüft die Verkettung.
 *
 * Ein Fehler bedeutet immer dasselbe: der Beleg ist nicht mehr der, der
 * ausgestellt wurde. Die Antwort nennt die betroffene Nummer und den Grund,
 * damit eine Prüfung nicht raten muss.
 */
export type ChainReport = {
  checked: number;
  intact: boolean;
  unsealed: string[];
  broken: Array<{ kind: 'invoice' | 'credit_note'; number: string; reason: 'hash_mismatch' | 'chain_break' }>;
  note: string;
};

export async function verifyChain(db: Database): Promise<ChainReport> {
  const report: ChainReport = { checked: 0, intact: true, unsealed: [], broken: [],
    note: 'Prüfsumme und Verkettung zeigen Veränderungen an der Datenbank vorbei. Sie sind keine '
      + 'Signatur und beweisen nicht, wer einen Beleg erzeugt hat.' };
  for (const kind of ['invoice', 'credit_note'] as const) {
    const rows = kind === 'invoice'
      ? await db.invoice.findMany({ orderBy: { invoice_number: 'asc' } })
      : await db.creditNote.findMany({ orderBy: { document_number: 'asc' } });
    let previous: Uint8Array | null = null;
    for (const row of rows) {
      const number = 'invoice_number' in row ? row.invoice_number : row.document_number;
      const stored = row.content_hash;
      if (!stored) {
        // Belege von vor der Einführung der Prüfsumme: sie werden nicht
        // nachträglich verändert, sondern einmalig versiegelt (`docs:seal`).
        report.unsealed.push(number);
        previous = null;
        continue;
      }
      const document: SealedDocument = { kind, number, issued_at: row.issued_at,
        service_date: row.service_date, service_end_date: row.service_end_date,
        seller_snapshot: 'seller_snapshot' in row ? row.seller_snapshot : row.issuer_snapshot,
        buyer_snapshot: row.buyer_snapshot, lines_snapshot: row.lines_snapshot,
        total_gross_cents: row.total_gross_cents, currency: row.currency,
        due_at: 'due_at' in row ? row.due_at : null,
        payment_reference: 'payment_reference' in row ? row.payment_reference : null };
      const expected = documentHash(document, previous);
      report.checked += 1;
      if (Buffer.from(expected).compare(Buffer.from(stored)) !== 0) {
        report.broken.push({ kind, number, reason: 'hash_mismatch' });
      } else if ((previous === null) !== (row.previous_hash === null)) {
        report.broken.push({ kind, number, reason: 'chain_break' });
      }
      previous = stored;
    }
  }
  report.intact = report.broken.length === 0;
  return report;
}
