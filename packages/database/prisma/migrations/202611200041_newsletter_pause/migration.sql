-- Anhalten und Fortsetzen eines geplanten Newsletter-Versands. Erlaubt ist nur
-- scheduled -> paused -> scheduled sowie der bestehende Weg zu cancelled.
-- Der bereits festgelegte Empfängerkreis (frozen) bleibt unveränderlich.
ALTER TABLE newsletter_campaigns DROP CONSTRAINT newsletter_campaigns_status_check;
ALTER TABLE newsletter_campaigns ADD CONSTRAINT newsletter_campaigns_status_check
  CHECK (status IN ('draft','scheduled','paused','frozen','cancelled'));

-- Der Inhaltsschutz bleibt unverändert; nur der Statusweg erhält das Anhalten
-- und Fortsetzen vor dem Einfrieren. Alles andere bleibt gesperrt.
CREATE OR REPLACE FUNCTION newsletter_campaign_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.id,NEW.subject,NEW.body,NEW.audience,NEW.created_by,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.subject,OLD.body,OLD.audience,OLD.created_by,OLD.created_at)
 OR NOT ((OLD.status='draft' AND NEW.status='scheduled') OR (OLD.status='scheduled' AND NEW.status='frozen')
      OR (OLD.status='scheduled' AND NEW.status='paused') OR (OLD.status='paused' AND NEW.status='scheduled')
      OR (OLD.status IN ('draft','scheduled','paused','frozen') AND NEW.status='cancelled'))
 OR (OLD.status<>'draft' AND (OLD.scheduled_at,OLD.policy,OLD.approved_by) IS DISTINCT FROM (NEW.scheduled_at,NEW.policy,NEW.approved_by)) THEN RAISE EXCEPTION 'CAMPAIGN_IMMUTABLE'; END IF; RETURN NEW; END; $$;
