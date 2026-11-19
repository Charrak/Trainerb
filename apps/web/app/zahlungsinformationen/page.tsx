import { LegalPage } from '../../components/legal-page';
export const dynamic = 'force-dynamic';
export const metadata = { title: 'Zahlungsinformationen' };
export default function Page() {
  return <LegalPage kind="payment_info" title="Zahlungsinformationen" />;
}
