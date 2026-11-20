/** Scheduler entry point. No .env loader, HTTP endpoint or operational writes. */
import { Client } from 'pg';
import { pathToFileURL } from 'node:url';

export const indicators = Object.freeze([
  'mail_overdue', 'mail_lease_stalled', 'mail_failed_24h', 'certificate_stalled',
  'scan_overdue', 'scan_failed_24h', 'promotion_stalled', 'paid_unfulfilled',
]);

export function evaluate(rows) {
  if (rows.length !== 1 || !indicators.every(key => typeof rows[0]?.[key] === 'boolean'))
    throw Error('Probe contract mismatch');
  const alerts = indicators.filter(key => rows[0][key]);
  return { version: 1, status: alerts.length ? 'critical' : 'ok', alerts };
}

export async function check(db) {
  // READ ONLY even if the monitor login was accidentally granted extra rights.
  await db.query('BEGIN READ ONLY');
  try {
    await db.query("SET LOCAL statement_timeout = '5s'");
    const { rows } = await db.query(`SELECT ${indicators.join(', ')} FROM public.operations_probe_v1`);
    const report = evaluate(rows);
    await db.query('COMMIT');
    return report;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const url = new URL(process.env.MONITOR_READONLY_DATABASE_URL);
  if (process.argv.length !== 2 || !['postgresql:', 'postgres:'].includes(url.protocol) || !url.hostname ||
      url.pathname.length < 2 || !url.username) throw Error('Invalid monitor configuration');
  const db = new Client({ connectionString: url.href, application_name: 'trainerb_operations_probe',
    connectionTimeoutMillis: 4000, query_timeout: 7000 });
  // Do not let a dropped idle connection print driver details to stderr.
  let disconnected = false;
  db.on('error', () => { disconnected = true; });
  let report;
  try {
    await db.connect();
    report = await check(db);
    if (disconnected) throw Error();
  } finally { await db.end(); }
  console.log(JSON.stringify(report));
  process.exitCode = report.status === 'ok' ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    // Configuration, DB errors and timeouts are never a healthy observation.
    console.log(JSON.stringify({ version: 1, status: 'unknown' }));
    process.exitCode = 3;
  });
