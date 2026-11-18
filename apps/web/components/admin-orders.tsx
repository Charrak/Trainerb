'use client';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage, type Profile } from '../lib/api';
import { dateTime, euro, paymentStateLabels, fulfillmentLabels, refundStatusLabels, refundReasons,
  type AdminOrder, type OrderDetail } from '../lib/shop';
import { Arrow, Field, Notice } from './site';
import { InvoiceDownload } from './invoices';

const canRead = (profile: Profile) => profile.permissions.includes('orders.read') &&
  profile.roles.some(role => role === 'admin' || role === 'superadmin');
const canManage = (profile: Profile) => profile.permissions.includes('orders.manage') &&
  profile.roles.some(role => role === 'admin' || role === 'superadmin');
const canConfigure = (profile: Profile) => profile.permissions.includes('settings.manage') &&
  profile.roles.some(role => role === 'admin' || role === 'superadmin');
const canRefund = (profile: Profile) => profile.permissions.includes('refunds.manage');
const canPropose = (profile: Profile) => profile.permissions.includes('refunds.propose') ||
  profile.permissions.includes('refunds.manage');
const canDecideAccess = (profile: Profile) => profile.permissions.includes('access.manage');

export function StaffInvoiceDownload({ invoiceId }: { invoiceId: string }) {
  // The staff route enforces `orders.read` on the server; the button only asks.
  return <InvoiceDownload href={`/admin/invoices/${invoiceId}/pdf`} label="Rechnung (PDF) ansehen"/>;
}

export function AdminOrders() {
  const [profile, setProfile] = useState<Profile>();
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [state, setState] = useState('awaiting');
  const [totals, setTotals] = useState<{ awaiting: number; paid: number; refunded: number }>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const allowed = !!profile && canRead(profile);
  async function load(filter = state) {
    setError('');
    try {
      const page = await api<{ data: AdminOrder[]; totals: { awaiting: number; paid: number; refunded: number } }>(
        `/admin/orders?state=${encodeURIComponent(filter)}`);
      setOrders(page.data); setTotals(page.totals);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) { setOrders([]); setProfile(undefined); }
      setError(errorMessage(e));
    } finally { setLoading(false); }
  }
  useEffect(() => {
    let active = true;
    api<Profile>('/me').then(user => {
      if (!active) return;
      setProfile(user);
      if (!canRead(user)) { setError('Für diesen Bereich fehlt die Berechtigung.'); setLoading(false); return; }
      void load();
    }).catch(e => { if (active) { setError(errorMessage(e)); setLoading(false); } });
    return () => { active = false; };
  }, []);
  return <div className="account-page content-width">
    <div className="dashboard-title"><div><span className="eyebrow"><span className="eyebrow-line"/> GESCHÜTZTE VERWALTUNG</span>
      <h1>Bestellungen<span className="accent-dot">.</span></h1><p>Zahlungseingänge buchen, stornieren und Zugänge prüfen.</p></div>
      <div className="title-actions"><Link className="button button-secondary" href="/admin/commerce">Zahlung &amp; Recht <Arrow/></Link>
        <Link className="button button-outline" href="/admin">← Nutzerverwaltung</Link></div></div>
    <div className="course-feedback"><Notice message={error}/></div>
    {loading ? <p className="muted">Bestellungen werden geladen …</p> : allowed && <>
      <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">ÜBERSICHT</span>
        <h2>Offene und bezahlte Bestellungen</h2>
        <p>{totals ? `${totals.awaiting} offen · ${totals.paid} bezahlt · ${totals.refunded} erstattet` : ''} · nur für Administration und Superadministration sichtbar.</p></div></div>
        <div className="choice-row" role="group" aria-label="Statusfilter">
          {['awaiting', 'paid', 'unlinked', 'review', 'refunded', 'cancelled', ''].map(value => <label key={value || 'all'}>
            <input type="radio" checked={state === value} onChange={() => { setState(value); void load(value); }}/>
            {value === '' ? 'Alle' : value === 'unlinked' ? 'Ohne Konto' : paymentStateLabels[value]}</label>)}
        </div>
        {!orders.length && !error ? <p className="muted">Keine Bestellungen in dieser Auswahl.</p> : <div className="draft-list">
          {orders.map(order => <Link className="draft-row" key={order.id} href={`/admin/bestellungen/${order.id}`}>
            <div><strong>{order.order_number} · {order.buyer.name || order.buyer.email}</strong>
              <span>{dateTime(order.placed_at)} · {order.payment_method === 'invoice' ? 'Rechnung' : 'Karte'}
                {order.identity_kind === 'guest' && <> · Gastkauf{!order.buyer.has_account && ' · ohne Konto'}</>}
                {' · '}{order.items.join(', ')}</span></div>
            <span className="draft-row-end"><span className="draft-badge">{euro(order.total_gross_cents)}</span>
              <span className="status-chip">{paymentStateLabels[order.payment_state] ?? order.payment_state}</span><Arrow/></span></Link>)}
        </div>}
      </section></>}
  </div>;
}

export function AdminOrderDetail({ orderId }: { orderId: string }) {
  const [profile, setProfile] = useState<Profile>();
  const [order, setOrder] = useState<OrderDetail>();
  const [error, setError] = useState(''); const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState('');
  const [reference, setReference] = useState('');
  const [decision, setDecision] = useState<'grant' | 'cancel'>('grant'), [linkNote, setLinkNote] = useState(''); const [note, setNote] = useState(''); const [reason, setReason] = useState('customer_request');
  const [reauthPassword, setReauthPassword] = useState(''); const [reauthCode, setReauthCode] = useState('');
  const [reauthNeeded, setReauthNeeded] = useState(false);
  async function load() {
    setError('');
    try { setOrder(await api<OrderDetail>(`/admin/orders/${encodeURIComponent(orderId)}`)); }
    catch (e) { setError(errorMessage(e)); }
  }
  useEffect(() => {
    let active = true;
    api<Profile>('/me').then(user => { if (active) { setProfile(user); void load(); } })
      .catch(e => { if (active) setError(errorMessage(e)); });
    return () => { active = false; };
  }, [orderId]);
  async function reauth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy('reauth'); setError('');
    try {
      await api('/auth/reauth', 'POST', { password: reauthPassword, ...(reauthCode ? { code: reauthCode } : {}) });
      setReauthPassword(''); setReauthCode(''); setReauthNeeded(false); setSuccess('Identität bestätigt. Bitte die Aktion erneut ausführen.');
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(''); }
  }
  async function run(label: string, path: string, body: unknown, message: string) {
    setBusy(label); setError(''); setSuccess('');
    try { setOrder(await api<OrderDetail>(path, 'POST', body)); setSuccess(message); }
    catch (e) {
      if (e instanceof ApiError && e.status === 403 && e.code === 'REAUTH_REQUIRED') setReauthNeeded(true);
      setError(errorMessage(e));
    } finally { setBusy(''); }
  }
  const manage = !!profile && canManage(profile);
  return <div className="account-page content-width">
    <div className="dashboard-title"><div><span className="eyebrow"><span className="eyebrow-line"/> BESTELLUNG</span>
      <h1>{order?.order_number ?? 'Bestellung'}<span className="accent-dot">.</span></h1>{order && <p>{dateTime(order.placed_at)} · {paymentStateLabels[order.payment_state]} · {fulfillmentLabels[order.fulfillment_state]}</p>}</div>
      <Link className="button button-secondary" href="/admin/bestellungen">← Alle Bestellungen</Link></div>
    <div className="course-feedback"><Notice message={error}/><Notice kind="success" message={success}/></div>
    {reauthNeeded && <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">SICHERHEIT</span>
      <h2>Identität bestätigen</h2><p>Zahlungen und Stornierungen benötigen eine frische Bestätigung.</p></div></div>
      <form onSubmit={reauth} className="stack-form"><div className="field-row">
        <Field label="Passwort" id="order-reauth-password"><input id="order-reauth-password" type="password" value={reauthPassword} onChange={e => setReauthPassword(e.target.value)} autoComplete="current-password" required/></Field>
        <Field label="App-Code" id="order-reauth-code" hint="Sechsstelliger Code aus der Authenticator-App."><input id="order-reauth-code" value={reauthCode} onChange={e => setReauthCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code"/></Field></div>
        <button className="button button-primary" disabled={!!busy}>{busy === 'reauth' ? 'Bitte warten …' : 'Identität bestätigen'} <Arrow/></button></form>
    </section>}
    {order && <div className="admin-grid">
      <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">POSITIONEN</span>
        <h2>Bestellinhalt</h2><p>Beträge und Titel sind eingefroren.</p></div><span className="status-chip">{paymentStateLabels[order.payment_state]}</span></div>
        <div className="table-wrap"><table><thead><tr><th>Produkt</th><th>Kurse</th><th>Betrag</th></tr></thead><tbody>
          {order.items.map(item => <tr key={item.product_id}><td>{item.title}{item.variant && <><br/><small>{item.variant}</small></>}</td>
            <td>{item.courses.map(course => <div key={course.course_id}>{course.title}{course.access_days ? ` (${course.access_days} Tage)` : ''}</div>)}</td>
            <td>{euro(item.total_gross_cents)}</td></tr>)}
          {order.discount_cents !== '0' && <tr><td colSpan={2}>Rabatt {order.coupon_code ? `(${order.coupon_code})` : ''}</td><td>−{euro(order.discount_cents)}</td></tr>}
        </tbody></table></div>
        <div className="summary-lines"><p className="summary-total"><span>Gesamt</span><strong>{euro(order.total_gross_cents)}</strong></p></div>
        <h3 className="detail-subheading">Rechnungsadresse</h3>
        <p className="muted">{[order.billing_snapshot.company, `${order.billing_snapshot.first_name ?? ''} ${order.billing_snapshot.last_name ?? ''}`,
          order.billing_snapshot.street, order.billing_snapshot.street_extra,
          `${order.billing_snapshot.postal_code ?? ''} ${order.billing_snapshot.city ?? ''}`, order.billing_snapshot.country]
          .filter(Boolean).join(' · ')}</p>
        {order.invoice && <div className="stack-form">
          <p className="muted">Rechnung {order.invoice.invoice_number} · {euro(order.invoice.total_gross_cents)} · fällig {order.invoice.due_at ? dateTime(order.invoice.due_at) : '–'}</p>
          {/* Support sees the document exactly as it was issued to the buyer. */}
          <StaffInvoiceDownload invoiceId={order.invoice.id}/></div>}
      </section>
      <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">AKTIONEN</span>
        <h2>Zahlungseingang buchen</h2><p>Nur buchen, wenn das Geld tatsächlich eingegangen ist.</p></div></div>
        {!manage ? <p className="muted">Für diese Aktion fehlt die Berechtigung.</p> : order.payment_state === 'awaiting' ? <>
          <form className="stack-form" onSubmit={event => { event.preventDefault(); void run('confirm', `/admin/orders/${order.id}/confirm-payment`, { reference, note }, 'Zahlungseingang gebucht und Zugang freigeschaltet.'); }}>
            <Field label="Referenz des Zahlungseingangs" id="payment-reference" hint="Bankreferenz, Kontoauszug oder Stripe-ID."><input id="payment-reference" value={reference} onChange={e => setReference(e.target.value)} maxLength={60} required/></Field>
            <Field label="Notiz (optional)" id="payment-note"><input id="payment-note" value={note} onChange={e => setNote(e.target.value)} maxLength={500}/></Field>
            <button className="button button-primary" disabled={!!busy}>{busy === 'confirm' ? 'Bitte warten …' : 'Zahlungseingang buchen'} <Arrow/></button>
          </form>
          <div className="inner-divider"/>
          <h3>Stornieren</h3><p className="muted">Ein storniertes Bestellung entzieht den zugehörigen Zugang.</p>
          <form className="stack-form" onSubmit={event => { event.preventDefault(); void run('cancel', `/admin/orders/${order.id}/cancel`, { reason }, 'Bestellung storniert und Zugang entzogen.'); }}>
            <Field label="Grund" id="cancel-reason"><select id="cancel-reason" value={reason} onChange={e => setReason(e.target.value)}>
              <option value="customer_request">Kundenwunsch</option><option value="payment_not_received">Zahlung nicht eingegangen</option>
              <option value="fraud_suspicion">Betrugsverdacht</option><option value="duplicate_order">Doppelbestellung</option></select></Field>
            <button className="button button-secondary" disabled={!!busy}>{busy === 'cancel' ? 'Bitte warten …' : 'Bestellung stornieren'}</button>
          </form>
        </> : <p className="publication-ok">Für diese Bestellung ist keine Zahlungsbuchung mehr offen.</p>}
        {manage && order.payment_state === 'paid' && order.identity_kind === 'guest' && !order.account_linked && <>
          <div className="inner-divider"/>
          <h3>Gastbestellung ohne Konto</h3>
          <p className="muted">Die Adresse dieser bezahlten Bestellung gehört zu einem gesperrten Konto. Der Zugang wurde
            bewusst nicht automatisch vergeben. Entscheide ausdrücklich.</p>
          <form className="stack-form" onSubmit={event => { event.preventDefault();
            void run('resolve', `/admin/orders/${order.id}/resolve-link`, { decision, note: linkNote },
              decision === 'grant' ? 'Zugang ausdrücklich vergeben.' : 'Bestellung storniert; Erstattung separat veranlassen.'); }}>
            <Field label="Entscheidung" id="resolve-decision"><select id="resolve-decision" value={decision}
              onChange={e => setDecision(e.target.value as 'grant' | 'cancel')}>
              <option value="grant">Trotz Sperre Zugang vergeben (Kunde hat bezahlt)</option>
              <option value="cancel">Bestellung stornieren und erstatten</option></select></Field>
            <Field label="Begründung" id="resolve-note"><input id="resolve-note" value={linkNote}
              onChange={e => setLinkNote(e.target.value)} maxLength={500} required/></Field>
            <button className="button button-secondary" disabled={!!busy}>
              {busy === 'resolve' ? 'Bitte warten …' : 'Entscheidung festhalten'}</button>
          </form>
        </>}
        <div className="inner-divider"/>
        <h3>Zugang</h3>
        {order.access.length ? <ul className="plain-list">{order.access.map(access => <li key={access.id}>
          {access.course_id.slice(0, 8)}… · {access.revoked ? 'entzogen' : access.suspended ? 'gesperrt' : 'aktiv'}</li>)}</ul>
          : <p className="muted">Noch kein Zugang vergeben.</p>}
        <RefundPanel order={order} profile={profile!} busy={busy} setBusy={setBusy}
          setError={setError} setSuccess={setSuccess} reload={() => void load()} setReauthNeeded={setReauthNeeded}/>
      </section>
    </div>}
  </div>;
}

/**
 * Refunds for one order.
 *
 * The panel is deliberately boring: an amount, a reason and an explicit button
 * whose label says what will happen. A proposal moves no money, executing one
 * does — and the access question is asked separately, because "the money came
 * back" and "the learner loses the course" are two different decisions.
 */
function RefundPanel({ order, profile, busy, setBusy, setError, setSuccess, reload, setReauthNeeded }: {
  order: OrderDetail; profile: Profile; busy: string;
  setBusy: (value: string) => void; setError: (value: string) => void; setSuccess: (value: string) => void;
  reload: () => void; setReauthNeeded: (value: boolean) => void;
}) {
  const refundable = order.refundable;
  const [amount, setAmount] = useState(refundable?.refundable_cents ?? '0');
  const [reason, setReason] = useState(refundReasons[0].code);
  const [note, setNote] = useState('');
  const [decision, setDecision] = useState<'revoked' | 'kept' | 'suspended'>('kept');
  const [decisionReason, setDecisionReason] = useState('customer_request');
  useEffect(() => { setAmount(refundable?.refundable_cents ?? '0'); }, [refundable?.refundable_cents]);
  if (!canPropose(profile)) return null;
  const cents = /^[0-9]{1,12}$/.test(amount) ? BigInt(amount) : 0n;
  const left = refundable ? BigInt(refundable.refundable_cents) : 0n;
  const valid = cents > 0n && cents <= left;
  async function send(label: string, path: string, payload: unknown, message: string) {
    setBusy(label); setError(''); setSuccess('');
    try {
      await api(path, 'POST', payload); setSuccess(message); reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403 && e.code === 'REAUTH_REQUIRED') setReauthNeeded(true);
      setError(errorMessage(e));
    } finally { setBusy(''); }
  }
  const proposal = { amount_cents: amount, reason_code: reason, note: note || undefined,
    idempotency_key: crypto.randomUUID().replace(/-/g, '').slice(0, 40) };
  const settled = (order.refunds ?? []).filter(refund => refund.status === 'succeeded');
  return <>
    <div className="inner-divider"/>
    <h3>Erstattung</h3>
    {refundable && <p className="muted">Bezahlt {euro(refundable.paid_cents)} · zurück {euro(refundable.refunded_cents)} ·
      {' '}noch erstattbar <strong>{euro(refundable.refundable_cents)}</strong></p>}
    {!!order.refunds?.length && <ul className="plain-list">{order.refunds.map(refund => <li key={refund.id}>
      {euro(refund.amount_cents)} · {refundStatusLabels[refund.status] ?? refund.status}
      {' '}· {refund.reason_code}{refund.confirmed_at ? ` · bestätigt ${dateTime(refund.confirmed_at)}` : ''}</li>)}</ul>}
    {left > 0n ? <form className="stack-form" onSubmit={event => { event.preventDefault();
      void send('refund', `/admin/orders/${order.id}/refunds`, proposal,
        'Erstattung gebucht und Gutschrift erstellt.'); }}>
      <div className="field-row">
        <Field label="Betrag in Cent" id="refund-amount" hint={`Höchstens ${euro(refundable?.refundable_cents ?? '0')}.`}>
          <input id="refund-amount" inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9]/g, ''))} required/></Field>
        <Field label="Grund" id="refund-reason"><select id="refund-reason" value={reason} onChange={e => setReason(e.target.value)}>
          {refundReasons.map(entry => <option key={entry.code} value={entry.code}>{entry.label}</option>)}</select></Field>
      </div>
      <Field label="Notiz (optional)" id="refund-note"><input id="refund-note" value={note}
        onChange={e => setNote(e.target.value)} maxLength={500}/></Field>
      {canRefund(profile) ? <>
        <button className="button button-primary" disabled={!!busy || !valid}>
          {busy === 'refund' ? 'Bitte warten …' : `${euro(cents.toString())} erstatten und Gutschrift erstellen`} <Arrow/></button>
        <p className="muted">Erstattet das Geld nachweislich und erzeugt den Korrekturbeleg. Nicht ausführen, solange
          die Zahlung nicht tatsächlich zurückgegangen ist.</p>
      </> : <p className="muted">Erstattungen dürfen nur von Administration und Superadministration ausgeführt
        werden. Du kannst einen Vorschlag zur Prüfung erfassen.</p>}
      {!canRefund(profile) && <button type="button" className="button button-secondary" disabled={!!busy || !valid}
        onClick={() => void send('propose', `/admin/orders/${order.id}/refund-proposals`, proposal,
          'Vorschlag erfasst. Die Ausführung prüft eine berechtigte Person.')}>
        {busy === 'propose' ? 'Bitte warten …' : 'Erstattung vorschlagen'}</button>}
    </form> : <p className="muted">Für diese Bestellung ist nichts mehr erstattbar.</p>}
    {canDecideAccess(profile) && settled.length > 0 && <div className="stack-form">
      <h4 className="detail-subheading">Zugang nach Erstattung</h4>
      <p className="muted">Ohne diese Entscheidung bleibt der Zugang unverändert. „Gesperrt“ lässt sich später
        zurücknehmen, „entzogen“ nicht.</p>
      <Field label="Entscheidung" id="access-decision"><select id="access-decision" value={decision}
        onChange={e => setDecision(e.target.value as typeof decision)}>
        <option value="kept">Zugang bleibt bestehen (Kulanz)</option>
        <option value="suspended">Zugang vorläufig sperren</option>
        <option value="revoked">Zugang entziehen</option></select></Field>
      <Field label="Begründung" id="access-decision-reason"><input id="access-decision-reason" value={decisionReason}
        onChange={e => setDecisionReason(e.target.value)} maxLength={60} pattern="[a-z_]{3,60}" required/></Field>
      <button type="button" className="button button-secondary" disabled={!!busy}
        onClick={() => void send('decision', `/admin/refunds/${settled[settled.length - 1].id}/access-decision`,
          { decision, reason: decisionReason }, 'Entscheidung zum Zugang festgehalten.')}>
        {busy === 'decision' ? 'Bitte warten …' : 'Entscheidung festhalten'}</button>
    </div>}
  </>;
}

type CommerceState = { settings: { sales_enabled: boolean; invoice_seller_name: string; invoice_seller_street: string;
  invoice_seller_postal: string; invoice_seller_city: string; invoice_seller_country: string; invoice_seller_email: string;
  invoice_seller_vat_id: string | null; bank_account_holder: string; bank_iban: string; bank_bic: string | null;
  bank_name: string | null; payment_term_days: number } | null;
  documents: { kind: string; versions: { id: string; version: number; status: string; wording: string;
    activated_at: string | null }[] }[] };

export function AdminCommerce() {
  const [profile, setProfile] = useState<Profile>();
  const [state, setState] = useState<CommerceState>();
  const [error, setError] = useState(''); const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState<Record<string, string>>({});
  const [salesEnabled, setSalesEnabled] = useState(false);
  const [draftKind, setDraftKind] = useState<'terms' | 'withdrawal' | 'privacy'>('terms');
  const [wording, setWording] = useState('');
  const allowed = !!profile && canConfigure(profile);
  async function load() {
    const data = await api<CommerceState>('/admin/commerce');
    setState(data);
    if (data.settings) {
      setSalesEnabled(data.settings.sales_enabled);
      setForm({ invoice_seller_name: data.settings.invoice_seller_name, invoice_seller_street: data.settings.invoice_seller_street,
        invoice_seller_postal: data.settings.invoice_seller_postal, invoice_seller_city: data.settings.invoice_seller_city,
        invoice_seller_country: data.settings.invoice_seller_country, invoice_seller_email: data.settings.invoice_seller_email,
        invoice_seller_vat_id: data.settings.invoice_seller_vat_id ?? '', bank_account_holder: data.settings.bank_account_holder,
        bank_iban: data.settings.bank_iban, bank_bic: data.settings.bank_bic ?? '', bank_name: data.settings.bank_name ?? '',
        payment_term_days: String(data.settings.payment_term_days) });
    }
  }
  useEffect(() => {
    let active = true;
    api<Profile>('/me').then(async user => {
      if (!active) return; setProfile(user);
      if (!canConfigure(user)) { setError('Nur die Superadministration darf Zahlung und Recht konfigurieren.'); return; }
      try { await load(); } catch (e) { if (active) setError(errorMessage(e)); }
    }).catch(e => { if (active) setError(errorMessage(e)); });
    return () => { active = false; };
  }, []);
  function change(field: string) {
    return (event: { target: { value: string } }) => setForm(current => ({ ...current, [field]: event.target.value }));
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy('save'); setError(''); setSuccess('');
    try {
      await api('/admin/commerce/settings', 'POST', { sales_enabled: salesEnabled, ...form,
        payment_term_days: Number(form.payment_term_days), invoice_seller_vat_id: form.invoice_seller_vat_id || null,
        bank_bic: form.bank_bic || null, bank_name: form.bank_name || null });
      await load(); setSuccess('Einstellungen gespeichert.');
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(''); }
  }
  async function createVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy('legal'); setError(''); setSuccess('');
    try { await api('/admin/commerce/legal', 'POST', { kind: draftKind, wording }); setWording('');
      await load(); setSuccess('Neue Fassung als Entwurf angelegt. Aktivierung macht sie verbindlich.');
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(''); }
  }
  async function activate(versionId: string) {
    setBusy(versionId); setError(''); setSuccess('');
    try { await api(`/admin/commerce/legal/${versionId}/activate`, 'POST', {}); await load();
      setSuccess('Fassung aktiviert. Ältere Fassungen bleiben als Historie erhalten.'); }
    catch (e) {
      if (e instanceof ApiError && e.code === 'REAUTH_REQUIRED') setError('Bitte bestätige im Konto deine Identität und versuche es erneut.');
      else setError(errorMessage(e));
    } finally { setBusy(''); }
  }
  return <div className="account-page content-width">
    <div className="dashboard-title"><div><span className="eyebrow"><span className="eyebrow-line"/> GESCHÜTZTE VERWALTUNG</span>
      <h1>Zahlung &amp; Recht<span className="accent-dot">.</span></h1><p>Verkauf freischalten, Rechnungsdaten und rechtliche Fassungen pflegen.</p></div>
      <Link className="button button-secondary" href="/admin/bestellungen">← Bestellungen</Link></div>
    <div className="course-feedback"><Notice message={error}/><Notice kind="success" message={success}/></div>
    {state && allowed && <div className="admin-grid">
      <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">01 / VERKAUF</span>
        <h2>Verkauf und Rechnungsdaten</h2><p>Solange der Verkauf aus ist, sind Warenkorb und Checkout gesperrt.</p></div>
        <span className={salesEnabled ? 'status-chip status-on' : 'status-chip'}>{salesEnabled ? 'Verkauf aktiv' : 'Verkauf gesperrt'}</span></div>
        <form onSubmit={save} className="stack-form">
          <div className="choice-row"><label><input type="checkbox" checked={salesEnabled} onChange={e => setSalesEnabled(e.target.checked)}/> Verkauf freischalten</label></div>
          <Field label="Rechnungssteller" id="seller-name"><input id="seller-name" value={form.invoice_seller_name ?? ''} onChange={change('invoice_seller_name')} maxLength={160} required/></Field>
          <Field label="Straße und Hausnummer" id="seller-street"><input id="seller-street" value={form.invoice_seller_street ?? ''} onChange={change('invoice_seller_street')} maxLength={160} required/></Field>
          <div className="field-row"><Field label="Postleitzahl" id="seller-postal"><input id="seller-postal" value={form.invoice_seller_postal ?? ''} onChange={change('invoice_seller_postal')} maxLength={16} required/></Field>
            <Field label="Ort" id="seller-city"><input id="seller-city" value={form.invoice_seller_city ?? ''} onChange={change('invoice_seller_city')} maxLength={120} required/></Field></div>
          <div className="field-row"><Field label="Land" id="seller-country"><input id="seller-country" value={form.invoice_seller_country ?? ''} onChange={change('invoice_seller_country')} maxLength={2} required/></Field>
            <Field label="USt-IdNr." id="seller-vat"><input id="seller-vat" value={form.invoice_seller_vat_id ?? ''} onChange={change('invoice_seller_vat_id')} maxLength={20}/></Field></div>
          <Field label="Rechnungs-E-Mail" id="seller-email"><input id="seller-email" type="email" value={form.invoice_seller_email ?? ''} onChange={change('invoice_seller_email')} maxLength={254} required/></Field>
          <div className="field-row"><Field label="Kontoinhaber" id="bank-holder"><input id="bank-holder" value={form.bank_account_holder ?? ''} onChange={change('bank_account_holder')} maxLength={160} required/></Field>
            <Field label="IBAN" id="bank-iban"><input id="bank-iban" value={form.bank_iban ?? ''} onChange={change('bank_iban')} maxLength={34} required/></Field></div>
          <div className="field-row"><Field label="BIC (optional)" id="bank-bic"><input id="bank-bic" value={form.bank_bic ?? ''} onChange={change('bank_bic')} maxLength={11}/></Field>
            <Field label="Bank (optional)" id="bank-name"><input id="bank-name" value={form.bank_name ?? ''} onChange={change('bank_name')} maxLength={120}/></Field></div>
          <Field label="Zahlungsziel in Tagen" id="payment-term"><input id="payment-term" type="number" min={1} max={90} value={form.payment_term_days ?? '14'} onChange={change('payment_term_days')} required/></Field>
          <button className="button button-primary" disabled={!!busy}>{busy === 'save' ? 'Bitte warten …' : 'Einstellungen speichern'} <Arrow/></button>
        </form>
      </section>
      <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">02 / RECHTSTEXTE</span>
        <h2>Fassungen</h2><p>Nur die aktive Fassung wird im Checkout verlangt; jede Bestellung friert ihren Wortlaut ein.</p></div></div>
        {state.documents.map(document => <div key={document.kind} className="legal-version-group">
          <h3>{document.kind === 'terms' ? 'AGB' : document.kind === 'withdrawal' ? 'Widerrufsbelehrung' : 'Datenschutzhinweis'}</h3>
          {document.versions.map(version => <div key={version.id} className="legal-version-row">
            <span>Fassung {version.version} · {version.status === 'active' ? 'aktiv' : version.status === 'draft' ? 'Entwurf' : 'abgelöst'}</span>
            {version.status === 'draft' && <button type="button" className="inline-button text-link" disabled={!!busy}
              onClick={() => void activate(version.id)}>Aktivieren</button>}
          </div>)}
        </div>)}
        <div className="inner-divider"/>
        <form onSubmit={createVersion} className="stack-form">
          <Field label="Dokument" id="legal-kind"><select id="legal-kind" value={draftKind} onChange={e => setDraftKind(e.target.value as typeof draftKind)}>
            <option value="terms">AGB</option><option value="withdrawal">Widerrufsbelehrung</option><option value="privacy">Datenschutzhinweis</option></select></Field>
          <Field label="Neue Fassung" id="legal-wording" hint="Der Wortlaut wird unverändert in jede Bestellung übernommen.">
            <textarea id="legal-wording" rows={8} value={wording} onChange={e => setWording(e.target.value)} maxLength={20000} required/></Field>
          <button className="button button-secondary" disabled={!!busy}>{busy === 'legal' ? 'Bitte warten …' : 'Fassung als Entwurf anlegen'}</button>
        </form>
      </section>
    </div>}
  </div>;
}
