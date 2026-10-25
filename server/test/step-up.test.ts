import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Step-up re-authentication (#14, auth/step-up.ts): sensitive actions need a recent confirmation of the session's owner
 * – the password again (password sessions) or a fresh sign-in at the identity provider (single sign-on sessions, with
 * the mock identity provider honouring prompt=login / max_age and emitting auth_time, amr, acr and acrs).
 */
let s: TestServer;
let providerId = '';
let mock: typeof import('../src/mock/mockOidc.js');
let cfg: typeof import('../src/config.js');

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  providerId = (await s.api('GET', '/sso/providers'))[0].id;
  mock = await import('../src/mock/mockOidc.js');
  cfg = await import('../src/config.js');
}, 120_000);
afterAll(async () => {
  await s?.app.close();
});
afterEach(() => mock.resetMockIdentities());

/** The refusal of a call: { status, code, body }. */
const refusal = async (p: Promise<unknown>): Promise<{ status: number; code?: string; body?: any }> => {
  try {
    await p;
    return { status: 200 };
  } catch (e) {
    const x = e as { status: number; body?: any };
    return { status: x.status, code: x.body?.code, body: x.body };
  }
};
const lastAudit = async (action: string) => (await s.api('GET', `/audit?action=${action}&limit=1`))[0];

/** A password session that has not confirmed anything (a sign-in counts as a confirmation: ended right away). */
async function unconfirmed(username = 'admin', password = 'Admin-password-1'): Promise<Client> {
  const c = await s.as(username, password, { autoStepUp: false });
  expect((await c('GET', '/auth/step-up')).until).not.toBeNull(); // the sign-in itself
  await c('DELETE', '/auth/step-up');
  expect((await c('GET', '/auth/step-up')).until).toBeNull();
  return c;
}

function withSession(cookie: string, key: string): Client {
  return (async (method: string, url: string, body?: unknown) => {
    const res = await fetch(s.base + '/api' + url, {
      method,
      headers: { 'x-sm-client': '1', cookie, 'x-sm-session': key, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw Object.assign(new Error(`${method} ${url} → ${res.status}: ${text}`), { status: res.status, body: data });
    return data;
  }) as Client;
}

/** A session through the mock identity provider (browser redirects walked with fetch). */
async function ssoClient(login: string): Promise<Client> {
  const start = await fetch(`${s.base}/api/auth/oidc/${providerId}/start`, { redirect: 'manual' });
  const authorize = new URL(start.headers.get('location')!);
  authorize.pathname += '/approve';
  authorize.searchParams.set('login', login);
  const approve = await fetch(authorize, { redirect: 'manual' });
  const res = await fetch(new URL(approve.headers.get('location')!), { redirect: 'manual' });
  expect(res.status).toBe(200);
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const key = /localStorage\.setItem\("sm\.sessionKey","([^"]+)"\)/.exec(await res.text())![1]!;
  return withSession(cookie, key);
}

/** A step-up through the mock: start, sign in as `login` at the provider, the callback page (no session). */
async function ssoStepUp(c: Client, login: string, opts: { popup?: boolean; returnTo?: string } = {}) {
  const start = await c('POST', '/auth/step-up/sso', opts);
  const url = new URL(start.authorizationUrl);
  const asked = Object.fromEntries(url.searchParams);
  url.pathname += '/approve';
  url.searchParams.set('login', login);
  const approve = await fetch(url, { redirect: 'manual' });
  const callback = await fetch(new URL(approve.headers.get('location')!), { redirect: 'manual' });
  const html = await callback.text();
  return { asked, status: callback.status, setCookie: callback.headers.get('set-cookie'), html, ticket: /ticket:"([^"]+)"/.exec(html)?.[1] };
}

async function provider(): Promise<Record<string, any>> {
  const x = (await s.api('GET', '/sso/providers')).find((y: { id: string }) => y.id === providerId);
  const { id: _i, hasClientSecret: _h, createdAt: _c, updatedAt: _u, warnings: _w, ...input } = x;
  return input;
}
const configure = async (patch: Record<string, unknown>) => s.api('PUT', `/sso/providers/${providerId}`, { ...(await provider()), ...patch });

describe('password step-up', () => {
  it('asks a password session for its password before a sensitive action, and goes on once confirmed', async () => {
    const c = await unconfirmed();
    const r = await refusal(c('POST', '/me/tokens', { name: 'step-up', scope: 'read' }));
    expect(r).toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    expect(r.body.stepUp).toMatchObject({ method: 'password', windowMinutes: 5 });
    // everyday actions need none
    await c('PATCH', '/me', { displayName: 'Admin' });

    const wrong = await refusal(c('POST', '/auth/step-up', { password: 'not-it' }));
    expect(wrong).toMatchObject({ status: 403, code: 'STEP_UP_WRONG_PASSWORD' });
    expect(await lastAudit('auth.step_up_failed')).toMatchObject({ actor: 'admin', details: { method: 'password', reason: 'wrong_password' } });
    expect(await refusal(c('POST', '/me/tokens', { name: 'step-up', scope: 'read' }))).toMatchObject({ code: 'STEP_UP_REQUIRED' });

    const ok = await c('POST', '/auth/step-up', { password: 'Admin-password-1' });
    expect(ok).toMatchObject({ method: 'password', confirmedWith: 'password' });
    expect(Date.parse(ok.until) - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(await lastAudit('auth.step_up')).toMatchObject({ actor: 'admin', details: { method: 'password' } });
    const token = await c('POST', '/me/tokens', { name: 'step-up', scope: 'read' });
    expect(token.token).toMatch(/^smt_/);
  });

  it('counts wrong passwords like sign-in failures: locked after five', async () => {
    const { temporaryPassword } = await s.api('POST', '/users', { username: 'stepper', roles: ['viewer'] });
    const first = s.client({ autoStepUp: false });
    await first('POST', '/auth/login', { username: 'stepper', password: temporaryPassword });
    await first('POST', '/auth/password', { current: temporaryPassword, next: 'Stepper-password-1' });
    const c = await unconfirmed('stepper', 'Stepper-password-1');
    for (let i = 0; i < 5; i++) expect((await refusal(c('POST', '/auth/step-up', { password: `wrong-${i}` }))).code).toBe('STEP_UP_WRONG_PASSWORD');
    // locked: even the right password waits (and so does the sign-in from this address)
    expect(await refusal(c('POST', '/auth/step-up', { password: 'Stepper-password-1' }))).toMatchObject({ status: 429, code: 'TOO_MANY_ATTEMPTS' });
    expect(await refusal(s.as('stepper', 'Stepper-password-1'))).toMatchObject({ status: 429 });
  });

  it('lasts SM_STEP_UP_MINUTES, for the session that confirmed only', async () => {
    const a = await unconfirmed();
    const b = await unconfirmed();
    await a('POST', '/auth/step-up', { password: 'Admin-password-1' });
    // the other session of the same person is not confirmed
    expect(await refusal(b('POST', '/me/tokens', { name: 'b', scope: 'read' }))).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await a('POST', '/me/tokens', { name: 'a', scope: 'read' });
    const before = cfg.config.session.stepUpMs;
    cfg.config.session.stepUpMs = 1000;
    try {
      await new Promise((r) => setTimeout(r, 1200));
      expect(await refusal(a('POST', '/me/tokens', { name: 'a2', scope: 'read' }))).toMatchObject({ code: 'STEP_UP_REQUIRED' });
      expect((await a('GET', '/auth/step-up')).until).toBeNull();
    } finally {
      cfg.config.session.stepUpMs = before;
    }
  });

  it('confirms a fresh sign-in right away, and a password step-up needs a password session', async () => {
    const c = await s.as('admin', 'Admin-password-1', { autoStepUp: false });
    await c('POST', '/me/tokens', { name: 'fresh', scope: 'read' });
    const sso = await ssoClient('a1f3');
    expect(await refusal(sso('POST', '/auth/step-up', { password: 'whatever' }))).toMatchObject({ status: 400, code: 'STEP_UP_METHOD' });
    expect(await refusal(c('POST', '/auth/step-up/sso', {}))).toMatchObject({ status: 400, code: 'STEP_UP_METHOD' });
  });
});

describe('each sensitive route', () => {
  it('refuses without a step-up and goes on after one', async () => {
    const c = await unconfirmed();
    const vera = (await s.api('GET', '/users')).find((u: { username: string }) => u.username === 'vera');
    const pack = { scope: { controlIds: [] }, from: '2026-01-01T00:00:00Z', to: new Date().toISOString() };
    const settings = await s.api('GET', '/settings/notifications');
    // [method, url, body, status or code expected once confirmed – the route's own answer, past the step-up]
    const calls: [string, string, unknown, number | string][] = [
      ['POST', '/me/tokens', { name: 'route', scope: 'mcp' }, 200],
      ['POST', '/vault/passphrase', { current: 'wrong passphrase', next: 'another passphrase 1', rotateDataKey: false }, 'WRONG_PASSPHRASE'],
      ['POST', '/users', { username: 'stepped-new', roles: ['operator'] }, 200],
      ['PUT', `/users/${vera.id}`, { roles: ['viewer', 'auditor'] }, 200],
      ['POST', `/users/${vera.id}/reset-password`, {}, 200],
      ['PUT', `/sso/providers/${providerId}`, await provider(), 200],
      ['POST', '/sso/providers', { ...(await provider()), displayName: 'Step-up copy', clientSecret: 'demo-oidc-secret', enabled: false }, 200],
      ['PUT', '/settings', { outboundAllowList: ['stepup.example'] }, 200],
      ['PUT', '/settings/notifications', { ...settings, allowedEmailDomains: ['example.com', 'stepup.example'] }, 200],
      ['POST', '/compliance/evidence-packs', pack, 'INVALID_INPUT'],
      ['POST', '/migration/export', { passphrase: 'wrong passphrase', transferPassphrase: 'transfer passphrase 1' }, 'WRONG_PASSPHRASE'],
      ['POST', '/migration/imports/staged/nothing/apply', { mapping: {}, confirmFingerprint: 'x' }, 404],
    ];
    for (const [method, url, body] of calls) {
      expect(await refusal(c(method, url, body)), `${method} ${url}`).toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    }
    await c('POST', '/auth/step-up', { password: 'Admin-password-1' });
    for (const [method, url, body, expected] of calls) {
      const r = await refusal(c(method, url, body));
      if (typeof expected === 'number') expect(r.status, `${method} ${url}: ${JSON.stringify(r.body)}`).toBe(expected);
      else expect(r.code, `${method} ${url}`).toBe(expected);
    }
    await c('PUT', `/users/${vera.id}`, { roles: ['viewer'] });
    const copy = (await s.api('GET', '/sso/providers')).find((p: { displayName: string }) => p.displayName === 'Step-up copy');
    await c('DELETE', '/auth/step-up');
    expect(await refusal(c('DELETE', `/sso/providers/${copy.id}`))).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await c('POST', '/auth/step-up', { password: 'Admin-password-1' });
    await c('DELETE', `/sso/providers/${copy.id}`);
  });

  it('asks only for the sensitive part of a change', async () => {
    const c = await unconfirmed();
    const vera = (await s.api('GET', '/users')).find((u: { username: string }) => u.username === 'vera');
    await c('PUT', `/users/${vera.id}`, { displayName: 'Vera Viewer', roles: ['viewer'] }); // roles unchanged
    await c('PUT', '/settings', { retentionRunDays: 365 });
    const settings = await s.api('GET', '/settings/notifications');
    await c('PUT', '/settings/notifications', settings);
    expect(await refusal(c('PUT', '/settings', { passwordLogin: 'adminsOnly' }))).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await refusal(c('PUT', '/settings', { outboundPolicy: 'open' }))).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    // deactivating an administrator
    const other = await s.api('POST', '/users', { username: 'second-admin', roles: ['admin'] });
    expect(await refusal(c('PUT', `/users/${other.user?.id ?? other.id}`, { active: false }))).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    // binding an account to a provider
    expect(await refusal(c('PUT', `/users/${vera.id}`, { provider: providerId }))).toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });
});

describe('API tokens and emergency sessions', () => {
  it('refuses API tokens on sensitive requests, whatever their scope, and lets them do the rest', async () => {
    const { token } = await s.api('POST', '/me/tokens', { name: 'full', scope: 'full' });
    const bearer = (method: string, url: string, body: unknown) =>
      fetch(s.base + '/api' + url, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const settings = await s.api('GET', '/settings/notifications');
    const changed = await bearer('PUT', '/settings/notifications', { ...settings, allowedEmailDomains: ['token.example'] });
    expect(changed.status).toBe(403);
    expect(await changed.json()).toMatchObject({ code: 'SESSION_REQUIRED' });
    expect((await bearer('PUT', '/settings/notifications', settings)).status).toBe(200);
    const pack = await bearer('POST', '/compliance/evidence-packs', { scope: { controlIds: [] }, from: '2026-01-01T00:00:00Z', to: new Date().toISOString() });
    expect(pack.status).toBe(403);
    expect((await bearer('POST', '/auth/step-up', { password: 'Admin-password-1' })).status).toBe(403);
  });

  it('counts an emergency session as confirmed for its life', async () => {
    const { createGrant, newCode, hashCode } = await import('../src/auth/emergency.js');
    const code = newCode();
    createGrant({ username: 'admin', minutes: 30, actor: 'cli:test@host', codeHash: hashCode(code), via: 'cli' });
    const res = await fetch(s.base + '/api/auth/emergency', {
      method: 'POST',
      headers: { 'x-sm-client': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(200);
    const c = withSession(res.headers.get('set-cookie')!.split(';')[0]!, res.headers.get('x-sm-session-key')!);
    await c('DELETE', '/auth/step-up'); // nothing to end
    expect(await c('GET', '/auth/step-up')).toMatchObject({ method: 'emergency', confirmedWith: 'emergency' });
    expect((await c('GET', '/auth/step-up')).until).not.toBeNull();
    await c('PUT', '/settings', { outboundAllowList: ['emergency.example'] });
    // (an emergency session still creates no API tokens)
    expect(await refusal(c('POST', '/me/tokens', { name: 'x', scope: 'read' }))).toMatchObject({ code: 'EMERGENCY_NO_TOKENS' });
    expect(await refusal(c('POST', '/auth/step-up', { password: 'Admin-password-1' }))).toMatchObject({ code: 'STEP_UP_METHOD' });
  });
});

describe('single sign-on step-up', () => {
  it('confirms with a fresh sign-in at the provider (prompt=login, max_age=0), redeemed by the session', async () => {
    const c = await ssoClient('a1f3');
    // the sign-in was fresh (auth_time): confirmed right away
    expect((await c('GET', '/auth/step-up')).confirmedWith).toBe('sso');
    await c('DELETE', '/auth/step-up');
    const r = await refusal(c('POST', '/me/tokens', { name: 'sso', scope: 'read' }));
    expect(r).toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    expect(r.body.stepUp).toMatchObject({ method: 'sso', provider: { id: providerId, displayName: 'Microsoft Entra ID (simulated)' }, mfa: false });

    const step = await ssoStepUp(c, 'a1f3');
    expect(step.asked).toMatchObject({ prompt: 'login', max_age: '0' });
    expect(step.asked.acr_values).toBeUndefined();
    expect(step.status).toBe(200);
    expect(step.setCookie).toBeNull(); // the callback never signs in
    expect(step.ticket).toBeTruthy();
    // not confirmed until the browser holding the session redeems the ticket
    expect(await refusal(c('POST', '/me/tokens', { name: 'sso', scope: 'read' }))).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await c('POST', '/auth/step-up/sso/complete', { ticket: step.ticket })).toMatchObject({ confirmedWith: 'sso' });
    expect(await lastAudit('auth.step_up')).toMatchObject({ actor: 'max@contoso.example', details: { method: 'sso' } });
    await c('POST', '/me/tokens', { name: 'sso', scope: 'read' });
    // once only
    expect(await refusal(c('POST', '/auth/step-up/sso/complete', { ticket: step.ticket }))).toMatchObject({ code: 'STEP_UP_TICKET' });
  });

  it('is bound to the session that started it', async () => {
    const c = await ssoClient('a1f3');
    const other = await ssoClient('a1f3'); // the same person in another browser
    await c('DELETE', '/auth/step-up');
    await other('DELETE', '/auth/step-up');
    const step = await ssoStepUp(c, 'a1f3');
    expect(await refusal(other('POST', '/auth/step-up/sso/complete', { ticket: step.ticket }))).toMatchObject({ status: 403, code: 'STEP_UP_TICKET' });
    expect(await refusal(other('POST', '/me/tokens', { name: 'x', scope: 'read' }))).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    // without a session the ticket is nothing
    const anonymous = await fetch(s.base + '/api/auth/step-up/sso/complete', {
      method: 'POST',
      headers: { 'x-sm-client': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: step.ticket }),
    });
    expect(anonymous.status).toBe(401);
  });

  it('refuses another identity, a stale or missing auth_time, and says why', async () => {
    const c = await ssoClient('a1f3');
    await c('DELETE', '/auth/step-up');
    const refusedWith = async (login: string, code: string) => {
      const step = await ssoStepUp(c, login);
      expect(step.ticket, step.html).toBeUndefined();
      expect((await c('GET', '/auth/step-up')).failure).toMatchObject({ code });
      expect(await lastAudit('auth.step_up_failed')).toMatchObject({ details: { method: 'sso', reason: code } });
      expect(await refusal(c('POST', '/me/tokens', { name: 'x', scope: 'read' }))).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    };
    // another person at the provider (Erik), even though he could sign in himself
    await refusedWith('b2e4', 'STEP_UP_OTHER_IDENTITY');
    // a provider that does not honour prompt=login: the last sign-in there is an hour old
    mock.setMockIdentity('a1f3', { authAgeSeconds: 3600, ignorePrompt: true });
    await refusedWith('a1f3', 'STEP_UP_STALE');
    // a provider that does not send auth_time at all
    mock.setMockIdentity('a1f3', { idToken: { auth_time: null } });
    await refusedWith('a1f3', 'STEP_UP_NO_AUTH_TIME');
    // honoured prompt=login: an hour-old session at the provider is asked again
    mock.setMockIdentity('a1f3', { authAgeSeconds: 3600 });
    const step = await ssoStepUp(c, 'a1f3');
    await c('POST', '/auth/step-up/sso/complete', { ticket: step.ticket });
    await c('POST', '/me/tokens', { name: 'x', scope: 'read' });
  });

  it('a stale sign-in through the provider does not confirm the new session', async () => {
    mock.setMockIdentity('a1f3', { authAgeSeconds: 3600 });
    const c = await ssoClient('a1f3'); // silent single sign-on: the provider reuses its hour-old session
    expect((await c('GET', '/auth/step-up')).until).toBeNull();
    expect(await refusal(c('POST', '/me/tokens', { name: 'x', scope: 'read' }))).toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('requires multi-factor authentication when the provider says so (amr, acr_values, Entra authentication context)', async () => {
    const original = await provider();
    try {
      await configure({ stepUpMfa: true });
      const c = await ssoClient('a1f3');
      await c('DELETE', '/auth/step-up');
      expect((await refusal(c('POST', '/me/tokens', { name: 'x', scope: 'read' }))).body.stepUp).toMatchObject({ mfa: true });
      // amr without "mfa": refused
      const plain = await ssoStepUp(c, 'a1f3');
      expect(plain.ticket).toBeUndefined();
      expect((await c('GET', '/auth/step-up')).failure).toMatchObject({ code: 'STEP_UP_MFA_REQUIRED' });
      // amr with "mfa": accepted as sso+mfa
      mock.setMockIdentity('a1f3', { mfa: 'always' });
      const strong = await ssoStepUp(c, 'a1f3');
      expect(await c('POST', '/auth/step-up/sso/complete', { ticket: strong.ticket })).toMatchObject({ confirmedWith: 'sso+mfa' });
      expect(await lastAudit('auth.step_up')).toMatchObject({ details: { method: 'sso+mfa' } });

      // acr_values: the ID token's acr must be one of them
      await configure({ stepUpMfa: true, stepUpAcrValues: 'gold' });
      mock.resetMockIdentities();
      await c('DELETE', '/auth/step-up');
      const gold = await ssoStepUp(c, 'a1f3');
      expect(gold.asked.acr_values).toBe('gold');
      await c('POST', '/auth/step-up/sso/complete', { ticket: gold.ticket });
      mock.setMockIdentity('a1f3', { mfa: 'never' });
      await c('DELETE', '/auth/step-up');
      expect((await ssoStepUp(c, 'a1f3')).ticket).toBeUndefined();

      // Entra ID: a Conditional Access authentication context, asked for with the claims parameter, in acrs
      await configure({ stepUpMfa: true, stepUpAcrValues: '', stepUpAuthContext: 'c1' });
      mock.resetMockIdentities();
      const ctx = await ssoStepUp(c, 'a1f3');
      expect(JSON.parse(ctx.asked.claims!)).toEqual({ id_token: { acrs: { essential: true, value: 'c1' } } });
      await c('POST', '/auth/step-up/sso/complete', { ticket: ctx.ticket });
      mock.setMockIdentity('a1f3', { mfa: 'never' });
      await c('DELETE', '/auth/step-up');
      expect((await ssoStepUp(c, 'a1f3')).ticket).toBeUndefined();
      expect((await c('GET', '/auth/step-up')).failure).toMatchObject({ code: 'STEP_UP_MFA_REQUIRED' });
    } finally {
      await configure({ ...original, stepUpMfa: false, stepUpAcrValues: '', stepUpAuthContext: '' });
    }
  });

  it('returns to app paths only, under the base path, after a confirmation in the same window', async () => {
    const c = await ssoClient('a1f3');
    const step = await ssoStepUp(c, 'a1f3', { popup: false, returnTo: '//evil.example/x' });
    expect(step.html).toContain('location.replace("/")');
    const ok = await ssoStepUp(c, 'a1f3', { popup: false, returnTo: '/settings?tab=sso' });
    expect(ok.html).toContain('location.replace("/settings?tab=sso")');
    const api = await ssoStepUp(c, 'a1f3', { popup: false, returnTo: '/api/me/tokens' });
    expect(api.html).toContain('location.replace("/")');
  });

  it('cannot use a provider that is gone', async () => {
    const c = await ssoClient('a1f3');
    await c('DELETE', '/auth/step-up');
    const original = await provider();
    await s.api('PUT', `/sso/providers/${providerId}`, { ...original, enabled: false });
    try {
      const r = await refusal(c('POST', '/me/tokens', { name: 'x', scope: 'read' }));
      expect(r.body.stepUp).toMatchObject({ method: 'none' });
      expect(await refusal(c('POST', '/auth/step-up/sso', {}))).toMatchObject({ code: 'STEP_UP_SSO_UNAVAILABLE' });
    } finally {
      await s.api('PUT', `/sso/providers/${providerId}`, { ...original, enabled: true });
    }
  });
});
