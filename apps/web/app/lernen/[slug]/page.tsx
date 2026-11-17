import { Shell } from '../../../components/site';
import { CoursePlayer } from '../../../components/learning';
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <Shell><CoursePlayer slug={slug}/></Shell>;
}
