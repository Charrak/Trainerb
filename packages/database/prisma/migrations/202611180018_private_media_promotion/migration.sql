ALTER TABLE course_media_uploads
  ADD COLUMN promoted_asset_id uuid UNIQUE REFERENCES media_assets(id) ON DELETE RESTRICT,
  ADD COLUMN promotion_error text,
  ADD CONSTRAINT upload_promotion_approval CHECK (
    (promoted_asset_id IS NULL AND promotion_error IS NULL) OR
    (approved_at IS NOT NULL AND (
      (promoted_asset_id IS NOT NULL AND promotion_error IS NULL) OR
      (promoted_asset_id IS NULL AND promotion_error IS NOT NULL AND promotion_error IN ('storage','integrity','destination'))))
  );
CREATE INDEX course_media_uploads_promotion_queue ON course_media_uploads(approved_at,id)
  WHERE approved_at IS NOT NULL AND promoted_asset_id IS NULL AND promotion_error IS NULL;
