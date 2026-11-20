'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { Notice } from './site';
import { Reauth } from './reauth';

type Area = 'header' | 'footer';
type Row = { page_id: string; label: string; visible: boolean; slug: string; published?: boolean };
type Menu = { revision: number; items: Row[] };
type Pages = { data: { id: string; slug: string }[]; next_cursor: string | null };
const writable = ({ page_id, label, visible }: Row) => ({ page_id, label, visible });
export function NavigationEditor() {
  const [area, setArea] = useState<Area>('header'),
    [generation, reload] = useState(0);
  const [menu, setMenu] = useState<Menu>(),
    [rows, setRows] = useState<Row[]>([]),
    [pages, setPages] = useState<Pages>(),
    [choice, choose] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    setMenu(undefined);
    setPages(undefined);
    setRows([]);
    choose('');
    setError('');
    Promise.all([api<Menu>(`/admin/navigation/${area}`), api<Pages>('/admin/pages')])
      .then(([m, p]) => {
        if (active) {
          setMenu(m);
          setRows(m.items);
          setPages(p);
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [area, generation]);
  const dirty = !!menu && JSON.stringify(rows.map(writable)) !== JSON.stringify(menu.items.map(writable));
  function discard() {
    return !dirty || window.confirm('Nicht gespeicherte Menüänderungen verwerfen?');
  }
  async function more() {
    if (!pages?.next_cursor) return;
    setBusy(true);
    setError('');
    try {
      const p = await api<Pages>('/admin/pages?after=' + encodeURIComponent(pages.next_cursor));
      setPages({ data: [...pages.data, ...p.data], next_cursor: p.next_cursor });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function move(index: number, offset: number) {
    const next = [...rows];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    setRows(next);
  }
  async function save() {
    if (!menu) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ revision: number }>(`/admin/navigation/${area}`, 'PUT', {
        revision: menu.revision,
        items: rows.map(writable),
      });
      setMenu({ revision: result.revision, items: rows });
      setNotice('Menü gespeichert. Sichtbare Links zu veröffentlichten Seiten erscheinen beim nächsten Seitenaufruf.');
      reload((n) => n + 1);
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
          <h1>Menüverwaltung</h1>
          <p>
            Ergänze Kopf- und Fußzeile um Links zu Website-Seiten. Die festen Konto- und Rechtslinks bleiben erhalten.
          </p>
        </div>
        <Link href="/admin/website">Website-Seiten bearbeiten</Link>
      </header>
      <section className="dashboard-card">
        <label>
          Menübereich{' '}
          <select
            disabled={busy}
            value={area}
            onChange={(e) => {
              if (discard()) {
                setArea(e.target.value as Area);
                setNotice('');
              }
            }}
          >
            <option value="header">Kopfzeile</option>
            <option value="footer">Fußzeile</option>
          </select>
        </label>{' '}
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (discard()) {
              reload((n) => n + 1);
              setNotice('');
            }
          }}
        >
          Gespeicherten Stand laden
        </button>
      </section>
      <Notice message={error} />
      <Notice kind="success" message={notice} />
      {!menu && !error && <p role="status">Menü wird geladen …</p>}
      {menu && pages && (
        <>
          <section className="dashboard-card">
            <h2>Menüeinträge</h2>
            <p>
              Maximal zwölf Links pro Bereich. Auch als sichtbar markierte Entwürfe erscheinen erst mit ihrer
              Veröffentlichung.
            </p>
            {!rows.length && <p>Keine zusätzlichen Links.</p>}
            <fieldset disabled={busy} className="stack-form">
              <legend>Reihenfolge und Sichtbarkeit</legend>
              {rows.map((row, i) => (
                <fieldset key={row.page_id}>
                  <legend>
                    {i + 1}. /seiten/{row.slug}
                  </legend>
                  <label>
                    Linktext
                    <input
                      maxLength={60}
                      value={row.label}
                      onChange={(e) => setRows(rows.map((r, n) => (n === i ? { ...r, label: e.target.value } : r)))}
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={row.visible}
                      onChange={(e) => setRows(rows.map((r, n) => (n === i ? { ...r, visible: e.target.checked } : r)))}
                    />{' '}
                    Sichtbar
                  </label>
                  {row.published === false && <p>Seite derzeit nicht veröffentlicht.</p>}
                  <button type="button" disabled={i === 0} onClick={() => move(i, -1)}>
                    Nach oben
                  </button>{' '}
                  <button type="button" disabled={i + 1 === rows.length} onClick={() => move(i, 1)}>
                    Nach unten
                  </button>{' '}
                  <button type="button" onClick={() => setRows(rows.filter((_, n) => n !== i))}>
                    Entfernen
                  </button>
                </fieldset>
              ))}
              <label>
                Website-Seite hinzufügen{' '}
                <select value={choice} onChange={(e) => choose(e.target.value)}>
                  <option value="">Seite auswählen</option>
                  {pages.data
                    .filter((p) => !rows.some((r) => r.page_id === p.id))
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.slug}
                      </option>
                    ))}
                </select>
              </label>
              {pages.next_cursor && (
                <button type="button" onClick={more}>
                  Weitere Seiten laden
                </button>
              )}
              <button
                type="button"
                disabled={!choice || rows.length >= 12}
                onClick={() => {
                  const page = pages.data.find((p) => p.id === choice);
                  if (page) {
                    setRows([
                      ...rows,
                      { page_id: page.id, slug: page.slug, label: page.slug.slice(0, 60), visible: true },
                    ]);
                    choose('');
                  }
                }}
              >
                Link hinzufügen
              </button>
            </fieldset>
            <button type="button" disabled={busy || !dirty || rows.some((r) => !r.label.trim())} onClick={save}>
              Menü speichern
            </button>
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
