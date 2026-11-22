import Link from 'next/link';
import { Arrow } from './site';

/**
 * Öffentliche Startseite. Die Anmeldung bleibt über Kopf- und Fußzeile sowie
 * den ausdrücklichen Zugang erreichbar; hier steht das Angebot im Mittelpunkt.
 * Keine erfundenen Preise, Bewertungen oder Referenzen.
 */
export function Startseite() {
  return (
    <div className="startseite content-width">
      <section className="start-hero" aria-labelledby="start-titel">
        <span className="eyebrow">
          <span className="eyebrow-line" /> TRAINER B AKADEMIE
        </span>
        <h1 id="start-titel">Wissen, das weiterbringt.</h1>
        <p>
          Die Akademie bündelt geprüfte Ausbildungen an einem Ort: klarer Aufbau, ehrliche Angaben und ein Lernbereich,
          der deinen Fortschritt geräteübergreifend festhält. Veröffentlicht wird nur, was vorher fachlich und
          rechtlich geprüft wurde.
        </p>
        <div className="start-actions">
          <Link className="button button-primary" href="/kurse">
            Ausbildungen ansehen <Arrow diagonal />
          </Link>
          <Link className="button button-secondary" href="/registrieren">
            Konto erstellen <Arrow />
          </Link>
        </div>
      </section>

      <section className="start-schritte" aria-labelledby="start-schritte">
        <h2 id="start-schritte">So funktioniert es</h2>
        <ol>
          <li>
            <strong>Ausbildung auswählen</strong>
            <p>Katalog und Buchungsseite zeigen ausschließlich freigegebene Angebote mit nachvollziehbaren Angaben.</p>
          </li>
          <li>
            <strong>Zugang erhalten</strong>
            <p>Nach bestätigtem Zahlungseingang wird dein Zugang freigeschaltet; Konto und Leistung bleiben getrennt.</p>
          </li>
          <li>
            <strong>Lernen und abschließen</strong>
            <p>Kapitel, Prüfungen und Fortschritt laufen über dein Konto – auf Wunsch mit Urkunde nach vollständigem Abschluss.</p>
          </li>
        </ol>
      </section>

      <section className="start-rechtliches" aria-labelledby="start-recht">
        <h2 id="start-recht">Transparent von Anfang an</h2>
        <p>
          Rechtstexte, Datenschutz und Widerruf sind öffentlich einsehbar. Erst wenn Preise, Vertragstexte und
          Zahlungsweg geprüft sind, wird der Verkauf freigeschaltet. Bis dahin zeigt die Buchungsseite diesen Stand
          offen an.
        </p>
        <nav aria-label="Rechtliches und Hilfe">
          <Link href="/widerruf">Vertrag widerrufen</Link>
          <Link href="/datenschutz">Datenschutz</Link>
          <Link href="/agb">AGB</Link>
          <Link href="/datenrechte">Meine Datenrechte</Link>
        </nav>
      </section>
    </div>
  );
}
