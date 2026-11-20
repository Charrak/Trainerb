-- Merge touching access intervals, not just the latest grant. A gap remains a gap.
CREATE VIEW current_course_expiries AS
SELECT periods.user_id,periods.course_id,upper(span) AS ends_at,
 CASE WHEN upper(span)<=now()+interval '24 hours' THEN 1 ELSE 7 END AS window_days
FROM (SELECT user_id,course_id,range_agg(tstzrange(starts_at,ends_at,'[)')) AS spans FROM course_access
 WHERE revoked_at IS NULL AND suspended_at IS NULL AND (ends_at IS NULL OR ends_at>now()) GROUP BY user_id,course_id) periods
 CROSS JOIN LATERAL unnest(spans) span
 WHERE span @> now() AND NOT upper_inf(span) AND upper(span)<=now()+interval '168 hours';
CREATE TABLE access_expiry_notices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users,course_id uuid NOT NULL REFERENCES courses,
 ends_at timestamptz NOT NULL,window_days integer NOT NULL CHECK(window_days IN (1,7)),outbox_id uuid UNIQUE REFERENCES email_outbox ON DELETE SET NULL,
 UNIQUE(user_id,course_id,ends_at,window_days)
);
