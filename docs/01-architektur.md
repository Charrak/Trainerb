# 1. Technische Architektur und Leitentscheidungen

**Version 1.0 · 15.11.2026 · Entwurf zur Freigabe**

Verantwortlich: Soufian Charrak · Erste geplante Ausbildung: Fitnesstrainer B-Lizenz

> Dieses Dokument beschreibt das Zielkonzept. Nach ausdrücklicher Freigabe wurde Phase 1 begonnen; der tatsächliche Implementierungsstand steht in der [README](../README.md). Weder Konzept noch Entwicklungsstand begründen eine staatliche Zulassung, Zertifizierung, Rechtskonformität oder Produktionsreife.

## 1.1 Ziel und Geltungsbereich

Geplant ist eine professionelle Online-Akademie mit öffentlicher Website, Katalog, Warenkorb, Zahlungsanbindung, Kundenportal, Lernplattform, Prüfungen, Zertifikaten, Newsletter und geschütztem Backoffice. Das System unterstützt **beliebig viele fachlich unterschiedliche Kurse** sowie Varianten und Pakete. Die Zahl der tatsächlich gleichzeitig möglichen Nutzer wird durch Kapazität und Betrieb begrenzt, nicht durch eine fest eingebaute Kurszahl.

Die Fitnesstrainer-B-Lizenz ist der erste konfigurierte Kurs, kein eigener technischer Sonderfall. Ihre Strukturvorgaben werden als Daten und Veröffentlichungsregeln erfasst. Preise, Kursinhalte, Anbieterangaben, Seitentexte, E-Mail-Vorlagen und Rechtstexte kommen aus der Datenbank. Technische Validierungs-, Berechtigungs- und Geschäftsregeln müssen dagegen selbstverständlich im Anwendungscode implementiert werden.

Die Dokumentation besteht aus sechs zusammengehörigen Teilen: [Datenmodell](02-datenmodell.md), [Abläufe und API](03-ablaeufe-und-api.md), [Sicherheit und Betrieb](04-sicherheit-und-betrieb.md), [Phasen und Tests](05-phasen-und-tests.md) sowie [Admin-Handbuch](06-admin-handbuch.md).

## 1.2 Prüfung der Referenz

Die angegebene Adresse `https://share.google/aARKHakhK3yaWXB7P` leitete bei der Inhaltsprüfung am 15.11.2026 auf `https://vitalzentrum-eschweiler.de/home` weiter. Die öffentlich abrufbare Seite beschreibt ein Gesundheits-, Trainings- und Physiotherapieangebot mit gegliederter Navigation, Leistungsbereichen und Kontaktmöglichkeiten. Sie ist keine bereits vorhandene Online-Akademie.

Für die Akademie dienen lediglich allgemeine Prinzipien wie klare Navigation, eine verständliche Vorstellung des Angebots und zugängliche Kontaktmöglichkeiten als Orientierung. Der Abruf liefert keine verlässliche vollständige Prüfung des visuellen Erscheinungsbildes, der mobilen Bedienung oder der Nutzungsrechte. **Keine Logos, Texte, Fotos, Gestaltungsdetails, Bewertungen oder behaupteten Kooperationen werden ohne ausdrückliche Freigabe übernommen oder verändert.** Eine Marken- und Gestaltungsfreigabe erfolgt später gesondert.

## 1.3 Leitentscheidungen

| Entscheidung | Festlegung und Begründung |
|---|---|
| Architektur | Modularer Monolith mit separat laufendem Worker. Ein gemeinsamer Fachcode und eine relationale Datenbank sind einfacher zu testen und zu betreiben als Microservices. Fachmodule haben klar definierte Schnittstellen. |
| Sprache | TypeScript für Web, API und Worker; Validierung erfolgt zur Laufzeit zusätzlich zur Typprüfung. |
| Frontend | Next.js/React für serverseitig darstellbare öffentliche Seiten und interaktive Portale; Tailwind CSS und zugängliche gemeinsame Komponenten. |
| Backend | NestJS mit REST-API, zentralen Authentifizierungs-, Berechtigungs- und Validierungsschichten. |
| Datenbank | PostgreSQL 16 als anfängliche Mindestbasis; unterstützte Patchversion einsetzen und vor Ende des Herstellersupports geordnet upgraden. Relationale Constraints und Transaktionen sind maßgeblich. |
| Datenzugriff | Prisma und versionierte Migrationen; für von Prisma nicht abbildbare Constraints gezielte, geprüfte Migrationen. Parametrisierte Abfragen verwenden; ORM-Nutzung allein garantiert weder SQL-Injection-Schutz noch Autorisierung. |
| Hintergrundarbeit | Redis und BullMQ für Ausführung und Wiederholungen. Der dauerhafte Auftragszustand liegt zusätzlich in PostgreSQL; Redis-Verlust darf keine Geschäftsaktion verlieren. |
| Dateien | EU-S3-kompatibler Objektspeicher mit privaten Buckets, unveränderlichen Objektschlüsseln, Malware-Prüfung und kurzlebigen Zugriffslinks. |
| Video | Externer Dienst mit Zugriffsbeschränkung und möglichst EU-Verarbeitung; Verträge und Drittlandtransfers vor Nutzung prüfen. Kein eigener Streaming-Stack. |
| Zahlung | Stripe Checkout als erste tatsächliche Integration. Karte und SEPA nur bei unterstützter und aktivierter Händlerkonfiguration; PayPal über Stripe nur, wenn dort für das Konto verfügbar. Ein direkter PayPal-Adapter ist eine spätere, separat zu prüfende Erweiterung. |
| E-Mail | Transaktions- und Newsletter-Versand über getrennte Versandströme eines geprüften Anbieters; lokale Entwicklungsumgebung mit abgefangenem Testversand. |
| Dokumente | Servergenerierte Rechnungs- und Zertifikats-PDFs aus eingefrorenen Daten und kontrollierten Vorlagen. |
| Betrieb | Zunächst Docker Compose auf einem EU-Server bzw. mit verwaltetem EU-PostgreSQL; Reverse Proxy mit TLS. Kein Kubernetes. Datenbank, Speicher und Backups sind auch bei Ausfall des Webservers wiederherstellbar. |
| Überwachung | Strukturierte, datensparsame Logs, Verfügbarkeitsüberwachung, Job- und Zahlungsabgleich; optional Fehlerdienst mit geprüfter EU-Konfiguration. |
| Qualität | Unit-, Integrations-, Sicherheits- und End-to-End-Tests; echte Anbieter-Sandbox für Zahlungstests, niemals simulierte Produktionszahlungen. |

Node.js 24 LTS ist die Ausgangsbasis; bei jedem Release werden Supportstatus, kompatible Versionen von Next.js/NestJS/Prisma sowie Sicherheitsupdates geprüft. Die Abhängigkeiten sind im Lockfile fixiert; produktive Container-Image-Digests und das Release-Verfahren müssen vor einem Livegang gesondert festgelegt werden. Komponenten dürfen nur durch gleichwertige, dokumentierte Entscheidungen ersetzt werden.

### Fachliche Standardannahmen zur Freigabe

| Thema | Konkreter Startwert |
|---|---|
| Absatzmarkt | Deutschland, bis Steuer- und Rechtsprüfung weitere Länder freigibt. EU-Erweiterung ist im Datenmodell vorgesehen. |
| Registrierung und Gastkauf | Vor- und Nachname sind bei jeder Kontoerstellung Pflicht. Beim Gastkauf werden die Namen der teilnehmenden Person vor Bestellung und Zahlung getrennt von den Rechnungsdaten erfasst; die bestätigte E-Mail bestimmt das Teilnehmerkonto. Ein neues Konto entsteht erst nach Zahlungserfolg per signaturgeprüftem Webhook; ein bestehendes Profil wird nicht überschrieben. Der spätere Login erfolgt mit E-Mail und Passwort, für Backoffice-Rollen zusätzlich mit MFA. |
| Gutschein | Ein Coupon je Bestellung; ein automatischer Kauf muss einen positiven Zahlbetrag haben. Ein 100-%-Nachlass ist zunächst nur über einen ausdrücklich manuellen Zugang möglich, nicht als fingierte Zahlung. |
| Zugangsdauer | Ein Tag entspricht 24 Stunden ab tatsächlichem Zugangsstart. Überlappende Kaufquellen laufen unabhängig und werden nicht automatisch addiert; die Vorschau weist darauf hin. |
| Rückerstattung | Bereits begonnene Zugänge bleiben bis zur protokollierten Admin-Entscheidung bestehen; noch nicht begonnene Zugänge werden bei vollständiger Erstattung/offener Rückbuchung vorsorglich angehalten. |
| Lernabschluss | Fortschritt wird automatisch gespeichert. Für die erste Ausbildung wird ein Kapitel nach Bestehen seiner beiden Prüfungen automatisch abgeschlossen; eine Selbstbestätigung bleibt möglich. Nach allen 84 bestandenen Prüfungen wird das personalisierte Zertifikat automatisch als PDF erstellt. Für weitere Kurse sind Kapitel- und Abschlussregeln konfigurierbar. |
| Zahlungs- und Preismodelle | Zunächst einmalige Zahlung über die tatsächlich aktivierten Stripe-Zahlarten; Raten und Abos sind spätere, gesondert zu entwerfende Erweiterungen. |

Dies sind Vorschläge und keine vorweggenommene Betreiber- oder Rechtsfreigabe. Eine Änderung vor der Architekturfreigabe wird dokumentiert, bevor darauf aufbauend implementiert wird.

**Erweiterungspfad für spätere Preismodelle:** Bei einem freigegebenen Abo oder Ratenplan werden ein eigener Vertrags-/Plan-Datensatz und periodische Fälligkeiten ergänzt. Jede tatsächlich fällige Zahlung erzeugt einen eigenen unveränderlichen Bestell-/Rechnungssnapshot mit eigenem Zahlungserfolg und – nach fachlicher Regel – einer Zugangsquelle. `orders.origin` und die optionale Warenkorbreferenz erlauben dafür später weitere Ursprünge ohne künstlichen Warenkorb; Kurs, Inhalte, bestehende Bestellungen, Webhook-Nachweise und Lernstände müssen nicht neu erfunden werden. Kündigung, Mahnung, gescheiterte Folgelastschriften, Steuern und Anspruch auf Zugang benötigen ein gesondertes Fach-, Daten- und Rechtskonzept. Diese Modelle sind im ersten Ausbau ausdrücklich nicht funktionsfähig.

### Bewusst vermiedene Komplexität

Keine Microservices, kein Kubernetes, kein GraphQL, keine eigene Kartenverarbeitung und kein eigenes Videostreaming. Es gibt zunächst **einen Betreiber und eine Organisation**, keine vorgetäuschte Mandantenfähigkeit. Bei späterem Bedarf sind Mandantentrennung und deren Sicherheitsfolgen gesondert zu entwerfen. Das breite Fachgebiet führt dennoch zu vielen Tabellen; sie werden phasenweise eingeführt und nicht alle in Phase 1 implementiert.

## 1.4 Systemübersicht

```text
Browser, mobile Geräte
        │ HTTPS, eine öffentliche Domain
        ▼
Reverse Proxy / TLS
        ├── /api/v1/* ───────────────► NestJS-API
        └── /* ──────────────────────► Next.js-Web-App
                                         │ serverseitig intern zur API
NestJS-API ──► PostgreSQL ◄──────────── NestJS-Worker
     │              │                         │
     │              └── dauerhafte Jobs        ├── BullMQ / Redis
     │                                        ├── E-Mail-Dienst
     ├── Stripe Checkout und Webhooks          ├── PDF-Erzeugung
     ├── privater EU-Objektspeicher             └── Fristen / Abgleich
     └── autorisierter Video-Dienst
```

Der Browser ruft die API über **relative URLs derselben Domain** auf. Interne Containeradressen sind nur serverseitig bekannt. Es gibt keine Browser-Aufrufe an `localhost` oder interne Dienstnamen. Private Antworten werden nicht öffentlich gecacht; öffentliche Inhalte können kontrolliert zwischengespeichert und beim Veröffentlichen invalidiert werden.

Die Grundstruktur `apps/web`, `apps/api`, `apps/worker`, `packages/contracts`, `packages/database` und `docs` ist für Phase 1 angelegt; spätere Fachmodule fehlen noch. Web und API sind getrennt deploybar; der Worker verwendet dieselben Backend-Module, aber keine öffentlich erreichbare Verwaltungsoberfläche. Fachmodule greifen nicht unkontrolliert in fremde Tabellen; über definierte Services und transaktionale Schnittstellen werden benötigte Änderungen koordiniert.

### Backend-Module

| Modul | Verantwortung |
|---|---|
| `auth`, `users`, `rbac` | Konten, Sitzungen, MFA, Rollen, Rechte, Kurszuordnung |
| `catalog`, `media`, `cms` | Kurse und Versionen, Lernhierarchie, Medien, Seiten und rechtliche Inhalte |
| `shop`, `payments`, `invoicing` | Warenkorb, Preise, Gutscheine, Bestellungen, Zahlungsadapter, Webhooks und Rechnungsdokumente |
| `enrollments`, `learning`, `exams` | Zugangsberechtigungen, Fortschritt, Prüfungen, Versuche und Ergebnisse |
| `certificates` | Abschlussprüfung, Zertifikatsausstellung, Widerruf und Verifikation |
| `mailer`, `newsletter`, `automation` | Vorlagen, E-Mail-Outbox, Double-Opt-in, Kampagnen und wiederholbare Aufträge |
| `audit`, `privacy`, `admin-stats` | Nachvollziehbarkeit, Auskunft/Löschung, aggregierte Auswertungen |

Der konkrete Bestand an Tabellen und ihren Fremdschlüsseln ist in [02-datenmodell.md](02-datenmodell.md) verbindlich beschrieben. Das Modulmodell ist organisatorisch; wo eine einzelne fachliche Transaktion mehrere Tabellen betrifft, koordiniert ein Anwendungsservice die Arbeit auf derselben Datenbankverbindung.

## 1.5 Fachliche Invarianten

1. **Kurs und Verkauf sind getrennt:** Ein Kurs hat veröffentlichte Inhaltsversionen; ein Produkt enthält einen oder mehrere Kurse und kann mehrere Preisversionen haben. Ein Paket ist ein Produkt mit mehreren Kursen. Bestellpositionen frieren den jeweiligen Inhalt und Preis ein.
2. **Ein Kaufzugang folgt nur einem signaturgeprüften und erfolgreich verarbeiteten Zahlungs-Erfolgswebhook:** Browserrückleitung, bloßer Providerabgleich, Warenkorb und unbestätigte Banklastschrift gewähren keinen Zugang. Ein ausdrücklich berechtigter Mitarbeiter kann davon unabhängig einen **manuellen**, protokollierten Zugang anlegen; dadurch entsteht weder ein bezahlter Auftrag noch eine Rechnung, und die Webhook-Pflicht eines konkreten Kaufs wird nicht umgangen.
3. **Zahlungsereignisse sind wiederholbar verarbeitbar:** Verifizierter Eingang und veränderlicher Verarbeitungsstatus sind getrennt. Eindeutige Provider-IDs, Transaktionen, Sperren und eindeutige Fulfillment-Schlüssel verhindern doppelte Auswirkungen.
4. **Mehrere Zugangsquellen bleiben unabhängig:** Kauf eines Einzelkurses und eines Pakets kann zwei Berechtigungen für denselben Lernstand erzeugen. Entzug einer Quelle entfernt nicht automatisch andere noch gültige Quellen.
5. **Veröffentlichte Lerninhalte sind versioniert:** Käufer lernen in der erworbenen Version; Änderungen erzeugen eine neue Version. Bestehende Versuche und Zertifikate bleiben nachvollziehbar. Eine Übernahme in eine neue Version ist eine gesonderte, dokumentierte Aktion.
6. **Prüfungslösungen bleiben serverseitig:** Ein fehlgeschlagener Versuch gibt weder richtige Antworten noch Erklärungen noch eine Teilpunktzahl preis. Nach bestandenem Versuch werden nur dessen Lösungen und Erklärungen freigegeben.
7. **Finanzwerte sind ganzzahlig:** Beträge in kleinsten Währungseinheiten, zu Beginn Euro-Cent; Steuersätze in Basispunkten. Preise sind brutto. Bestellungen speichern unveränderliche Betrags- und Steuer-Snapshots.
8. **Einwilligung ist zweckgebunden:** Kauf, Kontoregistrierung und Datenschutzinformation begründen keine Newsletter-Einwilligung. Nicht erforderliches Tracking ist standardmäßig aus.
9. **Keine geheimen Passwörter per E-Mail:** Neue Kunden setzen ein Passwort über einen zeitlich begrenzten, einmaligen Aktivierungslink. Bereits bestehende Konten zur selben kanonischen E-Mail werden nicht dupliziert und keine bestehenden Anmeldesitzungen durch einen Kauf erzeugt. Unterschiedliche E-Mail-Aliase einer Person sind nicht zuverlässig als derselbe Mensch erkennbar und werden nicht ungeprüft zusammengeführt.
10. **Keine automatischen Rechtsbehauptungen:** Die Frage einer Fernunterrichtszulassung, die Einordnung des Angebots, Widerruf, Rechnungs- und Steuerregeln sowie die Anwendbarkeit des BFSG werden vor Start fachkundig geprüft. Eine technische Markierung ist kein Ersatz für eine behördliche Entscheidung.

### Präzisierungen gegenüber dem ursprünglichen Entwurf

Ein Datensatz kann nicht gleichzeitig unveränderlich und für Statusübergänge frei änderbar sein. Deshalb sind Ereignisse und Ergebnisse anfügbar, während beispielsweise Jobstatus, Zahlungsversuche und noch nicht abgeschlossene Prüfungsversuche kontrolliert veränderlich sind. Ein Nummernkreis wird transaktional geführt, aber eine absolute Lückenlosigkeit über Ausfälle, Stornos und Fremdsysteme hinweg nicht versprochen; Unregelmäßigkeiten werden dokumentiert und geprüft. Die Grenzen eines Kontos pro E-Mail und die unabhängigen Zugangsquellen ersetzen eine zu grobe Regel, die Wiederkäufe oder überlappende Pakete verhindern würde.

## 1.6 Öffentliche und geschützte Oberflächen

Öffentliche Routen umfassen Startseite, Über uns, Ausbildungskatalog und Kursdetails, FAQ, Kontakt, Newsletter, Impressum, Datenschutz, Widerruf, AGB, Zahlungsinformationen sowie die öffentliche Zertifikatsprüfung. Inhalte und Navigation sind redaktionell versioniert. Öffentliche Bewertungen werden nur mit entsprechender Berechtigung und Freigabe veröffentlicht; es werden keine erfundenen Bewertungen angelegt.

Im Kundenportal stehen eigene Kurse, Lernstände, Prüfungen, Zertifikate, Bestellungen, Rechnungen und Kontoeinstellungen zur Verfügung. Jeder Zugriff wird serverseitig auf Nutzer, Kursversion und gültige Zugangsquelle geprüft. Das Backoffice unter `/admin` nutzt dieselbe API, aber eigene Berechtigungen und eine MFA-geschützte Sitzung. Oberfläche und versteckte Schaltflächen ersetzen keine Serverprüfung.

Gestaltungsziele: gut lesbare Typografie, klare Informationshierarchie, responsive Layouts, sichtbare Fokuszustände, Tastaturbedienung, semantisches HTML, Alternativtexte, Untertitel/Transkripte, ausreichender Kontrast, reduzierte Animation bei entsprechendem Betriebssystemwunsch und mindestens WCAG-2.2-AA als technisches Ziel. Ob und in welchem Umfang bestimmte gesetzliche Anforderungen gelten, wird gesondert geprüft.

## 1.7 Rollen und Sicherheitsgrenzen

Vorgesehen sind `superadmin`, `admin`, `course_manager`, `instructor`, `support` und `participant`. Berechtigungen werden in der Datenbank Rollen zugeordnet. Welche Berechtigung ein bestimmter API-Vorgang benötigt, ist dennoch explizit im Code festgelegt und zentral geprüft. Kursmanager und Dozenten benötigen zusätzlich eine Kurszuordnung. Die vollständige Matrix steht im [Admin-Handbuch](06-admin-handbuch.md#63-rollen--und-berechtigungsmatrix).

Für alle Backoffice-Rollen ist MFA verpflichtend; ohne abgeschlossene Einrichtung besteht nur eine eng begrenzte Einrichtungssitzung, kein Admin-Zugriff. Kritische Vorgänge verlangen erneute Authentifizierung. Der erste Superadmin wird nach der späteren Installation über einen einmaligen, lokal autorisierten Bootstrap-Prozess mit vom Betreiber vorgegebener E-Mail sowie Vor- und Nachnamen eingerichtet; es gibt keine fest eingebauten Zugangsdaten. Der letzte Superadmin kann nicht entzogen werden.

## 1.8 Betrieb, Konfiguration und Skalierung

Für Entwicklung, Staging und Produktion gibt es getrennte Datenbanken, Speicher, Redis-Instanzen, Schlüssel und Providerkonten. Stripe-Testereignisse dürfen nie in der Produktion verarbeitet werden und umgekehrt. Eine Produktionskonfiguration startet nicht mit unsicheren Defaults oder fehlenden Pflichtschlüsseln. Die Buchungsfunktion bleibt in Produktion standardmäßig deaktiviert, bis die Freigabekriterien erfüllt sind; eine separat isolierte Testumgebung darf den Checkout ausschließlich mit Testdaten und Testprovidern aktivieren.

Vorgesehene Konfigurationsgruppen; Namen und Format werden bei Implementierung verbindlich validiert:

| Gruppe | Vorgesehene Variablen/Angaben |
|---|---|
| Anwendung | `APP_ENV`, `PUBLIC_BASE_URL`, `COMMERCE_ENABLED`, `LOG_LEVEL`, Zeitzone UTC |
| Datenhaltung | `DATABASE_URL`, `REDIS_URL`; getrennte Datenbankrollen für Migration, Anwendung und Backups |
| Authentifizierung | `CSRF_HMAC_KEY`, `TOKEN_HMAC_KEY`, `DATA_ENCRYPTION_KEY`, `DATA_ENCRYPTION_KEY_ID`, `AUDIT_PSEUDONYMIZATION_KEY`, getrennte Coupon-Identitäts-HMAC-Schlüssel mit Schlüssel-ID |
| Bootstrap | `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_FIRST_NAME`, `BOOTSTRAP_ADMIN_LAST_NAME` nur für den einmaligen autorisierten Einrichtungsschritt; alle sind Pflicht, keine mitgelieferten Passwörter |
| E-Mail | `MAIL_TRANSPORT`, SMTP- bzw. API-Zugang, Absender für Transaktions- und Newsletter-Stream, EU-Region |
| Speicher | S3-Endpunkt, Region, private und öffentliche Buckets, getrennte Zugriffsschlüssel |
| Zahlung | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_ACCOUNT_ID`, getrennte Test-/Live-Konfiguration |
| Optional | Video- und Fehlerdienst-Zugang, sofern geprüft und aktiviert; separate Backup-Schlüssel |

Secrets werden nicht in Git, Browser-Bundles, Logs oder CMS-Einstellungen gespeichert. Sie werden über geschützte Umgebungsvariablen bzw. einen Secret-Store injiziert und rotierbar gehalten. `PUBLIC_BASE_URL` muss eine erlaubte HTTPS-Produktionsdomain sein. Eine Admin-Oberfläche zeigt höchstens den Konfigurationsstatus, nicht die Geheimwerte.

Startbetrieb: eine Instanz für Web, API und Worker; PostgreSQL und Redis können auf derselben Maschine laufen, wenn sie überwacht und separat gesichert werden. Das ist **kein Hochverfügbarkeitscluster**. Bei Wachstum werden Web/API/Worker horizontal erweitert, PostgreSQL/Speicher getrennt betrieben und Abfragen sowie Queues gemessen, bevor weitere Technologien eingeführt werden. Sitzungen, Jobs und Idempotenz dürfen nicht vom lokalen Prozessspeicher abhängen.

## 1.9 Entscheidungen, die Phase 1 nicht blockieren

Phase 1 kann nach technischer Freigabe mit den beschriebenen Standardwerten beginnen. Folgende Angaben werden spätestens vor der jeweils betroffenen Funktion bzw. vor Livegang benötigt und dürfen nicht erfunden werden:

- Rechtsform, vollständige Anbieterbezeichnung, ladungsfähige Anschrift, Kontakt, Steuer- und Rechnungsangaben; der vom Nutzer genannte Name Soufian Charrak ist verantwortliche Person, nicht automatisch eine vollständige Anbieterbezeichnung.
- Endgültige Domain, Brandingrechte, Kursmedien, echte Kursinhalte und Preise; Autorisierung zur Verwendung fremder Materialien.
- Einschätzung und Dokumentation zu FernUSG/ZFU je betroffener Ausbildung; gegebenenfalls Zulassung vor Vertrieb. Keine Annahme, dass ein Quiz automatisch eine Zulassung beweist oder ausschließt.
- Fachliche Freigabe der AGB, Datenschutzhinweise, Widerrufsbelehrung, Bestelltexte, Nachweise und der Einordnung als Dienstleistung/digitaler Inhalt. Die Checkboxen dürfen keinen pauschalen Widerrufsverzicht suggerieren.
- Steuerkonzept, Rechnungsangaben, zulässige Absatzländer und etwaige EU-OSS-Behandlung. Bis zur Freigabe weiterer Länder ist für den ersten operativen Start **Deutschland** als Zielmarkt vorgesehen; das Datenmodell lässt weitere Länder zu.
- Konkrete Verträge, AV-Verträge bzw. sonstige datenschutzrechtliche Vereinbarungen, Datenstandorte und ggf. Drittlandtransfer-Prüfungen für Hosting, Zahlung, E-Mail, Video und Monitoring.
- Gewünschte Zugangsdauer, Abschlussregeln, Gutschein- und Rückerstattungspolitik sowie zugelassene Medien- und Zertifikatsvorlagen.

Der Betreiber muss keine Geheimnisse im Repository oder Chat hinterlegen. Die noch ausstehenden Entscheidungen sind Go-live-Sperren, keine Aufforderung, Phase 1 ohne Sicherheitskonzept zu beginnen.

## 1.10 Orientierende Primärquellen

- [PostgreSQL 16: UUID-Funktionen](https://www.postgresql.org/docs/16/functions-uuid.html) – UUIDv7 ist dort nicht als eingebaute Standardfunktion beschrieben.
- [Stripe: Webhooks empfangen und prüfen](https://docs.stripe.com/webhooks).
- [FernUSG § 1 – Anwendungsbereich](https://www.gesetze-im-internet.de/fernusg/__1.html).
- [BGB § 356 – Widerrufsrecht](https://www.gesetze-im-internet.de/bgb/__356.html).
- [BFSG § 1 – Anwendungsbereich](https://www.gesetze-im-internet.de/bfsg/__1.html).

Diese Quellen ersetzen keine Prüfung des konkreten Angebots und der jeweils aktuellen Rechtslage.
