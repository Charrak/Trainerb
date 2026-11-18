const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { mkdtemp, writeFile, rm, stat } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const { scanBytes } = require('../../apps/api/dist/media-scan');

test('real clamd: clean, harmless signature match, daemon unavailable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trainerb-clamd-'));
  const socket = join(dir, 'socket'), config = join(dir, 'clamd.conf');
  const marked = Buffer.from('TrainerB: synthetic signature fixture, not malware.');
  let daemon, closed;
  try {
    // A test-only hash database; no network, system socket or production signatures.
    const hash = createHash('md5').update(marked).digest('hex');
    await writeFile(join(dir, 'fixture.hdb'), `${hash}:${marked.length}:TrainerB.TestMarker\n`);
    await writeFile(config, `Foreground yes\nLocalSocket ${socket}\nDatabaseDirectory ${dir}\nTemporaryDirectory ${dir}\n`);
    daemon = spawn(process.env.TEST_CLAMD_BINARY || 'clamd', ['--config-file', config], { stdio: ['ignore', 'inherit', 'inherit'] });
    closed = once(daemon, 'close');
    await once(daemon, 'spawn');
    const deadline = Date.now() + 10000;
    while (!await stat(socket).then(s => s.isSocket(), () => false)) {
      assert.ok(daemon.exitCode === null && Date.now() < deadline, 'clamd did not start');
      await delay(50);
    }
    assert.equal(await scanBytes(Buffer.from('TrainerB: harmless control sample.'), socket), 'clean');
    assert.equal(await scanBytes(marked, socket), 'infected');
    daemon.kill(); await closed;
    await assert.rejects(scanBytes(marked, socket));
  } finally {
    if (daemon?.pid && daemon.exitCode === null && !daemon.signalCode) daemon.kill('SIGKILL');
    await closed?.catch(() => {}); await rm(dir, { recursive: true, force: true });
  }
});
