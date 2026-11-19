-- Explicit opt-in. A course with coincidentally similar planning numbers is not a qualification.
ALTER TABLE course_versions ADD COLUMN completion_profile text
  CHECK (completion_profile = 'qualification_84_v1'), ADD UNIQUE (id, completion_profile);
ALTER TABLE course_versions ADD CONSTRAINT qualification_profile_plan CHECK (completion_profile IS NULL OR
  (expected_module_count = 14 AND expected_chapter_count = 42 AND expected_exams_per_chapter = 2 AND chapter_completion_mode <> 'self_confirm') IS TRUE);
CREATE TABLE completion_records (
  id uuid PRIMARY KEY,
  access_id uuid NOT NULL UNIQUE,
  course_version_id uuid NOT NULL,
  completion_profile text NOT NULL,
  completed_at timestamptz NOT NULL,
  evidence_snapshot jsonb NOT NULL,
  FOREIGN KEY (access_id, course_version_id) REFERENCES course_access(id, course_version_id),
  FOREIGN KEY (course_version_id, completion_profile) REFERENCES course_versions(id, completion_profile),
  CHECK ((jsonb_typeof(evidence_snapshot->'exams') = 'array' AND jsonb_array_length(evidence_snapshot->'exams') = 84
      AND jsonb_typeof(evidence_snapshot->'chapters') = 'array' AND jsonb_array_length(evidence_snapshot->'chapters') = 42) IS TRUE)
);
CREATE FUNCTION trainerb_guard_completion_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'COMPLETION_RECORD_IMMUTABLE'; END $$;
CREATE TRIGGER completion_record_immutable BEFORE UPDATE OR DELETE ON completion_records
  FOR EACH ROW EXECUTE FUNCTION trainerb_guard_completion_record();
