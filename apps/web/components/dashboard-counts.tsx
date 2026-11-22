'use client';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { api, errorMessage } from '../lib/api';
import { FinanceReport } from './finance-report';
import { LedgerReport } from './ledger-report';
import { Notice } from './site';

type Counts =
  | { scope: 'global' | 'assigned'; courses: number; completions: number }
  | { scope: 'basic'; public_courses: number };
export function DashboardCounts() {
  const [data, setData] = useState<Counts>(),
    [error, setError] = useState(''),
    [revision, refresh] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    setData(undefined);
    api<Counts>('/admin/dashboard')
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [revision]);
  return (
    <div className="account-page content-width">
      <div className="dashboard-title">
        <div>
          <span className="eyebrow">VERWALTUNG</span>
          <h1>Kurskennzahlen</h1>
          <p>Aktueller Bestand, ohne personenbezogene Einzelansicht.</p>
        </div>
        <Link href="/konto">Zum Konto</Link>
      </div>
      <section className="dashboard-card">
        <Notice message={error} />
        {!data && !error && <p role="status">Kennzahlen werden geladen …</p>}
        {data &&
          (data.scope === 'basic' ? (
            <>
              <h2>Öffentlicher Katalog</h2>
              <p>
                Öffentlich gelistete, veröffentlichte Kurse: <strong>{data.public_courses}</strong>
              </p>
            </>
          ) : (
            <>
              <h2>{data.scope === 'global' ? 'Alle Kurse' : 'Mir zugewiesene Kurse'}</h2>
              <dl>
                <dt>Kurse (einschließlich Entwürfe)</dt>
                <dd>{data.courses}</dd>
                <dt>Nachgewiesene Ausbildungsabschlüsse (gesamt)</dt>
                <dd>{data.completions}</dd>
              </dl>
              <p>Gezählt wird der Abschluss pro Zugang. Eine Ersatzurkunde zählt nicht als weiterer Abschluss.</p>
            </>
          ))}
        <button disabled={!data && !error} type="button" onClick={() => refresh((r) => r + 1)}>
          Aktualisieren
        </button>
      </section>
      {data?.scope === 'global' && <FinanceReport/>}
      {data?.scope === 'global' && <LedgerReport/>}
    </div>
  );
}
