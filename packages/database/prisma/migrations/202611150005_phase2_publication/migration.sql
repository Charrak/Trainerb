-- Phase 2, publication and activation slice. Real status transitions replace the
-- earlier "everything is a draft" locks, but each transition is guarded inside
-- the database: publication is a catalogue state only, there is still no
-- checkout, order, payment, learning access or exam.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- A course may only be published while it has a published version, and a
-- published version must always carry publisher metadata.
ALTER TABLE courses DROP CONSTRAINT phase2_course_publication_locked;
ALTER TABLE course_versions DROP CONSTRAINT phase2_version_publication_locked;
ALTER TABLE course_versions DROP CONSTRAINT phase2_no_published_metadata;

ALTER TABLE course_versions ADD CONSTRAINT course_versions_published_metadata CHECK (
  (state = 'published' AND published_by IS NOT NULL AND published_at IS NOT NULL)
  OR (state <> 'published' AND published_by IS NULL AND published_at IS NULL)
);
-- The unique published index already exists from migration 2.
CREATE UNIQUE INDEX course_versions_one_draft ON course_versions(course_id) WHERE state = 'draft';

-- Publication history is append-only and keeps every transition.
CREATE TABLE course_publications (
  id uuid PRIMARY KEY,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  course_version_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  action text NOT NULL CHECK (action IN ('published', 'unpublished')),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (course_version_id, course_id) REFERENCES course_versions(id, course_id) ON DELETE RESTRICT
);
CREATE INDEX course_publications_course_idx ON course_publications(course_id, created_at DESC, id);
CREATE INDEX course_publications_actor_idx ON course_publications(actor_user_id);

ALTER TABLE products ADD COLUMN activated_at timestamptz;
ALTER TABLE products ADD COLUMN activated_by uuid REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE products DROP CONSTRAINT phase2_product_activation_locked;
ALTER TABLE prices DROP CONSTRAINT phase2_price_activation_locked;

ALTER TABLE products ADD CONSTRAINT products_activation_metadata CHECK (
  (status = 'active' AND activated_at IS NOT NULL AND activated_by IS NOT NULL)
  OR (status <> 'active' AND activated_at IS NULL AND activated_by IS NULL)
);

-- Completeness is only demanded for an activated product: an incomplete draft
-- stays savable. A single product carries exactly one course, a bundle at least
-- two different courses, and every linked course must actually be published.
CREATE FUNCTION trainerb_product_activation_ok(target uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM products p
    WHERE p.id = target AND (
      (SELECT count(*) FROM product_courses pc WHERE pc.product_id = p.id) >= CASE WHEN p.type = 'single' THEN 1 ELSE 2 END
      AND (p.type <> 'single' OR (SELECT count(*) FROM product_courses pc WHERE pc.product_id = p.id) = 1)
      AND NOT EXISTS (
        SELECT 1 FROM product_courses pc JOIN courses c ON c.id = pc.course_id
        WHERE pc.product_id = p.id AND c.status <> 'published'
      )
    )
  )
$$;

CREATE FUNCTION trainerb_check_product_activation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'active' AND NOT trainerb_product_activation_ok(NEW.id) THEN
    RAISE EXCEPTION 'PRODUCT_INCOMPLETE' USING HINT = 'An activated product needs published course links that match its type.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER products_activation_guard BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION trainerb_check_product_activation();

CREATE FUNCTION trainerb_check_product_links() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected uuid := COALESCE(NEW.product_id, OLD.product_id);
BEGIN
  IF EXISTS (SELECT 1 FROM products WHERE id = affected AND status = 'active')
     AND NOT trainerb_product_activation_ok(affected) THEN
    RAISE EXCEPTION 'PRODUCT_INCOMPLETE' USING HINT = 'An activated product cannot lose its required course links.';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER product_courses_activation_guard AFTER INSERT OR UPDATE OR DELETE ON product_courses
  FOR EACH ROW EXECUTE FUNCTION trainerb_check_product_links();

-- A course cannot leave publication while an activated product still points at it.
CREATE FUNCTION trainerb_check_course_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'published' AND EXISTS (
    SELECT 1 FROM product_courses pc JOIN products p ON p.id = pc.product_id
    WHERE pc.course_id = NEW.id AND p.status = 'active'
  ) THEN
    RAISE EXCEPTION 'COURSE_STILL_IN_ACTIVE_PRODUCT' USING HINT = 'Deactivate or detach the product before unpublishing this course.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER courses_publication_guard BEFORE UPDATE ON courses
  FOR EACH ROW EXECUTE FUNCTION trainerb_check_course_publication();

-- Two active price windows of the same product and currency must not overlap.
-- Drafts may overlap so a replacement can be prepared before activation.
ALTER TABLE prices ADD CONSTRAINT prices_no_overlapping_active_ranges EXCLUDE USING gist (
  product_id WITH =, currency WITH =, tstzrange(valid_from, COALESCE(valid_until, 'infinity'::timestamptz), '[)') WITH &&
) WHERE (status = 'active');

ALTER TABLE prices ADD CONSTRAINT prices_active_requires_positive_gross CHECK (
  status <> 'active' OR gross_cents > 0
);
CREATE FUNCTION trainerb_check_price_activation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'active' AND NOT EXISTS (SELECT 1 FROM products WHERE id = NEW.product_id AND status = 'active') THEN
    RAISE EXCEPTION 'PRICE_PRODUCT_INACTIVE' USING HINT = 'Activate the product before activating one of its prices.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prices_activation_guard BEFORE INSERT OR UPDATE ON prices
  FOR EACH ROW EXECUTE FUNCTION trainerb_check_price_activation();

-- The last published version of a published course cannot disappear.
CREATE FUNCTION trainerb_check_last_published_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'published' AND NEW.state <> 'published'
     AND EXISTS (SELECT 1 FROM courses WHERE id = NEW.course_id AND status = 'published')
     AND NOT EXISTS (SELECT 1 FROM course_versions WHERE course_id = NEW.course_id AND state = 'published') THEN
    RAISE EXCEPTION 'LAST_PUBLISHED_VERSION' USING HINT = 'Unpublish the course before retiring its last published version.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER course_versions_last_published_guard BEFORE UPDATE ON course_versions
  FOR EACH ROW EXECUTE FUNCTION trainerb_check_last_published_version();

-- A published course must actually have a published version; the check is a
-- trigger because PostgreSQL CHECK constraints cannot contain subqueries.
CREATE FUNCTION trainerb_check_course_has_published_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'published' AND NOT EXISTS (
    SELECT 1 FROM course_versions WHERE course_id = NEW.id AND state = 'published'
  ) THEN
    RAISE EXCEPTION 'COURSE_WITHOUT_PUBLISHED_VERSION' USING HINT = 'Publish a version before publishing the course.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER courses_published_version_guard BEFORE UPDATE ON courses
  FOR EACH ROW EXECUTE FUNCTION trainerb_check_course_has_published_version();
