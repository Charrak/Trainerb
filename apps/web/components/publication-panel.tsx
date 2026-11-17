'use client';
import { useEffect, useState } from 'react';
import { api, ApiError, errorMessage } from '../lib/api';
import { Arrow, Notice } from './site';
import { Reauth } from './reauth';

export type Blocker = { code: string; message: string };
type VersionRow = { id: string; version: number; state: string; title: string; revision: number; published_at: string | null };
export type CoursePublicationState = { course_id: string; status: string; visibility: string; versions: VersionRow[];
  publications: { id: string; version: number; action: string; created_at: string }[]; readiness: Blocker[] };
export type ProductPublicationState = { product_id: string; status: string; activated_at: string | null; blockers: Blocker[];
  prices: { id: string; status: string; gross_cents: string; currency: string; valid_from: string; valid_until: string | null }[] };

const stateLabels: Record<string, string> = { draft: 'Entwurf', published: 'Veröffentlicht', retired: 'Zurückgezogen',
  active: 'Aktiv', inactive: 'Inaktiv', archived: 'Archiviert' };
// A missing confirmation (403 REAUTH_REQUIRED) is not lost access: the panel
// must stay open so the reason and the confirmation form stay visible.
const lostAccess = (error: unknown) => error instanceof ApiError &&
  (error.status === 401 || (error.status === 403 && ['FORBIDDEN', 'MFA_REQUIRED'].includes(error.code)));
export function BlockerList({ blockers, empty }: { blockers: Blocker[]; empty: string }) {
  if (!blockers.length) return <p className="publication-ok">✓ {empty}</p>;
  return <ul className="blocker-list">{blockers.map(blocker => <li key={blocker.code}><strong>{blocker.code}</strong> {blocker.message}</li>)}</ul>;
}

/**
 * Release actions live next to the draft editor but stay separate from it:
 * they need their own permission and a confirmation younger than five minutes.
 * Nothing here sells anything; publishing only exposes the course text.
 */
export function CoursePublication({ courseId, version, canPublish, onChanged }: {
  courseId: string; version: { id: string; revision: number; version: number } | undefined;
  canPublish: boolean; onChanged: () => void;
}) {
  const [state, setState] = useState<CoursePublicationState>();
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [visibility, setVisibility] = useState<'public' | 'unlisted'>('public');
  async function load() {
    if (!canPublish) return;
    try { const value = await api<CoursePublicationState>(`/admin/courses/${encodeURIComponent(courseId)}/publication`);
      setState(value); setError(''); }
    catch (e) { if (lostAccess(e)) setState(undefined); setError(errorMessage(e)); }
  }
  useEffect(() => { void load(); }, [courseId, canPublish, version?.id, version?.revision]);
  if (!canPublish) return null;
  async function act(action: 'publish' | 'unpublish' | 'versions') {
    if (action === 'unpublish' && !window.confirm('Diesen Kurs wirklich aus der Veröffentlichung nehmen? Er ist danach nicht mehr im öffentlichen Katalog sichtbar.')) return;
    if (action === 'publish' && !window.confirm('Diese Version jetzt veröffentlichen? Der veröffentlichte Inhalt ist danach unveränderlich; weitere Änderungen brauchen eine neue Entwurfsversion.')) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const path = `/admin/courses/${encodeURIComponent(courseId)}/${action === 'versions' ? 'versions' : action}`;
      const body = action === 'publish' && version ? { version_id: version.id, revision: version.revision, visibility }
        : action === 'unpublish' ? { revision: 1 } : {};
      const result = await api<{ status?: string; version?: number }>(path, 'POST', body);
      setMessage(action === 'publish' ? `Version ${result.version ?? ''} veröffentlicht.` :
        action === 'unpublish' ? 'Der Kurs ist nicht mehr veröffentlicht.' : `Entwurfsversion ${result.version ?? ''} angelegt.`);
      await load(); onChanged();
    } catch (e) {
      if (lostAccess(e)) setState(undefined);
      // Blockers come as details; the message alone would hide what to fix.
      const details = e instanceof ApiError && e.details ? Object.entries(e.details).map(([code, text]) => `${code}: ${text}`) : [];
      setError(details.length ? `${errorMessage(e)} ${details.join(' · ')}` : errorMessage(e));
    } finally { setBusy(false); }
  }
  const published = state?.versions.find(item => item.state === 'published');
  return <section className="dashboard-card" id="freigabe"><div className="section-heading"><div><span className="section-kicker">FREIGABE</span>
    <h2>Veröffentlichung</h2><p>Veröffentlichen stellt nur den Kurstext in den Katalog. Es gibt weiterhin keinen Verkauf, keinen Lernzugang und keine Prüfungen.</p></div>
    {state && <span className="draft-badge">{stateLabels[state.status] || state.status}</span>}</div>
    <Notice message={error}/><Notice kind="success" message={message}/>
    {!state ? <p className="muted">Freigabestatus wird geladen …</p> : <>
      <h3>Voraussetzungen für den Entwurf</h3>
      <BlockerList blockers={state.readiness} empty="Der Entwurf erfüllt die technischen Voraussetzungen."/>
      <p className="muted editor-hint">Fachliche Freigabe, Rechte an Inhalten und Medien sowie rechtliche Prüfung sind damit nicht bestätigt.</p>
      <div className="inner-divider"/>
      {state.status === 'published' ? <>
        <h3>Veröffentlicht</h3>
        <p className="muted">Version {published?.version ?? '–'} ist öffentlich unveränderlich. Für Änderungen eine neue Entwurfsversion anlegen, bearbeiten und erneut veröffentlichen.</p>
        <div className="release-actions">
          <button type="button" className="button button-secondary" disabled={busy} onClick={() => void act('versions')}>Neue Entwurfsversion anlegen <Arrow/></button>
          <button type="button" className="button button-outline" disabled={busy} onClick={() => void act('unpublish')}>Veröffentlichung zurücknehmen</button>
        </div>
      </> : <>
        {!published && <button type="button" className="button button-secondary" disabled={busy || !version} onClick={() => void act('versions')}>Neue Entwurfsversion aus veröffentlichter Fassung <Arrow/></button>}
        <div className="release-actions">
          <label className="inline-label" htmlFor="publish-visibility">Sichtbarkeit</label>
          <select id="publish-visibility" value={visibility} onChange={e => setVisibility(e.target.value === 'unlisted' ? 'unlisted' : 'public')}>
            <option value="public">Öffentlich (im Katalog gelistet)</option>
            <option value="unlisted">Nicht gelistet (nur über direkten Link)</option>
          </select>
          <button type="button" className="button button-primary" disabled={busy || !version || (state.readiness?.length ?? 0) > 0}
            onClick={() => void act('publish')}>Veröffentlichen <Arrow/></button>
        </div>
      </>}
      <details className="editor-details"><summary>Identität für die Freigabe bestätigen</summary>
        <div className="editor-form"><Reauth mfa idPrefix="freigabe-reauth"/><p className="muted">Eine Bestätigung gilt fünf Minuten für alle Freigabeaktionen.</p></div></details>
      <div className="inner-divider"/>
      <h3>Verlauf</h3>
      {state.publications.length ? <div className="table-wrap"><table><thead><tr><th>Zeitpunkt</th><th>Aktion</th><th>Version</th></tr></thead><tbody>
        {state.publications.map(entry => <tr key={entry.id}><td>{new Date(entry.created_at).toLocaleString('de-DE', { timeZone: 'UTC' })} UTC</td>
          <td>{entry.action === 'published' ? 'Veröffentlicht' : 'Zurückgenommen'}</td><td>{entry.version}</td></tr>)}
      </tbody></table></div> : <p className="muted">Noch keine Freigabeaktion.</p>}
    </>}
  </section>;
}

/** Product activation with the same rules: preparation, never a sale. */
export function ProductActivation({ productId, revision, canManage, onChanged }: {
  productId: string; revision: number; canManage: boolean; onChanged: () => void;
}) {
  const [state, setState] = useState<ProductPublicationState>();
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  async function load() {
    if (!canManage) return;
    try { setState(await api<ProductPublicationState>(`/admin/products/${encodeURIComponent(productId)}/activation`)); setError(''); }
    catch (e) { if (lostAccess(e)) setState(undefined); setError(errorMessage(e)); }
  }
  useEffect(() => { void load(); }, [productId, canManage, revision]);
  if (!canManage) return null;
  async function act(action: 'activate' | 'deactivate', priceId?: string, priceRevision?: number) {
    setBusy(true); setError(''); setMessage('');
    try {
      if (priceId !== undefined) {
        await api(`/admin/prices/${encodeURIComponent(priceId)}/${action}`, 'POST', { revision: priceRevision });
      } else {
        if (action === 'deactivate' && !window.confirm('Produkt deaktivieren? Aktive Preiszeiträume werden dabei zurückgezogen.')) { setBusy(false); return; }
        await api(`/admin/products/${encodeURIComponent(productId)}/${action}`, 'POST', { revision });
      }
      setMessage(action === 'activate' ? 'Freigabe gespeichert.' : 'Zurückgezogen.');
      await load(); onChanged();
    } catch (e) {
      if (lostAccess(e)) setState(undefined);
      const details = e instanceof ApiError && e.details ? Object.entries(e.details).map(([code, text]) => `${code}: ${text}`) : [];
      setError(details.length ? `${errorMessage(e)} ${details.join(' · ')}` : errorMessage(e));
    } finally { setBusy(false); }
  }
  return <section className="dashboard-card" id="freigabe"><div className="section-heading"><div><span className="section-kicker">FREIGABE</span>
    <h2>Aktivierung</h2><p>Ein aktives Produkt ist katalogfähig, aber noch nicht kaufbar: Warenkorb, Checkout und Zahlung fehlen.</p></div>
    {state && <span className="draft-badge">{stateLabels[state.status] || state.status}</span>}</div>
    <Notice message={error}/><Notice kind="success" message={message}/>
    {!state ? <p className="muted">Aktivierungsstatus wird geladen …</p> : <>
      <BlockerList blockers={state.blockers} empty="Das Produkt erfüllt die technischen Aktivierungsvoraussetzungen."/>
      <div className="release-actions">
        {state.status === 'active'
          ? <button type="button" className="button button-outline" disabled={busy} onClick={() => void act('deactivate')}>Produkt deaktivieren</button>
          : <button type="button" className="button button-primary" disabled={busy || state.blockers.length > 0} onClick={() => void act('activate')}>Produkt aktivieren <Arrow/></button>}
      </div>
      <div className="inner-divider"/>
      <h3>Preiszeiträume</h3>
      <p className="muted">Aktive Zeiträume desselben Produkts und derselben Währung dürfen sich nicht überschneiden; Entwürfe dürfen es.</p>
      {state.prices.length ? <div className="table-wrap"><table><thead><tr><th>Gültig ab (UTC)</th><th>Gültig bis (UTC)</th><th>Brutto</th><th>Status</th><th/></tr></thead><tbody>
        {state.prices.map(price => <tr key={price.id}><td>{price.valid_from.slice(0, 16).replace('T', ' ')}</td>
          <td>{price.valid_until ? price.valid_until.slice(0, 16).replace('T', ' ') : 'offen'}</td>
          <td>{price.gross_cents} Cent</td><td>{stateLabels[price.status] || price.status}</td>
          <td>{price.status === 'draft' && state.status === 'active' && <span className="muted">Aktivierung erfolgt im Preisbereich</span>}</td></tr>)}
      </tbody></table></div> : <p className="muted">Noch kein Preiszeitraum.</p>}
      <details className="editor-details"><summary>Identität für die Freigabe bestätigen</summary>
        <div className="editor-form"><Reauth mfa idPrefix="freigabe-reauth"/><p className="muted">Eine Bestätigung gilt fünf Minuten für alle Freigabeaktionen.</p></div></details>
    </>}
  </section>;
}
