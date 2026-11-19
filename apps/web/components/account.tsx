'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { normalizePersonName } from '@trainerb/contracts';
import { api, errorMessage, isBackoffice, type Profile } from '../lib/api';
import { Arrow, Field, Notice, Shield } from './site';
import { Reauth } from './reauth';

export function Account() {
  const router = useRouter(); const [profile, setProfile] = useState<Profile>();
  const [first, setFirst] = useState(''); const [last, setLast] = useState('');
  const [currentPassword, setCurrentPassword] = useState(''); const [newPassword, setNewPassword] = useState('');
  const [newEmail, setNewEmail] = useState(''); const [loadError, setLoadError] = useState('');
  const [profileError, setProfileError] = useState(''); const [profileSuccess, setProfileSuccess] = useState('');
  const [emailError, setEmailError] = useState(''); const [emailSuccess, setEmailSuccess] = useState('');
  const [passwordError, setPasswordError] = useState(''); const [busy, setBusy] = useState('');
  useEffect(() => { let alive = true; api<Profile>('/me').then(user => {
    if (alive) { setProfile(user); setFirst(user.first_name); setLast(user.last_name); }
  }).catch(e => { if (alive) setLoadError(errorMessage(e)); }); return () => { alive = false; }; }, []);
  async function updateProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setProfileError(''); setProfileSuccess('');
    const a = normalizePersonName(first), b = normalizePersonName(last);
    if (!a.ok) { setProfileError(`Vorname: ${a.message}`); return; }
    if (!b.ok) { setProfileError(`Nachname: ${b.message}`); return; }
    setBusy('profile');
    try { const user = await api<Profile>('/me', 'PATCH', { first_name: first, last_name: last }); setProfile(user); setFirst(user.first_name); setLast(user.last_name); setProfileSuccess('Deine Angaben wurden gespeichert.'); }
    catch (e) { setProfileError(errorMessage(e)); } finally { setBusy(''); }
  }
  async function updatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPasswordError('');
    if (Array.from(newPassword).length < 12 || new TextEncoder().encode(newPassword).length > 1024) { setPasswordError('Das neue Passwort muss mindestens 12 Zeichen und darf höchstens 1.024 UTF-8-Bytes lang sein.'); return; }
    setBusy('password');
    try { await api('/me/password', 'PUT', { current_password: currentPassword, new_password: newPassword }); setCurrentPassword(''); setNewPassword(''); router.push('/anmelden'); }
    catch (e) { setPasswordError(errorMessage(e)); } finally { setBusy(''); }
  }
  async function updateEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setEmailError(''); setEmailSuccess(''); setBusy('email');
    try { await api('/me/email-change/request', 'POST', { new_email: newEmail }); setEmailSuccess('Wenn die Änderung möglich ist, erhältst du einen Bestätigungslink an die neue Adresse.'); setNewEmail(''); }
    catch (e) { setEmailError(errorMessage(e)); } finally { setBusy(''); }
  }
  async function logout() {
    setBusy('logout'); setLoadError('');
    try { await api('/auth/logout', 'POST', {}); router.push('/anmelden'); }
    catch (e) { setLoadError(errorMessage(e)); setBusy(''); }
  }
  if (!profile) return <section className="simple-page content-width"><div className="standalone-card narrow-card"><h1>Dein Konto.</h1>{loadError ? <><Notice message={loadError}/><Link href="/anmelden" className="text-link">Zur Anmeldung <Arrow/></Link></> : <p>Dein Konto wird geladen …</p>}</div></section>;
  return <div className="account-page content-width"><div className="dashboard-title"><div><span className="eyebrow"><span className="eyebrow-line"/> DEIN PERSÖNLICHER BEREICH</span><h1>Hallo, <em>{profile.first_name}.</em></h1><p>Schön, dass du da bist. Hier verwaltest du deinen persönlichen Zugang.</p></div><button className="button button-outline" onClick={logout} disabled={!!busy}>{busy === 'logout' ? 'Bitte warten …' : 'Abmelden'}</button></div>
    <Notice message={loadError}/><div className="dashboard-grid"><aside className="account-sidebar"><div className="sidebar-avatar">{Array.from(profile.first_name)[0]?.toUpperCase()}</div><strong>{profile.first_name} {profile.last_name}</strong><span>{profile.email}</span><div className="sidebar-divider"/><nav aria-label="Kontobereiche"><a href="#profil">Mein Profil <Arrow/></a><a href="#sicherheit">Sicherheit <Arrow/></a><a href="#email-wechsel">E-Mail ändern <Arrow/></a><Link href="/konto/kurse">Meine Ausbildungen <Arrow/></Link><Link href="/konto/urkunden">Meine Urkunden <Arrow/></Link><Link href="/konto/bestellungen">Bestellungen <Arrow/></Link><Link href="/konto/rechnungen">Rechnungen &amp; Gutschriften <Arrow/></Link><Link href="/warenkorb">Warenkorb <Arrow/></Link>{profile.permissions.includes('orders.read') && (profile.roles.includes('admin') || profile.roles.includes('superadmin')) && <Link href="/admin/bestellungen">Bestellungen (Verwaltung) <Arrow/></Link>}{profile.permissions.some(p => ['reports.read_all','reports.read_assigned','reports.read_basic'].includes(p)) && <Link href="/admin/kennzahlen">Kurskennzahlen <Arrow/></Link>}{profile.permissions.includes('operations.read') && <Link href="/admin/mailauftraege">Mailaufträge <Arrow/></Link>}{profile.permissions.includes('mail.manage') && <Link href="/admin/urkundenmail">Urkundenmail bearbeiten <Arrow/></Link>}{profile.permissions.includes('audit.read') && <Link href="/admin/protokoll">Auditprotokoll <Arrow/></Link>}{profile.permissions.includes('certificates.manage') && <Link href="/admin/urkunden">Urkundenverwaltung <Arrow/></Link>}{profile.permissions.includes('settings.manage') && <Link href="/admin/commerce">Zahlung &amp; Recht <Arrow/></Link>}{profile.permissions.includes('refunds.manage') && <Link href="/admin/streitfaelle">Streitfälle <Arrow/></Link>}{profile.permissions.includes('withdrawals.manage') && <Link href="/admin/widerrufe">Widerrufe <Arrow/></Link>}{profile.permissions.includes('courses.read') && <Link href="/admin/kurse">Kursverwaltung <Arrow/></Link>}{profile.permissions.includes('products.manage') && <Link href="/admin/produkte">Produkte <Arrow/></Link>}{profile.permissions.some(p => p === 'users.read' || p === 'users.read_limited') && <Link href="/admin/kunden">Kundenverwaltung <Arrow/></Link>}{profile.permissions.includes('users.read') && <Link href="/admin">Nutzerverwaltung <Arrow/></Link>}</nav><div className="sidebar-foot"><Shield/> Dein Konto</div></aside>
      <div className="account-content"><section className="dashboard-card" id="profil"><div className="section-heading"><div><span className="section-kicker">01 / PERSÖNLICH</span><h2>Dein Profil</h2><p>Diese Angaben gehören zu deinem persönlichen Konto.</p></div><span className="section-icon">↗</span></div>
        <form onSubmit={updateProfile} className="stack-form"><div className="field-row"><Field label="Vorname" id="profile-first"><input id="profile-first" autoComplete="given-name" value={first} onChange={e => setFirst(e.target.value)} required/></Field><Field label="Nachname" id="profile-last"><input id="profile-last" autoComplete="family-name" value={last} onChange={e => setLast(e.target.value)} required/></Field></div><Field label="E-Mail-Adresse" id="profile-email"><input id="profile-email" value={profile.email} disabled/></Field><Notice message={profileError}/><Notice kind="success" message={profileSuccess}/><button className="button button-primary" disabled={!!busy}>{busy === 'profile' ? 'Bitte warten …' : 'Änderungen speichern'} <Arrow/></button></form>
      </section>
      <section className="dashboard-card" id="sicherheit"><div className="section-heading"><div><span className="section-kicker">02 / GUT GESCHÜTZT</span><h2>Sicherheit</h2><p>Für besonders sensible Änderungen bestätige zuerst deine Identität.</p></div><span className="section-icon"><Shield/></span></div><Reauth mfa={isBackoffice(profile)}/><div className="inner-divider"/><h3>Passwort ändern</h3><p className="muted">Danach wirst du auf allen Geräten abgemeldet.{isBackoffice(profile) && ' Bestätige vorher deine Identität mit Passwort und zweitem Faktor.'}</p><form onSubmit={updatePassword} className="stack-form"><div className="field-row"><Field label="Aktuelles Passwort" id="current-password"><input id="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} required/></Field><Field label="Neues Passwort" id="change-password" hint="Mindestens 12 Zeichen."><input id="change-password" type="password" autoComplete="new-password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required aria-describedby="change-password-hint"/></Field></div><Notice message={passwordError}/><button className="button button-secondary" disabled={!!busy}>{busy === 'password' ? 'Bitte warten …' : 'Passwort ändern'} <Arrow/></button></form></section>
      <section className="dashboard-card" id="email-wechsel"><div className="section-heading"><div><span className="section-kicker">03 / KONTAKT</span><h2>E-Mail ändern</h2><p>Bestätige zuerst oben deine Identität. Anschließend senden wir einen Link an die neue Adresse.</p></div><span className="section-icon">@</span></div><form onSubmit={updateEmail} className="stack-form"><Field label="Neue E-Mail-Adresse" id="new-email"><input id="new-email" type="email" autoComplete="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="du@beispiel.de" required/></Field><Notice message={emailError}/><Notice kind="success" message={emailSuccess}/><button className="button button-secondary" disabled={!!busy}>{busy === 'email' ? 'Bitte warten …' : 'Bestätigungslink senden'} <Arrow/></button></form></section>
      <section className="dashboard-card" id="lernen"><div className="section-heading"><div><span className="section-kicker">04 / LERNEN</span><h2>Deine Ausbildungen</h2><p>Freigeschaltete Inhalte, Lernfortschritt und Bestellungen.</p></div><span className="section-icon">↗</span></div><div className="title-actions"><Link className="button button-secondary" href="/konto/kurse">Meine Ausbildungen <Arrow/></Link><Link className="button button-outline" href="/konto/bestellungen">Bestellungen <Arrow/></Link><Link className="button button-outline" href="/konto/rechnungen">Rechnungen <Arrow/></Link></div></section></div>
    </div></div>;
}
