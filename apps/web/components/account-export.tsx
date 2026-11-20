'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, errorMessage, isBackoffice, type Profile } from '../lib/api';
import { Notice } from './site';
import { Reauth } from './reauth';
const sections: Record<string, string> = {
  profile: 'Kontoprofil',
  billing: 'Rechnungsprofile',
  orders: 'Bestellungen',
  acceptances: 'Vertragsnachweise',
  invoices: 'Rechnungsübersicht',
  credits: 'Gutschriftenübersicht',
  access: 'Kurszugänge',
  progress: 'Kapitelabschlüsse',
  exams: 'Prüfungsversuche',
  completions: 'Kursabschlüsse',
  certificates: 'Urkundenübersicht',
};
export function AccountCopy() {
  const [profile, P] = useState<Profile>(),
    [section, S] = useState('profile'),
    [error, E] = useState(''),
    [busy, B] = useState(false),
    [after, F] = useState<string | null>(null),
    [n, N] = useState(0);
  useEffect(() => {
    api<Profile>('/me')
      .then(P)
      .catch((e) => E(errorMessage(e)));
  }, []);
  async function download() {
    B(true);
    E('');
    try {
      const r = await api<{ data: unknown[]; next_cursor: string | null }>('/me/export', 'POST', {
        section,
        ...(after ? { after } : {}),
      });
      const url = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `Meine-Daten-${section}-${n + 1}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      F(r.next_cursor);
      N(n + 1);
    } catch (e) {
      E(errorMessage(e));
    } finally {
      B(false);
    }
  }
  return (
    <section className="account-page content-width">
      <span className="eyebrow">MEIN KONTO</span>
      <h1>Eigene Kontodaten herunterladen</h1>
      <Notice message={error} />
      <p>
        Die JSON-Kopien enthalten vertrauliche Daten. Speichere sie nur auf einem sicheren Gerät. Jeder Download enthält
        bis zu 100 Datensätze des gewählten Bereichs, jeweils zum Abrufzeitpunkt. Weitere Daten, auch zu Gastkäufen,
        Newsletter oder externen Diensten, kannst du unter <Link href="/datenrechte">Meine Datenrechte</Link> anfordern.
      </p>
      {profile && (
        <>
          <div className="dashboard-card">
            <h2>Identität bestätigen</h2>
            <Reauth mfa={isBackoffice(profile)} />
          </div>
          <fieldset className="dashboard-card stack-form" disabled={busy}>
            <legend>Datenkopie</legend>
            <label>
              Datenbereich
              <select
                value={section}
                onChange={(e) => {
                  S(e.target.value);
                  F(null);
                  N(0);
                }}
              >
                {Object.entries(sections).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <button disabled={n > 0 && !after} onClick={download}>
              {after ? 'Nächste Seite herunterladen' : 'JSON herunterladen'}
            </button>
            {n > 0 && <p role="status">{after ? 'Weitere Datensätze sind verfügbar.' : 'Letzte Seite erreicht.'}</p>}
          </fieldset>
        </>
      )}
    </section>
  );
}
