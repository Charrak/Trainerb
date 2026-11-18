-- Existing versions and text blocks need no backfill.
ALTER TABLE course_versions ADD COLUMN cover_media_id uuid REFERENCES media_assets(id) ON DELETE RESTRICT;
CREATE INDEX course_versions_cover_media_id_idx ON course_versions(cover_media_id);
ALTER TABLE chapter_contents ADD COLUMN media_asset_id uuid REFERENCES media_assets(id) ON DELETE RESTRICT,
  ALTER COLUMN body DROP NOT NULL, DROP CONSTRAINT phase2_content_text_only, DROP CONSTRAINT chapter_content_body_schema;
CREATE INDEX chapter_contents_media_asset_id_idx ON chapter_contents(media_asset_id);
ALTER TABLE chapter_contents ADD CONSTRAINT chapter_content_payload CHECK (
  (kind = 'text' AND body IS NOT NULL AND media_asset_id IS NULL) OR
  (kind IN ('image', 'video', 'file') AND body IS NULL AND media_asset_id IS NOT NULL)
);
ALTER TABLE chapter_contents ADD CONSTRAINT chapter_content_body_schema CHECK (body IS NULL OR (CASE
  WHEN jsonb_typeof(body) = 'object' AND body->'schema_version' = '1'::jsonb
    AND jsonb_typeof(body->'blocks') = 'array'
  THEN jsonb_array_length(body->'blocks') = 1
    AND jsonb_typeof(body->'blocks'->0) = 'object'
    AND body->'blocks'->0->>'id' = id::text
    AND body->'blocks'->0->>'kind' IN ('paragraph', 'heading', 'list', 'link')
  ELSE false END) IS TRUE);

-- Check both initial associations and copies, under a lock against concurrent
-- quarantine. Later quarantine is always allowed: a reference is not a grant.
CREATE FUNCTION trainerb_require_course_asset(asset uuid, usage_kind text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM media_assets WHERE id = asset AND status = 'ready' AND CASE usage_kind
    WHEN 'cover' THEN visibility = 'public' AND mime_detected LIKE 'image/%'
    WHEN 'image' THEN visibility = 'private' AND mime_detected LIKE 'image/%'
    WHEN 'video' THEN visibility = 'private' AND mime_detected LIKE 'video/%'
    WHEN 'file' THEN visibility = 'private'
    ELSE false END FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'COURSE_MEDIA_UNAVAILABLE'; END IF;
END $$;
CREATE FUNCTION trainerb_check_course_cover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM trainerb_require_course_asset(NEW.cover_media_id, 'cover');
  RETURN NEW;
END $$;
CREATE TRIGGER course_cover_guard BEFORE INSERT OR UPDATE OF cover_media_id, state ON course_versions
  FOR EACH ROW WHEN (NEW.cover_media_id IS NOT NULL AND NEW.state <> 'retired') EXECUTE FUNCTION trainerb_check_course_cover();
CREATE FUNCTION trainerb_check_chapter_asset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM trainerb_require_course_asset(NEW.media_asset_id, NEW.kind);
  RETURN NEW;
END $$;
CREATE TRIGGER chapter_asset_guard BEFORE INSERT OR UPDATE OF media_asset_id, kind ON chapter_contents
  FOR EACH ROW WHEN (NEW.media_asset_id IS NOT NULL) EXECUTE FUNCTION trainerb_check_chapter_asset();
