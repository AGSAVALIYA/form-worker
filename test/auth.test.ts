import { describe, expect, it } from 'vitest';
import { authenticateAdmin } from '../src/admin/auth';

// Requests carry no credentials, so the response shows which mode is active:
// password mode asks for Basic auth (401), Access mode refuses outright (403).
const request = new Request('https://forms.example.com/admin');
const env = (vars: Record<string, string>) => ({ ADMIN_PASSWORD: 'correct horse', ...vars }) as unknown as Env;

async function mode(vars: Record<string, string>) {
  const auth = await authenticateAdmin(request, env(vars));
  if (auth.ok) throw new Error('expected a sign-in challenge');
  return auth.response.headers.has('WWW-Authenticate') ? 'password' : 'access';
}

describe('authenticateAdmin', () => {
  it('uses the password when the Access variables are missing', async () => {
    expect(await mode({})).toBe('password');
  });

  it('ignores placeholder Access values such as "na"', async () => {
    expect(await mode({ ACCESS_TEAM_DOMAIN: 'na', ACCESS_AUD: 'na' })).toBe('password');
  });

  it('ignores Access when only one of the two variables is set', async () => {
    expect(await mode({ ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com' })).toBe('password');
  });

  it('requires Access once both variables are set', async () => {
    const vars = { ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com/', ACCESS_AUD: 'abc123' };
    expect(await mode(vars)).toBe('access');
    const auth = await authenticateAdmin(request, env(vars));
    if (!auth.ok) expect(await auth.response.text()).toContain('did not come through Access');
  });
});
