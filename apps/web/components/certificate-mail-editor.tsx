'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Notice } from './site';
import { Reauth } from './reauth';

type Version = { id: string; version: number; subject_template: string; body_text_template: string };
type State = { published: Version | null; draft: Version | null };
const titles: Record<string, string> = {
  certificate_ready: 'Urkundenbenachrichtigung',
  activation: 'Kontoaktivierung',
  password_reset: 'Passwort zurücksetzen',
  email_change: 'E-Mail-Wechsel bestätigen',
  password_changed: 'Passwortänderung',
  email_changed_old: 'E-Mail-Änderung melden',
  order_placed: 'Bestellung per Überweisung',
  card_order_placed: 'Bestellung per Kartenzahlung',
  order_paid: 'Zahlungsbestätigung',
  refund_confirmed: 'Erstattung',
  dispute_opened: 'Streitfall',
  withdrawal_received: 'Widerrufseingang',
  withdrawal_verify: 'Widerruf verifizieren',
  withdrawal_decided: 'Widerrufsentscheidung',
  checkout_email_verify: 'Gastadresse bestätigen',
  newsletter_campaign: 'Newsletter-Versandrahmen',
  newsletter_confirm: 'Newsletter-Bestätigung',
  course_expiry: 'Kurszugang läuft ab',
};
export function MailLibrary() {
  const [keys, K] = useState<string[]>([]),
    [chosen, S] = useState('activation'),
    [error, E] = useState('');
  useEffect(() => {
    api<{ keys: string[] }>('/admin/mail-templates')
      .then((r) => K(r.keys))
      .catch((e) => E(errorMessage(e)));
  }, []);
  return (
    <>
      <section className="content-width">
        <label>
          Mailvorlage auswählen
          <select value={chosen} onChange={(e) => S(e.target.value)}>
            {keys.map((k) => (
              <option key={k} value={k}>
                {titles[k] ?? k}
              </option>
            ))}
          </select>
        </label>
        <Notice message={error} />
      </section>
      {keys.includes(chosen) && <CertificateMailEditor key={chosen} templateKey={chosen} />}
    </>
  );
}
const preview = (s: string) =>
  s.replace(/\{\{([a-z_]+)\}\}/g, (_, k: string) =>
    k === 'first_name'
      ? 'Mila'
      : k.endsWith('_url')
        ? '[synthetischer Link]'
        : k === 'code'
          ? '000000'
          : `[Beispiel: ${k}]`,
  );
export function CertificateMailEditor({ templateKey }: { templateKey?: string }) {
  const path = templateKey ? '/admin/mail-templates/' + templateKey : '/admin/certificate-mail-template';
  const [state, setState] = useState<State>(),
    [subject, setSubject] = useState(''),
    [text, setText] = useState('');
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, reload] = useState(0);
  useEffect(() => {
    let active = true;
    setState(undefined);
    setError('');
    api<State>(path)
      .then((s) => {
        if (!active) return;
        setState(s);
        const v = s.draft ?? s.published;
        setSubject(v?.subject_template ?? '');
        setText(v?.body_text_template ?? '');
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [revision, path]);
  const base = state?.draft ?? state?.published;
  const changed = base && (subject !== base.subject_template || text !== base.body_text_template);
  async function change(publish: boolean) {
    if (!base || !state) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const v = await api<Version>(
        path + (publish ? '/publish' : '/drafts'),
        'POST',
        publish ? { draft_id: base.id } : { base_id: base.id, subject, text },
      );
      setState(publish ? { published: v, draft: null } : { ...state, draft: v });
      setSubject(v.subject_template);
      setText(v.body_text_template);
      setNotice(
        publish
          ? templateKey
            ? 'Neue Version für künftige Nachrichten freigegeben.'
            : 'Neue Version für künftige Urkundenmails freigegeben.'
          : 'Entwurf gespeichert. Der Versand verwendet weiterhin die freigegebene Version.',
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="account-page content-width">
      <div className="dashboard-title">
        <div>
          <span className="eyebrow">MAILVORLAGEN</span>
          <h1>{titles[templateKey ?? 'certificate_ready']}</h1>
          <p>
            Änderungen gelten nur für künftig eingeplante Nachrichten. Bereits vorbereitete Nachrichten behalten ihre
            Version.
          </p>
        </div>
        <Link href="/konto">Zum Konto</Link>
      </div>
      <Notice message={error} />
      <Notice kind="success" message={notice} />
      {error && (
        <button disabled={busy} onClick={() => reload((r) => r + 1)}>
          Gespeicherten Stand laden (Eingaben verwerfen)
        </button>
      )}
      {!state && !error && <p role="status">Vorlage wird geladen …</p>}
      {state && base && (
        <>
          <section className="dashboard-card">
            <h2>Text bearbeiten</h2>
            <p>
              Im Versand: Version {state.published?.version ?? '–'} · Entwurf: {state.draft?.version ?? '–'}
            </p>
            <p>
              Nur Klartext ohne eingegebene Webadressen. Vorhandene fachliche Platzhalter im jeweiligen Feld
              beibehalten. Links und Codes nicht an andere Wörter anhängen.
            </p>
            <div className="stack-form">
              <label>
                Betreff
                <input disabled={busy} maxLength={160} value={subject} onChange={(e) => setSubject(e.target.value)} />
              </label>
              <label>
                Nachricht
                <textarea
                  disabled={busy}
                  rows={6}
                  maxLength={6000}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
              <button disabled={busy || !changed || !text.trim() || !subject.trim()} onClick={() => change(false)}>
                Als Entwurf speichern
              </button>
            </div>
          </section>
          <section className="dashboard-card">
            <h2>Vorschau mit Beispieldaten</h2>
            <strong>{preview(subject)}</strong>
            <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{preview(text)}</p>
            <button disabled={busy || !!changed || !state.draft} onClick={() => change(true)}>
              Gespeicherten Entwurf für den Versand freigeben
            </button>
          </section>
          <section className="dashboard-card">
            <h2>Identität für Änderungen bestätigen</h2>
            <Reauth mfa />
          </section>
        </>
      )}
    </div>
  );
}
