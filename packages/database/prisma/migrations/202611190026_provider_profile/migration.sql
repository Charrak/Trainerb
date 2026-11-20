-- Single, lockable editorial profile. Never derive legal identity from bank data.
CREATE TABLE provider_profile (
  id smallint PRIMARY KEY CHECK (id=1), revision integer NOT NULL CHECK (revision>=0), details jsonb,
  CHECK ((revision=0 AND details IS NULL) OR (revision>0 AND details IS NOT NULL AND jsonb_typeof(details)='object'))
);
INSERT INTO provider_profile(id,revision) VALUES(1,0);
ALTER TABLE legal_document_versions ADD COLUMN provider_revision integer, ADD COLUMN provider_snapshot jsonb,
  ADD CHECK ((provider_revision IS NULL AND provider_snapshot IS NULL) OR
    (provider_revision IS NOT NULL AND provider_revision>0 AND provider_snapshot IS NOT NULL AND jsonb_typeof(provider_snapshot)='object'));
CREATE FUNCTION protect_provider_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.provider_revision,NEW.provider_snapshot) IS DISTINCT FROM (OLD.provider_revision,OLD.provider_snapshot)
    THEN RAISE EXCEPTION 'PROVIDER_SNAPSHOT_IMMUTABLE'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER protect_provider_snapshot BEFORE UPDATE ON legal_document_versions FOR EACH ROW EXECUTE FUNCTION protect_provider_snapshot();
-- Old texts remain visible. A legacy sales approval is not approval of a profile.
UPDATE commerce_settings SET sales_enabled=false,updated_at=now() WHERE sales_enabled;
