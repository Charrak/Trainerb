import {NavigationProvider,EditorialNavigation} from './editorial-navigation';
import Link from 'next/link';
import { liveSite } from '../lib/site-stage';
import type { ReactNode } from 'react';

export function Brand() {
  return <Link href="/" className="brand" aria-label="Trainer B Akademie – zur Startseite">
    <img className="brand-mark" src="/marke/zeichen.svg" width="34" height="34" alt=""/>
    <span className="brand-word">trainer<span>b</span><small>AKADEMIE</small></span>
  </Link>;
}
export function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return <svg aria-hidden="true" viewBox="0 0 20 20" width="19" height="19" fill="none"><path d={diagonal ? 'M5 15 15 5M6 5h9v9' : 'M3.5 10h12M11 5l5 5-5 5'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
export function Shield() {
  return <svg aria-hidden="true" width="17" height="17" viewBox="0 0 20 20" fill="none"><path d="M10 2 16 4.4v4.8c0 4-2.5 6.8-6 8.8-3.5-2-6-4.8-6-8.8V4.4L10 2Z" stroke="currentColor" strokeWidth="1.4"/><path d="m7.3 9.7 1.8 1.8 3.7-3.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
export function Header() {
  return <header className="site-header"><div className="header-inner"><Brand/><nav aria-label="Hauptnavigation" className="top-nav">
    <Link className="catalog-link" href="/kurse">Katalog</Link><Link className="catalog-link" href="/buchen">Buchen</Link><Link href="/anmelden">Anmelden</Link><Link className="nav-cta" href="/registrieren">Konto erstellen <Arrow diagonal/></Link>
  </nav></div><EditorialNavigation location="header"/></header>;
}
const footerGroups = [
  { title: 'Akademie', links: [['Ausbildungen', '/kurse'], ['Buchen', '/buchen'], ['Website-Seiten', '/seiten'], ['Newsletter', '/newsletter']] },
  { title: 'Rechtliches', links: [['Impressum', '/impressum'], ['Datenschutz', '/datenschutz'], ['AGB', '/agb'],
    ['Widerrufsbelehrung', '/widerrufsbelehrung'], ['Vertrag widerrufen', '/widerruf'], ['Zahlungsinformationen', '/zahlungsinformationen'],
    ['Cookie-Einstellungen', '/cookie-einstellungen'], ['Meine Datenrechte', '/datenrechte']] },
  { title: 'Konto', links: [['Mein Konto', '/konto'], ['Anmelden', '/anmelden'], ['Konto erstellen', '/registrieren']] },
] as const;

export function Footer({ live }: { live: boolean }) {
  return <footer className="site-footer">
    <Brand/>
    <div className="footer-columns">{footerGroups.map(({ title, links }) => (
      <div key={title}>
        <h2 id={'footer-' + title}>{title}</h2>
        <nav aria-labelledby={'footer-' + title}><ul>{links.map(([label, href]) => (
          <li key={href}><Link href={href} prefetch={false}>{label}</Link></li>
        ))}</ul></nav>
        {title === 'Akademie' && <EditorialNavigation location="footer"/>}
      </div>
    ))}</div>
    {!live && <p className="footer-note">Entwicklungsversion · Nur Testdaten verwenden. Zahlungen im Testbetrieb.</p>}
  </footer>;
}
export function Shell({ children }: { children: ReactNode }) {
  return <NavigationProvider><Header/><main id="inhalt">{children}</main><Footer live={liveSite}/></NavigationProvider>;
}
export function AuthLayout({ children }: { children: ReactNode }) {
  return <Shell><div className="auth-form-layout">{children}</div></Shell>;
}
export function SimpleLayout({ children, eyebrow = 'DEIN KONTO' }: { children: ReactNode; eyebrow?: string }) {
  return <Shell><section className="simple-page content-width"><div className="simple-heading"><span className="eyebrow"><span className="eyebrow-line"/> {eyebrow}</span><Link className="back-link" href="/anmelden">← Zur Anmeldung</Link></div>{children}</section></Shell>;
}
export function Notice({ message, kind = 'error' }: { message?: string; kind?: 'error' | 'success' | 'info' }) {
  if (!message) return null;
  return <div role={kind === 'error' ? 'alert' : 'status'} className={`notice notice-${kind}`}>{message}</div>;
}
export function Field({ label, id, children, hint }: { label: string; id: string; children: ReactNode; hint?: string }) {
  return <div className="field"><label htmlFor={id}>{label}</label>{children}{hint && <small id={`${id}-hint`}>{hint}</small>}</div>;
}
