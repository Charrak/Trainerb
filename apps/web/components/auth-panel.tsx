'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { normalizePersonName } from '@trainerb/contracts';
import { api, errorMessage } from '../lib/api';
import { Arrow, Field, Notice } from './site';

export function AuthPanel({ mode, showTestInbox = false }: { mode: 'login' | 'register'; showTestInbox?: boolean }) {
  const router = useRouter();
  const [first, setFirst] = useState(''); const [last, setLast] = useState('');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    if (mode === 'register') {
      const firstResult = normalizePersonName(first), lastResult = normalizePersonName(last);
      if (!firstResult.ok) { setError(`Vorname: ${firstResult.message}`); return; }
      if (!lastResult.ok) { setError(`Nachname: ${lastResult.message}`); return; }
    }
    setBusy(true);
    try {
      if (mode === 'register') {
        await api('/auth/register', 'POST', { email, first_name: first, last_name: last });
        setDone(true);
      } else {
        const result = await api<{ status: string }>('/auth/login', 'POST', { email, password });
        setPassword('');
        if (result.status === 'authenticated') router.push('/konto');
        else if (result.status === 'mfa_enrollment_required') router.push('/mfa/einrichten');
        else if (result.status === 'mfa_required') router.push('/mfa');
        else throw new Error('Unexpected login status');
      }
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <div className="auth-card">
    <div className="card-topline"><span>DEIN PERSÖNLICHER BEREICH</span><span className="card-spark" aria-hidden="true">✳</span></div>
    <div className="auth-tabs" aria-label="Kontozugang"><Link aria-current={mode === 'login' ? 'page' : undefined} href="/anmelden">Anmelden</Link><Link aria-current={mode === 'register' ? 'page' : undefined} href="/registrieren">Konto erstellen</Link></div>
    {done ? <div className="completed-card"><span className="success-icon" aria-hidden="true">✓</span><h2>Fast geschafft.</h2><p>Wenn eine Aktivierung möglich ist, erhältst du eine E-Mail mit den nächsten Schritten. Bitte prüfe auch deinen Spam-Ordner.</p>{showTestInbox && <p><Link className="button button-secondary button-full" href="/test-postfach">Test-Postfach öffnen <Arrow/></Link></p>}<Link className="text-link" href="/anmelden">Zur Anmeldung <Arrow/></Link></div> : <>
      <h2>{mode === 'login' ? 'Willkommen zurück.' : 'Schön, dass du da bist.'}</h2>
      <p className="card-description">{mode === 'login' ? 'Melde dich mit deiner E-Mail und deinem Passwort an.' : 'Ein paar Angaben genügen für deinen persönlichen Zugang.'}</p>
      <form onSubmit={submit} noValidate={false}>
        {mode === 'register' && <div className="field-row"><Field label="Vorname" id="first-name"><input id="first-name" value={first} onChange={e => setFirst(e.target.value)} autoComplete="given-name" placeholder="Dein Vorname" required/></Field><Field label="Nachname" id="last-name"><input id="last-name" value={last} onChange={e => setLast(e.target.value)} autoComplete="family-name" placeholder="Dein Nachname" required/></Field></div>}
        <Field label="E-Mail-Adresse" id="email"><input id="email" type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" placeholder="du@beispiel.de" required/></Field>
        {mode === 'login' && <Field label="Passwort" id="password"><input id="password" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" placeholder="Dein Passwort" required/></Field>}
        {mode === 'login' && <div className="form-link-row"><Link href="/passwort-vergessen">Passwort vergessen?</Link></div>}
        <Notice message={error}/>
        <button type="submit" className="button button-primary button-full" disabled={busy}>{busy ? 'Bitte warten …' : mode === 'login' ? 'Anmelden' : 'Konto erstellen'} <Arrow/></button>
      </form>
      <div className="card-bottom">{mode === 'login' ? <>Noch kein Konto? <Link href="/registrieren">Jetzt registrieren</Link><br/><Link className="secondary-card-link" href="/aktivierung-erneut">Aktivierungslink erneut anfordern</Link></> : <>Bereits registriert? <Link href="/anmelden">Jetzt anmelden</Link></>}{showTestInbox && <><br/><Link className="secondary-card-link" href="/test-postfach">Test-Postfach öffnen</Link></>}</div>
    </>}
  </div>;
}
