'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage } from '../lib/api';
import { checkoutKey, dateOnly, euro, type Cart, type OrderDetail, type ShopConfig } from '../lib/shop';
import { Arrow, Field, Notice } from './site';
import { InvoiceDownload } from './invoices';

const emptyCart: Cart = { id: null, items: [], subtotal_gross_cents: '0', currency: 'EUR' };

export function CartPage() {
  const [cart, setCart] = useState<Cart>(emptyCart);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState('');
  const [guest, setGuest] = useState(false);
  async function load() {
    setError('');
    try { setCart(await api<Cart>('/cart')); }
    catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        // Not signed in: show the guest basket instead of an error. Buying
        // without an account is a supported path, not a dead end.
        try { setCart(await api<Cart>('/guest/cart')); setGuest(true); setLoading(false); return; }
        catch { setError('Bitte melde dich an, um deinen Warenkorb zu sehen.'); setLoading(false); return; }
      }
      setError(errorMessage(e));
    }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  async function applyCoupon(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy('coupon'); setError('');
    try { setCart(await api<Cart>('/cart/coupon', 'POST', { coupon_code: code })); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(''); }
  }
  async function remove(productId: string) {
    setBusy(productId); setError('');
    try {
      setCart(guest ? await api<Cart>(`/guest/cart/items/${encodeURIComponent(productId)}`, 'DELETE')
        : await api<Cart>(`/cart/items/${productId}`, 'DELETE'));
    }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(''); }
  }
  const total = cart.total_gross_cents ?? cart.subtotal_gross_cents;
  return <div className="account-page content-width">
    <div className="dashboard-title"><div><span className="eyebrow"><span className="eyebrow-line"/> DEINE AUSWAHL</span>
      <h1>Warenkorb<span className="accent-dot">.</span></h1><p>Prüfe deine Auswahl und fahre zur Bestellung fort.</p></div>
      <Link className="button button-secondary" href="/buchen">Weiter stöbern <Arrow/></Link></div>
    <Notice message={error}/>
    {loading ? <p className="muted">Warenkorb wird geladen …</p> : !cart.items.length ?
      <section className="dashboard-card"><span className="section-kicker">NOCH LEER</span><h2>Dein Warenkorb ist leer.</h2>
        <p className="muted">Wähle eine Ausbildung aus dem Angebot.</p><Link className="text-link" href="/buchen">Zum Angebot <Arrow/></Link></section> :
      <div className="admin-grid">
        <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">POSITIONEN</span>
          <h2>{cart.items.length} {cart.items.length === 1 ? 'Ausbildung' : 'Ausbildungen'}</h2></div></div>
          <div className="table-wrap"><table><thead><tr><th>Produkt</th><th>Preis</th><th/></tr></thead><tbody>
            {cart.items.map(item => <tr key={item.product_id}><td><strong>{item.title}</strong>{item.variant_name && <><br/><small>{item.variant_name}</small></>}
              <br/><small>{item.sku}</small>{item.gross_cents !== item.list_gross_cents && <><br/><small>Aktionspreis statt {euro(item.list_gross_cents)}</small></>}</td>
              <td>{euro(item.gross_cents)}</td>
              <td><button type="button" className="inline-button text-link" disabled={busy === item.product_id}
                onClick={() => void remove(item.product_id)}>Entfernen</button></td></tr>)}
          </tbody></table></div>
          <div className="summary-lines"><p><span>Zwischensumme</span><strong>{euro(cart.subtotal_gross_cents)}</strong></p>
            {cart.discount_cents && cart.discount_cents !== '0' && <p><span>Rabatt {cart.coupon_code ? `(${cart.coupon_code})` : ''}</span><strong>−{euro(cart.discount_cents)}</strong></p>}
            <p className="summary-total"><span>Gesamt</span><strong>{euro(total)}</strong></p></div>
          <Link className="button button-primary" href={guest ? '/kasse/gast' : '/kasse'}>Zur Bestellung <Arrow/></Link>
          {guest && <p className="muted small-print">Du bestellst ohne Konto. <Link className="text-link"
            href={`/anmelden?weiter=${encodeURIComponent('/warenkorb')}`}>Anmelden</Link> – dein Warenkorb wandert mit.</p>}
        </section>
        <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">GUTSCHEIN</span>
          <h2>Gutscheincode</h2><p>Ein Gutschein je Bestellung. Der Rabatt wird beim Bestellen erneut geprüft.</p></div></div>
          <form onSubmit={applyCoupon} className="stack-form"><Field label="Code" id="coupon-code">
            <input id="coupon-code" value={code} onChange={e => setCode(e.target.value.toUpperCase())} maxLength={64} placeholder="z. B. WILLKOMMEN10"/></Field>
            <button className="button button-secondary" disabled={!!busy}>{busy === 'coupon' ? 'Bitte warten …' : 'Gutschein anwenden'}</button></form>
        </section>
      </div>}
  </div>;
}

const countryOptions = [
  ['DE', 'Deutschland'], ['AT', 'Österreich'], ['CH', 'Schweiz'], ['BE', 'Belgien'], ['NL', 'Niederlande'],
  ['FR', 'Frankreich'], ['IT', 'Italien'], ['ES', 'Spanien'], ['PL', 'Polen'], ['DK', 'Dänemark'],
] as const;

export function CheckoutPage() {
  const router = useRouter();
  const [cart, setCart] = useState<Cart>();
  const [config, setConfig] = useState<ShopConfig>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [key] = useState(checkoutKey);
  const [method, setMethod] = useState<'invoice' | 'stripe'>('invoice');
  const [form, setForm] = useState({ company: '', first_name: '', last_name: '', street: '', street_extra: '',
    postal_code: '', city: '', region: '', country: 'DE', vat_id: '' });
  const [coupon, setCoupon] = useState('');
  const [accepted, setAccepted] = useState({ terms: false, withdrawal: false, privacy: false });
  useEffect(() => {
    let active = true;
    Promise.all([api<Cart>('/cart'), api<ShopConfig>('/shop/config'), api<{ first_name: string; last_name: string }>('/me')])
      .then(([cartValue, configValue, profile]) => {
        if (!active) return;
        setCart(cartValue); setConfig(configValue);
        setForm(current => ({ ...current, first_name: profile.first_name, last_name: profile.last_name }));
        if (!configValue.stripe_enabled) setMethod('invoice');
      })
      .catch(e => { if (active) setError(e instanceof ApiError && (e.status === 401 || e.status === 403)
        ? 'Bitte melde dich an, um zu bestellen.' : errorMessage(e)); });
    return () => { active = false; };
  }, []);
  function change(field: keyof typeof form) {
    return (event: { target: { value: string } }) => setForm(current => ({ ...current, [field]: event.target.value }));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    if (!accepted.terms || !accepted.withdrawal || !accepted.privacy) { setError('Bitte bestätige alle rechtlichen Hinweise.'); return; }
    if (!config) { setError('Die Bestellkonfiguration ist noch nicht geladen.'); return; }
    setBusy(true);
    try {
      const order = await api<OrderDetail>('/orders', 'POST', { idempotency_key: key, billing_address: form,
        coupon_code: coupon || null, payment_method: method,
        legal_versions: { terms: config.legal.terms?.id, withdrawal: config.legal.withdrawal?.id, privacy: config.legal.privacy?.id },
        terms_accepted: true, withdrawal_notice_seen: true, privacy_notice_seen: true });
      if (order.payment_method === 'stripe') {
        const session = await api<{ url: string }>(`/orders/${order.id}/pay`, 'POST', {});
        window.location.assign(session.url);
        return;
      }
      router.push(`/bestellung/${order.id}`);
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  }
  if (!cart || !config) return <div className="account-page content-width"><h1 className="page-title">Bestellung<span className="accent-dot">.</span></h1><Notice message={error}/>{!error && <p className="muted">Bestellung wird vorbereitet …</p>}</div>;
  const total = cart.total_gross_cents ?? cart.subtotal_gross_cents;
  const legalReady = !!(config.legal.terms && config.legal.withdrawal && config.legal.privacy);
  return <div className="account-page content-width">
    <div className="dashboard-title"><div><span className="eyebrow"><span className="eyebrow-line"/> LETZTER SCHRITT</span>
      <h1>Bestellung<span className="accent-dot">.</span></h1><p>Rechnungsadresse, Zahlungsart und rechtliche Hinweise.</p></div>
      <Link className="button button-outline" href="/warenkorb">← Warenkorb</Link></div>
    <Notice message={error}/>
    {!cart.items.length ? <section className="dashboard-card"><h2>Der Warenkorb ist leer.</h2><Link className="text-link" href="/buchen">Zum Angebot <Arrow/></Link></section> :
      !config.sales_enabled ? <section className="dashboard-card"><h2>Der Verkauf ist derzeit nicht freigeschaltet.</h2><p className="muted">Bitte versuche es später erneut.</p></section> :
      <form onSubmit={submit} className="checkout-grid">
        <div className="checkout-main">
          <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">01 / RECHNUNG</span>
            <h2>Rechnungsadresse</h2><p>Diese Angaben erscheinen unverändert auf der Rechnung.</p></div></div>
            <div className="field-row"><Field label="Vorname" id="billing-first"><input id="billing-first" value={form.first_name} onChange={change('first_name')} autoComplete="given-name" maxLength={120} required/></Field>
              <Field label="Nachname" id="billing-last"><input id="billing-last" value={form.last_name} onChange={change('last_name')} autoComplete="family-name" maxLength={120} required/></Field></div>
            <Field label="Firma (optional)" id="billing-company"><input id="billing-company" value={form.company} onChange={change('company')} autoComplete="organization" maxLength={160}/></Field>
            <Field label="Straße und Hausnummer" id="billing-street"><input id="billing-street" value={form.street} onChange={change('street')} autoComplete="address-line1" maxLength={160} required/></Field>
            <Field label="Adresszusatz (optional)" id="billing-extra"><input id="billing-extra" value={form.street_extra} onChange={change('street_extra')} autoComplete="address-line2" maxLength={160}/></Field>
            <div className="field-row"><Field label="Postleitzahl" id="billing-postal"><input id="billing-postal" value={form.postal_code} onChange={change('postal_code')} autoComplete="postal-code" maxLength={16} required/></Field>
              <Field label="Ort" id="billing-city"><input id="billing-city" value={form.city} onChange={change('city')} autoComplete="address-level2" maxLength={120} required/></Field></div>
            <div className="field-row"><Field label="Land" id="billing-country"><select id="billing-country" value={form.country} onChange={change('country')}>
              {countryOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
              <Field label="USt-IdNr. (optional)" id="billing-vat"><input id="billing-vat" value={form.vat_id} onChange={change('vat_id')} maxLength={20}/></Field></div>
          </section>
          <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">02 / ZAHLUNG</span>
            <h2>Zahlungsart</h2></div></div>
            <div className="choice-row"><label><input type="radio" name="payment" checked={method === 'invoice'} onChange={() => setMethod('invoice')}/> Rechnung / Überweisung</label>
              <label><input type="radio" name="payment" checked={method === 'stripe'} disabled={!config.stripe_enabled} onChange={() => setMethod('stripe')}/> Karte (Stripe){!config.stripe_enabled && ' – nicht verfügbar'}</label></div>
            <p className="muted">{method === 'invoice'
              ? `Du erhältst eine Rechnung mit Zahlungsziel von ${config.payment_term_days ?? 14} Tagen. Der Zugang wird nach bestätigtem Zahlungseingang freigeschaltet.`
              : 'Du wirst zur Zahlung zu Stripe weitergeleitet. Der Zugang wird nach der bestätigten Zahlung freigeschaltet.'}</p>
          </section>
          <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">03 / PFLICHTANGABEN</span>
            <h2>Rechtliche Hinweise</h2></div></div>
            {legalReady ? <>
              {(['terms', 'withdrawal', 'privacy'] as const).map(kind => <div className="legal-block" key={kind}>
                <label><input type="checkbox" checked={accepted[kind]} onChange={e => setAccepted(current => ({ ...current, [kind]: e.target.checked }))}/>{
                  kind === 'terms' ? ` AGB (Fassung ${config.legal.terms!.version}) akzeptieren`
                    : kind === 'withdrawal' ? ` Widerrufsbelehrung (Fassung ${config.legal.withdrawal!.version}) zur Kenntnis genommen`
                    : ` Datenschutzhinweis (Fassung ${config.legal.privacy!.version}) zur Kenntnis genommen`}</label>
                <details><summary>Wortlaut anzeigen</summary><p>{config.legal[kind]!.wording}</p></details></div>)}
            </> : <p className="muted">Bestellungen sind erst möglich, wenn die rechtlichen Hinweise freigegeben sind.</p>}
          </section>
        </div>
        <aside className="checkout-side dashboard-card"><span className="section-kicker">ÜBERSICHT</span>
          <ul className="plain-list summary-list">{cart.items.map(item => <li key={item.product_id}><strong>{item.title}</strong><small>{euro(item.gross_cents)}</small></li>)}</ul>
          <Field label="Gutscheincode (optional)" id="checkout-coupon"><input id="checkout-coupon" value={coupon} onChange={e => setCoupon(e.target.value.toUpperCase())} maxLength={64}/></Field>
          <div className="summary-lines"><p><span>Zwischensumme</span><strong>{euro(cart.subtotal_gross_cents)}</strong></p>
            <p className="summary-total"><span>Gesamt</span><strong>{euro(total)}</strong></p></div>
          <p className="muted small-print">Der Rabatt eines Gutscheins wird beim Absenden verbindlich berechnet. Alle Beträge inklusive der gesetzlichen Umsatzsteuer, soweit anwendbar.</p>
          <button className="button button-primary button-full" disabled={busy || !legalReady}>{busy ? 'Bitte warten …' : 'Zahlungspflichtig bestellen'} <Arrow/></button>
        </aside>
      </form>}
  </div>;
}

export function OrderPage({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<OrderDetail>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function load() {
    try { setOrder(await api<OrderDetail>(`/orders/${encodeURIComponent(orderId)}`)); }
    catch (e) { setError(errorMessage(e)); }
  }
  useEffect(() => { void load(); }, [orderId]);
  async function payWithCard() {
    setBusy(true); setError('');
    try {
      const session = await api<{ url: string }>(`/orders/${encodeURIComponent(orderId)}/pay`, 'POST', {});
      window.location.assign(session.url);
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  }
  return <div className="account-page content-width">
    <div className="dashboard-title"><div><span className="eyebrow"><span className="eyebrow-line"/> BESTELLUNG</span>
      <h1>Bestellung<span className="accent-dot">.</span></h1>{order && <p>{order.order_number} · {dateOnly(order.placed_at)}</p>}</div>
      <Link className="button button-secondary" href="/konto/bestellungen">Alle Bestellungen <Arrow/></Link></div>
    <Notice message={error}/>
    {!order ? <p className="muted">Bestellung wird geladen …</p> : <div className="admin-grid">
      <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">STATUS</span>
        <h2>{order.payment_state === 'paid' ? 'Bezahlt' : order.payment_state === 'awaiting' ? 'Zahlung offen' : order.payment_state === 'cancelled' ? 'Storniert' : 'In Prüfung'}</h2>
        <p>{order.fulfillment_state === 'fulfilled' ? 'Dein Zugang ist freigeschaltet.' : 'Der Zugang wird nach bestätigtem Zahlungseingang freigeschaltet.'}</p></div></div>
        {order.bank && order.payment_state === 'awaiting' && <div className="bank-box"><span className="section-kicker">ÜBERWEISUNG</span>
          <p><strong>{euro(order.total_gross_cents)}</strong>{order.due_at && <> bis {dateOnly(order.due_at)}</>}</p>
          <dl><div><dt>Empfänger</dt><dd>{order.bank.holder}</dd></div><div><dt>IBAN</dt><dd>{order.bank.iban}</dd></div>
            {order.bank.bic && <div><dt>BIC</dt><dd>{order.bank.bic}</dd></div>}
            <div><dt>Verwendungszweck</dt><dd><strong>{order.bank.reference}</strong></dd></div></dl>
          <p className="muted small-print">Bitte gib immer den Verwendungszweck an, damit die Zahlung zugeordnet werden kann.</p></div>}
        {order.payment_method === 'stripe' && order.payment_state === 'awaiting' && <button className="button button-primary" disabled={busy}
          onClick={() => void payWithCard()}>{busy ? 'Bitte warten …' : 'Jetzt mit Karte bezahlen'} <Arrow/></button>}
        <h3 className="detail-subheading">Positionen</h3>
        <div className="table-wrap"><table><tbody>{order.items.map(item => <tr key={item.product_id}>
          <td><strong>{item.title}</strong>{item.variant && <><br/><small>{item.variant}</small></>}
            <br/><small>{item.courses.map(course => course.title).join(', ')}</small></td><td>{euro(item.total_gross_cents)}</td></tr>)}
          {order.discount_cents !== '0' && <tr><td>Rabatt {order.coupon_code ? `(${order.coupon_code})` : ''}</td><td>−{euro(order.discount_cents)}</td></tr>}
          <tr><td><strong>Gesamt</strong></td><td><strong>{euro(order.total_gross_cents)}</strong></td></tr></tbody></table></div>
        {order.payment_state === 'paid' && <Link className="button button-primary" href="/konto/kurse">Jetzt lernen <Arrow/></Link>}
      </section>
      <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">BELEG</span>
        <h2>Rechnung</h2></div></div>
        {order.invoice ? <>
          <p><strong>{order.invoice.invoice_number}</strong> · {dateOnly(order.invoice.issued_at)}</p>
          {order.invoice.pdf_href && <InvoiceDownload href={order.invoice.pdf_href}/>}
          {!order.invoice.pdf_href && <p className="muted small-print">Der Beleg steht zum Download bereit, sobald die Zahlung bestätigt ist.</p>}
          <div className="invoice-columns"><div><span className="section-kicker">RECHNUNGSSTELLER</span>
            <p>{order.invoice.seller.name}<br/>{order.invoice.seller.street}<br/>{order.invoice.seller.postal_code} {order.invoice.seller.city}<br/>{order.invoice.seller.email}</p></div>
            <div><span className="section-kicker">RECHNUNGSEMPFÄNGER</span>
            <p>{[order.invoice.buyer.company, `${order.invoice.buyer.first_name} ${order.invoice.buyer.last_name}`,
              order.invoice.buyer.street, order.invoice.buyer.street_extra, `${order.invoice.buyer.postal_code} ${order.invoice.buyer.city}`,
              order.invoice.buyer.country].filter(Boolean).join('\n').split('\n').map((line, index) => <span key={index}>{line}<br/></span>)}</p></div></div>
        </> : <p className="muted">Für Kartenzahlungen wird die Rechnung nach bestätigter Zahlung erstellt.</p>}
        <div className="legal-block"><span className="section-kicker">BESTÄTIGT</span>
          <ul className="plain-list">{order.acceptances.map(acceptance => <li key={acceptance.kind}>{acceptance.kind === 'terms_accepted' ? 'AGB' : acceptance.kind === 'withdrawal_notice_seen' ? 'Widerrufsbelehrung' : 'Datenschutzhinweis'}
            <small> Fassung {acceptance.legal_document_version_id.slice(0, 8)}…</small></li>)}</ul></div>
      </section>
    </div>}
  </div>;
}

export function MyOrders() {
  const [orders, setOrders] = useState<{ id: string; order_number: string; placed_at: string; payment_state: string;
    fulfillment_state: string; total_gross_cents: string }[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<{ data: typeof orders }>('/orders').then(value => { if (active) setOrders(value.data); })
      .catch(e => { if (active) setError(errorMessage(e)); });
    return () => { active = false; };
  }, []);
  return <div className="account-page content-width">
    <div className="dashboard-title"><div><span className="eyebrow"><span className="eyebrow-line"/> DEINE BESTELLUNGEN</span>
      <h1>Bestellungen<span className="accent-dot">.</span></h1></div><Link className="button button-secondary" href="/konto">← Zum Konto</Link></div>
    <Notice message={error}/>
    <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">ÜBERSICHT</span>
      <h2>Deine Bestellungen</h2></div></div>
      {!orders.length && !error ? <p className="muted">Du hast noch keine Bestellung aufgegeben.</p> : <div className="draft-list">
        {orders.map(order => <Link className="draft-row" key={order.id} href={`/bestellung/${order.id}`}>
          <div><strong>{order.order_number}</strong><span>{dateOnly(order.placed_at)} · {order.payment_state === 'paid' ? 'Bezahlt' : order.payment_state === 'awaiting' ? 'Zahlung offen' : order.payment_state === 'cancelled' ? 'Storniert' : 'In Prüfung'}</span></div>
          <span className="draft-row-end"><span className="draft-badge">{euro(order.total_gross_cents)}</span><Arrow/></span></Link>)}</div>}
    </section>
  </div>;
}
