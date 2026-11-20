import { Shell } from '../../../components/site';
import { AccountCopy } from '../../../components/account-export';
export const metadata = {title: 'Meine Datenkopie · Trainer B Akademie'};
export default function Page() {
  return (
    <Shell>
      <AccountCopy />
    </Shell>
  );
}
