import { Shell } from '../../components/site';
import { Newsletter } from '../../components/newsletter';
export default function Page() {
  return (
    <Shell>
      <Newsletter mode="subscribe" />
    </Shell>
  );
}
