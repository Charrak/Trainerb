import { LegalPage } from '../../components/legal-page';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Datenschutzerklärung' };
export default function Page() { return <LegalPage kind="privacy" title="Datenschutzerklärung"/>; }
