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

test('standalone scanner needs no API secrets and rejects invalid storage or credentials', () => {
  const { scanConfig } = require('../../apps/api/dist/media-scan-config');
  const env = { DATABASE_URL: 'postgresql://worker@db/test', MEDIA_S3_ENDPOINT: 'https://objects.example.invalid',
    MEDIA_S3_REGION: 'eu-central-1', MEDIA_QUARANTINE_BUCKET: 'private-quarantine', MEDIA_SCAN_ACCESS_KEY_ID: 'reader',
    MEDIA_SCAN_SECRET_ACCESS_KEY: 'unit-test-only', MEDIA_SCAN_CLAMD_SOCKET: '/tmp/clamd.sock' };
  assert.equal(scanConfig(env).store.bucket, env.MEDIA_QUARANTINE_BUCKET);
  for (const key of Object.keys(env)) assert.throws(() => scanConfig({ ...env, [key]: '' }));
  for (const invalid of [{ MEDIA_S3_ENDPOINT: 'http://objects.example.invalid' }, { MEDIA_S3_ENDPOINT: 'https://host/path' },
    { MEDIA_SCAN_CLAMD_SOCKET: 'relative' }, { MEDIA_S3_BUCKET: env.MEDIA_QUARANTINE_BUCKET },
    { MEDIA_QUARANTINE_ACCESS_KEY_ID: 'reader' }, { MEDIA_S3_ACCESS_KEY_ID: 'reader' }]) {
    assert.throws(() => scanConfig({ ...env, ...invalid }));
  }
});

test('promotion only accepts a separate destination and dedicated identity, without API/scan secrets', () => {
  const { promotionConfig } = require('../../apps/api/dist/media-scan-config');
  const env = { DATABASE_URL: 'postgresql://worker@db/test', MEDIA_S3_ENDPOINT: 'https://objects.example.invalid',
    MEDIA_S3_REGION: 'eu-central-1', MEDIA_QUARANTINE_BUCKET: 'private-quarantine', MEDIA_S3_BUCKET: 'delivery-private',
    MEDIA_PROMOTE_ACCESS_KEY_ID: 'promoter', MEDIA_PROMOTE_SECRET_ACCESS_KEY: 'unit-test-only' };
  assert.equal(promotionConfig(env).destination.bucket, 'delivery-private');
  assert.equal(promotionConfig(env).source.bucket, 'private-quarantine');
  for (const key of Object.keys(env)) assert.throws(() => promotionConfig({ ...env, [key]: '' }));
  for (const override of [{ MEDIA_S3_BUCKET: env.MEDIA_QUARANTINE_BUCKET }, { MEDIA_S3_BUCKET: '../public' },
    { MEDIA_SCAN_ACCESS_KEY_ID: 'promoter' }, { MEDIA_QUARANTINE_ACCESS_KEY_ID: 'promoter' }, { MEDIA_S3_ACCESS_KEY_ID: 'promoter' }]) {
    assert.throws(() => promotionConfig({ ...env, ...override }));
  }
});
