# Online-Akademie – Konzept und Entwicklungsstand

**Stand: 15.11.2026 · Phase 4 (Kaufkonto, Rechnung, Steuern, Aufbewahrung) in Entwicklung · nicht produktionsreif**

Verantwortlich: Soufian Charrak

Das Repository enthält das [technische Zielkonzept](docs/01-architektur.md), die Umsetzung der Benutzerverwaltung, eine geschützte Verwaltung für Kursentwürfe und eine vollständige **Kaufstrecke**: öffentlicher Produktkatalog, Warenkorb, Bestellung mit Positions- und Preis-Snapshot, Rechnung, Zahlungseingangsbestätigung durch die Verwaltung und Freischaltung des Lernzugangs. Eine Freigabe von Kursen und eine Aktivierung von Produkten/Preisen ist möglich – nur mit eigener Berechtigung, erfüllten Voraussetzungen und frischer Bestätigung; der öffentliche Katalog zeigt ausschließlich den freigegebenen Kurstext. Prüfungen, Zertifikate, Medien und ein Auswertungs-Dashboard sind weiterhin **nicht** implementiert.

## Bereits umgesetzt

- Node-24-/TypeScript-Monorepo mit Next.js-Weboberfläche, NestJS-API, PostgreSQL 16, Prisma-Adapter, Redis/BullMQ und Mail-Worker.
- Versionierte SQL-Migration für Konten, Rollen/Rechte, MFA, Sitzungen, Einmaltokens, Audit, Mailvorlagen und dauerhafte Aufträge.
- Registrierung **nur mit Vor- und Nachname und E-Mail**; dieselbe Unicode-Namensregel wird in Formular, API und Datenbank geprüft. Aktivierung per einmaligem E-Mail-Link, selbst gewähltes Passwort, Login/Logout, Profil, Passwortreset und bestätigter E-Mail-Wechsel.
- Für Backoffice-Rollen TOTP mit Wiederherstellungscodes, kurzlebige Voranmeldung, rollenbasierte Berechtigungen und nachvollziehbare Rollenänderung. Der erste Superadmin wird ausschließlich über einen ausdrücklich autorisierten lokalen Bootstrap angelegt – ohne voreingestelltes Passwort.
- Verschlüsselte Token in der Mail-Outbox, HMACs für Sitzung und Einmaltokens, CSRF-/Origin-Prüfung und Redis-Ratenlimits. PostgreSQL ist die dauerhafte Quelle für Mailaufträge; BullMQ dient als Transport und ein Abgleich stellt verlorene Queue-Einträge wieder her.
- Öffentliche Katalogansicht unter `/kurse` sowie MFA-geschützte Kursverwaltung unter `/admin/kurse`: globale Administratoren legen Entwürfe an; zugewiesene Kursmanager und Dozenten bearbeiten deren Angaben, Module und Kapitel. Die Anmeldung und die Einzelrechte werden serverseitig geprüft. Mitarbeiterzuordnungen erfordern frische Bestätigung; Rollenentzug entfernt die zugehörigen Kurszuordnungen.
- Kapitel können geschützte **Entwurfsbausteine** für Textabsätze, Überschriften, Aufzählungen und Links enthalten. Die Vorschau zeigt Text ohne HTML-Ausführung; Links werden dort nicht geöffnet. Medien und ein Teilnehmer-Lernzugang fehlen weiterhin.
- Revisionsprüfung gegen überschreibende parallele Bearbeitung, eindeutige Positionen, nachvollziehbare Änderungsereignisse ohne Lehrtexte und Datenbank-Fremdschlüssel. Kapitel mit Inhalten und Module mit Kapiteln können nicht versehentlich gelöscht werden. Der Kurs selbst kann in diesem Teilumfang noch nicht gelöscht oder veröffentlicht werden. Die Vorlage für die erste Fitnesstrainer-B-Lizenz übernimmt nur Titel und geplante Anzahlen 14 / 42 / 2 – keine erfundenen Inhalte oder Prüfungen.
- **Kaufstrecke:** öffentlicher Katalog unter `/buchen` (nur bei freigeschaltetem Verkauf), Warenkorb (24 Stunden gültig, ein Gutschein je Bestellung), Bestellung als unveränderlicher Snapshot aus Produkten, Preisen, Adresse und Rechtsfassungen, Rechnung mit fortlaufender Nummer, Zahlungsziel und Verwendungszweck, Zahlungseingangsbestätigung durch die Verwaltung sowie Freischaltung des Kurszugangs. Stornieren gibt Gutschein und Sitzplatz frei.
- **Optional Kartenzahlung über Stripe im Testmodus:** ohne hinterlegte Testschlüssel bleibt die Zahlungsart deaktiviert (`STRIPE_UNAVAILABLE`). Ein Erfolgswebhook wird nur mit gültiger Signatur, idempotent und erst nach Prüfung von Betrag und Währung akzeptiert; der Zugang wird nie allein auf ein Browser-Redirect hin freigeschaltet. **Geld verschwindet nicht:** eine Zahlung, die zu keiner offenen Bestellung passt (zweite Zahlung, Zahlung nach Storno, abweichender Betrag), wird als `payment.unmatched` auditiert und die Bestellung — außer sie ist bereits bezahlt/erstattet/zurückgebucht — auf „Prüfung nötig“ gesetzt; erstattet wird nie automatisch. Eine abgeschlossene Checkout-Sitzung erzeugt keine zweite Sitzung (`409 PAYMENT_IN_PROGRESS`), damit niemand doppelt zahlt.
- **Lernbereich als Folge des Kaufs:** `/konto/kurse` und `/lernen/<kurs>` zeigen die freigeschalteten, veröffentlichten Kapitel als reinen Text (kein HTML, Links mit `rel="noopener noreferrer nofollow"`) und speichern den Kapitelabschluss idempotent. Der Zugang wird bei jeder Anfrage erneut geprüft.
- **Verwaltung** unter `/admin/bestellungen` (Zahlung bestätigen, stornieren, Beleg prüfen) und `/admin/commerce` (Verkauf freischalten, Rechnungssteller, Bankverbindung, Zahlungsziel, Rechtstexte anlegen und aktivieren). Alle schreibenden Aktionen verlangen eine frische Bestätigung.
- **Erstattungen und Korrekturbelege:** Teil- und Vollerstattung durch die Verwaltung (Vorschlag mit `refunds.propose`, Ausführung mit `refunds.manage` und frischer Bestätigung), Deckelung durch Anbieterzahlbetrag und Datenbank-Trigger, positionsgenaue Zuordnung ohne erfundene Steuersätze, Gutschrift-PDF je Erstattung im eigenen Nummernkreis (`TB-GS-JJJJ-NNNNNN`), Download im Konto unter `/konto/rechnungen` und per Support. Die Frage „behält die Person den Kurs?“ ist eine eigene, dokumentierte Entscheidung (`kept`/`suspended`/`revoked`); ein noch nicht begonnener Zugang wird gesperrt statt gelöscht, und der Zahlnachweis verschwindet nie.
- **Keine Sackgassen:** Ein Widerruf ohne auffindbare Bestellung lässt sich mit einem passenden Grund ablehnen (Annehmen verlangt die Bestellung); ein laufender Streitfall verhindert die Freischaltung, parkt die bezahlte Bestellung sichtbar als „gesperrt“ und gibt sie nach einem gewonnenen Fall wieder frei — während der Fall läuft, ist der Zugang nur vorläufig zu entscheiden.
- **Rückbuchungen (Streitfälle):** `/admin/streitfaelle` (Liste mit Herkunft und letztem Anbieterabgleich) und das Bestellbild erfassen Anbieterfälle (`warning`/`open`/`won`/`lost`/`closed`). Fälle kommen auch **ohne Zutun** über den signaturgeprüften Provider-Webhook (`charge.dispute.*`) und laufen durch dieselben Regeln wie eine manuelle Erfassung; `sync_source` hält fest, ob eine Anbietermeldung oder ein Mensch den Stand gesetzt hat. Ein verlorener Fall setzt die Bestellung auf `charged_back`, mindert den erstattbaren Betrag und ist nicht stornierbar; derselbe Anbieterfall aktualisiert sich statt sich zu duplizieren. Es entsteht keine Gutschrift, und der Zugang wird nie automatisch entzogen — die Entscheidung bleibt ein eigener, dokumentierter Schritt.
- **Umsatzsteuer als Daten:** `tax_rates` hält Sätze mit Gültigkeitszeitraum (19 % `standard` als Regelsteuersatz für Online-Training/digitale Kurse in Deutschland und Vorgabe, 7 % `reduced` vorhanden, nicht vorgewählt). Jede Position speichert Netto, Steuer und Satz beim Kauf — `gross = net + tax` und die Ratenkonsistenz sind Datenbank-Constraints —, und Rechnung wie Gutschrift weisen die Steuer **je Satz** aus. Ein Satz wird nie überschrieben, sondern als neuer Zeitraum angelegt; ohne gültigen Satz bricht der Verkauf mit `TAX_RATE_MISSING` ab. Sonderfälle und Befreiungen bleiben offen und sind als Datenzeile zu pflegen.
- **Aufbewahrung:** `npm run retention:run` (mit `-- --dry-run` zum Prüfen) entfernt abgelaufene Einmaltokens, alte bzw. widerrufene Sitzungen, endgültig fehlgeschlagene Mail-Outbox-Zeilen und — nach Frist — die Klartextadresse abgeschlossener Widerrufsfälle. Rechnungen, Gutschriften, Zahlungen, Streitfälle und Audit-Ereignisse werden nicht angetastet. Der Lauf protokolliert sich als `retention.run`.
- **Öffentlicher Widerruf:** `/widerruf` ohne Anmeldung, gedrosselt, mit immer gleicher Antwort (keine Auskunft über fremde Bestellungen) und Eingangsbestätigung mit Datum und Uhrzeit als Fristbeleg. Die Adresse wird über einen Einmal-Link bestätigt; erst danach ordnet Personal eine passende Bestellung zu (`/admin/widerrufe`). Ein angenommener Widerruf erstattet nichts — die Erstattung bleibt ein separater Vorgang.
- Automatisierte Unit- und Datenbank-/API-Integrationstests sowie lokale Browser-Smoke-Tests für Identität, Kursentwürfe, Produkt-/Preisentwürfe, die Kaufstrecke, Steueraufteilung (`TAX-01`), Aufbewahrung (`RET-01`) und Streitfälle aus Anbietermeldungen (`PAY-04f`).

**Keine Freigabe für echte Kundendaten oder den Produktivbetrieb:** Betriebs- und Sicherheitsabnahme, vollständige Datenschutzprozesse, Schlüsselrotation, Löschprozesse für personenbezogene Daten, restriktive Datenbankrollen, Überwachung, Backup-Restore, CSP und rechtliche Prüfung stehen noch aus. Der Browser-Smoke-Test ersetzt keine vollständige Accessibility- oder Sicherheitsprüfung. SMTP-Status `accepted` bedeutet Anbieterannahme, nicht garantierte Zustellung; bei einem Absturz nach Annahme kann eine Mail erneut gesendet werden. Es gibt keine Zusicherung eines Exactly-once-Mailversands.

## Lokal starten

Voraussetzungen: **Node.js 24** (gepinnt in `.nvmrc`: `nvm use`; `engines` bricht auf einem anderen Major ab), npm, Docker mit Compose und freie lokale Ports 3000, 4000, 5432, 6379, 1025 und 8025. Die Compose-Datei ist nur für synthetische Entwicklungsdaten gedacht; ihre Zugangsdaten und Images sind kein Produktionssetup. Die Datenbank-Initialisierung legt die Entwicklungs- und Testdatenbank nur beim ersten Erstellen des Docker-Volumes an.

```bash
npm ci
npm run setup:env       # erstellt .env und ergänzt fehlende unabhängige Zufallsschlüssel

docker compose up -d
npm run build:contracts
npm run db:generate
npm run db:migrate
npm run db:seed
```

Danach in drei Terminals:

```bash
npm run dev:api
npm run dev:worker
npm run dev:web
```

Weboberfläche: <http://localhost:3000> · lokales Mailpit-Testpostfach: <http://localhost:8025>. Die Web-App ruft die API über `/api/v1` auf; nur der Next.js-Server verbindet sich intern mit der API. `PUBLIC_BASE_URL` muss exakt zur Browser-Origin passen. Die HTTP-Ausnahme und Secure-Cookies sind nur für `localhost`/`127.0.0.1` im lokalen Entwicklungsmodus vorgesehen; für andere Domains ist HTTPS erforderlich. Web und API binden für Entwicklungs- und Vorschauzwecke an `0.0.0.0`: Netzwerkzugriff lokal einschränken. Mailpit enthält Aktivierungslinks und darf niemals öffentlich oder für echte Daten betrieben werden.

Die `.env` ist ignoriert und darf nicht eingecheckt werden. `npm run setup:env` ersetzt **keine** vorhandenen Schlüssel; gehen Schlüssel verloren oder werden sie unkoordiniert geändert, lassen sich bestehende Geheimdaten nicht mehr entschlüsseln. Die API lädt die mitgelieferte [Django-Sperrliste](packages/database/data/common-passwords.md) offline und ergänzt die lokalen Sperreinträge. `COMMON_PASSWORDS_FILE` kann auf eine eigene UTF-8-Datei (eine Zeile je Passwort, optional `.gz`) zeigen; relative Pfade beziehen sich auf das Repository. In Produktion sind weiterhin mindestens 10.000 unterschiedliche normalisierte Einträge in der Basisliste erforderlich. Beim Deployment beide Listendateien mit ausliefern.

### Optionale geschützte Entwicklungsvorschau

Für eine eingebettete **HTTPS-Entwicklungsvorschau** müssen Umgebung und Testdatenbank isoliert sowie der Zugriff auf die Vorschau separat abgesichert sein. `APP_ENV=development` und `PUBLIC_BASE_URL` müssen in der API auf die genaue HTTPS-Browser-Origin eingestellt sein. Nur dann kann die API mit `TRAINERB_EMBEDDED_PREVIEW_COOKIES=true npm run dev:api` gestartet werden. Die Cookies sind in diesem Modus `Secure`, `SameSite=None` und `Partitioned`; die Origin- und CSRF-Prüfung bleiben aktiv. Der Browser muss partitionierte Cookies unterstützen. Ohne diese explizite Option gilt `SameSite=Lax`; in Produktion oder bei HTTP wird die Option abgelehnt.

Optional zeigt `TRAINERB_TEST_INBOX=true npm run dev:web` in der Entwicklungsansicht `/test-postfach` an. Der Webserver liest dafür das Testpostfach ausschließlich über `127.0.0.1:8025`; Mailpit selbst darf nicht öffentlich erreichbar sein. **Die Seite hat keinen eigenen Zugangsschutz**: Jede Person mit Zugriff auf die Vorschau kann alle abgefangenen Nachrichten und Aktivierungs-/Resetlinks lesen. Deshalb nur hinter bereits abgesichertem Zugriff und ausschließlich mit erfundenen Daten und Testpasswörtern verwenden. Standardmäßig und im Produktionsmodus ist die Seite nicht verfügbar. Die Optionen sind keine Produktionskonfiguration; Vorschau und Testdaten sind temporär.

### Ersten Superadmin lokal einrichten

Nach Migration und Seed die drei Variablen mit **eigenen synthetischen Testdaten** setzen und den Bootstrap einmalig lokal ausführen:

```bash
BOOTSTRAP_ADMIN_EMAIL=admin@example.invalid \
BOOTSTRAP_ADMIN_FIRST_NAME=Test \
BOOTSTRAP_ADMIN_LAST_NAME=Admin \
npm run bootstrap
```

Alle drei Angaben sind Pflicht. Die Aktivierungsmail erscheint im lokalen Mailpit; nach Passwortvergabe folgt beim ersten Login die TOTP-Einrichtung. Wiederholung mit denselben Angaben erzeugt kein Duplikat, ein zweiter unbeaufsichtigter Bootstrap wird abgelehnt. Das obige Beispiel legt keine mitgelieferten Zugangsdaten oder ein Standardpasswort fest. Nach Anmeldung und MFA führt **Mein Konto → Kursverwaltung** zu den Entwürfen; weitere Mitarbeiter erhalten zuerst ihre Rolle in der Nutzerverwaltung und danach eine Kurszuordnung. **Mein Konto → Produkte** (nur Admin/Superadmin mit `products.manage`) führt zu Produkt- und Preisentwürfen. Ein Produkt ist erst nach der Aktivierung und mit aktivem Preis buchbar.

## Kaufstrecke in Betrieb nehmen

Der Verkauf ist absichtlich **standardmäßig aus**: Ohne aktive Rechtsfassungen und ohne freigeschalteten Verkauf sind Katalog und Checkout gesperrt, statt halbfertig zu verkaufen.

1. Mindestens einen Kurs veröffentlichen (Admin mit `courses.publish`, frische Bestätigung) und ein Produkt anlegen, das diesen Kurs enthält.
2. Preis anlegen und aktivieren, danach Produkt aktivieren (Admin mit `products.manage`/`prices.manage`). Ein Produkt ohne aktiven, zeitlich gültigen Preis bleibt unsichtbar.
3. Unter **Mein Konto → Zahlung & Recht** (`settings.manage`, `legal.manage`) Rechnungssteller, Bankverbindung und Zahlungsziel pflegen und je Art eine Fassung von AGB, Widerrufsbelehrung und Datenschutzhinweis **anlegen und aktivieren**. Bestellungen sind erst möglich, wenn alle drei aktiv sind, und werden an genau diese Fassungen gebunden.
4. Verkauf freischalten (`sales_enabled`). Erst danach erscheinen Produkte unter `/buchen`.
5. Eingehende Überweisungen unter `/admin/bestellungen` prüfen und die Zahlung mit Referenz bestätigen — erst dann entsteht der Lernzugang und die Rechnung gilt als bezahlt. Stornierungen verlangen einen Grund; aktiver Zugang muss vorher entzogen werden.

Stripe ist optional. Ohne `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` und `STRIPE_PRICE_*`-Zuordnung bleibt die Kartenzahlung deaktiviert und der Webhook antwortet mit `409 STRIPE_UNAVAILABLE`; die Rechnungsstrecke funktioniert unabhängig davon. Nur Testschlüssel verwenden — es werden keine Kartendaten gespeichert oder protokolliert. Der Webhook-Endpunkt ist `POST /api/v1/payments/stripe/webhook`; er braucht den unveränderten Rohkörper zur Signaturprüfung.

## Tests und Build

```bash
npm test                 # Unit-Tests; baut zuerst Contracts und API
npm run test:integration # löscht Anwendungsdaten in der dedizierten *_test-Datenbank!
npm run typecheck
npm run build
npm run retention:run -- --dry-run   # zeigt, was der Aufbewahrungslauf entfernen würde
```

### Continuous Integration

`.github/workflows/ci.yml` startet für Pushes und Pull Requests gegen `main` PostgreSQL 16 und Redis als Dienste, legt die `trainerb_test`-Datenbank an, erzeugt eine lokale `.env` mit fünf unabhängigen Zufallsschlüsseln (wie `npm run setup:env`) und führt `npm run typecheck`, `npm test`, `npm run test:integration` und `npm run build` aus. Die Browser-Smoke-Tests sind **nicht** Teil der CI, weil sie Playwright/Chromium und eine laufende Web-/API-/Mailpit-Umgebung brauchen; der Workflow weist per Notice darauf hin.

Die frühere `deno.yml` war GitHubs Deno-Standardvorlage und konnte für dieses Projekt nie grün werden: Sie prüfte Node-/TypeScript-Quellen, CommonJS-Integrationstests (`Buffer`, `process`) und den generierten Prisma-Client mit `deno lint`/`deno test` und meldete entsprechend mehrere hundert Befunde. Sie wurde entfernt; Deno ist hier keine Laufzeit.

Die Integrationstests verlangen `TEST_DATABASE_URL` und `TEST_REDIS_URL` aus `.env`. Sie prüfen, dass der Datenbankname auf `_test` endet und der Redis-Testindex 1–15 ist; dort werden Anwendungsdaten einschließlich Kursen bzw. Rate-Limit-Schlüssel entfernt. **Nur isolierte Testdienste verwenden.** Sie wenden die Migrationen zweimal an und prüfen u. a. Identität, MFA, Rollen, Kurszuordnungen, konkurrierende Änderungen, Fremdzugriffe, Veröffentlichungs- und Aktivierungsregeln samt DB-Triggern sowie die Kaufstrecke: Verkaufssperre, Rechtstexte, Bestellung und Idempotenz, Zahlungsbestätigung mit frischer Bestätigung, Lernzugang und Fortschritt, Gutscheine, Stornierung, Stripe-Sperre ohne Schlüssel und manuelle Zugangsvergabe. Veröffentlichte Kurse erscheinen im öffentlichen Katalog nur als Kurstext; Modul- und Kapitelstruktur sowie Lehrinhalte bleiben geschützt.

Für den zusätzlichen Browser-Smoke-Test Web, API, Worker und Mailpit mit einer **isolierten Wegwerf-Entwicklungsdatenbank** starten, bei Bedarf einmalig `npx playwright install chromium` ausführen und dann:

```bash
E2E_ALLOW_TEST_DATA=yes E2E_BASE_URL=http://localhost:3000 \
E2E_MAILPIT_URL=http://localhost:8025 npm run test:e2e
```

Der Smoke-Test legt ein synthetisches Konto an und entfernt es nicht automatisch. Er akzeptiert nur lokale Adressen; Web-Origin und `PUBLIC_BASE_URL` müssen übereinstimmen. Die Beispiele nutzen keine echten E-Mails, Anbieter oder Zahlungen.

Der zusätzliche Iframe-Smoke-Test prüft Registrierung, Testpostfach, Aktivierung, Anmeldung und Abmeldung in Chromium. Voraussetzung sind OpenSSL, eine isolierte Wegwerfdatenbank, ein laufender Mail-Worker, die beiden oben genannten Preview-Optionen und dieselbe HTTPS-Origin in `PUBLIC_BASE_URL` und `E2E_PREVIEW_ORIGIN`. Ein lokales TLS-Gateway simuliert die HTTPS-Origin, ohne deren echten Host aufzurufen. Auch dieser Test legt ein synthetisches Konto an und löscht es nicht automatisch:

```bash
E2E_ALLOW_TEST_DATA=yes E2E_EMBEDDED_PREVIEW=yes \
E2E_BASE_URL=http://127.0.0.1:3000 E2E_PREVIEW_ORIGIN=https://academy.test \
node --test tests/e2e/preview-embedded.smoke.cjs
```

Mit `E2E_BLOCK_HMR=yes` wird zusätzlich eine Vorschau ohne durchgereichten HMR-WebSocket simuliert. Für die eingebettete Vorschau ist der optionale React-Debugkanal deaktiviert, damit die erstmalige Darstellung nicht von dieser Verbindung abhängt.

### Browser-Smoke-Test der Kursverwaltung

Für `tests/e2e/catalog.smoke.cjs` eine **neue, leere, lokale Wegwerf-Datenbank** mit Namen `*_e2e_test` und einen separaten Redis-Testindex verwenden. Diese Datenbank ist nicht die Anwendungs- oder Integrationstestdatenbank. Den Mail-Worker für diese Datenbank nicht starten: Der Test liest die synthetischen Aktivierungstokens direkt aus ihrer verschlüsselten Outbox. API und Test müssen dieselben Entwicklungsschlüssel aus `.env` verwenden; Web und API müssen genau auf diese Testumgebung zeigen. Beispiel nach dem einmaligen Anlegen von `trainerb_catalog_e2e_test` und mit laufendem lokalen PostgreSQL/Redis:

```bash
export E2E_CATALOG_DATABASE_URL='postgresql://trainerb:trainerb-local-only@127.0.0.1:5432/trainerb_catalog_e2e_test'
DATABASE_MIGRATION_URL="$E2E_CATALOG_DATABASE_URL" npm run db:migrate
# Separates Terminal: ausschließlich für diesen Test
APP_ENV=development DATABASE_URL="$E2E_CATALOG_DATABASE_URL" REDIS_URL=redis://127.0.0.1:6379/14 \
  PUBLIC_BASE_URL=http://localhost:3000 ALLOW_INSECURE_LOCAL_HTTP=true \
  TRAINERB_EMBEDDED_PREVIEW_COOKIES=false npm run dev:api
# Weiteres Terminal: npm run dev:web (ggf. API_INTERNAL_ORIGIN passend setzen)
E2E_CATALOG_SMOKE=yes E2E_ALLOW_TEST_DATA=yes E2E_BASE_URL=http://localhost:3000 \
  node --test tests/e2e/catalog.smoke.cjs
```

Der Test richtet synthetische Administrator- und Mitarbeiterkonten ein und legt Entwürfe an; er löscht diese Daten nicht automatisch. Vor einer Wiederholung eine neue leere Testdatenbank verwenden oder die dedizierte Wegwerfdatenbank bewusst zurücksetzen. Er prüft u. a. MFA, Rollenvergabe, Zuordnung/Entzug, Inhaltsbausteine mit Konflikt- und Zugriffsschutz, Pagination sowie einen mobilen leeren Katalog. Er ersetzt keine vollständige Sicherheits- oder Barrierefreiheitsprüfung.

## Konzeptdokumente

1. [Technische Architektur und Leitentscheidungen](docs/01-architektur.md)
2. [Relationales Datenbankschema und Datenwörterbuch](docs/02-datenmodell.md)
3. [Geschäftsabläufe und API-Schnittstellen](docs/03-ablaeufe-und-api.md)
4. [Sicherheit, Datenschutz, Betrieb und Wiederherstellung](docs/04-sicherheit-und-betrieb.md)
5. [Entwicklungsphasen, Abhängigkeiten und Testplan](docs/05-phasen-und-tests.md)
6. [Geplante Administration und Bedienungsanleitung](docs/06-admin-handbuch.md)
7. [Entwicklungs- und Betriebshinweise zum aktuellen Teilumfang](docs/07-entwicklung.md)

Die Dokumente beschreiben den **Zielzustand**, nicht automatisch vorhandene Funktionen. Preise, Lehrinhalte, Bewertungen und rechtlich geprüfte Anbieterangaben werden nicht erfunden. Die Klärung von FernUSG/ZFU, Widerruf, Datenschutz und Steuern sowie eine fachliche und rechtliche Freigabe sind vor einem kommerziellen Start erforderlich.

### Private Kapitelmedien aus S3 (optional)

Für bereits geprüfte, einem Kapitel zugeordnete Objekte die fünf `MEDIA_S3_*`-Werte aus `.env.example` setzen. Der Browser muss den separaten HTTPS-Endpunkt erreichen können. Benötigt werden ein privater Bucket mit Path-Style-Zugriff und ein eigener Schlüssel mit ausschließlich `GetObject` für diese Lernmedien. Ohne Konfiguration bleiben Textkurse unverändert nutzbar; Entwürfe mit Kapitelmedien sind nicht veröffentlichbar.

`GET /api/v1/me/courses/:slug/chapters/:chapterId/media/:contentId` prüft Sitzung, persönlichen Kurszugang, Version, Kapitel und aktuellen Assetstatus. Erst dann folgt ein Redirect auf einen signierten GET für genau ein Objekt (maximal 60 Sekunden, nie länger als die verbleibende Zugangsdauer). Bereits ausgestellte Links bleiben bis zu ihrem Ablauf nutzbar; eine Sperre verhindert neue Links. Signierte URLs nicht protokollieren oder cachen, auch nicht im Speicher-/Proxy-Logging. Vor Einsatz Abruf, Ablauf und Cache-Verhalten am gewählten S3-Dienst testen.

JPEG, PNG, WebP, GIF sowie MP4 und WebM werden im Lernbereich angezeigt, Dateien als Download ausgeliefert. Externe Videoanbieter, Upload, Scan und redaktionelle Zuordnung sind nicht Teil dieser Funktion. Ein `ready`-Eintrag ersetzt keine tatsächliche Prüfung der Datei.

**Abnahmetest:** Die CI startet für `bash scripts/test-integration-s3.sh` einen temporären S3-Speicher (VersityGW) mit TLS auf Loopback. Lokal benötigt der Befehl zusätzlich zu den normalen Integrationstest-Voraussetzungen VersityGW v1.11.0 im `PATH`, einen freien Loopback-Port 19754, Bash, OpenSSL und curl. Der Test prüft den Lernroute-Redirect mit einer Teilnehmersitzung, den tatsächlichen Objektinhalt und die Antwortheader, die Abweisung eines unsignierten Abrufs und den erneuten Abruf mit *derselben* URL nach Ablauf. Ein frisch ausgestellter Link muss danach funktionieren. Gateway-Prozess, Testobjekt und temporäre Zertifikate werden beim Beenden entfernt. `npm run test:integration` allein benötigt keinen Objektspeicher und prüft nur die API-/Signierungsseite dieses Ablaufs.

**Vor Freigabe beim gewählten Anbieter wiederholen:** In der isolierten Staging-Umgebung als Testteilnehmer ein kleines synthetisches Kapitelmedium öffnen. Der Redirect muss zum erwarteten HTTPS-Speicher führen; Inhalt und `Cache-Control: private, no-store` am Objekt prüfen. Die Objektadresse ohne Queryparameter darf keinen Inhalt liefern. Nach Ablauf von `X-Amz-Expires` dieselbe signierte URL ohne Browsercache erneut anfordern: Der Speicher muss sie abweisen. Über die Lernroute muss ein neuer Link funktionieren, solange der Zugang gilt. Nur Ergebnis, Zeitpunkt und Statuscodes dokumentieren, keine Cookies, signierten Links oder Netzwerk-Mitschnitte. Ein erfolgreicher VersityGW-Test ersetzt diesen Anbietercheck nicht.

**Upload in private Quarantäne (optional):** In der Kursverwaltung können Mitarbeiter mit `media.upload` für ihren eigenen Kurs PNG, JPEG und PDF bis 5 MiB hochladen. Admins mit diesem Recht dürfen kursübergreifend hochladen. Die API prüft Dateisignatur, Endung und Größe; das ist kein Malware-Scan. Der Upload-Beleg in `course_media_uploads` startet als `pending_scan`. Er ist kein `media_asset` und kann nicht als Cover oder Kapitelmedium referenziert werden. Es gibt weder Vorschau noch Freigabe.

Zusätzlich zur S3-Lesekonfiguration alle drei `MEDIA_QUARANTINE_*`-Variablen setzen. Auf demselben Endpunkt einen **separaten privaten Bucket** und eine eigene Identität nur für `PutObject` einrichten. Öffentliche ACLs/Listen sperren; der Auslieferungsschlüssel darf den Quarantäne-Bucket nicht lesen. Die API setzt keine Bucket-Policies. Ohne Konfiguration bleibt der Upload deaktiviert. Da Objektspeicher und Datenbank keine gemeinsame Transaktion haben, kann bei Abbruch nach dem PUT ein privates Objekt ohne Beleg zurückbleiben. Vor Aktivierung eine Lifecycle-Regel für den Quarantäne-Bucket und ein Verfahren zur Bereinigung abgelaufener Belege festlegen. Keine Kundendaten für die technische Abnahme verwenden.

### Öffentliche Rechtsseiten vor dem Livegang

`/impressum`, `/datenschutz` und `/agb` sind ohne Konto über den Footer erreichbar, auch bei ausgeschaltetem Verkauf. Unter **Zahlung & Recht → Fassungen** die tatsächlichen Anbieterangaben und die geprüften Wortlaute als Entwurf anlegen und nach Prüfung aktivieren. Ohne aktive Fassung erscheint ein Hinweis, kein Mustertext. Das Impressum wird nicht aus Rechnungsdaten abgeleitet und ist keine zusätzliche Checkbox im Checkout. Die technische Seite ersetzt weder vollständige Angaben noch die rechtliche Freigabe.

Nur für die ausdrücklich freigegebene Live-Website beim **Web-Build** `NEXT_PUBLIC_SITE_STAGE=live` setzen. Staging behält auch bei `next build` den Testdatenhinweis; der Schalter aktiviert weder Verkauf noch Suchmaschinenindexierung.

### Malware-Prüfung der Quarantäne

`npm run media:scan` als separaten geplanten Job ausführen (bis zu 25 ausstehende Belege pro Lauf). Ohne eingerichteten Job warten Uploads in Quarantäne. Der Job braucht Zugriff auf die Datenbank, die bestehende Speicherkonfiguration und zusätzlich die drei `MEDIA_SCAN_*`-Werte aus `.env.example`. Die Scanner-Identität erhält **nur GetObject im Quarantäne-Bucket**, keine Schreib- oder Freigaberechte. Zugangsdaten und Socket nur dem Scanprozess bereitstellen.

Einen isolierten, aktuell gehaltenen ClamAV-Daemon mit lokalem Unix-Socket bereitstellen. Signaturupdates (z. B. freshclam), Alter der Signaturen, Erreichbarkeit und Job-Exitcode überwachen. Stream-/Datei-/Scanlimits für mindestens 5 MiB und die unterstützten Formate konfigurieren; verschlüsselte Dokumente und überschrittene Analyselimits als Fund melden lassen (`AlertEncrypted`, `AlertExceedsMax`). TLS-Zertifikate für den Objektspeicher regulär validieren. Vor Einsatz mit harmloser Datei, anerkanntem Antivirus-Testobjekt und gestopptem Daemon prüfen.

Größe und SHA-256 müssen vor dem Scan dem Beleg entsprechen. Nur eine eindeutige OK-Antwort gilt als `clean`; Fund (`infected`) und technischer Fehler (`scan_error`) bleiben gesperrt. Ergebnisse stehen in der Kursverwaltung, im Audit ohne Dateiinhalt/Scanner-Rohmeldung. Nach Fehlerbehebung gezielt mit `npm run media:scan -- --retry-error <Beleg-UUID>` wiederholen. Ein laufender oder bereits abschließend geprüfter Beleg wird dabei nicht erneut verarbeitet. Auch `clean` ist **keine Veröffentlichung**: Objekt und Beleg bleiben in der Quarantäne; Kopie in den Auslieferungsbucket und redaktionelle Zuordnung sind nicht Teil des Prüflaufs.

Die CI prüft das Scanprotokoll zusätzlich mit einem echten lokalen `clamd`, einer temporären Signatur für eine harmlose Testdatei und ohne Produktionszugang. Lokal nach dem API-Build: `node --test tests/scanner/clamd.test.cjs` (`clamd` im PATH oder `TEST_CLAMD_BINARY` setzen). Dieser Test belegt die Anbindung, nicht die Aktualität oder Erkennungsleistung der Signaturen auf Staging.
