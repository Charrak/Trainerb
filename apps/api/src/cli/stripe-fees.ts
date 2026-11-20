import 'reflect-metadata';
import Stripe from 'stripe';
import { Database } from '../database';
import { getConfig } from '../config';
import { reconcileFees } from '../stripe-fees';
import { requireUuid } from '../security';
async function main() {
  const env = getConfig().paymentEnvironment,
    key = process.env.STRIPE_FEE_READ_KEY;
  if (!key || !key.startsWith(`rk_${env}_`)) throw Error();
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--after')) throw Error();
  const cursor = args[1] && requireUuid(args[1]);
  const db = new Database();
  try {
    await db.onModuleInit();
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
