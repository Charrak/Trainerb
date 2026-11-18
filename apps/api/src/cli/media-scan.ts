import 'reflect-metadata';
import { isAbsolute } from 'node:path';
import { Database } from '../database';
import { getConfig } from '../config';
import { inspectUpload, scanNext } from '../media-scan';
import { requireUuid } from '../security';

async function main() {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--retry-error')) throw new Error('Invalid scan arguments');
  const retryId = args.length ? requireUuid(args[1]) : undefined;
  const cfg = getConfig();
  const socket = process.env.MEDIA_SCAN_CLAMD_SOCKET, accessKeyId = process.env.MEDIA_SCAN_ACCESS_KEY_ID;
  const secretAccessKey = process.env.MEDIA_SCAN_SECRET_ACCESS_KEY;
  if (!cfg.quarantineStore || !socket || !isAbsolute(socket) || !accessKeyId || !secretAccessKey ||
      [cfg.mediaStore?.accessKeyId, cfg.quarantineStore.accessKeyId].includes(accessKeyId)) {
    throw new Error('Configure a separate quarantine reader and local clamd socket');
  }
  const store = { ...cfg.quarantineStore, accessKeyId, secretAccessKey };
  const db = new Database();
  try {
    for (let i = 0; i < (retryId ? 1 : 25); i++) {
      const result = await scanNext(db, row => inspectUpload(row, store, socket), retryId);
      if (!result) { if (retryId) throw new Error('Receipt not retryable'); break; }
      console.log(JSON.stringify({ event: 'media.scanned', ...result }));
      if (result.status === 'scan_error') process.exitCode = 1;
    }
  } finally { await db.$disconnect(); }
}
main().catch(() => { console.error('Medienprüfung fehlgeschlagen. Konfiguration, Datenbank und ggf. Beleg-ID prüfen.'); process.exitCode = 1; });
