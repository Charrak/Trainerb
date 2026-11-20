import { randomBytes } from 'node:crypto';
import { isIPv6 } from 'node:net';

/** Nur eine konfigurierte HTTPS-Origin übernehmen, nie Header, Pfade, Zugangsdaten oder CSP-Platzhalter. */
function httpsOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (!/^[a-z0-9.-]+$/i.test(url.hostname) && !isIPv6(url.hostname.slice(1, -1)))) throw new Error('Für die CSP ist eine einzelne HTTPS-Origin erforderlich.');
  return url.origin;
}

export function documentPolicy(env: NodeJS.ProcessEnv) {
  const nonce = randomBytes(24).toString('base64');
  const development = env.NODE_ENV === 'development' && env.APP_ENV !== 'production';
  const embedded = development && env.APP_ENV === 'development' && env.TRAINERB_EMBEDDED_PREVIEW_COOKIES === 'true';
  const frameAncestors = embedded && env.PREVIEW_FRAME_ORIGIN ? httpsOrigin(env.PREVIEW_FRAME_ORIGIN) : "'none'";
  const store = env.MEDIA_S3_ENDPOINT ? ` ${httpsOrigin(env.MEDIA_S3_ENDPOINT)}` : '';
  return [
    "default-src 'none'", "base-uri 'none'", "object-src 'none'", "form-action 'self'",
    `frame-ancestors ${frameAncestors}`, `script-src 'self' 'nonce-${nonce}'${development ? " 'unsafe-eval'" : ''}`,
    "script-src-attr 'none'", "style-src 'self' 'unsafe-inline'", "font-src 'self'",
    `img-src 'self' data:${store}`, `media-src 'self'${store}`, "connect-src 'self'",
  ].join('; ');
}
