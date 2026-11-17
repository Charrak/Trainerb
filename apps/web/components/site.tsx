import Link from 'next/link';
import type { ReactNode } from 'react';

export function Brand() {
  return <Link href="/" className="brand" aria-label="Trainer B Akademie – zur Startseite">
    <span className="brand-mark" aria-hidden="true"><span></span><span></span><span></span></span>
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
    <Link className="catalog-link" href="/kurse">Ausbildungen</Link><Link href="/anmelden">Anmelden</Link><Link className="nav-cta" href="/registrieren">Konto erstellen <Arrow diagonal/></Link>
  </nav></div></header>;
}
export function Footer() {
  return <footer className="site-footer"><div><Brand/><p>Ein guter Anfang für alles, was kommt.</p></div><div className="footer-note"><span className="status-dot"/> Entwicklungsversion · Nur Testdaten verwenden<br/><span>Keine Buchungen oder Zahlungen verfügbar.</span></div></footer>;
}
export function Shell({ children }: { children: ReactNode }) {
  return <><Header/><main id="inhalt">{children}</main><Footer/></>;
}
export function AuthLayout({ children }: { children: ReactNode }) {
  return <Shell><section className="auth-layout content-width">
    <div className="intro-column">
      <div className="eyebrow"><span className="eyebrow-line"/> DEIN NÄCHSTER SCHRITT</div>
      <h1>Wissen bewegt.<br/><em>Du auch.</em></h1>
      <p className="intro-copy">Dein persönlicher Zugang zur Akademie. Erstelle dein Konto und entdecke, was als Nächstes entsteht.</p>
      <div className="journey" aria-label="So funktioniert die Kontoerstellung">
        <div><span>01</span><p><strong>Konto erstellen</strong><small>Mit deinem Namen und deiner E-Mail</small></p></div>
        <div><span>02</span><p><strong>E-Mail bestätigen</strong><small>Link öffnen und Passwort festlegen</small></p></div>
        <div><span>03</span><p><strong>Sicher anmelden</strong><small>Dein persönlicher Bereich wartet</small></p></div>
      </div>
      <div className="intro-bottom"><span className="mini-seal"><Shield/></span><p><strong>Schritt für Schritt.</strong><br/>Die Akademie befindet sich im Aufbau.</p></div>
      <div className="orbit orbit-one" aria-hidden="true"/><div className="orbit orbit-two" aria-hidden="true"/>
    </div>
    <div className="auth-card-wrap">{children}<p className="secure-caption"><Shield/> Dein Zugang ist persönlich und geschützt.</p></div>
  </section><section className="build-note content-width"><div><span className="build-number">01 / 04</span><span className="build-divider"/><div><strong>Der Anfang ist gemacht.</strong><p>Konten & Sicherheit sind der erste Baustein.</p></div></div><Link href="/kurse" className="build-right">AUSBILDUNGEN ENTDECKEN <Arrow/></Link></section></Shell>;
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
