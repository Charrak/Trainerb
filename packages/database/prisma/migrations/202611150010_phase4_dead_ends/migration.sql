-- ============================================================================
--  Phase 4 — Sackgassen schließen
-- ============================================================================
--
-- Three situations had no way forward in the back office:
--
--  1. A withdrawal whose order could not be matched stayed in `identity_check`
--     forever. Turning it away is a legitimate outcome, so the file must be
--     closable *without* an order — but only as a decision with an author, a
--     time and a reason.
--
--  2. An announced chargeback (`warning`, `open`) could neither suspend nor
--     keep access. The money may still come back, but "we do not know yet" is
--     exactly the state in which a not-yet-started grant should be paused, so a
--     provisional access decision must be possible while the case is running.
--
--  3. Confirming a payment while a chargeback was already known handed out
--     access unexamined. Fulfilment now recognises such an order as blocked.
--
-- The withdrawal decision codes are fixed here as a CHECK, so a reason can never
-- become free text that nobody agreed on.

-- --------------------------------------------------- widerruf ohne bestellung --
--
-- Migration 9 required an order for every case whose address had been verified.
-- That held as long as every case could be linked; it left nobody a way out when
-- the purchase simply cannot be found. Accepting a withdrawal still always names
-- the purchase — declining does not have to.
ALTER TABLE withdrawal_requests ADD CONSTRAINT withdrawal_requests_completed_needs_order
  CHECK (status <> 'completed' OR order_id IS NOT NULL);

-- Migration 9 only limited the *shape* of a decision reason (`^[a-z_]{3,60}$`),
-- which accepts any typo. The codes below are the complete vocabulary a closed
-- case may use, so a reason can never become free text nobody agreed on.
ALTER TABLE withdrawal_requests ADD CONSTRAINT withdrawal_requests_decision_reason_codes
  CHECK (decision_reason IS NULL OR decision_reason IN (
    'withdrawal_accepted',
    'withdrawal_declined',
    'order_not_found',
    'outside_statutory_period',
    'digital_content_started',
    'duplicate_request',
    'identity_unconfirmed'
  ));

-- Which of those may close a case that has no order. `order_not_found` is the
-- honest one; a duplicate or an unconfirmed identity may close without one too.
-- Kept as a database rule so the API and the drop-down cannot drift apart.
CREATE FUNCTION trainerb_check_withdrawal_close() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'rejected' AND NEW.order_id IS NULL THEN
    IF NEW.decision_reason NOT IN ('order_not_found', 'identity_unconfirmed', 'duplicate_request') THEN
      RAISE EXCEPTION 'WITHDRAWAL_CLOSE_REASON'
        USING HINT = 'A case closed without an order needs a reason that explains it.';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER withdrawal_requests_close_guard BEFORE INSERT OR UPDATE ON withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION trainerb_check_withdrawal_close();

-- ------------------------------------------------- streitfall: vorläufig --
--
-- A provisional decision belongs to the *case*, so `dispute_id` is set and the
-- decision vocabulary stays the one from migration 8 (`kept`, `suspended`,
-- `revoked`). Nothing changes in the table; the blocking check on the fulfilment
-- path just needs a cheap lookup for open cases.
CREATE INDEX disputes_open_by_order ON disputes(order_id) WHERE status IN ('warning', 'open');
