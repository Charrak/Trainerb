const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizePersonName } = require('@trainerb/contracts');
const { normalizeEmail, bodyObject } = require('../../apps/api/dist/security');

test('names are normalized using the documented Unicode character sets', () => {
  const samples = [
    ['\u00a0\u200bÉléonore\u202f', 'Éléonore'],
    ["  O’Connor-Smith\t", 'O’Connor-Smith'],
    [' محمد\u200cرضا ', 'محمد\u200cرضا'],
    ['\u200dA\u2060', '\u200dA\u2060'],
    ['😀'.repeat(120), '😀'.repeat(120)],
  ];
  for (const [input, expected] of samples) assert.deepEqual(normalizePersonName(input), { ok: true, value: expected });
});

test('missing, empty, non-content, controls and names over 120 codepoints are rejected', () => {
  for (const input of [undefined, null, 5, '', ' \u00a0\u200b\u202f', '\u200c\u200d\u2060',
    'A\nB', 'A\u2028B', 'A\0B', '\ud800', '😀'.repeat(121)]) {
    assert.equal(normalizePersonName(input).ok, false, `unexpectedly valid: ${String(input)}`);
  }
});

test('addresses are canonicalized without assuming provider-specific alias rules', () => {
  assert.equal(normalizeEmail(' Test+Kurs@BÜCHER.de ').canonical, 'test+kurs@xn--bcher-kva.de');
  for (const invalid of ['foo', 'a@@example.org', 'a..b@example.org', 'a@-bad.example', 'a@localhost', 'bad name@example.org', 'a\u2028b@example.org', 'ü'.repeat(33) + '@example.org', null]) {
    assert.throws(() => normalizeEmail(invalid));
  }
});

test('strict DTOs reject unknown fields', () => {
  assert.throws(() => bodyObject({ first_name: 'A', role: 'admin' }, ['first_name']));
  assert.deepEqual(bodyObject({ first_name: 'A' }, ['first_name']), { first_name: 'A' });
});
