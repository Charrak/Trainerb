import type { Metadata } from 'next';
import { configuredHttpsOrigin } from './search-index';

export function brandMetadata(base: string | undefined): Metadata {
  // Gleiche Prüfung wie für die Sitemap, aber unabhängig von der Indexierungsfreigabe.
  const origin = configuredHttpsOrigin(base);
  return {
    icons: {
      icon: [ { url: '/favicon.ico', sizes: '16x16 32x32 48x48' },
        { url: '/marke/app-192.png', sizes: '192x192', type: 'image/png' },
        { url: '/marke/app-512.png', sizes: '512x512', type: 'image/png' } ],
      apple: { url: '/marke/app-180.png', sizes: '180x180', type: 'image/png' },
    },
    ...(origin && { openGraph: { images: [{ url: `${origin}/marke/vorschaubild.png`, width: 1200, height: 630,
      alt: 'Trainer B Akademie – Wort- und Bildmarke' }] } }),
  };
}
