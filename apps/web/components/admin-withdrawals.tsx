'use client';
import { useEffect, useState } from 'react';
import { api, ApiError, errorMessage, type Profile } from '../lib/api';
import { dateTime, withdrawalStatusLabels, type AdminWithdrawal } from '../lib/shop';
import { Arrow, Field, Notice } from './site';

const canHandle = (profile: Profile) => profile.permissions.includes('withdrawals.manage');

type Detail = AdminWithdrawal & { message: string | null;
  order: { id: string; order_number: string; payment_state: string; total_gross_cents: string } | null;
  processor: string | null;
  refund: { id: string; status: string; amount_cents: string } | null };

/**
 * Withdrawal cases.
 *
 * The list is FIFO, because a withdrawal has a legal clock. Every case file shows
 * what the person typed — never a guessed order — and separates three states that
 * are easy to confuse: the claim arrived, the address is proved, and the decision
 * is made. Only after the proof may staff link a real order, and even a completed
 * withdrawal does not refund: that stays a separate action on the order.
 */
export function AdminWithdrawals() {
  const [profile, setProfile] = useState<Profile>();
  const [rows, setRows] = useState<AdminWithdrawal[]>([]);
  const [totals, setTotals] = useState<{ received: number; in_progress: number }>();
  const [selected, setSelected] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState('');
  // The vocabulary comes from the API, which validates with the same list and is
  // backed by a database CHECK — the drop-down cannot invent a reason.
  const [reasons, setReasons] = useState<{ code: string; label: string; closes_without_order: boolean }[]>([]);
  const [reason, setReason] = useState('');
  const allowed = !!profile && canHandle(profile);

  async function load() {
    setError('');
    try {
      const page = await api<{ data: AdminWithdrawal[]; totals: { received: number; in_progress: number } }>(
        '/admin/withdrawal-requests');
      setRows(page.data); setTotals(page.totals);
    } catch (e) { if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setProfile(undefined);
      setError(errorMessage(e)); }
  }
  useEffect(() => {
    let active = true;
    api<Profile>('/me').then(user => {
      if (!active) return; setProfile(user);
      if (!canHandle(user)) { setError('Für diesen Bereich fehlt die Berechtigung.'); return; }
      void load();
      void api<{ data: { code: string; label: string; closes_without_order: boolean }[] }>(
        '/admin/withdrawal-requests/decision-reasons').then(page => {
          setReasons(page.data); setReason(page.data[0]?.code ?? '');
        }).catch(() => undefined);
    }).catch(e => { if (active) setError(errorMessage(e)); });
    return () => { active = false; };
  }, []);

  async function act(label: string, path: string, payload: unknown, message: string) {
    setBusy(label); setError(''); setSuccess('');
    try {
      const result = await api<Detail>(path, 'POST', payload);
      setSuccess(message); setSelected(result); void load();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(''); }
  }

  return <div className="account-page content-width">
    <div className="dashboard-title"><div><span className="eyebrow"><span className="eyebrow-line"/> GESCHÜTZTE VERWALTUNG</span>
      <h1>Widerrufe<span className="accent-dot">.</span></h1>
      <p>Erklärungen erfassen, Adresse bestätigen lassen und den Vorgang entscheiden.
        {totals ? ` ${totals.received} neu · ${totals.in_progress} in Bearbeitung.` : ''}</p></div></div>
    <Notice message={error}/><Notice message={success} kind="success"/>
    {!allowed ? <p className="muted">Nur für Administration, Superadministration und Kundenservice sichtbar.</p>
      : <div className="dashboard-grid">
        <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">EINGANG</span>
          <h2>Vorgänge</h2><p>Älteste zuerst.</p></div></div>
          {rows.length ? <ul className="plain-list">{rows.map(row => <li key={row.id}>
            <button type="button" className="button button-outline" onClick={() => void api<Detail>(`/admin/withdrawal-requests/${row.id}`)
              .then(setSelected).catch(e => setError(errorMessage(e)))}>
              {dateTime(row.submitted_at)} · {row.contact_email} · {withdrawalStatusLabels[row.status] ?? row.status}
              {row.submitted_order_number ? ` · Nr. ${row.submitted_order_number}` : ''}
            </button></li>)}</ul> : <p className="muted">Keine offenen Vorgänge.</p>}
        </section>
        <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">VORGANG</span>
          <h2>{selected ? withdrawalStatusLabels[selected.status] ?? selected.status : 'Nichts ausgewählt'}</h2></div></div>
          {!selected ? <p className="muted">Wähle links einen Vorgang.</p> : <>
            <p className="muted">{dateTime(selected.submitted_at)} · {selected.contact_email}
              {selected.customer_name ? ` · ${selected.customer_name}` : ''}</p>
            {selected.message && <p>„{selected.message}“</p>}
            <p className="muted">Angegebene Bestellnummer: {selected.submitted_order_number ?? 'keine'}
              {' '}(unbestätigte Angabe).</p>
            <p className="muted">Bestätigte Adresse: {selected.identity_verified_at
              ? dateTime(selected.identity_verified_at) : 'noch nicht bestätigt'}
              {' '}· Bestellung: {selected.order ? selected.order.order_number : 'nicht zugeordnet'}</p>

            {!selected.identity_verified_at && <form className="stack-form" onSubmit={event => {
              event.preventDefault(); void act('code', `/admin/withdrawal-requests/${selected.id}/identity-code`, {},
                'Bestätigungslink an die angegebene Adresse gesendet.'); }}>
              <button className="button button-secondary" disabled={!!busy}>
                {busy === 'code' ? 'Bitte warten …' : 'Bestätigungslink senden'}</button>
              <p className="muted">Die Personen bestätigt damit selbst, dass die Adresse ihr gehört. Ohne diesen
                Schritt lässt sich keine Bestellung zuordnen.</p>
            </form>}

            {!['completed', 'rejected'].includes(selected.status) && (() => {
              // Accepting needs the order it cancels; declining does not. The API
              // offers exactly the reasons that may close a case without one.
              const chosen = reasons.find(entry => entry.code === reason);
              const canAccept = selected.order !== null && chosen !== undefined && !chosen.closes_without_order;
              const canDecline = chosen !== undefined && (selected.order !== null || chosen.closes_without_order);
              return <form className="stack-form" onSubmit={event => {
                event.preventDefault();
                void act('decide', `/admin/withdrawal-requests/${selected.id}`,
                  { status: 'completed', decision_reason: reason }, 'Vorgang angenommen und Ergebnis mitgeteilt.'); }}>
                <Field label="Entscheidungsgrund" id="withdrawal-reason">
                  <select id="withdrawal-reason" value={reason} onChange={e => setReason(e.target.value)}>
                    {reasons.map(entry => <option key={entry.code} value={entry.code}>{entry.label}</option>)}
                  </select></Field>
                <div className="title-actions">
                  <button className="button button-primary"
                    disabled={!!busy || selected.identity_verified_at === null || !canAccept}>
                    {busy === 'decide' ? 'Bitte warten …' : 'Widerruf annehmen'}</button>
                  <button type="button" className="button button-secondary" disabled={!!busy || !canDecline}
                    onClick={() => void act('reject', `/admin/withdrawal-requests/${selected.id}`,
                      { status: 'rejected', decision_reason: reason }, 'Vorgang abgelehnt und Ergebnis mitgeteilt.')}>
                    Ablehnen</button>
                </div>
                {selected.order === null && <p className="muted">Ohne zugeordnete Bestellung lässt sich der
                  Vorgang nur ablehnen — zum Beispiel mit „Keine passende Bestellung auffindbar“.</p>}
                <p className="muted">Ein angenommener Widerruf erstattet nichts. Die Erstattung erfolgt bewusst
                  separat in der Bestellung.</p>
              </form>;
            })()}

            {['completed', 'rejected'].includes(selected.status) && <p className="muted">
              Entschieden {dateTime(selected.processed_at)} von {selected.processor ?? 'unbekannt'}
              {selected.decision_reason ? ` · ${selected.decision_reason}` : ''}.
              {selected.refund ? ` Erstattung ${selected.refund.status}.` : ' Keine Erstattung verknüpft.'}</p>}
          </>}
        </section>
      </div>}
  </div>;
}
