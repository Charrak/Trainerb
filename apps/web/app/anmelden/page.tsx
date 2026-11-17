import { AuthLayout } from '../../components/site';
import { AuthPanel } from '../../components/auth-panel';
import { testInboxEnabled } from '../../lib/test-inbox';
export const dynamic = 'force-dynamic';
export default function Page() { return <AuthLayout><AuthPanel mode="login" showTestInbox={testInboxEnabled()}/></AuthLayout>; }
