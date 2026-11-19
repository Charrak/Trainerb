const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('restore test refuses unsafe settings before migrations or fixtures', () => {
  const source = 'postgresql://test@127.0.0.1:1/cert_drill_test';
  const env = { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', E2E_ALLOW_TEST_DATA: 'yes',
    DATABASE_URL:'postgresql://127.0.0.1/dev', REDIS_URL:'redis://127.0.0.1/0',
    TEST_DATABASE_URL: source, TEST_REDIS_URL:'redis://127.0.0.1:1/14' };
  for (const bad of [ { E2E_ALLOW_TEST_DATA:'no' }, { NODE_ENV:'production' },
    { TEST_DATABASE_URL:source.replace('cert_drill_test','general_test') },
    { TEST_DATABASE_URL:source.replace('127.0.0.1','other.invalid') },
    { TEST_REDIS_URL:'redis://other.invalid:1/14' }, { TEST_DATABASE_URL:source+'?host=elsewhere.invalid' },
    { TEST_DATABASE_URL:source+'?dbname=another_test' }, { DATABASE_URL:source } ]) {
    const run = spawnSync(process.execPath, ['scripts/run-integration.mjs','--certificate-restore'], {
      env:{ ...env,...bad }, timeout:3000, encoding:'utf8' });
    assert.equal(run.status,1); assert.match(run.stderr,/Restore drill requires|must not point to the application database/);
  }
});
