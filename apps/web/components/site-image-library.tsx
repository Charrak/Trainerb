'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, errorMessage } from '../lib/api';
import { Notice } from './site';
import { Reauth } from './reauth';
type Row = {
  id: string;
  original_name: string;
  sha256: string;
  status: string;
  approved_at: string | null;
  own: boolean;
  promotion_error: string | null;
  asset_status?: string;
  rights_ref: string | null;
  rights_withdrawn_at: string | null;
};
type List = { data: Row[]; next_cursor: string | null };
const path = '/admin/site-image-uploads';
const states: Record<string, string> = {
  pending_scan: 'Scan ausstehend',
  clean: 'Scan bestanden',
  infected: 'Datei gesperrt',
  scan_error: 'Scanfehler',
};
export function SiteImageLibrary() {
  const [file, F] = useState<File>(),
    [list, L] = useState<List>(),
    [id, I] = useState(''),
    [hash, H] = useState(''),
    [ref, R] = useState(''),
    [checked, C] = useState(false),
    [busy, B] = useState(false),
    [error, E] = useState(''),
    [msg, M] = useState('');
  const row = list?.data.find((r) => r.id === id);
  async function load(before?: string) {
    L(await api<List>(path + (before ? '?before=' + before : '')));
    I('');
    H('');
    C(false);
    R('');
  }
  useEffect(() => {
    load().catch((e) => E(errorMessage(e)));
  }, []);
  async function run(f: () => Promise<unknown>, message: string) {
    B(true);
    E('');
    M('');
    try {
      await f();
      await load();
      M(message);
    } catch (e) {
      E(errorMessage(e));
    } finally {
      B(false);
    }
  }
  async function compare(f: File) {
    B(true);
    E('');
    H('');
    C(false);
    try {
      if (f.size > 5 * 1024 * 1024) throw Error();
      H(
        Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer())), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join(''),
      );
    } catch {
      E('Dateiabgleich fehlgeschlagen.');
    } finally {
      B(false);
    }
  }
  return (
    <div className="account-page content-width">
      <span className="eyebrow">WEBSITE-REDAKTION</span>
      <h1>Öffentliche Seitenbilder</h1>
      <Link href="/admin/website">Zum Seiteneditor</Link>
      <Notice message={error} />
      <Notice kind="success" message={msg} />
      <fieldset disabled={busy} className="dashboard-card stack-form">
        <legend>Bild in Quarantäne einreichen</legend>
        <p>
          Nur für die öffentliche Website bestimmte PNG- oder JPEG-Bilder, maximal 5 MiB. Kursdateien können hier nicht
          umgewidmet werden.
        </p>
        <label>
          Neue Bilddatei
          <input type="file" accept="image/png,image/jpeg" onChange={(e) => F(e.target.files?.[0])} />
        </label>
        <button
          disabled={!file || file.size > 5 * 1024 * 1024}
          onClick={() => run(() => api(path, 'POST', file), 'Bild zur Prüfung eingereicht.')}
        >
          Zur Prüfung einreichen
        </button>
      </fieldset>
      <fieldset disabled={busy} className="dashboard-card stack-form">
        <legend>Rechte und Freigabe</legend>
        <button onClick={() => run(() => Promise.resolve(), 'Stand aktualisiert.')}>Aktualisieren</button>
        <label>
          Bildbeleg
          <select
            value={id}
            onChange={(e) => {
              I(e.target.value);
              H('');
              C(false);
              R('');
            }}
          >
            <option value="">Bitte auswählen</option>
            {list?.data.map((x) => (
              <option key={x.id} value={x.id}>
                {x.original_name} · {x.id}
              </option>
            ))}
          </select>
        </label>
        {list?.next_cursor && (
          <button onClick={() => load(list.next_cursor!).catch((e) => E(errorMessage(e)))}>Ältere Belege</button>
        )}
        {row && (
          <>
            <p>
              {states[row.status]} ·{' '}
              {row.rights_withdrawn_at || row.asset_status === 'rejected'
                ? 'Zurückgenommen'
                : row.asset_status === 'ready'
                  ? 'Für Seiten verwendbar'
                  : row.promotion_error
                    ? 'Übernahme fehlgeschlagen'
                    : row.approved_at
                      ? 'Zur Übernahme freigegeben'
                      : 'Keine Freigabe'}
            </p>
            {row.rights_ref && <p>Rechtenachweis: {row.rights_ref}</p>}
            {row.own && !row.approved_at && <p>Eine andere berechtigte Person muss das Bild freigeben.</p>}
            {!row.own && !row.approved_at && row.status === 'clean' && (
              <>
                <label>
                  Geprüfte Originaldatei lokal abgleichen
                  <input
                    key={id}
                    type="file"
                    accept="image/jpeg,image/png"
                    onChange={(e) => e.target.files?.[0] && compare(e.target.files[0])}
                  />
                </label>
                {hash && (
                  <p>{hash === row.sha256 ? 'Datei stimmt überein.' : 'Datei stimmt nicht mit dem Beleg überein.'}</p>
                )}
                <label>
                  Interne Referenz zum Rechtenachweis
                  <input maxLength={80} value={ref} onChange={(e) => R(e.target.value)} />
                </label>
                <label>
                  <input type="checkbox" checked={checked} onChange={(e) => C(e.target.checked)} /> Inhalt und
                  dokumentierte Nutzungsrechte für die öffentliche Website geprüft.
                </label>
                <button
                  disabled={!checked || hash !== row.sha256 || !ref.trim()}
                  onClick={() =>
                    run(
                      () =>
                        api(path + '/' + id + '/approve', 'POST', {
                          sha256: hash,
                          rights_ref: ref,
                          public_use_confirmed: checked,
                        }),
                      'Freigabe protokolliert.',
                    )
                  }
                >
                  Öffentliche Nutzung freigeben
                </button>
              </>
            )}
            {row.approved_at && !row.rights_withdrawn_at && (
              <button
                onClick={() => run(() => api(path + '/' + id + '/withdraw', 'POST', {}), 'Freigabe zurückgenommen.')}
              >
                Öffentliche Bildfreigabe zurücknehmen
              </button>
            )}
          </>
        )}
      </fieldset>
      <section className="dashboard-card">
        <h2>Identität bestätigen</h2>
        <Reauth mfa />
      </section>
    </div>
  );
}
