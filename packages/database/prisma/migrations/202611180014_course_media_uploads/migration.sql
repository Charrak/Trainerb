-- Quarantine receipts deliberately cannot be referenced by covers or chapters.
CREATE TABLE course_media_uploads (
  id uuid PRIMARY KEY,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  uploaded_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  object_key uuid NOT NULL UNIQUE,
  original_name text NOT NULL CHECK (char_length(original_name) BETWEEN 1 AND 160),
  mime_detected text NOT NULL CHECK (mime_detected IN ('image/png','image/jpeg','application/pdf')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  status text NOT NULL DEFAULT 'pending_scan' CHECK (status = 'pending_scan'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX course_media_uploads_course_id_idx ON course_media_uploads(course_id);
CREATE INDEX course_media_uploads_uploaded_by_idx ON course_media_uploads(uploaded_by);
