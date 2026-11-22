'use client';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { euro } from '../lib/shop';
import { Notice } from './site';

type Row = { section: string; category: string; documents: number;
  net_cents: string; tax_cents: string; gross_cents: string; currency: string };
type Ledger = {
  period: string;
  timezone: string;
  environment: 'test' | 'live';
  currency: 'EUR';
  as_of: string;
  starts_at: string | null;
  rows: Row[];
  totals: {
    invoice_net_cents: string; invoice_tax_cents: string; invoice_gross_cents: string;
    credit_net_cents: string; credit_tax_cents: string; credit_gross_cents: string;
    net_after_credits_cents: string; tax_after_credits_cents: string;
    payments_cents: string; refunds_cents: string; receivables_cents: string;
  };
  note: string;
};
const sections: Record<string, string> = {
  income: 'Rechnungen (netto, Steuer, brutto)',
  credits: 'Gutschriften (netto, Steuer, brutto)',
  tax: 'Steuer je Satz',
  payments: 'Bestätigte Zahlungseingänge nach Weg',
  refunds: 'Bestätigte Erstattungen nach Weg',
  receivables: 'Offene Forderungen aus Rechnungen',
};
const localTime = (date: string, zone: string) =>
  new Intl.DateTimeFormat('de-DE', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));
const rateLabel = (category: string) => {
  const match = /^(?:invoice|credit)_tax_(\d+)$/.exec(category);
  if (!match) return category;
  return `${(Number(match[1]) / 100).toLocaleString('de-DE', { maximumFractionDigits: 2 })} %`;
};
const rowLabel = (row: Row) => {
  if (row.section === 'payments' || row.section === 'refunds') return row.category === 'stripe' ? 'Karte (Stripe)' : 'Rechnung/Überweisung';
  if (row.section === 'tax') return rateLabel(row.category);
  if (row.category === 'invoice_net') return 'Rechnungspositionen gesamt';
  if (row.category === 'credit_note_net') return 'Gutschriftpositionen gesamt';
  return 'Rechnungen ohne bestätigte Zahlung';
};

/**
 * Buchhaltungsnahe Auswertung. Die Anzeige behauptet bewusst keine
 * Buchhaltung: sie zeigt Belege und ihre Steuer, nicht Konten oder Meldungen.
 */
export function LedgerReport() {
  const [period, setPeriod] = useState('month');
  const [revision, refresh] = useState(0);
  const [data, setData] = useState<Ledger>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<Ledger>(`/admin/dashboard/ledger?period=${period}`)
      .then(value => { if (active) setData(value); })
      .catch(e => { if (active) setError(errorMessage(e)); });
    return () => { active = false; };
  }, [period, revision]);
  const reset = () => { setData(undefined); setError(''); };
  const grouped = data ? Object.keys(sections).map(section => ({
    section, rows: data.rows.filter(row => row.section === section) })).filter(group => group.rows.length) : [];
  return (
    <section className="dashboard-card">
      <h2>Buchhaltungsauswertung</h2>
      <p>
        Arbeitsgrundlage für die Buchhaltung, kein Hauptbuch. Grundlage sind ausschließlich ausgestellte Rechnungen,
        Gutschriften und bestätigte Zahlungen aus eingefrorenen Belegen.
      </p>
      <label>
        Zeitraum{' '}
        <select value={period} onChange={e => { reset(); setPeriod(e.target.value); }}>
          <option value="today">Heute</option>
          <option value="month">Laufender Monat</option>
          <option value="all">Gesamt</option>
        </select>
      </label>{' '}
      <button type="button" onClick={() => { reset(); refresh(value => value + 1); }}>Auswertung aktualisieren</button>
      <Notice message={error} />
      {!error && !data && <p role="status">Auswertung wird geladen …</p>}
      {data && (
        <>
          <p>
            {data.environment === 'test' ? 'Testbetrieb' : 'Livebetrieb'} · {data.currency} · {data.timezone}
            <br />
            {data.starts_at ? `Ab ${localTime(data.starts_at, data.timezone)}` : 'Seit Aufzeichnungsbeginn'} · Stand:{' '}
            <time dateTime={data.as_of}>{localTime(data.as_of, data.timezone)}</time>
          </p>
          <dl>
            <dt>Rechnungen netto / Steuer / brutto</dt>
            <dd>{euro(data.totals.invoice_net_cents)} / {euro(data.totals.invoice_tax_cents)} / {euro(data.totals.invoice_gross_cents)}</dd>
            <dt>Gutschriften netto / Steuer / brutto</dt>
            <dd>{euro(data.totals.credit_net_cents)} / {euro(data.totals.credit_tax_cents)} / {euro(data.totals.credit_gross_cents)}</dd>
            <dt>Netto nach Gutschriften</dt>
            <dd><strong>{euro(data.totals.net_after_credits_cents)}</strong></dd>
            <dt>Steuer nach Gutschriften</dt>
            <dd><strong>{euro(data.totals.tax_after_credits_cents)}</strong></dd>
            <dt>Bestätigte Zahlungseingänge</dt>
            <dd>{euro(data.totals.payments_cents)}</dd>
            <dt>Bestätigte Erstattungen</dt>
            <dd>{euro(data.totals.refunds_cents)}</dd>
            <dt>Offene Forderungen aus gestellten Rechnungen</dt>
            <dd>{euro(data.totals.receivables_cents)}</dd>
          </dl>
          {!grouped.length && <p>Keine Belege im gewählten Zeitraum.</p>}
          {grouped.map(group => (
            <div key={group.section}>
              <h3>{sections[group.section] ?? group.section}</h3>
              <table>
                <caption>Belege: {group.rows.reduce((total, row) => total + row.documents, 0)}</caption>
                <thead>
                  <tr>
                    <th scope="col">Position</th>
                    <th scope="col">Netto</th>
                    <th scope="col">Steuer</th>
                    <th scope="col">Brutto</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map(row => (
                    <tr key={`${row.section}-${row.category}`}>
                      <th scope="row">{rowLabel(row)}</th>
                      <td>{euro(row.net_cents)}</td>
                      <td>{euro(row.tax_cents)}</td>
                      <td>{euro(row.gross_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          <p className="muted small-print">{data.note}</p>
        </>
      )}
    </section>
  );
}
