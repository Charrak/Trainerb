-- ------------------------------------------------------------- erstattungen --
--
-- A refund is money going back. It is *not* a second truth about the payment:
-- the successful attempt and `orders.payment_state` stay untouched, and the
-- refund rows are the only place that says "part of this was returned". The
-- cancellation guard therefore must not fire for a refunded order — otherwise
-- the books would lose the payment evidence from phase 4 again.
--
-- Every decision that follows a refund (does the learner keep the course?) is a
-- separate, explicit row in `order_access_decisions`. Keeping access is a
-- decision as much as revoking it, and a missing decision is a visible gap
-- instead of a silent default.

CREATE TABLE refunds (
  id                       uuid PRIMARY KEY,
  order_id                 uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  payment_attempt_id       uuid NOT NULL,
  provider                 text NOT NULL CHECK (provider IN ('invoice', 'stripe')),
  environment              text NOT NULL CHECK (environment IN ('test', 'live')),
  provider_refund_id       text,
  provider_idempotency_key text NOT NULL UNIQUE,
  amount_cents             bigint NOT NULL CHECK (amount_cents > 0),
  currency                 char(3) NOT NULL CHECK (currency = 'EUR'),
  status                   text NOT NULL CHECK (status IN ('requested', 'pending', 'succeeded', 'failed', 'cancelled')),
  reason_code              text NOT NULL CHECK (reason_code ~ '^[a-z_]{3,60}$'),
  note                     text CHECK (note IS NULL OR char_length(note) <= 500),
  requested_by             uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_at             timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_at             timestamptz,
  last_error_safe          text,
  created_at               timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Only a confirmed refund counts as money returned; only an unconfirmed one
  -- may still be open.
  CONSTRAINT refund_confirmation_metadata CHECK (
    (status = 'succeeded' AND confirmed_at IS NOT NULL)
    OR (status <> 'succeeded' AND confirmed_at IS NULL)
  ),
  -- A provider reference is required exactly when the provider confirmed it.
  CONSTRAINT refund_provider_reference CHECK (
    (status = 'succeeded' AND provider = 'stripe' AND provider_refund_id IS NOT NULL)
    OR (status <> 'succeeded')
    OR (provider = 'invoice')
  )
);

-- The attempt must belong to the same order. This is what makes "refund the
-- order through a payment that was never its own" impossible.
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_order_id_key UNIQUE (id, order_id);
ALTER TABLE refunds ADD CONSTRAINT refunds_attempt_order_fkey
  FOREIGN KEY (payment_attempt_id, order_id) REFERENCES payment_attempts(id, order_id) ON DELETE RESTRICT;
CREATE INDEX refunds_order_status ON refunds(order_id, status);
CREATE INDEX refunds_attempt_status ON refunds(payment_attempt_id, status);
-- A provider refund can only be recorded once per provider account.
CREATE UNIQUE INDEX refunds_provider_refund ON refunds(provider, environment, provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;

-- Position-level allocation: needed for a correct credit note and for the tax
-- split once rates are approved. `net_cents`/`tax_cents` stay zero until an
-- approved rule exists, so no invented tax is ever stored.
CREATE TABLE refund_allocations (
  refund_id     uuid NOT NULL REFERENCES refunds(id) ON DELETE RESTRICT,
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  order_item_product uuid NOT NULL,
  gross_cents   bigint NOT NULL CHECK (gross_cents > 0),
  net_cents     bigint NOT NULL DEFAULT 0 CHECK (net_cents >= 0),
  tax_cents     bigint NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  created_at    timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (refund_id, order_item_product),
  CONSTRAINT refund_allocations_order_item_fkey
    FOREIGN KEY (order_item_product, order_id) REFERENCES order_items(product_id, order_id) ON DELETE RESTRICT,
  -- Either the split is known (gross = net + tax), or it is deliberately not
  -- filled in yet. A gross amount with a made-up split would be worse than an
  -- openly missing one, so `0/0` marks "not apportioned" instead of inventing
  -- a VAT rate.
  CONSTRAINT refund_allocations_amount CHECK (
    (net_cents = 0 AND tax_cents = 0) OR gross_cents = net_cents + tax_cents
  )
);

-- --------------------------------------------------- entscheidung zum zugang --
--
-- One row per refund (and later per dispute) records what happens to the access
-- the order created. `kept` is a decision, not the absence of one.
CREATE TABLE order_access_decisions (
  id              uuid PRIMARY KEY,
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  refund_id       uuid REFERENCES refunds(id) ON DELETE RESTRICT,
  access_id       uuid REFERENCES course_access(id) ON DELETE RESTRICT,
  decision        text NOT NULL CHECK (decision IN ('revoked', 'kept', 'suspended')),
  reason          text NOT NULL CHECK (reason ~ '^[a-z_]{3,60}$'),
  decided_by      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decided_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT order_access_decisions_refund_or_manual CHECK (refund_id IS NOT NULL OR access_id IS NOT NULL)
);
CREATE INDEX order_access_decisions_order ON order_access_decisions(order_id, decided_at);
CREATE INDEX order_access_decisions_refund ON order_access_decisions(refund_id);

-- ------------------------------------------------------------ korrekturbeleg --
--
-- A credit note (Gutschrift) references the original invoice and the refund.
-- Numbering uses its own sequence, so no number is ever reused or guessed from
-- the count of existing rows.
CREATE SEQUENCE IF NOT EXISTS credit_note_number_seq START 1;

CREATE TABLE credit_notes (
  id                 uuid PRIMARY KEY,
  order_id           uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  refund_id          uuid NOT NULL REFERENCES refunds(id) ON DELETE RESTRICT,
  original_invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  document_number    text NOT NULL UNIQUE,
  issued_at          timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  issuer_snapshot    jsonb NOT NULL,
  buyer_snapshot     jsonb NOT NULL,
  lines_snapshot     jsonb NOT NULL,
  total_gross_cents  bigint NOT NULL CHECK (total_gross_cents > 0),
  currency           char(3) NOT NULL CHECK (currency = 'EUR'),
  reason_code        text NOT NULL,
  note               text,
  recipient_email    text,
  created_at         timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Exactly one credit note per refund; a partial refund of the same order gets
-- its own document with its own number.
CREATE UNIQUE INDEX credit_notes_one_per_refund ON credit_notes(refund_id);
CREATE INDEX credit_notes_order ON credit_notes(order_id, issued_at);

-- The books must never show more refunded money than was actually paid.
CREATE FUNCTION trainerb_check_refund_amount() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid_cents bigint; refunded_cents bigint;
BEGIN
  SELECT amount_cents INTO paid_cents FROM payment_attempts WHERE id = NEW.payment_attempt_id;
  IF NEW.amount_cents > paid_cents THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_PAYMENT'
      USING HINT = 'A refund cannot be larger than the confirmed payment.';
  END IF;
  IF NEW.status IN ('requested', 'pending', 'succeeded') THEN
    SELECT COALESCE(SUM(amount_cents), 0) INTO refunded_cents FROM refunds
      WHERE payment_attempt_id = NEW.payment_attempt_id
        AND status IN ('requested', 'pending', 'succeeded')
        AND id <> NEW.id;
    IF refunded_cents + NEW.amount_cents > paid_cents THEN
      RAISE EXCEPTION 'REFUND_EXCEEDS_PAYMENT'
        USING HINT = 'The sum of open and confirmed refunds must not exceed the payment.';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER refunds_amount_guard BEFORE INSERT OR UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION trainerb_check_refund_amount();

-- A refunded order keeps its payment evidence. `payment_state` may only become
-- 'refunded' when the refunds cover the whole amount; a partial refund leaves
-- the state at 'paid' and is visible through the refund rows.
ALTER TABLE orders ADD COLUMN refunded_at timestamptz;
ALTER TABLE orders ADD CONSTRAINT orders_refunded_metadata CHECK (
  (payment_state = 'refunded' AND refunded_at IS NOT NULL AND paid_at IS NOT NULL)
  OR (payment_state <> 'refunded' AND refunded_at IS NULL)
);

-- Phase 3 defined the allowed payment states; extend the constraint instead of
-- redefining it, so the original rule stays visible in history.
ALTER TABLE orders DROP CONSTRAINT orders_payment_state_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_state_check
  CHECK (payment_state IN ('awaiting', 'paid', 'cancelled', 'review', 'refunded'));

-- The paid-metadata and cancellation guards from phase 3/4 must accept the new
-- state: a refunded order is a paid order from the books' point of view.
ALTER TABLE orders DROP CONSTRAINT orders_paid_via_check;
ALTER TABLE orders ADD CONSTRAINT orders_paid_via_check CHECK (
  (payment_state IN ('paid', 'refunded') AND paid_via IN ('admin', 'provider')
    AND paid_at IS NOT NULL
    AND ((paid_via = 'admin' AND paid_confirmed_by IS NOT NULL)
      OR (paid_via = 'provider' AND paid_confirmed_by IS NULL)))
  OR (payment_state = 'cancelled' AND (
    (paid_via IS NULL AND paid_at IS NULL AND paid_confirmed_by IS NULL)
    OR (paid_via IN ('admin', 'provider') AND paid_at IS NOT NULL
      AND ((paid_via = 'admin' AND paid_confirmed_by IS NOT NULL)
        OR (paid_via = 'provider' AND paid_confirmed_by IS NULL)))))
  OR (payment_state NOT IN ('paid', 'cancelled', 'refunded')
    AND paid_via IS NULL AND paid_at IS NULL AND paid_confirmed_by IS NULL)
);

-- A refunded order is not "cancelled": the payment happened and part or all of
-- it came back. It must not silently release coupons or revoke access — those
-- are separate, explicit decisions.
CREATE OR REPLACE FUNCTION trainerb_check_order_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
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

-- Suspending is a third state next to "runs" and "revoked": it stops access
-- without erasing the grant, so a partially refunded purchase can be resumed
-- after clarification. It is an explicit column rather than a magic `ends_at`,
-- because `ends_at` is a reason of its own (a time-limited purchase).
ALTER TABLE course_access ADD COLUMN suspended_at timestamptz;
ALTER TABLE course_access ADD COLUMN suspend_reason text;
ALTER TABLE course_access ADD CONSTRAINT course_access_suspend_metadata CHECK (
  (suspended_at IS NULL AND suspend_reason IS NULL)
  OR (suspended_at IS NOT NULL AND suspend_reason IS NOT NULL AND revoke_reason IS NULL)
);

-- An access row created by an order may only be revoked or suspended while at
-- least one decision is on record for its order. This is what keeps "refund but
-- decide nothing" out of the data.
CREATE FUNCTION trainerb_check_access_revocation_reason() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.source <> 'order' THEN RETURN NEW; END IF;
  IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
    IF NEW.revoke_reason IS NULL THEN
      RAISE EXCEPTION 'ACCESS_REVOKE_REASON_REQUIRED'
        USING HINT = 'Revoking purchased access needs a documented reason.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM order_access_decisions WHERE order_id = NEW.order_id) THEN
      RAISE EXCEPTION 'ACCESS_DECISION_REQUIRED'
        USING HINT = 'Record the access decision (revoked/kept) before revoking purchased access.';
    END IF;
  END IF;
  IF NEW.suspended_at IS NOT NULL AND OLD.suspended_at IS NULL AND NEW.suspend_reason IS NULL THEN
    RAISE EXCEPTION 'ACCESS_SUSPEND_REASON_REQUIRED'
      USING HINT = 'Suspending purchased access needs a documented reason.';
  END IF;
  IF NEW.suspended_at IS NOT NULL AND OLD.suspended_at IS NULL AND
     NOT EXISTS (SELECT 1 FROM order_access_decisions WHERE order_id = NEW.order_id) THEN
    RAISE EXCEPTION 'ACCESS_DECISION_REQUIRED'
      USING HINT = 'Record the access decision before suspending purchased access.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER course_access_revocation_guard BEFORE UPDATE ON course_access
  FOR EACH ROW EXECUTE FUNCTION trainerb_check_access_revocation_reason();
