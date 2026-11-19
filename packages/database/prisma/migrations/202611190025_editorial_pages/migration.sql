-- Additive editorial storage. No public content is seeded.
CREATE TABLE pages (
  id uuid PRIMARY KEY, slug text NOT NULL UNIQUE CHECK (length(slug) <= 80 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0)
);
CREATE TABLE page_versions (
  id uuid PRIMARY KEY, page_id uuid NOT NULL REFERENCES pages(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0), state text NOT NULL CHECK (state IN ('draft','published','retired')),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 20000), description text NOT NULL CHECK (length(description)<=300),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid REFERENCES users(id) ON DELETE RESTRICT, published_at timestamptz,
  CHECK ((published_at IS NULL) = (published_by IS NULL)), CHECK (state <> 'published' OR published_at IS NOT NULL),
  UNIQUE(page_id, version)
);
CREATE UNIQUE INDEX page_one_published ON page_versions(page_id) WHERE state='published';
CREATE UNIQUE INDEX page_one_draft ON page_versions(page_id) WHERE state='draft';
-- No automatic merging of pre-existing legal documents or checkout evidence.
CREATE UNIQUE INDEX legal_documents_kind_key ON legal_documents(kind);
ALTER TABLE legal_documents DROP CONSTRAINT legal_documents_kind_check,
  ADD CONSTRAINT legal_documents_kind_check CHECK (kind IN ('terms','privacy','withdrawal','imprint','payment_info'));

-- An edit creates a new row. Even an accidental in-place content update would
-- otherwise silently alter the version associated with a recorded release.
CREATE FUNCTION editorial_version_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PAGE_VERSION_IMMUTABLE'; END IF;
  IF (NEW.id,NEW.page_id,NEW.version,NEW.title,NEW.body,NEW.description,NEW.created_by,NEW.created_at)
     IS DISTINCT FROM (OLD.id,OLD.page_id,OLD.version,OLD.title,OLD.body,OLD.description,OLD.created_by,OLD.created_at)
     OR NOT ((OLD.state='draft' AND NEW.state='published') OR
       (OLD.state IN ('draft','published') AND NEW.state='retired' AND
         (NEW.published_at,NEW.published_by) IS NOT DISTINCT FROM (OLD.published_at,OLD.published_by)))
  THEN RAISE EXCEPTION 'PAGE_VERSION_IMMUTABLE'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER editorial_version_immutable BEFORE UPDATE OR DELETE ON page_versions FOR EACH ROW EXECUTE FUNCTION editorial_version_transition();
