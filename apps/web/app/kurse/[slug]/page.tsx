import { Shell } from '../../../components/site';
import { PublicCourseDetail } from '../../../components/public-courses';
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <Shell><PublicCourseDetail slug={slug}/></Shell>;
}
