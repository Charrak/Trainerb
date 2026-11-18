-- ------------------------------------------------------------- streitfälle --
--
-- A chargeback is not a refund. A refund is money *we* send back; a dispute is
-- money the buyer's bank took back. The books must be able to tell the two
-- apart, so they live in separate tables with separate lifecycles — and a lost
-- dispute can never be rewritten into a "refund we made".
--
-- The provider reports disputes asynchronously and out of order. A dispute may
-- therefore arrive *after* the order was already refunded, or be closed twice.
-- The unique provider id makes the second delivery an update, not a second row.

CREATE TABLE disputes (
  id                 uuid PRIMARY KEY,
  order_id           uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  payment_attempt_id uuid NOT NULL,
  provider           text NOT NULL CHECK (provider IN ('stripe', 'invoice')),
  environment        text NOT NULL CHECK (environment IN ('test', 'live')),
  provider_dispute_id text NOT NULL,
  amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
  currency           char(3) NOT NULL CHECK (currency = 'EUR'),
  status             text NOT NULL CHECK (status IN ('warning', 'open', 'won', 'lost', 'closed')),
  reason_code        text CHECK (reason_code IS NULL OR reason_code ~ '^[a-z_]{3,60}$'),
  opened_at          timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at        timestamptz,
  -- A closed case has an outcome; an open one has none. Without this, "won" and
  -- "lost" would be indistinguishable from "still running" in a report.
  CONSTRAINT disputes_resolution_metadata CHECK (
    (status IN ('won', 'lost', 'closed') AND resolved_at IS NOT NULL)
    OR (status IN ('warning', 'open') AND resolved_at IS NULL)
  )
);

-- The attempt must belong to the same order, exactly like a refund.
ALTER TABLE disputes ADD CONSTRAINT disputes_attempt_order_fkey
  FOREIGN KEY (payment_attempt_id, order_id) REFERENCES payment_attempts(id, order_id) ON DELETE RESTRICT;
-- One row per provider case: a repeated webhook updates instead of duplicating.
CREATE UNIQUE INDEX disputes_provider_dispute ON disputes(provider, environment, provider_dispute_id);
CREATE INDEX disputes_order_status ON disputes(order_id, status);
CREATE INDEX disputes_attempt_status ON disputes(payment_attempt_id, status);

-- Only a case that is still running needs attention; a decided case stays as
-- history. This partial index is what a "needs a human decision" list queries.
CREATE INDEX disputes_open ON disputes(order_id) WHERE status IN ('warning', 'open');

-- ------------------------------------------------ entscheidung zum zugang ---
-- `order_access_decisions` knew two origins: a refund or a manual access row.
-- A dispute is the third. Without that, an access decision after a chargeback
-- would have to point at a refund that never existed.
ALTER TABLE order_access_decisions ADD COLUMN dispute_id uuid REFERENCES disputes(id) ON DELETE RESTRICT;
ALTER TABLE order_access_decisions DROP CONSTRAINT order_access_decisions_refund_or_manual;
ALTER TABLE order_access_decisions ADD CONSTRAINT order_access_decisions_origin CHECK (
  (refund_id IS NOT NULL)::int + (dispute_id IS NOT NULL)::int + (access_id IS NOT NULL)::int >= 1
);
ALTER TABLE order_access_decisions ADD CONSTRAINT order_access_decisions_one_case CHECK (
  NOT (refund_id IS NOT NULL AND dispute_id IS NOT NULL)
);
CREATE INDEX order_access_decisions_dispute ON order_access_decisions(dispute_id);

-- ------------------------------------------------------------ widerrufscase --
--
-- The withdrawal request is reachable without a login, so it is the weakest
-- input in the system: no session, unknown identity, possibly a stranger's
-- order number. It is therefore only a *record of a claim*. It never refunds,
-- never touches an order and never confirms whether an order exists — the
-- neutral answer is the same for every address.
--
-- `contact_email_hmac` is a keyed hash for throttling and duplicate detection;
-- the readable address is needed to answer the person, so both are stored and
-- the plain column is the one a retention job will scrub.

CREATE TABLE withdrawal_requests (
  id                     uuid PRIMARY KEY,
  -- Deliberately not a foreign key: the submitted number is unverified text
  -- from a stranger. It is matched to an order only by a human.
  submitted_order_number text CHECK (submitted_order_number IS NULL OR char_length(submitted_order_number) <= 40),
  contact_email          text NOT NULL,
  contact_email_hmac     bytea NOT NULL,
  customer_name          text CHECK (customer_name IS NULL OR char_length(customer_name) <= 200),
  message                text CHECK (message IS NULL OR char_length(message) <= 2000),
  status                 text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'identity_check', 'in_progress', 'completed', 'rejected')),
  submitted_at           timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- The order is linked by staff after identity verification; only then may a
  -- refund follow, and even that is a separate, explicit action.
  order_id               uuid REFERENCES orders(id) ON DELETE RESTRICT,
  identity_verified_at   timestamptz,
  processed_by           uuid REFERENCES users(id) ON DELETE RESTRICT,
  processed_at           timestamptz,
  decision_reason        text CHECK (decision_reason IS NULL OR decision_reason ~ '^[a-z_]{3,60}$'),
  refund_id              uuid REFERENCES refunds(id) ON DELETE RESTRICT,
  -- The confirmation goes out through the durable outbox, like every other
  -- transactional mail; the row is unreadable without the queue entry.
  confirmation_outbox_id uuid REFERENCES email_outbox(id) ON DELETE RESTRICT,
  -- A decision has an author and a time; a waiting case has neither.
  CONSTRAINT withdrawal_requests_processing_metadata CHECK (
    (status IN ('completed', 'rejected')
      AND processed_by IS NOT NULL AND processed_at IS NOT NULL AND decision_reason IS NOT NULL)
    OR (status IN ('received', 'identity_check', 'in_progress')
      AND processed_by IS NULL AND processed_at IS NULL AND decision_reason IS NULL)
  ),
  -- Verification proves the *address*, not the order, so it may come first. The
  -- fact that it happened is kept in withdrawal_verifications; this column only
  -- mirrors the moment.
  CONSTRAINT withdrawal_requests_verified_after_submit CHECK (
    identity_verified_at IS NULL OR identity_verified_at >= submitted_at
  ),
  -- A refund is only ever attached to a completed withdrawal.
  CONSTRAINT withdrawal_requests_refund_metadata CHECK (
    (refund_id IS NULL) OR (status = 'completed' AND order_id IS NOT NULL)
  )
);
CREATE INDEX withdrawal_requests_status ON withdrawal_requests(status, submitted_at);
CREATE INDEX withdrawal_requests_email ON withdrawal_requests(contact_email_hmac, submitted_at);
CREATE INDEX withdrawal_requests_order ON withdrawal_requests(order_id) WHERE order_id IS NOT NULL;

-- The sender proves the address before staff may link an order. The pattern is
-- the guest-checkout one: only a hash of the token, one open proof per case, a
-- fixed expiry, and the proof is consumed by the first correct use.
CREATE TABLE withdrawal_verifications (
  id               uuid PRIMARY KEY,
  request_id       uuid NOT NULL REFERENCES withdrawal_requests(id) ON DELETE RESTRICT,
  token_hash       bytea NOT NULL UNIQUE,
  attempts         smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  expires_at       timestamptz NOT NULL,
  verified_at      timestamptz,
  consumed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT withdrawal_verified_after_send CHECK (verified_at IS NULL OR verified_at >= created_at)
);
CREATE INDEX withdrawal_verifications_request_idx ON withdrawal_verifications(request_id);
CREATE UNIQUE INDEX withdrawal_verify_one_open
  ON withdrawal_verifications(request_id) WHERE verified_at IS NULL AND consumed_at IS NULL;

-- A chargeback removes money from the account just like a refund does, so it
-- must reduce what can still be refunded. Without this, a lost dispute could be
-- "refunded" on top — the same payment leaving twice.

-- The refund guard now counts lost chargebacks as money already gone. A refund
-- request that would push the total above the payment is refused, and so is one
-- that tries to give back money the bank already took.
CREATE OR REPLACE FUNCTION trainerb_check_refund_amount() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid_cents bigint; used_cents bigint; lost_cents bigint;
BEGIN
  SELECT amount_cents INTO paid_cents FROM payment_attempts WHERE id = NEW.payment_attempt_id;
  IF NEW.amount_cents > paid_cents THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_PAYMENT'
      USING HINT = 'A refund cannot be larger than the confirmed payment.';
  END IF;
  IF NEW.status IN ('requested', 'pending', 'succeeded') THEN
    SELECT COALESCE(SUM(amount_cents), 0) INTO used_cents FROM refunds
      WHERE payment_attempt_id = NEW.payment_attempt_id
        AND status IN ('requested', 'pending', 'succeeded')
        AND id <> NEW.id;
    SELECT COALESCE(SUM(amount_cents), 0) INTO lost_cents FROM disputes
      WHERE payment_attempt_id = NEW.payment_attempt_id AND status = 'lost';
    IF used_cents + lost_cents + NEW.amount_cents > paid_cents THEN
      RAISE EXCEPTION 'REFUND_EXCEEDS_PAYMENT'
        USING HINT = 'Open refunds, confirmed refunds and lost chargebacks must not exceed the payment.';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- A lost dispute is money gone. The same guard shape as for refunds keeps the
-- two ceilings consistent: a dispute cannot be larger than the payment, and
-- open/won cases never reduce the refund capacity (the money may still come
-- back).
CREATE FUNCTION trainerb_check_dispute_amount() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid_cents bigint; lost_cents bigint; refunded_cents bigint;
BEGIN
  SELECT amount_cents INTO paid_cents FROM payment_attempts WHERE id = NEW.payment_attempt_id;
  IF NEW.amount_cents > paid_cents THEN
    RAISE EXCEPTION 'DISPUTE_EXCEEDS_PAYMENT'
      USING HINT = 'A dispute cannot be larger than the confirmed payment.';
  END IF;
  IF NEW.status = 'lost' THEN
    SELECT COALESCE(SUM(amount_cents), 0) INTO lost_cents FROM disputes
      WHERE payment_attempt_id = NEW.payment_attempt_id AND status = 'lost' AND id <> NEW.id;
    SELECT COALESCE(SUM(amount_cents), 0) INTO refunded_cents FROM refunds
      WHERE payment_attempt_id = NEW.payment_attempt_id AND status IN ('requested', 'pending', 'succeeded');
    IF lost_cents + refunded_cents + NEW.amount_cents > paid_cents THEN
      RAISE EXCEPTION 'DISPUTE_EXCEEDS_PAYMENT'
        USING HINT = 'A lost chargeback plus refunds must not exceed the payment.';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER disputes_amount_guard BEFORE INSERT OR UPDATE ON disputes
  FOR EACH ROW EXECUTE FUNCTION trainerb_check_dispute_amount();

-- A lost chargeback is money gone even though the provider never sent a refund,
-- so the order shows it. `refunded` stays reserved for money *we* returned; a
-- chargeback gets its own derived state so a support agent can tell the two
-- apart at a glance. An order can be refunded *and* have a dispute — the state
-- only changes when nothing else explains the gap.
ALTER TABLE orders DROP CONSTRAINT orders_payment_state_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_state_check
  CHECK (payment_state IN ('awaiting', 'paid', 'cancelled', 'review', 'refunded', 'charged_back'));

ALTER TABLE orders DROP CONSTRAINT orders_paid_via_check;
ALTER TABLE orders ADD CONSTRAINT orders_paid_via_check CHECK (
  (payment_state IN ('paid', 'refunded', 'charged_back') AND paid_via IN ('admin', 'provider')
    AND paid_at IS NOT NULL
    AND ((paid_via = 'admin' AND paid_confirmed_by IS NOT NULL)
      OR (paid_via = 'provider' AND paid_confirmed_by IS NULL)))
  OR (payment_state = 'cancelled' AND (
    (paid_via IS NULL AND paid_at IS NULL AND paid_confirmed_by IS NULL)
    OR (paid_via IN ('admin', 'provider') AND paid_at IS NOT NULL
      AND ((paid_via = 'admin' AND paid_confirmed_by IS NOT NULL)
        OR (paid_via = 'provider' AND paid_confirmed_by IS NULL)))))
  OR (payment_state NOT IN ('paid', 'cancelled', 'refunded', 'charged_back')
    AND paid_via IS NULL AND paid_at IS NULL AND paid_confirmed_by IS NULL)
);

-- A charged-back order keeps its payment evidence exactly like a refunded one;
-- `refunded_at` is *not* set, because no refund happened.
ALTER TABLE orders ADD COLUMN charged_back_at timestamptz;
ALTER TABLE orders ADD CONSTRAINT orders_charged_back_metadata CHECK (
  (payment_state = 'charged_back' AND charged_back_at IS NOT NULL AND paid_at IS NOT NULL)
  OR (payment_state <> 'charged_back' AND charged_back_at IS NULL)
);

-- The cancellation guard must not treat a chargeback as a cancellation: the
-- money was taken, not returned by us, and cancelling would release coupons
-- that belong to a real purchase.
CREATE OR REPLACE FUNCTION trainerb_check_order_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_state = 'cancelled' AND OLD.payment_state <> 'cancelled' THEN
    IF OLD.payment_state = 'charged_back' THEN
      RAISE EXCEPTION 'ORDER_CHARGED_BACK'
        USING HINT = 'A charged-back order is not cancellable; decide the access question instead.';
    END IF;
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
