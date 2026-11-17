'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../lib/api';
import { Arrow, Field, Notice } from './site';

export function RequestLink({ kind }: { kind: 'reset' | 'activation' }) {
  const [email, setEmail] = useState(''); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [done, setDone] = useState(false);
  const reset = kind === 'reset';
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api(reset ? '/auth/password-reset/request' : '/auth/activation/request', 'POST', { email });
      setDone(true);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <div className="standalone-card narrow-card"><span className="section-kicker">SICHERER ZUGANG</span>
    <h1>{reset ? 'Passwort vergessen?' : 'Aktivierungslink anfordern.'}</h1>
    <p>{reset ? 'Kein Problem. Wir senden dir gegebenenfalls einen Link, mit dem du ein neues Passwort festlegen kannst.' : 'Gib deine E-Mail-Adresse ein, um gegebenenfalls einen neuen Aktivierungslink zu erhalten.'}</p>
    {done ? <><Notice kind="success" message="Wenn für diese Adresse ein passender Vorgang möglich ist, erhältst du eine E-Mail. Bitte prüfe auch deinen Spam-Ordner."/><Link href="/anmelden" className="text-link">Zur Anmeldung <Arrow/></Link></> : <form onSubmit={submit}>
      <Field label="E-Mail-Adresse" id="request-email"><input id="request-email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="du@beispiel.de"/></Field>
      <Notice message={error}/><button className="button button-primary button-full" disabled={busy}>{busy ? 'Bitte warten …' : 'Link anfordern'} <Arrow/></button>
    </form>}
  </div>;
}

export function TokenAction({ kind }: { kind: 'activation' | 'reset' | 'email' }) {
  const [token, setToken] = useState<string | null>(); const processed = useRef(false);
  const [password, setPassword] = useState(''); const [again, setAgain] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
  useEffect(() => {
    if (processed.current) return;
    processed.current = true;
    const secret = new URLSearchParams(window.location.hash.slice(1)).get('token');
    // Fragments never reach the server; remove the token from browser history too.
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    setToken(secret);
  }, []);
  const isEmail = kind === 'email';
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    if (!token) { setError('Dieser Link enthält keinen gültigen Bestätigungscode.'); return; }
    if (!isEmail && (Array.from(password).length < 12 || new TextEncoder().encode(password).length > 1024)) {
      setError('Das Passwort muss mindestens 12 Zeichen und darf höchstens 1.024 UTF-8-Bytes lang sein.'); return;
    }
    if (!isEmail && password !== again) { setError('Die Passwörter stimmen nicht überein.'); return; }
    setBusy(true);
    try {
      const endpoint = kind === 'activation' ? '/auth/activate' : kind === 'reset' ? '/auth/password-reset/confirm' : '/auth/email-change/confirm';
      await api(endpoint, 'POST', isEmail ? { token } : { token, password });
      setToken(null); setPassword(''); setAgain(''); setDone(true);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  const title = kind === 'activation' ? 'Konto aktivieren.' : kind === 'reset' ? 'Neues Passwort festlegen.' : 'E-Mail bestätigen.';
  return <div className="standalone-card narrow-card"><span className="section-kicker">SICHERER ZUGANG</span><h1>{title}</h1>
    <p>{isEmail ? 'Bestätige bewusst, dass du diese Adresse für dein Konto verwenden möchtest.' : 'Wähle ein persönliches Passwort. Der Link kann nur einmal verwendet werden.'}</p>
    {done ? <><Notice kind="success" message={kind === 'activation' ? 'Dein Konto ist aktiviert. Du kannst dich jetzt anmelden.' : kind === 'reset' ? 'Dein Passwort wurde geändert. Bitte melde dich erneut an.' : 'Deine E-Mail-Adresse wurde bestätigt. Bitte melde dich erneut an.'}/><Link className="text-link" href="/anmelden">Zur Anmeldung <Arrow/></Link></> : token === undefined ? <p>Lade Bestätigung …</p> : !token ? <><Notice message="Der Link ist unvollständig oder wurde bereits aus der Adresszeile entfernt. Bitte öffne die E-Mail erneut oder fordere einen neuen Link an."/><Link href={kind === 'activation' ? '/aktivierung-erneut' : kind === 'reset' ? '/passwort-vergessen' : '/konto'} className="text-link">{kind === 'email' ? 'Zurück zum Konto' : 'Neuen Link anfordern'} <Arrow/></Link></> : <form onSubmit={submit}>
      {!isEmail && <><Field label="Neues Passwort" id="new-password" hint="Mindestens 12 Zeichen. Verwende kein häufiges Passwort."><input id="new-password" type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} aria-describedby="new-password-hint" required/></Field><Field label="Passwort wiederholen" id="repeat-password"><input id="repeat-password" type="password" autoComplete="new-password" value={again} onChange={e => setAgain(e.target.value)} required/></Field></>}
      <Notice message={error}/><button className="button button-primary button-full" disabled={busy}>{busy ? 'Bitte warten …' : isEmail ? 'E-Mail bestätigen' : kind === 'activation' ? 'Konto aktivieren' : 'Passwort speichern'} <Arrow/></button>
    </form>}
  </div>;
}
