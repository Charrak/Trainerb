export const templates: Record<string, { subject: string; text: string }> = {
  activation: {
    subject: 'Aktiviere dein Konto',
    text: 'Hallo {{first_name}},\n\nbitte öffne den folgenden Link und lege dein Passwort selbst fest:\n{{activation_url}}\n\nDer Link ist 24 Stunden gültig und kann nur einmal verwendet werden. Falls du kein Konto angefordert hast, ignoriere diese Nachricht.',
  },
  password_reset: {
    subject: 'Passwort zurücksetzen',
    text: 'Hallo {{first_name}},\n\nüber diesen Link kannst du dein Passwort zurücksetzen:\n{{reset_url}}\n\nDer Link ist 30 Minuten gültig und kann nur einmal verwendet werden. Falls du das nicht angefordert hast, ignoriere diese Nachricht.',
  },
  email_change: {
    subject: 'Neue E-Mail-Adresse bestätigen',
    text: 'Hallo {{first_name}},\n\nbitte bestätige deine neue E-Mail-Adresse über diesen Link:\n{{email_change_url}}\n\nDer Link ist 30 Minuten gültig und kann nur einmal verwendet werden.',
  },
  course_expiry: {
    subject: 'Hinweis zu deinem Kurszugang',
    text: 'Hallo {{first_name}},\n\ndein aktueller Zugang zum Kurs {{course_title}} endet am {{ends_at}} Uhr (Ortszeit Berlin). Deinen Zugangsstand findest du im Konto. Dies ist keine Zahlungsaufforderung.',
  },
  newsletter_confirm: {
    subject: 'Newsletter-Anmeldung bestätigen',
    text: 'Für diese Adresse wurde der Newsletter angefordert. Thema: {{topic}}. Einwilligung: {{wording}}\n\nZum Bestätigen innerhalb von 30 Minuten öffnen und die Anmeldung bestätigen: {{confirm_url}}\nOhne Bestätigung erfolgt keine Anmeldung.',
  },
  newsletter_campaign: { subject: '{{subject}}', text: '{{body}}\n\nNewsletter abbestellen: {{leave_url}}' },
  certificate_ready: {
    subject: 'Deine Urkunde steht bereit',
    text: 'Hallo {{first_name}},\n\ndeine Urkunde steht in deinem Konto unter „Meine Urkunden“ zum Download bereit.',
  },
  password_changed: {
    subject: 'Dein Passwort wurde geändert',
    text: 'Hallo {{first_name}},\n\ndas Passwort für dein Konto wurde geändert. Falls du das nicht selbst warst, kontaktiere den Betreiber.',
  },
  card_order_placed: {
    subject: 'Bestellung {{order_number}} ist eingegangen',
    text: 'Hallo {{first_name}},\n\ndeine Bestellung {{order_number}} über {{total}} EUR wurde angelegt. Du hast Kartenzahlung gewählt. Bitte nutze dafür die Zahlungsseite deiner Bestellung. Eine zusätzliche Überweisung ist nicht erforderlich.',
  },
  order_placed: {
    subject: 'Bestellung {{order_number}} ist eingegangen',
    text: 'Hallo {{first_name}},\n\nvielen Dank für deine Bestellung {{order_number}} über {{total}} EUR.\n\nBitte überweise den Betrag unter Angabe der Referenz {{payment_reference}} auf das im Konto genannte Konto. Sobald der Zahlungseingang gebucht ist, steht dir der Inhalt in deinem Konto zur Verfügung.',
  },
  order_paid: {
    subject: 'Zahlungseingang zu {{order_number}}',
    text: 'Hallo {{first_name}},\n\nwir haben deine Zahlung zur Bestellung {{order_number}} verbucht. Dein Zugang ist jetzt in deinem Konto freigeschaltet.',
  },
  refund_confirmed: {
    subject: 'Erstattung zu {{order_number}}',
    text: 'Hallo {{first_name}},\n\nwir haben dir {{total}} EUR zur Bestellung {{order_number}} zurückerstattet. Die Gutschrift {{credit_note_number}} findest du in deinem Konto.\n\nOb ein bereits freigeschalteter Kurszugang bestehen bleibt, entscheidet unser Team und meldet sich bei Bedarf. Andere Kurse sind davon nicht betroffen.',
  },
  withdrawal_received: {
    subject: 'Dein Widerruf ist eingegangen',
    text: 'Hallo {{first_name}},\n\nwir haben deinen Widerruf am {{received_date}} um {{received_time}} Uhr (UTC) erhalten und dauerhaft dokumentiert.\n\nWir prüfen den Vorgang und melden uns mit dem Ergebnis. Ein Widerruf löst nicht automatisch eine Erstattung aus; falls eine fällig wird, erhältst du einen eigenen Beleg.\n\nBewahre diese Nachricht als Bestätigung auf.',
  },
  withdrawal_verify: {
    subject: 'Bestätige deine Adresse für den Widerruf',
    text: 'Hallo {{first_name}},\n\nbitte bestätige über diesen Link die Adresse, von der der Widerruf eingegangen ist:\n\n{{verification_url}}\n\nDer Link ist 30 Minuten gültig und kann nur einmal verwendet werden. Erst danach kann der Vorgang {{request_reference}} einer Bestellung zugeordnet werden. Falls du keinen Widerruf erklärt hast, ignoriere diese Nachricht.',
  },
  withdrawal_decided: {
    subject: 'Ergebnis zu deinem Widerruf',
    text: 'Hallo {{first_name}},\n\nzu deinem Widerruf liegt jetzt eine Entscheidung vor: {{decision}}.\n\nFalls eine Erstattung erfolgt ist, findest du die Gutschrift in deinem Konto. Bei Rückfragen antworte einfach auf diese Nachricht.',
  },
  checkout_email_verify: {
    subject: 'Bestätige deine E-Mail-Adresse für die Bestellung',
    text: 'Hallo,\n\nbitte bestätige diese E-Mail-Adresse, damit wir deine Bestellung annehmen können. Öffne dafür diesen Link:\n\n{{verify_url}}\n\nAlternativ kannst du diesen Code eingeben: {{code}}\n\nDer Link ist 30 Minuten gültig. Wenn du nichts bestellt hast, ignoriere diese Nachricht einfach.',
  },
  dispute_opened: {
    subject: 'Rückbuchung zu {{order_number}} – Frist prüfen',
    text: 'Hallo {{first_name}},\n\nzu Bestellung {{order_number}} hat der Zahlungsanbieter eine Rückbuchung gemeldet: {{amount}} EUR, Grund {{reason}}, Stand {{status}}.\n\nBitte prüfe den Fall im Backoffice unter Streitfälle. Der Zugang wurde nicht automatisch entzogen; über den Zugang entscheidet ein Mensch.\n\nDiese Nachricht ist eine interne Meldung, keine Kundenmail.',
  },
  email_changed_old: {
    subject: 'Deine Konto-E-Mail-Adresse wurde geändert',
    text: 'Hallo {{first_name}},\n\ndie E-Mail-Adresse deines Kontos wurde geändert. Falls du das nicht selbst warst, kontaktiere den Betreiber.',
  },
};
