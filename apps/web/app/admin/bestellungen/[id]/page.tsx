import { Shell } from '../../../../components/site';
import { AdminOrderDetail } from '../../../../components/admin-orders';
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Shell><AdminOrderDetail orderId={id}/></Shell>;
}
