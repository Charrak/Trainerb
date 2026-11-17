'use client';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage, type Profile } from '../lib/api';
import { Arrow, Field, Notice } from './site';
import { Reauth } from './reauth';

type User = { id: string; first_name: string; last_name: string; email: string; status: string; roles: string[] };
type Page = { data: User[]; next_cursor: string | null };
const roles: Record<string, string> = { participant:'Teilnehmer', support:'Kundenservice', instructor:'Dozent', course_manager:'Kursmanager', admin:'Administrator', superadmin:'Superadministrator' };
export function AdminUsers() {
  const [profile, setProfile] = useState<Profile>(); const [users, setUsers] = useState<User[]>([]); const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<User>(); const [selected, setSelected] = useState<string[]>([]); const [reason, setReason] = useState('staff_change'); const [busy, setBusy] = useState(false);
  async function load(next?: string) {
    setError('');
    try { const page = await api<Page>(`/admin/users${next ? `?cursor=${encodeURIComponent(next)}` : ''}`); setUsers(current => next ? [...current, ...page.data] : page.data); setCursor(page.next_cursor); }
    catch (e) { setError(errorMessage(e)); } finally { setLoading(false); }
  }
  useEffect(() => { let active = true; api<Profile>('/me').then(user => { if (active) { setProfile(user); if (user.permissions.includes('users.read')) void load(); else { setError('Für diesen Bereich fehlt die Berechtigung.'); setLoading(false); } } }).catch(e => { if (active) { setError(errorMessage(e)); setLoading(false); } }); return () => { active = false; }; }, []);
  function open(user: User) { setTarget(user); setSelected(user.roles); setError(''); setMessage(''); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!target) return; setBusy(true); setError(''); setMessage('');
    try {
      await api(`/admin/users/${target.id}/roles`, 'PUT', { role_keys: selected, reason_code: reason });
      setMessage('Die Rollen wurden gespeichert. Betroffene Sitzungen wurden abgemeldet.'); setTarget(undefined); await load();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <div className="account-page content-width"><div className="dashboard-title"><div><span className="eyebrow"><span className="eyebrow-line"/> VERWALTUNG</span><h1>Nutzer<span className="accent-dot">.</span></h1><p>Konten einsehen und berechtigte Rollen nachvollziehbar verwalten.</p></div><div className="title-actions">{profile?.permissions.includes('courses.read') && <Link className="button button-secondary" href="/admin/kurse">Kursverwaltung <Arrow/></Link>}{profile?.permissions.includes('products.manage') && <Link className="button button-secondary" href="/admin/produkte">Produkte <Arrow/></Link>}<Link className="button button-outline" href="/konto">← Mein Konto</Link></div></div>
    <Notice message={error}/><Notice kind="success" message={message}/>{loading ? <p>Konten werden geladen …</p> : profile?.permissions.includes('users.read') && <div className="admin-grid"><section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">KONTOVERWALTUNG</span><h2>Nutzerübersicht</h2><p>Es werden nur die erforderlichen Kontodaten angezeigt.</p></div></div><div className="table-wrap"><table><thead><tr><th>Name</th><th>E-Mail</th><th>Status</th><th>Rollen</th>{profile.permissions.includes('roles.manage') && <th><span className="sr-only">Aktion</span></th>}</tr></thead><tbody>{users.map(user => <tr key={user.id}><td>{user.first_name} {user.last_name}</td><td>{user.email}</td><td>{user.status}</td><td>{user.roles.map(r => roles[r] || r).join(', ')}</td>{profile.permissions.includes('roles.manage') && <td><button className="inline-button" onClick={() => open(user)}>Bearbeiten</button></td>}</tr>)}</tbody></table></div>{cursor && <button className="button button-secondary" onClick={() => void load(cursor)}>Weitere laden <Arrow/></button>}</section>
      {profile.permissions.includes('roles.manage') && <><section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">SICHERHEIT</span><h2>Identität bestätigen</h2><p>Rollenänderungen erfordern eine frische Bestätigung mit Passwort und zweitem Faktor.</p></div></div><Reauth mfa/></section>
      {target && <section className="dashboard-card" id="rollen"><div className="section-heading"><div><span className="section-kicker">ROLLEN ÄNDERN</span><h2>{target.first_name} {target.last_name}</h2><p>Die Teilnehmerrolle bleibt erhalten. Alle Sitzungen dieses Kontos werden abgemeldet.</p></div></div><form onSubmit={save} className="stack-form"><fieldset className="role-list"><legend>Rollen</legend>{Object.entries(roles).map(([key, label]) => <label key={key}><input type="checkbox" checked={selected.includes(key)} disabled={key === 'participant'} onChange={e => setSelected(current => e.target.checked ? [...current, key] : current.filter(x => x !== key))}/>{label}</label>)}</fieldset><Field label="Grund der Änderung" id="role-reason"><select id="role-reason" value={reason} onChange={e => setReason(e.target.value)}><option value="staff_change">Personaländerung</option><option value="correction">Korrektur</option><option value="security">Sicherheit</option></select></Field><button className="button button-primary" disabled={busy}>{busy ? 'Bitte warten …' : 'Rollen speichern'} <Arrow/></button><button type="button" className="inline-button" onClick={() => setTarget(undefined)}>Abbrechen</button></form></section>}</>}
    </div>}</div>;
}
