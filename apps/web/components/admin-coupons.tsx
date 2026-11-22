'use client';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage, type Profile } from '../lib/api';
import { euro } from '../lib/shop';
import { centsFromInput } from '../lib/products';
import { Arrow, Field, Notice } from './site';
import { Reauth } from './reauth';

type Coupon = {
  id: string;
  code: string;
  type: 'percent' | 'fixed';
  value: string;
  currency: string | null;
  valid_from: string;
  valid_until: string | null;
  max_redemptions: number | null;
  active: boolean;
  redeemed: number;
  product_ids: string[];
};
const canManage = (profile: Profile) => profile.permissions.includes('coupons.manage') &&
  profile.roles.some(role => role === 'admin' || role === 'superadmin');

/** Prozentwerte werden in Basispunkten gespeichert: 10 % = 1000. */
const basisPoints = (percent: string) => {
  const value = Number(percent.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0 || value > 100) return null;
  return Math.round(value * 100);
};
const percentOf = (value: string) => (Number(value) / 100).toLocaleString('de-DE', { maximumFractionDigits: 2 });

export function AdminCoupons() {
  const [profile, setProfile] = useState<Profile>();
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [type, setType] = useState<'percent' | 'fixed'>('percent');
  const [value, setValue] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [max, setMax] = useState('');
  const [active, setActive] = useState(false);
  const allowed = !!profile && canManage(profile);

  async function load() {
    setBusy(true); setError('');
    try {
      setCoupons((await api<{ data: Coupon[] }>('/admin/coupons')).data);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setCoupons([]);
      setError(errorMessage(e));
    } finally { setBusy(false); }
  }
  useEffect(() => {
    let current = true;
    api<Profile>('/me').then(user => { if (current) setProfile(user); })
      .catch(e => { if (current) setError(errorMessage(e)); });
    void load();
    return () => { current = false; };
  }, []);

  const amount = type === 'percent' ? basisPoints(value) : centsFromInput(value);
  const canSubmit = !!amount && /^[A-Za-z0-9_-]{4,64}$/.test(code.trim());

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!amount) { setError('Bitte einen gültigen Wert angeben.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await api('/admin/coupons', 'POST', {
        code: code.trim(), type, value: type === 'percent' ? amount : Number(amount), active,
        ...(validUntil ? { valid_until: new Date(validUntil + 'T23:59:59').toISOString() } : {}),
        ...(max ? { max_redemptions: Number(max) } : {}),
      });
      setCode(''); setValue(''); setValidUntil(''); setMax(''); setActive(false);
      setNotice('Gutschein gespeichert. Ob er gilt, entscheidet zusätzlich seine Aktivierung und der Laufzeitraum.');
      await load();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function toggle(coupon: Coupon) {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/admin/coupons/${coupon.id}/active`, 'POST', { active: !coupon.active });
      setNotice(coupon.active ? 'Gutschein deaktiviert.' : 'Gutschein aktiviert.');
      await load();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <div className="account-page content-width">
      <div className="dashboard-title">
        <div>
          <span className="eyebrow">VERWALTUNG</span>
          <h1>Gutscheine</h1>
          <p>Codes gelten nur bei Aktivierung, im Laufzeitraum und innerhalb der Einlösegrenze. Beträge werden nie geschätzt.</p>
        </div>
        <Link href="/admin/bestellungen">Bestellungen <Arrow/></Link>
      </div>
      <Notice message={error} />
      <Notice kind="success" message={notice} />
      {!profile && !error && <p role="status">Berechtigung wird geprüft …</p>}
      {profile && !allowed && <p>Für diese Seite fehlt die Berechtigung zur Gutscheinverwaltung.</p>}
      {allowed && (
        <>
          <form className="dashboard-card stack-form" onSubmit={create}>
            <h2>Neuen Gutschein anlegen</h2>
            <Field label="Code" id="coupon-code" hint="4–64 Zeichen aus Buchstaben, Ziffern, - und _. Der Code wird in Großbuchstaben gespeichert.">
              <input id="coupon-code" value={code} maxLength={64} onChange={e => setCode(e.target.value)} aria-describedby="coupon-code-hint" required/>
            </Field>
            <div className="field-row">
              <Field label="Art" id="coupon-type">
                <select id="coupon-type" value={type} onChange={e => setType(e.target.value as 'percent' | 'fixed')}>
                  <option value="percent">Prozentrabatt</option>
                  <option value="fixed">Fester Betrag</option>
                </select>
              </Field>
              <Field label={type === 'percent' ? 'Rabatt in Prozent' : 'Betrag in Euro'} id="coupon-value">
                <input id="coupon-value" inputMode="decimal" value={value} maxLength={12} onChange={e => setValue(e.target.value)} required/>
              </Field>
            </div>
            <div className="field-row">
              <Field label="Gültig bis (optional)" id="coupon-until">
                <input id="coupon-until" type="date" value={validUntil} onChange={e => setValidUntil(e.target.value)}/>
              </Field>
              <Field label="Einlösungen insgesamt (optional)" id="coupon-max">
                <input id="coupon-max" type="number" min={1} max={1000000} value={max} onChange={e => setMax(e.target.value)}/>
              </Field>
            </div>
            <label><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)}/> Sofort aktiv</label>
            <button className="button button-primary" disabled={busy || !canSubmit}>
              {busy ? 'Bitte warten …' : 'Gutschein speichern'} <Arrow/>
            </button>
            <p className="muted">Ohne Produktauswahl gilt der Code für alle Produkte. Eine Beschränkung auf einzelne Produkte ist derzeit nicht vorgesehen.</p>
          </form>
          <section className="dashboard-card">
            <h2>Identität für Änderungen bestätigen</h2>
            <Reauth mfa idPrefix="coupon-reauth" />
          </section>
          <section className="dashboard-card">
            <h2>Bestehende Gutscheine</h2>
            {!coupons.length ? <p>Noch keine Gutscheine angelegt.</p> : (
              <div className="table-wrap">
                <table>
                  <caption>Höchstens die letzten 100 Gutscheine.</caption>
                  <thead><tr><th scope="col">Code</th><th scope="col">Rabatt</th><th scope="col">Zeitraum</th><th scope="col">Einlösungen</th><th scope="col">Status</th><th scope="col">Aktion</th></tr></thead>
                  <tbody>{coupons.map(coupon => (
                    <tr key={coupon.id}>
                      <th scope="row">{coupon.code}</th>
                      <td>{coupon.type === 'percent' ? percentOf(coupon.value) + ' %' : euro(coupon.value)}</td>
                      <td>
                        ab {new Date(coupon.valid_from).toLocaleDateString('de-DE')}
                        {coupon.valid_until ? ` bis ${new Date(coupon.valid_until).toLocaleDateString('de-DE')}` : ', unbefristet'}
                      </td>
                      <td>{coupon.redeemed}{coupon.max_redemptions ? ` von ${coupon.max_redemptions}` : ''}</td>
                      <td>{coupon.active ? 'Aktiv' : 'Inaktiv'}</td>
                      <td>
                        <button className="inline-button" disabled={busy} onClick={() => void toggle(coupon)}>
                          {coupon.active ? 'Deaktivieren' : 'Aktivieren'}
                        </button>
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
            <button className="button button-secondary" disabled={busy} onClick={() => void load()}>Stand aktualisieren</button>
          </section>
        </>
      )}
    </div>
  );
}
