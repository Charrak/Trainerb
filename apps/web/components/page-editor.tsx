'use client';
import { EDITORIAL_TEXT_LIMIT } from '@trainerb/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Notice } from './site';
import { Reauth } from './reauth';
import { EditorialText } from './editorial-text';

type Row = { id: string; slug: string };
type Fields = {
  title: string;
  description: string;
  body: string;
  banner: string | null;
  button_path: string | null;
  button_label: string | null;
  image_id: string | null;
  image_alt: string | null;
};
type Detail = Row & {
  revision: number;
  latest: Fields & { id: string; version: number; state: string };
  published: null | { id: string; version: number };
};
const blank: Fields = {
  title: '',
  description: '',
  body: '',
  banner: null,
  button_label: null,
  button_path: null,
  image_id: null,
  image_alt: null,
};
export function PageEditor() {
  type Images = { data: { id: string; original_name: string }[]; next_cursor: string | null };
  const [images, setImages] = useState<Images>({ data: [], next_cursor: null });
  async function loadImages(after?: string) {
    setBusy(true);
    try {
      const r = await api<Images>('/admin/page-images' + (after ? '?after=' + encodeURIComponent(after) : ''));
      setImages((prev) => ({ data: after ? [...prev.data, ...r.data] : r.data, next_cursor: r.next_cursor }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
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
    const content = {
      banner: fields.banner,
      button_label: fields.button_label,
      button_path: fields.button_path,
      image_id: fields.image_id,
      image_alt: fields.image_alt,
      title: fields.title,
      body: fields.body,
      description: fields.description,
    };
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
        <Link href="/admin/seitenbilder">Seitenbilder einreichen und freigeben</Link> <Link href="/konto">Zum Konto</Link>
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
                      maxLength={EDITORIAL_TEXT_LIMIT}
                      onChange={(e) => setFields({ ...fields, body: e.target.value })}
                    />
                  </label>
                  <small>
                    Absätze mit Leerzeilen trennen. Für eine Zwischenüberschrift den Absatz mit „## “ beginnen. HTML
                    wird nicht ausgeführt.
                  </small>
                  <label>
                    Bannertext (optional)
                    <textarea
                      maxLength={240}
                      rows={2}
                      value={fields.banner ?? ''}
                      onChange={(e) => setFields({ ...fields, banner: e.target.value || null })}
                    />
                  </label>
                  <label>
                    Buttonziel{' '}
                    <select
                      value={fields.button_path ?? ''}
                      onChange={(e) =>
                        setFields({
                          ...fields,
                          button_path: e.target.value || null,
                          button_label: e.target.value ? fields.button_label : null,
                        })
                      }
                    >
                      <option value="">Kein Button</option>
                      <option value="/kurse">Kurskatalog</option>
                      <option value="/buchen">Buchung</option>
                      <option value="/seiten">Website-Seiten</option>
                      <option value="/registrieren">Registrierung</option>
                    </select>
                  </label>
                  {fields.button_path && (
                    <label>
                      Buttontext
                      <input
                        value={fields.button_label ?? ''}
                        maxLength={80}
                        onChange={(e) => setFields({ ...fields, button_label: e.target.value || null })}
                      />
                    </label>
                  )}
                  <button type="button" onClick={() => loadImages(images.next_cursor ?? undefined)}>
                    {images.next_cursor ? 'Weitere Bilder laden' : 'Öffentlich freigegebene Bilder laden'}
                  </button>
                  <label>
                    Seitenbild{' '}
                    <select
                      value={fields.image_id ?? ''}
                      onChange={(e) =>
                        setFields({
                          ...fields,
                          image_id: e.target.value || null,
                          image_alt: e.target.value ? fields.image_alt : null,
                        })
                      }
                    >
                      <option value="">Kein Bild</option>
                      {fields.image_id && !images.data.some((a) => a.id === fields.image_id) && (
                        <option value={fields.image_id}>Gespeichertes Bild</option>
                      )}
                      {images.data.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.original_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {fields.image_id && (
                    <label>
                      Alternativtext
                      <input
                        value={fields.image_alt ?? ''}
                        maxLength={180}
                        onChange={(e) => setFields({ ...fields, image_alt: e.target.value || null })}
                      />
                    </label>
                  )}
                  <button
                    disabled={
                      (!!fields.button_path && !fields.button_label?.trim()) ||
                      (!!fields.image_id && !fields.image_alt?.trim()) ||
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
                <EditorialText
                  {...fields}
                  preview
                  image_url={fields.image_id ? `/api/v1/admin/page-images/${fields.image_id}` : null}
                />
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
