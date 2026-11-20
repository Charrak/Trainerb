-- Stop a pending approval before a background promotion can consume it. Locking
-- the receipt serializes withdrawal with promotion. Never repurpose a receipt.
ALTER TABLE course_media_uploads ADD COLUMN rights_withdrawn_at timestamptz,
 ADD CHECK(rights_withdrawn_at IS NULL OR (intended_use='website' AND approved_at IS NOT NULL));
CREATE FUNCTION guard_rights_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.rights_withdrawn_at IS NOT NULL AND (NEW.rights_withdrawn_at,NEW.promoted_asset_id) IS DISTINCT FROM (OLD.rights_withdrawn_at,OLD.promoted_asset_id)
 THEN RAISE EXCEPTION 'RIGHTS_WITHDRAWAL_FINAL'; END IF; RETURN NEW; END $$;
CREATE TRIGGER guard_rights_withdrawal BEFORE UPDATE ON course_media_uploads FOR EACH ROW EXECUTE FUNCTION guard_rights_withdrawal();

-- No UPDATE privilege on payment tables is needed by the evidence writer.
CREATE OR REPLACE FUNCTION guard_stripe_fee() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'FEE_EVIDENCE_IMMUTABLE'; END IF;
 IF NEW.payment_id IS NOT NULL THEN PERFORM id FROM payment_attempts WHERE id=NEW.payment_id AND environment=NEW.environment AND provider='stripe' AND status='succeeded' AND amount_cents=NEW.amount_cents AND currency=NEW.currency;
 ELSE PERFORM id FROM refunds WHERE id=NEW.refund_id AND environment=NEW.environment AND provider='stripe' AND status='succeeded' AND amount_cents=-NEW.amount_cents AND currency=NEW.currency; END IF;
 IF NOT FOUND THEN RAISE EXCEPTION 'FEE_EVIDENCE_MISMATCH'; END IF; RETURN NEW; END $$;
