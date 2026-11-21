// Absichtlich ohne Router, Sitzung, CMS und Fehlerobjekt. Auch ohne Layout-CSS lesbar.
export function Fehleransicht() {
  return <main id="inhalt" className="system-view">
    <img src="/marke/zeichen.svg" width="48" height="48" alt=""/>
    <h1>Seite konnte nicht geladen werden</h1>
    <p>Versuche es noch einmal. Wenn der Fehler bestehen bleibt, kehre zur Startseite zurück.</p>
    <div className="system-actions"><button type="button" className="button button-primary" onClick={() => window.location.reload()}>Seite neu laden</button>{' '}
      <a href="/">Zur Startseite</a></div>
  </main>;
}
