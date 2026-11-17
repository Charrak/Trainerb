# 5. Entwicklungsphasen, Abhängigkeiten und Testplan

**Version 1.0 · 15.11.2026 · Vorschlag zur Freigabe**

Nach ausdrücklicher Freigabe wurde die Umsetzung mit Phase 1 begonnen. Der tatsächliche Entwicklungs- und Teststand steht in der [README](../README.md); die folgenden Phasen und Abnahmekriterien bleiben der Zielplan. Jede Phase endet mit nachgewiesenen automatisierten Tests und einer fachlichen Abnahme. Sicherheit, Datenschutz und Barrierefreiheit laufen durchgehend mit.

## 5.1 Abhängigkeitsübersicht

```text
Freigabe Architektur
  └─ 1 Fundament / Identität / Rechte
      ├─ 2 Öffentliche Seiten / Katalog
      │   └─ 3 Warenkorb / Zahlungssandbox
      │       └─ 4 Konto-Fulfillment / E-Mail / Rechnungsauftrag
      │           └─ 5 Kundenportal / Lernen
      │               └─ 6 Prüfungen / Abschluss / Zertifikate
      └─ 7 Vollständiges Backoffice (baut auf 2–6 auf)
          └─ 8 Newsletter / weitere Automatisierungen
              └─ 9 Datenschutz / Sicherheits- und Rechtsfreigaben
                  └─ 10 Gesamtprüfung / Betriebsfreigabe
```

Phase 7 kann für einzelne bereits vorhandene Funktionen früher vorbereitet werden; vollständig abgeschlossen wird sie erst nach deren Implementierung. Phase 3 verwendet ausschließlich den Provider-Testmodus. `COMMERCE_ENABLED=false` bleibt in Produktion und auf der öffentlichen Website gesetzt; in einer isolierten Test-/Staging-Umgebung darf der Checkout für synthetische Daten und Stripe-Testkonten eingeschaltet werden. Testfreigaben und Testdaten gelangen nie in Produktion. Die Ende-zu-Ende-Freischaltung ist erst nach Phase 4 und die vollständige Kursabnahme erst nach Phase 6 testbar. Vor Phase 10 findet kein kommerzieller Start statt.

## 5.2 Phasen mit Ergebnissen und Abnahmekriterien

Die Tabelle beschreibt die geplanten vollständigen Phasen. Phase 2 ist in einem begrenzten Ausschnitt umgesetzt: geschützte Kursentwürfe, Kapitelinhalte, Produkt-/Preisentwürfe sowie die Freigabe (Veröffentlichung eines Kurses, Aktivierung eines Produkts und Aktivierung/Zurückziehen von Preiszeiträumen). Details und aktuelle Grenzen stehen in [07 – Entwicklungsstand](07-entwicklung.md#73-erster-ausschnitt-von-phase-2-kursentwürfe).

| Phase | Ergebnis / zentrale Tabellen | Tests und Ende der Phase |
|---|---|---|
| **1 Fundament, Datenbank, Benutzerverwaltung** | Monorepo-Grundstruktur, Web/API/Worker, PostgreSQL/Redis lokal, Migrationen; `users`, Rollen/Rechte, MFA, Sitzungen, Einmaltokens, Audit, begrenzter transaktionaler Mailpfad und dauerhafte Jobs. Keine Zahlungsfunktion. | Migration auf leerer DB und Wiederholung, Registrierung/Aktivierung, Login/Logout, Passwortreset, parallele E-Mail-Kollision, MFA-Setup/Wiederherstellung, Rollen- und Sessiontests, negatives Zugriffs- und Sicherheitsset. |
| **2 Öffentliche Website und Katalog** | Responsive öffentliche Seiten, CMS-Versionen, Navigation, Anbieterprofil, Medienverwaltung, Kurse/Versionen, Module/Kapitel, Produkte und Preise als Daten (Aktivierung und Preiszeiträume technisch umgesetzt; öffentliche Preisausgabe, CMS, Navigation und Medien fehlen). Rechtstexte bleiben Entwürfe, bis sie geprüft sind; die erste Ausbildung bleibt bis zu ihren vollständigen Prüfungen in Phase 6 Entwurf bzw. interne Vorschau. | Rendering/SEO, Mobil/Tastatur, keine unveröffentlichten Inhalte, Mehrkurs-/Versions- und Paketmodell, sichere Medien, Publikations- und Aktivierungschecks (Blocker, frische Bestätigung, DB-Trigger). Keine fingierten Bewertungen oder Preise. |
| **3 Shop und Zahlungen** | Warenkorb, Preisvorschau, Couponreservierung, Bestell- und Rechtssnapshots, Stripe-Testintegration, signierte Webhooks und persistente Verarbeitung. Im Sandbox-Checkout zunächst nur bereits angemeldete, verifizierte Testkonten; Gastprüfung folgt in Phase 4. Öffentlicher Verkauf bleibt aus; Zahlungsstatus ist von Fulfillment getrennt. | Test-Checkout, korrekt/falsch signierte Events, Duplikate, Betrag/Währung/Modus, asynchrone und fehlgeschlagene Zahlung, Race-Conditions und Gutscheinkapazität. Eine Rückleitung erzeugt keinen Zugang. |
| **4 Kaufkonto, E-Mail und Rechnungsauftrag** | Gast-E-Mail-Nachweis, Kontozuordnung nach bestätigter Zahlung, Aktivierung, Einschreibung und unabhängige Grants, E-Mail-Vorlagen/Outbox, Rechnungsnummern und sichere PDF-Erzeugung, Erstattungs-/Streitfallgrundlagen. | Neues/bestehendes/gesperrtes Konto, einmaliges Fulfillment bei Eventwiederholung, zwei Käufe desselben Kurses, Mailausfall/Retry, Rechnungssnapshots, keine Klartexttokens. |
| **5 Kundenportal und Lernplattform** | Eigene Ausbildungen, autorisierte Lerninhalte, Kapitel-/Modulnavigation, Medien, Speicherung und Darstellung des Fortschritts, Kontodaten und Rechnungsdownloads. | Fremdzugriffe verboten, gültige/abgelaufene Grants, erneuter Einstieg auf anderem Gerät, Fortschritt bei parallelen Änderungen, mobile Nutzung. |
| **6 Prüfung und Zertifikate** | Fragenpools, eingefrorene Versuche, serverseitige Auswertung, Abschlussregeln, Zertifikatvorlagen, PDF/öffentliche Verifikation und Widerruf. | 14/42/84-Strukturprüfung; genau 3 Fragen, 4 Antworten, eine richtige; 3/3 erforderlich; keine Lösungen/Teilpunkte vor Bestehen; alternative Fragen; kein Zertifikat ohne Abschluss; Widerruf/Neuausstellung. |
| **7 Vollständiges Backoffice** | CMS-/Rechtseditor, Kursbaum, Produkt-/Preisverwaltung, Kunden, Rollen, Bestellungen, Rückerstattungen, Gutscheine, Zertifikate, E-Mail-Vorlagen, Audit, Statistiken und Auftragsüberwachung. | Jede Oberfläche führt eine echte, autorisierte Aktion aus; Rollenmatrix einschließlich negativer Tests, MFA, Audit, Bearbeitung ohne Code, Versionierung und mobile Grundfunktionen. |
| **8 Newsletter und Automatisierungen** | Double-Opt-in, Abmeldung, Interessen/Segmente, Kampagnen, planbarer Versand, Bounce/Complaint, Ablaufhinweise und Jobüberwachung. Tracking standardmäßig aus. | Bestätigung/Abmeldung, Link-Scanner-GET, Kauf ohne Werbeeinwilligung, Widerruf zwischen Planung und Versand, Wiederholungen, unterdrückter Versand und ggf. gesondertes Tracking-Opt-in. |
| **9 Datenschutz, Sicherheit, Recht** | Vollständige Datenprozesse/Retention, Cookie-Einstellungen, Widerrufs-/Auskunfts- und Löschverfahren, Sicherheits- und Accessibility-Review, vertragliche und rechtliche Freigaben. | Auth-/CSRF/XSS/Upload-/Rechteprüfungen, Datenschutz- und Backup-Restore-Test, manuelle Accessibility-Prüfung, ZFU-/FernUSG-, Widerrufs-, Steuer- und Dienstleisterfreigaben. |
| **10 Gesamttests und Produktivsetzung** | Integrierte Abnahme, Monitoring, Runbooks, externe Providerkonfiguration, Release- und Rückfallplan. Nur mit dokumentierter Zustimmung Verkaufsfreigabe. | Voller Ablauf mit Stripe-Sandbox und Test-Mail, alle 84 Prüfungen im Test, Zertifikat; Restore/Provider-Abgleich, Security-Review, keine kritischen offenen Fehler, unterschriebene Go-live-Checkliste. |

## 5.3 Phase 1: umsetzbarer Startplan

### 5.3.1 Erster Migrationsumfang

1. Datenbankkonventionen aus [02-datenmodell.md](02-datenmodell.md#21-leseregeln-und-datenkonventionen), UUIDv7-Erzeugung, Zeitstempel und Migrationsrolle einrichten.
2. `users`, `billing_profiles`, `roles`, `permissions`, `role_permissions`, `user_roles`, `user_mfa_factors`, `mfa_recovery_codes`, `auth_sessions`, `account_tokens` und `audit_events` anlegen; genannte Uniques, Fremdschlüssel, Checks und Indizes tatsächlich migrieren.
3. Für Registrierung/Reset den minimalen transaktionalen Mailpfad `email_templates`, `email_template_versions`, `email_outbox`, `automation_jobs` und `automation_job_attempts` ergänzen. Im lokalen Test stellt ein Mailfänger Nachrichten zu; in Produktion ist eine geprüfte Mailkonfiguration erforderlich. Der übrige Mail-/Newsletterumfang folgt später.
4. Felder, die auf noch nicht eingeführte Module zeigen, werden **erst mit diesen Modulen** durch eine ergänzende Migration hinzugefügt: `email_outbox.order_id` und Anhänge in Phase 3, `email_outbox.subscriber_id` in Phase 8, `course_versions.certificate_template_version_id` in Phase 6 und `orders.checkout_email_verification_id` mit Gast-Checkout in Phase 4. Die Gastnamenfelder und ihre Constraints werden ebenfalls mit Phase 4 eingeführt. In Phase 3 sind Bestellungen deshalb auf angemeldete, verifizierte Testkonten beschränkt. Bei gegenseitigen Verweisen zwischen `newsletter_subscribers` und `consent_events` werden zuerst Tabellen mit nullable Verweis, danach die Fremdschlüssel und schließlich die Bezüge angelegt. In Phase 3 werden `orders` mit zunächst leerem erfolgreichem Zahlungsbezug, `payment_attempts`, `payment_events` und `payment_confirmation_evidence` angelegt, bevor der zusammengesetzte Rückverweis und seine Prüftrigger ergänzt werden. Keine Migration darf auf eine noch nicht vorhandene Tabelle verweisen.
5. Den systemseitigen Katalog der Rollen und Berechtigungsschlüssel sowie minimale, neutral formulierte transaktionale Mailvorlagen als Daten einrichten; keine Testkunden oder festen Passwörter. Der einmalige Bootstrap legt den ersten Superadmin mit der vom Betreiber konfigurierten Adresse sowie Vor- und Nachnamen an und stößt die sichere Aktivierung an. Der Bootstrap ist nur lokal/operativ autorisiert und nicht öffentlich erreichbar.
6. Bei jeder Schemaänderung sind Vorwärtsmigration, Rollback-/Wiederherstellungsstrategie, betroffene Indizes und Verträglichkeit mit bestehenden Daten zu dokumentieren. Native Datenbankregeln, die Prisma nicht modellieren kann, werden in geprüften Migrationen ergänzt.

### 5.3.2 Lokale Einrichtung nach Freigabe

1. Unterstützte Node.js-LTS- und Docker-Version bereitstellen; Abhängigkeiten anhand des dann vorhandenen Lockfiles installieren. Lokale PostgreSQL-, Redis- und Mailfänger-Dienste über eine Entwicklungs-Compose-Konfiguration starten.
2. Nicht geheime Beispielkonfiguration kopieren und lokale Werte setzen: HTTPS-Entwicklungs-URL mit lokal vertrauter Entwicklungs-CA, getrennte DB-/Redis-Zugänge, zufällige lokale Schlüssel für Token/CSRF/Datenverschlüsselung/Pseudonymisierung und lokalen Mailtransport. Für Phase 1 sind Stripe-, Video- und S3-Secrets nicht erforderlich, weil ihre Funktionen deaktiviert sind. Geheimwerte nicht committen. Produktionswerte dürfen nicht in die lokale Umgebung kopiert werden.
3. Migrationen mit einer Migrationsrolle ausführen; Anwendung mit einer eingeschränkten Laufzeitrolle starten. Rollen-/Rechtekatalog und Systemmailvorlagen initialisieren.
4. `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_FIRST_NAME` und `BOOTSTRAP_ADMIN_LAST_NAME` ausschließlich für den autorisierten Bootstrap setzen, Aktivierung über den lokalen Mailfänger durchführen und TOTP einrichten. Alle drei Angaben sind Pflicht; die Namen erfüllen die [verbindliche Namensregel](02-datenmodell.md#verbindliche-namensprüfung). Bei ungültiger Konfiguration bleibt der Bootstrap ohne Konto, Rollenzuweisung oder Aktivierungsmail. Es gibt keine mitgelieferte Kennung und kein Standardpasswort.
5. Web, API und Worker starten; Session-, Rollen-, MFA- und Mailflüsse über die [Phase-1-Endpunkte](03-ablaeufe-und-api.md#phase-1-vertrag-identität-und-berechtigungen) prüfen. Anschließend Unit-/Integrations-/End-to-End-Tests mit isolierter Testdatenbank ausführen.
6. Ergebnisse, notwendige Betriebsvariablen, Migrationen und Abweichungen dokumentieren. In Phase 1 ist kein produktiver Kauf und kein echter Newsletterversand verfügbar.

### 5.3.3 Definition of Done für jede Phase

- Anforderungen und Datenänderungen dokumentiert; Sicherheits- und Datenschutzrisiken bewertet.
- Migration auf leerem und vorhandenem Testdatenbestand erfolgreich, Constraints tatsächlich wirksam.
- Automatisierte Tests grün; fehlgeschlagene Abhängigkeiten und Wiederholungen realistisch geprüft.
- Rechte, mobile Bedienung und relevante Barrierefreiheit überprüft; keine nur optischen Buttons.
- Strukturierte, geheimnisfreie Logs und sinnvolle Fehler-/Alarmbehandlung vorhanden.
- Die Phase ist vor der nächsten fachlich vorgeführt und freigegeben; nicht fertige Funktionen werden nicht als produktionsbereit vermarktet.

## 5.4 Automatisierte Testmatrix

| Kennung | Szenario / erwartetes Ergebnis |
|---|---|
| `AUTH-01` | Neue Registrierung: Aktivierungsmail, Tokenhash statt Klartext, Passwort erst nach einmaligem Link setzen; abgelaufener Aktivierungslink kann neutral und gedrosselt neu angefordert werden. |
| `AUTH-02` | Zwei parallele Registrierungen und unterschiedlich groß geschriebene Identität: höchstens ein Konto, keine Kontoexistenz im Response. |
| `AUTH-03` | Falsches Passwort, gesperrtes/ungeprüftes Konto, Ratenlimit und Redis-Ausfall: kein unberechtigter Login. |
| `AUTH-04` | Reset gültig/abgelaufen/wiederholt, Passwortänderung und E-Mail-Wechsel: Tokens einmalig, alte Sitzungen widerrufen, alte Adresse informiert. |
| `AUTH-05` | Backoffice ohne MFA, falsches TOTP, TOTP-Replay und wiederverwendeter Recovery-Code: kein Admin-Zugriff. Bootstrap kann MFA sicher einrichten. |
| `AUTH-06` | Letzter Superadmin, Rollenänderung, frische Authentifizierung und Sessionfixation: Grenzen bleiben erhalten; Änderungen auditiert. |
| `AUTH-07` | Registrierung mit fehlendem, `null`, leerem, nur aus Zeichen der festgelegten Leermenge (gegebenenfalls mit U+200C/U+200D/U+2060) bestehendem, verbotene Steuerzeichen enthaltendem oder zu langem Vor- oder Nachnamen wird in Oberfläche und API abgewiesen; `422`, kein Konto, Aktivierungstoken oder Mail. Direkte DB-Schreibversuche verletzen die Check-Constraint. Grenzwerte 120/121 Unicode-Codepunkte, U+00A0, U+202F und U+200B prüfen; Umlaute, Apostrophe, Bindestriche, weitere Schriften und ZWNJ innerhalb eines Namens funktionieren. |
| `AUTH-08` | Eigenes und administratives Profil: `null`, leerer oder ungültiger Name ergibt `422` ohne Teiländerung; weggelassene Felder bleiben unverändert, gültige Korrekturen werden gespeichert. Nach Registrierung benötigt der Teilnehmer-Login E-Mail und Passwort, Backoffice-Rollen zusätzlich MFA. |
| `AUTH-09` | Bootstrap mit fehlender E-Mail oder fehlendem/ungültigem Vor- oder Nachnamen bricht ohne Konto, Rollenzuweisung, Token und Mail ab; gültiger Bootstrap erzeugt genau ein Konto, wiederholte Initialisierung kein Duplikat. |
| `CAT-01` | Mehrere Kurse, Varianten und Pakete; alte Erwerbsversion bleibt nach Veröffentlichung einer neuen Version unverändert. |
| `CAT-02` | Kopie erzeugt neue IDs für Inhalte/Prüfungen, referenziert zulässige Medien, kopiert weder Preise noch Zugänge. |
| `SHOP-01` | Preisänderung, ungültiger Coupon, abgelaufener Preis, unbekanntes Land und manipulierte Clientbeträge: keine stille Übernahme. Gast-E-Mail-Nachweis kann am Zweitgerät bestätigt werden, ohne Warenkorb oder Konto offenzulegen. |
| `SHOP-02` | Parallele Reservierungen beim letzten Couponplatz; fehlgeschlagene und lang laufende SEPA-Zahlungen sowie verspäteter Erfolg: Limit und Kundenpreis korrekt behandeln. |
| `SHOP-03` | Rückleitungsseite, offener/abgebrochener/fehlgeschlagener Checkout und Null-Euro-Checkout: kein fiktiver bezahlter Zugang. |
| `SHOP-04` | Gastkauf mit fehlendem, `null`, leerem oder ungültigem Vor- oder Nachnamen der teilnehmenden Person wird mit `422` vor Bestellung und Zahlungssitzung abgewiesen. Nach gültiger Bestellung und verifiziertem Zahlungswebhook werden die getrennt gespeicherten Teilnehmernamen – nicht abweichende Rechnungsnamen – für ein neues Konto übernommen. |
| `SHOP-05` | Gastkauf für bereits bekanntes Konto und gleichzeitige Registrierung derselben E-Mail: höchstens ein Konto, keine Kontoexistenz im Response, kein Überschreiben des Profilnamens; Rechnung mit abweichender Ansprechperson bleibt korrekt und das spätere Zertifikat nutzt den Kontonamen. |
| `PAY-01` | Korrekter Stripe-Sandbox-Webhook gegenüber gefälschter Signatur, falscher Währung/Betrag, falschem Konto und Test-/Live-Vermischung. |
| `PAY-02` | Gleicher Event mehrfach, zwei Eventtypen für dieselbe Zahlung, parallele Worker, ungewöhnliche Reihenfolge: genau ein fachliches Fulfillment. |
| `PAY-03` | Provideraufruf erfolgreich, Antwort verloren; Worker-/DB-Absturz; zweiter erfolgreicher Zahlungslauf: Abgleich, keine zweite Freischaltung, Alarm für Überzahlung. |
| `PAY-04` | Teil-/Vollerstattung und Rückbuchung vor bzw. nach Freischaltung: Beleg, Status und explizite Entscheidung korrekt; ein zukünftig beginnender Grant wird vorläufig suspendiert und andere Grants bleiben gültig. |
| `PAY-05` | Ein Provider-API-Erfolg ohne zugehörigen signaturgeprüften Erfolgswebhook sowie ein Zwischenstands- oder Fehlerwebhook erzeugen weder `paid` noch Kauf-Grant. Erneut signiert zugestellter Erfolg bzw. erneut verarbeiteter zuvor geprüfter Erfolg führt nach allen Zuordnungsprüfungen idempotent zur Bestätigung; ohne Ereignis bleibt der Fall alarmiert. |
| `MAIL-01` | Mailanbieter vorübergehend ausgefallen und anschließend wieder erreichbar: dauerhafter Auftrag, Retry, keine Klartextpasswörter oder Token in Logs. |
| `LEARN-01` | Nur eigene, passende Kursversion und wirksamer Grant ermöglichen Inhalt/Download; gesperrter, abgelaufener und fremder Zugriff scheitern. |
| `LEARN-02` | Fortschritt automatisch, geräteübergreifend und bei konkurrierenden Aktualisierungen korrekt; Quote nicht vom Client manipulierbar. |
| `EXAM-01` | Veröffentlichungscheck der ersten Ausbildung: 14 Module, 42 Kapitel, zwei für den Abschluss verpflichtende Prüfungen je Kapitel, drei Fragen, vier Optionen, genau eine richtige; automatische Zertifizierung mit gültiger Vorlage. |
| `EXAM-02` | 0, 1 oder 2 richtige: ausschließlich Nicht-bestanden, keine Teilpunktzahl, keine Antwort/Erklärung in API, HTML, Netzwerk und clientseitigen Daten. |
| `EXAM-03` | 3 richtige: bestanden; nur Fragen dieses bestandenen Versuchs mit Lösungen und ausführlichen Erklärungen abrufbar. Wiederholung bevorzugt alternative Fragen; die fachliche Qualität der Erklärungen wird redaktionell geprüft. |
| `EXAM-04` | Unvollständige Abgabe, doppelte Abgabe, fremde Frage/Option und parallele Starts: keine Bewertung bzw. nur ein Versuch/Ergebnis. |
| `CERT-01` | Bei 83 von 84 bestandenen Prüfungen kein Zertifikat; nach der letzten bestandenen Prüfung ohne zusätzlichen Abschlussklick automatisch genau ein gültiges Zertifikat. Frühere Fehlversuche verhindern den Abschluss nicht. |
| `CERT-02` | Die PDF-Vorlage enthält den Vor- und Nachnamen aus dem Kundenprofil, Kurstitel, Abschlussdatum und Zertifikatsnummer; das erzeugte PDF ist nur im eigenen Konto abrufbar, auch nach regulärem Zugangsablauf. Benachrichtigung erst nach PDF-Erstellung. |
| `CERT-03` | Ein gültiges Kundenkonto ohne Vor- oder Nachnamen kann nicht angelegt oder gespeichert werden; Altbestände ohne Namen werden vor einer Übernahme abgewiesen. PDF-Fehler und Worker-Retry erzeugen keine doppelte gültige Urkunde. |
| `CERT-04` | Widerruf und Neuausstellung: keine doppelt gültige Urkunde; Verifikation zeigt korrekten Status und keine unnötigen Personendaten. |
| `NEWS-01` | Anmeldung, Ablauf und einmalige Bestätigung; unverifizierte Adresse erhält keine Kampagne, Kauf erzeugt keine Einwilligung. |
| `NEWS-02` | Abmeldung per POST und One-Click; `GET` eines Link-Scanners ändert nichts; Widerruf nach Planung stoppt wartenden Versand. Parallele Providerübergaben und deren unvermeidbares Zeitfenster werden gesondert geprüft und dokumentiert. |
| `NEWS-03` | Bounce/Complaint sperren Versand; Tracking bleibt ohne separate Einwilligung aus; Segmentfilter umgehen Einwilligung nicht. |
| `ADMIN-01` | Für jede Rolle jeden relevanten API-Vorgang positiv und negativ testen; Kursmanager/Dozent ausschließlich zugewiesene Kurse. |
| `ADMIN-02` | Manuelle Freischaltung, Entzug, Rollen-, Preis-, Rechts- und Erstattungsänderung benötigen Recht, speichern Grund und Audit; relevante Anbieteränderungen sperren neue Verkäufe, ohne eingegangene Zahlungen zu ignorieren. |
| `SEC-01` | CSRF, XSS, SQL-Injection, unsichere URLs/Uploads, IDOR, Cache-Leaks und ungewollte Logs von Geheimnissen abwehren. |
| `PRIV-01` | Auskunft/Löschung, Aufbewahrungssperren, Abmeldung und Wiederherstellung aus Backup stellen keine gelöschten bzw. widerrufenen Zustände ungeprüft wieder her. |
| `PRIV-02` | Autorisierte Löschung setzt beide Profilnamen und Status atomar auf `NULL` bzw. `deleted`, widerruft Sitzungen und verhindert Login; nicht gelöschte Konten ohne Namen verletzen weiterhin die DB-Constraint. Gastnamen und Rechnungs-/Zertifikatssnapshots werden getrennt nach Erforderlichkeits- und Aufbewahrungsprüfung behandelt. Ein parallel laufender Zertifikatsjob pausiert bei Löschbegehren bzw. wird nach Anonymisierung beendet und stellt keine neuen Daten oder Benachrichtigungen bereit. Ein späterer Zahlungswebhook reaktiviert kein zuvor zugeordnetes gelöschtes Konto und erzeugt dafür keinen Kauf-Grant; der bezahlte Vorgang bleibt zur Klärung blockiert. |
| `LEGAL-01` | Öffentliche Widerrufsanfrage erzeugt eine nachvollziehbare Bestätigung und einen geschützten Vorgang; sie offenbart keine fremde Bestellung und löst keine unautorisierte Erstattung aus. |
| `OPS-01` | Redis-Verlust/Workerabsturz, fehlgeschlagener Mailversand, DB-/Objekt-Restore und Provider-Abgleich erzeugen sichtbare Alarme und rekonstruierbare Aufträge. |
| `A11Y-01` | Tastatur, Screenreader, Kontrast, Zoom, kleine Viewports und barrierefreie Prüfungsformulare auf Website, Checkout, Portal und Admin-Grundfunktionen. |

## 5.5 Durchgehender Abnahmetest

In einer isolierten Testumgebung wird ein synthetischer erster Kurs mit 14 Modulen, 42 Kapiteln, 84 Prüfungen und mindestens 252 synthetischen Fragen angelegt. Diese Daten sind **Test-Fixtures**, keine echten Lehrinhalte und keine Produktivkunden.

1. Ein neuer Gast findet eine freigegebene Ausbildung, legt das Produkt in den Warenkorb und durchläuft die Gast-E-Mail-Verifizierung.
2. Teilnehmer-Vor- und Nachname, getrennte Rechnungsdaten und freigegebene Bedingungen werden erfasst; ein Stripe-Testmodus-Checkout wird tatsächlich im Sandbox-Anbieter durchgeführt. Vor bestätigtem Webhook besteht kein Zugang.
3. Ein verifizierter erfolgreicher Webhook wird verarbeitet und nochmals zugestellt. Es entstehen ein zugeordnetes Konto mit den Teilnehmernamen, eine Einschreibung, genau eine entsprechende Zugangsquelle und eine Rechnung; Aktivierungsmail wird über den Test-Mailfänger geprüft. Das Verhalten für bestehende Konten wird zusätzlich gemäß `SHOP-05` getestet.
4. Teilnehmer aktiviert sein Konto, meldet sich an und durchläuft alle Kapitel und beide Prüfungen je Kapitel. Mindestens ein Fehlversuch beweist die Nichtoffenlegung; danach wird bestanden. Bestandene Kapitelprüfungen setzen den Kapitelabschluss automatisch; der gespeicherte Lernstand wird auf einem zweiten Client fortgesetzt.
5. Nach der 84. bestandenen Prüfung entstehen ohne weiteren Abschlussklick genau ein Abschluss und ein gültiges Zertifikat. Das automatisch erstellte PDF enthält den Vor- und Nachnamen aus dem Kundenkonto, wird im eigenen Konto bereitgestellt und ist auch nach regulärem Kurszugangsablauf verfügbar. Download und öffentliche Gültigkeitsprüfung funktionieren; fremder Kontozugriff ist unmöglich.
6. Ein berechtigter Admin sieht echte Bestellung, Lernstand, Prüfungsergebnisse und Beleg; eine Rückerstattung und getrennte Zugangsentscheidung werden im Provider-Testmodus nachvollzogen. Newsletter bleibt ohne unabhängiges Double-Opt-in abgemeldet.

Dieser vollständige Lauf eignet sich mindestens für einen nächtlichen bzw. Release-Test. Kürzere repräsentative UI-Smoke-Tests und vollständige API-/Integrationstests halten die laufende Entwicklung schnell; sie ersetzen die vollständige Abnahme nicht.

## 5.6 Go-live-Sperren

Die **Kaufstrecke ist technisch umgesetzt** (öffentlicher Katalog, Warenkorb, Bestellung mit Snapshots, Rechnung, Zahlungseingangsbestätigung, Lernzugang, optionale Stripe-Testzahlung). Das ersetzt keine Freigabe: Veröffentlichung, Aktivierung und Verkaufsfreischaltung bestätigen nur technische Voraussetzungen und eine frische Identitätsbestätigung. Der Verkauf bleibt standardmäßig aus (`commerce_settings.sales_enabled = false`), bis der Betreiber ihn in einer isolierten Testumgebung ausdrücklich freischaltet.

Die Verkaufsfreigabe bleibt aus, solange einer der folgenden Punkte offen ist:

- ausdrückliche Produkt- und Betriebsfreigabe durch den Betreiber; alle Phasen abgenommen und keine kritischen Sicherheits-/Zahlungs-/Datenschutzmängel offen;
- vollständige, rechtlich geprüfte Anbieter-, Vertrags-, Widerrufs- und Datenschutzangaben, korrekte Bestellbestätigung und geprüfte Zahlungs-/Steuerkonfiguration;
- dokumentierte Klärung und ggf. erforderliche Zulassung nach FernUSG/ZFU für jede betroffene Ausbildung; keine unbewiesenen Zertifikats- oder Anerkennungsbehauptungen;
- tatsächlich freigegebene Kursinhalte, Preise, Urheber-/Nutzungsrechte, Medien, Prüfungsfragen und Abschlussregeln (eine technische Veröffentlichung erteilt diese Freigabe nicht);
- bestätigte Live-Providerkonten, Signaturschlüssel, TLS, Mailzustellbarkeit und saubere Test-/Live-Trennung;
- funktionierende Überwachung, Ansprechpartner, getestete Backups samt Wiederherstellung, Incident- und Supportprozesse;
- Datenschutz- und Barrierefreiheitsprüfung einschließlich Dienstleisterverträgen und Datenflüssen abgeschlossen;
- dokumentierter End-to-End-Test vom ersten Besuch bis zum Zertifikat und eine geprüfte Rollbackstrategie.
