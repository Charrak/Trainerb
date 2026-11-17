'use client';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage, type Profile } from '../lib/api';
import { centsForInput, centsFromInput, utcMinuteForInput, utcMinuteFromInput, productTypeLabels, priceStatusLabels,
  type CourseOption, type PriceDraft, type ProductDetail, type ProductPage } from '../lib/products';
import { Arrow, Field, Notice } from './site';
import { ProductActivation } from './publication-panel';

const lostAccess = (error: unknown) => error instanceof ApiError && (error.status === 401 || error.status === 403);

export function AdminProductDetail({ id }: { id: string }) {
  const [profile, setProfile] = useState<Profile>();
  const [product, setProduct] = useState<ProductDetail>();
  const [courses, setCourses] = useState<CourseOption[]>([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [title, setTitle] = useState(''), [variant, setVariant] = useState(''), [description, setDescription] = useState('');
  const [links, setLinks] = useState<string[]>([]);
  const [gross, setGross] = useState(''), [validFrom, setValidFrom] = useState(''), [taxCategory, setTaxCategory] = useState('standard');
  const [saleGross, setSaleGross] = useState(''), [saleStart, setSaleStart] = useState(''), [saleEnd, setSaleEnd] = useState('');
  const canEditProducts = !!profile?.permissions.includes('products.manage') &&
    profile.roles.some(role => role === 'admin' || role === 'superadmin');
  const canEditPrices = !!profile?.permissions.includes('prices.manage') &&
    profile.roles.some(role => role === 'admin' || role === 'superadmin');
  function apply(value: ProductDetail) {
    setProduct(value); setTitle(value.title); setVariant(value.variant_name ?? ''); setDescription(value.description ?? '');
    setLinks(value.courses.map(link => link.course_id));
  }
  async function reload() {
    setError(''); setMessage('');
    try { apply(await api<ProductDetail>(`/admin/products/${encodeURIComponent(id)}`)); }
    catch (e) { if (lostAccess(e)) setProduct(undefined); setError(errorMessage(e)); }
  }
  useEffect(() => {
    let active = true;
    api<Profile>('/me').then(async user => {
      if (!active) return;
      setProfile(user);
      try {
        const value = await api<ProductDetail>(`/admin/products/${encodeURIComponent(id)}`);
        if (!active) return;
        apply(value);
        const list = await api<ProductPage<CourseOption>>('/admin/courses?limit=100');
        if (active) setCourses(list.data);
      } catch (e) { if (active) setError(errorMessage(e)); }
      finally { if (active) setLoading(false); }
    }).catch(e => { if (active) { setError(errorMessage(e)); setLoading(false); } });
    return () => { active = false; };
  }, [id]);
  async function mutate<T>(work: () => Promise<T>, success: string): Promise<T | undefined> {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await work(); setMessage(success);
      try { apply(await api<ProductDetail>(`/admin/products/${encodeURIComponent(id)}`)); }
      catch (e) { if (lostAccess(e)) setProduct(undefined); setError('Die Änderung wurde gespeichert, aber der aktuelle Stand konnte nicht geladen werden. Bitte lade die Seite neu.'); }
      return result;
    } catch (e) { if (lostAccess(e)) setProduct(undefined); setError(errorMessage(e)); return undefined; }
    finally { setBusy(false); }
  }
  async function saveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!product) return;
    const chosen = links.filter(Boolean);
    if (product.type === 'single' && chosen.length > 1) { setError('Ein Einzelprodukt darf höchstens einen Kurs enthalten.'); return; }
    await mutate(() => api(`/admin/products/${product.id}`, 'PATCH', { revision: product.revision, title, variant_name: variant,
      description, courses: chosen.map(courseId => ({ course_id: courseId, access_days_override: null })) }), 'Produktangaben gespeichert.');
  }
  async function addPrice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!product) return;
    const grossCents = centsFromInput(gross), from = utcMinuteFromInput(validFrom);
    if (!grossCents) { setError('Bitte gib einen Bruttobetrag mit höchstens zwei Nachkommastellen an.'); return; }
    if (!from) { setError('Bitte gib Beginn und Ende als UTC-Zeit im Format JJJJ-MM-TTTHH:MM an.'); return; }
    const hasSale = !!saleGross.trim() || !!saleStart.trim() || !!saleEnd.trim();
    const saleCents = saleGross.trim() ? centsFromInput(saleGross) : null, saleFrom = utcMinuteFromInput(saleStart), saleTo = utcMinuteFromInput(saleEnd);
    if (hasSale && (!saleCents || !saleFrom || !saleTo)) { setError('Für einen Aktionspreis werden Betrag, Beginn und Ende benötigt.'); return; }
    const body = { currency: 'EUR', gross_cents: grossCents, tax_category: taxCategory, valid_from: from,
      sale_gross_cents: hasSale ? saleCents : null, sale_starts_at: hasSale ? saleFrom : null, sale_ends_at: hasSale ? saleTo : null };
    if (await mutate(() => api(`/admin/products/${product.id}/prices`, 'POST', body), 'Preiszeitraum als Entwurf gespeichert.')) {
      setGross(''); setValidFrom(''); setSaleGross(''); setSaleStart(''); setSaleEnd('');
    }
  }
  async function removePrice(price: PriceDraft) {
    if (!window.confirm(`Preiszeitraum ab ${utcMinuteForInput(price.valid_from)} UTC löschen?`)) return;
    await mutate(() => api(`/admin/prices/${price.id}`, 'DELETE', { revision: price.revision }), 'Preiszeitraum gelöscht.');
  }
  async function removeProduct() {
    if (!product || !window.confirm(`Produktentwurf ${product.sku} endgültig löschen?`)) return;
    setBusy(true); setError('');
    try { await api(`/admin/products/${product.id}`, 'DELETE', { revision: product.revision }); window.location.assign('/admin/produkte'); }
    catch (e) { setError(errorMessage(e)); setBusy(false); }
  }
  const canRelease = !!profile && profile.permissions.includes('products.manage') &&
    profile.roles.some(role => role === 'admin' || role === 'superadmin');
  async function togglePrice(price: PriceDraft) {
    const action = price.status === 'active' ? 'deactivate' : 'activate';
    setBusy(true); setError(''); setMessage('');
    try {
      await api(`/admin/prices/${price.id}/${action}`, 'POST', { revision: price.revision });
      setMessage(action === 'activate' ? 'Preiszeitraum aktiviert.' : 'Preiszeitraum zurückgezogen.');
      await reload();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  if (loading) return <div className="account-page content-width"><p className="muted">Produktentwurf wird geladen …</p></div>;
  return <div className="account-page content-width">
    <div className="dashboard-title"><div><span className="eyebrow"><span className="eyebrow-line"/> NICHT AKTIV · NICHT KAUFBAR</span>
      <h1>{product?.title || 'Produktentwurf'}<span className="accent-dot">.</span></h1>
      <p>{product ? `${product.sku} · ${productTypeLabels[product.type]} · Status ${product.status}` : 'Produktverwaltung'}</p></div>
      <div className="title-actions"><Link className="button button-outline" href="/admin/produkte">← Alle Produkte</Link></div></div>
    <div className="course-feedback"><Notice message={error}/><Notice message={message} kind="success"/></div>
    {!product && !error && <p className="muted">Kein zugängliches Produkt gefunden.</p>}
    {product && <div className="admin-grid">
      {canRelease && <ProductActivation productId={product.id} revision={product.revision} canManage={canRelease} onChanged={() => void reload()}/>}
      <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">STAMMDATEN</span><h2>Produktangaben</h2>
        <p>SKU und Produktart sind nach dem Anlegen unverändert. Es gibt keine Veröffentlichung, keinen Warenkorb und keine Zahlung.</p></div></div>
        <form onSubmit={saveProduct} className="stack-form">
          <Field label="Titel" id="product-title"><input id="product-title" value={title} onChange={e => setTitle(e.target.value)} maxLength={160} disabled={!canEditProducts} required/></Field>
          <Field label="Variante (optional)" id="product-variant"><input id="product-variant" value={variant} onChange={e => setVariant(e.target.value)} maxLength={160} disabled={!canEditProducts}/></Field>
          <Field label="Beschreibung (optional)" id="product-description"><textarea id="product-description" rows={4} value={description} onChange={e => setDescription(e.target.value)} maxLength={4000} disabled={!canEditProducts}/></Field>
          <fieldset className="content-fields"><legend>Kurszuordnung</legend>
            {links.map((courseId, index) => <div className="field" key={index}>
              <label htmlFor={`product-course-${index}`}>{product.type === 'bundle' ? `Kurs ${index + 1}` : 'Kurs'}</label>
              <select id={`product-course-${index}`} value={courseId} disabled={!canEditProducts}
                onChange={e => setLinks(current => current.map((value, at) => at === index ? e.target.value : value))}>
                <option value="">Kein Kurs</option>
                {courses.map(course => <option key={course.id} value={course.id}>{course.draft?.title || course.slug} (/{course.slug})</option>)}
              </select></div>)}
            {canEditProducts && (product.type === 'bundle' || !links.length) && links.length < 20 &&
              <button type="button" className="inline-button text-link" onClick={() => setLinks(current => [...current, ''])}>+ Kurs hinzufügen</button>}
          </fieldset>
          {canEditProducts && <button className="button button-primary" disabled={busy}>{busy ? 'Bitte warten …' : 'Produktangaben speichern'} <Arrow/></button>}
        </form>
        <div className="inner-divider"/>
        <h3>Kurszuordnungen</h3>
        <div className="table-wrap"><table><thead><tr><th>Position</th><th>Kurs</th><th>Zugangsdauer</th></tr></thead><tbody>
          {product.courses.map(link => <tr key={link.course_id}><td>{link.position}</td><td>/{link.slug} · {link.status}</td>
            <td>{link.access_days_override ? `${link.access_days_override} Tage` : 'Kursvorgabe'}</td></tr>)}
          {!product.courses.length && <tr><td colSpan={3}>Noch kein Kurs zugeordnet.</td></tr>}
        </tbody></table></div>
        {canEditProducts && <button type="button" className="button button-outline" disabled={busy} onClick={() => void removeProduct()}>Produktentwurf löschen</button>}
      </section>
      <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">PREISE</span><h2>Preiszeiträume</h2>
        <p>Alle Beträge sind Brutto in Euro und kleinsten Einheit gespeichert. Steuerkategorie und Satz werden hier nicht festgelegt; das erfordert eine spätere fachliche und rechtliche Freigabe.</p></div></div>
        {product.prices.length ? <div className="table-wrap"><table><thead><tr><th>Gültig ab (UTC)</th><th>Gültig bis (UTC)</th><th>Brutto</th><th>Aktion</th><th>Kategorie</th><th>Status</th><th/></tr></thead><tbody>
          {product.prices.map(price => <tr key={price.id}><td>{utcMinuteForInput(price.valid_from)}</td><td>{price.valid_until ? utcMinuteForInput(price.valid_until) : 'offen'}</td>
            <td>{centsForInput(price.gross_cents)} EUR</td><td>{price.sale_gross_cents ? `${centsForInput(price.sale_gross_cents)} EUR (${utcMinuteForInput(price.sale_starts_at)} – ${utcMinuteForInput(price.sale_ends_at)})` : '–'}</td>
            <td>{price.tax_category}</td><td>{priceStatusLabels[price.status] || price.status} · Revision {price.revision}</td>
            <td>{canEditPrices && (price.status === 'draft'
              ? <button type="button" className="inline-button text-link" disabled={busy} onClick={() => void togglePrice(price)}>Aktivieren</button>
              : price.status === 'active'
                ? <button type="button" className="inline-button text-link" disabled={busy} onClick={() => void togglePrice(price)}>Zurückziehen</button>
                : null)}
              {canEditPrices && price.status === 'draft' && <> · <button type="button" className="inline-button text-link" disabled={busy} onClick={() => void removePrice(price)}>Löschen</button></>}</td></tr>)}
        </tbody></table></div> : <p className="muted">Noch kein Preiszeitraum hinterlegt.</p>}
        {canEditPrices ? <form onSubmit={addPrice} className="stack-form">
          <div className="field-row"><Field label="Brutto (EUR)" id="price-gross" hint="Zum Beispiel 199.00"><input id="price-gross" value={gross} onChange={e => setGross(e.target.value)} inputMode="decimal" placeholder="0.00" required/></Field>
            <Field label="Gültig ab (UTC)" id="price-valid-from" hint="Format JJJJ-MM-TTTHH:MM"><input id="price-valid-from" value={validFrom} onChange={e => setValidFrom(e.target.value)} placeholder="2027-01-01T09:30" required/></Field></div>
          <Field label="Steuerkategorie" id="price-tax-category" hint="Freitext-Kennung, kein Steuersatz. Der Standardwert ist keine steuerliche Aussage."><input id="price-tax-category" value={taxCategory} onChange={e => setTaxCategory(e.target.value)} maxLength={64} pattern="[a-z][a-z0-9_-]{0,63}" required/></Field>
          <div className="field-row"><Field label="Aktionspreis (optional)" id="price-sale-gross"><input id="price-sale-gross" value={saleGross} onChange={e => setSaleGross(e.target.value)} inputMode="decimal" placeholder="0.00"/></Field>
            <Field label="Aktion ab (UTC)" id="price-sale-start"><input id="price-sale-start" value={saleStart} onChange={e => setSaleStart(e.target.value)} placeholder="2027-02-01T00:00"/></Field>
            <Field label="Aktion bis (UTC)" id="price-sale-end"><input id="price-sale-end" value={saleEnd} onChange={e => setSaleEnd(e.target.value)} placeholder="2027-03-01T00:00"/></Field></div>
          <button className="button button-secondary" disabled={busy}>{busy ? 'Bitte warten …' : 'Preiszeitraum hinzufügen'} <Arrow/></button>
        </form> : <p className="muted">Für Preisänderungen fehlt die Berechtigung.</p>}
        <div className="inner-divider"/>
        <button type="button" className="button button-outline" disabled={busy} onClick={() => void reload()}>Aktuellen Stand laden</button>
      </section>
    </div>}
  </div>;
}
