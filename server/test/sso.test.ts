import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

let s: TestServer;
let providerId: string;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {}); // adds "Microsoft Entra ID (simulated)" backed by /mock/oidc
  providerId = (await s.api('GET', '/auth/status')).ssoProviders[0].id;
});
afterAll(async () => {
  await s?.app.close();
});

/** Walk the browser redirects: app → identity provider (pick account) → callback. */
async function ssoSignIn(login: string, opts: { tamperState?: boolean } = {}) {
  const start = await fetch(`${s.base}/api/auth/oidc/${providerId}/start?returnTo=/tasks`, { redirect: 'manual' });
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get('location')!);
  expect(authorize.pathname).toBe('/mock/oidc/authorize');
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  authorize.pathname = '/mock/oidc/authorize/approve';
  authorize.searchParams.set('login', login);
  const approve = await fetch(authorize, { redirect: 'manual' });
  const callback = new URL(approve.headers.get('location')!);
  if (opts.tamperState) callback.searchParams.set('state', 'forged');
  const res = await fetch(callback, { redirect: 'manual' });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  const body = await res.text();
  // the callback page hands the session key to the web app (localStorage)
  const key = /localStorage\.setItem\("sm\.sessionKey","([^"]+)"\)/.exec(body)?.[1];
  if (cookie && key) ssoKeys.set(cookie, key);
  return { res, cookie, body, location: res.headers.get('location') ?? '' };
}
const ssoKeys = new Map<string, string>();
const auth = (cookie: string) => ({ cookie, 'x-sm-session': ssoKeys.get(cookie) ?? '' });

const me = async (cookie: string) => (await fetch(`${s.base}/api/auth/me`, { headers: auth(cookie) })).json();

describe('single sign-on (OIDC)', () => {
  it('lists the provider on the sign-in page but never returns the secret', async () => {
    const providers = await s.api('GET', '/sso/providers');
    expect(providers[0].hasClientSecret).toBe(true);
    expect(JSON.stringify(providers)).not.toContain('demo-oidc-secret');
    const d = await s.api('POST', '/sso/discover', { issuer: providers[0].issuer });
    expect(d.ok).toBe(true);
    expect(d.tokenEndpoint).toContain('/mock/oidc/token');
  });

  it('signs in, creates the account and maps roles and teams from the token', async () => {
    const r = await ssoSignIn('c3d5'); // Oskar, role claim SM.Operators
    expect(r.res.status).toBe(200);
    expect(r.body).toContain('location.replace("/tasks")');
    const info = await me(r.cookie!);
    expect(info.user.username).toBe('oskar@contoso.example');
    expect(info.user.displayName).toBe('Oskar Operator');
    expect(info.user.roles).toEqual(['operator']);
    expect(info.user.teams).toEqual(['Service Desk']);
    expect(info.user.authSource).toBe(providerId);
    const audit = await s.api('GET', '/audit?q=oskar');
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['user.created', 'user.roles_synced', 'auth.login']));
  });

  it('denies users without a mapped role', async () => {
    const r = await ssoSignIn('e5b7'); // Nina, no roles
    expect(r.res.status).toBe(302);
    expect(decodeURIComponent(r.location)).toContain('no role assigned');
    expect(r.cookie).toBeUndefined();
  });

  it('rejects forged or replayed state', async () => {
    const r = await ssoSignIn('c3d5', { tamperState: true });
    expect(decodeURIComponent(r.location)).toContain('expired or is unknown');
  });

  it('re-synchronises roles at every sign-in', async () => {
    const [p] = await s.api('GET', '/sso/providers');
    const mappings = p.mappings.map((m: any) => (m.claimValue === 'SM.Operators' ? { ...m, roles: ['viewer'], teams: [] } : m));
    await s.api('PUT', `/sso/providers/${p.id}`, { ...p, mappings });
    const r = await ssoSignIn('c3d5');
    const info = await me(r.cookie!);
    expect(info.user.roles).toEqual(['viewer']);
    expect(info.user.teams).toEqual([]);
    await s.api('PUT', `/sso/providers/${p.id}`, p); // restore
  });

  it('links a pre-created account with the same user name', async () => {
    const { user } = await s.api('POST', '/users', { username: 'sofia@contoso.example', roles: ['auditor'] });
    const r = await ssoSignIn('d4c6');
    const info = await me(r.cookie!);
    expect(info.user.id).toBe(user.id);
    expect(info.user.roles).toEqual(['approver']);
    expect(info.user.mustChangePassword).toBe(false);
    expect(await (await fetch(`${s.base}/api/processes`, { headers: auth(r.cookie!) })).status).toBe(200);
  });

  it('can restrict password sign-in to administrators', async () => {
    await s.api('PUT', '/settings', { passwordLogin: 'adminsOnly' });
    await expect(s.as('olivia', 'Demo-password-1')).rejects.toThrow(/403/);
    await expect(s.as('admin', 'Admin-password-1')).resolves.toBeTruthy();
    await s.api('PUT', '/settings', { passwordLogin: 'all' });
  });

  it('does not offer disabled providers', async () => {
    const [p] = await s.api('GET', '/sso/providers');
    await s.api('PUT', `/sso/providers/${p.id}`, { ...p, enabled: false });
    expect((await s.api('GET', '/auth/status')).ssoProviders).toEqual([]);
    const start = await fetch(`${s.base}/api/auth/oidc/${p.id}/start`, { redirect: 'manual' });
    expect(decodeURIComponent(start.headers.get('location')!)).toContain('disabled');
    await s.api('PUT', `/sso/providers/${p.id}`, { ...p, enabled: true });
  });
});
