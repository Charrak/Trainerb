import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cli = require.resolve('prisma/build/index.js');
// With the pinned Prisma client-engine/pg adapter, generate only uses its
// packaged WASM compiler. Prisma 6's CLI otherwise attempts an unnecessary
// native schema-engine download even for generation. These paths are never
// executed; migrations use scripts/migrate.mjs, not Prisma's native engine.
const env = {
  ...process.env,
  PRISMA_SCHEMA_ENGINE_BINARY: process.env.PRISMA_SCHEMA_ENGINE_BINARY || process.execPath,
  PRISMA_QUERY_ENGINE_LIBRARY: process.env.PRISMA_QUERY_ENGINE_LIBRARY || process.execPath,
};
const result = spawnSync(process.execPath, [cli, 'generate', '--schema', 'packages/database/prisma/schema.prisma'], {
  stdio: 'inherit', env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
