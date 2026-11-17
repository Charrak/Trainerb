'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage } from '../lib/api';
import { checkoutKey, dateOnly, euro, type Cart, type GuestOrder, type ProofStatus, type ShopConfig } from '../lib/shop';
import { Arrow, Field, Notice } from './site';

const emptyCart: Cart = { id: null, items: [], subtotal_gross_cents: '0', currency: 'EUR' };
const countryOptions = [
  ['DE', 'Deutschland'], ['AT', 'Österreich'], ['CH', 'Schweiz'], ['BE', 'Belgien'], ['NL', 'Niederlande'],
  ['FR', 'Frankreich'], ['IT', 'Italien'], ['ES', 'Spanien'], ['PL', 'Polen'], ['DK', 'Dänemark'],
] as const;

/**
 * Guest basket.
 *
 * It lives next to the account cart on purpose: the same browser can shop as a
 * guest and, if it signs in, the basket follows into the account (the API merges
 * it on login). Nothing here requires a session.
 */
export function GuestCart() {
  const [cart, setCart] = useState<Cart>(emptyCart);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState('');
  useEffect(() => {
    let active = true;
    api<Cart>('/guest/cart').then(value => { if (active) setCart(value); })
      .catch(e => { if (active) setError(errorMessage(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  async function remove(productId: string) {
    setBusy(productId); setError('');
    try { setCart(await api<Cart>(`/guest/cart/items/${encodeURIComponent(productId)}`, 'DELETE')); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(''); }
  }
  return <div className="account-page content-width">
    <div className="dashboard-title"><div><span className="eyebrow"><span className="eyebrow-line"/> OHNE KONTO</span>
      <h1>Warenkorb<span className="accent-dot">.</span></h1>
      <p>Du kannst ohne Konto bestellen. Den Zugang erhältst du, sobald die Zahlung eingegangen ist.</p></div>
      <Link className="button button-secondary" href="/buchen">Weiter stöbern <Arrow/></Link></div>
    <Notice message={error}/>
    {loading ? <p className="muted">Warenkorb wird geladen …</p> : !cart.items.length ?
      <section className="dashboard-card"><span className="section-kicker">NOCH LEER</span><h2>Dein Warenkorb ist leer.</h2>
        <p className="muted">Wähle eine Ausbildung aus dem Angebot.</p><Link className="text-link" href="/buchen">Zum Angebot <Arrow/></Link></section> :
      <div className="admin-grid">
        <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">POSITIONEN</span>
          <h2>{cart.items.length} {cart.items.length === 1 ? 'Ausbildung' : 'Ausbildungen'}</h2></div></div>
          <div className="table-wrap"><table><thead><tr><th>Produkt</th><th>Preis</th><th/></tr></thead><tbody>
            {cart.items.map(item => <tr key={item.product_id}><td><strong>{item.title}</strong>
              {item.variant_name && <><br/><small>{item.variant_name}</small></>}<br/><small>{item.sku}</small></td>
              <td>{euro(item.gross_cents)}</td>
              <td><button type="button" className="inline-button text-link" disabled={busy === item.product_id}
                onClick={() => void remove(item.product_id)}>Entfernen</button></td></tr>)}
          </tbody></table></div>
          <div className="summary-lines"><p className="summary-total"><span>Gesamt</span>
            <strong>{euro(cart.subtotal_gross_cents)}</strong></p></div>
          <Link className="button button-primary" href="/kasse/gast">Weiter zur Bestellung <Arrow/></Link>
        </section>
        <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">KONTO</span>
          <h2>Lieber mit Konto?</h2><p>Ein Konto speichert deine Bestellungen und Zugänge dauerhaft. Dein Warenkorb
            wandert beim Anmelden automatisch mit.</p></div></div>
          <div className="release-actions"><Link className="button button-secondary"
            href={`/anmelden?weiter=${encodeURIComponent('/warenkorb')}`}>Anmelden <Arrow/></Link>
            <Link className="button button-outline" href={`/registrieren?weiter=${encodeURIComponent('/warenkorb')}`}>Konto anlegen</Link></div>
        </section>
      </div>}
  </div>;
}

/**
 * Guest checkout in two steps: prove the address, then order.
 *
 * The address proof is deliberate — without it anyone could order courses for a
 * stranger's mailbox. The wording below stays identical for unknown and known
 * addresses so the form never reveals whether an account exists.
 */
export function GuestCheckoutPage() {
  const router = useRouter();
  const [cart, setCart] = useState<Cart>();
  const [config, setConfig] = useState<ShopConfig>();
  const [proof, setProof] = useState<ProofStatus>({ email_verified: false, email_verification_pending: false, email: null });
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [key] = useState(checkoutKey);
  const [email, setEmail] = useState('');
  const [method, setMethod] = useState<'invoice' | 'stripe'>('invoice');
  const [form, setForm] = useState({ company: '', first_name: '', last_name: '', street: '', street_extra: '',
    postal_code: '', city: '', region: '', country: 'DE', vat_id: '' });
  const [participant, setParticipant] = useState({ first_name: '', last_name: '' });
  const [accepted, setAccepted] = useState({ terms: false, withdrawal: false, privacy: false });
  useEffect(() => {
    let active = true;
    Promise.all([api<Cart>('/guest/cart'), api<ShopConfig>('/shop/config'), api<ProofStatus>('/guest/email')])
      .then(([cartValue, configValue, proofValue]) => {
        if (!active) return;
        setCart(cartValue); setConfig(configValue); setProof(proofValue);
        if (proofValue.email) setEmail(proofValue.email);
        if (!configValue.stripe_enabled) setMethod('invoice');
      })
      .catch(e => { if (active) setError(errorMessage(e)); });
    return () => { active = false; };
  }, []);
  function change(field: keyof typeof form) {
    return (event: { target: { value: string } }) => setForm(current => ({ ...current, [field]: event.target.value }));
  }
  async function requestProof(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy('proof'); setError(''); setNotice('');
    try {
      await api('/guest/email/verify/request', 'POST', { email });
      setProof(current => ({ ...current, email_verification_pending: true, email }));
      setNotice('Wir haben dir eine E-Mail mit einem Bestätigungslink und einem Code geschickt. Der Link ist 30 Minuten gültig.');
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(''); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    if (!accepted.terms || !accepted.withdrawal || !accepted.privacy) {
      setError('Bitte bestätige alle rechtlichen Hinweise.'); return;
    }
    if (!config) { setError('Die Bestellkonfiguration ist noch nicht geladen.'); return; }
    setBusy('order');
    try {
      const order = await api<GuestOrder>('/guest/orders', 'POST', { idempotency_key: key, billing_address: form,
        payment_method: method,
        legal_versions: { terms: config.legal.terms?.id, withdrawal: config.legal.withdrawal?.id,
          privacy: config.legal.privacy?.id },
        terms_accepted: true, withdrawal_notice_seen: true, privacy_notice_seen: true,
        participant_first_name: participant.first_name, participant_last_name: participant.last_name });
      router.push(`/bestellung/${order.id}?gast=1`);
    } catch (e) { setError(errorMessage(e)); setBusy(''); }
  }
  if (!cart || !config) return <div className="account-page content-width">
    <h1 className="page-title">Bestellung<span className="accent-dot">.</span></h1>
    <Notice message={error}/>{!error && <p className="muted">Bestellung wird vorbereitet …</p>}</div>;
  const legalReady = !!(config.legal.terms && config.legal.withdrawal && config.legal.privacy);
  return <div className="account-page content-width">
    <div className="dashboard-title"><div><span className="eyebrow"><span className="eyebrow-line"/> OHNE KONTO BESTELLEN</span>
      <h1>Bestellung<span className="accent-dot">.</span></h1><p>Adresse bestätigen, Rechnungsdaten eintragen, fertig.</p></div>
      <Link className="button button-outline" href="/warenkorb">← Warenkorb</Link></div>
    <Notice message={error}/><Notice message={notice} kind="info"/>
    {!cart.items.length ? <section className="dashboard-card"><h2>Der Warenkorb ist leer.</h2>
        <Link className="text-link" href="/buchen">Zum Angebot <Arrow/></Link></section> :
      !config.sales_enabled ? <section className="dashboard-card"><h2>Der Verkauf ist derzeit nicht freigeschaltet.</h2></section> :
      <div className="checkout-grid">
        <div className="checkout-main">
          <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">01 / E-MAIL</span>
            <h2>E-Mail-Adresse bestätigen</h2>
            <p>Die Bestellung und der Lernzugang gehören zu dieser Adresse. Wir senden dir dafür einen Link.</p></div></div>
            {proof.email_verified ? <p className="publication-ok">Adresse bestätigt: <strong>{proof.email ?? email}</strong></p> : <>
              <form onSubmit={requestProof} className="stack-form">
                <Field label="E-Mail-Adresse" id="guest-email"><input id="guest-email" type="email" value={email}
                  onChange={e => setEmail(e.target.value)} autoComplete="email" maxLength={254} required/></Field>
                <button className="button button-secondary" disabled={!!busy}>
                  {busy === 'proof' ? 'Bitte warten …' : proof.email_verification_pending ? 'Neuen Link senden' : 'Bestätigungslink senden'}</button>
              </form>
              {proof.email_verification_pending && <p className="muted small-print">
                Den Link kannst du auch auf einem anderen Gerät öffnen: <Link className="text-link"
                  href="/kasse/bestaetigen">Bestätigung öffnen <Arrow/></Link></p>}
            </>}
          </section>
          <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">02 / TEILNAHME</span>
            <h2>Teilnehmende Person</h2><p>Dieser Name erscheint später in deinem Konto und auf Bescheinigungen.</p></div></div>
            <div className="field-row"><Field label="Vorname" id="participant-first"><input id="participant-first"
              value={participant.first_name} onChange={e => setParticipant({ ...participant, first_name: e.target.value })}
              maxLength={120} required/></Field>
              <Field label="Nachname" id="participant-last"><input id="participant-last" value={participant.last_name}
                onChange={e => setParticipant({ ...participant, last_name: e.target.value })} maxLength={120} required/></Field></div>
          </section>
          <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">03 / RECHNUNG</span>
            <h2>Rechnungsadresse</h2><p>Diese Angaben erscheinen unverändert auf der Rechnung.</p></div></div>
            <div className="field-row"><Field label="Vorname" id="billing-first"><input id="billing-first" value={form.first_name}
              onChange={change('first_name')} autoComplete="given-name" maxLength={120} required/></Field>
              <Field label="Nachname" id="billing-last"><input id="billing-last" value={form.last_name}
                onChange={change('last_name')} autoComplete="family-name" maxLength={120} required/></Field></div>
            <Field label="Firma (optional)" id="billing-company"><input id="billing-company" value={form.company}
              onChange={change('company')} autoComplete="organization" maxLength={160}/></Field>
            <Field label="Straße und Hausnummer" id="billing-street"><input id="billing-street" value={form.street}
              onChange={change('street')} autoComplete="address-line1" maxLength={160} required/></Field>
            <Field label="Adresszusatz (optional)" id="billing-extra"><input id="billing-extra" value={form.street_extra}
              onChange={change('street_extra')} autoComplete="address-line2" maxLength={160}/></Field>
            <div className="field-row"><Field label="Postleitzahl" id="billing-postal"><input id="billing-postal"
              value={form.postal_code} onChange={change('postal_code')} autoComplete="postal-code" maxLength={16} required/></Field>
              <Field label="Ort" id="billing-city"><input id="billing-city" value={form.city} onChange={change('city')}
                autoComplete="address-level2" maxLength={120} required/></Field></div>
            <div className="field-row"><Field label="Land" id="billing-country"><select id="billing-country"
              value={form.country} onChange={change('country')}>{countryOptions.map(([value, label]) =>
                <option key={value} value={value}>{label}</option>)}</select></Field>
              <Field label="USt-IdNr. (optional)" id="billing-vat"><input id="billing-vat" value={form.vat_id}
                onChange={change('vat_id')} maxLength={20}/></Field></div>
          </section>
          <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">04 / ZAHLUNG</span>
            <h2>Zahlungsart</h2></div></div>
            <div className="choice-row"><label><input type="radio" name="payment" checked={method === 'invoice'}
              onChange={() => setMethod('invoice')}/> Rechnung / Überweisung</label>
              <label><input type="radio" name="payment" checked={method === 'stripe'} disabled={!config.stripe_enabled}
                onChange={() => setMethod('stripe')}/> Karte (Stripe){!config.stripe_enabled && ' – nicht verfügbar'}</label></div>
            <p className="muted">{method === 'invoice'
              ? `Du erhältst eine Rechnung mit Zahlungsziel von ${config.payment_term_days ?? 14} Tagen. Der Zugang wird nach bestätigtem Zahlungseingang freigeschaltet.`
              : 'Du wirst zur Zahlung zu Stripe weitergeleitet. Der Zugang wird nach der bestätigten Zahlung freigeschaltet.'}</p>
          </section>
          <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">05 / PFLICHTANGABEN</span>
            <h2>Rechtliche Hinweise</h2></div></div>
            {legalReady ? <>
              {(['terms', 'withdrawal', 'privacy'] as const).map(kind => <div className="legal-block" key={kind}>
                <label><input type="checkbox" checked={accepted[kind]}
                  onChange={e => setAccepted(current => ({ ...current, [kind]: e.target.checked }))}/>{
                  kind === 'terms' ? ` AGB (Fassung ${config.legal.terms!.version}) akzeptieren`
                    : kind === 'withdrawal' ? ` Widerrufsbelehrung (Fassung ${config.legal.withdrawal!.version}) zur Kenntnis genommen`
                    : ` Datenschutzhinweis (Fassung ${config.legal.privacy!.version}) zur Kenntnis genommen`}</label>
                <details><summary>Wortlaut anzeigen</summary><p>{config.legal[kind]!.wording}</p></details></div>)}
            </> : <p className="muted">Bestellungen sind erst möglich, wenn die rechtlichen Hinweise freigegeben sind.</p>}
          </section>
        </div>
        <aside className="checkout-side dashboard-card"><span className="section-kicker">ÜBERSICHT</span>
          <ul className="plain-list summary-list">{cart.items.map(item => <li key={item.product_id}>
            <strong>{item.title}</strong><small>{euro(item.gross_cents)}</small></li>)}</ul>
          <div className="summary-lines"><p className="summary-total"><span>Gesamt</span>
            <strong>{euro(cart.subtotal_gross_cents)}</strong></p></div>
          <p className="muted small-print">Alle Beträge inklusive der gesetzlichen Umsatzsteuer, soweit anwendbar.</p>
          <form onSubmit={submit}><button className="button button-primary button-full"
            disabled={!!busy || !legalReady || !proof.email_verified}>
            {busy === 'order' ? 'Bitte warten …' : proof.email_verified ? 'Zahlungspflichtig bestellen' : 'Erst E-Mail bestätigen'} <Arrow/></button></form>
        </aside>
      </div>}
  </div>;
}

/** The page the proof link points at; it reads the token from the URL fragment. */
export function GuestProofPage() {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [token, setToken] = useState('');
  const [manual, setManual] = useState('');
  useEffect(() => {
    const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
    // The fragment never reaches the server or a proxy log.
    if (fromHash) { setToken(fromHash); void confirm(fromHash); }
  }, []);
  async function confirm(value: string) {
    setState('busy'); setMessage('');
    try {
      await api<{ verified: boolean }>('/guest/email/verify/confirm', 'POST', { token: value });
      setState('done');
    } catch (e) { setState('error'); setMessage(errorMessage(e)); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!manual.trim()) return;
    setToken(manual.trim());
    await confirm(manual.trim());
  }
  return <div className="account-page content-width"><div className="dashboard-card">
    <span className="eyebrow"><span className="eyebrow-line"/> BESTÄTIGUNG</span>
    <h1 className="page-title">E-Mail-Adresse<span className="accent-dot">.</span></h1>
    <Notice message={message}/>
    {state === 'done' ? <>
      <p className="publication-ok">Deine E-Mail-Adresse ist bestätigt.</p>
      <p className="muted">Öffne die Bestellung auf dem Gerät, auf dem sich dein Warenkorb befindet.</p>
      <Link className="button button-primary" href="/kasse/gast">Weiter zur Bestellung <Arrow/></Link>
    </> : state === 'busy' ? <p className="muted">Bestätigung wird geprüft …</p> : <>
      <p className="muted">Wenn der Link nicht automatisch greift, kannst du den Code aus der E-Mail hier einfügen.</p>
      <form onSubmit={submit} className="stack-form">
        <Field label="Bestätigungscode oder Token" id="proof-token"><input id="proof-token" value={manual}
          onChange={e => setManual(e.target.value)} maxLength={128} autoComplete="one-time-code"/></Field>
        <button className="button button-primary">Bestätigen <Arrow/></button>
      </form>
      {token && <p className="muted small-print">Ein Token aus dem Link wurde bereits geprüft.</p>}
    </>}
  </div></div>;
}

/**
 * Guest order page. It reads the order through the cart cookie, so it also works
 * right after paying with a card, without any login.
 */
export function GuestOrderPage({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<GuestOrder>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function load() {
    try { setOrder(await api<GuestOrder>(`/guest/orders/${encodeURIComponent(orderId)}`)); }
    catch (e) { setError(errorMessage(e)); }
  }
  useEffect(() => { void load(); }, [orderId]);
  async function payWithCard() {
    setBusy(true); setError('');
    try {
      const session = await api<{ url: string }>(`/orders/${encodeURIComponent(orderId)}/pay`, 'POST', {});
      window.location.assign(session.url);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setError('Bitte melde dich an, um mit Karte zu bezahlen.'); setBusy(false); return;
      }
      setError(errorMessage(e)); setBusy(false);
    }
  }
  return <div className="account-page content-width">
    <div className="dashboard-title"><div><span className="eyebrow"><span className="eyebrow-line"/> BESTELLUNG</span>
      <h1>Bestellung<span className="accent-dot">.</span></h1>{order && <p>{order.order_number} · {dateOnly(order.placed_at)}</p>}</div>
      <Link className="button button-secondary" href="/buchen">Weiter stöbern <Arrow/></Link></div>
    <Notice message={error}/>
    {!order ? <p className="muted">{error ? '' : 'Bestellung wird geladen …'}</p> : <div className="admin-grid">
      <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">STATUS</span>
        <h2>{order.payment_state === 'paid' ? 'Bezahlt' : order.payment_state === 'awaiting' ? 'Zahlung offen'
          : order.payment_state === 'cancelled' ? 'Storniert' : 'In Prüfung'}</h2>
        <p>{order.payment_state === 'paid'
          ? (order.account_linked ? 'Wir haben ein Konto für dich angelegt und dir eine Aktivierungsmail geschickt.'
            : 'Deine Zahlung ist eingegangen.')
          : 'Der Zugang wird nach bestätigtem Zahlungseingang freigeschaltet.'}</p></div></div>
        {order.bank && order.payment_state === 'awaiting' && <div className="bank-box"><span className="section-kicker">ÜBERWEISUNG</span>
          <p><strong>{euro(order.total_gross_cents)}</strong>{order.due_at && <> bis {dateOnly(order.due_at)}</>}</p>
          <dl><div><dt>Empfänger</dt><dd>{order.bank.holder}</dd></div><div><dt>IBAN</dt><dd>{order.bank.iban}</dd></div>
            {order.bank.bic && <div><dt>BIC</dt><dd>{order.bank.bic}</dd></div>}
            <div><dt>Verwendungszweck</dt><dd><strong>{order.bank.reference}</strong></dd></div></dl>
          <p className="muted small-print">Bitte gib immer den Verwendungszweck an, damit die Zahlung zugeordnet werden kann.</p></div>}
        {order.payment_method === 'stripe' && order.payment_state === 'awaiting' && <button className="button button-primary"
          disabled={busy} onClick={() => void payWithCard()}>{busy ? 'Bitte warten …' : 'Jetzt mit Karte bezahlen'} <Arrow/></button>}
        <h3 className="detail-subheading">Positionen</h3>
        <div className="table-wrap"><table><tbody>{order.items.map(item => <tr key={item.product_id}>
          <td><strong>{item.title}</strong>{item.variant && <><br/><small>{item.variant}</small></>}
            <br/><small>{item.courses.map(course => course.title).join(', ')}</small></td>
          <td>{euro(item.total_gross_cents)}</td></tr>)}
          <tr><td><strong>Gesamt</strong></td><td><strong>{euro(order.total_gross_cents)}</strong></td></tr></tbody></table></div>
      </section>
      <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">BELEG</span>
        <h2>Rechnung</h2></div></div>
        {order.invoice ? <>
          <p><strong>{order.invoice.invoice_number}</strong> · {dateOnly(order.invoice.issued_at)}</p>
          <p className="muted small-print">Die Rechnung wird an {order.buyer_email} gesendet.</p>
        </> : <p className="muted">Für Kartenzahlungen wird die Rechnung nach bestätigter Zahlung erstellt.</p>}
        <div className="legal-block"><span className="section-kicker">BESTÄTIGT</span>
          <ul className="plain-list">{order.acceptances.map(acceptance => <li key={acceptance.kind}>
            {acceptance.kind === 'terms_accepted' ? 'AGB' : acceptance.kind === 'withdrawal_notice_seen'
              ? 'Widerrufsbelehrung' : 'Datenschutzhinweis'}</li>)}</ul></div>
        <p className="muted small-print">Du möchtest deine Bestellung in einem Konto sehen? Lege mit derselben
          E-Mail-Adresse ein Konto an – die Bestellung wird dann übernommen.</p>
        <Link className="text-link" href={`/registrieren?weiter=${encodeURIComponent(`/bestellung/${orderId}`)}`}>
          Konto mit dieser Adresse anlegen <Arrow/></Link>
      </section>
    </div>}
  </div>;
}
