-- One approved, frozen layout per qualification version. No template is seeded.
CREATE TABLE certificate_templates (
  id uuid PRIMARY KEY, course_version_id uuid NOT NULL REFERENCES course_versions(id),
  heading text NOT NULL CHECK(length(btrim(heading)) BETWEEN 1 AND 100),
  issuer text NOT NULL CHECK(length(btrim(issuer)) BETWEEN 1 AND 160),
  created_by uuid NOT NULL REFERENCES users(id), approved_by uuid REFERENCES users(id), approved_at timestamptz,
  CHECK ((approved_at IS NULL) = (approved_by IS NULL)), UNIQUE(id,course_version_id)
);
CREATE UNIQUE INDEX certificate_template_one_approved ON certificate_templates(course_version_id) WHERE approved_at IS NOT NULL;
CREATE FUNCTION trainerb_template_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.approved_at IS NULL AND NEW.approved_at IS NOT NULL
     AND (to_jsonb(OLD)-'approved_by'-'approved_at') = (to_jsonb(NEW)-'approved_by'-'approved_at') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'CERTIFICATE_TEMPLATE_IMMUTABLE';
END $$;
CREATE TRIGGER template_guard BEFORE UPDATE OR DELETE ON certificate_templates FOR EACH ROW EXECUTE FUNCTION trainerb_template_guard();
ALTER TABLE completion_records ADD UNIQUE(id, course_version_id);
CREATE TABLE certificates (
  id uuid PRIMARY KEY, completion_id uuid NOT NULL, template_id uuid NOT NULL, course_version_id uuid NOT NULL,
  replaces_id uuid UNIQUE REFERENCES certificates(id),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','valid','revoked','cancelled')),
  attempts integer NOT NULL DEFAULT 0, retry_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, last_error text,
  issued_at timestamptz, verification_hash bytea UNIQUE, document_ciphertext bytea, key_id text,
  revoked_at timestamptz, revoked_by uuid REFERENCES users(id), revoke_reason text,
  FOREIGN KEY (completion_id,course_version_id) REFERENCES completion_records(id,course_version_id),
  FOREIGN KEY (template_id,course_version_id) REFERENCES certificate_templates(id,course_version_id),
  CHECK ((status IN ('valid','revoked')) = (issued_at IS NOT NULL) AND (issued_at IS NULL) = (document_ciphertext IS NULL)
    AND (issued_at IS NULL) = (key_id IS NULL) AND (issued_at IS NULL) = (verification_hash IS NULL)),
  CHECK ((status='revoked') = (revoked_at IS NOT NULL) AND (revoked_at IS NULL)=(revoked_by IS NULL) AND (revoked_at IS NULL)=(revoke_reason IS NULL))
);
CREATE UNIQUE INDEX certificate_one_initial ON certificates(completion_id) WHERE replaces_id IS NULL;
CREATE UNIQUE INDEX certificate_one_current ON certificates(completion_id) WHERE status IN ('queued','valid');
CREATE INDEX certificate_ready_queue ON certificates(retry_at,id) WHERE status='queued';
CREATE FUNCTION trainerb_certificate_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status='queued' AND EXISTS
    (SELECT 1 FROM certificate_templates WHERE id=NEW.template_id AND approved_at IS NOT NULL)
    AND (NEW.replaces_id IS NULL OR EXISTS (SELECT 1 FROM certificates p WHERE p.id=NEW.replaces_id
      AND p.status='revoked' AND p.completion_id=NEW.completion_id AND p.template_id=NEW.template_id)) THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id,NEW.completion_id,NEW.course_version_id,NEW.template_id,NEW.replaces_id)
     IS NOT DISTINCT FROM (OLD.id,OLD.completion_id,OLD.course_version_id,OLD.template_id,OLD.replaces_id) THEN
    IF OLD.status = 'queued' AND NEW.status IN ('queued','valid','cancelled') THEN RETURN NEW; END IF;
    IF OLD.status = 'valid' AND NEW.status = 'revoked' AND
       (NEW.document_ciphertext,NEW.key_id,NEW.verification_hash,NEW.issued_at) IS NOT DISTINCT FROM
       (OLD.document_ciphertext,OLD.key_id,OLD.verification_hash,OLD.issued_at) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'CERTIFICATE_IMMUTABLE';
END $$;
CREATE TRIGGER certificate_guard BEFORE INSERT OR UPDATE OR DELETE ON certificates FOR EACH ROW EXECUTE FUNCTION trainerb_certificate_guard();
-- The job and the evidence commit together; approval after the fact never awards retroactively.
CREATE FUNCTION trainerb_queue_certificate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO certificates(id,completion_id,course_version_id,template_id)
    SELECT gen_random_uuid(),NEW.id,NEW.course_version_id,t.id FROM certificate_templates t
    WHERE t.course_version_id=NEW.course_version_id AND t.approved_at IS NOT NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER completion_certificate AFTER INSERT ON completion_records FOR EACH ROW EXECUTE FUNCTION trainerb_queue_certificate();
