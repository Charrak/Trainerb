const test = require('node:test'), assert = require('node:assert/strict');
const { couponScopeMismatch, couponScopeMessage, uniqueCouponProducts, isCouponProductId,
  COUPON_PRODUCT_LIMIT } = require('../../apps/api/dist/coupon-scope');

const p1 = '0190a000-0000-7000-8000-000000000001';
const p2 = '0190A000-0000-7000-8000-000000000002';
const p3 = '0190a000-0000-7000-8000-000000000003';

test('ein Gutschein ohne Produktliste deckt jeden Warenkorb ab', () => {
  assert.deepEqual(couponScopeMismatch([], [{ product_id: p1, title: 'Kurs A' }]), []);
  assert.deepEqual(couponScopeMismatch([], []), []);
});

test('ein Gutschein mit Liste gilt nur, wenn jedes Produkt freigegeben ist', () => {
  const cart = [{ product_id: p1, title: 'Kurs A' }, { product_id: p2, title: 'Kurs B' }];
  assert.deepEqual(couponScopeMismatch([p1, p2], cart), []);
  assert.deepEqual(couponScopeMismatch([p1], cart), [{ product_id: p2, title: 'Kurs B' }]);
  // Auch ein Warenkorb ganz ohne freigegebenes Produkt wird vollständig gemeldet.
  assert.equal(couponScopeMismatch([p3], cart).length, 2);
});

test('die Meldung nennt die betroffenen Artikel und nicht die abgedeckten', () => {
  const one = couponScopeMessage([{ product_id: p2, title: 'Kurs B' }]);
  assert.match(one, /„Kurs B“/);
  assert.match(one, /den Artikel/);
  const two = couponScopeMessage([{ product_id: p2, title: 'Kurs B' },
    { product_id: p3, title: 'Kurs C' }]);
  assert.match(two, /„Kurs B“ und „Kurs C“/);
  assert.match(two, /diese Artikel/);
  // Kein HTML, keine Steuerzeichen: der Titel kommt aus der Datenbank, die
  // Meldung ist reiner Text und wird im Browser escaped.
  const plain = couponScopeMessage([{ product_id: p2, title: 'A & B <script>' }]);
  assert.match(plain, /A & B <script>/);
  assert.doesNotMatch(plain, /<b>|&lt;/);
});

test('Produktlisten werden normalisiert, begrenzt und auf UUIDs geprüft', () => {
  assert.deepEqual(uniqueCouponProducts(undefined), []);
  assert.deepEqual(uniqueCouponProducts([]), []);
  // Groß-/Kleinschreibung derselben UUID ist dieselbe Zeile; die Reihenfolge bleibt stabil.
  assert.deepEqual(uniqueCouponProducts([p1, p2, p1]), [p1, p2.toLowerCase()]);
  for (const bad of ['keine-uuid', [p1, '0190a000'], [1], {}, [p1, p1, 'x'],
    Array.from({ length: COUPON_PRODUCT_LIMIT + 1 }, (_, i) =>
      `0190a000-0000-7000-8000-${String(i).padStart(12, '0')}`)]) {
    assert.throws(() => uniqueCouponProducts(bad), /INVALID_COUPON_PRODUCTS/);
  }
  assert.equal(isCouponProductId(p1), true);
  assert.equal(isCouponProductId(p1.toUpperCase()), true);
  assert.equal(isCouponProductId(''), false);
  assert.equal(isCouponProductId(null), false);
});
