import { Shell } from '../../../components/site';
import { WithdrawalVerify } from '../../../components/withdrawal';
export const metadata = { title: 'Widerruf bestätigen' };
export default function Page() {
  return <Shell><section className="withdrawal-layout content-width"><div className="intro-column"><span className="section-kicker">WIDERRUF</span>
    <h1>Adresse bestätigen<span className="accent-dot">.</span></h1>
    <p>Über diesen Schritt stellen wir sicher, dass die Erklärung von der Adresse kommt, die sie angibt.</p></div>
    <WithdrawalVerify/></section></Shell>;
}
