const { test } = require('node:test');
const assert = require('node:assert/strict');
const { splitGross, sumSplits, groupByRate, rateAt } = require('../../apps/api/dist/tax');

const standard = { rate_bp: 1900, label: '19 %' };
const reduced = { rate_bp: 700, label: '7 %' };
const zero = { rate_bp: 0, label: '0 %' };

test('a gross amount splits into net and tax without losing a cent', () => {
  const split = splitGross(19900n, standard);
  assert.equal(split.gross_cents, 19900n);
  assert.equal(split.tax_cents, 317700n / 100n); // round(19900 × 1900 / 11900) = 3177
  assert.equal(split.net_cents, 16723n);
  // The invariant the database also checks.
  assert.equal(split.gross_cents, split.net_cents + split.tax_cents);
  assert.equal(split.rate_bp, 1900);
  assert.equal(split.label, '19 %');
});

test('a net price of 100,00 EUR at 19 % becomes 119,00 EUR gross', () => {
  const split = splitGross(11900n, standard);
  assert.equal(split.net_cents, 10000n);
  assert.equal(split.tax_cents, 1900n);
});

test('small amounts round half-up and still add up', () => {
  // 0,01 EUR at 19 % → tax rounds to 0, net keeps the cent.
  assert.deepEqual(splitGross(1n, standard), { gross_cents: 1n, net_cents: 1n, tax_cents: 0n,
    rate_bp: 1900, label: '19 %' });
  // 0,05 EUR: 5 × 1900 / 11900 = 0,798 → 1 cent (half-up would be 1, exact rounding is 1).
  assert.equal(splitGross(5n, standard).tax_cents, 1n);
  for (const gross of [1n, 5n, 99n, 999n, 19900n, 123456789n]) {
    const part = splitGross(gross, standard);
    assert.equal(part.net_cents + part.tax_cents, gross, `split of ${gross} must be exact`);
  }
});

test('a reduced rate and a zero rate are supported', () => {
  assert.deepEqual(splitGross(10700n, reduced), { gross_cents: 10700n, net_cents: 10000n,
    tax_cents: 700n, rate_bp: 700, label: '7 %' });
  assert.deepEqual(splitGross(5000n, zero), { gross_cents: 5000n, net_cents: 5000n,
    tax_cents: 0n, rate_bp: 0, label: '0 %' });
});

test('a zero gross amount yields a zero split, and nonsense is refused', () => {
  assert.deepEqual(splitGross(0n, standard), { gross_cents: 0n, net_cents: 0n, tax_cents: 0n,
    rate_bp: 1900, label: '19 %' });
  assert.throws(() => splitGross(-1n, standard), /non-negative/);
  assert.throws(() => splitGross(100n, { rate_bp: -1, label: 'x' }), /basis points/);
  assert.throws(() => splitGross(100n, { rate_bp: 10001, label: 'x' }), /basis points/);
  assert.throws(() => splitGross(100n, { rate_bp: 10000, label: 'x' }), /100 %/);
  assert.throws(() => splitGross(100n, { rate_bp: 19.5, label: 'x' }), /basis points/);
});

test('totals and rate groups keep a mixed document readable', () => {
  const splits = [splitGross(11900n, standard), splitGross(10700n, reduced),
    splitGross(11900n, standard)];
  const total = sumSplits(splits);
  assert.equal(total.gross_cents, 34500n);
  assert.equal(total.net_cents + total.tax_cents, total.gross_cents);
  const groups = groupByRate(splits);
  // Highest rate first: a document lists the standard rate above the reduced one.
  assert.equal(groups.length, 2);
  assert.equal(groups[0].rate_bp, 1900);
  assert.equal(groups[0].gross_cents, 23800n);
  assert.equal(groups[0].tax_cents, 3800n);
  assert.equal(groups[0].net_cents, 20000n);
  assert.equal(groups[1].rate_bp, 700);
  assert.equal(groups[1].tax_cents, 700n);
});

test('the rate for a day comes from the period, never from "the current one"', () => {
  const rows = [
    { category: 'standard', rate_bp: 1600, label: '16 %',
      valid_from: new Date('2020-07-01T00:00:00Z'), valid_until: new Date('2020-12-31T00:00:00Z') },
    { category: 'standard', rate_bp: 1900, label: '19 %',
      valid_from: new Date('2021-01-01T00:00:00Z'), valid_until: null },
  ];
  assert.equal(rateAt(rows, 'standard', new Date('2020-08-01T00:00:00Z')).rate_bp, 1600);
  assert.equal(rateAt(rows, 'standard', new Date('2026-11-15T00:00:00Z')).rate_bp, 1900);
  // A day before the first period has no rate — and no invented one.
  assert.equal(rateAt(rows, 'standard', new Date('2019-01-01T00:00:00Z')), null);
  assert.equal(rateAt(rows, 'unknown', new Date('2026-11-15T00:00:00Z')), null);
  // The end of a period is exclusive: a new rate may start that same day.
  assert.equal(rateAt(rows, 'standard', new Date('2020-12-31T00:00:00Z')), null);
});
