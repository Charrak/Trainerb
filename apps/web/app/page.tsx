import { Shell } from '../components/site';
import { Startseite } from '../components/startseite';
import { publicMetadata } from '../lib/public-index';
export const dynamic = 'force-dynamic';
export function generateMetadata() {
  return {
    ...publicMetadata('/'),
    title: 'Trainer B Akademie',
    description: 'Geprüfte Ausbildungen, persönlicher Lernbereich und transparente Vertragsbedingungen.',
  };
}
export default function Home() {
  return (
    <Shell>
      <Startseite />
    </Shell>
  );
}
