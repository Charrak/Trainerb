'use client';
import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../lib/api';
import { Arrow, Field, Notice } from './site';

// `idPrefix` keeps field ids unique when more than one confirmation form is on
// the same page (course detail shows staff and release actions).
export function Reauth({ mfa, idPrefix = 'reauth' }: { mfa: boolean; idPrefix?: string }) {
  const [password, setPassword] = useState(''); const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false); const [message, setMessage] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      await api('/auth/reauth', 'POST', { password, ...(mfa ? (recovery ? { recovery_code: code } : { code }) : {}) });
      setPassword(''); setCode(''); setMessage('Identität bestätigt. Du kannst die geschützte Aktion jetzt innerhalb von fünf Minuten ausführen.');
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="stack-form">
    <Field label="Aktuelles Passwort" id={`${idPrefix}-password`}><input id={`${idPrefix}-password`} type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required/></Field>
    {mfa && <><div className="choice-row"><label><input type="radio" checked={!recovery} onChange={() => {setRecovery(false); setCode('');}}/> App-Code</label><label><input type="radio" checked={recovery} onChange={() => {setRecovery(true); setCode('');}}/> Wiederherstellungscode</label></div><Field label={recovery ? 'Wiederherstellungscode' : 'Aktueller App-Code'} id={`${idPrefix}-code`} hint="Bereits verwendete Codes können nicht erneut genutzt werden. Warte gegebenenfalls auf den nächsten Code."><input id={`${idPrefix}-code`} autoComplete="one-time-code" inputMode={recovery ? 'text' : 'numeric'} value={code} onChange={e => setCode(e.target.value)} required aria-describedby={`${idPrefix}-code-hint`}/></Field></>}
    <Notice message={error}/><Notice kind="success" message={message}/><button disabled={busy} className="button button-secondary">{busy ? 'Bitte warten …' : 'Identität bestätigen'} <Arrow/></button>
  </form>;
}
