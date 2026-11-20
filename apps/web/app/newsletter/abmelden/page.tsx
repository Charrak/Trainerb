import { Shell } from '../../../components/site';
import { Newsletter } from '../../../components/newsletter';
export const metadata = {title: 'Newsletter abbestellen · Trainer B Akademie'};
export default function Page() {
  return (
    <Shell>
      <Newsletter mode="unsubscribe" />
    </Shell>
  );
}
