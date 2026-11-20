import { Shell } from '../../components/site';
import { PrivacyIntake } from '../../components/privacy-requests';
export const metadata = {title: 'Meine Datenrechte · Trainer B Akademie'};
export default function Page() {
  return (
    <Shell>
      <PrivacyIntake />
    </Shell>
  );
}
