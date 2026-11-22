import { apiError, bodyObject } from './security';
import { uniqueCouponProducts } from './coupon-scope';

const invalid = (field: string, message = 'Ungültiger Wert.'): never => {
  throw apiError(422, 'INVALID_CHECKOUT_FIELD', 'Bitte prüfe deine Angaben.', { [field]: message });
};

/** Free text with a hard length bound; control characters and lone surrogates are rejected. */
export function plainText(value: unknown, field: string, max: number, optional = false, multiline = false): string | null {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string') return invalid(field);
  const text = (multiline ? value.replace(/\r\n/g, '\n') : value).normalize('NFC').trim();
  if (!text) return optional ? null : invalid(field, 'Pflichtfeld.');
  if (Array.from(text).length > max || /\p{Cs}/u.test(text) ||
      Array.from(text).some(char => /\p{Cc}/u.test(char) && !(multiline && char === '\n')) || /[\u2028\u2029]/u.test(text)) return invalid(field);
  return text;
}

/** Postal addresses are stored as validated snapshots; nothing is guessed or completed later. */
export type BillingAddress = {
  company: string | null; first_name: string; last_name: string; street: string; street_extra: string | null;
  postal_code: string; city: string; region: string | null; country: string; vat_id: string | null;
};

const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU',
  'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'CH', 'NO', 'GB', 'LI', 'IS',
]);

export function billingAddress(input: unknown): BillingAddress {
  const body = bodyObject(input, ['company', 'first_name', 'last_name', 'street', 'street_extra', 'postal_code', 'city',
    'region', 'country', 'vat_id']);
  const postal = plainText(body.postal_code, 'postal_code', 16)!;
  if (!/^[A-Za-z0-9][A-Za-z0-9 -]{1,15}$/.test(postal)) throw invalid('postal_code', 'Ungültige Postleitzahl.');
  const country = typeof body.country === 'string' ? body.country.trim().toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(country) || !EU_COUNTRIES.has(country)) throw invalid('country', 'Bitte wähle ein unterstütztes Land.');
  const vatId = plainText(body.vat_id, 'vat_id', 20, true);
  if (vatId && !/^[A-Z]{2}[A-Z0-9]{6,14}$/.test(vatId.replace(/\s+/g, '').toUpperCase())) {
    throw invalid('vat_id', 'Ungültige Umsatzsteuer-Identifikationsnummer.');
  }
  return {
    company: plainText(body.company, 'company', 160, true),
    first_name: plainText(body.first_name, 'first_name', 120)!,
    last_name: plainText(body.last_name, 'last_name', 120)!,
    street: plainText(body.street, 'street', 160)!,
    street_extra: plainText(body.street_extra, 'street_extra', 160, true),
    postal_code: postal,
    city: plainText(body.city, 'city', 120)!,
    region: plainText(body.region, 'region', 120, true),
    country,
    vat_id: vatId ? vatId.replace(/\s+/g, '').toUpperCase() : null,
  };
}

/** Coupon codes are canonicalised the same way at creation and at redemption. */
export function couponCode(value: unknown): string {
  if (typeof value !== 'string') throw invalid('coupon_code', 'Bitte gib einen Gutscheincode ein.');
  const canonical = value.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{4,64}$/.test(canonical)) throw invalid('coupon_code', 'Bitte gib einen gültigen Gutscheincode ein.');
  return canonical;
}

export function optionalCouponCode(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return couponCode(value);
}

export function paymentMethod(value: unknown): 'invoice' | 'stripe' {
  if (value !== 'invoice' && value !== 'stripe') throw invalid('payment_method', 'Bitte wähle eine Zahlungsart.');
  return value;
}

export function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(value)) {
    throw invalid('idempotency_key', 'Bitte lade die Seite neu und versuche es erneut.');
  }
  return value;
}

/** Money is transported as integer cents in decimal strings, never as JSON numbers. */
export function centsString(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,11})$/.test(value)) return invalid(field);
  return BigInt(value);
}

export function couponValues(input: unknown) {
  const body = bodyObject(input, ['code', 'type', 'value', 'currency', 'valid_from', 'valid_until', 'max_redemptions',
    'active', 'product_ids']);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(code)) throw invalid('code', '4–64 Zeichen aus Buchstaben, Ziffern, - und _.');
  const type = body.type === 'percent' || body.type === 'fixed' ? body.type : invalid('type');
  if (typeof body.value !== 'number' || !Number.isSafeInteger(body.value) || body.value < 1) return invalid('value');
  if (type === 'percent' && body.value > 10_000) return invalid('value', 'Höchstens 100 %.');
  const currency = type === 'fixed' ? 'EUR' : null;
  if (type === 'fixed' && body.value > 1_000_000) return invalid('value', 'Betrag zu hoch.');
  const validFrom = body.valid_from === undefined || body.valid_from === null ? new Date()
    : new Date(String(body.valid_from));
  if (!Number.isFinite(validFrom.getTime())) return invalid('valid_from');
  const validUntil = body.valid_until === undefined || body.valid_until === null ? null : new Date(String(body.valid_until));
  if (validUntil && (!Number.isFinite(validUntil.getTime()) || validUntil <= validFrom)) return invalid('valid_until');
  const max = body.max_redemptions === undefined || body.max_redemptions === null ? null : body.max_redemptions;
  if (max !== null && (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1 || max > 1_000_000)) {
    return invalid('max_redemptions');
  }
  let productIds: string[];
  try {
    productIds = uniqueCouponProducts(body.product_ids);
  } catch {
    // Mehr als 50 Produkte, Duplikate in falscher Form oder keine UUID: alles
    // endet hier als Feldhinweis und nicht als Serverfehler.
    return invalid('product_ids', 'Bitte höchstens 50 gültige Produkte auswählen.');
  }
  return { code_original: code, code_canonical: code.toUpperCase(), type, value: BigInt(body.value), currency,
    valid_from: validFrom, valid_until: validUntil, max_redemptions: max,
    active: body.active === undefined ? false : body.active === true, product_ids: productIds };
}

/**
 * Discount for one order. Percent values are in basis points so that no
 * floating-point rounding can ever decide a price. The result is clamped so a
 * payable order never becomes cheaper than one cent.
 */
export function discountFor(type: string, value: bigint, subtotal: bigint): bigint {
  if (subtotal <= 0n) return 0n;
  const raw = type === 'percent' ? (subtotal * value) / 10_000n : value;
  if (raw >= subtotal) return subtotal - 1n;
  return raw > 0n ? raw : 0n;
}
