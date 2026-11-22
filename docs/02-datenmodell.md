# 2. Relationales Datenbankschema und Datenwörterbuch

**Version 1.0 · 15.11.2026 · konzeptioneller Entwurf, kein SQL und keine Migration**

Dieses Datenwörterbuch spezifiziert das geplante Gesamtprodukt. Die [Phasenplanung](05-phasen-und-tests.md) bestimmt, wann eine Tabelle tatsächlich eingeführt wird. Es beschreibt keine bereits existierende Datenbank. Fachliche Abläufe und Transaktionen stehen in [03-ablaeufe-und-api.md](03-ablaeufe-und-api.md).

## 2.1 Leseregeln und Datenkonventionen

### Tabellenformen

- **S – Stammdatensatz:** Zusätzlich zu den genannten Feldern immer `id uuid` Primärschlüssel, `created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP` und `updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`. `updated_at` wird bei jeder Änderung zentral aktualisiert.
- **E – Ereignis/Nachweis:** Zusätzlich `id uuid` Primärschlüssel und `created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP`; kein `updated_at`. Nach dem Einfügen fachlich unveränderlich. Ein technischer Aufbewahrungs-/Löschprozess kann nach dokumentierter Prüfung trotzdem löschen oder anonymisieren.
- **J – Zuordnung/Sondertabelle:** Nur die ausdrücklich genannten Felder; Primärschlüssel und Zeitstempel stehen jeweils dabei.

`name:typ` bedeutet **NOT NULL**, `name:typ?` bedeutet **NULL erlaubt**. `→ tabelle.id` kennzeichnet den Fremdschlüssel; `→ tabelle` ist Kurzform für denselben Primärschlüssel. `U` bedeutet eindeutig, `PK` Primärschlüssel. `text{a|b}` ist ein Textfeld mit `CHECK` auf die aufgezählten Werte, kein unbeschränktes Statusfeld. Ein `=wert` bezeichnet den Standardwert. Referenzen auf später beschriebene Tabellen sind normale Fremdschlüssel. Fehlende Standardwerte bedeuten: Die Anwendung muss den Wert explizit setzen.

Alle S/E-IDs werden durch eine geprüfte UUIDv7-Bibliothek der Anwendung erzeugt; sie sind keine Geheimnisse. PostgreSQL 16 erzeugt mit seiner eingebauten `gen_random_uuid()` UUIDv4, **nicht UUIDv7**. Alle Zeiten sind `timestamptz` in UTC; für Berichte wird eine ausdrücklich gewählte Zeitzone verwendet. Geldbeträge sind `bigint` in kleinsten Währungseinheiten; `currency:char(3)` verwendet gültige ISO-4217-Codes. Ländernamen verwenden `char(2)` nach ISO 3166-1. Prozentwerte und Steuersätze sind ganzzahlige Basispunkte; 1.900 entspricht 19 %.

`jsonb` ist nur für versionierte, validierte Block-, Regel- und unveränderliche Belegdaten vorgesehen, nicht als Ersatz für Kernbeziehungen. Jedes JSON-Feld hat ein serverseitig validiertes, versioniertes Schema; fremde Skripte und beliebige SQL-Ausdrücke sind nicht zulässig. Regeln dürfen nur bekannte Operatoren und IDs verwenden. Inhalte und Medienreferenzen werden beim Veröffentlichen gegen die zugehörige Version geprüft. Textlängen und Uploadgrößen werden sowohl serverseitig als auch, wo zweckmäßig, durch Datenbank-Checks begrenzt: E-Mail höchstens 254 Bytes, Titel 200 Zeichen, Namen 120, externe IDs 255 und JSON-Inhalte je Feld grundsätzlich höchstens 1 MiB; bei begründet kleineren Grenzwerten gilt der niedrigere Wert.

**Referenzielle Integrität:** Standard für Fremdschlüssel ist `ON DELETE RESTRICT`. Historische Datensätze werden nicht durch Kaskaden vernichtet. Soweit zur datenschutzgerechten Löschung erforderlich, werden optionale Verweise durch einen autorisierten Prozess zunächst auf `NULL` gesetzt oder Personenstammdaten anonymisiert; danach wird gegebenenfalls gelöscht. Für jeden Fremdschlüssel existiert ein Index, sofern nicht ein anderer Index ihn bereits als linkes Präfix abdeckt. Entsprechende Prisma-Migrationen ergänzen nicht nativ unterstützte Checks, partielle Indizes und gegebenenfalls Trigger. Geschäftsregeln, die mehrere Zeilen betreffen, werden beim Transaktionsabschluss und beim Veröffentlichen geprüft; reine UI-Validierung genügt nicht.

**E-Mail-Identität:** `email_original` ist die Zustelladresse, `email_canonical` der eindeutige Vergleichswert: Leerraum entfernen, Domain über IDNA in ASCII und kleingeschrieben, lokalen Teil Unicode-normalisieren und für diese Plattform ebenfalls sprachunabhängig kleinschreiben. Provider-spezifische Punkt- oder Plus-Aliasregeln werden nicht angewandt. Die Behandlung des lokalen Teils ist eine bewusste Produktregel; mögliche Kollisionen werden nicht automatisch zusammengeführt. Nach datenschutzgerechter Anonymisierung dürfen beide Felder bei einem gelöschten Nutzer `NULL` sein; PostgreSQL lässt mehrere `NULL`-Werte im Unique-Index zu.

### Verbindliche Namensprüfung

Die folgende feste Regel gilt für Vor- und Nachnamen bei Registrierung, Gastkauf, Bootstrap und Profiländerungen einschließlich administrativer Änderungen. Rechnungsnamen werden unabhängig vom Teilnehmernamen nach derselben technischen Regel geprüft. Sie ist in Formular, Backend und Datenbank mit denselben expliziten Zeichenmengen umzusetzen:

1. Eingabe muss eine gültige Unicode-Zeichenkette sein; `NULL`, andere Typen, ungültige einzelne Surrogates und U+0000 sind nicht zulässig. Ausdrücklich keine Beschränkung auf ASCII: Umlaute, Apostrophe, Bindestriche und internationale Schriften sind erlaubt.
2. Führende und nachgestellte Zeichen aus der festen Menge `W` entfernen: U+0009–U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 sowie zusätzlich U+200B und U+FEFF. Die ersten 25 Zeichen entsprechen der Unicode-White-Space-Menge; die zwei zusätzlichen unsichtbaren Zeichen werden hier bewusst ebenfalls getrimmt. Nicht von implementations- oder sprachabhängigem `trim` beziehungsweise `\s` ausgehen.
3. Das Ergebnis muss 1–120 Unicode-Codepunkte enthalten und nach gedanklichem Entfernen aller Zeichen aus `W` sowie U+200C, U+200D und U+2060 noch mindestens einen Codepunkt besitzen. So gelten auch nur aus diesen unsichtbaren Zeichen bestehende Eingaben als leer; etwa ein ZWNJ oder ZWJ innerhalb eines echten Namens bleibt erhalten. U+0001–U+001F, U+007F–U+009F sowie U+2028/U+2029 sind im Ergebnis als Steuer- bzw. Zeilentrennzeichen nicht erlaubt. Es wird keine Echtheitsprüfung oder automatische Änderung der Schreibweise behauptet.
4. Das Backend speichert den getrimmten Wert. In PostgreSQL mit UTF-8 erzwingt eine geprüfte Check-Constraint je gespeichertem Namen dieselbe Regel: nicht `NULL`, Gleichheit mit `btrim(Wert, W)`, `char_length` zwischen 1 und 120, nach `translate(Wert, W plus U+200C/U+200D/U+2060, '')` nicht leer und keines der genannten verbotenen Zeichen vorhanden. `W` und die Vergleichsmengen sind feste Zeichenlisten, keine kollationsabhängigen Regex-Klassen; bei JavaScript zählt die Implementierung Unicode-Codepunkte statt UTF-16-Codeeinheiten. Direkte DB-Schreibzugriffe mit ungetrimmten Werten werden abgewiesen. Die Ausnahme für die datenschutzgerechte Anonymisierung gelöschter Konten ist unten ausdrücklich geregelt.

**Historie:** Rechnungsinhalt, veröffentlichte Kursversionen, abgegebene Prüfungsdaten, Einwilligungsereignisse und Zahlungseingänge dürfen nicht stillschweigend überschrieben werden. Arbeitsstatus, Zustellversuche und noch offene Vorgänge sind dagegen kontrolliert veränderlich. Versions- und Aufbewahrungsschutz ist mit DSGVO-Löschpflichten und gesetzlichen Aufbewahrungsfristen abzuwägen, nicht als ewige Unlöschbarkeit zu verstehen.

**Technische Durchsetzung:** Datenbankberechtigungen und geprüfte Trigger verweigern der Anwendungsrolle Einfügen/Ändern/Löschen von Lernstruktur, Fragen und Antworten einer bereits `published` oder `retired` Kursversion. An der Versionszeile selbst dürfen nur dokumentierte Lebenszyklusmetadaten wie der Wechsel auf `retired` geändert werden. Auch veröffentlichte Seiten-, Rechts-, E-Mail- und Zertifikatsvorlagen frieren ihren Inhalt ein; neue Fassungen sind neue Zeilen. Bestellpositionen/-kurs-Snapshots sowie ihre Preis- und Rechnungsadresswerte werden nach Bestellung, ausgegebene Beleg- und Zertifikatsinhalte nach Vergabe geschützt; erlaubte Zustell-, PDF- und Widerrufsmetadaten bleiben änderbar. Die spätere Zuordnung eines zuvor leeren Bestell-`user_id` ist kontrolliert zulässig. Datenschutzbedingte Löschung oder Anonymisierung erfolgt ausschließlich über den getrennt berechtigten, dokumentierten Prozess.

## 2.2 Identität, Rollen und Datenschutz

### `users` – S

- `email_original:text?`, `email_canonical:text? U`, `email_verified_at:timestamptz?`, `password_hash:text?` (Argon2id).
- `first_name:text?`, `last_name:text?`, `locale:text=de-DE`, `status:text{pending_activation|active|blocked|deletion_requested|deleted}`, `last_login_at:timestamptz?`, `deleted_at:timestamptz?`.
- Für jedes nicht gelöschte Konto sind gültige E-Mail sowie **Vor- und Nachname verpflichtend**, auch bei `pending_activation`, `blocked` und `deletion_requested`. Beide Namen erfüllen die [verbindliche Namensprüfung](#verbindliche-namensprüfung) in Anwendung und Datenbank.
- `first_name` und `last_name` sind nur bei datenschutzgerechter Anonymisierung und `status=deleted` `NULL`. Eine DB-Constraint verlangt für `deleted` beide Namen als `NULL`, für alle anderen Status beide gültig; Statuswechsel, Anonymisierung und Sitzungswiderruf erfolgen atomar durch den autorisierten Prozess. Gelöschte Konten können sich nicht anmelden oder durch Wiederverwendung alter IDs reaktiviert werden. Nur aktivierte Konten haben ein Passwort und verifizierte E-Mail; Blockierung widerruft Sitzungen.

### `billing_profiles` – S

- `user_id:uuid → users`, `company:text?`, `first_name:text`, `last_name:text`, `street:text`, `street_extra:text?`, `postal_code:text`, `city:text`, `region:text?`, `country:char(2)`, `vat_id:text?`, `is_default:boolean=false`, `archived_at:timestamptz?`.
- `first_name` und `last_name` bezeichnen die Ansprechperson der Rechnung und erfüllen dieselbe Namensprüfung wie bei `users`; sie dürfen vom Teilnehmerprofil abweichen und verändern es nicht. Höchstens ein nicht archiviertes Standardprofil je Nutzer durch partiellen Unique-Index. Bestellungen speichern davon unabhängige Rechnungssnapshots.

### `roles` – S

- `key:text U` mit Systemwerten `superadmin`, `admin`, `course_manager`, `instructor`, `support`, `participant`; `name:text`, `is_system:boolean=true`.

### `permissions` – S

- `key:text U`, `description:text`. Der versionierte Berechtigungskatalog wird bei Einrichtung/Migration angelegt; das Backend ordnet jeder geschützten Operation einen dieser Schlüssel zu.

### `role_permissions` – J

- `role_id:uuid → roles`, `permission_id:uuid → permissions`, `granted_at:timestamptz`; `PK(role_id, permission_id)`.

### `user_roles` – J

- `user_id:uuid → users`, `role_id:uuid → roles`, `granted_by:uuid? → users`, `granted_at:timestamptz`; `PK(user_id, role_id)`. `granted_by` ist nur beim autorisierten Bootstrap leer. Jede Vergabe/Entziehung wird auditiert.

### `user_mfa_factors` – S

- `user_id:uuid → users`, `type:text{totp}`, `status:text{pending|active|revoked}`, `secret_ciphertext:bytea`, `key_id:text`, `confirmed_at:timestamptz?`, `last_used_at:timestamptz?`.
- Geheimnis authentifiziert verschlüsseln, Schlüssel extern halten. Für einen Faktor wird ein TOTP-Zeitschritt höchstens einmal akzeptiert; benötigter zuletzt verwendeter Zeitschritt wird als `last_accepted_step:bigint?` gespeichert. Ein partieller Unique-Index erlaubt höchstens einen Faktor je Nutzer und Typ mit Status `pending` oder `active`.

### `mfa_recovery_codes` – S

- `factor_id:uuid → user_mfa_factors`, `code_hash:bytea U`, `used_at:timestamptz?`, `expires_at:timestamptz?`. Zufällige Codes sind nur einmal sichtbar und atomar einmalig einlösbar.

### `auth_sessions` – S

- `user_id:uuid → users`, `kind:text{preauth|participant|backoffice}`, `token_hash:bytea U`, `csrf_secret_hash:bytea`, `mfa_verified_at:timestamptz?`, `reauthenticated_at:timestamptz?`, `last_seen_at:timestamptz`, `expires_at:timestamptz`, `revoked_at:timestamptz?`, `ip_hmac:bytea?`, `user_agent_hmac:bytea?`.
- `preauth` berechtigt ausschließlich zu MFA-Einrichtung/-Prüfung und Abmeldung. `backoffice` erfordert gültige MFA; Session-Token selbst wird nicht gespeichert.

### `account_tokens` – S

- `user_id:uuid → users`, `purpose:text{activation|email_verify|password_reset|email_change}`, `token_hash:bytea U`, `target_email_original:text?`, `target_email_canonical:text?`, `expires_at:timestamptz`, `used_at:timestamptz?`, `revoked_at:timestamptz?`.
- Zieladresse ist nur bei E-Mail-Wechsel gesetzt. Verbrauch, Eindeutigkeitsprüfung und Kontowechsel erfolgen atomar. Ein Token wird nie im Klartext gespeichert.

### `consent_events` – E

- `user_id:uuid? → users`, `subscriber_id:uuid? → newsletter_subscribers`, `anonymous_subject_hmac:bytea?`, `purpose:text{newsletter|analytics|marketing_tracking|testimonial_publication|other}`, `action:text{grant|withdraw}`, `legal_document_version_id:uuid? → legal_document_versions`, `wording_snapshot:text`, `source:text`, `ip_hmac:bytea?`, `user_agent_hmac:bytea?`, `previous_event_id:uuid? → consent_events`.
- Mindestens ein Subjektbezug ist erforderlich; pro Zweck entscheidet das letzte gültige Ereignis. Nicht erforderliche Cookies und Tracking benötigen einen eigenen Zweck. Vertragsannahme und bloße Kenntnisnahme werden getrennt als `order_legal_acceptances` dokumentiert.

### `data_requests` – S

- `user_id:uuid? → users`, `contact_email:text?`, `type:text{access|export|deletion|correction}`, `status:text{open|identity_check|in_progress|completed|rejected}`, `identity_verified_at:timestamptz?`, `requested_at:timestamptz`, `processed_at:timestamptz?`, `processed_by:uuid? → users`, `reason_or_note:text?`, `next_action_at:timestamptz?`, `export_media_id:uuid? → media_assets`, `export_expires_at:timestamptz?`.
- Mindestens Nutzerbezug oder Kontaktadresse ist erforderlich. Identität vor Herausgabe/Löschung angemessen prüfen. Aufbewahrungspflichten und Beteiligung externer Anbieter werden als Vorgang dokumentiert.

### `audit_events` – E

- `actor_user_id:uuid? → users`, `origin:text{user|system|bootstrap|provider}`, `action:text`, `target_type:text`, `target_ref:text`, `before_safe:jsonb?`, `after_safe:jsonb?`, `reason_code:text?`, `request_id:uuid?`, `ip_hmac:bytea?`.
- Alle manuellen Rechte-, Kunden-, Zugangs-, Kurs-, Preis- und Rückerstattungsänderungen erzeugen ein Ereignis in derselben Transaktion. `before_safe`/`after_safe` enthalten nur notwendige, erlaubte Statuswerte bzw. IDs, keine Passwörter, Tokens, vollständigen Rechnungsadressen oder Provider-Payloads. System- und Sicherheitsereignisse sind ebenfalls erfassbar.

## 2.3 Medien, Kursstruktur und Verkaufskatalog

### `media_assets` – S

- `source:text{s3|video_provider}`, `storage_key:text?`, `video_external_id:text?`, `original_name:text`, `mime_detected:text`, `size_bytes:bigint`, `sha256:bytea?`, `visibility:text{private|public}`, `status:text{pending_scan|ready|quarantined|rejected|deleted}`, `uploaded_by:uuid? → users`.
- Je Quelle ist genau die passende Referenz gesetzt. `size_bytes ≥ 0`; Objektschlüssel sind zufällig und unveränderlich. Dateien sind erst nach Prüfung `ready`; private Assets werden nur nach Autorisierung ausgeliefert.

### `courses` – S

- `slug:text U`, `status:text{draft|published|deactivated|archived}`, `visibility:text{public|unlisted|private}`, `sort_order:integer=0`, `cloned_from_course_id:uuid? → courses`.
- Kursidentität bleibt bei Bearbeitung bestehen. Deaktivierung und Archivierung stoppen neue Verkäufe; Archivierung entfernt zusätzlich die öffentliche Sichtbarkeit. Beide entziehen weder bestehende Zugänge noch bereits zu bestätigende Käufe.

### `course_versions` – S

- `course_id:uuid → courses`, `version:integer`, `state:text{draft|published|retired}`, `title:text`, `subtitle:text?`, `description:jsonb`, `cover_media_id:uuid? → media_assets`, `duration_minutes:integer?`, `default_access_days:integer?`, `prerequisites_text:text?`, `learning_objectives:jsonb?`, `qualification_label:text?`, `certificate_template_version_id:uuid? → certificate_template_versions`, `auto_certificate_enabled:boolean=false`, `chapter_completion_mode:text{self_confirm|all_chapter_exams|self_or_all_chapter_exams}=self_confirm`.
- `expected_module_count:integer?`, `expected_chapter_count:integer?`, `expected_exams_per_chapter:integer?`, `content_schema_version:smallint`, `published_at:timestamptz?`, `published_by:uuid? → users`.
- `U(course_id, version)`, `U(id, course_id)` und partiell höchstens eine `published`-Version je Kurs. Zeit-/Anzahlwerte, sofern vorhanden, sind positiv. Bei aktivierter automatischer Zertifizierung ist vor der Kursveröffentlichung eine freigegebene Zertifikatsvorlage mit den erforderlichen Platzhaltern zu hinterlegen. `chapter_completion_mode` legt kursübergreifend als Datenregel fest, ob ein Kapitel selbst bestätigt, nach Bestehen aller zugehörigen Kapitelprüfungen oder durch beide Wege abgeschlossen wird; ohne vorhandene Prüfungen erfolgt kein automatischer Abschluss durch eine leere Prüfliste. Einmal veröffentlichte Inhalte werden nicht mehr verändert; `state` darf beim Ablösen auf `retired` wechseln. Bereits erworbene Versionen bleiben nutzbar. Eine Kopie ist ein neuer Entwurf mit neuen Kind-IDs.

### `course_regulatory_records` – S

- `course_version_id:uuid → course_versions`, `topic:text{fernusg_zfu|other}`, `jurisdiction:char(2)`, `status:text{not_checked|review_required|application_pending|approved|not_required_with_basis|rejected|expired}`, `decision_reference:text?`, `evidence_media_id:uuid? → media_assets`, `notes:text?`, `checked_by:uuid? → users`, `checked_at:timestamptz?`, `valid_until:date?`, `public_claim_authorized:boolean=false`.
- `U(course_version_id, topic, jurisdiction)`. Freigabe benötigt nachvollziehbare fachliche Prüfung und gegebenenfalls Beleg; eine bloße Checkbox erfindet keine Zulassung. Vor Verkauf ist der anwendbare Sachverhalt freigegeben.

### `course_prerequisites` – J

- `course_version_id:uuid → course_versions`, `required_course_id:uuid → courses`, `policy:text{informational|must_complete}`, `created_at:timestamptz`; `PK(course_version_id, required_course_id)`. Selbstabhängigkeiten und Zyklen werden transaktional verhindert.

### `course_staff` – J

- `course_id:uuid → courses`, `user_id:uuid → users`, `scope_role:text{manager|instructor}`, `assigned_by:uuid → users`, `created_at:timestamptz`; `PK(course_id, user_id, scope_role)`. Die Zuordnung allein verleiht keine globale Rolle.

### `course_modules` – S

- `course_version_id:uuid → course_versions`, `title:text`, `description:text?`, `position:integer`. `U(course_version_id, position)`, `U(id, course_version_id)`; `position ≥ 0`.

### `course_chapters` – S

- `course_version_id:uuid → course_versions`, `module_id:uuid`, `title:text`, `summary:text?`, `estimated_minutes:integer?`, `position:integer`.
- Zusammengesetzter FK `(module_id, course_version_id) → course_modules(id, course_version_id)`; `U(module_id, position)`, `U(id, course_version_id)`. Minuten positiv, Position nicht negativ.

### `chapter_contents` – S

- `course_version_id:uuid → course_versions`, `chapter_id:uuid`, `kind:text{text|video|image|file}`, `title:text?`, `body:jsonb?`, `media_asset_id:uuid? → media_assets`, `position:integer`.
- FK `(chapter_id, course_version_id) → course_chapters(id, course_version_id)`, `U(chapter_id, position)`. Typabhängiger Check: Text benötigt zulässigen Body; Medienblöcke benötigen ein passendes freigegebenes Asset. Die Reihenfolge ist versioniert.

### `course_completion_rules` – S

- `course_version_id:uuid U → course_versions`, `schema_version:smallint`, `conditions:jsonb`, `created_by:uuid → users`.
- Regelwerk enthält zunächst ausschließlich bekannte Bedingungen wie Pflichtkapitel und Pflichtprüfungen. IDs müssen derselben Kursversion angehören. Nach Veröffentlichung unveränderlich; keine frei ausführbaren Ausdrücke. Eine Mindestlerndauer wird erst nach gesondertem Entwurf für belastbare serverseitige Zeitnachweise zugelassen; die bloß vom Client gemeldete Zeit belegt keine tatsächliche Lernzeit.

### `products` – S

- `sku:text U`, `type:text{single|bundle}`, `title:text`, `variant_name:text?`, `description:text?`, `status:text{draft|active|inactive|archived}`, `sort_order:integer=0`.
- Ein `single`-Produkt enthält genau einen Kurs, ein `bundle` mindestens zwei verschiedene Kurse. Diese Mehrzeilenregel wird bei Aktivierung transaktional geprüft.

### `product_courses` – J

- `product_id:uuid → products`, `course_id:uuid → courses`, `access_days_override:integer?`, `position:integer`, `created_at:timestamptz`; `PK(product_id, course_id)`, `U(product_id, position)`. Override, falls gesetzt, ist positiv; sonst gilt die Kursversion.

### `tax_rates` – S (umgesetzt)

- `id:uuid PK`, `category:text`, `rate_bp:integer`, `label:text`, `note:text?`, `valid_from:timestamptz`, `valid_until:timestamptz?`, `is_default:boolean`, `created_by:uuid? → users`, `created_at`/`updated_at`.
- `rate_bp` sind ganzzahlige Basispunkte (`900` = 9 %, `1900` = 19 %); 10.000 und mehr sind unzulässig. Zeitbereich ist `[valid_from, valid_until)`, ein gesetztes Ende liegt nach dem Start. Die Exclusion-Constraint `tax_rates_no_overlap` (über `btree_gist`, `tstzrange(valid_from, COALESCE(valid_until,'infinity'), '[)')`) verbietet Überschneidungen je Kategorie; `U(category, valid_from)` ergänzt sie. Höchstens eine Zeile ist zugleich `is_default` (partieller Unique-Index `tax_rates_one_default`).
- **Sätze sind Daten, keine Konstanten.** Ein geänderter Satz ist eine neue Zeile ab einem Datum, das alte Zeitende wird auf den Tag davor gesetzt; Zeilen werden nie editiert oder gelöscht, weil alte Belege sie referenzieren. Seed: `standard` = 1.900 bp (Regelsteuersatz für Online-Training/digitale Kurse in Deutschland, ab 2020-01-01, `is_default`) und `reduced` = 700 bp als vorhandene, **nicht** vorgewählte Zeile. Sonderfälle und Befreiungen bleiben offen und sind als Datenzeile anzulegen, nicht zu erfinden.
- Fehlt für eine Kategorie ein zum Bestellzeitpunkt gültiger Satz, bricht der Verkauf mit `TAX_RATE_MISSING` ab; es wird **nie** stillschweigend 0 % angenommen.

### `prices` – S

- `product_id:uuid → products`, `currency:char(3)`, `model:text{one_time}`, `gross_cents:bigint`, `sale_gross_cents:bigint?`, `sale_starts_at:timestamptz?`, `sale_ends_at:timestamptz?`, `tax_category:text`, `valid_from:timestamptz`, `valid_until:timestamptz?`, `status:text{draft|active|retired}`.
- `U(id, product_id)` für zusammengesetzte Fremdschlüssel. Beträge nicht negativ; `valid_until`, falls gesetzt, liegt nach `valid_from`. Aktionsbetrag, Aktionsbeginn und Aktionsende sind entweder alle leer oder alle gesetzt; der Betrag liegt höchstens beim Normalbetrag und der Aktionszeitraum ist nicht leer und liegt innerhalb der Preisgültigkeit. Pro Produkt/Währung keine überlappenden aktiven Zeitbereiche. Für den anfänglichen Online-Kauf muss der nach Rabatt zu zahlende Betrag positiv und beim Provider zulässig sein. Abonnements/Raten sind als spätere Preis- und Vertragsmodelle zu entwerfen, nicht als schon implementiert auszugeben.

## 2.4 Warenkorb, Bestellung, Zahlung und Zugang

### `carts` – S

- `user_id:uuid? → users`, `session_secret_hash:bytea U`, `status:text{open|converted|abandoned}`, `currency:char(3)`, `expires_at:timestamptz`.
- Ein Gast erhält ein zufälliges, gehasht gespeichertes Warenkorbgeheimnis. Auch angemeldete Nutzer dürfen nur auf den eigenen oder ausdrücklich übernommenen Warenkorb zugreifen.

### `cart_items` – J

- `cart_id:uuid → carts`, `product_id:uuid → products`, `price_id:uuid`, `quantity:smallint=1`, `added_at:timestamptz`; `PK(cart_id, product_id)`.
- FK `(price_id, product_id) → prices(id, product_id)`; zunächst `quantity = 1`. Der Preis wird beim Bestellen serverseitig neu ermittelt, nicht aus dem Browser übernommen.

### `checkout_email_verifications` – S

- `cart_id:uuid → carts`, `email_original:text`, `email_canonical:text`, `token_hash:bytea U`, `expires_at:timestamptz`, `token_used_at:timestamptz?`, `verified_at:timestamptz?`, `consumed_at:timestamptz?`.
- Der Nachweis ist an diesen Warenkorb gebunden. Linkverbrauch und Nachweisbestätigung sind atomar; die Bestellung verbraucht anschließend den Nachweis genau einmal. Er muss bei Bestellanlage gültig sein; die spätere Zahlungsbestätigung darf auch nach seinem Ablauf eintreffen. Ein angemeldeter Nutzer mit verifizierter Kontoadresse benötigt keine separate Gastprüfung. Ein Gastnachweis erzeugt keine Sitzung für ein bestehendes Konto.

### `coupons` – S

- `code_original:text`, `code_canonical:text U`, `type:text{percent|fixed}`, `value:bigint`, `currency:char(3)?`, `valid_from:timestamptz`, `valid_until:timestamptz?`, `max_redemptions:integer?`, `max_per_identity:integer=1`, `scope:text{all|selected_products|selected_courses}`, `active:boolean=false`.
- `code_canonical` entsteht durch Trimmen und ASCII-Großschreibung; zulässig sind 4–64 Zeichen aus Buchstaben, Ziffern, Bindestrich und Unterstrich. Prozentwerte liegen in Basispunkten zwischen 1 und 10.000 und haben keine feste Währung; feste Werte sind positive kleinste Währungseinheiten und benötigen eine Währung. Ein gesetztes Gültigkeitsende liegt nach dem Beginn. Maximalzahlen sind, falls gesetzt, positiv. Ein Gutschein mit rechnerisch 100 % Rabatt kann verwaltet werden, ist im automatischen Bezahl-Checkout aber nicht einlösbar, solange ein positiver Zahlbetrag vorgeschrieben ist.

### `coupon_products` – J

- `coupon_id:uuid → coupons`, `product_id:uuid → products`, `created_at:timestamptz`; `PK(coupon_id, product_id)`. Bei `scope=selected_products` muss mindestens ein Produkt zugeordnet sein.

### `coupon_courses` – J

- `coupon_id:uuid → coupons`, `course_id:uuid → courses`, `created_at:timestamptz`; `PK(coupon_id, course_id)`. Bei `scope=selected_courses` muss mindestens ein Kurs zugeordnet sein. Ein kursgebundener Gutschein gilt zunächst für Einzelprodukte mit diesem Kurs; Pakete sind davon ausgenommen und können stattdessen ausdrücklich über `selected_products` rabattiert werden.

### `orders` – S

- `order_number:text U`, `origin:text{checkout}`, `cart_id:uuid? U → carts`, `user_id:uuid? → users`, `buyer_email_original:text`, `buyer_email_canonical:text`, `email_source:text{authenticated_account|guest_verified}`, `checkout_email_verification_id:uuid? U → checkout_email_verifications`, `buyer_email_verified_at:timestamptz`, `currency:char(3)`, `payment_state:text{awaiting|paid|failed|cancelled|review}`, `fulfillment_state:text{not_ready|waiting|fulfilled|blocked}`, `successful_payment_attempt_id:uuid?`.
- `subtotal_gross_cents:bigint`, `discount_cents:bigint`, `total_gross_cents:bigint`, `tax_cents:bigint`, `billing_snapshot:jsonb`, `guest_participant_first_name:text?`, `guest_participant_last_name:text?`, `guest_names_purged_at:timestamptz?`, `checkout_idempotency_key:text?`, `placed_at:timestamptz`, `paid_at:timestamptz?`, `release_at:timestamptz?`, `fulfilled_at:timestamptz?`.
- Für den zunächst einzigen Ursprung `checkout` sind `cart_id` und `checkout_idempotency_key` verpflichtend. Spätere Vertragstypen können ohne künstlichen Warenkorb ergänzt werden. Alle Beträge sind nicht negativ; `total_gross_cents = subtotal_gross_cents − discount_cents`, `tax_cents ≤ total_gross_cents`. Gesamtsteuer ist die Summe der gerundeten Positionssteuern. Die Rechnung enthält die zum Bestellzeitpunkt gültige Rechnungsadresse als validierten Snapshot. `user_id` darf bis zur erfolgreichen, verifizierten Zahlungsabwicklung fehlen. Bei `guest_verified` muss der verwendete Nachweis zum Warenkorb und zur Käuferadresse passen; bei `authenticated_account` ist er leer und das Nutzerkonto bereits zugeordnet. Ein zum Bestellzeitpunkt bereits ermitteltes Konto bleibt auch bei späterem E-Mail-Wechsel zugeordnet.
- Bei jeder Gastbestellung werden unabhängig von einer möglichen bestehenden Konto-Zuordnung beide `guest_participant_*_name` nach der verbindlichen Namensprüfung erfasst und getrennt vom `billing_snapshot` für den späteren Kontoprozess gespeichert. Die Felder sind bei `authenticated_account` samt `guest_names_purged_at` `NULL`. Die DB verlangt bei `guest_verified` entweder zwei gültige Namen und `guest_names_purged_at IS NULL` oder nach datenschutzgerechter Entfernung zwei `NULL`-Namen und einen gesetzten Entfernungszeitpunkt. Reguläre APIs dürfen den Entfernungszeitpunkt nicht setzen; die Laufzeitrolle darf die gespeicherten Gastnamen nicht nachträglich ändern. Nur ein gesondert autorisierter Datenschutzprozess entfernt sie nach Prüfung ihrer weiteren Erforderlichkeit atomar und protokolliert; gespeicherte Rechnungssnapshots folgen ihren eigenen Aufbewahrungsregeln. Fehlen die Gastnamen ausnahmsweise nach dieser Entfernung bei einer später doch erforderlichen Kontoanlage, wird eine bestätigte Zahlung nicht rückgängig gemacht, aber die Kontoanlage zur Klärung blockiert; keine Platzhalternamen verwenden.
- Zusammengesetzter FK `(successful_payment_attempt_id, id) → payment_attempts(id, order_id)` wird wegen des zyklischen Bezugs erst nach Anlage beider Tabellen erstellt. `payment_state=paid` erfordert `paid_at`, den erfolgreichen zugehörigen Versuch, passende Summe/Währung und einen gültigen `payment_confirmation_evidence`-Nachweis; dies wird transaktional und per deferrierbarer Datenbankprüfung abgesichert. Rückerstattungs- und Streitstatus werden aus `refunds`/`disputes` abgeleitet, nicht aus einer widersprüchlichen zweiten Zahlungswahrheit.

### `order_items` – S

- `order_id:uuid → orders`, `product_id:uuid → products`, `price_id:uuid`, `position:integer`, `title_snapshot:text`, `variant_snapshot:text?`, `quantity:smallint=1`, `unit_gross_cents:bigint`, `discount_cents:bigint`, `total_gross_cents:bigint`, `tax_rate_bp:integer`, `tax_cents:bigint`, `net_cents:bigint`, `tax_country:char(2)`, `tax_basis_snapshot:text?`.
- FK `(price_id, product_id) → prices(id, product_id)`; `U(order_id, position)`. `quantity=1`; `total_gross_cents = unit_gross_cents − discount_cents`, `net_cents + tax_cents = total_gross_cents`. Bestellte Beträge und Bezeichnungen sind unveränderlich.

### `order_item_courses` – S

- `order_item_id:uuid → order_items`, `course_id:uuid → courses`, `course_version_id:uuid`, `access_days:integer?`, `course_title_snapshot:text`.
- FK `(course_version_id, course_id) → course_versions(id, course_id)`, `U(order_item_id, course_id)`. Bei Bestellabschluss wird der vollständige Produkt-/Paketinhalt samt gekaufter Version und effektiver Zugangsdauer eingefroren. `NULL` bedeutet unbegrenzt.

### `order_legal_acceptances` – E

- `order_id:uuid → orders`, `legal_document_version_id:uuid? → legal_document_versions`, `kind:text{terms_accepted|privacy_notice_seen|withdrawal_notice_seen|request_early_start|acknowledge_withdrawal_rule}`, `wording_snapshot:text`, `affirmed:boolean`, `ip_hmac:bytea?`, `user_agent_hmac:bytea?`.
- Tatsächlich angezeigten Wortlaut, Versionsbezug und konkrete Handlung dokumentieren. Kenntnisnahme ist keine Datenschutz-Einwilligung; Wunsch nach vorzeitigem Beginn und Kenntnis einer rechtlich geprüften Folge sind getrennt. Keine pauschale Annahme, dass das Widerrufsrecht beim Kauf erlischt.

### `coupon_reservations` – S

- `coupon_id:uuid → coupons`, `order_id:uuid U → orders`, `user_id:uuid? → users`, `identity_hmac:bytea`, `identity_hmac_key_id:text`, `status:text{reserved|redeemed|released}`, `reserved_until:timestamptz?`, `redeemed_at:timestamptz?`, `released_at:timestamptz?`.
- Zunächst ist höchstens ein Coupon je Bestellung zulässig. Ein Limit wird unter Sperre des Gutscheins anhand eingelöster **und** noch wirksam reservierter Nutzungen geprüft; pro Person zählen bekanntes Nutzerkonto und verifizierter E-Mail-HMAC. Nachträgliche Konto-Zuordnung wird nachgetragen. Der HMAC ist zweckgebunden und hat eine Schlüssel-ID; bei Rotation werden für noch wirksame Limits alle dafür benötigten alten Schlüssel kontrolliert weiterverwendet oder die Nachweise nachvollziehbar umgestellt. Ein und dieselbe Person mit unabhängig neu verifizierter Adresse ohne Konto kann technisch nicht sicher erkannt werden. Bei verzögerter Zahlung bleibt die Reservierung bestehen, bis ein endgültiger Providerzustand geklärt ist. Überfällige Reservierungen werden überwacht; Einzelheiten und späte Zahlungsereignisse siehe [03](03-ablaeufe-und-api.md#33-warenkorb-gutschein-und-bestellung).

### `idempotency_requests` – S

- `scope:text`, `actor_hmac:bytea`, `key:text`, `request_hash:bytea`, `status:text{processing|completed}`, `resource_type:text?`, `resource_id:uuid?`, `response_status:smallint?`, `response_body_safe:jsonb?`, `expires_at:timestamptz`; `U(scope, actor_hmac, key)`.
- Für ausdrücklich idempotente API-Aktionen wird die normalisierte Nutzlast gehasht und nach erneuter Autorisierungsprüfung die ungefährliche ursprüngliche Antwort reproduziert. Derselbe Schlüssel mit anderer Nutzlast ergibt `409`. Keine Sitzungscookies, Tokens oder Geheimnisse speichern. Technische Einträge werden nach mindestens 24 Stunden entfernt; dauerhafte fachliche Uniques und Provider-Schlüssel schützen auch danach vor doppelten Geschäftseffekten.

### `payment_attempts` – S

- `order_id:uuid → orders`, `provider:text{stripe|paypal}`, `provider_account_id:text`, `environment:text{test|live}`, `provider_session_id:text?`, `provider_payment_id:text?`, `provider_idempotency_key:text U`, `status:text{created|pending|requires_action|processing|succeeded|failed|cancelled|review}`.
- `amount_cents:bigint`, `currency:char(3)`, `confirmed_at:timestamptz?`, `failure_code:text?`. Betrag positiv. `U(id, order_id)` und `U(id, provider, provider_account_id, environment)` ermöglichen konsistente zusammengesetzte Fremdschlüssel. Partielle Unique-Indizes auf `(provider, provider_account_id, environment, provider_session_id)` bzw. `provider_payment_id`, jeweils bei gesetzter ID, und höchstens ein Versuch pro Bestellung mit Status `created`, `pending`, `requires_action`, `processing` oder `review`. Ein neuer Versuch darf nur bei bestellseitig `awaiting` und nach geklärtem endgültigem Zustand des vorherigen Versuchs begonnen werden. Ein Status `succeeded` erfordert transaktional einen passenden kanonischen `payment_confirmation_evidence`. Ein zweiter tatsächlich erfolgreicher Versuch wird gesondert markiert und operativ bearbeitet, nicht doppelt erfüllt.

### `payment_events` – E

- `provider:text{stripe|paypal}`, `provider_account_id:text`, `environment:text{test|live}`, `provider_event_id:text`, `event_type:text`, `provider_occurred_at:timestamptz?`, `signature_verified_at:timestamptz`, `minimal_payload:jsonb`.
- `U(provider, provider_account_id, environment, provider_event_id)`. Nur signaturgeprüfte Ereignisse werden hier aufgenommen; ungültige Anfragen erzeugen allenfalls ein datensparsames Sicherheitsereignis. Der Eingang ist fachlich unveränderlich.

### `payment_confirmation_evidence` – E

- `payment_attempt_id:uuid U → payment_attempts`, `source:text{webhook}`, `payment_event_id:uuid → payment_events`, `provider_payment_id:text`, `provider_request_id:text?`, `provider_status:text{succeeded}`, `amount_cents:bigint`, `currency:char(3)`, `verified_at:timestamptz`, `minimal_response:jsonb`.
- Der kanonische Erfolgsnachweis benötigt **immer** ein zugeordnetes, bei Eingang signaturgeprüftes Zahlungs-Erfolgsereignis und wird in derselben Transaktion wie der erfolgreiche Zahlungsversuch gespeichert. DB-Constraints und ein geprüfter, deferrierbarer Trigger erzwingen den nicht leeren Ereignisbezug sowie die Zusammengehörigkeit von Providerkonto, Modus, Zahlungsobjekt, erlaubtem Erfolgsereignistyp, tatsächlich bestätigtem Betrag und Währung mit Zahlungsversuch und Bestellung. Die hierfür benötigten Ereignisfakten einschließlich des ursprünglichen Erfolgsstatus sind unveränderlich in `payment_events` zu halten. Die Signatur selbst prüft der Provider-Webhook-Handler beim Eingang; nur dieser kontrollierte Eingang darf geprüfte Ereignisse anlegen. Ein bloßer authentisierter Providerabgleich, eine Rückleitungsseite oder ein Nicht-Erfolgsereignis darf keinen Erfolgsnachweis erzeugen; der Providerabgleich liefert nur zusätzliche Prüf- und Klärungsdaten. Weitere oder wiederholte Erfolgsmeldungen bleiben in `payment_events`, erzeugen aber keinen zweiten kanonischen Nachweis.

### `payment_event_payloads` – J

- `payment_event_id:uuid PK → payment_events`, `raw_payload_ciphertext:bytea`, `payload_key_id:text`, `delete_after:timestamptz`, `created_at:timestamptz`. Optionaler, getrennt verschlüsselter Original-Payload. Der Aufbewahrungsprozess darf diese Zeile nach Frist löschen, ohne das Ereignis zu ändern.

### `payment_event_processing` – S

- `payment_event_id:uuid U → payment_events`, `status:text{received|processing|processed|ignored|failed}`, `attempts:integer=0`, `lease_until:timestamptz?`, `processed_at:timestamptz?`, `last_error_safe:text?`.
- Veränderlicher Verarbeitungsstand; wird getrennt vom unveränderlichen Eingang geführt. Offene und fehlgeschlagene Ereignisse sind erneut bearbeitbar.

### `payment_event_attempts` – E

- `processing_id:uuid → payment_event_processing`, `attempt_no:integer`, `result:text{processed|ignored|failed}`, `started_at:timestamptz`, `finished_at:timestamptz`, `error_safe:text?`; `U(processing_id, attempt_no)`.

### `refunds` – S

- `payment_attempt_id:uuid`, `order_id:uuid → orders`, `provider:text{stripe|paypal}`, `provider_account_id:text`, `environment:text{test|live}`, `provider_refund_id:text?`, `provider_idempotency_key:text U`, `amount_cents:bigint`, `status:text{requested|pending|succeeded|failed|cancelled}`, `reason_code:text`, `requested_by:uuid? → users`, `requested_at:timestamptz`, `confirmed_at:timestamptz?`, `last_error_safe:text?`.
- FK `(payment_attempt_id, order_id) → payment_attempts(id, order_id)` und `(payment_attempt_id, provider, provider_account_id, environment) → payment_attempts(id, provider, provider_account_id, environment)`; `U(id, order_id)` und partiell `U(provider, provider_account_id, environment, provider_refund_id)` bei gesetzter Provider-ID. Positive Beträge in der Währung des Zahlungsversuchs; die Summe erfolgreicher und gleichzeitig laufender Erstattungen darf den bestätigten Zahlbetrag unter Sperre nicht überschreiten. Providerabweichungen führen zu Prüfung statt stiller Korrektur.

### `refund_allocations` – J

- `refund_id:uuid`, `order_id:uuid → orders`, `order_item_id:uuid`, `gross_cents:bigint`, `net_cents:bigint`, `tax_cents:bigint`, `created_at:timestamptz`; `PK(refund_id, order_item_id)`.
- FK `(refund_id, order_id) → refunds(id, order_id)` und `(order_item_id, order_id) → order_items(id, order_id)`; dazu `U(id, order_id)` auf `order_items`. Beträge nicht negativ, `gross_cents = net_cents + tax_cents`; bei bestätigter/freigegebener Aufteilung ergeben die Zuordnungen insgesamt den Erstattungsbetrag und überschreiten unter Sperre nicht die noch erstattbaren Positionsbeträge. Bei extern ausgelöster Erstattung ohne Zuordnung wird der Korrekturbeleg erst nach fachlicher Klärung erzeugt.

### `disputes` – S (umgesetzt)

- `order_id:uuid → orders`, `payment_attempt_id:uuid`, `provider:text{stripe|invoice}`, `environment:text{test|live}`, `provider_dispute_id:text`, `amount_cents:bigint`, `currency:char(3)`, `status:text{warning|open|won|lost|closed}`, `reason_code:text?`, `opened_at:timestamptz`, `resolved_at:timestamptz?`.
- FK `(payment_attempt_id, order_id) → payment_attempts(id, order_id)`; `U(provider, environment, provider_dispute_id)` macht das wiederholte Zustellen desselben Anbieterfalls zu einem Update statt zu einer zweiten Zeile. `resolved_at` ist genau bei `won|lost|closed` gesetzt. Ein offener Index trägt die Prüfliste.
- Ein **laufender** Fall (`warning`/`open`) verhindert die Freischaltung: `fulfilPaidOrder` parkt die bezahlte Bestellung als `blocked`, statt Zugang zu vergeben — das Geld ist da, die Frage offen. Gewinnt der Fall, wird der Auftrag freigegeben; verliert er, bleibt er blockiert und die Bestellung geht auf `charged_back`.
- Ein Streitfall ist **keine** Erstattung: er erzeugt keine Gutschrift und keine `refund`-Zeile. Trigger `trainerb_check_dispute_amount` verweigert Fälle über dem bestätigten Zahlbetrag (`DISPUTE_EXCEEDS_PAYMENT`). Ein `lost`-Fall setzt `orders.payment_state='charged_back'` und `charged_back_at`, senkt `refundable_cents` und ist unumkehrbar; ein späterer `won` (erfolgreicher Widerspruch) stellt `paid` nur wieder her, wenn kein anderer `lost`-Fall die Lücke erklärt. Trigger `trainerb_check_refund_amount` rechnet `lost`-Fälle gegen den erstattbaren Betrag, sodass dasselbe Geld nicht zweimal das Konto verlässt. Eine zurückgebuchte Bestellung lässt sich nicht stornieren (`ORDER_CHARGED_BACK`).

### `withdrawal_requests` – S (umgesetzt)

- `submitted_order_number:text?`, `contact_email:text`, `contact_email_hmac:bytea`, `customer_name:text?`, `message:text?`, `status:text{received|identity_check|in_progress|completed|rejected}`, `submitted_at:timestamptz`, `order_id:uuid? → orders`, `identity_verified_at:timestamptz?`, `processed_by:uuid? → users`, `processed_at:timestamptz?`, `decision_reason:text?`, `refund_id:uuid? → refunds`, `confirmation_outbox_id:uuid? → email_outbox`.
- Die eingegebene Bestellnummer ist bewusst **kein** FK: sie ist unbestätigte Angabe einer fremden Person. Prüfbedingungen halten fest, dass ein offener Vorgang weder Bearbeiter noch Entscheidung hat, ein abgeschlossener beides samt Grund, und dass eine Erstattung nur an einem angenommenen Vorgang hängt.
- `withdrawal_verifications` speichert nur einen Schlüssel-Hash des Einmal-Links, mit Ablauf, Versuchszähler und genau einem offenen Nachweis pro Vorgang. Der Link bestätigt die **Adresse**, nicht die Bestellung; erst danach darf Personal eine Bestellung zuordnen, und nur wenn deren Käuferadresse zur bestätigten Adresse passt (`WITHDRAWAL_ORDER_MISMATCH`).
- Der Vorgang löst **keine** automatische Rückerstattung aus; ein angenommener Widerruf bleibt ohne `refund_id`, bis jemand mit `refunds.manage` die Erstattung separat bucht.
- `decision_reason` ist ein geschlossener Katalog (`withdrawal_requests_decision_reason_codes`): `withdrawal_accepted`, `withdrawal_declined`, `order_not_found`, `outside_statutory_period`, `digital_content_started`, `duplicate_request`, `identity_unconfirmed`. Freitext wäre eine Falle — jeder Filter würde Vorgänge mit abweichender Schreibweise stillschweigend übersehen.
- Annehmen verlangt die Bestellung (`withdrawal_requests_completed_needs_order`); Ablehnen darf ohne sie schließen, aber nur mit einem Grund, der das erklärt (Trigger `trainerb_check_withdrawal_close`, `WITHDRAWAL_CLOSE_REASON`). So bleibt der Eingang keine unendliche Warteschlange.

### `number_counters` – J

- `kind:text{order|invoice_document|certificate}`, `year:integer`, `last_value:bigint`, `updated_at:timestamptz`; `PK(kind, year)`. `last_value ≥ 0`.
- Vergabe unter Zeilensperre in derselben Transaktion wie der erzeugte Beleg. Rechnungen und Gutschriften teilen den Rechnungsdokument-Nummernkreis. Stornierte oder fehlerhafte Dokumente bleiben nachvollziehbar; absolute Lückenlosigkeit über externe Ausfälle wird nicht zugesichert.

### `invoice_documents` – S

- `order_id:uuid → orders`, `type:text{invoice|credit_note|cancellation}`, `document_number:text U`, `issued_at:timestamptz`, `original_invoice_id:uuid? → invoice_documents`, `refund_id:uuid? → refunds`, `currency:char(3)`, `gross_cents:bigint`, `net_cents:bigint`, `tax_cents:bigint`, `issuer_snapshot:jsonb`, `buyer_snapshot:jsonb`, `pdf_media_id:uuid? → media_assets`, `document_status:text{pending_pdf|issued|void}`.
- Währung muss der Bestellwährung entsprechen. Beträge sind positive bzw. null absolute Werte; der Dokumenttyp bestimmt die buchhalterische Richtung. `gross_cents = net_cents + tax_cents`. Ein Rechnungsoriginal pro Bestellung, partielle Unique-Indizes für das Original und für dokumentierte Erstattungen. Korrekturdokumente benötigen `original_invoice_id`; ihre rechtlich korrekte Bezeichnung, Steuerwirkung und Aufbewahrung sind fachlich freizugeben. Inhaltliche Belegdaten nach Vergabe nicht überschreiben; PDF-Erzeugungsstatus darf nachgeführt werden.

### `invoice_lines` – E

- `invoice_document_id:uuid → invoice_documents`, `order_item_id:uuid? → order_items`, `position:integer`, `description_snapshot:text`, `quantity:smallint`, `tax_rate_bp:integer`, `net_cents:bigint`, `tax_cents:bigint`, `gross_cents:bigint`; `U(invoice_document_id, position)`. Positionssumme und Steueraufteilung müssen zum Dokument passen.

### `enrollments` – S

- `user_id:uuid → users`, `course_id:uuid → courses`, `course_version_id:uuid`, `learning_state:text{not_started|in_progress|completed|closed}`, `started_at:timestamptz?`, `last_activity_at:timestamptz?`.
- FK `(course_version_id, course_id) → course_versions(id, course_id)`, `U(user_id, course_version_id)`, `U(id, course_version_id)`. Ein Lernstand pro Nutzer und Kursversion; verschiedene Versionen desselben Kurses können historisch nebeneinander bestehen. Zugang wird nicht aus `learning_state`, sondern aus `access_grants` ermittelt.

### `access_grants` – S

- `enrollment_id:uuid → enrollments`, `source:text{purchase|manual}`, `order_item_course_id:uuid? U → order_item_courses`, `granted_by:uuid? → users`, `status:text{active|suspended|revoked}`, `starts_at:timestamptz`, `expires_at:timestamptz?`, `reason:text?`.
- Bei `purchase` ist `order_item_course_id` gesetzt und `granted_by` leer; bei `manual` ist die Kaufquelle leer sowie ein berechtigter `granted_by` und ein Grund gesetzt. Kaufquelle muss zum Käufer und zur Kursversion der Einschreibung passen. `expires_at`, sofern gesetzt, liegt nach `starts_at`. Zugriff besteht, wenn **mindestens eine** Quelle aktiv ist und der Zeitpunkt im Intervall `[starts_at, expires_at)` liegt. Ablauf ist damit auch ohne pünktlichen Cron-Job wirksam.

### `access_grant_events` – E

- `access_grant_id:uuid → access_grants`, `kind:text{created|suspended|resumed|expiry_changed|revoked|kept_after_refund|kept_after_dispute}`, `actor_user_id:uuid? → users`, `refund_id:uuid? → refunds`, `dispute_id:uuid? → disputes`, `reason:text?`, `idempotency_key:text U`.
- Jede ausdrückliche Entscheidung einschließlich Beibehaltung wird mit passender Erstattungs-/Streitfallreferenz und Akteur festgehalten; eine fehlende Entscheidung ist offen und wird überwacht. Änderungen und Entscheidungen sind zusätzlich im Audit protokolliert. Rückerstattung und Widerruf einer Berechtigung sind getrennte Vorgänge; andere weiterhin gültige Quellen bleiben wirksam.

### Umsetzungsstand Erstattungen (Migration `202611150008_phase4_refunds`)

- **`refunds`** – `order_id`, `payment_attempt_id`, `provider{invoice|stripe}`, `environment{test|live}`, `provider_refund_id?`, `provider_idempotency_key U`, `amount_cents > 0`, `currency='EUR'`, `status{requested|pending|succeeded|failed|cancelled}`, `reason_code`, `note?`, `requested_by`, `requested_at`, `confirmed_at?`, `last_error_safe?`.
  - FK `(payment_attempt_id, order_id) → payment_attempts(id, order_id)`: eine Erstattung kann nur über eine Zahlung **derselben** Bestellung laufen.
  - Partiell `U(provider, environment, provider_refund_id)`: eine Anbieter-Erstattung wird je Anbieterkonto nur einmal verbucht.
  - `refund_confirmation_metadata` (bestätigt ⇔ `confirmed_at`), `refund_provider_reference` (Stripe braucht bei `succeeded` eine `provider_refund_id`).
  - Trigger `refunds_amount_guard` (`REFUND_EXCEEDS_PAYMENT`): die Summe aus `requested`, `pending` und `succeeded` überschreitet den bestätigten Zahlbetrag nicht; `failed`/`cancelled` geben Kapazität frei, weil kein Geld floss. Die Sperre läuft unter `FOR UPDATE` auf `orders`, die Prüfung im Trigger noch einmal.
- **`refund_allocations`** – `refund_id`, `order_id`, `order_item_product`, `gross_cents > 0`, `net_cents`, `tax_cents`; `PK(refund_id, order_item_product)`, FK `(order_item_product, order_id) → order_items(product_id, order_id)`.
  - `gross_cents = net_cents + tax_cents` **oder** (`net_cents = tax_cents = 0`) = „Aufteilung noch nicht vorgenommen“. Die Aufteilung stammt aus der Position, sie wird für eine Teilerstattung mit demselben Satz aus dem zugeordneten Betrag neu bestimmt und in der Gutschrift eingefroren.
- **`order_access_decisions`** – `order_id`, `refund_id?`, `access_id?`, `decision{revoked|kept|suspended}`, `reason`, `decided_by`, `decided_at`. „Behalten“ ist eine Entscheidung wie jede andere; `refund_id` oder `access_id` muss gesetzt sein.
- **`credit_notes`** – `order_id`, `refund_id U` (genau eine Gutschrift je Erstattung), `original_invoice_id`, `document_number U` aus `trainerb_next_document_number` (Format `TB-GS-JJJJ-NNNNNN`), Snapshots (Aussteller, Käufer, Positionen), `total_gross_cents > 0`, `reason_code`, `note?`, `recipient_email?`. Seit Migration `202611210042_document_compliance` zusätzlich `service_date`/`service_end_date` (Leistungszeitpunkt bzw. -zeitraum der korrigierten Rechnung), `content_hash` und `previous_hash` (32-Byte-SHA-256, Kette je Belegart). Trigger `credit_notes_immutable` lehnt `UPDATE`/`DELETE` ab; einzige Ausnahme ist das einmalige Setzen der beiden Hash-Spalten von `NULL` auf einen Wert bei Altbelegen.
- **`invoices`** – `seller_snapshot` enthält seit derselben Migration auch `tax_number` (§ 14 Abs. 4 Nr. 2 UStG) und `small_business` (§ 19 UStG); `service_date`/`service_end_date`, `content_hash`, `previous_hash` wie bei `credit_notes`, gleicher Trigger (`invoices_immutable`).
- **`document_number_counters`** – `kind{invoice|credit_note}`, `year`, `last_value > 0`, `PK(kind, year)`. Ein Zähler je Belegart und Kalenderjahr; das Jahr stammt aus dem Ausstellungszeitpunkt in `Europe/Berlin`. Die Funktion `trainerb_next_document_number(prefix, document_kind, at)` zählt per `ON CONFLICT ... DO UPDATE` hoch und serialisiert damit gleichzeitige Ausstellungen. Bestehende Nummern bleiben gültig; die Zähler starten hinter der höchsten vergebenen Nummer des jeweiligen Jahres.
- **`orders`** – neu `refunded_at`; **vorbereitet, aber noch ohne Erzeuger:** `reminder_sent_at` samt partiellem Index `orders_overdue` (fällige, unbezahlte Überweisungsbestellungen ohne Erinnerung). Die Spalte ist für eine einmalige Zahlungserinnerung vorgesehen und wird von keinem Prozess gesetzt; es gibt derzeit **keine** Erinnerungsmail, und ein überfälliges Zahlungsziel löst von sich aus nichts aus. `payment_state` kennt zusätzlich `refunded`. `orders_refunded_metadata` verlangt `refunded ⇔ refunded_at ∧ paid_at`; `orders_paid_via_check` behandelt `refunded` wie `paid`, damit der Zahlnachweis sichtbar bleibt. Der Storno-Trigger greift für erstattete Bestellungen nicht: Erstattung ist kein Storno und gibt keine Gutscheine frei.
- **`course_access`** – neu `suspended_at`/`suspend_reason` (`course_access_suspend_metadata`). Trigger `course_access_revocation_guard` (`ACCESS_DECISION_REQUIRED`, `ACCESS_REVOKE_REASON_REQUIRED`, `ACCESS_SUSPEND_REASON_REQUIRED`) gilt nur für `source='order'`: gekaufte Zugänge lassen sich ohne dokumentierte Entscheidung weder entziehen noch sperren.
- **API** – Sperrung wirkt in der Lernplattform als `403 ACCESS_SUSPENDED` (nicht als „nicht gefunden“): der Kauf ist bekannt, der Zugang nur vorläufig gestoppt.

## 2.5 Lernfortschritt und Prüfungen

> **Umsetzungsstand (Migration `202611150006_phase3_commerce`):** Angelegt sind `commerce_settings`, `carts`, `cart_items`, `legal_documents`, `legal_document_versions`, `orders`, `order_items`, `order_item_courses`, `order_acceptances`, `coupons`, `coupon_reservations`, `payment_attempts`, `invoices`, `course_access` und `chapter_progress`. Prüfungen, Fragen, Versuche und Zertifikate fehlen weiterhin; `chapter_progress` speichert vorerst nur den Abschlusszeitpunkt je Zugang und Kapitel (eindeutig über `access_id, chapter_id`, Fremdschlüssel auf die Zugangsversion, damit ein Kapitel nur in der freigeschalteten Version abgeschlossen werden kann).

### `chapter_progress` – S

- `enrollment_id:uuid`, `course_version_id:uuid → course_versions`, `chapter_id:uuid`, `status:text{not_started|in_progress|completed}`, `last_position:jsonb?`, `time_spent_seconds:bigint=0`, `revision:integer=0`, `started_at:timestamptz?`, `completed_at:timestamptz?`.
- FK `(enrollment_id, course_version_id) → enrollments(id, course_version_id)` und `(chapter_id, course_version_id) → course_chapters(id, course_version_id)`; `U(enrollment_id, chapter_id)`. Zeit und Revision nicht negativ. Aktualisierung nutzt eine Revisionsprüfung; ein bereits abgeschlossener Status wird durch spätere Positionsmeldungen nicht zurückgesetzt. Die Fortschrittsquote wird serverseitig aus Pflichtbestandteilen berechnet und ist keine vom Browser gesetzte Wahrheit.

### `exams` – S

- `course_version_id:uuid → course_versions`, `anchor_type:text{course|module|chapter}`, `module_id:uuid?`, `chapter_id:uuid?`, `title:text`, `exam_type:text{single_choice_quiz}`, `question_count:smallint`, `option_count:smallint`, `pass_rule_schema_version:smallint`, `pass_rule:jsonb`, `max_attempts:integer?`, `required_for_completion:boolean=true`, `show_solutions_after_pass:boolean=true`, `position:integer`.
- FK `(module_id, course_version_id) → course_modules(id, course_version_id)` und `(chapter_id, course_version_id) → course_chapters(id, course_version_id)`; `U(id, course_version_id)`. Der Ankertyp bestimmt exakt, welches optionale Feld gesetzt ist. `question_count > 0`, `option_count ≥ 2`; Versuchslimit positiv, falls gesetzt. Die geprüfte Regel erlaubt zunächst absolute oder prozentuale Mindestpunktzahl innerhalb der Frageanzahl. Eindeutige Position je Anker. Prüfungsart und versionierte Evaluator-Schnittstelle erlauben spätere Erweiterungen; andere Antwortformen benötigen einen gesonderten Evaluator und ergänzende Migrationen und sind nicht bereits implementiert.

### `question_pools` – S

- `exam_id:uuid U → exams`, `title:text`. `U(id, exam_id)`. Der Startentwurf verwendet einen eigenen Pool je Prüfung; dadurch sind Fragen verschiedener Prüfungen klar getrennt.

### `questions` – S

- `pool_id:uuid`, `exam_id:uuid → exams`, `question_type:text{single_choice}`, `question_text:text`, `explanation:text`, `status:text{draft|active|archived}`, `position:integer`.
- FK `(pool_id, exam_id) → question_pools(id, exam_id)`; `U(id, exam_id)`, `U(pool_id, position)`. Für eine veröffentlichte Single-Choice-Frage ist eine ausführliche, fachlich freigegebene Erklärung erforderlich; automatische Prüfung auf Nicht-Leerheit ersetzt die fachliche Qualitätskontrolle nicht. Die Frage wird nach Veröffentlichung nur in einer neuen Kursversion geändert.

### `answer_options` – S

- `question_id:uuid → questions`, `option_text:text`, `is_correct:boolean`, `position:smallint`.
- `U(id, question_id)`, `U(question_id, position)`; partiell höchstens eine richtige Option pro Frage. Die Veröffentlichung prüft zusätzlich die **genaue** Zahl und mindestens eine richtige Option; die Maximalregel allein genügt nicht.

### `exam_attempts` – S

- `enrollment_id:uuid`, `course_version_id:uuid → course_versions`, `exam_id:uuid`, `attempt_no:integer`, `status:text{in_progress|submitted|expired}`, `start_idempotency_key:text`, `started_at:timestamptz`, `submitted_at:timestamptz?`.
- FK `(enrollment_id, course_version_id) → enrollments(id, course_version_id)` und `(exam_id, course_version_id) → exams(id, course_version_id)`; `U(enrollment_id, exam_id, attempt_no)` und `U(enrollment_id, start_idempotency_key)`. Partiell höchstens ein `in_progress`-Versuch je Einschreibung/Prüfung. Nach Abgabe sind Auswahl, Antworten und Ergebnis unveränderlich; nur noch offene Versuche dürfen ablaufen.

### `exam_attempt_questions` – J

- `attempt_id:uuid`, `exam_id:uuid`, `question_id:uuid`, `position:smallint`; `PK(attempt_id, question_id)`, `U(attempt_id, position)`.
- FK `(attempt_id, exam_id) → exam_attempts(id, exam_id)` und `(question_id, exam_id) → questions(id, exam_id)`; dazu `U(id, exam_id)` auf `exam_attempts`. Auswahl wird beim Start persistiert; Fragen aus einem fremden Pool sind ausgeschlossen.

### `exam_attempt_options` – J

- `attempt_id:uuid`, `question_id:uuid`, `option_id:uuid`, `position:smallint`; `PK(attempt_id, question_id, option_id)`, `U(attempt_id, question_id, position)`.
- FK `(attempt_id, question_id) → exam_attempt_questions(attempt_id, question_id)` und `(option_id, question_id) → answer_options(id, question_id)`. Damit ist die angezeigte zufällige Reihenfolge wiederherstellbar.

### `exam_attempt_answers` – E

- `attempt_id:uuid`, `question_id:uuid`, `selected_option_id:uuid`, `is_correct:boolean`; `U(attempt_id, question_id)`.
- FK `(attempt_id, question_id, selected_option_id) → exam_attempt_options(attempt_id, question_id, option_id)`. Antworten werden bei endgültiger Abgabe in derselben Transaktion wie das Ergebnis angelegt, nicht während einer unvollständigen Abgabe.

### `exam_attempt_results` – E

- `attempt_id:uuid U → exam_attempts`, `correct_count:smallint`, `question_count:smallint`, `passed:boolean`, `rule_snapshot:jsonb`, `evaluated_at:timestamptz`.
- `0 ≤ correct_count ≤ question_count`; `passed` muss der eingefrorenen Regel entsprechen. Auf fehlgeschlagene Versuche liefert die Teilnehmer-API nur den Nicht-bestanden-Status, nicht diese internen Detailfelder.

### `completion_records` – E

- `enrollment_id:uuid`, `course_version_id:uuid → course_versions`, `completion_rule_id:uuid`, `evidence_snapshot:jsonb`, `completed_at:timestamptz`.
- FK `(enrollment_id, course_version_id) → enrollments(id, course_version_id)` und `(completion_rule_id, course_version_id) → course_completion_rules(id, course_version_id)`; dazu `U(id, course_version_id)` auf der Regeltabelle. `U(enrollment_id)`. Entsteht nur nach serverseitiger Prüfung aller tatsächlich erfüllten Bedingungen.

### Verbindliches Profil für die erste Ausbildung

In der ersten freigegebenen Version werden `expected_module_count=14`, `expected_chapter_count=42`, `expected_exams_per_chapter=2`, `chapter_completion_mode=self_or_all_chapter_exams`, `auto_certificate_enabled=true` und eine freigegebene Zertifikatsvorlage erfasst. Für **jede** der 84 Kapitelprüfungen gelten `required_for_completion=true`, `exam_type=single_choice_quiz`, `question_count=3`, `option_count=4`, `pass_rule` mit `min_correct=3` und `show_solutions_after_pass=true`. Jede verwendbare Frage hat **genau vier** Optionen und **genau eine** richtige Option. Die Abschlussregel verlangt alle Kapitel und alle Kapitelprüfungen; ein Kapitel wird automatisch abgeschlossen, wenn seine beiden Prüfungen bestanden sind. Für diese erste Version sind keine zusätzlichen Pflichtprüfungen oder weiteren Abschlussbedingungen vorgesehen, sodass das Zertifikat nach der 84. bestandenen Prüfung automatisch angestoßen wird. Die Version kann erst veröffentlicht werden, wenn alle Regeln und die Vorlage geprüft wurden.

Das ergibt 84 eigenständige Prüfungen und bei einem exklusiven Pool je Prüfung mindestens 252 nutzbare Fragen. Um für jede Prüfung zwei vollständig unterschiedliche Dreier-Sets zu garantieren, wären mindestens sechs nutzbare Fragen je Prüfung, also 504, erforderlich. Sind weniger Alternativen vorhanden, werden ungenutzte Fragen bevorzugt und ansonsten zulässige Fragen erneut verwendet. Diese Zahlen sind Strukturvorgaben, keine erfundenen Fachinhalte. Andere Kurse dürfen andere Zahlen und später andere Prüfungsarten haben.

## 2.6 Zertifikate

### `certificate_templates` – S

- `name:text`, `status:text{draft|active|archived}`, `created_by:uuid → users`.

### `certificate_template_versions` – S

- `template_id:uuid → certificate_templates`, `version:integer`, `state:text{draft|published|retired}`, `layout_schema_version:smallint`, `layout:jsonb`, `logo_media_id:uuid? → media_assets`, `background_media_id:uuid? → media_assets`, `published_at:timestamptz?`, `published_by:uuid? → users`.
- `U(template_id, version)`; höchstens eine veröffentlichte Version je Vorlage. Layout enthält kontrollierte Felder und erlaubte Platzhalter, keinen ausführbaren Code, kein beliebiges JavaScript und keine unkontrollierten Netzwerkzugriffe. Für automatische Zertifikate sind sichtbare Platzhalter mindestens für Teilnehmername, Kurstitel, Abschlussdatum und Zertifikatsnummer Pflicht. Bestehende Zertifikate verweisen dauerhaft auf ihre eingefrorene Vorlagenversion; eine später abgelöste Vorlage bleibt für bereits erworbene Kurse verwendbar.

### `certificates` – S

- `completion_record_id:uuid → completion_records`, `template_version_id:uuid → certificate_template_versions`, `certificate_number:text U`, `verification_token_hash:bytea U`, `verification_token_ciphertext:bytea`, `verification_key_id:text`, `status:text{valid|revoked}`, `issued_at:timestamptz`, `revoked_at:timestamptz?`, `revoked_reason:text?`, `replaces_certificate_id:uuid? → certificates`, `pdf_media_id:uuid? → media_assets`, `completion_snapshot:jsonb`.
- Partiell höchstens ein `valid`-Zertifikat pro Abschluss; `revoked_at` und `revoked_reason` sind genau beim Status `revoked` gesetzt. Nach Widerruf ist eine nachvollziehbare Neuausstellung möglich; alte Urkunden bleiben als widerrufen erhalten. Unveränderlicher Snapshot umfasst den bei Ausstellung aus `users.first_name` und `users.last_name` übernommenen Teilnehmernamen, Kurstitel/-version, Abschlussdatum und Regelversion. `pdf_media_id` verweist nach erfolgreicher Erzeugung auf ein privates, geprüftes `media_assets`-Objekt mit `mime_detected=application/pdf`, `status=ready` und Inhalts-Checksumme. Der Download wird über den zugehörigen Abschluss und die Einschreibung ausschließlich dem berechtigten Kontoinhaber gestattet; ein signierter Downloadlink ist kurzlebig. Solange das PDF fehlt, zeigt das Portal „wird erstellt“ und bietet keinen defekten Download an. Der Verifikationswert ist zufällig; sein gespeicherter Hash dient der Prüfung, die separat verschlüsselte Kopie der erneuten PDF-Erzeugung. Widerruf ist protokolliert und in der Verifikation sichtbar.

### `certificate_events` – E

- `certificate_id:uuid → certificates`, `kind:text{issued|pdf_generated|revoked|reissued}`, `actor_user_id:uuid? → users`, `reason:text?`, `idempotency_key:text U`.

## 2.7 Newsletter

### `newsletter_subscribers` – S

- `email_original:text`, `email_canonical:text U`, `user_id:uuid? → users`, `status:text{pending|confirmed|unsubscribed|bounced|complained}`, `current_consent_event_id:uuid? → consent_events`, `confirmed_at:timestamptz?`, `unsubscribed_at:timestamptz?`, `source:text`, `unsubscribe_token_hash:bytea U`, `unsubscribe_token_ciphertext:bytea`, `unsubscribe_key_id:text`.
- Kauf/Registrierung verändert den Newsletterstatus nicht. Eine neue Anfrage nach Abmeldung setzt den Status nicht ohne erneute erfolgreiche Bestätigung auf `confirmed`. Bounce/Complaint sperren den Versand zusätzlich zur Einwilligungsprüfung.

### `newsletter_confirmation_tokens` – S

- `subscriber_id:uuid → newsletter_subscribers`, `token_hash:bytea U`, `wording_snapshot:text`, `legal_document_version_id:uuid? → legal_document_versions`, `expires_at:timestamptz`, `used_at:timestamptz?`, `revoked_at:timestamptz?`.
- Bestätigung erzeugt atomar ein `consent_events`-Grant mit dem bei der Anfrage angezeigten Wortlaut. Token sind einmalig und begrenzt gültig.

### `newsletter_interests` – S

- `key:text U`, `name:text`, `active:boolean=true`.

### `subscriber_interests` – J

- `subscriber_id:uuid → newsletter_subscribers`, `interest_id:uuid → newsletter_interests`, `created_at:timestamptz`; `PK(subscriber_id, interest_id)`.

### `newsletter_segments` – S

- `name:text`, `schema_version:smallint`, `rule:jsonb`, `created_by:uuid → users`, `status:text{draft|active|archived}`.
- Nur erlaubte Filter, etwa Interesse, gekaufte Kurs-ID und Kundenstatus, sowie sichere logische Kombinationen. Kein ausführbares SQL. Segmentierung ersetzt nie die individuelle Versandberechtigung.

### `newsletter_campaigns` – S

- `subject:text`, `preview_text:text?`, `body_html:text`, `body_text:text`, `segment_id:uuid → newsletter_segments`, `segment_schema_version:smallint?`, `segment_rule_snapshot:jsonb?`, `audience_frozen_at:timestamptz?`, `status:text{draft|scheduled|sending|sent|cancelled}`, `scheduled_at:timestamptz?`, `sent_at:timestamptz?`, `tracking_policy:text{none|consent_only}=none`, `created_by:uuid → users`, `approved_by:uuid? → users`.
- Bei Versandfreigabe werden Inhalt, Regel-Snapshot und Trackingentscheidung eingefroren; spätere Änderungen am Segment wirken nicht rückwirkend. Beim Sendestart wird die Kandidatenliste einmal konsistent in `newsletter_sends` fixiert. Abmeldung und aktueller Berechtigungsstatus werden unmittelbar vor jedem Einzelversand erneut geprüft.

### `newsletter_sends` – S

- `campaign_id:uuid → newsletter_campaigns`, `subscriber_id:uuid → newsletter_subscribers`, `email_outbox_id:uuid? U → email_outbox`, `status:text{queued|sending|accepted|delivered|failed|suppressed|bounced}`, `sent_at:timestamptz?`, `last_error_safe:text?`; `U(campaign_id, subscriber_id)`.
- Die Outbox verwendet eine versionierte Newsletter-Rahmenvorlage; der freigegebene und sanitierte Kampagneninhalt wird über diese relationale Zuordnung geladen, nicht als beliebiger HTML-Platzhalter eines Nutzers ausgeführt. Jeder Versand erzwingt den Abmeldelink und aktuelle Versandberechtigung.

### `newsletter_tracking_events` – E

- `newsletter_send_id:uuid → newsletter_sends`, `type:text{open|click}`, `target_url:text?`, `tracking_consent_event_id:uuid → consent_events`, `occurred_at:timestamptz`.
- Nur bei technisch aktivierter und zum Ereigniszeitpunkt gültiger eigenständiger Tracking-Einwilligung; keine IP oder User-Agent. Ziel-URLs ohne geheime Parameter speichern. Standardmäßig entstehen keine Tracking-Ereignisse. Öffnungsraten sind technisch unzuverlässig.

## 2.8 Website, Inhalte und Anbieter

### `pages` – S

- `slug:text U`, `type:text{standard|landing}`, `status:text{draft|published|archived}`.

### `page_versions` – S

- `page_id:uuid → pages`, `version:integer`, `state:text{draft|published|retired}`, `title:text`, `content_schema_version:smallint`, `content:jsonb`, `seo:jsonb`, `created_by:uuid → users`, `published_by:uuid? → users`, `published_at:timestamptz?`.
- `U(page_id, version)` und partiell höchstens eine veröffentlichte Version pro Seite. Content besteht aus zugelassenen, sanitisierten Blöcken; verfügbare Medien werden zusätzlich in `page_version_media` referenziert. Veröffentlichte Inhalte bleiben versioniert.

### `page_version_media` – J

- `page_version_id:uuid → page_versions`, `media_asset_id:uuid → media_assets`, `created_at:timestamptz`; `PK(page_version_id, media_asset_id)`. Alle im Seiteninhalt verwendeten Medien müssen zugeordnet und freigegeben sein.

### `page_version_courses` – J

- `page_version_id:uuid → page_versions`, `section_key:text`, `course_id:uuid → courses`, `position:integer`, `created_at:timestamptz`; `PK(page_version_id, section_key, course_id)`, `U(page_version_id, section_key, position)`.
- Redaktionell ausgewählte Kurskacheln einer Seitenversion; nur öffentlich sichtbare, zum Anzeigezeitpunkt veröffentlichte Kurse werden ausgegeben. Dynamische Kurslisten können stattdessen alle zulässigen Kurse aus dem Katalog laden.

### `legal_documents` – S

- `type:text{imprint|privacy|withdrawal|terms|payment_info} U`, `status:text{draft|published|archived}`.

### `legal_document_versions` – S

- `document_id:uuid → legal_documents`, `version:integer`, `state:text{draft|published|retired}`, `title:text`, `content:jsonb`, `provider_snapshot:jsonb?`, `effective_from:timestamptz?`, `published_at:timestamptz?`, `created_by:uuid → users`, `approved_by:uuid? → users`.
- `U(document_id, version)`, partiell höchstens eine veröffentlichte Version pro Dokument. Beim Impressum wird vor Veröffentlichung ein vollständiger, geprüfter Anbietersnapshot einschließlich `responsible_name` übernommen und in der veröffentlichten Fassung ausgegeben. Auf Bestellungen/Einwilligungen verlinkte Versionen bleiben nachvollziehbar. Inhalt ist vom Betreiber/rechtlichen Berater zu liefern und freizugeben; es werden keine fertigen Rechtstexte behauptet.

### `navigation_items` – S

- `location:text{header|footer}`, `label:text`, `page_id:uuid? → pages`, `legal_document_id:uuid? → legal_documents`, `external_url:text?`, `parent_id:uuid? → navigation_items`, `position:integer`, `visible:boolean=true`.
- Genau eines von Seite, Rechtsdokument und erlaubter externer HTTPS-URL ist gesetzt. Elternelemente müssen dieselbe Position `location` haben; Zyklen sind verboten. Eindeutige Reihenfolge innerhalb desselben Elternelements/Standorts.

### `provider_profile` – S

- `singleton:boolean=true U`, `responsible_name:text`, `legal_provider_name:text?`, `legal_form:text?`, `street:text?`, `street_extra:text?`, `postal_code:text?`, `city:text?`, `country:char(2)?`, `contact_email:text?`, `phone:text?`, `registration_details:text?`, `vat_id:text?`, `additional_legal_info:text?`, `logo_media_id:uuid? → media_assets`, `updated_by:uuid? → users`.
- `singleton` muss `true` sein. Als Verantwortlicher ist nach Einrichtung der vom Auftraggeber genannte Name Soufian Charrak vorzusehen; weitere Angaben werden nicht erfunden. Vor Veröffentlichung und Verkauf sind die nach rechtlicher Prüfung erforderlichen Daten vorhanden und auf den vorgesehenen Seiten korrekt ausgegeben. Änderungen allein ersetzen keine Freigabe aktualisierter Rechtstexte. Änderungen rechtlich relevanter Anbieterangaben deaktivieren die fachliche Freigabe für neue Verkäufe transaktional; veröffentlichte Fassungen werden erneut geprüft und freigegeben. Bereits eingegangene Zahlungsvorgänge werden weiterhin verifiziert und bearbeitet.

### `site_settings` – J

- `key:text PK`, `value:jsonb`, `updated_by:uuid → users`, `updated_at:timestamptz`.
- Erlaubte Schlüssel und Schemas sind versioniert, z. B. `branding`, `contact_display`, `consent_categories`, `commerce_publication_enabled` und `public_languages`. Keine Secrets. Die effektive Verkaufsfreigabe benötigt sowohl die geschützte Betriebsvariable `COMMERCE_ENABLED` als auch die fachliche Admin-Freigabe und alle Go-live-Prüfungen.

### `faqs` – S

- `question:text`, `answer:jsonb`, `category:text?`, `course_id:uuid? → courses`, `position:integer`, `status:text{draft|published|archived}`.

### `testimonials` – S

- `display_name:text`, `text:text`, `rating:smallint?`, `course_id:uuid? → courses`, `publication_consent_event_id:uuid? → consent_events`, `status:text{draft|published|archived}`.
- Bewertung, falls vorhanden, zwischen 1 und 5. Veröffentlichung nur mit dokumentierter Freigabe und ausreichender Tatsachengrundlage; keine automatisch erzeugten Erfahrungsberichte.

### `contact_messages` – S

- `name:text`, `email_original:text`, `subject:text?`, `message:text`, `status:text{new|in_progress|closed}`, `handled_by:uuid? → users`, `handled_at:timestamptz?`, `delete_after:timestamptz?`.
- Kontaktaufnahme ist keine Newsletter-Einwilligung. Zugriff und Aufbewahrung sind begrenzt.

## 2.9 E-Mail und Automatisierung

### `email_templates` – S

- `key:text`, `locale:text`, `status:text{active|inactive}`; `U(key, locale)`.
- Schlüssel mindestens für Registrierung, E-Mail-Verifizierung, Willkommen, Aktivierung, Gast-Checkout-Verifizierung, Bestelleingang, gegebenenfalls Vertragsbestätigung, Kaufbestätigung, Zahlungsbestätigung, Rechnung, Kursfreischaltung, Passwort-Reset, Passwortänderung, Ablaufhinweis, Zertifikat, Bestätigung einer Widerrufsanfrage, Newsletterbestätigung, Newsletterabmeldung und den Newsletter-Kampagnenrahmen.

### `email_template_versions` – S

- `template_id:uuid → email_templates`, `version:integer`, `state:text{draft|published|retired}`, `subject_template:text`, `body_html_template:text`, `body_text_template:text`, `allowed_variables:jsonb`, `created_by:uuid? → users`, `published_at:timestamptz?`.
- `created_by` darf nur bei systemseitiger Ersteinrichtung leer sein; diese wird als Bootstrap-Auditereignis protokolliert. `U(template_id, version)` und partiell höchstens eine veröffentlichte Version je Vorlage. Platzhalter sind explizit erlaubt und kontextgerecht escaped; Vorlagen führen keinen beliebigen Code aus. Transaktions- und Newsletter-Absender sind getrennt konfiguriert.

### `email_outbox` – S

- `template_version_id:uuid → email_template_versions`, `purpose:text{transaction|newsletter}`, `user_id:uuid? → users`, `subscriber_id:uuid? → newsletter_subscribers`, `order_id:uuid? → orders`, `to_email:text`, `variables_public:jsonb`, `variables_secret_ciphertext:bytea?`, `secret_key_id:text?`, `secret_delete_after:timestamptz?`, `idempotency_key:text U`, `status:text{queued|sending|accepted|delivered|failed|suppressed}`, `attempts:integer=0`, `scheduled_at:timestamptz`, `sent_at:timestamptz?`, `provider:text?`, `provider_message_id:text?`, `last_error_safe:text?`.
- Nur notwendige Daten speichern; Aktivierungs-, Bestätigungs- und Abmeldetokens nie in `variables_public`, Logs oder unverschlüsselter Job-Payload. Notwendiges Linkmaterial ist ausschließlich bis zur Zustellung bzw. definierten Löschung authentifiziert verschlüsselt und wird vom Worker entschlüsselt. Provider-Message-ID je Provider, soweit gesetzt, eindeutig. Eine providerseitige Doppelzustellung nach unklarem Netzwerkabbruch ist nicht pauschal auszuschließen; Provider-Idempotenz und Abgleich minimieren das Risiko.

### `email_outbox_attachments` – J

- `email_outbox_id:uuid → email_outbox`, `media_asset_id:uuid → media_assets`, `position:integer`, `created_at:timestamptz`; `PK(email_outbox_id, media_asset_id)`, `U(email_outbox_id, position)`.
- Nur geprüfte, zur Nachricht gehörende Dateien. Erforderliche Vertragsinformationen und Erklärungen werden nach rechtlicher Freigabe als unveränderlicher Anhang oder im Nachrichtentext auf dauerhaftem Datenträger bereitgestellt; ein bloßer Portal-Link wird nicht ungeprüft damit gleichgesetzt.

### `email_delivery_events` – E

- `email_outbox_id:uuid → email_outbox`, `provider:text`, `provider_event_id:text`, `type:text{accepted|delivered|deferred|bounce|complaint}`, `occurred_at:timestamptz`, `detail_safe:text?`; `U(provider, provider_event_id)`.
- Providerzustellungen nur nach geeigneter Authentifizierung/Signatur verarbeiten. Falls ein gewählter Anbieter keine Zustellereignisse unterstützt, ist die Einschränkung sichtbar; ein SMTP-`accepted` ist kein Beweis für Zustellung.

### `automation_jobs` – S

- `kind:text`, `ref_type:text`, `ref_id:uuid?`, `payload_schema_version:smallint`, `payload:jsonb`, `idempotency_key:text U`, `status:text{queued|waiting_for_data|running|succeeded|failed|cancelled}`, `wait_reason:text?`, `attempts:integer=0`, `max_attempts:integer`, `run_after:timestamptz`, `lease_until:timestamptz?`, `finished_at:timestamptz?`, `last_error_safe:text?`.
- Dauerhafte Steuerung in PostgreSQL; Payload enthält keine Passwörter oder Tokens. BullMQ verwendet daraus abgeleitete deterministische Job-IDs. Ein Dispatcher und regelmäßiger Abgleich stellen fällige/abgelaufene Leases nach Redis-Ausfall erneut zu. `waiting_for_data` ist nur für zulässige, noch ausstehende Fach- oder Datenschutzklärungen vorgesehen; ein nicht gelöschtes Konto ohne Vor- oder Nachnamen darf aufgrund der Kontovalidierung nicht entstehen. Ein Zertifikatsjob pausiert bei `deletion_requested` mit `wait_reason=privacy_review` ohne Retry-Verbrauch und wird bei `deleted` beendet statt neue personenbezogene Daten zu erzeugen. Eine fachliche Operation und ihr Job werden, wo erforderlich, in derselben Datenbanktransaktion angelegt.

### `admin_exports` – S

- `requested_by:uuid → users`, `type:text{orders|customers}`, `filter_schema_version:smallint`, `filters:jsonb`, `status:text{queued|ready|failed|expired}`, `result_media_id:uuid? → media_assets`, `expires_at:timestamptz`, `last_error_safe:text?`.
- Ein dauerhafter `automation_jobs`-Auftrag referenziert den Export. Datei ist privat, zeitlich begrenzt und nur nach erneuter Rechteprüfung abrufbar; Erstellung und Download werden auditiert. Tabellenkalkulations-Formeln in CSV-Zellen werden sicher entschärft, ohne Beträge oder Zuordnung zu verfälschen.

### `automation_job_attempts` – E

- `automation_job_id:uuid → automation_jobs`, `attempt_no:integer`, `started_at:timestamptz`, `finished_at:timestamptz`, `result:text{succeeded|failed|cancelled}`, `error_safe:text?`; `U(automation_job_id, attempt_no)`.

## 2.10 Regeln, JSON-Verträge und Indizes

### Aufbau wesentlicher JSON-Werte

Alle Werte werden vor Persistierung und bei Verwendung gegen die jeweils bekannte Schema-Version validiert. Nicht definierte Eigenschaften sind zurückzuweisen. Der erste implementierte Vertrag muss mindestens folgende fachlichen Felder enthalten:

| Feld | Inhalt des ersten Schemas |
|---|---|
| `course_versions.description`, `chapter_contents.body`, `page_versions.content`, `legal_document_versions.content`, `faqs.answer` | Reihenfolge typisierter Inhaltsblöcke mit Text, Listen und explizit referenzierten Medien; nur erlaubte Formatierungen und Links. Medien müssen als relationale Zuordnung vorhanden sein. |
| `course_versions.learning_objectives` | Liste nicht leerer, redaktionell freigegebener Lernziele. |
| `course_completion_rules.conditions` | Bekannte Bedingungen wie alle Pflichtkapitel, alle Pflichtprüfungen und konkrete zugehörige IDs; Bedingungen werden ausschließlich serverseitig ausgewertet. Mindestzeit ist im ersten Evaluator nicht zulässig. |
| `orders.billing_snapshot`, `invoice_documents.buyer_snapshot` | Firmenname optional, Vor- und Nachname der Rechnungs-Ansprechperson, Straßenanschrift, optional Zusatz/Region, Postleitzahl, Ort, Land und optional USt-ID. Die Daten werden bei Bestellung eingefroren und in den Rechnungsbeleg übernommen. Die Namen sind verpflichtend und nach der Namensregel validiert, können aber vom separat erfassten Teilnehmernamen abweichen. |
| `invoice_documents.issuer_snapshot`, `legal_document_versions.provider_snapshot` | Rechtliche Anbieterbezeichnung, verantwortliche Person, Anschrift, Kontakt und die jeweils benötigten, fachlich bestätigten Angaben zum Ausgabe- bzw. Veröffentlichungszeitpunkt. Das Impressum zeigt den im Snapshot gespeicherten `responsible_name`. |
| `completion_records.evidence_snapshot` | Kursversion, Regelversion und IDs/Zeitpunkte der erfüllten Pflichtkapitel und Prüfungen; keine zusätzlichen Lösungen. |
| `certificates.completion_snapshot` | Zum Ausstellungszeitpunkt gespeicherter Vorname und Nachname sowie daraus gebildeter Teilnehmername, Titel und Version der Ausbildung, Abschlussdatum und tatsächlich erfüllte Regelreferenz. Profiländerungen verändern bereits ausgestellte PDFs nicht. |
| `chapter_progress.last_position` | Zugelassener Inhaltstyp und nicht negative Position, z. B. Video-Sekunden oder Textabschnitt-ID derselben Kursversion. |
| `exams.pass_rule` | Versionierter, typisierter Regelsatz: `kind` ist `min_correct` mit ganzzahligem Schwellenwert oder `min_percent` mit Basispunkten; Schwelle liegt im gültigen Bereich. Für die erste Ausbildung gilt `min_correct=3`. |
| `exam_attempt_results.rule_snapshot` | Evaluatorversion, Frageanzahl, tatsächlich verwendete Bestehensregel und Anzeigeoptionen des Versuchs. |
| `page_versions.seo` | Optional Titel, Beschreibung und freigegebene kanonische URL; keine eingebetteten Skripte. |
| `newsletter_segments.rule`, `newsletter_campaigns.segment_rule_snapshot` | Versionierter Baum aus erlaubten AND-/OR-Regeln mit Interessen-, Kurs- und Kundenstatusfiltern; begrenzte Tiefe und Anzahl. Der Kampagnen-Snapshot bleibt nach Freigabe unveränderlich. |
| `admin_exports.filters` | Versionierter Vertrag für ausdrücklich erlaubte Datumsbereiche, Status- und Kursfilter; keine SQL-Ausdrücke und nur Felder, die der anfordernden Rolle zustehen. |
| `certificate_template_versions.layout` | Seitenformat, erlaubte Text-/Bildfelder, Positionen und Platzhalter, referenzierte Medien; keine externen Code-/Netzwerkreferenzen. |
| `email_template_versions.allowed_variables` und `email_outbox.variables_public` | Explizit erlaubte Namen und Typen pro Vorlagenversion; Linkgeheimnisse nur separat verschlüsselt. |
| `automation_jobs.payload`, `payment_events.minimal_payload`, `payment_confirmation_evidence.minimal_response`, Audit-Snapshots und `idempotency_requests.response_body_safe` | Für jeden Ereignis-/Antworttyp ein kleines erlaubtes Schema mit IDs/Status, ohne Geheimnisse und ohne unnötige personenbezogene Daten. Zahlungsereignisse benötigen Providerobjekttyp und -ID sowie, soweit geliefert, ursprünglichen Ereignisstatus, Zahlungsreferenz, bestätigten Betrag, Währung und Bestellreferenz. Für einen Erfolgsnachweis müssen Ereignistyp und der beim signierten Eingang enthaltene Erfolg belegbar sein; fehlende Zuordnungs- oder Betragsdetails dürfen ergänzend beim Provider abgefragt werden, nicht aber der fehlende Erfolgswebhook ersetzt werden. |
| `site_settings.value` | Je erlaubtem Schlüssel ein eigener Schema-Vertrag, insbesondere Branding, Kontaktanzeige, Einwilligungskategorien und Verkaufsfreigabe. |

**Konkreter Startumfang der Verträge:**

- Inhaltswerte sind Objekte mit `schema_version` (Ganzzahl) und `blocks` (geordnete Liste). Ein Block besitzt `id` (UUID) und `kind`: `paragraph` mit Text, `heading` mit Ebene 2–4 und Text, `list` mit einer Liste von Texten oder `link` mit Text und freigegebener HTTPS-/interner URL. Kursbeschreibungen, Rechtstexte und FAQ-Antworten enthalten im ersten Schema keine eingebetteten Medien. Lernmedien stehen in `chapter_contents.media_asset_id`. Bei Tabellen mit separater Schema-Spalte müssen die Versionen übereinstimmen.
- Nur `page_versions.content` unterstützt darüber hinaus `image` mit `media_asset_id` und Alternativtext, `hero` mit Überschrift, Beschreibung, optionalem Bild und optionalem Button, `button` mit Beschriftung und geprüftem Ziel sowie `process_steps` mit geordneten Titel-/Textpaaren. `course_list` verweist über `section_key` auf `page_version_courses` oder zeigt alle veröffentlichten Kurse; `faq_list` und `testimonials_list` laden ausschließlich freigegebene Daten. `newsletter_form` und `contact_form` binden die tatsächlichen, separat geschützten API-Vorgänge ein. Bildreferenzen müssen in `page_version_media` stehen, interne Buttonziele beim Veröffentlichen existieren; beliebige externe Skripte oder ausführbares HTML sind nicht erlaubt. Damit bleiben Startseite, Vorteile, Ablauf, Zertifizierung, Angebote, Newsletter und Kontakt über reale Bausteine redaktionell pflegbar.
- `course_completion_rules.conditions` enthält `schema_version`, `require_all_chapters:boolean`, `require_all_required_exams:boolean`, `require_all_chapter_exams:boolean`, `required_chapter_ids:uuid[]` und `required_exam_ids:uuid[]`. Die Bedingungen werden konjunktiv ausgewertet und dürfen nicht alle leer/inaktiv sein. `require_all_chapter_exams` verlangt mindestens einen bestandenen Versuch für jede Prüfung an jedem Kapitel, unabhängig von einzelnen Pflichtmarkierungen; ein Kapitel ohne Prüfung erfüllt diese Bedingung nicht. Für die erste Ausbildung sind alle drei Alles-Flags gesetzt, alle 84 Kapitelprüfungen als Pflichtprüfungen markiert und die zusätzlichen ID-Listen leer. Alle referenzierten IDs müssen derselben Version angehören; frühere Fehlversuche verhindern einen späteren erfolgreichen Abschluss nicht.
- `exams.pass_rule` enthält `schema_version` und entweder `kind=min_correct` mit `min_correct` von 1 bis `question_count` oder `kind=min_percent` mit `min_percent_bp` von 1 bis 10.000; bei Prozenten wird die erforderliche Zahl aufgerundet. Andere Felder/Regeln sind zurückzuweisen. In der ersten Ausbildung wird `min_correct=3` verwendet. Der zu `exam_type` registrierte Evaluator prüft und versioniert die Auswertung.
- `allowed_variables` listet pro Vorlagenversion Namen mit Typ und Geheimhaltungsstufe. Der erste Katalog enthält beispielsweise `academy_name`, `recipient_first_name`, `course_title`, `order_number`, `expires_at`, `login_url`, `activation_url`, `reset_url`, `confirmation_url` und `unsubscribe_url`. URLs mit Einmaltoken sind als geheim deklariert und ausschließlich über das verschlüsselte Outbox-Feld zulässig. Der erlaubte Satz wird für jede Vorlage konkretisiert, unbekannte Variablen werden zurückgewiesen.
- Für `site_settings` enthält `branding` einen Akademienamen und validierte Farbwerte; das Logo wird relational über `provider_profile.logo_media_id` gehalten. `contact_display` enthält Booleans zur Anzeige freigegebener Kontaktdaten. `consent_categories` enthält versionierte Beschreibungen und notwendige/optionale Kategorien ohne automatisch aktivierte optionale Kategorien. `commerce_publication_enabled` enthält ein Boolean, `public_languages` eine Liste unterstützter BCP-47-Codes; Standard ist `de-DE`. Jedes Setting hat eine Schema-Version. Keine dieser Einstellungen enthält Provider-Secrets.
- `chapter_progress.last_position` enthält `kind` und je nach Art `block_id:uuid` oder `offset_seconds` als nicht negative Ganzzahl. Eine selbst bestätigte Kapitelbearbeitung und geschätzte Zeit sind nicht der technische Beweis, dass der Inhalt gelesen oder verstanden wurde; Prüfungen und ausdrücklich konfigurierte Bedingungen bleiben separat maßgeblich.

### Berechnungs- und Sperrregeln

- Brutto-Positionsbeträge werden serverseitig bestimmt. Ein Gesamtgutschein wird proportional auf berechtigte Positionen verteilt: zunächst ganzzahlige Abrundung, verbleibende Cent nach größtem Rest und bei Gleichstand nach Positionsnummer. Keine Position darf negativ werden.
- Für einen gültigen Bruttosteuersatz wird die enthaltene Positionssteuer deterministisch als `round_half_up(Positionsbrutto × rate_bp / (10.000 + rate_bp))` berechnet; das Netto ist Brutto minus Steuer (`apps/api/src/tax.ts`). Summen werden aus den gerundeten Positionen gebildet. Die Rechnung wird **nicht** nachträglich aus heutigen Daten gerechnet: `order_items.tax_rate_bp/net_cents/tax_cents/tax_label` und der Rechnungssnapshot tragen die beim Kauf bestimmte Aufteilung.
- `order_items` prüft `total_gross_cents = net_cents + tax_cents` (`order_items_tax_split_check`) und die Ratenkonsistenz (`order_items_tax_rate_consistency_check`): bei 0 % ist keine Steuer erlaubt, bei positivem Satz muss `tax_cents` exakt dem gerundeten Wert entsprechen. Eine handgeschriebene Zeile kann keine falsche Aufteilung vortäuschen.
- Bei Bestellabschluss Preis, Verfügbarkeit, Gültigkeit und rechtliche Dokumentversionen erneut unter geeigneten Sperren prüfen. Bei Preisänderung eine erneute ausdrückliche Bestätigung verlangen. Bestellsnapshot danach nicht ändern.
- Nicht überlappende Zeiträume werden mit PostgreSQL-Exclusion-Constraints oder gleichwertiger serialisierter Durchsetzung geschützt; normale reine Unique-Indizes reichen dafür nicht. Die für Exclusion benötigte Standarderweiterung `btree_gist` ist eine explizite Migrationsvoraussetzung und in Migration 5 aktiviert. Für `prices` setzt `prices_no_overlapping_active_ranges` überlappungsfreie **aktive** Zeiträume je Produkt und Währung durch (`tstzrange(valid_from, COALESCE(valid_until,'infinity'), '[)')`); Entwürfe dürfen sich überschneiden. `tax_rates` ist über `tax_rates_no_overlap` ebenso geschützt (Migration 11).
- Zahlungseingang, Konto-Zuordnung, Einschreibung, einzelne Zugangsquelle, Gutscheinverbrauch, Rechnungsvorgang und Auftrags-/Mail-Outbox werden idempotent unter Datensatzsperren durchgeführt. Externe Aufrufe liegen außerhalb der Datenbanktransaktion und erhalten eigene Idempotenzschlüssel; ein Datenbank-Rollback kann einen bereits erfolgten Provideraufruf nicht rückgängig machen.
- Ein bestandener Versuch, der Abschlussnachweis und der Auftrag zur Zertifikatserzeugung werden transaktional verknüpft. Eindeutige Schlüssel verhindern doppelte aktive Zertifikate, nicht aber legitime widerrufene Vorversionen.

### Wichtige zusätzliche Indizes

Neben allen genannten Primär-, Unique-, partiellen und Fremdschlüsselindizes mindestens: `orders(payment_state, placed_at)`, `orders(user_id, placed_at)`, `payment_event_processing(status, lease_until)`, `payment_attempts(order_id, status)`, `refunds(payment_attempt_id, status)`, `access_grants(enrollment_id, status, starts_at, expires_at)`, `enrollments(user_id, learning_state)`, `chapter_progress(enrollment_id, status)`, `exam_attempts(enrollment_id, exam_id, attempt_no)`, `newsletter_sends(campaign_id, status)`, `email_outbox(status, scheduled_at)`, `automation_jobs(status, run_after)` und `audit_events(target_type, target_ref, created_at)`. Berichtsindizes werden anhand realer Abfragen und Datenmengen nachgemessen.

### Beziehungen im Überblick

`users → enrollments → access_grants` verbindet Teilnehmer mit einer bestimmten `course_version`; eine Kaufquelle zeigt auf `order_item_courses → order_items → orders`. `products → product_courses → courses → course_versions → course_modules → course_chapters → chapter_contents` ist die generische Lern- und Verkaufsstruktur. `exams → question_pools → questions → answer_options` und `exam_attempts → exam_attempt_questions/options/answers/results` halten Fragen und tatsächliche Versuche getrennt. `completion_records → certificates` bindet Urkunden an belegte Abschlussbedingungen. `newsletter_subscribers → consent_events/newsletter_sends` trennt Einwilligung von Bestellungen. `payment_events → payment_event_processing/payment_event_attempts` trennt verifizierten Eingang von veränderlichem Verarbeitungsstatus.
