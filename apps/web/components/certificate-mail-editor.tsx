'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Notice } from './site';
import { Reauth } from './reauth';

type Version = { id: string; version: number; subject_template: string; body_text_template: string };
type State = { published: Version | null; draft: Version | null };
const path = '/admin/certificate-mail-template';
export function CertificateMailEditor() {
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
  }, [revision]);
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
          ? 'Neue Version für künftige Urkundenmails freigegeben.'
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
          <h1>Urkundenbenachrichtigung</h1>
          <p>
            Diese Nachricht verweist auf die Urkunde im Konto. Änderungen betreffen weder das PDF noch bereits
            eingeplante Mails.
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
              Nur Klartext. Der Platzhalter <code>{'{{first_name}}'}</code> wird beim Versand durch den Vornamen
              ersetzt.
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
            <h2>Vorschau mit Testnamen</h2>
            <strong>{subject.replaceAll('{{first_name}}', 'Mila')}</strong>
            <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {text.replaceAll('{{first_name}}', 'Mila')}
            </p>
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
