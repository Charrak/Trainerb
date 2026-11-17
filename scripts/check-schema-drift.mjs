import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

/**
 * Guard against schema drift between `schema.prisma` and the SQL migrations.
 *
 * Prisma's `migrate diff` needs the native schema engine, which is not available
 * in every environment, so this check compares the parts that actually break at
 * runtime: every column a Prisma model maps to must exist in the migrated
 * database. It has already caught one real bug (a nullable owner that the
 * migration forgot), so it runs as part of the integration setup.
 *
 * Usage: node scripts/check-schema-drift.mjs  (needs DATABASE_URL)
 */
const schema = readFileSync(new URL('../packages/database/prisma/schema.prisma', import.meta.url), 'utf8');

/** Parse `model X { ... }` blocks into table name -> Prisma field names. */
function models() {
  const result = new Map();
  for (const block of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, name, body] = block;
    const map = /@@map\("([^"]+)"\)/.exec(body);
    const table = map ? map[1] : name;
    const columns = [];
    // Model-level relation fields have no scalar type; collect them once so they
    // can be skipped even when the relation attribute sits on the next line.
    const relationFields = new Set();
    for (const match of body.matchAll(/^\s{2}(\w+)\s+(\w+)(\[\])?\??\s+(@relation\s*\(|\w+\s+@relation)/gm)) {
      relationFields.add(match[1]);
    }
    // A field whose type is another model name is a relation, not a column.
    const modelNames = new Set([...schema.matchAll(/^model\s+(\w+)/gm)].map(match => match[1]));
    for (const line of body.split('\n')) {
      const field = /^\s{2}(\w+)\s+(\w+)(\[\])?(\?)?/.exec(line);
      if (!field) continue;
      const [, fieldName, fieldType] = field;
      if (fieldName.startsWith('@@')) continue;
      if (relationFields.has(fieldName) || modelNames.has(fieldType)) continue;
      if (fieldType === 'Unsupported') continue;
      const explicitMap = /@map\("([^"]+)"\)/.exec(line);
      columns.push(explicitMap ? explicitMap[1] : fieldName);
    }
    result.set(table, columns);
  }
  return result;
}

const databaseUrl = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  console.error('Set DATABASE_URL to the migrated database before running this check.');
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();
const problems = [];
try {
  const { rows } = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`);
  const existing = new Map();
  for (const row of rows) {
    if (!existing.has(row.table_name)) existing.set(row.table_name, new Set());
    existing.get(row.table_name).add(row.column_name);
  }
  for (const [table, columns] of models()) {
    if (!existing.has(table)) { problems.push(`missing table ${table}`); continue; }
    for (const column of columns) {
      if (!existing.get(table).has(column)) problems.push(`missing column ${table}.${column}`);
    }
  }
} finally {
  await client.end();
}

if (problems.length) {
  console.error(`Schema drift detected (${problems.length}):`);
  for (const problem of problems.slice(0, 50)) console.error(` - ${problem}`);
  process.exit(1);
}
console.log('Schema and migrations agree.');
