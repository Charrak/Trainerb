import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { scanConfig } from '../media-scan-config';
import { inspectUpload, scanNext } from '../media-scan';

async function main() {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--retry-error')) throw new Error('Invalid scan arguments');
  const retryId = args[1];
  if (retryId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(retryId)) throw new Error('Invalid receipt');
  const { databaseUrl, socket, store } = scanConfig(process.env);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
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
