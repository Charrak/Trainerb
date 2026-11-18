-- Existing receipts have no editorial decision, including those already scanned clean.
ALTER TABLE course_media_uploads
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN approved_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD CONSTRAINT upload_approval_clean CHECK (
    (approved_at IS NULL AND approved_by IS NULL) OR
    (approved_at IS NOT NULL AND approved_by IS NOT NULL AND status = 'clean')
  );
CREATE INDEX course_media_uploads_approved_by_idx ON course_media_uploads(approved_by);
