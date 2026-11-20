'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { providerFields, type ProviderDetails, type ProviderField } from '@trainerb/contracts';
import { api, errorMessage } from '../lib/api';
import { Notice } from './site';
import { Reauth } from './reauth';
export type ProfileData = { revision: number; details: ProviderDetails | null };
const path = '/admin/provider-profile';
const keys = Object.keys(providerFields) as ProviderField[];
const blank = Object.fromEntries(
  keys.map((k) => [k, k === 'responsible_name' ? 'Soufian Charrak' : '']),
) as ProviderDetails;
export function ProviderEditor() {
  const [profile, setProfile] = useState<ProfileData>(),
    [fields, setFields] = useState(blank),
    [load, reload] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    setProfile(undefined);
    setError('');
    api<ProfileData>(path)
      .then((r) => {
        if (active) {
          setProfile(r);
          setFields(r.details ?? blank);
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [load]);
  return (
    <div className="account-page content-width">
      <header className="dashboard-title">
        <div>
          <span className="eyebrow">REDAKTION</span>
          <h1>Anbieterprofil</h1>
          <p>
            Diese Angaben sind zur Veröffentlichung im Impressum bestimmt. Keine Bankdaten, Geheimnisse oder internen
            Notizen eintragen.
          </p>
        </div>
        <Link href="/admin/rechtstexte">Zum Rechtstexteditor</Link>
      </header>
      <Notice message={error} />
      <Notice kind="success" message={message} />
      {error && (
        <button
          disabled={busy}
          onClick={() => {
            setMessage('');
            reload((n) => n + 1);
          }}
        >
          Stand neu laden (Eingaben verwerfen)
        </button>
      )}
      {!profile && !error && <p role="status">Profil wird geladen …</p>}
      {profile && (
        <>
          <section className="dashboard-card">
            <h2>Anbieterangaben bearbeiten</h2>
            <p>
              {profile.revision ? `Gespeicherter Stand: ${profile.revision}.` : 'Noch kein Profil gespeichert.'}{' '}
              Pflichtangaben sind mit * markiert. Weitere gesetzlich erforderliche Angaben nach Prüfung ergänzen.
            </p>
            <form
              className="stack-form"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError('');
                setMessage('');
                try {
                  const r = await api<ProfileData>(path, 'PATCH', { revision: profile.revision, details: fields });
                  setProfile(r);
                  setFields(r.details!);
                  setMessage(
                    r.revision === profile.revision
                      ? 'Keine Änderung.'
                      : 'Profil gespeichert. Bitte eine neue Impressumsfassung prüfen. Neue Verkäufe bleiben bis zur ausdrücklichen Freigabe gesperrt.',
                  );
                } catch (err) {
                  setError(errorMessage(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {keys.map((k) => {
                const [label, max, required] = providerFields[k];
                return (
                  <label key={k}>
                    {label}
                    {required ? ' *' : ''}
                    <input
                      disabled={busy}
                      required={required}
                      type={k === 'contact_email' ? 'email' : 'text'}
                      maxLength={max}
                      value={fields[k]}
                      onChange={(e) => setFields({ ...fields, [k]: e.target.value })}
                    />
                  </label>
                );
              })}
              <p>
                Eine Änderung sperrt den Verkauf sofort. Das öffentliche Impressum bleibt bis zur Freigabe einer neuen
                Fassung unverändert.
              </p>
              <button disabled={busy || !keys.some((k) => fields[k] !== profile.details?.[k])}>
                Anbieterprofil speichern
              </button>
            </form>
          </section>
          <section className="dashboard-card">
            <h2>Identität für Änderungen bestätigen</h2>
            <Reauth mfa />
          </section>
        </>
      )}
    </div>
  );
}
