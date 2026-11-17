import { Shell } from '../../../../components/site';
import { AdminCourseDetail } from '../../../../components/admin-course-detail';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Shell><AdminCourseDetail id={id}/></Shell>;
}
