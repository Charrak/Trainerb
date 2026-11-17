-- Phase 4: guest checkout, verified buyer e-mail and fulfilment without a
-- pre-existing account.
--
-- Design notes
-- ------------
-- * A guest cart belongs to a browser secret, never to a user account. The
--   secret is stored only as an HMAC so a database leak cannot be replayed.
-- * The e-mail proof is a single-use token bound to exactly one cart. It is
--   stored as a hash, has a short lifetime and is consumed on checkout.
-- * `orders.user_id` becomes nullable: a paid guest order is linked to the
--   account that owns the verified address in the same transaction that grants
--   access. `orders.created_by` stays mandatory because it is the accountable
--   actor (the guest principal or the account owner).
-- * Nothing here deletes or rewrites phase 3 data. Every change is additive or
--   relaxes a constraint that is re-narrowed by a trigger/constraint below.

-- ------------------------------------------------------- guest cart owner --
ALTER TABLE carts ALTER COLUMN user_id DROP NOT NULL;
-- A cart is either personal or a guest cart. Exactly one owner kind is set, and
-- a guest cart always carries its hashed browser secret.
ALTER TABLE carts ADD COLUMN guest_secret_hash bytea;
ALTER TABLE carts ADD COLUMN guest_secret_key_id text;
ALTER TABLE carts ADD COLUMN email_verified_at timestamptz;
ALTER TABLE carts ADD CONSTRAINT carts_owner_check CHECK (
  (user_id IS NOT NULL AND guest_secret_hash IS NULL AND guest_secret_key_id IS NULL)
  OR (user_id IS NULL AND guest_secret_hash IS NOT NULL AND guest_secret_key_id IS NOT NULL)
);
-- One open cart per browser secret as well, so two tabs cannot fork the basket.
DROP INDEX carts_one_open_per_user;
CREATE UNIQUE INDEX carts_one_open_per_user ON carts(user_id) WHERE status = 'open' AND user_id IS NOT NULL;
CREATE UNIQUE INDEX carts_one_open_per_guest ON carts(guest_secret_hash) WHERE status = 'open' AND guest_secret_hash IS NOT NULL;

-- ------------------------------------------------------ e-mail proof rows --
-- A proof is bound to one cart and one canonical address. Only a hash of the
-- token is stored; the raw token exists solely in the outgoing mail.
CREATE TABLE checkout_email_verifications (
  id               uuid PRIMARY KEY,
  cart_id          uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  email_original   text NOT NULL,
  email_canonical  text NOT NULL,
  token_hash       bytea NOT NULL UNIQUE,
  code_hash        bytea NOT NULL,
  attempts         smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  expires_at       timestamptz NOT NULL,
  verified_at      timestamptz,
  consumed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT checkout_email_verified_after_send CHECK (verified_at IS NULL OR verified_at >= created_at)
);
CREATE INDEX checkout_email_verifications_cart_idx ON checkout_email_verifications(cart_id);
-- Only one proof may be open per cart; a new request replaces the old one by
-- revoking it first (handled in the application under a cart lock).
CREATE UNIQUE INDEX checkout_email_one_open_per_cart
  ON checkout_email_verifications(cart_id) WHERE consumed_at IS NULL AND verified_at IS NULL;

-- --------------------------------------------------------- order changes --
-- Guest orders have no account yet: the buyer is identified by the verified
-- address until a claim step links or creates the account.
ALTER TABLE orders ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE orders ADD COLUMN checkout_email_verification_id uuid UNIQUE
  REFERENCES checkout_email_verifications(id) ON DELETE RESTRICT;
ALTER TABLE orders ADD COLUMN identity_kind text NOT NULL DEFAULT 'account';
ALTER TABLE orders ADD CONSTRAINT orders_identity_kind_check
  CHECK (identity_kind IN ('account', 'guest'));
ALTER TABLE orders ADD CONSTRAINT orders_identity_shape_check CHECK (
  (identity_kind = 'account' AND user_id IS NOT NULL AND checkout_email_verification_id IS NULL)
  OR (identity_kind = 'guest' AND checkout_email_verification_id IS NOT NULL)
);
-- The participant named on a guest purchase is captured separately from the
-- invoice address; it becomes the account profile name once the account exists.
ALTER TABLE orders ADD COLUMN guest_participant_first_name text;
ALTER TABLE orders ADD COLUMN guest_participant_last_name text;
ALTER TABLE orders ADD CONSTRAINT orders_guest_names_check CHECK (
  (identity_kind = 'guest' AND guest_participant_first_name IS NOT NULL
    AND guest_participant_last_name IS NOT NULL
    AND char_length(btrim(guest_participant_first_name)) BETWEEN 1 AND 120
    AND char_length(btrim(guest_participant_last_name)) BETWEEN 1 AND 120)
  OR (identity_kind = 'account' AND guest_participant_first_name IS NULL AND guest_participant_last_name IS NULL)
);

-- The phase-3 unique key (user_id, checkout_idempotency_key) already ignores
-- rows with a NULL user, so guest orders get their own scope on the proof id.
CREATE UNIQUE INDEX orders_guest_idempotency ON orders(checkout_email_verification_id, checkout_idempotency_key)
  WHERE checkout_email_verification_id IS NOT NULL;

-- A guest order can only be paid once its address was proven; the payment
-- transition guard from phase 3 additionally requires payment evidence.
CREATE OR REPLACE FUNCTION trainerb_check_order_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof_verified timestamptz;
BEGIN
  IF NEW.identity_kind = 'guest' THEN
    SELECT verified_at INTO proof_verified FROM checkout_email_verifications
      WHERE id = NEW.checkout_email_verification_id;
    IF proof_verified IS NULL THEN
      RAISE EXCEPTION 'ORDER_EMAIL_NOT_VERIFIED'
        USING HINT = 'A guest order requires an e-mail proof that was actually confirmed.';
    END IF;
    -- A guest order may be recorded as paid while still unlinked, because the
    -- linking decision (create a new account or attach to an existing one) is a
    -- separate, audited step. It must never be *granted* before that step.
    IF NEW.fulfillment_state = 'fulfilled' AND NEW.user_id IS NULL THEN
      RAISE EXCEPTION 'ORDER_GUEST_NOT_LINKED'
        USING HINT = 'Fulfilment requires the buyer account to be linked first.';
    END IF;
  END IF;
  IF NEW.user_id IS NOT NULL AND NEW.buyer_email_canonical IS DISTINCT FROM (
    SELECT email_canonical FROM users WHERE id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'ORDER_EMAIL_MISMATCH'
      USING HINT = 'The order address must belong to the linked account.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_identity_guard BEFORE INSERT OR UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION trainerb_check_order_identity();

-- Payment attribution: a verified provider webhook pays an order without a
-- human actor, so `paid_confirmed_by` cannot be mandatory for every paid order.
-- The phase-3 rule is re-stated per attribution kind instead of dropped.
ALTER TABLE orders ADD COLUMN paid_via text;
UPDATE orders SET paid_via = 'admin' WHERE payment_state = 'paid' AND paid_confirmed_by IS NOT NULL;
-- A cancelled order keeps its payment evidence when money did arrive (refund,
-- chargeback, manual decision): the payment record must survive the refund,
-- otherwise the books could no longer tell a refunded order from an unpaid one.
ALTER TABLE orders ADD CONSTRAINT orders_paid_via_check CHECK (
  (payment_state = 'paid' AND paid_via IN ('admin', 'provider')
    AND paid_at IS NOT NULL
    AND ((paid_via = 'admin' AND paid_confirmed_by IS NOT NULL)
      OR (paid_via = 'provider' AND paid_confirmed_by IS NULL)))
  OR (payment_state = 'cancelled' AND (
    (paid_via IS NULL AND paid_at IS NULL AND paid_confirmed_by IS NULL)
    OR (paid_via IN ('admin', 'provider') AND paid_at IS NOT NULL
      AND ((paid_via = 'admin' AND paid_confirmed_by IS NOT NULL)
        OR (paid_via = 'provider' AND paid_confirmed_by IS NULL)))))
  OR (payment_state NOT IN ('paid', 'cancelled')
    AND paid_via IS NULL AND paid_at IS NULL AND paid_confirmed_by IS NULL)
);
ALTER TABLE orders DROP CONSTRAINT orders_paid_metadata;

-- A guest has no account and therefore no acting user; the verified e-mail
-- proof is the accountable principal instead.
ALTER TABLE orders ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE orders ADD CONSTRAINT orders_actor_check CHECK (
  (identity_kind = 'account' AND created_by IS NOT NULL) OR (identity_kind = 'guest' AND created_by IS NULL)
);

-- A coupon may be redeemed by a guest before their account exists. The
-- reservation therefore points at the order and only optionally at an account;
-- until the order is linked, the limit is enforced per canonical e-mail so one
-- address cannot redeem the same code twice.
ALTER TABLE coupon_reservations ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE coupon_reservations ADD COLUMN identity_hmac bytea;
ALTER TABLE coupon_reservations ADD CONSTRAINT coupon_reservation_identity_check CHECK (
  user_id IS NOT NULL OR identity_hmac IS NOT NULL
);
CREATE UNIQUE INDEX coupon_reservation_one_per_identity
  ON coupon_reservations(coupon_id, identity_hmac) WHERE identity_hmac IS NOT NULL AND status <> 'released';

-- Learning access and invoices keep their phase-3 rules; only the account
-- reference becomes conditional on a linked order.
CREATE OR REPLACE FUNCTION trainerb_check_course_access() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE published boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM course_publications p
    JOIN course_versions v ON v.id = p.course_version_id AND v.course_id = p.course_id
    WHERE p.course_id = NEW.course_id AND p.course_version_id = NEW.course_version_id
      AND v.state = 'published'
  ) INTO published;
  IF NOT published THEN
    RAISE EXCEPTION 'ACCESS_COURSE_NOT_PUBLISHED'
      USING HINT = 'Access is only granted to a published course version.';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------- invoice data --
-- Buyer data for guest invoices comes from the order snapshot, so the invoice
-- row itself stays an immutable copy of what the buyer submitted.
ALTER TABLE invoices ADD COLUMN recipient_email text;
ALTER TABLE invoices ADD CONSTRAINT invoices_recipient_email_check
  CHECK (recipient_email IS NULL OR char_length(recipient_email) BETWEEN 3 AND 254);

-- ------------------------------------------------------- account claiming --
-- Linking a paid guest order to an account is auditable and idempotent.
CREATE INDEX orders_buyer_email_idx ON orders(buyer_email_canonical, placed_at DESC);
CREATE INDEX orders_guest_unlinked_idx ON orders(placed_at) WHERE identity_kind = 'guest' AND user_id IS NULL;
