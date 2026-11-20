-- Nur die Obergrenze erweitern. Bestehende Fassungen, Freigaben und
-- Bestellbezüge bleiben unverändert; Leertext bleibt unzulässig.
ALTER TABLE legal_document_versions DROP CONSTRAINT legal_document_versions_wording_check,
  ADD CONSTRAINT legal_document_versions_wording_check CHECK (char_length(btrim(wording)) BETWEEN 1 AND 100000);
ALTER TABLE page_versions DROP CONSTRAINT page_versions_body_check,
  ADD CONSTRAINT page_versions_body_check CHECK (length(trim(body)) BETWEEN 1 AND 100000);
