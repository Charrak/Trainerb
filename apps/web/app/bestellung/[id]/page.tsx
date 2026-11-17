import { Shell } from '../../../components/site';
import { OrderPage } from '../../../components/checkout';
import { GuestOrderPage } from '../../../components/guest-checkout';
export const dynamic = 'force-dynamic';
/**
 * One page for two audiences: an account buyer reads the order with their
 * session, a guest reads it through the cart cookie. The guest view is shown
 * first because it is the stricter read; an account buyer with an unknown order
 * simply falls through to the session view.
 */
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>;
  searchParams: Promise<{ gast?: string }> }) {
  const { id } = await params;
  const { gast } = await searchParams;
  if (gast === '1') return <Shell><GuestOrderPage orderId={id}/></Shell>;
  return <Shell><OrderPage orderId={id}/></Shell>;
}
