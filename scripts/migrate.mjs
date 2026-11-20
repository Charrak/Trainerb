import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import 'dotenv/config';

// Versioned SQL is applied under a PostgreSQL advisory lock, with a checksum
// and one transaction per migration. No destructive reset is performed.
if (process.env.APP_ENV === 'production' && !process.env.DATABASE_MIGRATION_URL) {
  throw new Error('Production migrations require a separate DATABASE_MIGRATION_URL.');
}
const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL is required.');
const migrationsDir = resolve(fileURLToPath(new URL('../packages/database/prisma/migrations/', import.meta.url)));
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtext('trainerb_schema_migrations'))");
  await client.query(`CREATE TABLE IF NOT EXISTS _trainerb_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const folders = (await readdir(migrationsDir, { withFileTypes: true }))
    .filter(d => d.isDirectory()).map(d => d.name).sort();
  const applied = (await client.query('SELECT name, checksum FROM _trainerb_migrations')).rows;
  for (const row of applied) {
    if (!folders.includes(row.name)) throw new Error(`Applied migration missing from repository: ${row.name}`);
  }
  for (const name of folders) {
    const sql = await readFile(resolve(migrationsDir, name, 'migration.sql'), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const old = applied.find(row => row.name === name);
    if (old) {
      if (old.checksum !== checksum) throw new Error(`Applied migration was modified: ${name}`);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO _trainerb_migrations(name, checksum) VALUES ($1, $2)', [name, checksum]);
      await client.query('COMMIT');
      console.log(`Applied ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  console.log('Migrations are up to date.');
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('trainerb_schema_migrations'))").catch(() => {});
  await client.end();
}
