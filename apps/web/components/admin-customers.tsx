'use client';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage, type Profile } from '../lib/api';
import { Field, Notice } from './site';
import { Reauth } from './reauth';

const labels: Record<string, string> = { active: 'Aktiv', blocked: 'Gesperrt', pending_activation: 'Aktivierung ausstehend', deletion_requested: 'Löschung beantragt' };
type Customer = { id: string; first_name: string; last_name: string; email_original: string; status: string };
type Results = { data: Customer[]; has_more: boolean };

export function AdminCustomers() {
  const [profile, setProfile] = useState<Profile>();
  const [query, setQuery] = useState(''); const [filter, setFilter] = useState('');
  const [results, setResults] = useState<Results>(); const [target, setTarget] = useState<Customer>();
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [message, setMessage] = useState('');
  useEffect(() => {
    api<Profile>('/me').then(user => {
      if (user.permissions.some(p => p === 'users.read' || p === 'users.read_limited')) setProfile(user);
      else setError('Für die Kundensuche fehlt die Berechtigung.');
    }).catch(e => setError(errorMessage(e)));
  }, []);
  async function search(event: FormEvent) {
    event.preventDefault(); setBusy(true); setTarget(undefined); setResults(undefined); setMessage(''); setError('');
    try { setResults(await api<Results>('/admin/customers/search', 'POST', { query, ...(filter && { status: filter }) })); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!target) return;
    setBusy(true); setMessage(''); setError('');
    const status = target.status === 'active' ? 'blocked' : 'active';
    try {
      await api(`/admin/customers/${target.id}/status`, 'PUT', { status, reason_code: reason });
      setMessage(status === 'blocked' ? 'Konto gesperrt. Bestehende Sitzungen wurden beendet.' : 'Sperre aufgehoben. Eine neue Anmeldung ist erforderlich.');
      setTarget(undefined); setResults(undefined);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <div className="account-page content-width"><div className="dashboard-title"><div><h1>Kundenverwaltung</h1>
    <p>Teilnehmerkonten finden und den Kontostatus prüfen.</p></div><Link className="button button-secondary" href="/konto">← Mein Konto</Link></div>
    <Notice message={error}/><Notice kind="success" message={message}/>
    {!profile && !error && <p>Kundenverwaltung wird geladen …</p>}
    {profile && <div className="admin-grid"><section className="dashboard-card"><h2>Konto suchen</h2>
      <form onSubmit={search} className="stack-form"><Field label="Name oder E-Mail-Adresse" id="customer-query"><input id="customer-query"
        required minLength={2} maxLength={254} value={query} onChange={e => setQuery(e.target.value)}/></Field>
        <Field label="Kontostatus" id="customer-filter"><select id="customer-filter" value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="">Alle Status</option>{Object.entries(labels).map(([key, text]) => <option key={key} value={key}>{text}</option>)}
        </select></Field><button className="button button-secondary" disabled={busy}>Suchen</button></form>
      {results && <><h3>Suchergebnis</h3>{results.has_more && <p>Die ersten 25 Treffer werden angezeigt. Bitte grenze die Suche weiter ein.</p>}
        {!results.data.length ? <p>Kein passendes Kundenkonto gefunden.</p> : <ul className="plain-list">{results.data.map(row => <li key={row.id}>
          <strong>{row.first_name} {row.last_name}</strong> · {row.email_original} · {labels[row.status]}
          {profile.permissions.includes('users.block') && ['active', 'blocked'].includes(row.status) && <button className="inline-button" disabled={busy}
            onClick={() => { setTarget(row); setReason(''); setMessage(''); setError(''); }}>{row.status === 'active' ? 'Sperre vorbereiten' : 'Entsperrung vorbereiten'}</button>}
        </li>)}</ul>}</>}
    </section>{target && <section className="dashboard-card"><h2>{target.email_original}</h2>
      <p>{target.status === 'active' ? 'Die Kontosperre beendet alle Sitzungen. Käufe und Kurszugänge bleiben erhalten.' : 'Nach dem Entsperren kann sich die Person wieder anmelden.'}</p>
      <h3>Identität bestätigen</h3><Reauth mfa/><form className="stack-form" onSubmit={save}>
        <Field label="Grund der Änderung" id="customer-reason"><select required id="customer-reason" value={reason} onChange={e => setReason(e.target.value)}>
          <option value="">Bitte auswählen</option><option value="security">Sicherheit</option><option value="customer_request">Kundenwunsch</option><option value="correction">Korrektur</option>
        </select></Field><button className="button button-primary" disabled={busy}>{target.status === 'active' ? 'Konto sperren' : 'Konto entsperren'}</button>
        <button className="inline-button" type="button" disabled={busy} onClick={() => setTarget(undefined)}>Abbrechen</button></form>
    </section>}</div>}
  </div>;
}
