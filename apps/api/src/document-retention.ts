import type { Prisma } from '@prisma/client';
import { uuidv7 } from 'uuidv7';
import { calendarDate } from './document-seal';

/**
 * Aufbewahrung der Belege: die Frist, die Sperre und der Nachweis.
 *
 * Drei Dinge gehören zusammen und werden hier bewusst getrennt gehalten:
 *
 *  1. **Die Sperre ist technisch.** Ein Trigger auf `invoices` und
 *     `credit_notes` verweigert jedes `UPDATE` und `DELETE`
 *     (`trainerb_documents_immutable`, Migration 042). Kein Lauf, kein Skript
 *     und keine Web-Route kann einen ausgestellten Beleg entfernen — auch
 *     dieser Lauf nicht.
 *  2. **Die Frist ist eine Rechnung, keine Behauptung.** § 147 Abs. 3 AO lässt
 *     die Frist mit dem Ende des Kalenderjahres beginnen, in dem der Beleg
 *     ausgestellt wurde; bei zehn Jahren endet sie mit dem 31.12. des zehnten
 *     Folgejahres. Ein Beleg vom 22.11.2026 ist damit bis zum 31.12.2036
 *     aufzubewahren und frühestens am 01.01.2037 entbehrlich. Die Dauer ist
 *     konfigurierbar, weil sie eine Entscheidung des Betreibers mit Steuer- und
 *     Rechtsberatung ist und keine Eigenschaft dieses Codes.
 *  3. **Der Nachweis ist ein Protokolleintrag.** Jeder Prüflauf schreibt
 *     `documents.retention_checked` mit Zeitpunkt, Frist, Anzahl und dem
 *     jüngsten Beleg. Damit ist später belegbar, dass zu einem Zeitpunkt
 *     niemand etwas entfernt hat und wie lange die Sperre noch läuft.
 *
 * Bewusst **nicht** hier: ein automatischer Löschlauf. Wenn die Frist abläuft,
 * ist ein Beleg nicht „weg“, sondern entbehrlich — das ist eine Entscheidung
 * mit Begründung, kein Timer. Der Lauf macht solche Belege sichtbar und
 * verweigert die Freigabe ohne ausdrückliche Bestätigung.
 */

/** Zehn Jahre nach § 147 Abs. 3 AO; ein Startwert, keine Rechtsentscheidung. */
export const DOCUMENT_RETENTION_YEARS = 10;

const dayInZone = (value: Date): string => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric',
    month: '2-digit', day: '2-digit' }).formatToParts(value);
  const pick = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
};

export type RetentionRule = { years: number; startsAt: 'end_of_calendar_year';
  basis: string };

export const RETENTION_RULE: RetentionRule = {
  years: DOCUMENT_RETENTION_YEARS,
  startsAt: 'end_of_calendar_year',
  basis: '§ 147 Abs. 3 AO, § 14b Abs. 1 UStG',
};

/**
 * Letzter Tag, an dem ein Beleg aufzubewahren ist (`YYYY-MM-DD`), und der erste
 * Tag, ab dem er entbehrlich wäre. Beide Tage werden aus dem Ausstellungsdatum
 * in `Europe/Berlin` gerechnet — derselbe Tag, der auf dem Beleg steht.
 */
export function retentionWindow(issuedAt: Date | string, rule: RetentionRule = RETENTION_RULE):
{ lastDay: string; releaseDay: string; year: number } {
  const day = typeof issuedAt === 'string' ? issuedAt.slice(0, 10) : dayInZone(new Date(issuedAt));
  const year = Number(day.slice(0, 4));
  if (!Number.isInteger(year) || year < 1900 || year > 2999) {
    throw new Error('Ungültiges Ausstellungsdatum für die Aufbewahrungsfrist.');
  }
  const lastYear = year + rule.years;
  return { lastDay: `${lastYear}-12-31`, releaseDay: `${lastYear + 1}-01-01`, year };
}

/** Ist der Beleg am Stichtag noch aufzubewahren? (`true` = Sperre gilt.) */
export function isRetained(issuedAt: Date | string, asOf: Date | string, rule: RetentionRule = RETENTION_RULE) {
  const { releaseDay } = retentionWindow(issuedAt, rule);
  const today = typeof asOf === 'string' ? asOf.slice(0, 10) : dayInZone(new Date(asOf));
  return today < releaseDay;
}

export type RetentionDocument = { kind: 'invoice' | 'credit_note'; number: string;
  issued_at: Date; content_hash: Uint8Array | null };

export type RetentionReport = {
  checked_at: string;
  rule: RetentionRule;
  documents: { invoices: number; credit_notes: number; total: number };
  unsealed: number;
  /** Belege, deren Frist am Stichtag noch läuft. */
  retained: number;
  /** Belege, deren Frist abgelaufen ist: sichtbar, aber nicht gelöscht. */
  expired: Array<{ kind: 'invoice' | 'credit_note'; number: string; issued_at: string;
    retention_until: string; release_from: string }>;
  /**
   * Der jüngste Beleg bestimmt, wie lange die Sperre mindestens noch läuft.
   * Bewusst ohne Belegnummer: der Nachweis soll langfristig lesbar sein, ohne
   * eine Kundenbeziehung zu archivieren.
   */
  newest: { issued_at: string; retention_until: string } | null;
  /** Frühester und spätester Fristablauf im gesamten Archiv. */
  window: { first_release: string | null; last_release: string | null };
  note: string;
};

/**
 * Bestand und Fristen, ohne etwas zu verändern. Dieselbe Rechnung wie im Export,
 * nur über das ganze Archiv: der Lauf liest beide Belegarten vollständig, weil
 * eine Frist nur dann stimmt, wenn auch der älteste Beleg mitgezählt wird.
 */
export async function documentRetentionReport(db: Prisma.TransactionClient,
  options: { asOf?: Date; rule?: RetentionRule } = {}): Promise<RetentionReport> {
  const asOf = options.asOf ?? new Date();
  const rule = options.rule ?? RETENTION_RULE;
  const [invoices, notes] = await Promise.all([
    db.invoice.findMany({ orderBy: { invoice_number: 'asc' } }),
    db.creditNote.findMany({ orderBy: { document_number: 'asc' } }),
  ]);
  const all: RetentionDocument[] = [
    ...invoices.map((row: Record<string, unknown>) => ({ kind: 'invoice' as const,
      number: row.invoice_number as string, issued_at: row.issued_at as Date,
      content_hash: (row.content_hash ?? null) as Uint8Array | null })),
    ...notes.map((row: Record<string, unknown>) => ({ kind: 'credit_note' as const,
      number: row.document_number as string, issued_at: row.issued_at as Date,
      content_hash: (row.content_hash ?? null) as Uint8Array | null })),
  ];
  const expired: RetentionReport['expired'] = [];
  let retained = 0;
  let unsealed = 0;
  let newest: RetentionReport['newest'] = null;
  const releases: string[] = [];
  for (const document of all) {
    const window = retentionWindow(document.issued_at, rule);
    releases.push(window.releaseDay);
    if (!document.content_hash) unsealed += 1;
    if (isRetained(document.issued_at, asOf, rule)) retained += 1;
    else {
      expired.push({ kind: document.kind, number: document.number,
        issued_at: calendarDate(document.issued_at) ?? dayInZone(document.issued_at),
        retention_until: window.lastDay, release_from: window.releaseDay });
    }
    if (!newest || document.issued_at > new Date(newest.issued_at)) {
      newest = { issued_at: document.issued_at.toISOString(), retention_until: window.lastDay };
    }
  }
  releases.sort();
  return {
    checked_at: asOf.toISOString(),
    rule,
    documents: { invoices: invoices.length, credit_notes: notes.length, total: all.length },
    unsealed,
    retained,
    expired,
    newest,
    window: { first_release: releases[0] ?? null, last_release: releases.at(-1) ?? null },
    note: 'Die Sperre ist technisch: ein Trigger verweigert Änderung und Löschung ausgestellter '
      + 'Belege. Dieser Bericht rechnet nur die Frist; er löscht nichts und gibt nichts frei. '
      + 'Abgelaufene Fristen sind eine Entscheidung des Betreibers mit Steuer- und Rechtsberatung.',
  };
}

/** Ein Prüflauf mit Nachweis. */
export type RetentionCheck = {
  asOf?: Date;
  rule?: RetentionRule;
  /** Abgelaufene Fristen ausdrücklich quittieren; löscht weiterhin nichts. */
  release?: boolean;
};

/** Der Prüflauf selbst braucht nur Transaktionen, keine Verbindung. */
type Transactor = { $transaction: <T>(run: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T> };

const writeAudit = (tx: Prisma.TransactionClient, action: string, payload: unknown) =>
  tx.auditEvent.create({ data: { id: uuidv7(), actor_user_id: null, origin: 'system',
    action, target_type: 'system', target_ref: 'documents',
    after_safe: payload as Prisma.InputJsonValue } });

/**
 * Ein Prüflauf mit Nachweis.
 *
 * Der Nachweis ist der eigentliche Zweck: er hält fest, dass zu diesem
 * Zeitpunkt geprüft wurde, wie viele Belege unter welcher Frist standen und wie
 * lange die Sperre mindestens noch läuft. Deshalb schreibt dieser Lauf seine
 * Protokollzeile **außerhalb** der Prüftransaktion — sonst würde ein Abbruch
 * genau den Befund mitnehmen, den er belegen soll.
 *
 * `release` ist der einzige Weg, einen abgelaufenen Beleg als „entbehrlich“
 * zu quittieren. Auch das löscht nichts: der Trigger bleibt stärker. Ohne
 * `release` endet der Lauf mit `RETENTION_EXPIRED`, nachdem er den Befund
 * protokolliert hat.
 */
export async function retentionCheck(db: Transactor, options: RetentionCheck = {}): Promise<RetentionReport> {
  const report = await db.$transaction(tx => documentRetentionReport(tx, options));
  const summary = { checked_at: report.checked_at, rule: report.rule, documents: report.documents,
    retained: report.retained, expired: report.expired.length, unsealed: report.unsealed,
    newest: report.newest, window: report.window };
  if (report.expired.length > 0 && !options.release) {
    // Die Nummern gehören in den Befund — nur so lässt sich die Entscheidung
    // später einem konkreten Beleg zuordnen. Der Routinelauf bleibt ohne sie.
    await db.$transaction(tx => writeAudit(tx, 'documents.retention_expired',
      { ...summary, numbers: report.expired.slice(0, 50).map(entry => entry.number) }));
    throw Object.assign(new Error('RETENTION_EXPIRED'), { expired: report.expired.length,
      hint: 'Abgelaufene Fristen brauchen eine dokumentierte Entscheidung (--release); '
        + 'auch dann wird nichts gelöscht.' });
  }
  await db.$transaction(tx => writeAudit(tx, 'documents.retention_checked', summary));
  return report;
}
