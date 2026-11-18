'use client';
import { useEffect, useState } from 'react';
import { api, ApiError, errorMessage } from '../lib/api';
import { Arrow, Field, Notice } from './site';

/**
 * The public withdrawal form.
 *
 * Anyone may use it: no login, no account, and no order lookup. The number of
 * the order is typed by hand and stored as text — it is evidence of what the
 * person said, not proof that they bought anything.
 *
 * The response is always the same sentence. A form that answers "this order does
 * not exist" would turn the page into a lookup service for other people's
 * purchases, so the success message is identical for every input.
 */
export function WithdrawalForm() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  if (sent) return <div className="form-card">
    <span className="section-kicker">WIDERRUF</span>
    <h2>Dein Widerruf ist eingegangen<span className="accent-dot">.</span></h2>
    <p>Wir haben deine Erklärung dokumentiert und senden eine Bestätigung mit Datum und Uhrzeit an die
      angegebene Adresse. Diese Bestätigung ist der Beleg für die Frist — bitte bewahre sie auf.</p>
    <p className="muted">Ein Widerruf löst nicht automatisch eine Erstattung aus. Wir prüfen den Vorgang und
      melden uns mit dem Ergebnis. Antworte einfach auf die Bestätigungsmail, wenn du etwas ergänzen möchtest.</p>
  </div>;

  return <form className="form-card" onSubmit={event => {
    event.preventDefault(); setError(''); setSending(true);
    void (async () => {
      try {
        await api('/withdrawal-requests', 'POST', {
          contact_email: email,
          ...(name.trim() ? { customer_name: name.trim() } : {}),
          ...(orderNumber.trim() ? { order_number: orderNumber.trim() } : {}),
          ...(message.trim() ? { message: message.trim() } : {}),
        });
        setSent(true);
      } catch (e) {
        // Only the sender's own input error is named; anything about an order
        // stays silent, because silence is the answer that leaks nothing.
        if (e instanceof ApiError && e.status === 429) {
          setError('Zu viele Anfragen in kurzer Zeit. Bitte versuche es später erneut.');
        } else if (e instanceof ApiError && e.code === 'INVALID_FIELD') {
          setError('Bitte prüfe deine E-Mail-Adresse.');
        } else setError(errorMessage(e));
      } finally { setSending(false); }
    })();
  }}>
    <span className="section-kicker">WIDERRUF</span>
    <h2>Vertrag widerrufen<span className="accent-dot">.</span></h2>
    <p>Erkläre hier deinen Widerruf. Es entstehen keine Kosten, und du brauchst keinen Grund zu nennen.
      Wenn du deine Bestellnummer zur Hand hast, hilft sie bei der Zuordnung.</p>
    <Notice message={error}/>
    <Field label="E-Mail-Adresse" id="withdrawal-email" hint="An diese Adresse senden wir die Bestätigung.">
      <input id="withdrawal-email" type="email" value={email} onChange={e => setEmail(e.target.value)}
        maxLength={254} required autoComplete="email"/></Field>
    <Field label="Name (optional)" id="withdrawal-name"><input id="withdrawal-name" value={name}
      onChange={e => setName(e.target.value)} maxLength={200} autoComplete="name"/></Field>
    <Field label="Bestellnummer (optional)" id="withdrawal-order"
      hint="Zum Beispiel TB-2026-000123. Sie steht in der Bestellbestätigung.">
      <input id="withdrawal-order" value={orderNumber} onChange={e => setOrderNumber(e.target.value)}
        maxLength={40}/></Field>
    <Field label="Nachricht (optional)" id="withdrawal-message"><textarea id="withdrawal-message" rows={5}
      value={message} onChange={e => setMessage(e.target.value)} maxLength={2000}/></Field>
    <button className="button button-primary" disabled={sending}>
      {sending ? 'Bitte warten …' : 'Widerruf erklären'} <Arrow/></button>
    <p className="muted">Mit dem Absenden erklärst du den Widerruf. Die Bestätigung geht an die angegebene
      Adresse; erst nach Bestätigung dieser Adresse können wir den Vorgang einer Bestellung zuordnen.</p>
  </form>;
}

/**
 * Opens the one-time link from the confirmation mail.
 *
 * The token arrives in the URL fragment, which the browser never sends to the
 * server, so it stays out of access logs. It is posted once and then dead.
 */
export function WithdrawalVerify() {
  const [state, setState] = useState<'pending' | 'done' | 'error'>('pending');
  const [error, setError] = useState('');
  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (!token) { setState('error'); setError('Diesem Link fehlt die Bestätigung. Bitte öffne den Link aus der E-Mail vollständig.'); return; }
    // The token is removed from the address bar before it is used.
    window.history.replaceState(null, '', window.location.pathname);
    void (async () => {
      try { await api('/withdrawal-requests/verify', 'POST', { token }); setState('done'); }
      catch (e) {
        setState('error');
        setError(e instanceof ApiError && e.code === 'TOKEN_EXPIRED'
          ? 'Dieser Link ist abgelaufen. Bitte antworte auf die Bestätigungsmail, dann senden wir einen neuen.'
          : e instanceof ApiError && e.code === 'TOKEN_USED'
            ? 'Dieser Link wurde bereits verwendet. Deine Adresse ist bestätigt.' : errorMessage(e));
      }
    })();
  }, []);
  return <div className="form-card">
    <span className="section-kicker">WIDERRUF</span>
    {state === 'pending' && <><h2>Adresse wird bestätigt …</h2><p className="muted">Einen Moment bitte.</p></>}
    {state === 'done' && <><h2>Adresse bestätigt<span className="accent-dot">.</span></h2>
      <p>Danke. Wir können deinen Widerruf jetzt deiner Bestellung zuordnen und melden uns mit dem Ergebnis.</p></>}
    {state === 'error' && <><h2>Bestätigung nicht möglich</h2><Notice message={error}/></>}
  </div>;
}
