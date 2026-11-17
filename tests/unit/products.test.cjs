const { test } = require('node:test');
const assert = require('node:assert/strict');

require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS', moduleResolution: 'Node' } });
const { centsFromInput, centsForInput, utcMinuteFromInput, utcMinuteForInput } = require('../../apps/web/lib/products.ts');

test('price input converts to integer cents without floating point', () => {
  assert.equal(centsFromInput('199'), '19900');
  assert.equal(centsFromInput('199,5'), '19950');
  assert.equal(centsFromInput('0.05'), '5');
  assert.equal(centsFromInput('00012.30'), '1230');
  assert.equal(centsFromInput('0'), '0');
  for (const invalid of ['', '1.234', '1,2,3', '-5', '1e3', ' 12,345', '.5', '199.00 €', '9999999999999']) {
    assert.equal(centsFromInput(invalid), null, invalid);
  }
  assert.equal(centsForInput('19900'), '199.00');
  assert.equal(centsForInput('5'), '0.05');
  assert.equal(centsForInput(null), '');
  assert.equal(centsForInput('0'), '0.00');
});

test('price periods accept only explicit UTC minutes and never local time guesses', () => {
  assert.equal(utcMinuteFromInput('2027-01-01T09:30'), '2027-01-01T09:30Z');
  assert.equal(utcMinuteFromInput('2027-01-01T09:30Z'), null); // the field is UTC-labelled, so a suffix is rejected
  for (const invalid of ['2027-01-01', '2027-02-30T09:30', '2027-01-01T24:00', '1999-12-31T23:59', '2101-01-01T00:00', '', '2027-01-01 09:30']) {
    assert.equal(utcMinuteFromInput(invalid), null, invalid);
  }
  assert.equal(utcMinuteForInput('2027-01-01T09:30:00.000Z'), '2027-01-01T09:30');
  assert.equal(utcMinuteForInput(null), '');
});
