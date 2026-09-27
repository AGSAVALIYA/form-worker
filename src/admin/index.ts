import { HttpError, json } from '../lib/http';
import { handleAdminApi } from './api';
import { authenticateAdmin } from './auth';
import appCss from './ui/app.css';
import appJs from './ui/app.client.js';
import indexHtml from './ui/index.html';

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
  'Cache-Control': 'no-store',
};

function asset(body: string, contentType: string): Response {
  return new Response(body, { headers: { ...SECURITY_HEADERS, 'Content-Type': contentType } });
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  const auth = await authenticateAdmin(request, env);
  if (!auth.ok) return withSecurityHeaders(auth.response);

  const path = url.pathname.slice('/admin'.length) || '/';

  if (path.startsWith('/api/')) {
    // CSRF guard: the UI always sends this header, which a cross-site form or
    // image cannot, and browsers mark cross-site requests with Sec-Fetch-Site.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const site = request.headers.get('Sec-Fetch-Site');
      if (request.headers.get('X-Form-Worker') !== '1' || (site && site !== 'same-origin')) {
        return withSecurityHeaders(json({ ok: false, error: 'Cross-site request blocked' }, { status: 403 }));
      }
    }
    try {
      return withSecurityHeaders(await handleAdminApi(request, env, path.slice('/api'.length), auth, url.origin));
    } catch (error) {
      if (error instanceof HttpError) return withSecurityHeaders(json({ ok: false, error: error.message }, { status: error.status }));
      console.error(JSON.stringify({ event: 'admin_error', path, error: String(error) }));
      return withSecurityHeaders(json({ ok: false, error: 'Something went wrong' }, { status: 500 }));
    }
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  if (path === '/' ) return asset(indexHtml, 'text/html; charset=utf-8');
  if (path === '/app.js') return asset(appJs, 'text/javascript; charset=utf-8');
  if (path === '/app.css') return asset(appCss, 'text/css; charset=utf-8');
  return new Response('Not found', { status: 404, headers: SECURITY_HEADERS });
}
