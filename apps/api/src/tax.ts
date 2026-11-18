import type { Prisma } from '@prisma/client';
/**
 * Turnover tax (Umsatzsteuer) for a position, derived from a gross amount.
 *
 * Prices in this shop are entered and shown **gross** — that is what a buyer
 * sees and what the price row stores. The net and the tax are therefore always
 * *derived*, never typed, and the derivation is the same integer arithmetic the
 * database constraint re-checks:
 *
 *   tax = round(gross × rate_bp / (10000 + rate_bp))
 *   net = gross − tax
 *
 * Integers only: a cent that appears out of nowhere on a document is worse than
 * a rounding difference of one cent, and `gross = net + tax` must hold exactly.
 *
 * Rates are basis points (1900 = 19 %) and come from the `tax_rates` table, so a
 * change is a new row with its own validity period rather than a code change.
 * This module only does the maths; choosing *which* rate applies is a decision
 * of the caller and is recorded on the position.
 */
export type TaxSplit = { gross_cents: bigint; net_cents: bigint; tax_cents: bigint;
  rate_bp: number; label: string };

export type TaxRateRow = { rate_bp: number; label: string };

/** The little bit of the client these helpers need; keeps them testable. */
export type TaxRateReader = { taxRate: { findMany: (args: {
  where: { category: { in: string[] }; valid_from: { lte: Date };
    OR: Array<{ valid_until: null } | { valid_until: { gt: Date } }> };
  orderBy: { valid_from: 'desc' } }) => Promise<Array<{ category: string; rate_bp: number; label: string }>> } };

/**
 * Split a gross amount with a rate given in basis points.
 *
 * Rounding is half-up on the tax, then the net is the remainder — that keeps
 * `gross = net + tax` true by construction instead of by hope.
 */
export function splitGross(grossCents: bigint, rate: TaxRateRow): TaxSplit {
  if (grossCents < 0n) throw new Error('A tax split needs a non-negative gross amount.');
  if (!Number.isInteger(rate.rate_bp) || rate.rate_bp < 0 || rate.rate_bp > 10_000) {
    throw new Error('A tax rate must be between 0 and 10000 basis points.');
  }
  // 100 % tax is nonsense for a sale and would make the divisor ambiguous.
  if (rate.rate_bp === 10_000) throw new Error('A tax rate of 100 % is not a sale.');
  const denominator = BigInt(10_000 + rate.rate_bp);
  const numerator = grossCents * BigInt(rate.rate_bp);
  // Half-up: add half the denominator before the integer division.
  const tax = (numerator + denominator / 2n) / denominator;
  return { gross_cents: grossCents, net_cents: grossCents - tax, tax_cents: tax,
    rate_bp: rate.rate_bp, label: rate.label };
}

/** Sum of a set of splits, for the totals block of a document. */
export function sumSplits(splits: TaxSplit[]): { gross_cents: bigint; net_cents: bigint; tax_cents: bigint } {
  return splits.reduce((sum, split) => ({
    gross_cents: sum.gross_cents + split.gross_cents,
    net_cents: sum.net_cents + split.net_cents,
    tax_cents: sum.tax_cents + split.tax_cents,
  }), { gross_cents: 0n, net_cents: 0n, tax_cents: 0n });
}

/**
 * Group splits by rate for the "Umsatzsteuer" block: a document with a 19 %
 * and a 7 % position shows two lines, never one blended rate.
 */
export function groupByRate(splits: TaxSplit[]): Array<{ rate_bp: number; label: string;
  net_cents: bigint; tax_cents: bigint; gross_cents: bigint }> {
  const groups = new Map<string, { rate_bp: number; label: string; net_cents: bigint;
    tax_cents: bigint; gross_cents: bigint }>();
  for (const split of splits) {
    const key = `${split.rate_bp}:${split.label}`;
    const current = groups.get(key) ?? { rate_bp: split.rate_bp, label: split.label,
      net_cents: 0n, tax_cents: 0n, gross_cents: 0n };
    current.net_cents += split.net_cents; current.tax_cents += split.tax_cents;
    current.gross_cents += split.gross_cents;
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) => right.rate_bp - left.rate_bp);
}

/**
 * Pick the rate that applies to a category at a point in time.
 *
 * The rows are expected to be non-overlapping (the database enforces it with an
 * exclusion constraint), so at most one row matches. `null` means "no rate is
 * configured for that day" — the caller must then refuse to sell rather than
 * invent a rate, because an invoice without a rate is not an invoice.
 */
export function rateAt<T extends { category: string; rate_bp: number; label: string;
  valid_from: Date; valid_until: Date | null }>(rows: T[], category: string, at: Date): T | null {
  return rows.find(row => row.category === category && row.valid_from <= at &&
    (row.valid_until === null || row.valid_until > at)) ?? null;
}

/**
 * The rate rows that apply to the given categories at `at`, from the table.
 *
 * Returns a map category → row. A category without a row is *missing*, not
 * defaulted: selling without a configured rate would mean printing an invoice
 * without tax at all, so the checkout refuses instead (see `requireRates`).
 */
export async function loadRates(tx: Prisma.TransactionClient | TaxRateReader,
                                categories: string[], at: Date): Promise<Map<string, TaxRateRow>> {
  if (!categories.length) return new Map();
  const rows = await tx.taxRate.findMany({ where: { category: { in: categories },
    valid_from: { lte: at }, OR: [{ valid_until: null }, { valid_until: { gt: at } }] },
    orderBy: { valid_from: 'desc' } }) as Array<TaxRateRow & { category: string }>;
  const map = new Map<string, TaxRateRow>();
  for (const row of rows) if (!map.has(row.category)) map.set(row.category, row);
  return map;
}

/**
 * The tax rows for the categories a cart actually contains, or a refusal.
 *
 * Called once per checkout, before anything is written: a missing rate must
 * stop the sale, not appear as "0 %" on an invoice later. The error names the
 * category so an operator can add the rate instead of guessing.
 */
export async function requireRates(tx: Prisma.TransactionClient | TaxRateReader,
                                   categories: string[], at: Date): Promise<Map<string, TaxRateRow>> {
  const unique = [...new Set(categories)];
  const rates = await loadRates(tx, unique, at);
  const missing = unique.filter(category => !rates.has(category));
  if (missing.length) {
    throw Object.assign(new Error(`No tax rate configured for: ${missing.join(', ')}`), {
      code: 'TAX_RATE_MISSING', categories: missing });
  }
  return rates;
}
