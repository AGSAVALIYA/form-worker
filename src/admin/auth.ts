/**
 * Admin authentication. Two modes, in order of preference:
 *
 * 1. Cloudflare Access (ACCESS_TEAM_DOMAIN + ACCESS_AUD set): Access signs
 *    people in at the edge; the Worker also verifies the signed JWT it adds,
 *    so a misconfigured route can never expose the admin. Both are optional
 *    dashboard variables, not listed in wrangler.jsonc.
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

type AccessConfig = { issuer: string; audience: string };

/** Optional variables: only set when Access protects the admin, so they may be missing from `Env`. */
type OptionalAccess = { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string };

/**
 * Returns the Access settings, or null when Access is not configured. A team
 * domain that is not a hostname (e.g. "na" typed into the Deploy button to get
 * past a required field) counts as not configured, so the password still works.
 */
function accessConfig(env: Env): AccessConfig | null {
  const { ACCESS_TEAM_DOMAIN, ACCESS_AUD } = env as Env & OptionalAccess;
  const domain = (ACCESS_TEAM_DOMAIN ?? '').trim().replace(/^https:\/\//, '').replace(/\/+$/, '');
  const audience = (ACCESS_AUD ?? '').trim();
  if (!domain || !audience) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain)) {
    console.warn(JSON.stringify({ event: 'access_config_ignored', reason: 'ACCESS_TEAM_DOMAIN is not a hostname' }));
    return null;
  }
  return { issuer: `https://${domain}`, audience };
}

async function viaAccess(request: Request, { issuer, audience }: AccessConfig): Promise<AdminAuth> {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) {
    return deny(
      403,
      'This admin is set up for Cloudflare Access (ACCESS_TEAM_DOMAIN and ACCESS_AUD are set), but the request did not come through Access. ' +
        'Enable Cloudflare Access for this Worker, or delete both variables to sign in with ADMIN_PASSWORD.',
    );
  }

  try {
    // Created per request: key sets must not be shared across requests in Workers.
    const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(token, keys, { issuer, audience });
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
  const access = accessConfig(env);
  if (access) return viaAccess(request, access);
  if (env.ADMIN_PASSWORD) return viaPassword(request, env.ADMIN_PASSWORD);
  return deny(503, 'The admin is disabled. Configure Cloudflare Access (ACCESS_TEAM_DOMAIN and ACCESS_AUD) or set an ADMIN_PASSWORD secret.');
}
