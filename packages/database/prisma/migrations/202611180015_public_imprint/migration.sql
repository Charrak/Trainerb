-- The imprint has a published wording, but is not a checkout acceptance.
ALTER TABLE legal_documents DROP CONSTRAINT legal_documents_kind_check,
  ADD CONSTRAINT legal_documents_kind_check CHECK (kind IN ('terms','privacy','withdrawal','imprint'));
