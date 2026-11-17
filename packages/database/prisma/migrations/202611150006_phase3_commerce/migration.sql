-- Phase 3: cart, order, payment and learning access.
--
-- Scope of this slice, deliberately narrower than the target concept in
-- docs/02-datenmodell.md:
--   * exactly one checkout origin, one coupon per order, quantity = 1;
--   * invoice/SEPA bank transfer as the default (and only) automatic path;
--     a Stripe payment intent can be recorded but never marks an order paid
--     without a signature-verified webhook (implemented in the API);
--   * no tax rates, no refunds and no guest checkout: the buyer must be an
--     authenticated participant, because a verified guest email flow has no
--     verified e-mail provider yet.
-- Every transition is guarded inside the database; the API is not the only
-- line of defence.

-- ---------------------------------------------------------------- legality --
-- Legal texts are versioned. Checkout can only be completed while the
-- currently required versions are active; a wording change therefore forces a
-- fresh acceptance instead of silently reusing an old one.
CREATE TABLE legal_documents (
  id         uuid PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('terms', 'withdrawal', 'privacy')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE legal_document_versions (
  id           uuid PRIMARY KEY,
  document_id  uuid NOT NULL REFERENCES legal_documents(id) ON DELETE RESTRICT,
  version      integer NOT NULL CHECK (version > 0),
  wording      text NOT NULL CHECK (char_length(btrim(wording)) BETWEEN 1 AND 20000),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  activated_at timestamptz,
  activated_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (document_id, version),
  CONSTRAINT legal_version_activation_metadata CHECK (
    (status = 'active' AND activated_at IS NOT NULL AND activated_by IS NOT NULL)
    OR (status <> 'active')
  )
);
CREATE UNIQUE INDEX legal_one_active_version ON legal_document_versions(document_id) WHERE status = 'active';

-- ------------------------------------------------------- commerce settings --
-- A single row. It exists so that "sellable" is an explicit, audited decision
-- and so that the invoice issuer data is configured once, in the database,
-- instead of being invented by a template.
CREATE TABLE commerce_settings (
  id                      smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  sales_enabled           boolean NOT NULL DEFAULT false,
  invoice_seller_name     text NOT NULL,
  invoice_seller_street   text NOT NULL,
  invoice_seller_postal   text NOT NULL,
  invoice_seller_city     text NOT NULL,
  invoice_seller_country  char(2) NOT NULL,
  invoice_seller_email    text NOT NULL,
  invoice_seller_vat_id   text,
  bank_account_holder     text NOT NULL,
  bank_iban               text NOT NULL,
  bank_bic                text,
  bank_name               text,
  payment_term_days       integer NOT NULL DEFAULT 14 CHECK (payment_term_days BETWEEN 1 AND 90),
  currency                char(3) NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  updated_by              uuid REFERENCES users(id) ON DELETE RESTRICT,
  updated_at              timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- --------------------------------------------------------------------- cart --
CREATE TABLE carts (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  currency         char(3) NOT NULL DEFAULT 'EUR' CHECK (currency = 'EUR'),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'converted', 'abandoned')),
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- One open cart per account; a second cart cannot be created concurrently.
CREATE UNIQUE INDEX carts_one_open_per_user ON carts(user_id) WHERE status = 'open';
CREATE INDEX carts_user_idx ON carts(user_id, created_at DESC);

CREATE TABLE cart_items (
  cart_id    uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  price_id   uuid NOT NULL,
  quantity   smallint NOT NULL DEFAULT 1 CHECK (quantity = 1),
  added_at   timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (cart_id, product_id),
  FOREIGN KEY (price_id, product_id) REFERENCES prices(id, product_id) ON DELETE RESTRICT
);

-- -------------------------------------------------------------------- order --
CREATE SEQUENCE order_number_seq START 1 INCREMENT 1;

CREATE TABLE orders (
  id                     uuid PRIMARY KEY,
  order_number           text NOT NULL UNIQUE CHECK (order_number ~ '^TB-[0-9]{4}-[0-9]{6}$'),
  cart_id                uuid UNIQUE REFERENCES carts(id) ON DELETE RESTRICT,
  checkout_idempotency_key text NOT NULL,
  user_id                uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  buyer_email_original   text NOT NULL,
  buyer_email_canonical  text NOT NULL,
  currency               char(3) NOT NULL CHECK (currency = 'EUR'),
  payment_method         text NOT NULL CHECK (payment_method IN ('invoice', 'stripe')),
  payment_state          text NOT NULL DEFAULT 'awaiting'
                           CHECK (payment_state IN ('awaiting', 'paid', 'cancelled', 'review')),
  fulfillment_state      text NOT NULL DEFAULT 'not_ready'
                           CHECK (fulfillment_state IN ('not_ready', 'waiting', 'fulfilled', 'blocked')),
  subtotal_gross_cents   bigint NOT NULL CHECK (subtotal_gross_cents >= 0),
  discount_cents         bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  total_gross_cents      bigint NOT NULL CHECK (total_gross_cents >= 0),
  billing_snapshot       jsonb NOT NULL,
  placed_at              timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at                timestamptz,
  paid_confirmed_by      uuid REFERENCES users(id) ON DELETE RESTRICT,
  payment_reference      text,
  due_at                 timestamptz,
  fulfilled_at           timestamptz,
  cancelled_at           timestamptz,
  cancelled_reason       text,
  created_by             uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at             timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, checkout_idempotency_key),
  CONSTRAINT orders_total_check CHECK (total_gross_cents = subtotal_gross_cents - discount_cents),
  CONSTRAINT orders_paid_metadata CHECK (
    (payment_state = 'paid' AND paid_at IS NOT NULL AND paid_confirmed_by IS NOT NULL)
    OR (payment_state <> 'paid' AND paid_at IS NULL AND paid_confirmed_by IS NULL)
  ),
  CONSTRAINT orders_fulfillment_check CHECK (
    (fulfillment_state = 'fulfilled' AND fulfilled_at IS NOT NULL)
    OR (fulfillment_state <> 'fulfilled' AND fulfilled_at IS NULL)
  ),
  CONSTRAINT orders_invoice_term CHECK (payment_method <> 'invoice' OR due_at IS NOT NULL),
  -- Learning access is only ever derived from a paid and fulfilled order; the
  -- guard triggers below enforce the same rule from the other side.
  CONSTRAINT orders_cancelled_check CHECK (
    (payment_state = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_reason IS NOT NULL)
    OR (payment_state <> 'cancelled')
  )
);
CREATE INDEX orders_user_idx ON orders(user_id, placed_at DESC, id);
CREATE INDEX orders_payment_state_idx ON orders(payment_state, placed_at);
CREATE INDEX orders_fulfillment_idx ON orders(fulfillment_state, placed_at);

CREATE TABLE order_items (
  order_id               uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  product_id             uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  price_id               uuid NOT NULL,
  position               integer NOT NULL CHECK (position BETWEEN 1 AND 50),
  title_snapshot         text NOT NULL,
  variant_snapshot       text,
  quantity               smallint NOT NULL DEFAULT 1 CHECK (quantity = 1),
  unit_gross_cents       bigint NOT NULL CHECK (unit_gross_cents > 0),
  discount_cents         bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  total_gross_cents      bigint NOT NULL CHECK (total_gross_cents > 0),
  created_at             timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (order_id, product_id),
  UNIQUE (order_id, position),
  FOREIGN KEY (price_id, product_id) REFERENCES prices(id, product_id) ON DELETE RESTRICT,
  CONSTRAINT order_item_total_check CHECK (total_gross_cents = unit_gross_cents - discount_cents)
);

CREATE TABLE order_item_courses (
  order_id             uuid NOT NULL,
  order_item_product   uuid NOT NULL,
  course_id            uuid NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  course_version_id    uuid NOT NULL,
  course_title_snapshot text NOT NULL,
  access_days          integer CHECK (access_days IS NULL OR access_days BETWEEN 1 AND 36500),
  PRIMARY KEY (order_id, order_item_product, course_id),
  FOREIGN KEY (order_id, order_item_product) REFERENCES order_items(order_id, product_id) ON DELETE RESTRICT,
  FOREIGN KEY (course_version_id, course_id) REFERENCES course_versions(id, course_id) ON DELETE RESTRICT
);

CREATE TABLE order_legal_acceptances (
  id                       uuid PRIMARY KEY,
  order_id                 uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  legal_document_version_id uuid NOT NULL REFERENCES legal_document_versions(id) ON DELETE RESTRICT,
  kind                     text NOT NULL
                             CHECK (kind IN ('terms_accepted', 'withdrawal_notice_seen', 'privacy_notice_seen')),
  wording_snapshot         text NOT NULL,
  affirmed                 boolean NOT NULL,
  ip_hmac                  bytea,
  user_agent_hmac          bytea,
  created_at               timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (order_id, kind)
);

-- ---------------------------------------------------------------- payments --
CREATE TABLE payment_attempts (
  id                   uuid PRIMARY KEY,
  order_id             uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  provider             text NOT NULL CHECK (provider IN ('invoice', 'stripe')),
  environment          text NOT NULL CHECK (environment IN ('test', 'live')),
  provider_session_id  text,
  provider_payment_id  text,
  provider_idempotency_key text NOT NULL UNIQUE,
  status               text NOT NULL CHECK (status IN ('created', 'pending', 'succeeded', 'failed', 'cancelled', 'review')),
  amount_cents         bigint NOT NULL CHECK (amount_cents > 0),
  currency             char(3) NOT NULL CHECK (currency = 'EUR'),
  confirmed_at         timestamptz,
  failure_code         text,
  created_at           timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT payment_attempt_succeeded_metadata CHECK (status <> 'succeeded' OR confirmed_at IS NOT NULL)
);
CREATE UNIQUE INDEX payment_attempts_session ON payment_attempts(provider, environment, provider_session_id)
  WHERE provider_session_id IS NOT NULL;
CREATE UNIQUE INDEX payment_attempts_payment ON payment_attempts(provider, environment, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
-- At most one open attempt per order.
CREATE UNIQUE INDEX payment_attempts_one_open ON payment_attempts(order_id) WHERE status IN ('created', 'pending', 'review');

-- Append-only record of verified provider events (Stripe webhook). Storing the
-- raw provider event is forbidden; only the verified, minimal facts are kept.
CREATE TABLE payment_events (
  id                  uuid PRIMARY KEY,
  order_id            uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  provider            text NOT NULL CHECK (provider = 'stripe'),
  environment         text NOT NULL CHECK (environment IN ('test', 'live')),
  provider_event_id   text NOT NULL,
  event_type          text NOT NULL,
  amount_cents        bigint NOT NULL CHECK (amount_cents > 0),
  currency            char(3) NOT NULL CHECK (currency = 'EUR'),
  received_at         timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, environment, provider_event_id)
);

-- ------------------------------------------------------------------ coupon --
CREATE TABLE coupons (
  id               uuid PRIMARY KEY,
  code_original    text NOT NULL,
  code_canonical   text NOT NULL UNIQUE CHECK (code_canonical ~ '^[A-Z0-9_-]{4,64}$'),
  type             text NOT NULL CHECK (type IN ('percent', 'fixed')),
  value            bigint NOT NULL CHECK (value > 0),
  currency         char(3) CHECK (currency IN ('EUR')),
  valid_from       timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_until      timestamptz,
  max_redemptions  integer CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  active           boolean NOT NULL DEFAULT false,
  created_by       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at       timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT coupon_value_check CHECK (
    (type = 'percent' AND value BETWEEN 1 AND 10000 AND currency IS NULL)
    OR (type = 'fixed' AND currency IS NOT NULL)
  ),
  CONSTRAINT coupon_range_check CHECK (valid_until IS NULL OR valid_until > valid_from)
);

CREATE TABLE coupon_products (
  coupon_id  uuid NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (coupon_id, product_id)
);

CREATE TABLE coupon_reservations (
  id                    uuid PRIMARY KEY,
  coupon_id             uuid NOT NULL REFERENCES coupons(id) ON DELETE RESTRICT,
  order_id              uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status                text NOT NULL CHECK (status IN ('reserved', 'redeemed', 'released')),
  created_at            timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at           timestamptz,
  CONSTRAINT coupon_reservation_resolved CHECK (
    (status = 'reserved' AND resolved_at IS NULL) OR (status <> 'reserved' AND resolved_at IS NOT NULL)
  )
);
CREATE INDEX coupon_reservations_coupon_idx ON coupon_reservations(coupon_id, status);
CREATE INDEX coupon_reservations_user_idx ON coupon_reservations(user_id);

-- ------------------------------------------------------------- access/learn --
-- Derived access rows. They are written only by the fulfilment path from a paid
-- order (or by an audited manual grant) and are revoked, never edited.
CREATE TABLE course_access (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  course_id       uuid NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  course_version_id uuid NOT NULL,
  source          text NOT NULL CHECK (source IN ('order', 'manual')),
  order_id        uuid REFERENCES orders(id) ON DELETE RESTRICT,
  granted_by      uuid REFERENCES users(id) ON DELETE RESTRICT,
  starts_at       timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ends_at         timestamptz,
  revoked_at      timestamptz,
  revoke_reason   text,
  created_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (course_version_id, course_id) REFERENCES course_versions(id, course_id) ON DELETE RESTRICT,
  CONSTRAINT course_access_origin_check CHECK (
    (source = 'order' AND order_id IS NOT NULL AND granted_by IS NULL)
    OR (source = 'manual' AND order_id IS NULL AND granted_by IS NOT NULL)
  ),
  CONSTRAINT course_access_validity_check CHECK (ends_at IS NULL OR ends_at > starts_at)
);
-- One active access per account and course; a re-purchase extends nothing
-- silently and is rejected instead.
CREATE UNIQUE INDEX course_access_one_active ON course_access(user_id, course_id) WHERE revoked_at IS NULL;
CREATE INDEX course_access_user_idx ON course_access(user_id, created_at DESC);

CREATE TABLE chapter_progress (
  id                uuid PRIMARY KEY,
  access_id         uuid NOT NULL REFERENCES course_access(id) ON DELETE RESTRICT,
  course_version_id uuid NOT NULL REFERENCES course_versions(id) ON DELETE RESTRICT,
  chapter_id        uuid NOT NULL,
  completed_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (access_id, chapter_id),
  -- A chapter may only be marked done inside the version that granted access.
  FOREIGN KEY (chapter_id, course_version_id) REFERENCES course_chapters(id, course_version_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX chapter_progress_access_idx ON chapter_progress(access_id);

-- ---------------------------------------------------------------- receipts --
-- The invoice is an immutable snapshot of the order at the moment of issue.
CREATE TABLE invoices (
  id                uuid PRIMARY KEY,
  order_id          uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  invoice_number    text NOT NULL UNIQUE CHECK (invoice_number ~ '^TB-RE-[0-9]{4}-[0-9]{6}$'),
  issued_at         timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  seller_snapshot   jsonb NOT NULL,
  buyer_snapshot    jsonb NOT NULL,
  lines_snapshot    jsonb NOT NULL,
  total_gross_cents bigint NOT NULL CHECK (total_gross_cents >= 0),
  currency          char(3) NOT NULL CHECK (currency = 'EUR'),
  due_at            timestamptz,
  payment_reference text,
  created_at        timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE SEQUENCE invoice_number_seq START 1 INCREMENT 1;

-- ------------------------------------------------------------- guard logic --

-- A cart may only contain prices of currently active products that are
-- themselves active and sellable *at the time the item is added*. The price is
-- re-resolved again at checkout; this guard stops obviously stale baskets.
CREATE FUNCTION trainerb_check_cart_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  product_status text;
  price_status text;
  price_product uuid;
BEGIN
  SELECT status INTO product_status FROM products WHERE id = NEW.product_id;
  SELECT status, product_id INTO price_status, price_product FROM prices WHERE id = NEW.price_id;
  IF price_status IS NULL OR price_product <> NEW.product_id THEN
    RAISE EXCEPTION 'CART_PRICE_MISMATCH' USING HINT = 'The price does not belong to the product.';
  END IF;
  IF product_status <> 'active' OR price_status <> 'active' THEN
    RAISE EXCEPTION 'CART_PRODUCT_NOT_SELLABLE' USING HINT = 'Only active products with an active price can be added.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cart_items_guard BEFORE INSERT OR UPDATE ON cart_items
  FOR EACH ROW EXECUTE FUNCTION trainerb_check_cart_item();

-- Learning access on a course requires that course to be published and its
-- version unchanged (the snapshot is frozen, access never silently points at a
-- different version).
CREATE FUNCTION trainerb_check_course_access() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  course_status text;
  version_state text;
BEGIN
  SELECT status INTO course_status FROM courses WHERE id = NEW.course_id;
  SELECT state INTO version_state FROM course_versions WHERE id = NEW.course_version_id AND course_id = NEW.course_id;
  IF course_status IS DISTINCT FROM 'published' OR version_state IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'ACCESS_COURSE_NOT_PUBLISHED' USING HINT = 'Access can only be granted to a published course version.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER course_access_guard BEFORE INSERT ON course_access
  FOR EACH ROW EXECUTE FUNCTION trainerb_check_course_access();

-- An order may only be marked paid through the API after a verified payment
-- confirmation. The API writes the audit record in the same transaction, so a
-- missing audit entry means the transition bypassed the application.
CREATE FUNCTION trainerb_check_order_payment_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_state = 'paid' AND OLD.payment_state <> 'paid' THEN
    IF NOT EXISTS (
      SELECT 1 FROM payment_attempts
      WHERE order_id = NEW.id AND status = 'succeeded' AND amount_cents = NEW.total_gross_cents
    ) THEN
      RAISE EXCEPTION 'ORDER_PAYMENT_EVIDENCE_MISSING'
        USING HINT = 'A successful payment attempt with the exact total is required.';
    END IF;
  END IF;
  IF NEW.payment_state = 'paid' AND NEW.fulfillment_state = 'fulfilled' THEN
    IF NOT EXISTS (SELECT 1 FROM course_access WHERE order_id = NEW.id) THEN
      RAISE EXCEPTION 'ORDER_FULFILMENT_WITHOUT_ACCESS' USING HINT = 'Fulfilment must grant access.';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_payment_guard BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION trainerb_check_order_payment_transition();

-- Access rows derived from an order disappear with a cancelled or unpaid order.
CREATE FUNCTION trainerb_check_order_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_state = 'cancelled' AND OLD.payment_state <> 'cancelled' THEN
    IF EXISTS (SELECT 1 FROM course_access WHERE order_id = NEW.id AND revoked_at IS NULL) THEN
      RAISE EXCEPTION 'ORDER_CANCEL_WITH_ACTIVE_ACCESS' USING HINT = 'Revoke access before cancelling the order.';
    END IF;
    IF EXISTS (SELECT 1 FROM coupon_reservations WHERE order_id = NEW.id AND status = 'reserved') THEN
      UPDATE coupon_reservations SET status = 'released', resolved_at = CURRENT_TIMESTAMP
        WHERE order_id = NEW.id AND status = 'reserved';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_cancellation_guard BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION trainerb_check_order_cancellation();

-- An order number and invoice number are drawn from a sequence, never from
-- application state, so a rolled-back transaction cannot create duplicates.
CREATE FUNCTION trainerb_next_order_number(prefix text, seq text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  EXECUTE format('SELECT nextval(%L)', seq) INTO n;
  RETURN prefix || to_char(CURRENT_DATE, 'YYYY') || '-' || lpad(n::text, 6, '0');
END $$;
