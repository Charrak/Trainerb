-- ============================================================================
--  Phase 4 — Steuersätze, Belegaufteilung, Aufbewahrung, Streitfall-Abgleich
-- ============================================================================
--
-- Until now `tax_category` was a free identifier with no rate behind it: the
-- invoice printed gross amounts and said so. The business has now fixed the
-- rate for online training in Germany (19 % Regelsteuersatz), so the rate can
-- exist as data — deliberately as a *table*, not a constant:
--
--  * a rate is valid for a period, so a later change is a new row and old
--    documents keep the rate they were issued with;
--  * one row can be marked as the default, so the checkout never has to guess;
--  * the split lives on the order item and in the invoice snapshot, so a
--    rendered document never recomputes tax from today's data.
--
-- Prices keep being entered gross. The split is derived, never typed, and
-- `gross = net + tax` is enforced by the database.

-- ------------------------------------------------------------- steuersätze --
CREATE TABLE tax_rates (
  id           uuid PRIMARY KEY,
  -- The category a price refers to. Free text today; the unique key below is
  -- (category, valid_from) so a category can be re-rated without reuse.
  category     text NOT NULL CHECK (category ~ '^[a-z][a-z0-9_-]{0,63}$'),
  -- Basis points, not a float: 1900 = 19,00 %. Integers keep the money exact.
  rate_bp      integer NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
  -- What the rate is called on a document: "19 %", "0 % (Reverse Charge)".
  label        text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  -- How the rate is legally described in the tax notice.
  note         text CHECK (note IS NULL OR char_length(note) <= 500),
  valid_from   timestamptz NOT NULL,
  valid_until  timestamptz,
  is_default   boolean NOT NULL DEFAULT false,
  created_by   uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (category, valid_from),
  CONSTRAINT tax_rates_period CHECK (valid_until IS NULL OR valid_until > valid_from)
);
-- Exactly one period per category at any moment, like the price ranges: an
-- overlapping window would make "the rate on that day" ambiguous.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE tax_rates ADD CONSTRAINT tax_rates_no_overlap EXCLUDE USING gist (
  category WITH =, tstzrange(valid_from, COALESCE(valid_until, 'infinity'), '[)') WITH &&
);
-- One default rate at a time.
CREATE UNIQUE INDEX tax_rates_one_default ON tax_rates(is_default) WHERE is_default;
CREATE INDEX tax_rates_lookup ON tax_rates(category, valid_from DESC);

-- ---------------------------------------------------- aufteilung der position --
--
-- A gross amount and a rate fully determine the net and the tax. Both are stored
-- on the position so the invoice can freeze them; nothing recomputes later.
ALTER TABLE order_items ADD COLUMN tax_rate_bp integer;
ALTER TABLE order_items ADD COLUMN net_cents bigint;
ALTER TABLE order_items ADD COLUMN tax_cents bigint;
ALTER TABLE order_items ADD COLUMN tax_label text;

-- Backfill: existing rows were sold as "19 % included, not split". Setting the
-- split is a *derivation* of the gross amount, not a new fact about the sale.
UPDATE order_items SET tax_rate_bp = 1900,
  net_cents = round(total_gross_cents::numeric * 10000 / 11900)::bigint,
  tax_cents = total_gross_cents - round(total_gross_cents::numeric * 10000 / 11900)::bigint,
  tax_label = '19 %'
WHERE tax_rate_bp IS NULL;

-- From here on every position carries its split. `gross = net + tax` is not a
-- convention but a constraint, and the rate must be a plausible basis-point
-- value even if the rate row itself is later removed from the catalogue.
ALTER TABLE order_items ALTER COLUMN tax_rate_bp SET NOT NULL;
ALTER TABLE order_items ALTER COLUMN net_cents SET NOT NULL;
ALTER TABLE order_items ALTER COLUMN tax_cents SET NOT NULL;
ALTER TABLE order_items ALTER COLUMN tax_label SET NOT NULL;
ALTER TABLE order_items ADD CONSTRAINT order_items_tax_split_check
  CHECK (tax_rate_bp BETWEEN 0 AND 10000
    AND net_cents >= 0 AND tax_cents >= 0
    AND total_gross_cents = net_cents + tax_cents);
-- A rate of 0 % must not carry tax, and a positive rate must not pretend there
-- is none when the gross amount is positive.
ALTER TABLE order_items ADD CONSTRAINT order_items_tax_rate_consistency_check
  CHECK ((tax_rate_bp = 0 AND tax_cents = 0)
    OR (tax_rate_bp > 0 AND total_gross_cents = 0)
    OR (tax_rate_bp > 0 AND tax_cents =
      round(total_gross_cents::numeric * tax_rate_bp / (10000 + tax_rate_bp))::bigint));

-- ------------------------------------------------------- zahlungszielhinweis --
--
-- The order gets a due date for transfers; nothing happened when it passed.
-- `reminder_sent_at` records that the buyer was told once, so the job is
-- idempotent and nobody is mailed twice for the same overdue day.
ALTER TABLE orders ADD COLUMN reminder_sent_at timestamptz;
UPDATE orders SET reminder_sent_at = NULL;
CREATE INDEX orders_overdue ON orders(due_at) WHERE payment_state = 'awaiting' AND reminder_sent_at IS NULL;

-- ------------------------------------------------ sammlung der klartextadresse --
--
-- A withdrawal case is evidence for the statutory period. Its readable address
-- is the data that does not have to survive that long: the keyed hash keeps the
-- case identifiable (duplicate detection, rate limiting) and the case id plus
-- the receipt mail id stay. `contact_email` therefore becomes nullable, so a
-- retention job can scrub it without destroying the case.
ALTER TABLE withdrawal_requests ALTER COLUMN contact_email DROP NOT NULL;
-- A scrubbed case must say so, otherwise "no address" looks like a bug.
ALTER TABLE withdrawal_requests ADD COLUMN contact_email_scrubbed_at timestamptz;
ALTER TABLE withdrawal_requests ADD CONSTRAINT withdrawal_requests_scrub_metadata CHECK (
  (contact_email IS NOT NULL AND contact_email_scrubbed_at IS NULL)
  OR (contact_email IS NULL AND contact_email_scrubbed_at IS NOT NULL)
);
CREATE INDEX withdrawal_requests_scrub_candidates
  ON withdrawal_requests(submitted_at) WHERE contact_email IS NOT NULL;

-- ------------------------------------------------------ streitfälle abgleichen --
--
-- A provider reports a case asynchronously; the first delivery is the one that
-- matters for the audit trail, later ones update the state.
ALTER TABLE disputes ADD COLUMN last_synced_at timestamptz;
ALTER TABLE disputes ADD COLUMN sync_source text NOT NULL DEFAULT 'manual'
  CHECK (sync_source IN ('manual', 'webhook'));
