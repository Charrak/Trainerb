'use client';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { euro } from '../lib/shop';
import { Notice } from './site';

type Row = {
  kind: 'Rechnung' | 'Gutschrift'; number: string; issued_at: string;
  service_date: string | null; service_end_date: string | null; order_number: string | null;
  buyer_name: string; buyer_city: string; buyer_country: string; buyer_vat_id: string;
  net_cents: string; tax_cents: string; gross_cents: string; currency: string;
  tax_rates: string; payment_state: string | null; content_hash: string | null;
  previous_hash: string | null; original_number: string | null;
};
type Listing = {
  period: { from: string | null; to: string };
  counts: { invoices: number; credit_notes: number };
  rows: Row[];
  totals: { net_cents: string; tax_cents: string; gross_cents: string;
    credit_net_cents: string; credit_tax_cents: string; credit_gross_cents: string };
  retention_note: string;
  retention: { years: number; basis: string; earliest_release: string | null;
    latest_release: string | null; documents: number };
  note: string;
};
type Chain = { checked: number; intact: boolean; unsealed: string[];
  broken: { kind: string; number: string; reason: string }[]; note: string };

const day = (date: Date) => date.toISOString().slice(0, 10);
const monthStart = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`; };
const showDate = (value: string | null) => value ? new Date(`${value}T00:00:00Z`)
  .toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }) : '—';

/**
 * Belegausgabe: Liste, Sammel-PDF und Kettenprüfung.
 *
 * Die Anzeige behauptet keine Buchhaltung. Sie zeigt, welche Belege in einem
 * Zeitraum ausgestellt wurden, mit welchen Pflichtangaben und mit welcher
 * Prüfsumme — und ob die Prüfsummen noch zu den Belegen passen.
 */
export function DocumentExport() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(day(new Date()));
  const [data, setData] = useState<Listing>();
  const [chain, setChain] = useState<Chain>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const query = new URLSearchParams({ from, to }).toString();
  async function load() {
    setBusy(true); setError('');
    try {
      setData(await api<Listing>(`/admin/documents?${query}`));
      setChain(await api<Chain>('/admin/documents/verify'));
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  // Beim Öffnen und bei jeder Zeitraumänderung werden Liste und Kettenprüfung
  // zusammen geholt: die Prüfung gehört zur Aussage der Liste, nicht zu einem
  // zweiten Klick.
  useEffect(() => { let active = true;
    setData(undefined); setChain(undefined); setError('');
    Promise.all([api<Listing>(`/admin/documents?${query}`), api<Chain>('/admin/documents/verify')])
      .then(([listing, checked]) => { if (active) { setData(listing); setChain(checked); } })
      .catch(e => { if (active) setError(errorMessage(e)); });
    return () => { active = false; };
  }, [query]);

  return (
    <section className="dashboard-card">
      <h2>Belege für die Buchhaltung</h2>
      <p>
        Rechnungen und Gutschriften eines Zeitraums mit allen Pflichtangaben, den Steuerbeträgen je Satz
        und ihrer Prüfsumme. Grundlage sind ausschließlich ausgestellte Belege; es wird nichts neu berechnet.
      </p>
      <div className="field-row">
        <label>Von <input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label>Bis <input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
      </div>
      <p>
        <button type="button" onClick={() => void load()} disabled={busy}>
          {busy ? 'Bitte warten …' : 'Auswertung und Prüfung aktualisieren'}
        </button>{' '}
        <a className="button button-secondary" href={`/api/v1/admin/documents.csv?${query}`}>Liste als CSV</a>{' '}
        <a className="button button-secondary" href={`/api/v1/admin/documents.pdf?${query}`}>Alle Belege als PDF</a>
      </p>
      <Notice message={error} />
      {chain && (
        <p role="status">
          Kettenprüfung: {chain.checked} Belege geprüft —{' '}
          <strong>{chain.intact ? 'Prüfsummen und Verkettung stimmen' : 'Abweichung gefunden'}</strong>.
          {chain.unsealed.length > 0 && ` ${chain.unsealed.length} Belege aus der Zeit vor der Prüfsumme sind noch nicht versiegelt.`}
        </p>
      )}
      {chain && chain.broken.length > 0 && (
        <ul>
          {chain.broken.map(entry => (
            <li key={`${entry.kind}-${entry.number}`}>
              {entry.kind === 'invoice' ? 'Rechnung' : 'Gutschrift'} {entry.number}:{' '}
              {entry.reason === 'hash_mismatch' ? 'Inhalt weicht von der Prüfsumme ab' : 'Verkettung unterbrochen'}
            </li>
          ))}
        </ul>
      )}
      {data && (
        <>
          <dl>
            <dt>Rechnungen</dt><dd>{data.counts.invoices} · netto {euro(data.totals.net_cents)} · Steuer {euro(data.totals.tax_cents)} · brutto {euro(data.totals.gross_cents)}</dd>
            <dt>Gutschriften</dt><dd>{data.counts.credit_notes} · netto {euro(data.totals.credit_net_cents)} · Steuer {euro(data.totals.credit_tax_cents)} · brutto {euro(data.totals.credit_gross_cents)}</dd>
          </dl>
          {!data.rows.length && <p>Keine Belege im gewählten Zeitraum.</p>}
          {data.rows.length > 0 && (
            <table>
              <caption>{data.rows.length} Belege</caption>
              <thead>
                <tr>
                  <th scope="col">Beleg</th><th scope="col">Datum</th><th scope="col">Leistung</th>
                  <th scope="col">Empfänger</th><th scope="col">Brutto</th><th scope="col">Prüfsumme</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map(row => (
                  <tr key={`${row.kind}-${row.number}`}>
                    <th scope="row">{row.kind} {row.number}</th>
                    <td>{showDate(row.issued_at.slice(0, 10))}</td>
                    <td>{row.service_end_date
                      ? `${showDate(row.service_date)} – ${showDate(row.service_end_date)}`
                      : showDate(row.service_date)}</td>
                    <td>{row.buyer_name}<br /><span className="muted small-print">{row.buyer_city} {row.buyer_country}</span></td>
                    <td>{euro(row.gross_cents)}</td>
                    <td><code title={row.content_hash ?? 'nicht versiegelt'}>{(row.content_hash ?? '—').slice(0, 16)}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted small-print">
            <strong>Aufbewahrung:</strong>{' '}
            {data.retention.documents === 0
              ? 'keine Belege im gewählten Zeitraum.'
              : `bis ${showDate(data.retention.latest_release)} aufzubewahren `
                + `(${data.retention.years} Jahre, ${data.retention.basis}); frühestens ab `
                + `${showDate(data.retention.earliest_release)} entbehrlich.`}{' '}
            {data.retention_note}
          </p>
          <p className="muted small-print">{data.note}</p>
          {chain && <p className="muted small-print">{chain.note}</p>}
        </>
      )}
    </section>
  );
}
