-- Phase 6 foundation: the first evaluator profile is chapter single-choice, 3/4/3.
-- No content or attempts are seeded. The publication gate remains closed.
CREATE TABLE exams (
  id uuid PRIMARY KEY,
  course_version_id uuid NOT NULL,
  chapter_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  position integer NOT NULL CHECK (position >= 0),
  exam_type text NOT NULL DEFAULT 'single_choice_quiz' CHECK (exam_type = 'single_choice_quiz'),
  question_count smallint NOT NULL DEFAULT 3 CHECK (question_count = 3),
  option_count smallint NOT NULL DEFAULT 4 CHECK (option_count = 4),
  pass_rule jsonb NOT NULL DEFAULT '{"schema_version":1,"kind":"min_correct","min_correct":3}'
    CHECK (pass_rule = '{"schema_version":1,"kind":"min_correct","min_correct":3}'::jsonb),
  FOREIGN KEY (chapter_id, course_version_id) REFERENCES course_chapters(id, course_version_id) ON DELETE RESTRICT,
  UNIQUE (chapter_id, position), UNIQUE (id, course_version_id)
);
CREATE INDEX exams_course_version_id_idx ON exams(course_version_id);
CREATE TABLE question_pools (
  id uuid PRIMARY KEY,
  exam_id uuid NOT NULL UNIQUE REFERENCES exams(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  UNIQUE (id, exam_id)
);
CREATE TABLE questions (
  id uuid PRIMARY KEY,
  pool_id uuid NOT NULL, exam_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  question_text text NOT NULL CHECK (length(btrim(question_text)) > 0),
  explanation text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  CHECK (status <> 'active' OR length(btrim(explanation)) > 0),
  FOREIGN KEY (pool_id, exam_id) REFERENCES question_pools(id, exam_id) ON DELETE RESTRICT,
  UNIQUE (pool_id, position), UNIQUE (id, exam_id)
);
CREATE TABLE answer_options (
  id uuid PRIMARY KEY,
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 4),
  option_text text NOT NULL CHECK (length(btrim(option_text)) > 0),
  is_correct boolean NOT NULL DEFAULT false,
  UNIQUE (question_id, position), UNIQUE (id, question_id)
);
CREATE UNIQUE INDEX answer_options_one_correct ON answer_options(question_id) WHERE is_correct;

-- A grant belongs to one learner/version; never accept an exam from another version.
ALTER TABLE course_access ADD UNIQUE (id, course_version_id);
CREATE TABLE exam_attempts (
  id uuid PRIMARY KEY,
  access_id uuid NOT NULL, course_version_id uuid NOT NULL, exam_id uuid NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  start_idempotency_key text NOT NULL CHECK (length(btrim(start_idempotency_key)) BETWEEN 1 AND 128),
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted','expired')),
  started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, submitted_at timestamptz,
  CHECK ((status = 'submitted') = (submitted_at IS NOT NULL) AND (submitted_at IS NULL OR submitted_at >= started_at)),
  FOREIGN KEY (access_id, course_version_id) REFERENCES course_access(id, course_version_id) ON DELETE RESTRICT,
  FOREIGN KEY (exam_id, course_version_id) REFERENCES exams(id, course_version_id) ON DELETE RESTRICT,
  UNIQUE (access_id, exam_id, attempt_no), UNIQUE (access_id, start_idempotency_key), UNIQUE (id, exam_id)
);
CREATE UNIQUE INDEX exam_attempts_one_open ON exam_attempts(access_id, exam_id) WHERE status = 'in_progress';
CREATE INDEX exam_attempts_exam_id_idx ON exam_attempts(exam_id);
CREATE TABLE exam_attempt_questions (
  attempt_id uuid NOT NULL, exam_id uuid NOT NULL, question_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 3),
  FOREIGN KEY (attempt_id, exam_id) REFERENCES exam_attempts(id, exam_id) ON DELETE RESTRICT,
  FOREIGN KEY (question_id, exam_id) REFERENCES questions(id, exam_id) ON DELETE RESTRICT,
  PRIMARY KEY (attempt_id, question_id), UNIQUE (attempt_id, position)
);
CREATE INDEX exam_attempt_questions_question_id_idx ON exam_attempt_questions(question_id);
CREATE TABLE exam_attempt_options (
  attempt_id uuid NOT NULL, question_id uuid NOT NULL, option_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 4),
  FOREIGN KEY (attempt_id, question_id) REFERENCES exam_attempt_questions(attempt_id, question_id) ON DELETE RESTRICT,
  FOREIGN KEY (option_id, question_id) REFERENCES answer_options(id, question_id) ON DELETE RESTRICT,
  PRIMARY KEY (attempt_id, question_id, option_id), UNIQUE (attempt_id, question_id, position)
);
CREATE INDEX exam_attempt_options_option_id_idx ON exam_attempt_options(option_id);

-- A retry starts a new attempt: never reopen a terminal row or relabel its owner/exam.
CREATE FUNCTION guard_exam_attempt_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'in_progress' OR
     (OLD.id, OLD.access_id, OLD.course_version_id, OLD.exam_id, OLD.attempt_no, OLD.start_idempotency_key, OLD.started_at)
     IS DISTINCT FROM
     (NEW.id, NEW.access_id, NEW.course_version_id, NEW.exam_id, NEW.attempt_no, NEW.start_idempotency_key, NEW.started_at) THEN
    RAISE EXCEPTION 'EXAM_ATTEMPT_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER exam_attempt_update BEFORE UPDATE ON exam_attempts FOR EACH ROW EXECUTE FUNCTION guard_exam_attempt_update();

-- Selection rows are inserted in the start transaction; never reshuffle them.
CREATE FUNCTION guard_exam_selection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM id FROM exam_attempts WHERE id = NEW.attempt_id AND status = 'in_progress' FOR SHARE;
    IF FOUND THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'EXAM_SELECTION_IMMUTABLE';
END $$;
CREATE TRIGGER exam_question_selection BEFORE INSERT OR UPDATE OR DELETE ON exam_attempt_questions
  FOR EACH ROW EXECUTE FUNCTION guard_exam_selection();
CREATE TRIGGER exam_option_selection BEFORE INSERT OR UPDATE OR DELETE ON exam_attempt_options
  FOR EACH ROW EXECUTE FUNCTION guard_exam_selection();
