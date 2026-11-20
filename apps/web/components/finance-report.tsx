'use client';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { euro } from '../lib/shop';
import { Notice } from './site';

type Report = {
  period: string;
  timezone: string;
  environment: 'test' | 'live';
  currency: 'EUR';
  as_of: string;
  starts_at: string | null;
  payments_cents: string;
  refunds_cents: string;
  balance_cents: string;
  dispute_face_value_cents: string;
  fees_cents: string|null;
  stripe_fees:{expected:number;verified:number;known_cents:string};
  sold_course_positions:number;
  orders_by_state:{payment_state:string;fulfillment_state:string;count:number}[];
};
const labels:Record<string,string>={awaiting:'Zahlung ausstehend',processing:'In Bearbeitung',paid:'Bezahlt',refunded:'Erstattet',charged_back:'Rückgebucht',failed:'Fehlgeschlagen',cancelled:'Storniert',not_ready:'Nicht bereit',ready:'Bereit',fulfilled:'Erfüllt',blocked:'Gesperrt'};
const localTime = (date: string, zone: string) =>
  new Intl.DateTimeFormat('de-DE', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));

export function FinanceReport() {
  const [period, setPeriod] = useState('today'),
    [revision, refresh] = useState(0);
  const [data, setData] = useState<Report>(),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<Report>(`/admin/dashboard/finance?period=${period}`)
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [period, revision]);
  function reset() {
    setData(undefined);
    setError('');
  }
  return (
    <section className="dashboard-card">
      <h2>Finanzbericht</h2>
      <label>
        Berichtszeitraum{' '}
        <select
          value={period}
          onChange={(e) => {
            reset();
            setPeriod(e.target.value);
          }}
        >
          <option value="today">Heute</option>
          <option value="month">Laufender Monat</option>
          <option value="all">Gesamt</option>
        </select>
      </label>{' '}
      <button
        type="button"
        onClick={() => {
          reset();
          refresh((r) => r + 1);
        }}
      >
        Bericht aktualisieren
      </button>
      <Notice message={error} />
      {!error && !data && <p role="status">Bericht wird geladen …</p>}
      {data && (
        <>
          <p>
            {data.environment === 'test' ? 'Testbetrieb' : 'Livebetrieb'} · {data.currency} · {data.timezone}
            <br />
            {data.starts_at ? `Ab ${localTime(data.starts_at, data.timezone)}` : 'Seit Aufzeichnungsbeginn'} · Stand:{' '}
            <time dateTime={data.as_of}>{localTime(data.as_of, data.timezone)}</time>
          </p>
          <dl>
            <dt>Bestätigte Zahlungseingänge (brutto)</dt>
            <dd>{euro(data.payments_cents)}</dd>
            <dt>Bestätigte Erstattungen</dt>
            <dd>{euro(data.refunds_cents)}</dd>
            <dt>Zahlungseingänge abzüglich Erstattungen</dt>
            <dd>
              <strong>{euro(data.balance_cents)}</strong>
            </dd>
            <dt>Im Zeitraum eröffnete Streitfälle (Streitwert)</dt>
            <dd>{euro(data.dispute_face_value_cents)}</dd>
            <dt>Providergebühren</dt>
            <dd>{data.fees_cents===null?'Nicht erfasst':euro(data.fees_cents)}</dd>
            <dt>Abgeglichene Stripe-Bewegungen (Zahlungen und Erstattungen)</dt><dd>{data.stripe_fees.verified} von {data.stripe_fees.expected} · belegte Teilgebühr: {euro(data.stripe_fees.known_cents)}</dd>
            <dt>Bezahlt bestätigte Kurspositionen (inklusive Paketbestandteile)</dt><dd>{data.sold_course_positions}</dd>
          </dl>
          <h3>Bestellungen dieser Datenbank nach Bestellzeitpunkt (EUR)</h3>{data.orders_by_state.length?<table><thead><tr><th scope="col">Zahlstatus</th><th scope="col">Erfüllungsstatus</th><th scope="col">Anzahl</th></tr></thead><tbody>{data.orders_by_state.map(g=><tr key={g.payment_state+g.fulfillment_state}><td>{labels[g.payment_state]??g.payment_state}</td><td>{labels[g.fulfillment_state]??g.fulfillment_state}</td><td>{g.count}</td></tr>)}</tbody></table>:<p>Keine Bestellungen im Zeitraum.</p>}
          <p>
            Maßgeblich ist die Zahlungs- bzw. Erstattungsbestätigung, nicht das Bestelldatum. Streitwerte sind keine
            gebuchten Verluste und werden nicht abgezogen. Keine steuerliche Umsatz- oder Gewinnrechnung.
          </p>
        </>
      )}
    </section>
  );
}
