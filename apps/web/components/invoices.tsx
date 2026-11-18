'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Arrow, Notice } from './site';
import { dateOnly, euro, paymentStateLabels, type CreditNoteSummary, type InvoiceSummary } from '../lib/shop';

/**
 * The account's invoices.
 *
 * The PDF is fetched with the session cookie, so a plain `<a href>` cannot be
 * used: the file arrives as a blob and is downloaded from memory. That also
 * means a failed permission check surfaces as an error message instead of a
 * browser error page.
 */
export function MyInvoices() {
  const [invoices, setInvoices] = useState<InvoiceSummary[]>();
  const [creditNotes, setCreditNotes] = useState<CreditNoteSummary[]>([]);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState('');
  useEffect(() => {
    let active = true;
    api<{ data: InvoiceSummary[] }>('/invoices')
      .then(value => { if (active) setInvoices(value.data); })
      .catch(e => { if (active) setError(errorMessage(e)); });
    // A credit note exists only after a refund; the list is simply empty until
    // then. It is a separate request so a refund failure never hides invoices.
    api<{ data: CreditNoteSummary[] }>('/credit-notes')
      .then(value => { if (active) setCreditNotes(value.data); })
      .catch(() => { /* summary list stays empty; download errors still show */ });
    return () => { active = false; };
  }, []);

  async function download(invoice: InvoiceSummary | CreditNoteSummary) {
    setDownloading(invoice.id); setError('');
    const creditNote = 'document_number' in invoice;
    try {
      const path = creditNote ? `/api/v1/credit-notes/${invoice.id}/pdf` : `/api/v1/invoices/${invoice.id}/pdf`;
      const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('Der Beleg konnte nicht geladen werden. Bitte versuche es später erneut.');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = creditNote ? `Gutschrift-${invoice.document_number}.pdf` : `Rechnung-${invoice.invoice_number}.pdf`;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : errorMessage(e));
    } finally { setDownloading(''); }
  }

  return <div className="account-page content-width">
    <div className="dashboard-title"><div><span className="eyebrow"><span className="eyebrow-line"/> DEINE BELEGE</span>
      <h1>Rechnungen &amp; Gutschriften<span className="accent-dot">.</span></h1>
      <p>Jede Rechnung ist unveränderlich. Ein Beleg wird erst bereitgestellt, wenn die Zahlung bestätigt ist.</p></div>
      <Link className="button button-secondary" href="/konto">← Zum Konto</Link></div>
    <Notice message={error}/>
    <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">ÜBERSICHT</span>
      <h2>Deine Rechnungen</h2></div></div>
      {!invoices && !error && <p className="muted">Rechnungen werden geladen …</p>}
      {invoices && !invoices.length && !error && <p className="muted">Sobald du etwas kaufst, findest du hier deine Rechnung.</p>}
      {!!invoices?.length && <div className="draft-list">{invoices.map(invoice => <div className="draft-row" key={invoice.id}>
        <div><strong>{invoice.invoice_number}</strong>
          <span>{dateOnly(invoice.issued_at)} · Bestellung {invoice.order_number} · {paymentStateLabels[invoice.payment_state] ?? invoice.payment_state}</span></div>
        <span className="draft-row-end">
          <span className="draft-badge">{euro(invoice.total_gross_cents)}</span>
          {invoice.payment_state === 'paid'
            ? <button type="button" className="button button-outline" disabled={downloading === invoice.id}
                onClick={() => void download(invoice)}>
                {downloading === invoice.id ? 'Bitte warten …' : 'PDF herunterladen'}</button>
            : <Link className="text-link" href={`/bestellung/${invoice.order_id}`}>Zur Bestellung <Arrow/></Link>}
        </span></div>)}</div>}
    </section>
  </div>;
}

/** One download button for a single invoice, used on the order page. */
export function InvoiceDownload({ href, label = 'Rechnung als PDF herunterladen' }: { href: string; label?: string }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/v1${href}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('Der Beleg konnte nicht geladen werden.');
      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') || '';
      const name = /filename="([^"]+)"/.exec(disposition)?.[1] || 'Rechnung.pdf';
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = name;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : errorMessage(e));
    } finally { setBusy(false); }
  }
  return <div className="stack-form">
    <button type="button" className="button button-primary" disabled={busy} onClick={() => void download()}>
      {busy ? 'Bitte warten …' : label} <Arrow/></button>
    <Notice message={error}/>
  </div>;
}
