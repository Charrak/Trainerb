import type { MetadataRoute } from 'next';

// Ausschließlich die konfigurierte öffentliche Origin verwenden, niemals Host-/Forwarded-Header.
export function indexOrigin(live: boolean, base: string | undefined): string | null {
  if (!live || !base) return null;
  try {
    const url = new URL(base);
    return url.protocol === 'https:' && /^[a-z0-9.-]+$/i.test(url.hostname) && url.href === `${url.origin}/`
      ? url.origin : null;
  } catch { return null; }
}

const sections = [
  { path: '/seiten', api: 'pages', cursor: 'after', maxSlug: 80 },
  { path: '/kurse', api: 'courses?limit=100', cursor: 'cursor', maxSlug: 100 },
] as const;

export function crawlerRules(origin: string | null): MetadataRoute.Robots {
  if (!origin) return { rules: { userAgent: '*', disallow: '/' } };
  return { rules: { userAgent: '*', disallow: '/', allow: [
    ...sections.flatMap(s => [s.path + '$', s.path + '/']), '/_next/static/', '/sitemap.xml$',
  ] }, sitemap: `${origin}/sitemap.xml` };
}

export function validSlug(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

type PublicList = { data: { slug: string }[]; next_cursor: string | null };
export async function publishedUrls(origin: string | null, list: (path: string) => Promise<PublicList>): Promise<MetadataRoute.Sitemap> {
  if (!origin) return [];
  // Beide Übersichtseinträge zählen ebenfalls zur Protokollgrenze von 50.000 URLs.
  const urls = new Set(sections.map(s => origin + s.path));
  for (const s of sections) {
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `${s.api.includes('?') ? '&' : '?'}${s.cursor}=${cursor}` : '';
      const page: PublicList = await list(s.api + query);
      for (const row of page.data) {
        const url = `${origin}${s.path}/${row.slug}`;
        if (!validSlug(row.slug, s.maxSlug) || urls.has(url) || urls.size >= 50_000) throw new Error('Ungültige Sitemap-Liste.');
        urls.add(url);
      }
      cursor = page.next_cursor;
      if (cursor !== null && (!validSlug(cursor, s.maxSlug) || page.data.at(-1)?.slug !== cursor)) throw new Error('Ungültige Seitenmarke.');
    } while (cursor);
  }
  return Array.from(urls, url => ({ url }));
}
