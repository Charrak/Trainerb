import { Shell } from '../../components/site';
import { WithdrawalForm } from '../../components/withdrawal';
export const metadata = { title: 'Widerruf' };
export default function Page() {
  return <Shell><section className="auth-layout content-width"><div className="intro-column"><span className="section-kicker">RECHTLICHES</span>
    <h1>Widerruf<span className="accent-dot">.</span></h1>
    <p>Du kannst deinen Vertrag ohne Angabe von Gründen widerrufen. Die Bestätigung mit Datum und Uhrzeit
      geht an die Adresse, die du hier angibst — sie ist dein Beleg für die Frist.</p></div>
    <WithdrawalForm/></section></Shell>;
}
