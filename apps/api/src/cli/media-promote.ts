import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { promotionConfig } from '../media-scan-config';
import { promoteNext } from '../media-promote';

async function main() {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--retry-error')) throw new Error('Invalid scan arguments');
  const retryId = args[1];
  if (retryId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(retryId)) throw new Error('Invalid receipt');
  const { databaseUrl, ...stores } = promotionConfig(process.env);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    for (let i = 0; i < (retryId ? 1 : 25); i++) {
      const result = await promoteNext(db, stores, retryId);
      if (!result) { if (retryId) throw new Error('Receipt not retryable'); break; }
      console.log(JSON.stringify({ event: result.error ? 'media.promotion_failed' : 'media.promoted', ...result }));
      if (result.error) process.exitCode = 1;
    }
  } finally { await db.$disconnect(); }
}
main().catch(() => { console.error('Medienübernahme fehlgeschlagen. Konfiguration, Datenbank und ggf. Beleg-ID prüfen.'); process.exitCode = 1; });
