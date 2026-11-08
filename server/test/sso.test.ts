import { beforeAll, describe, expect, it } from 'vitest';
import { sessionSetCookie, setup, ssoBinding, startTestServer, withRefusalReason, type TestServer } from './helpers.js';

let s: TestServer;
let providerId: string;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {}); // adds "Microsoft Entra ID (simulated)" backed by /mock/oidc
  providerId = (await s.api('GET', '/auth/status')).ssoProviders[0].id;
});

/** Walk the browser redirects: app → identity provider (pick account) → callback. */
async function ssoSignIn(login: string, opts: { tamperState?: boolean; cookie?: (binding: string) => string } = {}) {
  const start = await fetch(`${s.base}/api/auth/oidc/${providerId}/start?returnTo=/tasks`, { redirect: 'manual' });
  expect(start.status).toBe(302);
  const binding = ssoBinding(start);
  const authorize = new URL(start.headers.get('location')!);
  expect(authorize.pathname).toBe('/mock/oidc/authorize');
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  authorize.pathname = '/mock/oidc/authorize/approve';
  authorize.searchParams.set('login', login);
  const approve = await fetch(authorize, { redirect: 'manual' });
  const callback = new URL(approve.headers.get('location')!);
  if (opts.tamperState) callback.searchParams.set('state', 'forged');
  // the browser that started the sign-in sends its binding cookie back (opts.cookie: what another browser would send)
  const res = await fetch(callback, { redirect: 'manual', headers: { cookie: opts.cookie ? opts.cookie(binding) : binding } });
  const cookie = sessionSetCookie(res)?.split(';')[0];
  const body = await res.text();
  // the callback page hands the session key to the web app (localStorage)
  const key = /localStorage\.setItem\("sm\.sessionKey","([^"]+)"\)/.exec(body)?.[1];
  if (cookie && key) ssoKeys.set(cookie, key);
  return { res, cookie, body, location: res.headers.get('location') ?? '', binding, callback };
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
    // the person sees a reference, not the reason (it would tell whether an account exists); the audit entry has it
    expect(r.location).toMatch(/^\/\?sso_error=SSO_SIGN_IN_REFUSED&sso_ref=[0-9a-f]{8}$/);
    expect(decodeURIComponent(r.location)).not.toContain('role');
    expect(await withRefusalReason(s, r.location)).toContain('no role assigned');
    expect(r.cookie).toBeUndefined();
  });

  it('rejects forged or replayed state', async () => {
    const r = await ssoSignIn('c3d5', { tamperState: true });
    expect(decodeURIComponent(r.location)).toBe('/?sso_error=SSO_STATE_UNKNOWN');
  });

  it('puts no text of the request on the sign-in page: a fixed code only (security review 0.10.0 S8)', async () => {
    const lure = 'Your account is locked. Call the service desk at +1 555 0100 and give your password.';
    const start = await fetch(`${s.base}/api/auth/oidc/${providerId}/start`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const callback = `${s.base}/api/auth/oidc/callback?state=${state}&error=x&error_description=${encodeURIComponent(lure)}`;
    // from the browser that started it: the identity provider's (or an attacker's) description stays out of the address
    const r = await fetch(callback, { redirect: 'manual', headers: { cookie: ssoBinding(start) } });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/?sso_error=SSO_IDP_ERROR');
    // an unknown provider and a disabled one: a code as well
    const unknown = await fetch(`${s.base}/api/auth/oidc/nope/start`, { redirect: 'manual' });
    expect(unknown.headers.get('location')).toBe('/?sso_error=SSO_PROVIDER_UNAVAILABLE');
  });

  it('binds the sign-in to the browser that started it (login CSRF, RFC 9700 §4.7.1)', async () => {
    const start = await fetch(`${s.base}/api/auth/oidc/${providerId}/start`, { redirect: 'manual' });
    expect(start.headers.getSetCookie()).toEqual([expect.stringMatching(/^sm_sso_[\w-]{16}=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600$/)]);
    // the callback uses the binding cookie up
    const ok = await ssoSignIn('c3d5');
    expect(ok.res.status).toBe(200);
    expect(ok.res.headers.getSetCookie()[1]).toBe(`${ok.binding.split('=')[0]}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  });

  it('refuses a callback opened in another browser: an attacker cannot hand over their own sign-in', async () => {
    const audits = async () =>
      (await s.api('GET', '/audit?action=auth.login_failed&limit=200')).filter((a: any) => a.details?.reason === 'SSO_BROWSER_MISMATCH');
    const before = (await audits()).length;
    // the attacker starts and signs in at the provider, then sends the callback link to the victim (no cookie)
    const r = await ssoSignIn('c3d5', { cookie: () => '' });
    expect(r.res.status).toBe(302);
    expect(decodeURIComponent(r.location)).toBe('/?sso_error=SSO_STATE_UNKNOWN');
    expect(r.cookie).toBeUndefined();
    expect(r.body).not.toContain('sm.sessionKey');
    const entries = await audits();
    expect(entries.length).toBe(before + 1);
    expect(entries[0]).toMatchObject({ actor: 'anonymous', entityType: 'sso', entityId: providerId });
    expect(entries[0].summary).toContain('did not come from the browser that started it');
    // the state is used up: not even the attacker's own browser can finish it now
    const again = await fetch(r.callback, { redirect: 'manual', headers: { cookie: r.binding } });
    expect(decodeURIComponent(again.headers.get('location') ?? '')).toBe('/?sso_error=SSO_STATE_UNKNOWN');
    expect(sessionSetCookie(again)).toBeNull();
  });

  it('refuses the binding cookie of another sign-in or a wrong value', async () => {
    const other = ssoBinding(await fetch(`${s.base}/api/auth/oidc/${providerId}/start`, { redirect: 'manual' }));
    const wrongName = await ssoSignIn('c3d5', { cookie: () => other });
    expect(decodeURIComponent(wrongName.location)).toBe('/?sso_error=SSO_STATE_UNKNOWN');
    const wrongValue = await ssoSignIn('c3d5', { cookie: (b) => `${b.split('=')[0]}=${other.split('=')[1]}` });
    expect(decodeURIComponent(wrongValue.location)).toBe('/?sso_error=SSO_STATE_UNKNOWN');
    expect(wrongValue.cookie).toBeUndefined();
  });

  it('keeps sign-ins in several tabs apart (one binding cookie per sign-in)', async () => {
    const begin = async () => {
      const start = await fetch(`${s.base}/api/auth/oidc/${providerId}/start`, { redirect: 'manual' });
      const authorize = new URL(start.headers.get('location')!);
      authorize.pathname = '/mock/oidc/authorize/approve';
      authorize.searchParams.set('login', 'c3d5');
      const approve = await fetch(authorize, { redirect: 'manual' });
      return { binding: ssoBinding(start), callback: approve.headers.get('location')! };
    };
    const a = await begin();
    const b = await begin();
    expect(a.binding.split('=')[0]).not.toBe(b.binding.split('=')[0]);
    // the browser sends both cookies with each callback; the later tab finishes first
    const jar = `${a.binding}; ${b.binding}`;
    for (const t of [b, a]) {
      const res = await fetch(t.callback, { redirect: 'manual', headers: { cookie: jar } });
      expect(res.status).toBe(200);
      expect(sessionSetCookie(res)).toMatch(/^sm_session=/);
    }
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

  it('links a local account with the same user name only when the provider links by name', async () => {
    const { user } = await s.api('POST', '/users', { username: 'sofia@contoso.example', roles: ['auditor'] });
    // new providers link only accounts an administrator bound to them
    const [p] = await s.api('GET', '/sso/providers');
    expect(p.linkExisting).toBe('bound');
    const refused = await ssoSignIn('d4c6');
    expect(await withRefusalReason(s, refused.location)).toContain('has to bind it to');
    await s.api('PUT', `/sso/providers/${p.id}`, { ...p, linkExisting: 'byName' });
    expect((await s.api('GET', '/sso/providers'))[0].warnings).toContainEqual({ code: 'LINK_BY_NAME' });
    const r = await ssoSignIn('d4c6');
    const info = await me(r.cookie!);
    expect(info.user.id).toBe(user.id);
    expect(info.user.roles).toEqual(['approver']);
    expect(info.user.mustChangePassword).toBe(false);
    expect(await (await fetch(`${s.base}/api/processes`, { headers: auth(r.cookie!) })).status).toBe(200);
    await s.api('PUT', `/sso/providers/${p.id}`, { ...p, linkExisting: 'bound' });
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
    expect(start.headers.get('location')).toBe('/?sso_error=SSO_PROVIDER_UNAVAILABLE');
    await s.api('PUT', `/sso/providers/${p.id}`, { ...p, enabled: true });
  });
});
