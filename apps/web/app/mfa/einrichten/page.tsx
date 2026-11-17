export const dynamic = 'force-dynamic';
import { SimpleLayout } from '../../../components/site';
import { MfaForm } from '../../../components/mfa-form';
export default function Page() { return <SimpleLayout><MfaForm enroll/></SimpleLayout>; }
