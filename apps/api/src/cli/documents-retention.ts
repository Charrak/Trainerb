import 'reflect-metadata';
import { Database } from '../database';
import { documentRetentionReport, retentionCheck } from '../document-retention';

/**
 * Nachweis der Aufbewahrungsfrist.
 *
 *   npm run docs:retention                       # Bericht, nichts wird geschrieben
 *   npm run docs:retention -- --record           # Bericht als `documents.retention_checked`
 *   npm run docs:retention -- --record --release # abgelaufene Fristen quittieren
 *
 * Der Lauf löscht nichts und kann nichts löschen: der Trigger auf `invoices`
 * und `credit_notes` verweigert jedes `UPDATE` und `DELETE`. Er beantwortet die
 * Frage, die ein Prüfer stellt — „wie lange sind die Belege noch aufzubewahren,
 * und wo steht, dass das kontrolliert wurde?“. Ein abgelaufener Beleg ist nicht
 * automatisch weg, sondern entbehrlich; das bleibt eine Entscheidung mit
 * Begründung, deshalb verlangt sie `--release` und wird auditiert.
 */
async function main() {
  const record = process.argv.includes('--record');
  const release = process.argv.includes('--release');
  if (release && !record) throw new Error('--release braucht --record.');
  const db = new Database();
  try {
    await db.$connect();
    const report = record
      ? await retentionCheck(db, { release })
      : await db.$transaction(tx => documentRetentionReport(tx));
    console.log(JSON.stringify({ level: 'info',
      event: record ? 'documents.retention_checked' : 'documents.retention_report',
      recorded: record, released: release && record, report }, null, 2));
  } finally {
    await db.$disconnect();
  }
}
main().catch(error => {
  const expired = error && typeof error === 'object' && 'expired' in error
    ? { expired: (error as { expired: number }).expired } : {};
  console.error(JSON.stringify({ level: 'error',
    event: error?.message === 'RETENTION_EXPIRED' ? 'documents.retention_expired'
      : 'documents.retention_failed',
    // Kein Stack, keine Daten: nur der Grund, damit ein Zeitplan den Fehler einordnen kann.
    reason: error instanceof Error ? error.message : 'unbekannt', ...expired }));
  process.exitCode = error?.message === 'RETENTION_EXPIRED' ? 2 : 1;
});
