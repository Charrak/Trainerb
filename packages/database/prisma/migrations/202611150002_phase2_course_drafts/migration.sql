-- Phase 2, first slice: versioned course drafts and scoped staff assignments.
-- No checkout, course publication, learning content or exam system yet.
CREATE TABLE courses (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (char_length(slug) BETWEEN 1 AND 100 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','deactivated','archived')),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','unlisted','private')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Fail closed until publication validation, exams and release review exist.
  CONSTRAINT phase2_course_publication_locked CHECK (status <> 'published')
);
CREATE INDEX courses_status_visibility_sort_idx ON courses(status, visibility, sort_order, id);

CREATE TABLE course_versions (
  id uuid PRIMARY KEY,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','retired')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  subtitle text CHECK (subtitle IS NULL OR char_length(subtitle) BETWEEN 1 AND 240),
  description jsonb NOT NULL CHECK ((jsonb_typeof(description) = 'object' AND description->'schema_version' = '1'::jsonb AND jsonb_typeof(description->'blocks') = 'array') IS TRUE),
  duration_minutes integer CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  default_access_days integer CHECK (default_access_days IS NULL OR default_access_days > 0),
  chapter_completion_mode text NOT NULL DEFAULT 'self_confirm' CHECK (chapter_completion_mode IN ('self_confirm','all_chapter_exams','self_or_all_chapter_exams')),
  expected_module_count integer CHECK (expected_module_count IS NULL OR expected_module_count BETWEEN 1 AND 500),
  expected_chapter_count integer CHECK (expected_chapter_count IS NULL OR expected_chapter_count BETWEEN 1 AND 5000),
  expected_exams_per_chapter integer CHECK (expected_exams_per_chapter IS NULL OR expected_exams_per_chapter BETWEEN 1 AND 100),
  content_schema_version smallint NOT NULL DEFAULT 1 CHECK (content_schema_version = 1),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  published_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (course_id, version),
  UNIQUE (id, course_id),
  CONSTRAINT phase2_version_publication_locked CHECK (state = 'draft'),
  CONSTRAINT phase2_no_published_metadata CHECK (published_by IS NULL AND published_at IS NULL)
);
CREATE UNIQUE INDEX course_versions_one_published ON course_versions(course_id) WHERE state = 'published';
CREATE INDEX course_versions_created_by_idx ON course_versions(created_by);
CREATE INDEX course_versions_published_by_idx ON course_versions(published_by);

CREATE TABLE course_modules (
  id uuid PRIMARY KEY,
  course_version_id uuid NOT NULL REFERENCES course_versions(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  description text CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 4000),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 100000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (course_version_id, position),
  UNIQUE (id, course_version_id)
);

CREATE TABLE course_chapters (
  id uuid PRIMARY KEY,
  course_version_id uuid NOT NULL REFERENCES course_versions(id) ON DELETE RESTRICT,
  module_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  summary text CHECK (summary IS NULL OR char_length(summary) BETWEEN 1 AND 4000),
  estimated_minutes integer CHECK (estimated_minutes IS NULL OR estimated_minutes BETWEEN 1 AND 100000),
  position integer NOT NULL CHECK (position BETWEEN 0 AND 100000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (module_id, course_version_id) REFERENCES course_modules(id, course_version_id) ON DELETE RESTRICT,
  UNIQUE (module_id, position),
  UNIQUE (id, course_version_id)
);
CREATE INDEX course_chapters_course_version_id_idx ON course_chapters(course_version_id);

CREATE TABLE course_staff (
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  scope_role text NOT NULL CHECK (scope_role IN ('manager','instructor')),
  assigned_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (course_id, user_id, scope_role)
);
CREATE INDEX course_staff_user_scope_idx ON course_staff(user_id, scope_role);
CREATE INDEX course_staff_assigner_idx ON course_staff(assigned_by);
