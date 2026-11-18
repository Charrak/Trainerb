'use client';
import { useEffect, useState } from 'react';
import { api, ApiError, errorMessage, type Profile } from '../lib/api';
import { dateTime, euro, disputeStatusLabels, type AdminDispute } from '../lib/shop';
import { Notice } from './site';

const canRead = (profile: Profile) => profile.permissions.includes('refunds.manage');

/**
 * Chargeback cases.
 *
 * One list, because a case that nobody looks at is the actual risk: the bank's
 * deadline runs whether or not we opened a detail page. Rows say *where* the
 * state came from — a signature-verified provider report or a case staff typed
 * in — so the list never pretends to know more than it does. Nothing here
 * decides access; that stays a separate, explicit decision.
 */
export function AdminDisputes() {
  const [profile, setProfile] = useState<Profile>();
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState<AdminDispute[]>([]);
  const [totals, setTotals] = useState<{ open: number; lost: number }>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const allowed = !!profile && canRead(profile);

  async function load(next = status) {
    setError(''); setLoading(true);
    try {
      const query = next ? `?status=${encodeURIComponent(next)}` : '';
      const page = await api<{ data: AdminDispute[]; totals: { open: number; lost: number } }>(
        `/admin/disputes${query}`);
      setRows(page.data); setTotals(page.totals);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setProfile(undefined);
      setError(errorMessage(e));
    } finally { setLoading(false); }
  }

  useEffect(() => {
    let active = true;
    api<Profile>('/me').then(user => {
      if (!active) return; setProfile(user);
      if (!canRead(user)) { setError('Für diesen Bereich fehlt die Berechtigung.'); setLoading(false); return; }
      void load();
    }).catch(e => { if (active) { setError(errorMessage(e)); setLoading(false); } });
    return () => { active = false; };
    // The filter is applied through `load`; the initial load is deliberately once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="account-page content-width">
    <div className="dashboard-title"><div><span className="eyebrow"><span className="eyebrow-line"/> GESCHÜTZTE VERWALTUNG</span>
      <h1>Streitfälle<span className="accent-dot">.</span></h1>
      <p>Rückbuchungen der Zahlungsanbieter, mit Frist und Herkunft.
        {totals ? ` ${totals.open} offen · ${totals.lost} verloren.` : ''}</p></div></div>
    <div className="course-feedback"><Notice message={error}/></div>
    {loading ? <p className="muted">Streitfälle werden geladen …</p> : allowed && <>
      <section className="dashboard-card"><div className="section-heading"><div>
        <span className="section-kicker">ÜBERSICHT</span><h2>Fälle</h2>
        <p>Nur für Administration und Superadministration sichtbar. Eine Rückbuchung entzieht keinen Zugang —
          darüber entscheidet ein Mensch im Fall.</p></div></div>
        <div className="choice-row" role="group" aria-label="Statusfilter">
          {['', 'warning', 'open', 'won', 'lost', 'closed'].map(value => <label key={value || 'all'}>
            <input type="radio" checked={status === value} onChange={() => { setStatus(value); void load(value); }}/>
            {value === '' ? 'Alle' : disputeStatusLabels[value]}</label>)}
        </div>
        {!rows.length ? <p className="muted">Keine Streitfälle in dieser Auswahl.</p> : <div className="draft-list">
          {rows.map(row => <div className="draft-row" key={row.id}>
            <div><strong>{row.order_number} · {row.buyer_email ?? 'ohne Adresse'}</strong>
              <span>{dateTime(row.opened_at)} · {disputeStatusLabels[row.status] ?? row.status}
                {' '}· {euro(row.amount_cents)} {row.currency}
                {' '}· {row.sync_source === 'webhook' ? 'Anbietermeldung' : 'manuell erfasst'}
                {row.reason_code ? ` · ${row.reason_code.replace(/_/g, ' ')}` : ''}</span></div>
            <a className="status-chip" href={`/admin/bestellungen/${row.order_id}`}>Bestellung öffnen</a>
          </div>)}
        </div>}
      </section>
      <p className="muted">Offene Fälle werden über den Anbieter-Webhook nachgeführt; ein Status, der von der
        Anbietermeldung abweicht, erscheint als neuer Eintrag in der Bestellung und im Audit-Protokoll.</p>
    </>}
  </div>;
}
