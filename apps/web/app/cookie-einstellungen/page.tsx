import Link from 'next/link';
import { Shell } from '../../components/site';
export const metadata = {title: 'Cookie-Einstellungen · Trainer B Akademie'};
export default function Page() {
  return (
    <Shell>
      <section className="simple-page content-width">
        <span className="eyebrow">DATENSCHUTZ</span>
        <h1>Cookie-Einstellungen</h1>
        <p>
          Auf der Akademie-Website sind nur technisch notwendige Cookies vorgesehen. Statistik, personalisierte Werbung
          sowie die Messung von Newsletter-Öffnungen und Klicks sind ausgeschaltet. Es gibt dafür keine Einwilligung zu
          erteilen und keine Einstellung zu speichern.
        </p>
        <h2>Welche Cookies dienen welchem Zweck?</h2>
        <dl>
          <dt>
            <strong>
              Anmeldung: <code>__Host-session</code>
            </strong>
          </dt>
          <dd>
            Ordnet Anfragen deiner Sitzung zu. Höchstdauer: fünf Minuten bei der MFA-Voranmeldung, acht Stunden im
            Backoffice oder sieben Tage im Teilnehmerkonto. Inaktive Sitzungen enden früher. Beim Abmelden wird die
            Sitzung ungültig.
          </dd>
          <dt>
            <strong>
              Formularschutz: <code>__Host-csrf</code>
            </strong>
          </dt>
          <dd>
            Schützt Änderungen davor, unbemerkt von anderen Websites ausgelöst zu werden. Ohne Anmeldung ist der
            Nachweis bis zu einem Tag gültig.
          </dd>
          <dt>
            <strong>
              Gastwarenkorb: <code>__Host-guest-cart</code>
            </strong>
          </dt>
          <dd>
            Ordnet dir den Warenkorb und die daraus abgeschlossene Gastbestellung zu. Der Nachweis läuft nach 24 Stunden
            ab und kann bei weiterer Nutzung erneuert werden.
          </dd>
        </dl>
        <h2>Cookies entfernen</h2>
        <p>
          Über die Website-Daten deines Browsers kannst du die Cookies löschen. Danach musst du dich erneut anmelden;
          der Zugriff auf einen nicht übernommenen Gastwarenkorb oder eine Gastbestellung kann verloren gehen.
        </p>
        <p>
          Diese Übersicht gilt für die Akademie-Website. Wechselst du zur Zahlung auf die Seite eines
          Zahlungsdienstleisters, gelten dort dessen eigene Einstellungen.
        </p>
        <p>
          <Link href="/datenschutz">Zur Datenschutzerklärung</Link> · <Link href="/datenrechte">Meine Datenrechte</Link>
        </p>
      </section>
    </Shell>
  );
}
