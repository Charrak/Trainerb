-- Existing schema-only fixtures may lack snapshots; the learner service refuses them.
ALTER TABLE exam_attempt_questions ADD COLUMN prompt text, ADD COLUMN rationale text;
ALTER TABLE exam_attempt_options ADD COLUMN label text, ADD COLUMN correct boolean;
CREATE TABLE exam_attempt_answers (
  attempt_id uuid NOT NULL, question_id uuid NOT NULL, selected_option_id uuid NOT NULL,
  PRIMARY KEY (attempt_id, question_id),
  FOREIGN KEY (attempt_id, question_id, selected_option_id) REFERENCES exam_attempt_options(attempt_id, question_id, option_id) ON DELETE RESTRICT
);
CREATE TABLE exam_attempt_results (
  attempt_id uuid PRIMARY KEY REFERENCES exam_attempts(id) ON DELETE RESTRICT,
  submit_key uuid NOT NULL, correct_count smallint NOT NULL CHECK (correct_count BETWEEN 0 AND 3),
  passed boolean NOT NULL CHECK (passed = (correct_count = 3)),
  rule_version smallint NOT NULL DEFAULT 1 CHECK (rule_version = 1), evaluated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Once recorded, a result cannot be edited into a pass (or vice versa).
CREATE FUNCTION guard_exam_evaluation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM id FROM exam_attempts WHERE id = NEW.attempt_id AND status = 'in_progress' FOR UPDATE;
    IF FOUND THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'EXAM_EVALUATION_IMMUTABLE';
END $$;
CREATE TRIGGER exam_answer_guard BEFORE INSERT OR UPDATE OR DELETE ON exam_attempt_answers FOR EACH ROW EXECUTE FUNCTION guard_exam_evaluation();
CREATE TRIGGER exam_result_guard BEFORE INSERT OR UPDATE OR DELETE ON exam_attempt_results FOR EACH ROW EXECUTE FUNCTION guard_exam_evaluation();
