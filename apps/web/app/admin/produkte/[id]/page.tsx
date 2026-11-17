import { Shell } from '../../../../components/site';
import { AdminProductDetail } from '../../../../components/admin-product-detail';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Shell><AdminProductDetail id={id}/></Shell>;
}
