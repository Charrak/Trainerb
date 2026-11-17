'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { api, errorMessage } from '../lib/api';
import { Arrow, Field, Notice } from './site';

type Setup = { secret: string; otpauth_uri: string };
export function MfaForm({ enroll }: { enroll: boolean }) {
  const router = useRouter();
  const raw = useSearchParams().get('weiter');
  const next = raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\') && raw.length <= 200 ? raw : null;
  const [setup, setSetup] = useState<Setup>(); const [qr, setQr] = useState('');
  const [code, setCode] = useState(''); const [recovery, setRecovery] = useState(false);
  const [codes, setCodes] = useState<string[]>(); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function start() {
    setBusy(true); setError('');
    try {
      const result = await api<Setup>('/auth/mfa/enrollment/start', 'POST', {});
      setSetup(result);
      try { setQr(await QRCode.toDataURL(result.otpauth_uri, { margin: 1, width: 180, errorCorrectionLevel: 'M' })); } catch { /* manual secret remains available */ }
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (enroll) {
        const result = await api<{ recovery_codes: string[] }>('/auth/mfa/enrollment/confirm', 'POST', { code });
        setCode(''); setQr(''); setSetup(undefined); setCodes(result.recovery_codes);
      } else {
        await api('/auth/mfa/challenge', 'POST', recovery ? { recovery_code: code } : { code });
        setCode(''); router.push(next ?? '/konto');
      }
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <div className="standalone-card narrow-card"><span className="section-kicker">ZWEI-FAKTOR-ANMELDUNG</span>
    <h1>{codes ? 'Gut aufbewahren.' : enroll ? 'Ein zusätzlicher Schutz.' : 'Noch ein Schritt.'}</h1>
    {codes ? <><p>Speichere diese Wiederherstellungscodes an einem sicheren Ort. Sie werden nur einmal angezeigt und sind jeweils einmal verwendbar.</p><ul className="recovery-list">{codes.map(code => <li key={code}><code>{code}</code></li>)}</ul><Link href={next ?? '/konto'} className="button button-primary button-full">Weiter <Arrow/></Link></> : <>
      <p>{enroll ? 'Für den Verwaltungsbereich ist eine Authenticator-App erforderlich. Richte sie jetzt ein.' : 'Gib den aktuellen Code aus deiner Authenticator-App oder einen Wiederherstellungscode ein.'}</p>
      {enroll && !setup && <><Notice message={error}/><button className="button button-primary button-full" onClick={start} disabled={busy}>{busy ? 'Bitte warten …' : 'Einrichtung starten'} <Arrow/></button></>}
      {setup && <div className="setup-box"><p>Scanne den QR-Code mit deiner Authenticator-App oder gib den Schlüssel manuell ein.</p>{qr && <img src={qr} alt="QR-Code für die Einrichtung der Authenticator-App" width="180" height="180"/>}<div><small>Einrichtungsschlüssel</small><code className="secret-code">{setup.secret}</code></div></div>}
      {(!enroll || setup) && <form onSubmit={submit}>
        {!enroll && <div className="choice-row"><label><input type="radio" checked={!recovery} onChange={() => { setRecovery(false); setCode(''); }}/> App-Code</label><label><input type="radio" checked={recovery} onChange={() => { setRecovery(true); setCode(''); }}/> Wiederherstellungscode</label></div>}
        <Field label={recovery ? 'Wiederherstellungscode' : 'Sechsstelliger Code'} id="mfa-code"><input id="mfa-code" type="text" inputMode={recovery ? 'text' : 'numeric'} autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} required/></Field>
        <Notice message={error}/><button className="button button-primary button-full" disabled={busy}>{busy ? 'Bitte warten …' : 'Bestätigen'} <Arrow/></button>
      </form>}
    </>}
  </div>;
}
