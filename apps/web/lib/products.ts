export type ProductType = 'single' | 'bundle';
export type ProductListItem = { id: string; sku: string; type: ProductType; title: string; variant_name: string | null;
  status: string; revision: number; updated_at: string; course_count: number; price_count: number;
  latest_price: { id: string; gross_cents: string; currency: string; valid_from: string } | null };
export type ProductCourseLink = { course_id: string; position: number; access_days_override: number | null;
  slug: string; status: string; visibility: string; title: string | null };
export type PriceDraft = { id: string; product_id: string; currency: string; model: string; gross_cents: string;
  sale_gross_cents: string | null; sale_starts_at: string | null; sale_ends_at: string | null; tax_category: string;
  valid_from: string; valid_until: string | null; status: string; revision: number };
export type ProductDetail = { id: string; sku: string; type: ProductType; title: string; variant_name: string | null;
  description: string | null; status: string; sort_order: number; revision: number; courses: ProductCourseLink[];
  prices: PriceDraft[] };
export type ProductPage<T> = { data: T[]; next_cursor: string | null; total: number };
export type CourseOption = { id: string; slug: string; status: string; visibility: string; draft: { title: string } | null };

/** Integer cents as a decimal string; never a floating-point amount. */
export function centsFromInput(value: string): string | null {
  const text = value.trim().replace(',', '.');
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const cents = `${match[1]}${(match[2] ?? '').padEnd(2, '0')}`.replace(/^0+(?=\d)/, '');
  return /^(?:0|[1-9]\d{0,11})$/.test(cents) ? cents : null;
}
export function centsForInput(cents: string | null): string {
  if (!cents) return '';
  const padded = cents.padStart(3, '0');
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`;
}
/** UTC minute precision, e.g. `2027-01-01T09:30Z`; local times are never guessed. */
export function utcMinuteFromInput(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const normalized = `${text}:00.000Z`, date = new Date(normalized);
  return Number.isFinite(date.getTime()) && date.toISOString() === normalized && Number(match[1]) >= 2000 && Number(match[1]) <= 2100
    ? `${text}Z` : null;
}
export function utcMinuteForInput(value: string | null): string {
  return value ? value.slice(0, 16) : '';
}
export const productTypeLabels: Record<string, string> = { single: 'Einzelprodukt', bundle: 'Paket' };
export const priceStatusLabels: Record<string, string> = { draft: 'Entwurf (nicht aktiv)', active: 'Aktiv', retired: 'Zurückgezogen' };
