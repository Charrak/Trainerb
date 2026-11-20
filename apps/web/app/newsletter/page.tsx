import { Shell } from '../../components/site';
import { Newsletter } from '../../components/newsletter';
export const metadata = {title: 'Newsletter · Trainer B Akademie'};
export default function Page() {
  return (
    <Shell>
      <Newsletter mode="subscribe" />
    </Shell>
  );
}
