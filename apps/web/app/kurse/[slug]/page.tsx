import { cache } from 'react';
import { notFound } from 'next/navigation';
import { Shell } from '../../../components/site';
import { PublicCourseDetail, type PublicCourse } from '../../../components/public-courses';
import { publicMetadata } from '../../../lib/public-index';
import { validSlug } from '../../../lib/search-index';

type Props = { params: Promise<{ slug: string }> };
const read = cache(async (slug: string): Promise<PublicCourse> => {
  if (!validSlug(slug, 100)) notFound();
  const res = await fetch(`${process.env.API_INTERNAL_ORIGIN || 'http://127.0.0.1:4000'}/api/v1/courses/${slug}`, {
    cache: 'no-store', signal: AbortSignal.timeout(5000),
  });
  if (res.status === 404) notFound();
  if (!res.ok) throw new Error('Ausbildung nicht verfügbar.');
  return res.json();
});
export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  const course = await read(slug);
  return { ...publicMetadata('/kurse/' + slug), title: course.title };
}
export default async function Page({ params }: Props) {
  const course = await read((await params).slug);
  return <Shell><PublicCourseDetail course={course}/></Shell>;
}
