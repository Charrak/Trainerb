const test = require('node:test'),
  assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Database } = require('../../apps/api/dist/database');
const { assertRuntimeRole } = require('../../apps/api/dist/runtime-role');
// Dedicated CI cluster only. Roles and grants are transactional; never persist a login or a credential.
test(
  'runtime privilege check rejects owner, mutable audit and inherited privileges but accepts a limited role',
  { skip: process.env.TEST_PRIVILEGED_ROLE_CHECK !== 'yes' },
  async () => {
    assert.equal(process.env.APP_ENV, 'test');
    assert.equal(process.env.TRAINERB_DESTRUCTIVE_TEST_DATABASE, 'confirmed');
    assert.match(new URL(process.env.DATABASE_URL).pathname, /_test$/);
    const db = new Database(),
      role = 'guard_' + randomUUID().replaceAll('-', ''),
      elevated = role + '_extra';
    const rollback = new Error('ROLLBACK_TEST');
    try {
      await assert.rejects(
        db.$transaction(async (tx) => {
          await assert.rejects(assertRuntimeRole(tx), /Unsafe database privileges/);
          await tx.$executeRawUnsafe(`CREATE ROLE ${role} NOLOGIN NOINHERIT`);
          await tx.$executeRawUnsafe(`CREATE ROLE ${elevated} NOLOGIN`);
          await tx.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
          await tx.$executeRawUnsafe(`GRANT SELECT,INSERT ON audit_events TO ${role}`);
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
          await assertRuntimeRole(tx);
          await tx.$executeRawUnsafe('RESET ROLE');
          await tx.$executeRawUnsafe(`GRANT UPDATE(action) ON audit_events TO ${elevated}`);
          await tx.$executeRawUnsafe(`GRANT ${elevated} TO ${role}`);
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
          await assert.rejects(assertRuntimeRole(tx), /Unsafe database privileges/);
          throw rollback;
        }),
        (e) => e === rollback,
      );
    } finally {
      await db.$disconnect();
    }
  },
);
