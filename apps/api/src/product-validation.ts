import { apiError, bodyObject, requireUuid } from './security';

const MAX_CENTS = 100_000_000_000n;
const invalid = (field: string): never => {
  throw apiError(422, 'INVALID_PRODUCT_FIELD', 'Bitte prüfe die Produkt- und Preisangaben.', { [field]: 'Ungültiger Wert.' });
};

export function productText(value: unknown, field: string, max: number, optional = false, multiline = false): string | null {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string') return invalid(field);
  const text = value.normalize('NFC').trim();
  if (!text && optional) return null;
  if (!text || !text.replace(/[\p{White_Space}\u200b-\u200d\u2060\ufeff]/gu, '') || Array.from(text).length > max ||
      /\p{Cs}/u.test(text) || Array.from(text).some(c => /\p{Cc}/u.test(c) && !(multiline && ['\n', '\r', '\t'].includes(c))) ||
      (!multiline && /[\u2028\u2029]/u.test(text))) return invalid(field);
  return text;
}
export function productSku(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || !/^[A-Z0-9]+(?:[-_][A-Z0-9]+)*$/.test(value)) return invalid('sku');
  return value;
}
export function productType(value: unknown): 'single' | 'bundle' {
  if (value !== 'single' && value !== 'bundle') return invalid('type');
  return value;
}
export function productInteger(value: unknown, field: string, min: number, max: number, optional = false): number | null {
  if ((optional || field === 'sort_order') && (value === undefined || value === null)) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return invalid(field);
  return value;
}
export const productRevision = (value: unknown): number => productInteger(value, 'revision', 1, 2_147_483_646)!;

export function courseAssignments(value: unknown): { course_id: string; access_days_override: number | null }[] {
  if (!Array.isArray(value) || value.length > 20) return invalid('courses');
  const seen = new Set<string>();
  return value.map(raw => {
    const item = bodyObject(raw, ['course_id', 'access_days_override']);
    if (typeof item.course_id !== 'string') return invalid('courses');
    let id: string;
    try { id = requireUuid(item.course_id).toLowerCase(); } catch { return invalid('courses'); }
    if (seen.has(id)) return invalid('courses');
    seen.add(id);
    return { course_id: id, access_days_override: productInteger(item.access_days_override, 'access_days_override', 1, 36500, true) };
  });
}

function cents(value: unknown, field: string, optional = false): bigint | null {
  if (optional && (value === undefined || value === null)) return null;
  // Decimal strings only: JSON numbers and floating-point amounts are never accepted.
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,11})$/.test(value)) return invalid(field);
  const amount = BigInt(value);
  if (amount > MAX_CENTS) return invalid(field);
  return amount;
}
/** Accepts only explicit UTC instants without sub-minute precision ("2027-01-01T09:30Z"). */
function utcMinute(value: unknown, field: string, optional = false): Date | null {
  if (optional && (value === undefined || value === null)) return null;
  const match = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::00(?:\.000)?)?Z$/.exec(value) : null;
  if (!match) return invalid(field);
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00.000Z`;
  const year = Number(match[1]);
  if (year < 2000 || year > 2100) return invalid(field);
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized) return invalid(field);
  return date;
}
/** The stored UTC draft value, suitable as the default body of a partial update. */
export function utcMinuteString(value: Date): string {
  return value.toISOString().replace(':00.000Z', 'Z');
}

/** Fully validate a price after merging an update with the current draft. */
export function priceValues(input: unknown) {
  const body = bodyObject(input, ['currency', 'gross_cents', 'sale_gross_cents', 'sale_starts_at', 'sale_ends_at', 'tax_category', 'valid_from', 'valid_until']);
  if (body.currency !== 'EUR') return invalid('currency');
  const gross = cents(body.gross_cents, 'gross_cents')!;
  const sale = cents(body.sale_gross_cents, 'sale_gross_cents', true);
  const validFrom = utcMinute(body.valid_from, 'valid_from')!;
  const validUntil = utcMinute(body.valid_until, 'valid_until', true);
  const saleFrom = utcMinute(body.sale_starts_at, 'sale_starts_at', true);
  const saleUntil = utcMinute(body.sale_ends_at, 'sale_ends_at', true);
  if (typeof body.tax_category !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(body.tax_category)) return invalid('tax_category');
  if (validUntil && validUntil <= validFrom) return invalid('valid_until');
  if ((sale !== null || saleFrom !== null || saleUntil !== null) &&
      (sale === null || saleFrom === null || saleUntil === null || sale > gross || saleFrom < validFrom || saleUntil <= saleFrom ||
       (validUntil !== null && saleUntil > validUntil))) return invalid('sale_gross_cents');
  return { currency: 'EUR', model: 'one_time', gross_cents: gross, sale_gross_cents: sale,
    sale_starts_at: saleFrom, sale_ends_at: saleUntil, tax_category: body.tax_category,
    valid_from: validFrom, valid_until: validUntil };
}
