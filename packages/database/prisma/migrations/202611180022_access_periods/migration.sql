-- Keep expired grants (and their purchase/exam history). btree_gist exists since phase 2.
DROP INDEX course_access_one_active;
ALTER TABLE course_access ADD CONSTRAINT course_access_no_overlap EXCLUDE USING gist
  (user_id WITH =, course_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&) WHERE (revoked_at IS NULL);
