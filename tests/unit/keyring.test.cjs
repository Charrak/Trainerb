const test = require('node:test'),
  assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path'),
  { tmpdir } = require('node:os');
const { previousKeys } = require('../../apps/api/dist/keyring');
test('decryption ring requires unique ids and independent canonical keys without exposing malformed secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'test-keys-')),
    file = join(dir, 'keys'),
    reserved = [Buffer.alloc(32, 1)],
    old = { id: 'old', key: Buffer.alloc(32, 2).toString('base64') };
  try {
    assert.equal(previousKeys('', 'active', reserved).size, 0);
    for (const data of [
      [{ ...old, id: 'active' }],
      [old, old],
      [old, { ...old, id: 'other' }],
      [{ ...old, key: reserved[0].toString('base64') }],
      [{ ...old, key: 'secret-invalid' }],
      {},
      [null],
    ]) {
      writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
      assert.throws(() => previousKeys(file, 'active', reserved), { message: 'Invalid DATA_DECRYPTION_KEYS_FILE.' });
    }
    writeFileSync(file, JSON.stringify([old]));
    assert.deepEqual(previousKeys(file, 'active', reserved).get('old'), Buffer.alloc(32, 2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
