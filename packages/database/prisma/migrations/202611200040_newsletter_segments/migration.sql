-- Newsletter-Segmente und feste Empfängerzahl. Rein additiv: bestehende
-- Einwilligungen, Kampagnen, Versandnachweise und Sperren bleiben unverändert.
--
-- 1) "Kurse" (audience='kurse') wird zur bestätigten Einwilligung zum Thema
--    Kurse; "akademie" bleibt "alle bestätigten Themen". Zusätzlich entsteht
--    das hinterlegte Segment "Lernende mit aktivem Zugang": bestätigte
--    Einwilligung UND ein bestehender aktiver Kurszugang zum Versandzeitpunkt.
ALTER TABLE newsletter_campaigns DROP CONSTRAINT newsletter_campaigns_audience_check;
ALTER TABLE newsletter_campaigns ADD CONSTRAINT newsletter_campaigns_audience_check
  CHECK (audience IN ('all','kurse','akademie','kurse_aktiv'));

-- 2) Die beim Einfrieren ermittelte Empfängerzahl wird festgehalten, damit die
--    Redaktion den tatsächlich festgelegten Kreis prüfen kann.
ALTER TABLE newsletter_campaigns ADD COLUMN audience_size integer
  CHECK (audience_size IS NULL OR audience_size >= 0);
