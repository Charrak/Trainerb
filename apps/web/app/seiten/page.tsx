import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Shell } from '../../components/site';
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<{ after?: string }> }) {
  const { after } = await searchParams;
  if (
    after !== undefined &&
    (typeof after !== 'string' || after.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(after))
  )
    notFound();
  const r = await fetch(
    `${process.env.API_INTERNAL_ORIGIN || 'http://127.0.0.1:4000'}/api/v1/pages${after ? '?after=' + after : ''}`,
    { cache: 'no-store', signal: AbortSignal.timeout(5000) },
  );
  if (!r.ok) throw new Error('Seitenübersicht nicht verfügbar.');
  const list = (await r.json()) as { data: { slug: string; title: string }[]; next_cursor: string | null };
  return (
    <Shell>
      <section className="simple-page content-width">
        <h1>Website-Seiten</h1>
        {list.data.length ? (
          <ul>
            {list.data.map((p) => (
              <li key={p.slug}>
                <Link href={'/seiten/' + p.slug}>{p.title}</Link>
              </li>
            ))}
          </ul>
        ) : (
          <p>Keine veröffentlichten Seiten.</p>
        )}
        {list.next_cursor && <Link href={'/seiten?after=' + list.next_cursor}>Weitere Seiten</Link>}
      </section>
    </Shell>
  );
}
