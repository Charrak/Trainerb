-- Metadata only. A successful scan and a checked course association are
-- separate prerequisites for publication; this migration exposes no files.
CREATE TABLE media_assets (
  id uuid PRIMARY KEY,
  source text NOT NULL,
  storage_key text UNIQUE,
  video_external_id text UNIQUE,
  original_name text NOT NULL CHECK (char_length(btrim(original_name)) BETWEEN 1 AND 255),
  mime_detected text NOT NULL CHECK (char_length(btrim(mime_detected)) BETWEEN 1 AND 255),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 bytea CHECK (octet_length(sha256) = 32),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  status text NOT NULL DEFAULT 'pending_scan' CHECK (status IN ('pending_scan', 'ready', 'quarantined', 'rejected', 'deleted')),
  uploaded_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT media_assets_source_reference CHECK ((
    (source = 's3' AND storage_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND video_external_id IS NULL)
    OR (source = 'video_provider' AND storage_key IS NULL AND char_length(btrim(video_external_id)) BETWEEN 1 AND 255)
  ) IS TRUE),
  CONSTRAINT media_assets_public_ready CHECK (visibility = 'private' OR status = 'ready')
);
CREATE INDEX media_assets_uploaded_by_idx ON media_assets(uploaded_by);

-- Never repoint an already scanned asset at another object, including by
-- switching its source. A replacement needs its own row and scan.
CREATE FUNCTION guard_media_asset_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.source, NEW.storage_key, NEW.video_external_id) IS DISTINCT FROM
     (OLD.source, OLD.storage_key, OLD.video_external_id) THEN
    RAISE EXCEPTION 'MEDIA_REFERENCE_IMMUTABLE';
  END IF;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;
CREATE TRIGGER media_asset_update BEFORE UPDATE ON media_assets
  FOR EACH ROW EXECUTE FUNCTION guard_media_asset_update();
