-- No subscribers, example consent wording, test approvals or campaigns are seeded.
CREATE TABLE newsletter_subscribers (
 id uuid PRIMARY KEY,email text NOT NULL UNIQUE,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','unsubscribed','bounced','complained')),
 epoch uuid,policy text,topic text CHECK(topic IN ('kurse','akademie')),created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((status='confirmed')=(epoch IS NOT NULL)),CHECK((epoch IS NULL)=(policy IS NULL)),CHECK((epoch IS NULL)=(topic IS NULL))
);
CREATE TABLE newsletter_proofs (
 subscriber_id uuid PRIMARY KEY REFERENCES newsletter_subscribers ON DELETE CASCADE, token_hash bytea NOT NULL UNIQUE CHECK(octet_length(token_hash)=32),
 policy text NOT NULL,wording text NOT NULL,privacy_id uuid NOT NULL REFERENCES legal_document_versions,topic text NOT NULL CHECK(topic IN ('kurse','akademie')),expires_at timestamptz NOT NULL
);
CREATE TABLE newsletter_consent_events (
 id uuid PRIMARY KEY,subscriber_id uuid NOT NULL REFERENCES newsletter_subscribers,action text NOT NULL CHECK(action IN ('grant','withdraw','bounced','complained')),
 epoch uuid NOT NULL,policy text NOT NULL,wording text NOT NULL,privacy_id uuid NOT NULL REFERENCES legal_document_versions,topic text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(epoch,action)
);
CREATE FUNCTION newsletter_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'NEWSLETTER_EVIDENCE_IMMUTABLE'; END; $$;
CREATE TRIGGER newsletter_evidence_guard BEFORE UPDATE OR DELETE ON newsletter_consent_events FOR EACH ROW EXECUTE FUNCTION newsletter_evidence_immutable();
CREATE TABLE newsletter_campaigns (
 id uuid PRIMARY KEY,subject text NOT NULL CHECK(length(trim(subject)) BETWEEN 1 AND 160),body text NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 12000),
 audience text NOT NULL CHECK(audience IN ('all','kurse','akademie')),created_by uuid NOT NULL REFERENCES users,created_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','scheduled','frozen','cancelled')),scheduled_at timestamptz, approved_by uuid REFERENCES users,policy text,
 frozen_at timestamptz,CHECK(status NOT IN ('scheduled','frozen') OR (policy IS NOT NULL AND scheduled_at IS NOT NULL AND approved_by IS NOT NULL))
);
CREATE FUNCTION newsletter_campaign_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.id,NEW.subject,NEW.body,NEW.audience,NEW.created_by,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.subject,OLD.body,OLD.audience,OLD.created_by,OLD.created_at)
 OR NOT ((OLD.status='draft' AND NEW.status='scheduled') OR (OLD.status='scheduled' AND NEW.status='frozen') OR (OLD.status IN ('draft','scheduled','frozen') AND NEW.status='cancelled'))
 OR (OLD.status<>'draft' AND (OLD.scheduled_at,OLD.policy,OLD.approved_by) IS DISTINCT FROM (NEW.scheduled_at,NEW.policy,NEW.approved_by)) THEN RAISE EXCEPTION 'CAMPAIGN_IMMUTABLE'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER newsletter_campaign_immutable BEFORE UPDATE ON newsletter_campaigns FOR EACH ROW EXECUTE FUNCTION newsletter_campaign_guard();
CREATE INDEX newsletter_campaign_due ON newsletter_campaigns(status,scheduled_at);
ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_purpose_check, ADD CHECK(purpose IN ('transaction','newsletter'));
CREATE TABLE newsletter_sends (
 campaign_id uuid NOT NULL REFERENCES newsletter_campaigns,subscriber_id uuid NOT NULL REFERENCES newsletter_subscribers,epoch uuid NOT NULL,
 outbox_id uuid UNIQUE REFERENCES email_outbox ON DELETE SET NULL,dispatched_at timestamptz, PRIMARY KEY(campaign_id,subscriber_id)
);
CREATE INDEX newsletter_sends_waiting ON newsletter_sends(campaign_id,subscriber_id) WHERE dispatched_at IS NULL;
