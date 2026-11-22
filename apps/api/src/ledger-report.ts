import { Prisma } from '@prisma/client';
import type { Database } from './database';
import { getConfig } from './config';

export type LedgerPeriod = 'today' | 'month' | 'all';
export type LedgerSection = 'income' | 'credits' | 'refunds' | 'receivables' | 'tax' | 'payments';

const zone = 'Europe/Berlin';

/** Eine Zeile des Buchungsjournals; Beträge sind Cent als Dezimalzeichenkette. */
export type LedgerRow = {
  section: LedgerSection;
  /** Stabile Kennung, unter der die Zeile in einer Auswertung auftaucht. */
  category: string;
  /** Anzahl der Belege, auf denen die Zeile beruht. */
  documents: number;
  net_cents: string | null;
  tax_cents: string | null;
  gross_cents: string;
  currency: 'EUR';
};

/**
 * Buchhaltungsnahe Auswertung – ausdrücklich **kein** Hauptbuch.
 *
 * Die Beträge stammen ausschließlich aus eingefrorenen Belegen und bestätigten
 * Zahlungen: Rechnungspositionen (netto/Steuer/brutto), Gutschriftpositionen
 * und bestätigte Zahlungseingänge. Es wird nichts geschätzt, nichts aus einem
 * heutigen Steuersatz neu gerechnet und keine Auslandswährung umgerechnet.
 *
 * Was hier bewusst fehlt und nur mit der echten Buchhaltung zu klären ist:
 * Kontenrahmen und Buchungstexte, Umsatzsteuer-Voranmeldung, Auszahlungs- und
 * Bankgebühren, Mahn-/Zahlungsstatus offener Rechnungen sowie die Abstimmung
 * mit einem Steuerberater. Die Ausgabe ist eine Arbeitsgrundlage dafür.
 */
export async function ledgerReport(db: Database, period: LedgerPeriod, asOf = new Date()) {
  const environment = getConfig().paymentEnvironment;
  const start = period === 'all' ? Prisma.sql`NULL::timestamptz`
    : Prisma.sql`date_trunc(${period === 'today' ? 'day' : 'month'}, stamp AT TIME ZONE ${zone}) AT TIME ZONE ${zone}`;
  // Die Grenze kommt aus derselben SQL-Regel wie im Bericht, nicht aus einer
  // zweiten, eigenen Zeitzonenrechnung im Anwendungscode.
  const [boundary] = await db.$queryRaw<Array<{ starts_at: Date | null }>>`
    SELECT ${start} AS starts_at FROM (SELECT ${asOf}::timestamptz AS stamp) clock`;
  const rows = await db.$queryRaw<Array<{
    section: LedgerSection; category: string; documents: number;
    net_cents: string | null; tax_cents: string | null; gross_cents: string;
  }>>`WITH clock AS (SELECT ${asOf}::timestamptz AS stamp),
      bounds AS (SELECT stamp, ${start} AS starts_at FROM clock)
    -- 1) Ausgestellte Rechnungen: die Steuer je Satz steht eingefroren in der
    --    Position. Eine Rechnung ohne Position trägt zur Steuer nichts bei.
    , invoice_lines AS (
      SELECT i.id AS document_id, i.issued_at AS at,
        (line->>'tax_rate_bp')::int AS rate_bp, line->>'tax_label' AS label,
        (line->>'net_cents')::bigint AS net_cents, (line->>'tax_cents')::bigint AS tax_cents,
        (line->>'total_gross_cents')::bigint AS gross_cents
      FROM invoices i CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(i.lines_snapshot) = 'array' THEN i.lines_snapshot ELSE '[]'::jsonb END) AS line
      WHERE i.currency = 'EUR' AND i.issued_at BETWEEN (SELECT coalesce(starts_at,'-infinity') FROM bounds)
        AND (SELECT stamp FROM bounds))
      , income AS (
        SELECT 'income'::text AS section, 'invoice_net'::text AS category, count(DISTINCT document_id)::int AS documents,
          sum(net_cents)::text AS net_cents, sum(tax_cents)::text AS tax_cents, sum(gross_cents)::text AS gross_cents
        FROM invoice_lines),
      tax_by_rate AS (
        SELECT 'tax'::text AS section, ('invoice_tax_' || rate_bp::text)::text AS category,
          count(DISTINCT document_id)::int AS documents, sum(net_cents)::text AS net_cents,
          sum(tax_cents)::text AS tax_cents, sum(gross_cents)::text AS gross_cents
        FROM invoice_lines WHERE rate_bp IS NOT NULL GROUP BY rate_bp),
    -- 2) Gutschriften: Korrektur derselben Steuer, nie eine neue Rechnung.
      credit_lines AS (
        SELECT c.id AS document_id,
          (line->>'tax_rate_bp')::int AS rate_bp, (line->>'net_cents')::bigint AS net_cents,
          (line->>'tax_cents')::bigint AS tax_cents, (line->>'total_gross_cents')::bigint AS gross_cents
        FROM credit_notes c CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(c.lines_snapshot) = 'array' THEN c.lines_snapshot ELSE '[]'::jsonb END) AS line
        WHERE c.currency = 'EUR' AND c.issued_at BETWEEN (SELECT coalesce(starts_at,'-infinity') FROM bounds)
          AND (SELECT stamp FROM bounds)),
      credits AS (
        SELECT 'credits'::text AS section, 'credit_note_net'::text AS category, count(DISTINCT document_id)::int AS documents,
          sum(net_cents)::text AS net_cents, sum(tax_cents)::text AS tax_cents, sum(gross_cents)::text AS gross_cents
        FROM credit_lines),
      credit_tax AS (
        SELECT 'tax'::text AS section, ('credit_tax_' || rate_bp::text)::text AS category,
          count(DISTINCT document_id)::int AS documents, sum(net_cents)::text AS net_cents,
          sum(tax_cents)::text AS tax_cents, sum(gross_cents)::text AS gross_cents
        FROM credit_lines WHERE rate_bp IS NOT NULL GROUP BY rate_bp),
    -- 3) Bestätigte Zahlungseingänge nach tatsächlichem Weg. Der Weg kommt aus
    --    dem Zahlungsversuch, nicht aus einer Annahme über die Bestellung.
      payments AS (
        SELECT 'payments'::text AS section, a.provider, count(*)::int AS documents,
          NULL::text AS net_cents, NULL::text AS tax_cents, coalesce(sum(a.amount_cents),0)::text AS gross_cents
        FROM payment_attempts a, bounds
        WHERE a.environment = ${environment} AND a.currency = 'EUR' AND a.status = 'succeeded'
          AND a.confirmed_at BETWEEN coalesce(bounds.starts_at,'-infinity') AND bounds.stamp
        GROUP BY a.provider),
      refund_payments AS (
        SELECT 'refunds'::text AS section, ('refund_' || r.provider)::text AS category, count(*)::int AS documents,
          NULL::text AS net_cents, NULL::text AS tax_cents, coalesce(sum(r.amount_cents),0)::text AS gross_cents
        FROM refunds r, bounds
        WHERE r.environment = ${environment} AND r.currency = 'EUR' AND r.status = 'succeeded'
          AND r.confirmed_at BETWEEN coalesce(bounds.starts_at,'-infinity') AND bounds.stamp
        GROUP BY r.provider),
    -- 4) Offene Forderungen: Rechnungen ohne bestätigte Zahlung. Eine
    --    Erstattung macht daraus keine Forderung; storniert bleibt storniert.
      receivables AS (
        SELECT 'receivables'::text AS section, 'open_invoice'::text AS category, count(*)::int AS documents,
          NULL::text AS net_cents, NULL::text AS tax_cents, coalesce(sum(i.total_gross_cents),0)::text AS gross_cents
        FROM invoices i JOIN orders o ON o.id = i.order_id, bounds
        WHERE i.currency = 'EUR' AND i.issued_at BETWEEN coalesce(bounds.starts_at,'-infinity') AND bounds.stamp
          AND o.payment_state IN ('awaiting', 'processing')
          AND o.cancelled_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM payment_attempts p WHERE p.order_id = o.id
            AND p.environment = ${environment} AND p.currency = 'EUR' AND p.status = 'succeeded')),
      all_rows AS (
        SELECT * FROM income WHERE documents > 0 OR gross_cents <> '0'
        UNION ALL SELECT * FROM credits WHERE documents > 0
        UNION ALL SELECT * FROM credit_tax
        UNION ALL SELECT * FROM tax_by_rate
        UNION ALL SELECT * FROM payments
        UNION ALL SELECT * FROM refund_payments
        UNION ALL SELECT * FROM receivables)
    SELECT section, category, documents,
      coalesce(net_cents,'0') AS net_cents, coalesce(tax_cents,'0') AS tax_cents, gross_cents
    FROM all_rows ORDER BY section, category`;
  const data: LedgerRow[] = rows.map(row => ({ section: row.section, category: row.category,
    documents: row.documents, net_cents: row.net_cents, tax_cents: row.tax_cents,
    gross_cents: row.gross_cents, currency: 'EUR' }));
  const sum = (section: LedgerSection, field: 'net_cents' | 'tax_cents' | 'gross_cents') =>
    data.filter(row => row.section === section).reduce((total, row) => total + BigInt(row[field] ?? '0'), 0n).toString();
  return {
    period,
    timezone: zone,
    environment,
    currency: 'EUR' as const,
    as_of: asOf,
    starts_at: boundary?.starts_at ?? null,
    rows: data,
    totals: {
      // Rechnungen und Gutschriften stehen in derselben Steuerlogik: die
      // Gutschrift mindert Umsatz und Steuer, weil sie eine Korrektur ist.
      invoice_net_cents: sum('income', 'net_cents'),
      invoice_tax_cents: sum('income', 'tax_cents'),
      invoice_gross_cents: sum('income', 'gross_cents'),
      credit_net_cents: sum('credits', 'net_cents'),
      credit_tax_cents: sum('credits', 'tax_cents'),
      credit_gross_cents: sum('credits', 'gross_cents'),
      net_after_credits_cents: (BigInt(sum('income', 'net_cents')) - BigInt(sum('credits', 'net_cents'))).toString(),
      tax_after_credits_cents: (BigInt(sum('income', 'tax_cents')) - BigInt(sum('credits', 'tax_cents'))).toString(),
      payments_cents: sum('payments', 'gross_cents'),
      refunds_cents: sum('refunds', 'gross_cents'),
      receivables_cents: sum('receivables', 'gross_cents'),
    },
    note: 'Arbeitsgrundlage für die Buchhaltung, kein Hauptbuch. Keine Umsatzsteuer-Voranmeldung, keine Bank- oder Auszahlungsgebühren, keine Umrechnung fremder Währungen.',
  };
}
