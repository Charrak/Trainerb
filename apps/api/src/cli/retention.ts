import 'reflect-metadata';
import { Database } from '../database';
import { RETENTION_DAYS, runRetention } from '../retention';

/**
 * One retention pass, meant for a scheduled job (cron/systemd timer), not for a
 * web request: it touches many rows and must be able to take its time.
 *
 *   npm run retention:run             # apply
 *   npm run retention:run -- --dry-run
 *
 * The report goes to stdout as JSON and, when applied, into the audit log. A
 * failure exits non-zero so a scheduler notices.
 */
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const db = new Database();
  try {
    await db.$connect();
    const report = await db.$transaction(tx => runRetention(tx, { dryRun }), { timeout: 120_000 });
    console.log(JSON.stringify({ level: 'info', event: dryRun ? 'retention.dry_run' : 'retention.done',
      periods: RETENTION_DAYS, report }, null, 2));
  } finally {
    await db.$disconnect();
  }
}
main().catch(() => { console.error(JSON.stringify({ level: 'error', event: 'retention.failed' }));
  process.exitCode = 1; });
