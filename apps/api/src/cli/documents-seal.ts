import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Database } from '../database';
import { documentHash, hashHex, type SealedDocument } from '../document-seal';

/**
 * Belege einmalig versiegeln.
 *
 * Die Prüfsumme kam erst mit der GoBD-Härtung. Belege davor haben keine. Sie
 * nachträglich zu berechnen ist die einzige Änderung, die der Trigger auf
 * `invoices`/`credit_notes` noch erlaubt — und zwar genau einmal: nur
 * `content_hash` und `previous_hash` dürfen von NULL auf einen Wert gehen.
 *
 *   npm run docs:seal              # zeigt, was zu tun wäre
 *   npm run docs:seal -- --apply   # versiegelt
 *
 * Zwei Regeln, die den Lauf ehrlich halten:
 *
 *  1. **Nur am Ende versiegeln.** Versiegelt wird ab dem ersten unversiegelten
 *     Beleg in Nummernreihenfolge. Steht davor ein versiegelter und danach
 *     wieder einer, ist die Kette unterbrochen — dann bricht der Lauf ab,
 *     statt eine Lücke zu überdecken. Ein solcher Befund gehört zu einem
 *     Menschen (Sicherung, Zugriffswege, Buchhaltung), nicht zu einem Skript.
 *  2. **Der Vorgänger ist der Beleg davor**, nicht der letzte im Archiv. Genau
 *     daran wäre eine Mittellücke sonst unbemerkt geblieben.
 *
 * Wichtig für die Aussagekraft: eine Prüfsumme, die heute über einen Beleg von
 * 2026 gerechnet wird, bestätigt den Beleg *ab heute*. Sie behauptet nicht, dass
 * er seit der Ausstellung unverändert ist — das kann sie nicht. Der Export und
 * die Kettenprüfung sagen das auch so.
 */
type Entry = { id: string; number: string; sealed: boolean; row: Record<string, unknown> };

async function main() {
  const apply = process.argv.includes('--apply');
  const db = new Database();
  try {
    await db.$connect();
    const invoices = await db.invoice.findMany({ orderBy: { invoice_number: 'asc' } });
    const notes = await db.creditNote.findMany({ orderBy: { document_number: 'asc' } });
    const groups: Array<{ kind: 'invoice' | 'credit_note'; entries: Entry[] }> = [
      { kind: 'invoice', entries: invoices.map(row => ({ id: row.id, number: row.invoice_number,
        sealed: row.content_hash !== null, row: row as unknown as Record<string, unknown> })) },
      { kind: 'credit_note', entries: notes.map(row => ({ id: row.id, number: row.document_number,
        sealed: row.content_hash !== null, row: row as unknown as Record<string, unknown> })) },
    ];
    // Eine Lücke in der Mitte ist ein Befund, kein Arbeitsauftrag.
    const gaps: string[] = [];
    for (const group of groups) {
      const lastSealed = group.entries.map(entry => entry.sealed).lastIndexOf(true);
      const firstOpen = group.entries.findIndex(entry => !entry.sealed);
      if (firstOpen >= 0 && lastSealed > firstOpen) {
        gaps.push(...group.entries.slice(firstOpen, lastSealed + 1).filter(entry => !entry.sealed)
          .map(entry => entry.number));
      }
    }
    const plan = groups.flatMap(group => group.entries.filter(entry => !entry.sealed));
    if (!apply) {
      console.log(JSON.stringify({ level: 'info', event: 'documents.seal_plan', applying: false,
        invoices: invoices.filter(row => row.content_hash === null).length,
        credit_notes: notes.filter(row => row.content_hash === null).length,
        numbers: plan.map(entry => entry.number), gaps }, null, 2));
      if (gaps.length) process.exitCode = 2;
      return;
    }
    if (gaps.length) {
      console.error(JSON.stringify({ level: 'error', event: 'documents.chain_gap', numbers: gaps,
        hint: 'Unversiegelte Belege zwischen versiegelten: Kette prüfen, bevor versiegelt wird.' }));
      process.exitCode = 2;
      return;
    }
    let sealed = 0;
    for (const group of groups) {
      const firstOpen = group.entries.findIndex(entry => !entry.sealed);
      if (firstOpen < 0) continue;
      // Der Vorgänger ist der letzte Beleg *vor* dem ersten unversiegelten.
      const predecessor = firstOpen === 0 ? null : group.entries[firstOpen - 1];
      let previous: Uint8Array | null = predecessor
        ? (predecessor.row.content_hash as Uint8Array | null) : null;
      for (const entry of group.entries.slice(firstOpen)) {
        const row = entry.row;
        const document: SealedDocument = { kind: group.kind, number: entry.number,
          issued_at: row.issued_at as Date,
          service_date: row.service_date as Date | null,
          service_end_date: row.service_end_date as Date | null,
          seller_snapshot: 'seller_snapshot' in row ? row.seller_snapshot : row.issuer_snapshot,
          buyer_snapshot: row.buyer_snapshot, lines_snapshot: row.lines_snapshot,
          total_gross_cents: row.total_gross_cents as bigint, currency: row.currency as string,
          due_at: ('due_at' in row ? row.due_at : null) as Date | null,
          payment_reference: ('payment_reference' in row ? row.payment_reference : null) as string | null };
        const hash = documentHash(document, previous) as Uint8Array<ArrayBuffer>;
        if (group.kind === 'invoice') {
          await db.$executeRaw`UPDATE invoices SET content_hash = ${hash}, previous_hash = ${previous} WHERE id = ${entry.id}::uuid`;
        } else {
          await db.$executeRaw`UPDATE credit_notes SET content_hash = ${hash}, previous_hash = ${previous} WHERE id = ${entry.id}::uuid`;
        }
        previous = hash;
        sealed += 1;
      }
    }
    await db.auditEvent.create({ data: { id: randomUUID(), origin: 'system',
      action: 'documents.sealed', target_type: 'system', target_ref: 'documents',
      after_safe: { sealed, fingerprint: hashHex(await db.$queryRaw<Array<{ hash: Uint8Array | null }>>`
        SELECT content_hash AS hash FROM invoices ORDER BY invoice_number DESC LIMIT 1`
        .then(rows => rows[0]?.hash ?? null)) } } });
    console.log(JSON.stringify({ level: 'info', event: 'documents.sealed', sealed }, null, 2));
  } finally {
    await db.$disconnect();
  }
}
main().catch(() => { console.error(JSON.stringify({ level: 'error', event: 'documents.seal_failed' }));
  process.exitCode = 1; });
