-- Old and queued messages keep their actual approved text, never a mutable pointer.
CREATE FUNCTION guard_mail_version_content() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (NEW.id,NEW.template_id,NEW.version,NEW.subject_template,NEW.body_text_template,NEW.body_html_template,NEW.allowed_variables,NEW.created_by,NEW.created_at)
 IS DISTINCT FROM (OLD.id,OLD.template_id,OLD.version,OLD.subject_template,OLD.body_text_template,OLD.body_html_template,OLD.allowed_variables,OLD.created_by,OLD.created_at)
 OR NOT ((OLD.state='draft' AND NEW.state='published' AND NEW.published_at IS NOT NULL) OR (OLD.state IN('draft','published') AND NEW.state='retired' AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at))
 THEN RAISE EXCEPTION 'MAIL_TEMPLATE_VERSION_IMMUTABLE'; END IF; RETURN NEW; END $$;
CREATE TRIGGER guard_mail_version BEFORE UPDATE OR DELETE ON email_template_versions FOR EACH ROW EXECUTE FUNCTION guard_mail_version_content();
