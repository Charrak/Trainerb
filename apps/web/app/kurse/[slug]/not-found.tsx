import Link from 'next/link';
import { Shell } from '../../../components/site';
export default function NotFound() {
  return <Shell><section className="simple-page content-width"><h1>Diese Ausbildung ist nicht verfügbar.</h1>
    <Link href="/kurse">Alle Ausbildungen</Link></section></Shell>;
}
