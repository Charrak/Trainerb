const assert = require('node:assert/strict'),
  { test } = require('node:test'),
  { generateKeyPairSync, sign, createHash } = require('node:crypto');
const { verifyApproval, evidenceAreas } = require('../../apps/api/dist/release-approval');
test('production approval is bound to release, origin, complete evidence, verifier and expiry', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const start = Date.parse('2026-01-01T00:00:00.000Z');
  const r = {
    version: 1,
    scope: 'trainerb.production.new-sales',
    commit: '1'.repeat(40),
    origin: 'https://academy.test',
    valid_from: new Date(start).toISOString(),
    valid_until: new Date(start + 86400000).toISOString(),
    evidence: Object.fromEntries(
      evidenceAreas.map((k) => [
        k,
        createHash('sha256')
          .update('fixture-' + k)
          .digest('hex'),
      ]),
    ),
  };
  const check = (doc, over = {}) => {
    const bytes = Buffer.from(JSON.stringify(doc));
    return verifyApproval(
      over.bytes ?? bytes,
      sign(null, bytes, privateKey),
      over.pub ?? pub,
      over.origin ?? r.origin,
      over.commit ?? r.commit,
      over.now ?? start,
    );
  };
  assert.ok(check(r));
  for (const over of [
    { pub: '' },
    { origin: 'https://other.test' },
    { commit: '2'.repeat(40) },
    { bytes: Buffer.from('different') },
    { now: start - 1 },
    { now: start + 86400000 },
  ])
    assert.equal(check(r, over), false);
  for (const alt of [
    { evidence: {} },
    { scope: 'test' },
    { valid_until: new Date(start + 91 * 86400000).toISOString() },
  ])
    assert.equal(check({ ...r, ...alt }), false);
});
