'use client';
import { EDITORIAL_TEXT_LIMIT } from '@trainerb/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Notice } from './site';
import type { ProviderDetails } from '@trainerb/contracts';
import type { ProfileData } from './provider-editor';
import { ProviderFacts } from './provider-details';
import { Reauth } from './reauth';
const names = {
  terms: 'AGB',
  privacy: 'Datenschutz',
  withdrawal: 'Widerrufsbelehrung',
  imprint: 'Impressum',
  payment_info: 'Zahlungsinformationen',
};
type Kind = keyof typeof names;
const paths: Record<Kind, string> = {
  terms: '/agb',
  privacy: '/datenschutz',
  withdrawal: '/widerrufsbelehrung',
  imprint: '/impressum',
  payment_info: '/zahlungsinformationen',
};
type V = {
  id: string;
  version: number;
  status: string;
  wording: string;
  provider_revision: number | null;
  provider_snapshot: ProviderDetails | null;
};
type Data = { versions: V[]; active_version: number | null };
export function LegalEditor() {
  const [kind, setKind] = useState<Kind>('terms');
  return (
    <div className="account-page content-width">
      <header className="dashboard-title">
        <div>
          <span className="eyebrow">REDAKTION</span>
          <h1>Rechtstexte</h1>
          <p>Nur geprüfte Fassungen aktivieren. Die technische Freigabe ersetzt keine rechtliche Prüfung.</p>
        </div>
        <Link href="/admin/anbieter">Anbieterprofil bearbeiten</Link>
        <Link href="/konto">Zum Konto</Link>
      </header>
      <section className="dashboard-card">
        <label>
          Rechtsdokument{' '}
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {Object.entries(names).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </section>
      <DocumentEditor key={kind} kind={kind} />
    </div>
  );
}
function DocumentEditor({ kind }: { kind: Kind }) {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [data, setData] = useState<Data>(),
    [wording, setWording] = useState(''),
    [checked, check] = useState(false),
    [busy, setBusy] = useState(false),
    [revision, reload] = useState(0),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    setData(undefined);
    check(false);
    setError('');
    Promise.all([
      api<Data>('/admin/legal-documents/' + kind),
      kind === 'imprint' ? api<ProfileData>('/admin/provider-profile') : Promise.resolve(null),
    ])
      .then(([r, p]) => {
        if (active) {
          setProfile(p);
          setData(r);
          setWording(r.versions[0]?.wording ?? '');
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [kind, revision]);
  const latest = data?.versions[0],
    changed =
      wording !== (latest?.wording ?? '') || (kind === 'imprint' && profile?.revision !== latest?.provider_revision);
  async function write(activate: boolean) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (activate) await api(`/admin/commerce/legal/${latest!.id}/activate`, 'POST', {});
      else
        await api('/admin/commerce/legal', 'POST', {
          kind,
          wording,
          base_id: latest?.id ?? null,
          ...(profile ? { provider_revision: profile.revision } : {}),
        });
      setNotice(activate ? 'Gespeicherte Fassung aktiviert.' : 'Neue Fassung als Entwurf gespeichert.');
      reload((n) => n + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Notice message={error} />
      <Notice message={notice} kind="success" />
      {error && (
        <button disabled={busy} onClick={() => reload((n) => n + 1)}>
          Gespeicherten Stand laden (Eingaben verwerfen)
        </button>
      )}
      {!data && !error && <p role="status">Dokument wird geladen …</p>}
      {data && (
        <>
          <section className="dashboard-card">
            <h2>{names[kind]} bearbeiten</h2>
            <p>
              {data.active_version ? (
                <>
                  Aktiv: Fassung {data.active_version} · <Link href={paths[kind]}>Öffentlichen Wortlaut ansehen</Link>
                </>
              ) : (
                'Noch keine aktive Fassung.'
              )}
            </p>
            <div className="stack-form">
              <label htmlFor="legal-wording">Wortlaut</label>
              <textarea
                id="legal-wording"
                disabled={busy}
                value={wording}
                maxLength={EDITORIAL_TEXT_LIMIT}
                rows={12}
                onChange={(e) => {
                  setWording(e.target.value);
                  check(false);
                }}
              />
              <button
                disabled={busy || (kind === 'imprint' && !profile?.details) || !wording.trim() || !changed}
                onClick={() => write(false)}
              >
                Neue Fassung als Entwurf speichern
              </button>
            </div>
          </section>
          <section className="dashboard-card">
            <h2>Vorschau</h2>
            {kind === 'imprint' &&
              (profile?.details ? (
                <>
                  <p>Anbieterprofil · Stand {profile.revision}</p>
                  <ProviderFacts details={profile.details} />
                </>
              ) : (
                <p>Vor dem Speichern ein vollständiges Anbieterprofil anlegen.</p>
              ))}
            <p style={{ whiteSpace: 'pre-wrap' }}>{wording}</p>
            <label>
              <input
                type="checkbox"
                checked={checked}
                disabled={busy || changed || latest?.status !== 'draft'}
                onChange={(e) => check(e.target.checked)}
              />{' '}
              Der gespeicherte Wortlaut wurde rechtlich geprüft und soll öffentlich gelten.
            </label>{' '}
            <button disabled={busy || !checked || changed || latest?.status !== 'draft'} onClick={() => write(true)}>
              Geprüfte Fassung aktivieren
            </button>
          </section>
          <section className="dashboard-card">
            <h2>Letzte Fassungen</h2>
            {data.versions.length === 0 && <p>Noch keine Fassung gespeichert.</p>}
            {data.versions.map((v) => (
              <details key={v.id}>
                <summary>
                  Fassung {v.version} ·{' '}
                  {v.status === 'active' ? 'aktiv' : v.status === 'draft' ? 'Entwurf' : 'abgelöst'}
                </summary>
                {v.provider_snapshot && <ProviderFacts details={v.provider_snapshot} />}
                <p style={{ whiteSpace: 'pre-wrap' }}>{v.wording}</p>
              </details>
            ))}
          </section>
          <section className="dashboard-card">
            <h2>Identität für Änderungen bestätigen</h2>
            <Reauth mfa />
          </section>
        </>
      )}
    </>
  );
}
