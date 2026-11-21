export const metadata = { title: 'Seite nicht gefunden · Trainer B Akademie', robots: { index: false, follow: false } };

export default function NotFound() {
  return <main id="inhalt" className="system-view">
    <img src="/marke/zeichen.svg" width="48" height="48" alt=""/>
    <h1>Seite nicht gefunden</h1>
    <p>Unter dieser Adresse ist keine Seite verfügbar. Prüfe den Link oder gehe zum Kurskatalog.</p>
    <nav className="system-actions" aria-label="Weiterführende Links"><a href="/">Zur Startseite</a><a href="/kurse">Zum Kurskatalog</a></nav>
  </main>;
}
