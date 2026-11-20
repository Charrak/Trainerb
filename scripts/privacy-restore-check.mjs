/** Quiesced DB only. Compare to independently held, current evidence, NEVER to the archive being checked. */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
export async function fingerprintPrivacy(db) {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    // A restored case/audit marker is not sufficient if the erased profile actually reappeared.
    const invalid =
      await db.query(`SELECT EXISTS(SELECT FROM data_requests r LEFT JOIN users u ON u.id=r.erased_user_id WHERE r.profile_erased_at IS NOT NULL AND
   (u.id IS NULL OR u.status<>'deleted' OR u.password_hash IS NOT NULL OR u.first_name IS NOT NULL OR u.last_name IS NOT NULL OR u.email_original IS NOT NULL OR u.email_canonical IS NOT NULL OR
    EXISTS(SELECT FROM billing_profiles b WHERE b.user_id=r.erased_user_id) OR EXISTS(SELECT FROM auth_sessions s WHERE s.user_id=r.erased_user_id AND s.revoked_at IS NULL))) AS invalid`);
    if (invalid.rows[0].invalid) throw Error('ERASURE_NOT_PRESERVED');
    const hash = createHash('sha256').update('trainerb-privacy-check-v1\n');
    await db.query(`DECLARE privacy_evidence NO SCROLL CURSOR FOR SELECT kind,ref,detail FROM (
    SELECT 'erase' AS kind,id AS ref,erased_user_id::text AS detail FROM data_requests WHERE profile_erased_at IS NOT NULL
    UNION ALL SELECT 'consent',id,subscriber_id::text||':'||epoch::text||':'||action||':'||policy FROM newsletter_consent_events
    UNION ALL SELECT 'mail-state',id,status||':'||coalesce(epoch::text,'')||':'||coalesce(topic,'')||':'||coalesce(policy,'') FROM newsletter_subscribers WHERE status<>'pending'
    UNION ALL SELECT 'suppression',id,target_ref FROM audit_events WHERE action='newsletter.suppressed'
   ) ledger ORDER BY kind COLLATE "C",ref`);
    for (;;) {
      const { rows } = await db.query('FETCH FORWARD 1000 FROM privacy_evidence');
      for (const r of rows) hash.update(JSON.stringify([r.kind, r.ref, r.detail]) + '\n');
      if (rows.length < 1000) break;
    }
    await db.query('COMMIT');
    return hash.digest('hex');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}
export function matchPrivacy(expected, actual) {
  if (!/^[0-9a-f]{64}$/.test(expected ?? '') || expected !== actual) throw Error('PRIVACY_CHECK_MISMATCH');
}
async function main() {
  const mode = process.argv[2];
  if (!['capture', 'verify'].includes(mode) || process.argv.length !== 3 || !process.env.PRIVACY_READONLY_DATABASE_URL)
    throw Error();
  const db = new Client({ connectionString: process.env.PRIVACY_READONLY_DATABASE_URL, connectionTimeoutMillis: 5000 });
  await db.connect();
  try {
    const actual = await fingerprintPrivacy(db);
    if (mode === 'capture') console.log(actual);
    else {
      matchPrivacy(process.env.PRIVACY_EXPECTED_SHA256, actual);
      console.log('Verglichener Datenschutzstand stimmt überein. Keine Betriebsfreigabe.');
    }
  } finally {
    await db.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('Datenschutz-Abgleich fehlgeschlagen. Keine Wiederinbetriebnahme, Vorgänge einzeln abgleichen.');
    process.exitCode = 1;
  });
