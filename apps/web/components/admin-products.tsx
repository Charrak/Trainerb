'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage, type Profile } from '../lib/api';
import { type CourseOption, type ProductListItem, type ProductPage, productTypeLabels } from '../lib/products';
import { centsForInput } from '../lib/products';
import { Arrow, Field, Notice } from './site';

const canManage = (profile: Profile) => profile.permissions.includes('products.manage') &&
  profile.roles.some(role => role === 'admin' || role === 'superadmin');

export function AdminProducts() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile>();
  const [products, setProducts] = useState<ProductListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState('');
  const [type, setType] = useState<'single' | 'bundle'>('single');
  const [sku, setSku] = useState(''), [title, setTitle] = useState(''), [variant, setVariant] = useState(''), [description, setDescription] = useState('');
  const [courseId, setCourseId] = useState(''), [courseOptions, setCourseOptions] = useState<CourseOption[]>([]);
  const [optionsError, setOptionsError] = useState('');
  const allowed = !!profile && canManage(profile);
  async function load(next?: string) {
    setBusy(true); setError('');
    try {
      const page = await api<ProductPage<ProductListItem>>(`/admin/products${next ? `?cursor=${encodeURIComponent(next)}` : ''}`);
      setProducts(current => next ? [...current, ...page.data] : page.data); setCursor(page.next_cursor);
      setTotal(page.total); setHasLoaded(true);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) { setProducts([]); setProfile(undefined); setHasLoaded(false); }
      setError(errorMessage(e));
    } finally { setBusy(false); setLoading(false); }
  }
  useEffect(() => {
    let active = true;
    api<Profile>('/me').then(async user => {
      if (!active) return;
      setProfile(user);
      if (!canManage(user)) { setError('Für diesen Bereich fehlt die Berechtigung.'); setLoading(false); return; }
      await load();
      try {
        const courses = await api<ProductPage<CourseOption>>('/admin/courses?limit=100');
        if (active) setCourseOptions(courses.data.map(course => ({ id: course.id, slug: course.slug, status: course.status,
          visibility: course.visibility, draft: (course as unknown as { draft: { title: string } | null }).draft })));
      } catch (e) { if (active) setOptionsError('Die Kursliste konnte nicht geladen werden. Produkte lassen sich auch ohne Kurszuordnung speichern.'); }
    }).catch(e => { if (active) { setError(errorMessage(e)); setLoading(false); } });
    return () => { active = false; };
  }, []);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const product = await api<{ id: string }>('/admin/products', 'POST', { sku: sku.trim().toUpperCase(), type, title,
        variant_name: variant, description, courses: courseId ? [{ course_id: courseId, access_days_override: null }] : [] });
      router.push(`/admin/produkte/${product.id}`);
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  }
  return <div className="account-page content-width">
    <div className="dashboard-title"><div><span className="eyebrow"><span className="eyebrow-line"/> GESCHÜTZTE VERWALTUNG</span>
      <h1>Produktentwürfe<span className="accent-dot">.</span></h1><p>Produkte und Preise vorbereiten. Buchbar wird ein Produkt erst nach Aktivierung.</p></div>
      <div className="title-actions"><Link className="button button-secondary" href="/admin/kurse">Kursverwaltung <Arrow/></Link>
        <Link className="button button-outline" href="/admin">← Nutzerverwaltung</Link></div></div>
    <div className="course-feedback"><Notice message={error}/></div>
    {loading ? <p className="muted">Produktentwürfe werden geladen …</p> : allowed && <div className="admin-grid">
      <section className="dashboard-card"><div className="section-heading"><div><span className="section-kicker">ÜBERSICHT</span><h2>Alle Produktentwürfe</h2>
        <p>{total} {total === 1 ? 'Produkt' : 'Produkte'} · ausschließlich für Administration und Superadministration sichtbar.</p></div></div>
        {hasLoaded && !products.length && !error ? <p className="muted">Noch keine Produktentwürfe vorhanden.</p> : <div className="draft-list">
          {products.map(product => <Link className="draft-row" key={product.id} href={`/admin/produkte/${product.id}`}>
            <div><strong>{product.title}</strong><span>{product.sku} · {productTypeLabels[product.type]} · {product.course_count} Kurs(e) · {product.price_count} Preis(e)</span></div>
            <span className="draft-row-end"><span className="draft-badge">{product.latest_price ? `${centsForInput(product.latest_price.gross_cents)} EUR` : 'Ohne Preis'}</span><Arrow/></span></Link>)}</div>}
        {cursor && <button className="button button-secondary" disabled={busy} onClick={() => void load(cursor)}>Weitere laden <Arrow/></button>}
        {!hasLoaded && error && <button className="button button-secondary" disabled={busy} onClick={() => void load()}>Erneut laden</button>}
      </section>
      <section className="dashboard-card" id="neu"><div className="section-heading"><div><span className="section-kicker">NEUER ENTWURF</span><h2>Produkt anlegen</h2>
        <p>Ein Entwurf ist weder aktiv noch kaufbar. Erst Aktivierung und ein aktiver Preis machen ihn im Shop buchbar.</p></div></div>
        <Notice message={optionsError} kind="info"/>
        <form onSubmit={create} className="stack-form">
          <div className="field-row"><Field label="SKU" id="new-product-sku" hint="Nur Großbuchstaben, Zahlen, Bindestriche und Unterstriche."><input id="new-product-sku" name="sku" value={sku} onChange={e => setSku(e.target.value)} maxLength={64} pattern="[A-Za-z0-9]+([-_][A-Za-z0-9]+)*" aria-describedby="new-product-sku-hint" required/></Field>
            <Field label="Produktart" id="new-product-type" hint="Ein Paket benötigt bei späterer Freigabe mindestens zwei verschiedene Kurse."><select id="new-product-type" name="type" value={type} onChange={e => setType(e.target.value === 'bundle' ? 'bundle' : 'single')} aria-describedby="new-product-type-hint"><option value="single">Einzelprodukt</option><option value="bundle">Paket</option></select></Field></div>
          <Field label="Titel" id="new-product-title"><input id="new-product-title" name="title" value={title} onChange={e => setTitle(e.target.value)} maxLength={160} required/></Field>
          <Field label="Variante (optional)" id="new-product-variant"><input id="new-product-variant" name="variant" value={variant} onChange={e => setVariant(e.target.value)} maxLength={160}/></Field>
          <Field label="Beschreibung (optional)" id="new-product-description"><textarea id="new-product-description" name="description" rows={4} value={description} onChange={e => setDescription(e.target.value)} maxLength={4000}/></Field>
          <Field label={type === 'bundle' ? 'Erster Kurs (optional, weitere danach)' : 'Kurs (optional)'} id="new-product-course">
            <select id="new-product-course" name="course" value={courseId} onChange={e => setCourseId(e.target.value)}>
              <option value="">Noch kein Kurs</option>
              {courseOptions.map(course => <option key={course.id} value={course.id}>{course.draft?.title || course.slug} (/{course.slug})</option>)}
            </select></Field>
          <button className="button button-primary" disabled={busy}>{busy ? 'Bitte warten …' : 'Produktentwurf anlegen'} <Arrow/></button>
        </form></section>
    </div>}
  </div>;
}
