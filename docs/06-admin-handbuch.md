# 6. Geplante Administration und Bedienungsanleitung

**Version 1.0 · 15.11.2026 · Sollkonzept; nur Teilfunktionen implementiert**

Dieses Handbuch beschreibt die geplante Bedienung nach erfolgreicher Entwicklung und Freigabe. Es behauptet nicht, dass die genannten Ansichten oder Schaltflächen bereits existieren. Der tatsächlich implementierte Teil – insbesondere Identität und eine erste geschützte Kursentwurfsverwaltung – ist in [07 – Entwicklungsstand](07-entwicklung.md#73-erster-ausschnitt-von-phase-2-kursentwürfe) beschrieben. Für jede zukünftige Aktion gelten die serverseitigen Rechte und der Audit-Nachweis; eine bloß sichtbare Schaltfläche ist keine implementierte Funktion.

## 6.1 Anmeldung und erster Superadmin

Der technische Betreiber richtet nach Installation und Konfiguration einmalig über den lokal autorisierten Bootstrap die vom Betreiber angegebene E-Mail-Adresse sowie Vor- und Nachnamen als ersten Superadmin ein. Auch für dieses Konto sind beide Namensangaben Pflicht; bei fehlenden oder ungültigen Angaben werden weder Konto noch Aktivierungsnachricht angelegt. Es gibt kein Standardpasswort und keinen öffentlichen Bootstrap-Endpunkt. Der Administrator öffnet den zugesandten einmaligen Aktivierungslink, setzt selbst ein Passwort und richtet im anschließenden abgesicherten Schritt eine Authenticator-App mit TOTP ein. Die einmalig angezeigten Wiederherstellungscodes werden sicher und getrennt verwahrt.

Im späteren Alltag: Admin-Adresse aufrufen, E-Mail und Passwort eingeben, Authenticator-Code bestätigen. Ein eingerichteter Faktor ist für sämtliche Backoffice-Rollen Pflicht. Ohne gültige MFA ist nur die zeitlich begrenzte MFA-Einrichtung/-Prüfung möglich, kein Zugriff auf Kunden oder Einstellungen. Kritische Schritte wie Rückerstattung, Rollenänderung oder Entzug eines Zugangs verlangen erneut eine Bestätigung. Ein zweiter Superadmin und ein dokumentierter Offline-Wiederherstellungsprozess verhindern Aussperrung; der letzte Superadmin darf nicht entfernt werden.

## 6.2 Dashboard und Kennzahlen

Das Dashboard zeigt echte Daten statt vorbereiteter Beispielwerte, den Zeitpunkt der letzten Aktualisierung und einen Filter für den betrachteten Zeitraum. Auswertung in `Europe/Berlin`; Speicherung intern in UTC. Für Geldwerte wird die Währung angezeigt und nicht über verschiedene Währungen hinweg ohne Umrechnung addiert.

| Anzeige | Verbindliche Definition im ersten Ausbau |
|---|---|
| Kundenkonten | Nicht gelöschte Konten mit Teilnehmerrolle; Backoffice-Nutzer haben ebenfalls diese Rolle und sind darin enthalten, sofern nicht ein zusätzlicher Filter gewählt wird. |
| Neue Registrierungen | Im Zeitraum neu angelegte Teilnehmerkonten; Status und Aktivierung getrennt filterbar. |
| Verkaufte Kurspositionen | Bezahlt bestätigte `order_item_courses` im Zeitraum; Paketbestandteile werden jeweils als Kursposition gezählt, Rückerstattungen separat ausgewiesen. |
| Bestellungen | Anzahl nach Bestellzeitpunkt, mit Filtern für zahlungs-/fulfillmentbezogene Zustände; offene Zahlungen sind nicht bezahlt. |
| Bestätigte Zahlungen | Summe tatsächlich bestätigter Zahlungen nach Bestätigungszeitpunkt, brutto und je Währung. |
| Erstattungen | Summe tatsächlich bestätigter Erstattungen nach deren Bestätigungszeitpunkt, getrennt von Zahlungseingängen. |
| Umsatzanzeige heute/Monat/gesamt | Operative Brutto-Zahlungseingänge minus bestätigte Erstattungen im gewählten Zeitraum; Streitfälle und Gebühren separat ausweisen. Dies ist keine steuerliche Gewinn- oder periodengerechte Umsatzrechnung. |
| Aktive Kursteilnehmer | Verschiedene Nutzer mit mindestens einer zum Anzeigezeitpunkt gültigen Zugangsquelle; optional nach Kurs filterbar. |
| Abgeschlossene Ausbildungen | Anzahl nachgewiesener `completion_records` im Zeitraum; nicht gleich Anzahl ausgegebener Urkunden. |
| Newsletter-Abonnenten | Aktuell bestätigte und nicht wegen Bounce/Complaint gesperrte Empfänger, nicht sämtliche angefragte Adressen. |

Grafische Trends basieren auf denselben Definitionen. Bei kleinen Teilnehmerzahlen werden nur berechtigten Rollen personenbezogene Details angezeigt. Verfügbarkeit, Fehler oder Datenverzug werden sichtbar gemacht, nicht durch geschätzte Zahlen kaschiert.

## 6.3 Rollen- und Berechtigungsmatrix

Jeder Benutzer erhält `participant`; Backoffice-Rollen werden zusätzlich zugewiesen. Die Datenbank speichert Rollen, Einzelrechte und Kurszuordnungen. Der Code benennt für jede Operation explizit das erforderliche Recht und prüft zusätzlich Eigentum bzw. Kurszuordnung. Rechte mehrerer Rollen vereinigen sich; eine globale Berechtigung muss aus einer dafür vorgesehenen globalen Rolle stammen, nicht aus einer Kurszuordnung allein. Nicht aufgeführte Aktionen sind verboten.

| Bereich | Superadmin | Admin | Kursmanager | Dozent | Kundenservice | Teilnehmer |
|---|---|---|---|---|---|---|
| Rollen/Rechte und Zahlungsanbieter konfigurieren | ja | nein | nein | nein | nein | nein |
| Nicht-Superadmin-Konten anlegen, bearbeiten, sperren | ja | ja; Rollen nicht selbst zuweisen | nein | nein | begrenzt für Support | nur eigenes Konto |
| Kurs erstellen, veröffentlichen, Preise/Pakete | ja | ja | nein | nein | nein | nein |
| Lerninhalte und Fragen | alle | alle | zugewiesene Kurse, Entwürfe | zugewiesene Kurse, Entwürfe | nein | freigegebene eigene Lerninhalte |
| Teilnehmerfortschritt | alle | alle | nur zugewiesene Kurse | nur zugewiesene Kurse | für berechtigten Supportfall | nur eigener |
| Bestellung / Zahlung | alle Details | alle Details | nein | nein | Supportansicht ohne Zahlungsinstrument-/Providergeheimnisse | eigene Bestellung und Rechnung |
| Rückerstattung auslösen/entscheiden | ja | ja | nein | nein | nur Vorschlag | Anfrage stellen |
| Manuelle Zugänge gewähren/entziehen | ja | ja | nein | nein | ja, mit Grund und Audit | nein |
| Zertifikatvorlagen / Widerruf / Neuausstellung | ja | ja | nein | nein | nein | eigene Zertifikate herunterladen |
| Website-/Rechtstexte | ja | ja, nach fachlicher Freigabe | nein | nein | nein | öffentlich freigegebene Inhalte lesen |
| Newsletter | erstellen, freigeben, versenden | erstellen, freigeben, versenden | nur Entwurf ohne Empfängerliste | nein | nein | eigene Einwilligung/Abmeldung |
| Berichte | alle | alle | zugewiesene Kurse | zugewiesene Kurse | freigegebene Basiszahlen | eigene Fortschrittsanzeige |
| Audit/Betrieb | alle | Lesen und erlaubte Betriebsaktionen | nein | nein | nein | nein |

### Konkreter Mindestkatalog der Rechte

| Schlüssel | Zulässige Rollen / zusätzliche Grenzen |
|---|---|
| `roles.manage`, `payments.configure`, `settings.manage` | nur Superadmin; MFA und frische Authentifizierung. `settings.manage` betrifft insbesondere Betriebs-/Verkaufsfreigaben, nicht das Lesen öffentlicher Inhalte. Secrets bleiben außerhalb der Datenbankoberfläche. |
| `users.read`, `users.edit`, `users.block` | Superadmin/Admin; Support erhält nur zweckgebundene Projektion und begrenzte Bearbeitungsfelder. Admin kann keine Superadmins sperren oder Rollen vergeben. |
| `courses.read`, `courses.create`, `courses.edit`, `courses.publish` | Superadmin/Admin global; Kursmanager/Dozent erhalten Lese-/Entwurfsbearbeitung nur für ausdrücklich zugewiesene Kurse. Erstellen und Veröffentlichen sind globalen Rollen vorbehalten. |
| `products.manage`, `prices.manage`, `coupons.manage` | Superadmin/Admin; Kursmanager dürfen Preis-/Anbieterwerte nicht verändern. |
| `media.upload` | Superadmin/Admin global; Kursmanager/Dozent nur für zugewiesene Kursentwürfe. Upload allein veröffentlicht kein Objekt. |
| `orders.read` | Superadmin/Admin mit vollständiger fachlicher Bestellansicht; `orders.read_limited` für Support ohne Zahlungsinstrumentdetails. Teilnehmer nutzen separate Eigentumsprüfung. |
| `refunds.manage`, `refunds.propose` | Superadmin/Admin dürfen mit Reauth Providererstattung auslösen und entscheiden; Support darf nur einen Vorschlag erfassen. |
| `access.manage` | Superadmin/Admin/Support; Zielkunde/Kurs, Grund und Audit sind Pflicht. Bei sensiblen Aktionen Reauth. Keine Änderung des Zahlungsstatus. |
| `certificates.manage` | Superadmin/Admin; Widerruf/Neuausstellung mit Reauth, nur anhand eines tatsächlichen Abschlusses. |
| `cms.edit`, `legal.manage` | Superadmin/Admin für Inhaltsseiten, unsensible redaktionelle Einstellungen und Anbieterprofil; Veröffentlichung rechtlicher Texte erst nach fachlicher Freigabe. Verkaufsfreigabe und Betriebsgeheimnisse bleiben Superadmin bzw. externer Konfiguration vorbehalten. |
| `newsletter.read`, `newsletter.edit`, `newsletter.send` | Superadmin/Admin; Versenden erfordert Freigabe und aktuelle Einwilligung. `newsletter.draft` für Kursmanager erlaubt ausschließlich Entwurf ohne Empfängerdaten. |
| `mail.manage`, `operations.read`, `operations.retry`, `audit.read` | Superadmin/Admin im erlaubten Aufgabenbereich; keine Ausgabe von Tokens oder Passwort-/MFA-Geheimnissen. |
| `reports.read_all`, `reports.read_assigned`, `reports.read_basic` | Superadmin/Admin global; Kursmanager/Dozent nur zugewiesene Kurse; Support nur freigegebene Basiszahlen. |
| `data_requests.manage`, `exports.create` | Superadmin/Admin; Support nur sofern ausdrücklich für den Fall berechtigt. Export enthält nur zulässige Felder und wird auditiert. |
| `withdrawals.manage` | Superadmin/Admin und für die Fallbearbeitung freigegebener Support; daraus folgt keine Berechtigung zur Erstattung oder Änderung des Zahlungsstatus. |
| `self.read`, `self.edit`, `learning.use`, `orders.read_own`, `certificates.read_own`, `newsletter.manage_own` | Teilnehmerrolle; immer kombiniert mit der Prüfung der eigenen Identität und bei Lerninhalten eines gültigen Grants. |

### 6.3.1 Erstattungen und Gutschriften

1. **Vorschlag oder Ausführung.** Support mit `refunds.propose` erfasst im Bestellbild einen Erstattungs**vorschlag**: Betrag, Grund und Notiz, aber kein Geldbewegung und kein Beleg. Erst `refunds.manage` (Admin/Superadmin) führt ihn mit frischer Bestätigung aus.
2. **Vorher prüfen.** Die Bestellansicht zeigt bezahlt, bereits zurückgezahlt und noch erstattbar. Die Summe aller offenen und bestätigten Erstattungen darf den bestätigten Zahlbetrag nie übersteigen — der Datenbank-Trigger lehnt es zusätzlich ab (`REFUND_EXCEEDS_PAYMENT`). Positionen können gezielt erstattet werden; die Aufteilung muss den Betrag ergeben.
3. **Nach dem Geld.** Eine Überweisungserstattung ist mit dem Ausführen bestätigt, eine Karten-/Providererstattung bleibt `pending`, bis die Anbieter-Referenz vorliegt. Ein Fehlversuch wird als `failed` gebucht und gibt die Kapazität wieder frei; es entsteht kein Beleg.
4. **Korrekturbeleg.** Je bestätigter Erstattung entsteht genau eine Gutschrift im eigenen Nummernkreis (`TB-GS-JJJJ-NNNNNN`) mit Bezug auf die Ursprungsrechnung. Sie ist ein Dokument aus eingefrorenen Snapshots, enthält ausschließlich Bruttobeträge und ist im Konto („Rechnungen & Gutschriften“) sowie für `orders.read` abrufbar. Die Bestätigungsmail nennt die Gutschriftnummer.
5. **Zugang ist eine eigene Entscheidung.** Nach der Erstattung wird ausdrücklich entschieden: **behalten** (dokumentierte Kulanz), **vorläufig sperren** (Frage offen; lässt sich zurücknehmen) oder **entziehen** (endgültig). Ohne Entscheidung bleibt der Zugang, wie er ist — die Datenbank verweigert sogar den Entzug ohne dokumentierte Entscheidung. Andere Käufe und manuelle Grants bleiben unberührt.
6. **Nicht automatisch stornieren.** Eine erstattete Bestellung bleibt mit ihrem Zahlnachweis erhalten (`payment_state = refunded`); die Stornierung ist ein anderer Vorgang und für erstattete Bestellungen nicht der Weg.

Jede dieser Berechtigungen ist ein separater Datenbankeintrag. Der Katalog wird versioniert in Migrationen/Seed-Daten gepflegt; unerkannte Schlüssel sind kein Freifahrtschein. Änderungen der Zuweisungen erfolgen nur durch Superadmins, entziehen betroffenen Sitzungen unverzüglich ihre bisherige Autorisierung und erzeugen ein Audit-Ereignis. Die genaue Datenprojektion für Support und Berichte wird pro Endpunkt festgelegt und negativ getestet.

## 6.4 Akademieangaben und Website bearbeiten

1. Unter **Akademie/Anbieter** verantwortliche Person, vollständige rechtliche Anbieterbezeichnung, ladungsfähige Anschrift, Kontakt und weitere erforderliche Angaben eintragen. Soufian Charrak ist als vom Auftraggeber genannte verantwortliche Person vorgesehen. Eine Rechtsform oder Adresse wird nicht automatisch ergänzt. Änderungen relevanter Angaben sperren neue Verkäufe bis zur erneuten Prüfung und Freigabe; bereits eingegangene Zahlungsvorgänge werden weiter bearbeitet.
2. Unter **Website** eine Seite oder einen Seitenentwurf wählen, Überschriften, Texte, Bilder, Banner, Buttons und SEO-Angaben bearbeiten. Medien müssen freigegeben sein. Navigations- und Footer-Einträge werden gesondert gepflegt.
3. Unter **Rechtliches** geprüfte Fassungen von Impressum, Datenschutz, Widerruf, AGB und Zahlungsinformationen eintragen. Das Impressum übernimmt die verantwortliche Person und geprüfte Anbieterangaben als unveränderlichen Veröffentlichungssnapshot und gibt diese aus. Zunächst als Entwurf speichern, fachlich prüfen lassen und erst dann veröffentlichen. Alte akzeptierte Fassungen bleiben als Beleg erhalten.
4. Neue Unterseiten werden als Entwurf erstellt, geprüft und anschließend veröffentlicht. Vorschau ist keine Veröffentlichung. Die Verkaufsfreigabe bleibt gesperrt, wenn notwendige rechtliche Angaben oder Freigaben fehlen.
5. Bewertungen nur veröffentlichen, wenn sie echt sind und die erforderliche Freigabe/Nutzungsgrundlage vorliegt. Aus der Referenzseite keine fremden Logos, Texte oder Bilder ohne Erlaubnis übernehmen.

Die Seitenbausteine verwenden sichere Inhaltsblöcke. Beliebige Skripte, unkontrollierte HTML-Ausführung und das Hinterlegen von Secrets im Website-Editor sind nicht vorgesehen.

## 6.5 Eine Ausbildung anlegen und pflegen

**Heute verfügbar, nur für Testdaten:** Nach Anmeldung und MFA unter **Mein Konto → Kursverwaltung** einen Entwurf öffnen und in einem angelegten Kapitel **Lehrinhalte → Inhaltsbaustein hinzufügen** wählen. Textabsätze, Überschriften, Aufzählungen und Links lassen sich anlegen, bearbeiten und einzeln löschen. Links müssen mit `https://` beginnen oder ein interner Pfad wie `/kurse` sein; in der Entwurfsvorschau werden sie nicht geöffnet. Über eine freie Positionsnummer kann ein Baustein verschoben werden. Bei mehreren Seiten lädt **Weitere Inhalte laden** die nächste Seite. Wird ein Konflikt angezeigt, Eingaben bei Bedarf zunächst sichern und **Inhalte neu laden** bestätigen; dabei können ungespeicherte Änderungen verloren gehen. Das Löschen eines Kapitels ist erst möglich, wenn alle zugehörigen Bausteine entfernt sind. Weitere Details und Grenzen stehen in [07](07-entwicklung.md#73-erster-ausschnitt-von-phase-2-kursentwürfe).

**Freigeben (heute verfügbar, nur für Admin/Superadmin mit `courses.publish`):** In der Kursdetailansicht zeigt der Block **Veröffentlichung** den Status, die Blockerliste des offenen Entwurfs und den Verlauf. Voraussetzungen sind mindestens ein Modul, mindestens ein Kapitel, Inhalte in jedem Kapitel, passende Sollzahlen, ein Untertitel und eine Gesamtdauer bzw. Kapiteldauern. Eine Version mit geplanten Prüfungen je Kapitel bleibt gesperrt (`EXAMS_NOT_IMPLEMENTED`), solange es kein Prüfungssystem gibt – das ist Absicht. Nach leerer Blockerliste Sichtbarkeit wählen (**öffentlich** im Katalog oder **nicht gelistet**), **Identität für die Freigabe bestätigen** (Passwort + App-Code/Wiederherstellungscode, gilt fünf Minuten) und **Veröffentlichen**. Veröffentlicht wird ausschließlich der Kurstext (Titel, Untertitel, Beschreibung, Dauer); Module, Kapitel, Lehrinhalte, Prüfungen und Preise erscheinen öffentlich nicht. Die veröffentlichte Version ist danach unveränderlich: Über **Neue Entwurfsversion anlegen** entsteht eine Kopie mit neuen IDs, die nach erneuter Freigabe die alte Fassung ersetzt. **Veröffentlichung zurücknehmen** ist gesperrt, solange ein aktives Produkt den Kurs nutzt, und nicht möglich für die letzte veröffentlichte Fassung. Eine technische Veröffentlichung ersetzt keine fachliche, rechtliche oder urheberrechtliche Freigabe der Inhalte.

**Die folgenden Schritte beschreiben weiterhin den geplanten Zielzustand, nicht bereits verfügbare Funktionen:**

1. **Ausbildungen → Neu**: Titel, Untertitel, Beschreibung, Lernziele, Dauer, Voraussetzungen, Sichtbarkeit und Titelbild als Entwurf anlegen. Ein Kurs ist noch kein Produkt und hat zunächst keinen Verkaufspreis; verfügbar sind heute Titel, Untertitel, Beschreibung, Sichtbarkeit, geplante Abschlussregel und Sollzahlen.
2. In der Kursbaum-Ansicht Module, Kapitel und Inhaltsblöcke in der gewünschten Reihenfolge anlegen. Inhalte können Text, Bilder, freigegebene Dateien oder geschützte Videos referenzieren. Der Editor zeigt Prüfungen am zugehörigen Kapitel/Modul/Kurs.
3. Für die erste Fitnesstrainer-B-Lizenz werden 14 Module, insgesamt 42 Kapitel und zwei Prüfungen je Kapitel hinterlegt. Jede der 84 Prüfungen ist für den Abschluss verpflichtend und zieht drei Fragen, jede Frage hat vier Antworten mit genau einer richtigen; für das Bestehen sind alle drei korrekt. Ein Kapitel wird nach Bestehen seiner beiden Prüfungen automatisch als abgeschlossen markiert. Pro Prüfung mindestens drei geprüfte Fragen, für zwei vollständig unterschiedliche Sets mindestens sechs. Erklärungen sind fachlich zu prüfen und werden Teilnehmenden erst nach bestandenem Versuch gezeigt.
4. Für die erste Ausbildung die automatische Zertifizierung aktivieren und eine freigegebene Zertifikatsvorlage sowie die Abschlussregel für alle 84 Prüfungen wählen. Die mögliche FernUSG-/ZFU-Pflicht für die konkrete Version dokumentieren und fachlich prüfen lassen. Das System darf keine Zulassung behaupten, die nicht nachgewiesen und zur Anzeige freigegeben wurde.
5. Unter **Produkte/Preise** ein Einzelprodukt mit Kurs bzw. ein Paket mit mehreren unterschiedlichen Kursen anlegen. Eine Variante ist ein eigenes Produkt; Preis, Währung, Aktionszeitraum, Steuerkategorie und ggf. Zugangsdauer stammen aus konfigurierten Datensätzen. Die Steuer- und Rechtsprüfung erfolgt vor Verkauf.
6. Veröffentlichungscheck ausführen: Der technische Check (Struktur, Sollzahlen, Untertitel, Dauer) ist im Freigabeblock sichtbar; Prüfungszahlen, Fragen, Materialien und Abschlussbedingungen sind weiterhin manuell zu prüfen. Erst eine berechtigte globale Rolle mit `courses.publish` und frischer Bestätigung veröffentlicht. Kommerzieller Verkauf benötigt zusätzlich eine aktive Produkt-/Preisversion (siehe 6.6a) und alle Go-live-Freigaben.
7. Nach Veröffentlichung ist die Version unveränderlich. Für Änderungen eine neue Entwurfsversion erzeugen und erneut freigeben; die bisherige Fassung bleibt bis dahin öffentlich. Bestehende Teilnehmende (künftige Lernplattform) lernen weiter in ihrer ursprünglichen Version. Eine individuelle Migration benötigt eine dokumentierte fachliche Entscheidung und sichere Zuordnung von Fortschritt und Prüfungen.
8. **Duplizieren** kopiert die Kursstruktur einschließlich Prüfungen/Fragen in einen neuen Entwurf, mit neuen IDs; freigegebene Medien können referenziert werden. Preise, Käufe, Ergebnisse und Teilnehmer werden nicht kopiert. **Deaktivieren** oder **Archivieren** beendet neue Verkäufe, entzieht bestehende Zugänge und bereits verbindlich bestellte Inhalte aber nicht automatisch; archivierte Kurse erscheinen nicht mehr öffentlich.

## 6.6 Bestellungen, Kunden und Zugänge

### 6.3.2 Rückbuchungen (Streitfälle)

1. **Was ein Fall ist.** Meldet die Bank oder der Anbieter eine Rückbuchung, nimmt sie das Geld zurück — nicht wir. Im Bestellbild unter **Rückbuchung (Streitfall)** werden Anbieter-Referenz, Betrag, Stand (`angekündigt`, `offen`, `gewonnen`, `verloren`, `geschlossen`) und Grund erfasst. Derselbe Fall zweimal eingetragen aktualisiert ihn, statt eine zweite Zeile anzulegen; ein abweichender Betrag wird abgelehnt (`DISPUTE_AMOUNT_MISMATCH`).
2. **Verloren heißt: Geld ist weg.** Ein verlorener Fall setzt die Bestellung auf **zurückgebucht**, mindert den noch erstattbaren Betrag und lässt sich nicht stornieren. Der Zahlnachweis bleibt erhalten; es entsteht **keine** Gutschrift, weil wir kein Geld zurückgezahlt haben. Gewinnt der Widerspruch später doch, wird die Bestellung wieder **bezahlt** — aber nur, wenn kein anderer verlorener Fall bleibt.
3. **Zugang bleibt eine eigene Entscheidung.** Nach einem entschiedenen Fall lässt sich festhalten, ob der Zugang bleibt oder entzogen wird. Bei laufendem Verfahren ist das gesperrt (`DISPUTE_NOT_RESOLVED`), bei gewonnenem Fall ist ein Entzug nicht vorgesehen (`DISPUTE_WON`).
4. **Nichts automatisch.** Ein Streitfall löst weder Erstattung noch Kontosperre aus. Prüfliste: `/admin/disputes` (offene zuerst).

### 6.3.3 Widerrufe

1. **Der Eingang.** Über die öffentliche Seite `/widerruf` kann jede Person ohne Konto widerrufen. Die Antwort ist immer dieselbe — unabhängig davon, ob die angegebene Bestellnummer existiert. Das ist Absicht: sonst wäre die Seite eine Auskunftsstelle für fremde Bestellungen.
2. **Die Bestätigung.** Die eingetragene Adresse erhält sofort eine Bestätigung mit Datum und Uhrzeit. Sie ist der Fristbeleg und wird nicht manuell nachgereicht.
3. **Die Adresse bestätigen lassen.** In `/admin/widerrufe` **Bestätigungslink senden** — die Person öffnet ihn selbst. Erst danach lässt sich eine Bestellung zuordnen, und nur, wenn deren Käuferadresse zur bestätigten Adresse passt (`WITHDRAWAL_ORDER_MISMATCH`). Vorher ist die Zuordnung gesperrt (`WITHDRAWAL_IDENTITY_REQUIRED`).
4. **Entscheiden.** Annehmen oder Ablehnen verlangt einen Grund (Kurzcode, z. B. `within_deadline`) und verschickt das Ergebnis. Ein abgeschlossener Vorgang ist endgültig.
5. **Nicht erstattet.** Ein angenommener Widerruf erstattet nichts. Die Erstattung erfolgt bewusst getrennt in der Bestellung durch `refunds.manage` (Abschnitt 6.3.1). So bleibt sichtbar, wer wann Geld zurückgegeben hat.
6. **Sichtbarkeit.** `withdrawals.manage` (Admin/Superadmin und freigegebener Support) erlaubt die Fallbearbeitung, aber keine Erstattung und keine Änderung des Zahlungsstatus.

> **Umsetzungsstand:** Umgesetzt sind die Bestellübersicht und -detailansicht (`/admin/bestellungen`), die Bestätigung von Zahlungseingängen, das Stornieren mit Grund, Gutscheine, Rechtsfassungen, manuelle Zugangsvergabe samt Entzug, Erstattungen mit Gutschriften, Rückbuchungen (Streitfälle) und die Widerrufsfallbearbeitung (`/admin/widerrufe`). Kundenverwaltung und ein automatischer Provider-Abgleich (Streitfälle per Webhook) bleiben Zielzustand.

- **Bestellungen** nach Nummer, Zeitraum und Zahlungszustand suchen. Eine ausstehende oder fehlgeschlagene Zahlung ist nicht bezahlt. Rechnungen und erlaubte Details nur an Berechtigte ausgeben.
- **Kunden** nach Name/E-Mail suchen, Kontostatus und zulässige Lernstände einsehen, Daten im erlaubten Umfang korrigieren oder Konto sperren. Vor- und Nachname bleiben auch nach einer Korrektur verpflichtend; das Leeren beider Felder ist nur im autorisierten Datenschutz-Löschprozess beim anonymisierten Konto vorgesehen. Eine Sperrung beendet laufende Sitzungen.
- Bei Gastbestellungen sind Teilnehmername und Rechnungs-Ansprechperson getrennt erfasst. Der Zugang gehört zum Konto der bestätigten E-Mail; bei einem bestehenden Konto wird dessen Profilname für spätere Zertifikate verwendet und nicht durch Rechnungsdaten überschrieben. Eine gesonderte Geschenk- oder Mehrteilnehmerzuordnung ist zunächst nicht vorgesehen.
- **Manueller Zugang:** berechtigte Rolle wählt Kunde, Kursversion, Start, optionales Ende und Grund. Der Vorgang wird als `manual` protokolliert. Er erzeugt keine Zahlung und darf nicht als bezahlter Kauf dargestellt werden.
- **Zugangsquelle entziehen:** betroffene Quelle auswählen und begründen. Ein anderer gültiger Kauf oder ein manuell gewährter Grant kann den Zugang weiterhin ermöglichen; die Übersicht muss dies vor Bestätigung zeigen.
- **Erstattung:** zahlungsbezogenen Vorgang auswählen, Betrag/Grund prüfen, frische Anmeldung bestätigen und tatsächliches Providerergebnis abwarten. Anschließend für jede betroffene Zugangsquelle ausdrücklich über Beibehaltung/Sperrung/Entzug entscheiden. Eine Teilerstattung eines Pakets ist nicht automatisch einem Kurs zugeordnet.
- Jede manuelle Änderung an Rollen, Kunden, Preisen und Zugängen ist mit Akteur, Zeitpunkt, Aktion und zulässigen vorherigen/nachherigen Statuswerten nachvollziehbar. Audit enthält keine Passwörter, Tokens oder unnötigen Rechnungsadressen.

## 6.6a Produkte und Preise (aktivierbar und, bei freigegebenem Verkauf, buchbar)

**Mein Konto → Produkte** ist ausschließlich für Admin und Superadmin mit `products.manage` sichtbar. Kursmanager und Dozenten haben keinen Zugang. Bestellungen, Checkout und Zahlungen sind implementiert (siehe 6.6b); ein aktiviertes Produkt mit aktivem Preis ist buchbar, sobald der Verkauf freigeschaltet ist.

1. Unter **Produkte** einen Entwurf mit SKU, Produktart (Einzelprodukt oder Paket), Titel, optionaler Variante und Beschreibung anlegen. SKU und Produktart sind danach unveränderlich. Ein Einzelprodukt nimmt höchstens einen Kurs auf; ein Paket darf mehrere verschiedene Kurse enthalten.
2. Kurszuordnungen in der Detailansicht pflegen; eine optionale Zugangsdauer überschreibt später die Kursvorgabe. Solange der Entwurf unvollständig ist, lässt er sich speichern – die Aktivierung bleibt dann mit einer Blockerliste gesperrt.
3. Preiszeiträume als Entwurf hinzufügen: Brutto in Euro mit höchstens zwei Nachkommastellen, Beginn als **UTC**-Zeit `JJJJ-MM-TTTHH:MM`, optional Ende, optional ein Aktionspreis mit Betrag, Beginn und Ende innerhalb der Gültigkeit. Es werden keinerlei Steuersätze berechnet oder vorgeschlagen; `tax_category` ist nur eine Kennung, deren Bedeutung fachlich und rechtlich festzulegen ist.
4. Änderungen und Löschungen benötigen den aktuellen Stand (Revision). Bei „zwischenzeitlich geändert“ die Seite neu laden und die Eingaben erneut prüfen. Ein Produkt lässt sich erst löschen, wenn alle Preiszeiträume entfernt sind.
5. **Aktivieren:** Der Block **Aktivierung** in der Produktdetailansicht zeigt die Blockerliste (`SINGLE_COURSE_COUNT`, `BUNDLE_COURSE_COUNT`, `COURSE_NOT_PUBLISHED`, `NO_PRICE`, `NO_CURRENT_PRICE`, `MISSING_DESCRIPTION`). Erst wenn sie leer ist, lässt sich das Produkt aktivieren – nur Admin/Superadmin mit `products.manage` und mit einer höchstens fünf Minuten alten Bestätigung (Passwort + App-Code oder Wiederherstellungscode). Ein Einzelprodukt braucht genau einen **veröffentlichten** Kurs, ein Paket mindestens zwei verschiedene; ein noch nicht veröffentlichter Kurs blockiert die Aktivierung.
6. **Preiszeitraum aktivieren:** In der Preistabelle den gewünschten Entwurf aktivieren (`prices.manage`, frische Bestätigung). Das geht nur bei aktivem Produkt und positivem Bruttobetrag. Aktive Zeiträume desselben Produkts und derselben Währung dürfen sich **nicht** überschneiden; die Datenbank erzwingt das und die API antwortet `409 PRICE_OVERLAP`. Ein aktiver Zeitraum wird über **Zurückziehen** beendet, nicht gelöscht.
7. **Deaktivieren:** Ein Produkt lässt sich erst deaktivieren, wenn keine aktiven Preiszeiträume mehr bestehen. Ein Kurs, der in einem aktiven Produkt verwendet wird, kann nicht zurückgenommen werden (`409 COURSE_STILL_IN_ACTIVE_PRODUCT`); zuerst das Produkt deaktivieren. Aktivierte Produkte und Preise erscheinen im Shop unter `/buchen`, sobald zusätzlich der Verkauf freigeschaltet ist (siehe unten). `tax_category` bleibt eine Kennung ohne Steuersatz; Steuer- und Rechtsfreigabe stehen weiterhin aus.

### Verkauf, Rechnungen und Zahlungen (6.6b)

- **Verkauf freischalten:** unter **Mein Konto → Zahlung & Recht** (`settings.manage`) Rechnungssteller, Bankverbindung, Zahlungsziel und die drei Rechtsfassungen pflegen; bestellen lässt sich erst, wenn je Art eine Fassung aktiv ist. Danach die Verkaufssperre aufheben.
- **Bestellungen:** `/admin/bestellungen` (`orders.read`) listet wartende, bezahlte, zu prüfende und stornierte Bestellungen. Die Detailansicht zeigt Positionen-Snapshot, Rechnung, Adresse und die akzeptierten Rechtsfassungen.
- **Zahlungseingang bestätigen:** `orders.manage` und frische Bestätigung; Referenz (z. B. Kontoauszug) und optionale Notiz sind Pflicht. Erst dann wird die Bestellung bezahlt, der Lernzugang entsteht und die Bestellbestätigung versendet. Der Zugang wird nur zu veröffentlichten Kursen geschaltet.
- **Rechnungs-PDF:** In der Bestelldetailansicht steht bei bezahlten Bestellungen ein Button „Rechnung (PDF) ansehen“. Er liefert genau das ausgestellte Dokument; eine Änderung an Rechnungssteller oder Bankverbindung verändert bereits ausgestellte Rechnungen nicht. Für unbezahlte Überweisungsbestellungen existiert das Dokument, aber kein Download — es wäre sonst ein Beleg für eine Zahlung, die nicht eingegangen ist.
- **Stornieren:** Grund angeben. Aktiver Zugang muss vorher entzogen werden; ein reservierter Gutschein wird automatisch freigegeben. Rechnungsnummern bleiben erhalten und werden nicht neu verwendet.
- **Gutscheine:** Codes mit Prozent- oder Festrabatt, Gültigkeitsfenster und Einlöselimit; ein Gutschein je Bestellung, Rabatt nie über den Warenwert hinaus.
- **Manuelle Zugänge** bleiben getrennt vom Kauf: Sie erzeugen keine Bestellung und keine Rechnung.

## 6.7 Zertifikate

Unter **Zertifikate** eine Vorlage mit zulässigen Text-, Logo- und Bildbausteinen anlegen, Teilnehmername, Kurs, Abschlussdatum und Nummer als sichtbare Platzhalter auswählen und eine Version veröffentlichen. Für die erste Ausbildung wird diese Vorlage mit automatischer Zertifizierung verknüpft. Sobald alle 84 Prüfungen bestanden sind, wird der Vor- und Nachname aus dem Kundenprofil ohne weiteres Zutun in die Vorlage eingesetzt und das Zertifikat als PDF im Kundenkonto bereitgestellt. Die Teilnehmerin oder der Teilnehmer erhält eine Benachrichtigung, sobald das PDF verfügbar ist. Urkunden entstehen nur aus einem nachgewiesenen Abschluss und den tatsächlichen Bedingungen dieser Kursversion; andere Kurse können eigene Regeln und Vorlagen haben.

Vor- und Nachname sind bei der Kontoerstellung und beim Gastkauf Pflicht. Externe Altbestände mit fehlenden Namen werden vor einer Übernahme vervollständigt; es werden keine erfundenen Namen auf Zertifikaten verwendet. Ist die PDF-Erzeugung technisch fehlgeschlagen, ist dies in der Auftragsübersicht sichtbar und wird wiederholt. Ein später geänderter Profilname verändert ein bereits ausgestelltes PDF nicht automatisch.

Eine ausgestellte Urkunde kann durch Berechtigte begründet widerrufen werden. Eine Neuausstellung verwendet einen bestehenden nachgewiesenen Abschluss, eine neue Nummer und ersetzt die alte Urkunde nachvollziehbar; höchstens eine Urkunde desselben Abschlusses ist gleichzeitig gültig. Die öffentliche Prüfung zeigt nur die freigegebenen minimalen Angaben und den aktuellen Gültigkeitsstatus. Eine Urkunde behauptet keine staatliche Anerkennung, sofern diese nicht tatsächlich nachgewiesen und rechtlich freigegeben ist.

## 6.8 Newsletter und E-Mail-Vorlagen

1. Unter **Newsletter/Empfänger** ausschließlich Empfänger mit bestätigter aktueller Einwilligung als versandberechtigt betrachten. Anfragen, Abmeldungen, Bounces und Beschwerden bleiben unterscheidbar.
2. Interessen oder ein Segment nach zulässigen Kriterien wählen. Ein Kauf oder eine Segmentzugehörigkeit ersetzt keine Newsletter-Einwilligung.
3. Betreff, Vorschautext und Inhalt als Entwurf erstellen. Darstellung und Abmeldelink prüfen, intern freigeben und gegebenenfalls einen Versandzeitpunkt planen. Vor jedem Einzelversand prüft das System die Einwilligung erneut.
4. Versand- und, falls vorhanden, Zustellfehler prüfen. Öffnungs-/Klicktracking ist zunächst ausgeschaltet und darf nur nach separater datenschutzrechtlicher Freigabe und Einwilligung aktiviert werden.
5. Unter **E-Mail-Vorlagen** Transaktionsnachrichten versioniert bearbeiten. Aktivierung und Passwortreset enthalten nur einen zeitlich begrenzten Link, niemals ein unverschlüsseltes Passwort. Vorlagenvariablen sind vorgegeben; Testversand erfolgt nur an zulässige Adressen und ohne Offenlegung echter Kunden-Geheimnisse.

## 6.9 Routine und Eskalation

Täglich bzw. gemäß Betriebsplan offene Zahlungs-/Fulfillmentfälle, fehlgeschlagene Jobs, ausstehende Rechnungen, Rückerstattungen und Supportanfragen prüfen. Backup- und WAL-Status sowie Mail-Bounces überwachen. Bei Sicherheitsvorfall oder unklarer Zahlung keine Datensätze manuell als bezahlt markieren; den [Wiederherstellungs- und Incident-Ablauf](04-sicherheit-und-betrieb.md#46-backup--und-wiederherstellungskonzept) nutzen. Vor einem Livegang alle [Freigabesperren](05-phasen-und-tests.md#56-go-live-sperren) gemeinsam mit den zuständigen Fachleuten abarbeiten.
