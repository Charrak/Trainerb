'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError, errorMessage } from '../lib/api';
import { euro, type ShopProduct, type ShopProductDetail } from '../lib/shop';
import { Arrow, Notice } from './site';

type Catalog = { data: ShopProduct[]; sales_enabled: boolean };

/**
 * Public shop. It never shows a price that cannot be bought: without an active
 * price and an enabled sale the list simply stays empty and says so.
 */
export function Shop() {
  const [catalog, setCatalog] = useState<Catalog>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<Catalog>('/shop/products').then(value => { if (active) setCatalog(value); })
      .catch(e => { if (active) setError(errorMessage(e)); });
    return () => { active = false; };
  }, []);
  return <div className="catalog-page content-width">
    <div className="catalog-hero"><div><span className="eyebrow"><span className="eyebrow-line"/> BUCHEN</span>
      <h1>Ausbildungen buchen<span className="accent-dot">.</span></h1>
      <p>Bezahlung per Rechnung/Überweisung, auf Wunsch mit Karte. Der Zugang wird nach bestätigtem Zahlungseingang freigeschaltet.</p></div>
      <span className="draft-badge">Sichere Bestellung</span></div>
    <Notice message={error}/>
    {!catalog ? <p className="muted">Angebot wird geladen …</p> : !catalog.sales_enabled ? <section className="catalog-empty">
      <span className="section-kicker">BUCHUNG DERZEIT NICHT GEÖFFNET</span><h2>Der Verkauf ist noch nicht freigeschaltet.</h2>
      <p>Die Akademie schaltet Buchungen erst frei, wenn Preise, Rechtstexte und Zahlungsweg geprüft sind. Die Ausbildungen kannst du dir im Katalog ansehen.</p>
      <Link className="text-link" href="/kurse">Zum Katalog <Arrow/></Link></section> : !catalog.data.length ?
      <section className="catalog-empty"><span className="section-kicker">NOCH KEIN ANGEBOT</span><h2>Es ist noch nichts buchbar.</h2>
        <p>Sobald ein Produkt mit gültigem Preis aktiviert ist, erscheint es hier.</p></section> :
      <div className="course-grid">{catalog.data.map(product => <article className="course-tile" key={product.id}>
        <span className="section-kicker">{product.type === 'bundle' ? 'PAKET' : 'EINZELPRODUKT'}</span>
        <h2>{product.title}</h2>
        {product.variant_name && <p>{product.variant_name}</p>}
        <p className="course-duration">{product.course_count} {product.course_count === 1 ? 'Ausbildung' : 'Ausbildungen'} · {euro(product.gross_cents)}</p>
        <Link className="text-link" href={`/buchen/${product.id}`}>Details und buchen <Arrow/></Link></article>)}</div>}
  </div>;
}

export function ShopProductPage({ productId }: { productId: string }) {
  const router = useRouter();
  const [product, setProduct] = useState<ShopProductDetail>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState(false);
  useEffect(() => {
    let active = true;
    api<ShopProductDetail>(`/shop/products/${encodeURIComponent(productId)}`)
      .then(value => { if (active) setProduct(value); })
      .catch(e => { if (active) setError(e instanceof ApiError && e.status === 404
        ? 'Dieses Produkt ist nicht buchbar.' : errorMessage(e)); });
    return () => { active = false; };
  }, [productId]);
  /**
   * Adding to the basket works signed in or not: the guest basket is the
   * default, and it merges into the account when the buyer signs in later. Only
   * a backoffice-only session (403) is redirected to the login form.
   */
  async function add() {
    setBusy(true); setError('');
    try {
      try { await api('/cart/items', 'POST', { product_id: productId }); }
      catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          await api('/guest/cart/items', 'POST', { product_id: productId });
        } else throw e;
      }
      setAdded(true); router.push('/warenkorb');
    } catch (e) { setError(errorMessage(e)); setBusy(false); }
  }
  return <div className="catalog-page content-width"><Link className="back-link" href="/buchen">← Alle Angebote</Link>
    <Notice message={error}/>
    {!product && !error ? <p className="muted catalog-detail-loading">Angebot wird geladen …</p> : product &&
      <article className="public-detail"><span className="eyebrow"><span className="eyebrow-line"/> {product.type === 'bundle' ? 'PAKET' : 'EINZELPRODUKT'}</span>
        <h1>{product.title}<span className="accent-dot">.</span></h1>
        {product.variant_name && <p className="public-subtitle">{product.variant_name}</p>}
        <p className="price-line">{euro(product.gross_cents)}</p>
        {product.description && <p className="public-description">{product.description}</p>}
        <h2 className="detail-subheading">Enthalten</h2>
        <ul className="plain-list">{product.courses.map(course => <li key={course.slug}>
          <strong>{course.title}</strong>{course.subtitle && <span> — {course.subtitle}</span>}
          <small>{course.access_days ? `Zugang ${course.access_days} Tage` : 'Zugang ohne Befristung'}
            {course.duration_minutes ? ` · ${course.duration_minutes} Minuten Lernzeit` : ''}</small></li>)}</ul>
        <div className="release-actions"><button className="button button-primary" disabled={busy || added}
          onClick={() => void add()}>{busy ? 'Bitte warten …' : added ? 'Im Warenkorb' : 'In den Warenkorb'} <Arrow/></button>
          <Link className="button button-secondary" href="/warenkorb">Zum Warenkorb</Link></div>
        <p className="muted">Zahlung per Rechnung mit Überweisung. Der Zugang wird nach bestätigtem Zahlungseingang freigeschaltet.</p>
      </article>}
  </div>;
}
