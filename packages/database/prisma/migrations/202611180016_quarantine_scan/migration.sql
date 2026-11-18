-- Scan verdicts belong to quarantine receipts, never to published assets.
ALTER TABLE course_media_uploads DROP CONSTRAINT course_media_uploads_status_check,
  ADD COLUMN scanned_at timestamptz,
  ADD COLUMN scan_error text,
  ADD CONSTRAINT course_media_upload_scan_result CHECK (
    (status = 'pending_scan' AND scanned_at IS NULL AND scan_error IS NULL) OR
    (status IN ('clean','infected') AND scanned_at IS NOT NULL AND scan_error IS NULL) OR
    (status = 'scan_error' AND scanned_at IS NOT NULL AND scan_error IS NOT NULL AND
      scan_error IN ('storage','integrity','scanner'))
  );
CREATE INDEX course_media_upload_scan_queue ON course_media_uploads(created_at,id) WHERE status = 'pending_scan';
