const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

test('probe reports only known signals and rejects incomplete observations', async () => {
  const { evaluate, indicators } = await import('../../scripts/operations-probe.mjs');
  const row = Object.fromEntries(indicators.map(key => [key, false]));
  assert.deepEqual(evaluate([row]), {version:1,status:'ok',alerts:[]});
  for (const key of indicators) {
    assert.deepEqual(evaluate([{...row, [key]:true, raw:'must never be returned'}]), {version:1,status:'critical',alerts:[key]});
    assert.throws(() => evaluate([{...row,[key]:null}]));
  }
  assert.throws(() => evaluate([])); assert.throws(() => evaluate([row,row]));
});

test('CLI never uses the application DSN as a fallback or logs the monitor DSN on failure', () => {
  for (const dsn of ['', 'postgresql://fixture:secret@127.0.0.1:1/fixture_test']) {
    const r = spawnSync(process.execPath, ['scripts/operations-probe.mjs'], { encoding:'utf8',timeout:10000,
      env:{MONITOR_READONLY_DATABASE_URL:dsn,DATABASE_URL:'postgresql://secret@unused/unused'} });
    assert.equal(r.status,3); assert.equal(r.stderr,'');
    assert.deepEqual(JSON.parse(r.stdout),{version:1,status:'unknown'});
  }
});
