import { Shell } from '../../../components/site';
import { ShopProductPage } from '../../../components/shop';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Shell><ShopProductPage productId={id}/></Shell>;
}
