import { Shell } from './site';
import type { ShopConfig } from '../lib/shop';

export async function LegalPage({ kind, title }: { kind: 'imprint' | 'privacy' | 'terms' | 'payment_info' | 'withdrawal'; title: string }) {
  let version: ShopConfig['legal'][string] | undefined;
  let unavailable = false;
  try {
    const origin = process.env.API_INTERNAL_ORIGIN || 'http://127.0.0.1:4000';
    const response = await fetch(new URL('/api/v1/shop/config', origin), { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Legal wording unavailable');
    version = ((await response.json()) as ShopConfig).legal[kind];
  } catch { unavailable = true; }
  return <Shell><article className="simple-page content-width"><h1>{title}</h1>
    {version ? <><p>Fassung {version.version}</p><p style={{ whiteSpace: 'pre-wrap' }}>{version.wording}</p></>
      : <p>{unavailable ? 'Der Text konnte nicht geladen werden. Bitte versuche es später erneut.' : 'Für diese Seite ist noch keine Fassung veröffentlicht.'}</p>}
  </article></Shell>;
}
