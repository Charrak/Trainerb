# Staging-Abnahme: Medienprüfung

Nur im isolierten Staging mit privatem Testkurs, synthetischen Dateien und eigenem Quarantäne-Bucket durchführen. Keine Integrationstests gegen diese Umgebung starten: deren Datenbank wird geleert. Dieses Blatt ist ein Prüfplan, kein bereits erbrachter Nachweis.

## Einrichten

- API mit den Migrationen bis einschließlich `202611180016_quarantine_scan` bereitstellen. Dem Scanner weder die API-`.env` noch die Secrets von Website, Upload oder Auslieferung zugänglich machen. Die sieben benötigten Umgebungsvariablen stehen im [README](../README.md#malware-prüfung-der-quarantäne). Der Bucket muss exakt dem privaten Upload-Bucket entsprechen. Für eine private TLS-CA bei Bedarf `NODE_EXTRA_CA_CERTS` setzen; TLS-Prüfung nicht abschalten.
- Scanner als separaten Benutzer mit Zugriff auf den lokalen clamd-Socket ausführen. Sein S3-Zugang darf ausschließlich Quarantäneobjekte lesen, weder schreiben noch Auslieferungsobjekte lesen. Rollen und effektive Bucket-Policies **beim Zielanbieter** prüfen. Ein erfolgreicher Test mit einem Administratorschlüssel ersetzt diese Prüfung nicht.
- Eigener Datenbanklogin ohne Eigentümer-/Migrationsrechte: CONNECT auf die Datenbank, USAGE auf das Schema, SELECT auf `course_media_uploads`, UPDATE nur für `status`, `scan_error`, `scanned_at`; INSERT auf `audit_events` und SELECT für die zurückgegebene `id`. Keine Rechte auf Kunden-, Zahlungs- oder Assettabellen vergeben. Keine weitergehenden Rechte durch Rollenmitgliedschaften erben.
- Nach dem API-Build den Scheduler auf `node apps/api/dist/cli/media-scan.js` setzen. Startintervall, Alarm für Exitcode ungleich null und Überwachung von wartenden Belegen festlegen. ClamAV-Version, Zeitpunkt des letzten erfolgreichen Signaturupdates und Socket-Zugriff prüfen. Kein Klartext-Secret in Jobargumente oder Abnahmeprotokoll schreiben.

## Nachweise am Testkurs

| Handlung | Erwartetes Ergebnis |
|---|---|
| Bei pausiertem Scheduler eine harmlose, gültige PNG hochladen. Scheduler starten und einen regulären Lauf abwarten. | Erst „Wartet auf Prüfung“, anschließend „Ohne Fund – weiterhin privat“. Ein passendes `media.scanned`-Auditereignis. Keine Vorschau, kein Lernlink. |
| Eine vom Betrieb freigegebene **harmlose** Antivirus-Prüfdatei in einem unterstützten Format hochladen und prüfen lassen. | Die Annahme muss erfolgreich gewesen sein, bevor der Scan als getestet gilt. „Fund – gesperrt“, kein Asset. Kein echtes Schadprogramm verwenden. |
| Nur im Testjob vorübergehend einen nicht vorhandenen Socket konfigurieren und eine weitere harmlose Datei prüfen. | Job meldet Exitcode 1, die Kursverwaltung zeigt „Prüffehler – gesperrt“ und die Beleg-ID. Keine Freigabe. |
| Korrekten Socket wiederherstellen und `node apps/api/dist/cli/media-scan.js --retry-error <Beleg-UUID>` in derselben Worker-Umgebung ausführen. | Derselbe Beleg erhält das neue Ergebnis und einen weiteren Audit-Eintrag. Der Fund-Beleg bleibt unverändert. |

Release-Commit, Testkurs, Beleg-IDs, UTC-Zeitpunkte, Soll/Ist, ausführende Person und offene Abweichungen protokollieren. Bei Abweichungen keine Freigabe erteilen. Socket-Konfiguration und Scheduler nach dem Versuch kontrollieren, private Testobjekte und Belege nach der vereinbarten Aufbewahrungsfrist bereinigen. Die redaktionelle Übernahme in den Auslieferungsbucket ist **nicht** Gegenstand dieser Abnahme.

Ab Migration 034 verarbeiten Scan und Übernahme auch dedizierte `intended_use=website`-Belege. Vor Aktivierung API, Scanner und Promoter gemeinsam aktualisieren; alte Promoter nicht parallel betreiben. Die Promoter-Leserolle benötigt zusätzlich `intended_use`. Rechteakten gehören in die geschützte Rechteablage, nicht in Dateinamen oder die Datenbankreferenz. PNG-/JPEG-Originale bleiben in Quarantäne; nur die neu kodierte Kopie ist nach Zweitfreigabe nutzbar. Die echte Vier-Augen-Probe und Bucket-Policies im Zielsystem bleiben Betriebsabnahmen.
