/**
 * Produktbeschränkung von Gutscheinen.
 *
 * Ein Gutschein ohne Produktliste gilt für den gesamten Warenkorb. Mit
 * Produktliste gilt er nur, wenn **jedes** Produkt im Warenkorb ausdrücklich
 * freigegeben ist. Teilmengen werden bewusst nicht rabattiert: sonst stünde im
 * Warenkorb ein Rabatt, der sich keiner Position eindeutig zuordnen lässt, und
 * Rechnung und Gutschrift müssten den Rabatt nachträglich aufteilen.
 */
export const COUPON_PRODUCT_LIMIT = 50;

/** Ein Produkt, das der Gutschein nicht abdeckt, mit lesbarem Namen für die Meldung. */
export type CouponScopeMismatch = { product_id: string; title: string };

export function isCouponProductId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Normalisiert die Produktliste einer Vorlage: Duplikate fallen weg, die
 * Reihenfolge bleibt stabil, damit Audits und Antworten vergleichbar sind.
 */
export function uniqueCouponProducts(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > COUPON_PRODUCT_LIMIT || !input.every(isCouponProductId)) {
    throw new Error('INVALID_COUPON_PRODUCTS');
  }
  return [...new Set(input.map(id => id.toLowerCase()))];
}

/**
 * Prüft einen Warenkorb gegen die freigegebenen Produkte.
 *
 * `products` ist leer, wenn der Gutschein nicht beschränkt ist. Dann gibt es
 * nie eine Abweichung. Fehlende Namen werden nicht erfunden: Ist ein Produkt
 * unbekannt, bleibt nur die ID in der Meldung.
 */
export function couponScopeMismatch(
  products: readonly string[],
  cart: readonly { product_id: string; title: string }[],
): CouponScopeMismatch[] {
  if (!products.length) return [];
  const allowed = new Set(products);
  return cart.filter(line => !allowed.has(line.product_id))
    .map(line => ({ product_id: line.product_id, title: line.title }));
}

/** Deutsche Meldung, die den oder die nicht abgedeckten Artikel nennt. */
export function couponScopeMessage(mismatch: readonly CouponScopeMismatch[]): string {
  const titles = mismatch.map(item => `„${item.title}“`);
  const list = titles.length === 1 ? titles[0]
    : `${titles.slice(0, -1).join(', ')} und ${titles[titles.length - 1]}`;
  return `Dieser Gutscheincode gilt nicht für ${list}. Bitte entferne ${titles.length === 1 ? 'den Artikel' : 'diese Artikel'} oder verwende einen anderen Code.`;
}
