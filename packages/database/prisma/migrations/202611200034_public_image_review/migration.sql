-- A website receipt has no course. Existing receipts can never be repurposed.
ALTER TABLE course_media_uploads ALTER COLUMN course_id DROP NOT NULL,
 ADD COLUMN intended_use text NOT NULL DEFAULT 'course', ADD COLUMN rights_ref text,
 ADD CONSTRAINT receipt_use CHECK ((intended_use='course' AND course_id IS NOT NULL AND rights_ref IS NULL) OR
 (intended_use='website' AND course_id IS NULL AND mime_detected IN ('image/png','image/jpeg') AND
  ((approved_at IS NULL AND rights_ref IS NULL) OR (approved_at IS NOT NULL AND approved_by<>uploaded_by AND rights_ref IS NOT NULL AND rights_ref ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{2,79}$'))));
CREATE FUNCTION guard_upload_origin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.intended_use,NEW.course_id,NEW.uploaded_by,NEW.object_key,NEW.sha256,NEW.mime_detected,NEW.size_bytes) IS DISTINCT FROM
    (OLD.intended_use,OLD.course_id,OLD.uploaded_by,OLD.object_key,OLD.sha256,OLD.mime_detected,OLD.size_bytes)
 OR (OLD.approved_at IS NOT NULL AND (NEW.approved_by,NEW.approved_at,NEW.rights_ref) IS DISTINCT FROM (OLD.approved_by,OLD.approved_at,OLD.rights_ref))
 THEN RAISE EXCEPTION 'UPLOAD_ORIGIN_IMMUTABLE'; END IF; RETURN NEW; END $$;
CREATE TRIGGER guard_upload_origin BEFORE UPDATE ON course_media_uploads FOR EACH ROW EXECUTE FUNCTION guard_upload_origin();
