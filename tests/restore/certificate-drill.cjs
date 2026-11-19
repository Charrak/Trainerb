// Invoked by --certificate-restore AFTER the synthetic issuance/revocation tests exit.
// Never restore on top of an existing database. No application or workers run on the copy.
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { PDFDocument } = require('pdf-lib');

const digest = value => createHash('sha256').update(value).digest('hex');
const decryptFailure = 42;
let phase = 'initialization'; // Safe diagnostic labels only; never print child output or credentials.

function pgCommand(program, args, url) {
  // No connection strings on the command line. Backup utilities never receive document keys.
  const env = { PATH: process.env.PATH, PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: url.port || '5432', PGDATABASE: url.pathname.slice(1), PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: '5' };
  const run = spawnSync(program, ['--no-password', ...args], { env, timeout: 120000, stdio: 'ignore' });
  if (run.error || run.status !== 0) throw new Error(`${program} failed; check the PostgreSQL client version, connection and privileges.`);
}

async function fingerprint(url) {
  const { unseal } = require('../../apps/api/dist/security');
  const { getConfig } = require('../../apps/api/dist/config');
  const config = getConfig(); // Invalid unrelated configuration must not pass the wrong-key control.
  const db = new Client({ connectionString: url.href });
  await db.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name, url.pathname.slice(1));
    const { rows } = await db.query(`SELECT c.id,c.status,c.replaces_id,c.document_ciphertext,c.key_id,c.verification_hash,
      c.revoked_at,c.completion_id,r.access_id,r.evidence_snapshot,a.user_id,c.template_id,c.course_version_id
      FROM certificates c JOIN completion_records r ON r.id=c.completion_id JOIN course_access a ON a.id=r.access_id
      JOIN certificate_templates t ON t.id=c.template_id AND t.course_version_id=r.course_version_id
      WHERE t.approved_at IS NOT NULL ORDER BY c.issued_at,c.id`);
    assert.equal(rows.length, 2);
    const old = rows.find(r => r.status === 'revoked'), current = rows.find(r => r.status === 'valid');
    assert.ok(old && current && old.revoked_at && !current.revoked_at && !old.replaces_id && current.replaces_id === old.id);
    assert.equal(old.completion_id, current.completion_id);
    assert.equal(current.evidence_snapshot.exams.length, 84);
    const records = [];
    for (const { document_ciphertext, verification_hash, ...record } of rows) {
      assert.equal(record.key_id, config.encryptionKeyId);
      let doc;
      try { doc = unseal(document_ciphertext, `certificate:${record.id}`, record.key_id); }
      catch { throw new Error('DOCUMENT_UNSEAL_FAILED'); }
      const pdf = Buffer.from(doc.pdf, 'base64');
      assert.equal((await PDFDocument.load(pdf)).getPageCount(), 1);
      assert.ok(doc.snapshot.number === record.id && typeof doc.snapshot.token === 'string' &&
        digest(doc.snapshot.token) === verification_hash.toString('hex'), 'Certificate number or verification lookup does not match');
      records.push({ record, pdf_sha256: digest(pdf), snapshot_sha256: digest(JSON.stringify(doc.snapshot)) });
    }
    await db.query('COMMIT');
    return digest(JSON.stringify(records)); // IDs, PDF bytes, codes and names never leave the verifier.
  } finally { await db.end(); }
}

function inspect(url, key = process.env.DATA_ENCRYPTION_KEY) {
  // Fresh configuration in each verifier process. No SMTP, HTTP or Redis calls.
  return spawnSync(process.execPath, [__filename, '--inspect'], {
    env: { ...process.env, DATABASE_URL: url.href, DATA_ENCRYPTION_KEY: key }, encoding: 'utf8', timeout: 30000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

async function drill(source) {
  assert.ok(process.env.E2E_ALLOW_TEST_DATA === 'yes' && process.env.APP_ENV === 'test' && process.env.NODE_ENV === 'test' &&
    process.env.TRAINERB_DESTRUCTIVE_TEST_DATABASE === 'confirmed' && ['postgres:', 'postgresql:'].includes(source.protocol) &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname) && !source.search && !source.hash &&
    /^\/[a-z0-9_]+_drill_test$/.test(source.pathname), 'Use the isolated restore test runner.');
  phase = 'reading source certificates';
  const baseline = inspect(source);
  assert.ok(baseline.status === 0 && /^[a-f0-9]{64}$/.test(baseline.stdout), 'Could not establish a reference for the original certificates.');
  const name = `cert_restore_${randomUUID().replaceAll('-', '')}_test`;
  const target = new URL(source); target.pathname = `/${name}`;
  const db = new Client({ connectionString: source.href });
  await db.connect();
  const dir = mkdtempSync(join(tmpdir(), 'trainerb-cert-restore-')); // private (0700); synthetic data only
  let created = false;
  try {
    const archive = join(dir, 'fixture.dump');
    phase = 'writing pg_dump archive';
    pgCommand('pg_dump', ['--format=custom', '--file', archive], source);
    // Identifier generated here, NEVER supplied by an operator. If CREATE fails, do not DROP.
    phase = 'creating empty restore target';
    await db.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8'`); created = true;
    phase = 'restoring archive';
    pgCommand('pg_restore', ['--dbname', name, '--single-transaction', '--exit-on-error', '--no-owner', '--no-acl', archive], target);
    phase = 'comparing restored certificates';
    const restored = inspect(target);
    assert.ok(restored.status === 0 && restored.stdout === baseline.stdout, 'Restored certificates differ from the source.');
    phase = 'checking wrong key';
    const wrong = inspect(target, randomBytes(32).toString('base64'));
    assert.ok(wrong.status === decryptFailure && !wrong.stdout, 'Wrong document key must fail authentication, not just the DB connection.');
  } finally {
    try { if (created) await db.query(`DROP DATABASE ${name}`); }
    catch (error) { phase = 'removing temporary database'; throw error; }
    finally { rmSync(dir, { recursive: true, force: true }); await db.end(); }
  }
  console.log('Certificate restore drill passed: both PDFs match, revocation and replacement intact, wrong key rejected. Temporary copy removed.');
}

(async () => {
  const url = new URL(process.env.DATABASE_URL);
  if (process.argv[2] === '--inspect') process.stdout.write(await fingerprint(url));
  else await drill(url);
})().catch(error => {
  // Avoid dumping PG details, ciphertext, test keys or assertion values to logs.
  process.exitCode = error.message === 'DOCUMENT_UNSEAL_FAILED' ? decryptFailure : 1;
  if (process.argv[2] !== '--inspect') console.error(`Certificate restore drill failed during ${phase}. Check the fixture, client versions, CREATEDB permission and cleanup.`);
});
