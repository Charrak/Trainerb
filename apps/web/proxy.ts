import { NextResponse, type NextRequest } from 'next/server';
import { documentPolicy } from './lib/document-policy';

export function proxy(request: NextRequest) {
  const policy = documentPolicy(process.env);
  // Next.js liest die Nonce beim Rendern aus der REQUEST-CSP. Ein statischer
  // Antwortheader allein würde die Hydrierung blockieren.
  const headers = new Headers(request.headers);
  headers.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

export const config = { matcher: ['/((?!api/v1(?:/|$)|_next/static/|_next/image(?:/|$)|_next/webpack-hmr).*)'] };
