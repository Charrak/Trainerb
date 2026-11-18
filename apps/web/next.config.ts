import type { NextConfig } from 'next';

// The browser only calls relative /api paths. This server-side rewrite keeps
// private API addresses out of browser code and preserves a single origin.
const internalApi = process.env.API_INTERNAL_ORIGIN || 'http://127.0.0.1:4000';
// Development previews are served through a proxy host, so the dev server must
// accept that origin. It is configured, not hardcoded, and only in development:
// next.config is evaluated at build time, so this must never reach production.
const devOrigins = (process.env.ALLOWED_DEV_ORIGINS ?? '')
  .split(',').map(entry => entry.trim()).filter(Boolean);

const config: NextConfig = {
  ...(process.env.NODE_ENV !== 'production' && devOrigins.length ? { allowedDevOrigins: devOrigins } : {}),
  devIndicators: false,
  // The optional React debug stream otherwise makes development-page
  // hydration depend on an HMR WebSocket, which some preview proxies block.
  experimental: { reactDebugChannel: false },
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${internalApi}/api/v1/:path*` }];
  },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      // Development previews are embedded in Arena's iframe. Production must
      // refuse framing (and additionally receive a reviewed CSP at the proxy).
      ...(process.env.NODE_ENV === 'production' ? [{ key: 'X-Frame-Options', value: 'DENY' }] : []),
      { key: 'Cache-Control', value: 'no-store' },
    ] }];
  },
};
export default config;
