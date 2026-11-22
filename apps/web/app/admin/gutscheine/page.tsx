import { Shell } from '../../../components/site';
import { AdminCoupons } from '../../../components/admin-coupons';
export const metadata = { title: 'Gutscheine · Trainer B Akademie' };
export default function Page() {
  return (
    <Shell>
      <AdminCoupons />
    </Shell>
  );
}
