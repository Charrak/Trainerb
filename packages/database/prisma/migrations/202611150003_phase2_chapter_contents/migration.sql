-- Phase 2, second slice: ordered, version-bound draft lesson text.
-- Media kinds remain locked until private storage, scanning and authorization exist.
CREATE TABLE chapter_contents (
  id uuid PRIMARY KEY,
  course_version_id uuid NOT NULL REFERENCES course_versions(id) ON DELETE RESTRICT,
  chapter_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'text',
  title text CHECK (title IS NULL OR char_length(btrim(title)) BETWEEN 1 AND 160),
  body jsonb NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 100000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (chapter_id, course_version_id) REFERENCES course_chapters(id, course_version_id) ON DELETE RESTRICT,
  UNIQUE (chapter_id, position),
  CONSTRAINT phase2_content_text_only CHECK (kind = 'text'),
  CONSTRAINT chapter_content_body_size CHECK (octet_length(body::text) <= 32000),
  -- A row is one ordered editor block wrapped in the versioned document format.
  -- The API validates each block's exact fields and value constraints as well.
  CONSTRAINT chapter_content_body_schema CHECK ((CASE
    WHEN jsonb_typeof(body) = 'object' AND body->'schema_version' = '1'::jsonb
      AND jsonb_typeof(body->'blocks') = 'array'
    THEN jsonb_array_length(body->'blocks') = 1
      AND jsonb_typeof(body->'blocks'->0) = 'object'
      AND body->'blocks'->0->>'id' = id::text
      AND body->'blocks'->0->>'kind' IN ('paragraph', 'heading', 'list', 'link')
    ELSE false END) IS TRUE)
);
CREATE INDEX chapter_contents_course_version_id_idx ON chapter_contents(course_version_id);
