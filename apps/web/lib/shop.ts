export type ShopConfig = { sales_enabled: boolean; payment_term_days: number | null; stripe_enabled: boolean;
  legal: Record<string, { id: string; version: number; wording: string }> };
export type ShopProduct = { id: string; sku: string; type: 'single' | 'bundle'; title: string; variant_name: string | null;
  course_count: number; gross_cents: string; currency: string };
export type ShopProductDetail = { id: string; sku: string; type: 'single' | 'bundle'; title: string; variant_name: string | null;
  description: string | null; gross_cents: string; currency: string;
  courses: { slug: string; title: string; subtitle: string | null; duration_minutes: number | null; access_days: number | null }[] };
export type CartItem = { product_id: string; price_id: string; sku: string; title: string; variant_name: string | null;
  gross_cents: string; list_gross_cents: string; currency: string };
export type Cart = { id: string | null; items: CartItem[]; subtotal_gross_cents: string; currency: string;
  discount_cents?: string; total_gross_cents?: string; coupon_code?: string | null };
export type OrderSummary = { id: string; order_number: string; placed_at: string; payment_state: string;
  fulfillment_state: string; total_gross_cents: string; currency: string };
export type OrderDetail = OrderSummary & { payment_method: 'invoice' | 'stripe'; subtotal_gross_cents: string;
  discount_cents: string; due_at: string | null; paid_at: string | null; payment_reference: string | null;
  billing_snapshot: Record<string, string | null>; coupon_code: string | null;
  items: { product_id: string; title: string; variant: string | null; unit_gross_cents: string; total_gross_cents: string;
    courses: { course_id: string; title: string; access_days: number | null }[] }[];
  acceptances: { kind: string; legal_document_version_id: string }[];
  invoice: { id: string; invoice_number: string; issued_at: string; seller: Record<string, string | null>;
    buyer: Record<string, string | null>; lines: { position: number; title: string; quantity: number;
      unit_gross_cents: string; total_gross_cents: string }[]; total_gross_cents: string; due_at: string | null;
    payment_reference: string | null } | null;
  bank: { holder: string; iban: string; bic: string | null; bank: string | null; reference: string | null } | null;
  access: { course_id: string; revoked: boolean }[] };
export type MyCourse = { course_id: string; slug: string; title: string; subtitle: string | null;
  duration_minutes: number | null; starts_at: string; ends_at: string | null; chapter_count: number;
  completed_count: number };
export type AdminOrder = { id: string; order_number: string; placed_at: string; buyer: { name: string; email: string | null };
  payment_method: string; payment_state: string; fulfillment_state: string; total_gross_cents: string; currency: string;
  items: string[] };

/** German euro formatting from integer cents; never parse the string into a float. */
export function euro(cents: string | number | bigint | null | undefined): string {
  if (cents === null || cents === undefined) return '–';
  const value = typeof cents === 'bigint' ? cents : BigInt(String(cents));
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const padded = absolute.toString().padStart(3, '0');
  const whole = padded.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '-' : ''}${whole},${padded.slice(-2)} €`;
}
export function dateTime(value: string | null): string {
  if (!value) return '–';
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
export function dateOnly(value: string | null): string {
  if (!value) return '–';
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(value));
}
export const paymentStateLabels: Record<string, string> = {
  awaiting: 'Zahlung offen', paid: 'Bezahlt', cancelled: 'Storniert', review: 'Prüfung nötig',
};
export const fulfillmentLabels: Record<string, string> = {
  not_ready: 'Nicht bereit', waiting: 'Wartet auf Zahlung', fulfilled: 'Freigeschaltet', blocked: 'Gesperrt',
};
export const acceptanceLabels: Record<string, string> = {
  terms_accepted: 'AGB akzeptiert', withdrawal_notice_seen: 'Widerrufsbelehrung zur Kenntnis genommen',
  privacy_notice_seen: 'Datenschutzhinweis zur Kenntnis genommen',
};
/** Random, URL-safe idempotency key created once per checkout form. */
export function checkoutKey(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
export const isAdmin = (permissions: string[], roles: string[]) =>
  ['admin', 'superadmin'].some(role => roles.includes(role)) && permissions.includes('orders.read');
