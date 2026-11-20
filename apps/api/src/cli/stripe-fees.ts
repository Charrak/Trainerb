import 'reflect-metadata';
import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { assertRuntimeRole } from '../runtime-role';
import { reconcileFees } from '../stripe-fees';
async function main() {
  const mode = process.env.APP_ENV;
  if (
    !['production', 'development', 'test'].includes(mode ?? '') ||
    !process.env.FEE_DATABASE_URL ||
    process.env.DATABASE_MIGRATION_URL
  )
    throw Error();
  const env = mode === 'production' ? 'live' : 'test',
    key = process.env.STRIPE_FEE_READ_KEY;
  if (!key || !key.startsWith(`rk_${env}_`)) throw Error();
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--after')) throw Error();
  const cursor = args[1];
  if (args.length && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(cursor)) throw Error();
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.FEE_DATABASE_URL }) });
  try {
    if (mode === 'production') await assertRuntimeRole(db);
    const result = await reconcileFees(db, new Stripe(key, { maxNetworkRetries: 1, timeout: 8000 }), env, cursor);
    console.log(JSON.stringify(result));
    if (result.errors) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}
main().catch(() => {
  console.error('Gebührenabgleich nicht abgeschlossen. Leserolle, Umgebung und Provider prüfen.');
  process.exitCode = 1;
});
