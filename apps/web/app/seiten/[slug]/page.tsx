import { notFound } from 'next/navigation';
import { cache } from 'react';
import { Shell } from '../../../components/site';
import { EditorialText, type Presentation } from '../../../components/editorial-text';
export const dynamic = 'force-dynamic';
const read = cache(async (slug: string) => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) notFound();
  const res = await fetch(`${process.env.API_INTERNAL_ORIGIN || 'http://127.0.0.1:4000'}/api/v1/pages/${slug}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 404) notFound();
  if (!res.ok) throw new Error('Seite nicht verfügbar.');
  return (await res.json()) as { title: string; description: string; body: string } & Presentation;
});
type Props = { params: Promise<{ slug: string }> };
export async function generateMetadata({ params }: Props) {
  const p = await read((await params).slug);
  return { title: p.title, description: p.description };
}
export default async function Page({ params }: Props) {
  const p = await read((await params).slug);
  return (
    <Shell>
      <article className="simple-page content-width">
        <EditorialText {...p} />
      </article>
    </Shell>
  );
}
