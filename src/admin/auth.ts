/**
 * Admin authentication. Two modes, in order of preference:
 *
 * 1. Cloudflare Access (ACCESS_TEAM_DOMAIN + ACCESS_AUD set): Access signs
 *    people in at the edge; the Worker also verifies the signed JWT it adds,
 *    so a misconfigured route can never expose the admin.
 * 2. ADMIN_PASSWORD secret: HTTP Basic auth (any username). Use a long,
 *    random password.
 *
 * With neither configured the admin is disabled.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { secretsEqual } from '../lib/crypto';

export type AdminAuth = { ok: true; user: string; mode: 'access' | 'password' } | { ok: false; response: Response };

function deny(status: number, message: string, headers: Record<string, string> = {}): AdminAuth {
  return {
    ok: false,
    response: new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers } }),
  };
}

async function viaAccess(request: Request, env: Env): Promise<AdminAuth> {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return deny(403, 'Sign in through Cloudflare Access to use the admin.');

  const domain = env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, '');
  const issuer = domain.startsWith('https://') ? domain : `https://${domain}`;
  try {
    // Created per request: key sets must not be shared across requests in Workers.
    const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(token, keys, { issuer, audience: env.ACCESS_AUD });
    return { ok: true, user: typeof payload.email === 'string' ? payload.email : 'Access user', mode: 'access' };
  } catch {
    return deny(403, 'Your Cloudflare Access session is not valid for this application.');
  }
}

async function viaPassword(request: Request, adminPassword: string): Promise<AdminAuth> {
  const challenge = { 'WWW-Authenticate': 'Basic realm="Form Worker", charset="UTF-8"' };
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Basic ')) return deny(401, 'Sign in required.', challenge);

  let decoded = '';
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(header.slice(6)), (char) => char.charCodeAt(0)));
  } catch {
    return deny(401, 'Sign in required.', challenge);
  }
  const separator = decoded.indexOf(':');
  const user = separator >= 0 ? decoded.slice(0, separator) : '';
  const password = separator >= 0 ? decoded.slice(separator + 1) : '';

  if (!(await secretsEqual(password, adminPassword))) return deny(401, 'Wrong password.', challenge);
  return { ok: true, user: user || 'admin', mode: 'password' };
}

export async function authenticateAdmin(request: Request, env: Env): Promise<AdminAuth> {
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) return viaAccess(request, env);
  if (env.ADMIN_PASSWORD) return viaPassword(request, env.ADMIN_PASSWORD);
  return deny(503, 'The admin is disabled. Configure Cloudflare Access (ACCESS_TEAM_DOMAIN and ACCESS_AUD) or set an ADMIN_PASSWORD secret.');
}
