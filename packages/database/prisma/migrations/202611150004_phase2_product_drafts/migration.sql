-- Phase 2: private product and EUR price drafts only.  There is deliberately
-- no activation, public price, checkout, tax calculation or payment path.
CREATE TABLE products (
  id uuid PRIMARY KEY,
  sku text NOT NULL UNIQUE CHECK (char_length(sku) BETWEEN 1 AND 64 AND sku ~ '^[A-Z0-9]+([-_][A-Z0-9]+)*$'),
  type text NOT NULL CHECK (type IN ('single', 'bundle')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  variant_name text CHECK (variant_name IS NULL OR char_length(btrim(variant_name)) BETWEEN 1 AND 160),
  description text CHECK (description IS NULL OR char_length(btrim(description)) BETWEEN 1 AND 4000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'inactive', 'archived')),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 100000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT phase2_product_activation_locked CHECK (status = 'draft')
);
CREATE INDEX products_created_by_idx ON products(created_by);
CREATE INDEX products_created_at_id_idx ON products(created_at, id);

CREATE TABLE product_courses (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 20),
  access_days_override integer CHECK (access_days_override IS NULL OR access_days_override BETWEEN 1 AND 36500),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (product_id, course_id),
  UNIQUE (product_id, position)
);
CREATE INDEX product_courses_course_id_idx ON product_courses(course_id);

CREATE TABLE prices (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  currency char(3) NOT NULL CHECK (currency = 'EUR'),
  model text NOT NULL DEFAULT 'one_time' CHECK (model = 'one_time'),
  gross_cents bigint NOT NULL CHECK (gross_cents BETWEEN 0 AND 100000000000),
  sale_gross_cents bigint CHECK (sale_gross_cents IS NULL OR sale_gross_cents BETWEEN 0 AND gross_cents),
  sale_starts_at timestamptz,
  sale_ends_at timestamptz,
  tax_category text NOT NULL CHECK (tax_category ~ '^[a-z][a-z0-9_-]{0,63}$'),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, product_id),
  CONSTRAINT phase2_price_activation_locked CHECK (status = 'draft'),
  CONSTRAINT price_valid_range CHECK (valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT price_sale_range CHECK (
    (sale_gross_cents IS NULL AND sale_starts_at IS NULL AND sale_ends_at IS NULL)
    OR (sale_gross_cents IS NOT NULL AND sale_starts_at IS NOT NULL AND sale_ends_at IS NOT NULL
        AND sale_starts_at >= valid_from AND sale_ends_at > sale_starts_at
        AND (valid_until IS NULL OR sale_ends_at <= valid_until))
  ),
  -- The draft editor uses explicit UTC with minute precision; no local-time
  -- ambiguity or silent truncation when a price is edited later.
  CONSTRAINT price_times_minute_precision CHECK (
    valid_from >= '2000-01-01 00:00:00+00'::timestamptz AND valid_from < '2101-01-01 00:00:00+00'::timestamptz AND EXTRACT(SECOND FROM valid_from) = 0
    AND (valid_until IS NULL OR (valid_until >= '2000-01-01 00:00:00+00'::timestamptz AND valid_until < '2101-01-01 00:00:00+00'::timestamptz AND EXTRACT(SECOND FROM valid_until) = 0))
    AND (sale_starts_at IS NULL OR (sale_starts_at >= '2000-01-01 00:00:00+00'::timestamptz AND sale_starts_at < '2101-01-01 00:00:00+00'::timestamptz AND EXTRACT(SECOND FROM sale_starts_at) = 0))
    AND (sale_ends_at IS NULL OR (sale_ends_at >= '2000-01-01 00:00:00+00'::timestamptz AND sale_ends_at < '2101-01-01 00:00:00+00'::timestamptz AND EXTRACT(SECOND FROM sale_ends_at) = 0))
  )
);
CREATE INDEX prices_product_created_idx ON prices(product_id, created_at, id);
CREATE INDEX prices_created_by_idx ON prices(created_by);

-- Single/bundle completeness and non-overlapping *active* prices are release
-- checks, not required for incomplete drafts. Before unlocking active states,
-- a later migration must add transactionally enforced completeness and a
-- PostgreSQL exclusion constraint for active (product, currency, time) ranges.
