const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scanBytes } = require('../../apps/api/dist/media-scan');
const { withTestClamd } = require('./test-clamd.cjs');

test('real clamd: clean, harmless signature match, daemon unavailable', () =>
  withTestClamd(async ({ socket, marked, stop }) => {
    assert.equal(await scanBytes(Buffer.from('TrainerB: harmless control sample.'), socket), 'clean');
    assert.equal(await scanBytes(marked, socket), 'infected');
    await stop();
    await assert.rejects(scanBytes(marked, socket));
  }));
