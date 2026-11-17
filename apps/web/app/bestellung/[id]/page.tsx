import { Shell } from '../../../components/site';
import { OrderPage } from '../../../components/checkout';
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Shell><OrderPage orderId={id}/></Shell>;
}
