import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';

/**
 * Prüfsumme und Kette der Belege.
 *
 * Die Anforderung dahinter ist die GoBD-Forderung nach Nachvollziehbarkeit: ein
 * ausgestellter Beleg muss sich später darauf prüfen lassen, dass er *genau so*
 * ausgestellt wurde. Ein Trigger verhindert schon das Ändern; die Prüfsumme
 * macht zusätzlich sichtbar, ob ein Beleg an der Datenbank vorbei verändert
 * wurde, und die Verkettung macht das Entfernen oder Umsortieren eines Belegs
 * erkennbar.
 *
 * Zwei Regeln, die den Nutzen ausmachen:
 *
 *  1. **Kanonisch, nicht beliebig.** Der Hash läuft über eine feste Feldliste in
 *     fester Reihenfolge, mit normalisierten Werten (Cents als Dezimalstring,
 *     Daten als ISO-Datum in `Europe/Berlin`). Ein `JSON.stringify` über das
 *     ganze Objekt wäre nicht stabil: Schlüsselreihenfolge und Zahlendarstellung
 *     hängen von der Laufzeit ab.
 *  2. **Der Vorgänger ist Teil der Formel.** `previous_hash` geht in den Hash
 *     des nächsten Belegs ein. Damit bricht jede Lücke in der Kette auf.
 *
 * Der Hash ist eine Integritätsprüfung, keine Signatur: er zeigt Veränderungen,
 * er beweist nicht, wer den Beleg erzeugt hat. Das steht so auch im Export.
 */

export type DocumentKind = 'invoice' | 'credit_note';

/** Die Felder, die in die Prüfsumme eingehen — bewusst eine feste Liste. */
export type SealedDocument = {
  kind: DocumentKind;
  number: string;
  issued_at: Date;
  service_date: Date | null;
  service_end_date: Date | null;
  seller_snapshot: unknown;
  buyer_snapshot: unknown;
  lines_snapshot: unknown;
  total_gross_cents: bigint | string | number;
  currency: string;
  due_at?: Date | null;
  payment_reference?: string | null;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const zone = 'Europe/Berlin';

/**
 * Der Kalendertag in einer Zone — dieselbe Rechnung wie `to_char(... AT TIME
 * ZONE ...)` in der Nummernvergabe. Nr. 1–3 und die Nummer eines Belegs müssen
 * denselben Tag sehen, sonst trägt eine Rechnung vom 31.12. das Jahr danach.
 */
function dayInZone(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit',
    day: '2-digit' }).formatToParts(value);
  const pick = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/** Ein Datum als `YYYY-MM-DD` in derselben Zeitzone, in der Belege angezeigt werden. */
export function isoDate(value: Date | null | undefined): string | null {
  return value ? dayInZone(value, zone) : null;
}

/**
 * Ein `date`-Wert aus der Datenbank oder ein String wird zu `YYYY-MM-DD`.
 * Ein `date` kommt über den Treiber als UTC-Mitternacht; die darf nicht noch
 * einmal in eine Zeitzone gedreht werden, sonst verschiebt sich der Tag.
 */
export function calendarDate(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return DATE.test(value) ? value : isoDate(new Date(value));
  const stripped = value.toISOString().slice(0, 10);
  return stripped;
}

/**
 * Stabile JSON-Darstellung: Objektschlüssel sortiert, `undefined` fällt weg,
 * Zahlen bleiben Zahlen. Zwei gleiche Belege ergeben damit immer denselben Text,
 * egal in welcher Reihenfolge die Felder gesetzt wurden.
 */
function canonicalJson(value: unknown): string {
  const walk = (input: unknown): unknown => {
    if (input === null || input === undefined) return null;
    if (Array.isArray(input)) return input.map(walk);
    if (input instanceof Date) return input.toISOString();
    if (typeof input === 'bigint') return input.toString();
    if (typeof input === 'object') {
      const source = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) {
        const next = walk(source[key]);
        if (next !== null || source[key] === null) out[key] = next;
      }
      return out;
    }
    return input;
  };
  return JSON.stringify(walk(value));
}

/**
 * Der kanonische Beleginhalt als Text. Diese Funktion ist der Vertrag: wer sie
 * ändert, macht alle bisherigen Prüfsummen ungültig — genau deshalb steht die
 * Version im Hash. Eine neue Version ist eine bewusste Entscheidung und
 * erfordert eine Migration, keine stille Änderung.
 */
export function canonicalContent(document: SealedDocument): string {
  return canonicalJson({
    schema: 'trainerb.document.v1',
    kind: document.kind,
    number: document.number,
    issued_at: new Date(document.issued_at).toISOString(),
    service_date: calendarDate(document.service_date),
    service_end_date: calendarDate(document.service_end_date),
    seller: document.seller_snapshot ?? null,
    buyer: document.buyer_snapshot ?? null,
    lines: document.lines_snapshot ?? null,
    total_gross_cents: String(document.total_gross_cents),
    currency: document.currency,
    due_at: document.due_at ? new Date(document.due_at).toISOString() : null,
    payment_reference: document.payment_reference ?? null,
  });
}

/**
 * Die Prüfsumme eines Belegs.
 *
 * `previousHash` ist die Prüfsumme des vorigen Belegs derselben Art (nach
 * Nummer); `null` bedeutet: es ist der erste Beleg im Archiv. Der Wert geht mit
 * in den Hash, deshalb ist die Kette nicht umsortierbar.
 */
export function documentHash(document: SealedDocument, previousHash: Uint8Array | null): Uint8Array {
  return createHash('sha256')
    .update('trainerb.document.v1\0')
    .update(canonicalContent(document))
    .update('\0')
    .update(previousHash ? Buffer.from(previousHash).toString('hex') : 'genesis')
    .digest() as unknown as Uint8Array;
}

/** Hex-Darstellung für Anzeige und Export; die Spalte bleibt `bytea`. */
export const hashHex = (value: Uint8Array | Buffer | null | undefined): string | null =>
  value && value.length ? Buffer.from(value).toString('hex') : null;

/**
 * Der jüngste versiegelte Beleg einer Art, oder `null` in einem leeren Archiv.
 *
 * Gelesen wird nach Nummer, nicht nach `issued_at`: die Nummer ist der
 * Nummernkreis, in dem die Kette gilt, und sie ist unveränderlich.
 */
export type SealDb = { $queryRaw: Prisma.TransactionClient['$queryRaw'] };

export async function lastSealed(tx: SealDb, kind: DocumentKind): Promise<{ number: string; content_hash: Uint8Array | null } | null> {
  if (kind === 'invoice') {
    return tx.$queryRaw<Array<{ number: string; content_hash: Uint8Array | null }>>`
      SELECT invoice_number AS number, content_hash FROM invoices
      WHERE invoice_number ~ '^TB-RE-[0-9]{4}-[0-9]{6}$'
      ORDER BY split_part(invoice_number,'-',3)::int DESC, split_part(invoice_number,'-',4)::bigint DESC
      LIMIT 1` .then(rows => rows[0] ?? null);
  }
  return tx.$queryRaw<Array<{ number: string; content_hash: Uint8Array | null }>>`
    SELECT document_number AS number, content_hash FROM credit_notes
    WHERE document_number ~ '^TB-GS-[0-9]{4}-[0-9]{6}$'
    ORDER BY split_part(document_number,'-',3)::int DESC, split_part(document_number,'-',4)::bigint DESC
    LIMIT 1`.then(rows => rows[0] ?? null);
}

/** Ein `date`-Wert (Spalte) als `Date` um UTC-Mitternacht, damit `formatDate` den Tag trifft. */
export function serviceDateValue(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

/** Der Vorgänger-Hash, den ein neuer Beleg mitbekommt. */
export async function chainHead(tx: SealDb, kind: DocumentKind): Promise<Uint8Array | null> {
  const last = await lastSealed(tx, kind);
  return last?.content_hash ?? null;
}
