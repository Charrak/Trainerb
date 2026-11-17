'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage } from '../lib/api';
import { textValue, type CourseMutate, type Page } from '../lib/courses';
import { Arrow, Field, Notice } from './site';

type Mutate = CourseMutate;
type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'link'; text: string; href: string };
type Content = { id: string; kind: string; title: string | null; body: unknown; position: number; revision: number; editable: boolean };
const labels: Record<Block['kind'], string> = { paragraph: 'Textabsatz', heading: 'Überschrift', list: 'Aufzählung', link: 'Link' };

// Never render or overwrite an unknown document. Stored values are rendered as
// React text, not HTML; URLs in this draft-only preview are not clickable.
function readBlock(content: Content): Block | null {
  if (!content.editable || content.kind !== 'text' || !content.body || typeof content.body !== 'object' ||
      !('schema_version' in content.body) || content.body.schema_version !== 1 || !('blocks' in content.body) ||
      !Array.isArray(content.body.blocks) || content.body.blocks.length !== 1) return null;
  const block: unknown = content.body.blocks[0];
  if (!block || typeof block !== 'object' || !('id' in block) || block.id !== content.id || !('kind' in block)) return null;
  if (block.kind === 'paragraph' && 'text' in block && typeof block.text === 'string') return { kind: 'paragraph', text: block.text };
  if (block.kind === 'heading' && 'text' in block && typeof block.text === 'string' && 'level' in block &&
      typeof block.level === 'number' && [2, 3, 4].includes(block.level)) return { kind: 'heading', text: block.text, level: block.level };
  if (block.kind === 'list' && 'items' in block && Array.isArray(block.items) && block.items.every((item: unknown) => typeof item === 'string')) {
    return { kind: 'list', items: block.items };
  }
  if (block.kind === 'link' && 'text' in block && typeof block.text === 'string' && 'href' in block && typeof block.href === 'string') {
    return { kind: 'link', text: block.text, href: block.href };
  }
  return null;
}

function savedContent(value: unknown, original?: Content): Content | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<Content>;
  if (typeof candidate.id !== 'string' || (original && candidate.id !== original.id) || candidate.kind !== 'text' ||
      !(candidate.title === null || typeof candidate.title === 'string') ||
      !Number.isSafeInteger(candidate.position) || !Number.isSafeInteger(candidate.revision)) return null;
  const item = { ...candidate, editable: true } as Content;
  return readBlock(item) ? item : null;
}
const byPosition = (left: Content, right: Content) => left.position - right.position || left.id.localeCompare(right.id);

export function ChapterContents({ chapterId, count, disabled, canEdit, mutate, onAccessLost, onRefreshed, onCount }: {
  chapterId: string; count: number; disabled: boolean; canEdit: boolean; mutate: Mutate; onAccessLost: (error: unknown) => void; onRefreshed: () => void; onCount: (count: number) => void;
}) {
  const [contents, setContents] = useState<Content[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false), [loading, setLoading] = useState(false);
  const [error, setError] = useState(''), [note, setNote] = useState(''), [needsRefresh, setNeedsRefresh] = useState(false);
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  async function load(next?: string, userRefresh = false) {
    const currentRequest = ++request.current;
    setLoading(true); setError('');
    try {
      const page = await api<Page<Content> & { total: number }>(`/admin/course-chapters/${encodeURIComponent(chapterId)}/contents?limit=20${next ? `&cursor=${encodeURIComponent(next)}` : ''}`);
      if (currentRequest !== request.current) return;
      setContents(current => {
        if (!next) return page.data;
        const existing = new Set(current.map(item => item.id));
        return [...current, ...page.data.filter(item => !existing.has(item.id))];
      });
      setCursor(page.next_cursor); setLoaded(true); onCount(page.total);
      if (!next) { setNeedsRefresh(false); setNote(''); }
      if (userRefresh) onRefreshed();
    } catch (e) {
      if (currentRequest !== request.current) return;
      if (e instanceof ApiError && e.code === 'STALE_CURSOR') {
        setCursor(null); setNeedsRefresh(true);
      } else if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 404)) {
        setContents([]); setCursor(null); setLoaded(false); onAccessLost(e);
      }
      setError(errorMessage(e));
    } finally { if (currentRequest === request.current) setLoading(false); }
  }
  // Apply only the saved row. Automatically reloading the whole list here could
  // discard another open editor, including unsaved work on subsequent pages.
  function onSaved(value: unknown, original?: Content) {
    const saved = savedContent(value, original);
    if (!saved) {
      setCursor(null); setNeedsRefresh(true);
      setError('Der Baustein wurde gespeichert, konnte aber nicht angezeigt werden. Bitte lade die Inhalte neu.');
      return;
    }
    if (!original && (cursor || needsRefresh)) {
      setNote('Der neue Baustein steht am Ende. Lade weitere Inhalte oder aktualisiere die Liste, um ihn zu sehen.');
      return;
    }
    setContents(current => [...current.filter(item => item.id !== saved.id), saved].sort(byPosition));
    setNote('');
    if (original && cursor && original.position !== saved.position) {
      setCursor(null); setNeedsRefresh(true);
      setError('Die Reihenfolge wurde geändert. Lade die Inhalte neu, bevor du weiterblätterst.');
    }
  }
  function onRemoved(item: Content) {
    setContents(current => current.filter(candidate => candidate.id !== item.id));
    setNote('');
    if (cursor === item.id) {
      setCursor(null); setNeedsRefresh(true);
      setError('Die Inhaltsliste hat sich geändert. Bitte lade sie neu.');
    }
  }
  return <details className="chapter-content-panel" onToggle={event => {
    if (event.currentTarget.open && !loaded && !loading) void load();
  }}>
    <summary>Lehrinhalte <span>{count} {count === 1 ? 'Baustein' : 'Bausteine'}</span></summary>
    <div className="content-panel-body">
      <p className="muted">Nur im Entwurf sichtbar. Texte, Überschriften, Aufzählungen und Links werden als sichere Textbausteine gespeichert; Medien folgen später.</p>
      <Notice message={error}/><Notice kind="info" message={note}/>
      {loading && !loaded && <p className="muted">Inhalte werden geladen …</p>}
      {loaded && !contents.length && <p className="muted">Noch keine Inhaltsbausteine angelegt.</p>}
      <div className="content-block-list">{contents.map(item => <ContentItem key={`${item.id}:${item.revision}`} item={item} chapterId={chapterId}
        disabled={disabled || loading} canEdit={canEdit} mutate={mutate} onSaved={onSaved} onRemoved={onRemoved}/>)}</div>
      {cursor && <button type="button" className="button button-secondary content-more" disabled={disabled || loading} onClick={() => void load(cursor)}>Weitere Inhalte laden</button>}
      {loaded && <button type="button" className="inline-button content-refresh" disabled={disabled || loading} onClick={() => {
        if (window.confirm('Inhalte neu laden? Nicht gespeicherte Änderungen können dabei verloren gehen.')) void load(undefined, true);
      }}>Inhalte neu laden</button>}
      {!loaded && error && <button type="button" className="button button-secondary" disabled={disabled || loading} onClick={() => void load()}>Erneut laden</button>}
      {canEdit && loaded && <details className="editor-details add-content"><summary>+ Inhaltsbaustein hinzufügen</summary>
        {count >= 200 ? <p className="muted editor-hint">Pro Kapitel sind höchstens 200 Inhaltsbausteine möglich.</p> :
          <ContentForm chapterId={chapterId} disabled={disabled || loading} mutate={mutate} onSaved={onSaved}/>}</details>}
    </div>
  </details>;
}

function ContentItem({ item, chapterId, disabled, canEdit, mutate, onSaved, onRemoved }: {
  item: Content; chapterId: string; disabled: boolean; canEdit: boolean; mutate: Mutate; onSaved: (value: unknown, original?: Content) => void; onRemoved: (item: Content) => void;
}) {
  const block = readBlock(item);
  async function remove() {
    if (!window.confirm('Diesen Inhaltsbaustein wirklich löschen?')) return;
    if ((await mutate(`/admin/chapter-contents/${item.id}`, 'DELETE', { revision: item.revision }, 'Inhaltsbaustein gelöscht.', chapterId)).ok) onRemoved(item);
  }
  return <article className="content-block">
    <div className="content-block-heading"><span>{String(item.position).padStart(2, '0')}</span>
      <strong>{item.title || (block ? labels[block.kind] : 'Unbekannter Baustein')}</strong>
      {item.title && block && <small>{labels[block.kind]}</small>}</div>
    {!block ? <p className="muted">Dieses Format wird hier nicht unterstützt und kann nicht verändert oder gelöscht werden.</p> : <>
      {block.kind === 'paragraph' && <p className="content-preview-text">{block.text}</p>}
      {block.kind === 'heading' && <p className="content-preview-heading">{block.text}</p>}
      {block.kind === 'list' && <ul className="content-preview-list">{block.items.map((text, index) => <li key={index}>{text}</li>)}</ul>}
      {block.kind === 'link' && <p className="content-preview-link">{block.text}<span>{block.href}</span></p>}
      {canEdit && <details className="editor-details"><summary>Baustein bearbeiten</summary>
        <ContentForm chapterId={chapterId} item={item} initial={block} disabled={disabled} mutate={mutate} onSaved={onSaved}/>
        <button type="button" className="danger-link" disabled={disabled} onClick={() => void remove()}>Baustein löschen</button></details>}
    </>}
  </article>;
}

function ContentForm({ chapterId, item, initial, disabled, mutate, onSaved }: {
  chapterId: string; item?: Content; initial?: Block; disabled: boolean; mutate: Mutate; onSaved: (value: unknown, original?: Content) => void;
}) {
  const prefix = item ? `content-${item.id}` : `new-content-${chapterId}`;
  const [kind, setKind] = useState<Block['kind']>(initial?.kind || 'paragraph');
  const [text, setText] = useState(initial && 'text' in initial ? initial.text : '');
  const [items, setItems] = useState(initial?.kind === 'list' ? initial.items.join('\n') : '');
  const [href, setHref] = useState(initial?.kind === 'link' ? initial.href : '');
  const [level, setLevel] = useState(initial?.kind === 'heading' ? String(initial.level) : '2');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const element = event.currentTarget, form = new FormData(element);
    const block: Block = kind === 'paragraph' ? { kind, text } : kind === 'heading' ? { kind, text, level: Number(level) } :
      kind === 'link' ? { kind, text, href } : { kind, items: items.split(/\r?\n/).map(line => line.trim()).filter(Boolean) };
    const body = { title: textValue(form, 'title'), block,
      ...(item ? { revision: item.revision, position: Number(form.get('position')) } : {}) };
    const path = item ? `/admin/chapter-contents/${item.id}` : `/admin/course-chapters/${chapterId}/contents`;
    const result = await mutate(path, item ? 'PATCH' : 'POST', body, item ? 'Inhaltsbaustein gespeichert.' : 'Inhaltsbaustein angelegt.', chapterId);
    if (result.ok) {
      onSaved(result.value, item);
      if (!item) { element.reset(); setKind('paragraph'); setText(''); setItems(''); setHref(''); setLevel('2'); }
    }
  }
  return <form className="stack-form editor-form content-form" onSubmit={submit}>
    <fieldset className="content-fields" disabled={disabled}>
    {!item && <Field label="Art des Bausteins" id={`${prefix}-kind`}><select id={`${prefix}-kind`} value={kind} onChange={event => setKind(event.target.value as Block['kind'])}>
      <option value="paragraph">Textabsatz</option><option value="heading">Überschrift</option><option value="list">Aufzählung</option><option value="link">Link</option></select></Field>}
    <Field label="Interner Titel (optional)" id={`${prefix}-title`}><input id={`${prefix}-title`} name="title" defaultValue={item?.title || ''} maxLength={160}/></Field>
    {kind === 'paragraph' && <Field label="Text" id={`${prefix}-text`} hint="Einfacher Text; HTML wird nicht ausgeführt."><textarea id={`${prefix}-text`} value={text} onChange={event => setText(event.target.value)} rows={6} maxLength={7000} aria-describedby={`${prefix}-text-hint`} required/></Field>}
    {kind === 'heading' && <><Field label="Überschrift" id={`${prefix}-text`}><input id={`${prefix}-text`} value={text} onChange={event => setText(event.target.value)} maxLength={240} required/></Field>
      <Field label="Gliederungsebene" id={`${prefix}-level`}><select id={`${prefix}-level`} value={level} onChange={event => setLevel(event.target.value)}><option value="2">Ebene 2</option><option value="3">Ebene 3</option><option value="4">Ebene 4</option></select></Field></>}
    {kind === 'list' && <Field label="Einträge" id={`${prefix}-items`} hint="Ein Eintrag pro Zeile, höchstens 30 Einträge mit je 200 Zeichen. Leere Zeilen werden ignoriert."><textarea id={`${prefix}-items`} value={items} onChange={event => setItems(event.target.value)} rows={5} maxLength={6030} aria-describedby={`${prefix}-items-hint`} required/></Field>}
    {kind === 'link' && <><Field label="Linktext" id={`${prefix}-text`}><input id={`${prefix}-text`} value={text} onChange={event => setText(event.target.value)} maxLength={240} required/></Field>
      <Field label="Linkziel" id={`${prefix}-href`} hint="Nur HTTPS-Adressen oder interne Pfade wie /kurse."><input id={`${prefix}-href`} value={href} onChange={event => setHref(event.target.value)} maxLength={2048} aria-describedby={`${prefix}-href-hint`} required/></Field></>}
    {item && <Field label="Position" id={`${prefix}-position`} hint="Zum Verschieben eine freie Position verwenden."><input id={`${prefix}-position`} name="position" type="number" min="0" max="100000" defaultValue={item.position} aria-describedby={`${prefix}-position-hint`} required/></Field>}
    <button className="button button-secondary" disabled={disabled}>{item ? 'Baustein speichern' : 'Baustein anlegen'} <Arrow/></button>
    </fieldset>
  </form>;
}
