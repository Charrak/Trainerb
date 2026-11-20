-- These fields belong to a version, not a mutable page-wide setting.
ALTER TABLE page_versions
  ADD COLUMN banner text CHECK(length(trim(banner)) BETWEEN 1 AND 240),
  ADD COLUMN button_label text CHECK(length(trim(button_label)) BETWEEN 1 AND 80),
  ADD COLUMN button_path text CHECK(button_path IN ('/kurse','/buchen','/seiten','/registrieren')),
  ADD COLUMN image_id uuid REFERENCES media_assets(id) ON DELETE RESTRICT,
  ADD COLUMN image_alt text CHECK(length(trim(image_alt)) BETWEEN 1 AND 180),
  ADD CHECK((button_label IS NULL)=(button_path IS NULL)),
  ADD CHECK((image_alt IS NULL)=(image_id IS NULL));
CREATE INDEX page_versions_image_id_idx ON page_versions(image_id);
CREATE FUNCTION guard_page_presentation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.banner,NEW.button_label,NEW.button_path,NEW.image_id,NEW.image_alt)
     IS DISTINCT FROM (OLD.banner,OLD.button_label,OLD.button_path,OLD.image_id,OLD.image_alt)
  THEN RAISE EXCEPTION 'PAGE_VERSION_IMMUTABLE'; END IF;
  IF NEW.image_id IS NOT NULL AND NEW.state IN ('published','draft') THEN
    PERFORM id FROM media_assets WHERE id=NEW.image_id AND source='s3' AND visibility='public'
      AND status='ready' AND mime_detected IN ('image/png','image/jpeg') FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PAGE_IMAGE_UNAVAILABLE'; END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER page_presentation_guard BEFORE INSERT OR UPDATE ON page_versions FOR EACH ROW EXECUTE FUNCTION guard_page_presentation();
