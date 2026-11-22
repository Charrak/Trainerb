-- ------------------------------------------------------------ Belege (GoBD) --
-- Was diese Migration technisch sichert, und was bewusst *nicht* hier passiert:
--
--  * Pflichtangaben nach § 14 Abs. 4 UStG werden vollständig: neben der
--    USt-IdNr. gibt es die Steuernummer, und jeder Beleg trägt den Zeitpunkt
--    bzw. Zeitraum der Leistung. Beides ist Teil des eingefrorenen Snapshots,
--    damit ein Beleg von 2026 auch 2036 noch vollständig ist.
--  * Ein ausgestellter Beleg lässt sich nicht mehr ändern und nicht löschen.
--    Ein Trigger erzwingt das auf Datenbankebene, nicht nur im Anwendungscode.
--  * Jeder Beleg bekommt eine Prüfsumme und einen Verweis auf den vorherigen
--    Beleg. Damit ist nachträgliches ändern und wieder "geradebiegen" nicht
--    unsichtbar: die Kette bricht.
--  * Rechnungsnummern laufen je Kalenderjahr in einem eigenen Zähler. Die alte
--    globale Sequenz mit dem Jahr aus `CURRENT_DATE` konnte beim Jahreswechsel
--    eine Nummer mit "falschem" Jahr erzeugen.
--
-- Nicht hier: gesetzliche Aufbewahrungsfristen als Löschsperre. Die Trigger
-- verbieten Löschen vollständig; die 10-Jahres-Frist (§ 147 AO, § 14b UStG)
-- wird in `apps/api/src/document-retention.ts` beschrieben und im Export
-- ausgewiesen.

-- ------------------------------------------------- Steuernummer und § 19 UStG --
ALTER TABLE commerce_settings
  -- § 14 Abs. 4 Nr. 2 UStG verlangt Steuernummer **oder** USt-IdNr.
  ADD COLUMN invoice_seller_tax_number text,
  -- Kleinunternehmerregelung: keine Umsatzsteuer ausweisen (§ 19 Abs. 1 UStG).
  ADD COLUMN small_business boolean NOT NULL DEFAULT false;

-- ------------------------------------------------------- Nummernkreis je Jahr --
-- Eindeutig und fortlaufend *je Nummernkreis und Jahr*. Der Zähler ist eine
-- Zeile pro Jahr; die Zeilensperre serialisiert gleichzeitige Ausstellungen.
CREATE TABLE document_number_counters (
  kind       text    NOT NULL CHECK (kind IN ('invoice', 'credit_note')),
  year       integer NOT NULL CHECK (year BETWEEN 2000 AND 2999),
  last_value bigint  NOT NULL CHECK (last_value > 0),
  PRIMARY KEY (kind, year)
);

-- Das Jahr kommt aus derselben Zeitzone, in der die Belegdaten angezeigt
-- werden. `at` ist der Ausstellungszeitpunkt, nicht die Systemuhr beim Aufruf:
-- damit passen Nummer, Rechnungsdatum und Prüfsumme zusammen.
CREATE FUNCTION trainerb_next_document_number(prefix text, document_kind text, at timestamptz)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE year_value integer; next_value bigint;
BEGIN
  year_value := to_char(at AT TIME ZONE 'Europe/Berlin', 'YYYY')::integer;
  INSERT INTO document_number_counters AS counter (kind, year, last_value)
    VALUES (document_kind, year_value, 1)
    ON CONFLICT (kind, year) DO UPDATE SET last_value = counter.last_value + 1
    RETURNING counter.last_value INTO next_value;
  RETURN prefix || year_value::text || '-' || lpad(next_value::text, 6, '0');
END $$;

-- Bestehende Nummern bleiben gültig. Der Zähler startet hinter der höchsten
-- bereits vergebenen Nummer des jeweiligen Jahres, damit keine Nummer doppelt
-- entsteht; die vorhandene Lücke (die alte Sequenz war global) bleibt sichtbar
-- und wird nicht rückwirkend "geschlossen".
INSERT INTO document_number_counters (kind, year, last_value)
SELECT 'invoice', split_part(invoice_number, '-', 3)::integer,
       max(split_part(invoice_number, '-', 4)::bigint)
FROM invoices
WHERE invoice_number ~ '^TB-RE-[0-9]{4}-[0-9]{6}$'
GROUP BY 1, 2;
INSERT INTO document_number_counters (kind, year, last_value)
SELECT 'credit_note', split_part(document_number, '-', 3)::integer,
       max(split_part(document_number, '-', 4)::bigint)
FROM credit_notes
WHERE document_number ~ '^TB-GS-[0-9]{4}-[0-9]{6}$'
GROUP BY 1, 2;

-- ------------------------------------------------- Leistungszeitpunkt und Hash --
-- `service_date` ist der Tag der Leistung, `service_end_date` das Ende eines
-- Leistungszeitraums (bei Zugängen mit Laufzeit). Beide sind Teil des
-- Snapshots und werden nie nachgezogen.
ALTER TABLE invoices
  ADD COLUMN service_date     date,
  ADD COLUMN service_end_date date,
  -- SHA-256 über den kanonischen Beleginhalt (Anwendungsschicht, nicht DB).
  ADD COLUMN content_hash     bytea CHECK (content_hash IS NULL OR octet_length(content_hash) = 32),
  ADD COLUMN previous_hash    bytea CHECK (previous_hash IS NULL OR octet_length(previous_hash) = 32),
  ADD CONSTRAINT invoices_service_period CHECK (
    service_end_date IS NULL OR service_date IS NULL OR service_end_date >= service_date);

ALTER TABLE credit_notes
  ADD COLUMN service_date     date,
  ADD COLUMN service_end_date date,
  ADD COLUMN content_hash     bytea CHECK (content_hash IS NULL OR octet_length(content_hash) = 32),
  ADD COLUMN previous_hash    bytea CHECK (previous_hash IS NULL OR octet_length(previous_hash) = 32),
  ADD CONSTRAINT credit_notes_service_period CHECK (
    service_end_date IS NULL OR service_date IS NULL OR service_end_date >= service_date);

-- Bestehende Belege: das Rechnungsdatum ist der einzige belastbare Anhaltspunkt,
-- der vor der Einführung des Feldes dokumentiert wurde. Ein Zeitraum wird nicht
-- erfunden. Die Prüfsumme bleibt zunächst leer und wird über
-- `npm run docs:seal` einmalig nachgezogen (siehe Trigger unten).
UPDATE invoices SET service_date = (issued_at AT TIME ZONE 'Europe/Berlin')::date;
UPDATE credit_notes SET service_date = (issued_at AT TIME ZONE 'Europe/Berlin')::date;

-- ------------------------------------------------------------- Unveränderlich --
-- Ein Beleg ist nach der Ausstellung unveränderlich (GoBD: Unveränderbarkeit,
-- Nachvollziehbarkeit). Die *einzige* erlaubte Änderung ist das einmalige
-- Versiegeln eines Belegs, der vor Einführung der Prüfsumme entstanden ist:
-- dabei dürfen ausschließlich `content_hash` und `previous_hash` von NULL auf
-- einen Wert gesetzt werden, und alle anderen Spalten müssen identisch bleiben.
CREATE FUNCTION trainerb_documents_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '%_IMMUTABLE', upper(TG_TABLE_NAME)
      USING HINT = 'Belege werden nicht gelöscht (Aufbewahrungspflicht).';
  END IF;
  IF OLD.content_hash IS NULL AND NEW.content_hash IS NOT NULL
     AND OLD.previous_hash IS NULL
     AND (to_jsonb(OLD) - 'content_hash' - 'previous_hash')
       = (to_jsonb(NEW) - 'content_hash' - 'previous_hash') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%_IMMUTABLE', upper(TG_TABLE_NAME)
    USING HINT = 'Ein ausgestellter Beleg wird weder geändert noch gelöscht.';
END $$;

CREATE TRIGGER invoices_immutable BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION trainerb_documents_immutable();
CREATE TRIGGER credit_notes_immutable BEFORE UPDATE OR DELETE ON credit_notes
  FOR EACH ROW EXECUTE FUNCTION trainerb_documents_immutable();

-- Die Kette wird in Reihenfolge der Belegnummern gelesen; der Index hält das
-- auch bei einem Archiv mit vielen Jahren billig.
CREATE INDEX invoices_number_order ON invoices(invoice_number);
CREATE INDEX credit_notes_number_order ON credit_notes(document_number);
