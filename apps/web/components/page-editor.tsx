'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Notice } from './site';
import { Reauth } from './reauth';
import { EditorialText } from './editorial-text';

type Row = { id: string; slug: string };
type Fields = { title: string; description: string; body: string };
type Detail = Row & {
  revision: number;
  latest: Fields & { id: string; version: number; state: string };
  published: null | { id: string; version: number };
};
const blank: Fields = { title: '', description: '', body: '' };
export function PageEditor() {
  const [rows, setRows] = useState<Row[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [ready, setReady] = useState(false);
  const [selected, select] = useState(''),
    [revision, refresh] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [detail, setDetail] = useState<Detail>(),
    [fields, setFields] = useState<Fields>(blank),
    [slug, setSlug] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    api<{ data: Row[]; next_cursor: string | null }>('/admin/pages')
      .then((r) => {
        if (active) {
          setRows(r.data);
          setCursor(r.next_cursor);
          setReady(true);
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setDetail(undefined);
    setFields(blank);
    setSlug('');
    if (selected)
      api<Detail>('/admin/pages/' + selected)
        .then((r) => {
          if (active) {
            setDetail(r);
            setFields(r.latest);
            setSlug(r.slug);
          }
        })
        .catch((e) => {
          if (active) setError(errorMessage(e));
        });
    return () => {
      active = false;
    };
  }, [selected, revision]);
  async function more() {
    setBusy(true);
    try {
      const r = await api<{ data: Row[]; next_cursor: string | null }>('/admin/pages?after=' + cursor);
      setRows((prev) => [...new Map([...prev, ...r.data].map((row) => [row.id, row])).values()]);
      setCursor(r.next_cursor);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const changed = !detail || (Object.keys(blank) as (keyof Fields)[]).some((k) => fields[k] !== detail.latest[k]);
  async function act(action: 'save' | 'publish' | 'withdraw') {
    setError('');
    setNotice('');
    setBusy(true);
    const content = { title: fields.title, body: fields.body, description: fields.description };
    try {
      if (!selected) {
        const r = await api<Row>('/admin/pages', 'POST', { slug, ...content });
        setRows((prev) => [...prev, { id: r.id, slug }]);
        select(r.id);
      } else if (detail) {
        await api(
          `/admin/pages/${detail.id}/${action === 'save' ? 'drafts' : action}`,
          'POST',
          action === 'save'
            ? { revision: detail.revision, ...content }
            : { revision: detail.revision, version_id: action === 'publish' ? detail.latest.id : detail.published?.id },
        );
        refresh((n) => n + 1);
      }
      setNotice(
        action === 'save'
          ? 'Entwurf gespeichert.'
          : action === 'publish'
            ? 'Gespeicherte Fassung veröffentlicht.'
            : 'Seite zurückgenommen.',
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="account-page content-width">
      <header className="dashboard-title">
        <div>
          <span className="eyebrow">REDAKTION</span>
          <h1>Website-Seiten</h1>
          <p>Entwürfe sind nur im Backoffice sichtbar. Der öffentliche Pfad einer Seite bleibt bestehen.</p>
        </div>
        <Link href="/konto">Zum Konto</Link>
      </header>
      <Notice message={error} />
      <Notice message={notice} kind="success" />
      {ready && (
        <>
          <section className="dashboard-card">
            <label>
              Seite auswählen{' '}
              <select
                disabled={busy}
                value={selected}
                onChange={(e) => {
                  setError('');
                  setNotice('');
                  select(e.target.value);
                }}
              >
                <option value="">Neue Seite anlegen</option>
                {rows.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.slug}
                  </option>
                ))}
              </select>
            </label>
            {cursor && (
              <button disabled={busy} onClick={more}>
                Weitere Seiten laden
              </button>
            )}
          </section>
          {selected && !detail && <p role="status">{error ? 'Seite nicht geladen.' : 'Seite wird geladen …'}</p>}
          {selected && (
            <button
              disabled={busy}
              onClick={() => {
                setError('');
                setNotice('');
                refresh((n) => n + 1);
              }}
            >
              Stand neu laden (Eingaben verwerfen)
            </button>
          )}
          {(!selected || detail?.id === selected) && (
            <>
              <section className="dashboard-card">
                <h2>Seiteninhalt</h2>
                <p>
                  {detail?.published ? (
                    <>
                      Öffentlich: Fassung {detail.published.version} ·{' '}
                      <Link href={'/seiten/' + detail.slug}>Öffentliche Seite ansehen</Link>
                    </>
                  ) : (
                    'Nicht veröffentlicht.'
                  )}{' '}
                  {detail && <>Bearbeitungsstand: Fassung {detail.latest.version}.</>}
                </p>
                <fieldset className="stack-form" disabled={busy}>
                  <legend>Redaktionstext</legend>
                  <label>
                    Seitenpfad unter /seiten/
                    <input
                      disabled={!!selected}
                      value={slug}
                      maxLength={80}
                      onChange={(e) => setSlug(e.target.value)}
                      placeholder="zum-beispiel"
                    />
                  </label>
                  <label>
                    Seitentitel
                    <input
                      value={fields.title}
                      maxLength={160}
                      onChange={(e) => setFields({ ...fields, title: e.target.value })}
                    />
                  </label>
                  <label>
                    Kurzbeschreibung für Suchmaschinen (optional)
                    <input
                      value={fields.description}
                      maxLength={300}
                      onChange={(e) => setFields({ ...fields, description: e.target.value })}
                    />
                  </label>
                  <label>
                    Seiteninhalt
                    <textarea
                      rows={10}
                      value={fields.body}
                      maxLength={20000}
                      onChange={(e) => setFields({ ...fields, body: e.target.value })}
                    />
                  </label>
                  <small>
                    Absätze mit Leerzeilen trennen. Für eine Zwischenüberschrift den Absatz mit „## “ beginnen. HTML
                    wird nicht ausgeführt.
                  </small>
                  <button
                    disabled={
                      !slug ||
                      !fields.title.trim() ||
                      !fields.body.trim() ||
                      (!changed && detail?.latest.state !== 'retired')
                    }
                    onClick={() => act('save')}
                  >
                    Entwurf speichern
                  </button>
                </fieldset>
              </section>
              <section className="dashboard-card">
                <h2>Vorschau (nicht öffentlich)</h2>
                <EditorialText title={fields.title} body={fields.body} />
              </section>
              {detail && (
                <section className="dashboard-card">
                  <h2>Veröffentlichung</h2>
                  <button disabled={busy || changed || detail.latest.state !== 'draft'} onClick={() => act('publish')}>
                    Gespeicherten Entwurf veröffentlichen
                  </button>{' '}
                  {detail.published && (
                    <button disabled={busy || changed} onClick={() => act('withdraw')}>
                      Veröffentlichte Seite zurücknehmen
                    </button>
                  )}
                </section>
              )}
            </>
          )}
          <section className="dashboard-card">
            <h2>Identität für Änderungen bestätigen</h2>
            <Reauth mfa />
          </section>
        </>
      )}
    </div>
  );
}
