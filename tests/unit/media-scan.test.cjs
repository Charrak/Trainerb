const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:net');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { scanBytes } = require('../../apps/api/dist/media-scan');

test('local INSTREAM scan sends exact bytes and accepts only a complete clamd verdict', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trainerb-clamd-')), path = join(dir, 'socket');
  const sample = Buffer.from('synthetic fixture'), length = Buffer.alloc(4); length.writeUInt32BE(sample.length);
  const frame = Buffer.concat([Buffer.from('zINSTREAM\0'), length, sample, Buffer.alloc(4)]);
  let reply;
  const server = createServer(socket => {
    let data = Buffer.alloc(0);
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length >= frame.length) { assert.deepEqual(data, frame); socket.end(reply); }
    });
  });
  try {
    await new Promise(resolve => server.listen(path, resolve));
    reply = 'stream: OK\0'; assert.equal(await scanBytes(sample, path), 'clean');
    reply = 'stream: Synthetic.Test FOUND\0'; assert.equal(await scanBytes(sample, path), 'infected');
    for (reply of ['stream: OK', 'stream: scanner error ERROR\0', 'bogus OK\0', '']) await assert.rejects(scanBytes(sample, path));
  } finally { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});
