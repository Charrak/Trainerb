import { LegalPage } from '../../components/legal-page';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Widerrufsbelehrung' };
export default function Page() {
  return <LegalPage kind="withdrawal" title="Widerrufsbelehrung" />;
}
