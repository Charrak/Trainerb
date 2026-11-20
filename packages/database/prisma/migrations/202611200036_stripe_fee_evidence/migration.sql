CREATE TABLE stripe_fee_evidence (
 balance_id text NOT NULL, environment text NOT NULL CHECK(environment IN('test','live')),
 payment_id uuid UNIQUE REFERENCES payment_attempts, refund_id uuid UNIQUE REFERENCES refunds,
 currency char(3) NOT NULL, amount_cents bigint NOT NULL,fee_cents bigint NOT NULL,net_cents bigint NOT NULL,
 captured_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(environment,balance_id),CHECK(num_nonnulls(payment_id,refund_id)=1),CHECK(amount_cents-fee_cents=net_cents));
CREATE FUNCTION guard_stripe_fee() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'FEE_EVIDENCE_IMMUTABLE'; END IF;
 IF NEW.payment_id IS NOT NULL THEN PERFORM id FROM payment_attempts WHERE id=NEW.payment_id AND environment=NEW.environment AND provider='stripe' AND status='succeeded' AND amount_cents=NEW.amount_cents AND currency=NEW.currency FOR SHARE;
 ELSE PERFORM id FROM refunds WHERE id=NEW.refund_id AND environment=NEW.environment AND provider='stripe' AND status='succeeded' AND amount_cents=-NEW.amount_cents AND currency=NEW.currency FOR SHARE; END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'FEE_EVIDENCE_MISMATCH'; END IF; RETURN NEW; END $$;
CREATE TRIGGER guard_stripe_fee BEFORE INSERT OR UPDATE OR DELETE ON stripe_fee_evidence FOR EACH ROW EXECUTE FUNCTION guard_stripe_fee();
