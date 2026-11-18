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
  discount_cents?: string; total_gross_cents?: string; coupon_code?: string | null;
  email_verified?: boolean; email_verification_pending?: boolean };
/** A guest order is identified by the cart cookie, never by a session. */
export type GuestOrder = OrderDetail & { identity_kind: 'account' | 'guest'; buyer_email: string;
  account_linked: boolean };
export type ProofStatus = { email_verified: boolean; email_verification_pending: boolean; email: string | null };
export type OrderSummary = { id: string; order_number: string; placed_at: string; payment_state: string;
  fulfillment_state: string; total_gross_cents: string; currency: string };
export type OrderDetail = OrderSummary & { identity_kind?: 'account' | 'guest'; buyer_email?: string;
  account_linked?: boolean; payment_method: 'invoice' | 'stripe'; subtotal_gross_cents: string;
  discount_cents: string; due_at: string | null; paid_at: string | null; payment_reference: string | null;
  billing_snapshot: Record<string, string | null>; coupon_code: string | null;
  items: { product_id: string; title: string; variant: string | null; unit_gross_cents: string; total_gross_cents: string;
    courses: { course_id: string; title: string; access_days: number | null }[] }[];
  acceptances: { kind: string; legal_document_version_id: string }[];
  invoice: { id: string; invoice_number: string; issued_at: string; seller: Record<string, string | null>;
    buyer: Record<string, string | null>; lines: { position: number; title: string; quantity: number;
      unit_gross_cents: string; total_gross_cents: string }[]; total_gross_cents: string; due_at: string | null;
    payment_reference: string | null; /** null while the order is not paid */ pdf_href: string | null } | null;
  bank: { holder: string; iban: string; bic: string | null; bank: string | null; reference: string | null } | null;
  access: { id: string; course_id: string; revoked: boolean; suspended: boolean;
    suspend_reason: string | null; starts_at: string }[];
  /** staff only: what came back and what can still be returned */
  refunded_at?: string | null;
  refunds?: { id: string; amount_cents: string; status: string; provider: string; reason_code: string;
    requested_at: string; confirmed_at: string | null }[];
  refundable?: { paid_cents: string; refunded_cents: string; refundable_cents: string;
    charged_back_cents: string };
  /** staff only: chargebacks reported by the provider */
  disputes?: { id: string; provider: string; provider_dispute_id: string; amount_cents: string;
    currency: string; status: string; reason_code: string | null; opened_at: string;
    resolved_at: string | null }[] };
export type MyCourse = { course_id: string; slug: string; title: string; subtitle: string | null;
  duration_minutes: number | null; starts_at: string; ends_at: string | null; chapter_count: number;
  completed_count: number; suspended: boolean };
/** An issued invoice in the account overview; the document is one link away. */
export type InvoiceSummary = { id: string; invoice_number: string; issued_at: string; order_id: string;
  order_number: string; total_gross_cents: string; currency: string; payment_state: string };

export type AdminOrder = { id: string; order_number: string; placed_at: string; identity_kind: 'account' | 'guest';
  buyer: { name: string; email: string | null; has_account: boolean };
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
  refunded: 'Erstattet', charged_back: 'Zurückgebucht',
};
export const withdrawalStatusLabels: Record<string, string> = {
  received: 'Eingegangen', identity_check: 'Adresse prüfen', in_progress: 'In Bearbeitung',
  completed: 'Angenommen', rejected: 'Abgelehnt',
};
export type AdminWithdrawal = { id: string; contact_email: string | null; customer_name: string | null;
  status: string; submitted_at: string; submitted_order_number: string | null;
  order_number: string | null; identity_verified_at: string | null; processed_at: string | null;
  decision_reason: string | null; refund_id: string | null;
  contact_email_scrubbed_at?: string | null };

/** One chargeback case as the list shows it. */
export type AdminDispute = { id: string; order_id: string; order_number: string; buyer_email: string | null;
  amount_cents: string; currency: string; status: string; reason_code: string | null;
  opened_at: string; resolved_at: string | null; provider_dispute_id: string;
  sync_source?: 'manual' | 'webhook'; last_synced_at?: string | null };

export const disputeStatusLabels: Record<string, string> = {
  warning: 'Angekündigt', open: 'Offen', won: 'Gewonnen', lost: 'Verloren', closed: 'Geschlossen',
};
export const refundStatusLabels: Record<string, string> = {
  requested: 'Vorschlag offen', pending: 'Beim Anbieter offen', succeeded: 'Erstattet',
  failed: 'Fehlgeschlagen', cancelled: 'Zurückgezogen',
};
export const refundReasons: { code: string; label: string }[] = [
  { code: 'customer_request', label: 'Kundenwunsch' },
  { code: 'withdrawal', label: 'Widerruf' },
  { code: 'goodwill', label: 'Kulanz' },
  { code: 'duplicate_payment', label: 'Doppelzahlung' },
  { code: 'chargeback', label: 'Rückbuchung' },
  { code: 'service_not_delivered', label: 'Leistung nicht erbracht' },
];
/** One issued credit note (correction of an invoice after a refund). */
export type CreditNoteSummary = { id: string; document_number: string; issued_at: string; order_id: string;
  order_number: string; total_gross_cents: string; currency: string; reason_code: string;
  refund_status: string };
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
