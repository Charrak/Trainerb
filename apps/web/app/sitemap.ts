import { publishedUrls } from '../lib/search-index';
import { publicOrigin } from '../lib/public-index';

export const dynamic = 'force-dynamic';
export default async function sitemap() {
  const signal = AbortSignal.timeout(10_000);
  return publishedUrls(publicOrigin(), async path => {
    const res = await fetch(`${process.env.API_INTERNAL_ORIGIN || 'http://127.0.0.1:4000'}/api/v1/${path}`, {
      cache: 'no-store', credentials: 'omit', redirect: 'error', signal,
    });
    if (!res.ok) throw new Error('Veröffentlichungsliste nicht verfügbar.');
    return res.json();
  });
}
