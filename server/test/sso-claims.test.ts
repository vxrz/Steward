import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Who may claim an account at its first single sign-on: accounts without a password belong to one provider, a local
 * administrator is never taken over by a name, an account linked to one identity is not handed to another, and a user
 * name that comes from the e-mail claim needs a confirmed address.
 */
let s: TestServer;
let a = ''; // the demo provider ("Microsoft Entra ID (simulated)")
let b = ''; // a second provider at the same (mock) identity provider

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  const [p] = await s.api('GET', '/sso/providers');
  a = p.id;
  const { id: _i, hasClientSecret: _h, createdAt: _c, updatedAt: _u, ...input } = p;
  b = (await s.api('POST', '/sso/providers', { ...input, displayName: 'Second provider', clientSecret: 'demo-oidc-secret' })).id;
});
afterAll(async () => {
  delete process.env.SM_PASSWORD_LOGIN;
  await s?.app.close();
});

async function signIn(provider: string, login: string): Promise<{ client?: Client; error?: string }> {
  const start = await fetch(`${s.base}/api/auth/oidc/${provider}/start`, { redirect: 'manual' });
  const authorize = new URL(start.headers.get('location')!);
  if (!authorize.pathname.endsWith('/authorize')) return { error: decodeURIComponent(authorize.search) };
  authorize.pathname += '/approve';
  authorize.searchParams.set('login', login);
  const approve = await fetch(authorize, { redirect: 'manual' });
  const res = await fetch(new URL(approve.headers.get('location')!), { redirect: 'manual' });
  if (res.status !== 200) return { error: decodeURIComponent(res.headers.get('location') ?? String(res.status)) };
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const key = /localStorage\.setItem\("sm\.sessionKey","([^"]+)"\)/.exec(await res.text())![1]!;
  const client = (async (method: string, url: string, body?: unknown) => {
    const r = await fetch(s.base + '/api' + url, {
      method,
      headers: { 'x-sm-client': '1', cookie, 'x-sm-session': key, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw Object.assign(new Error(`${method} ${url} → ${r.status}: ${text}`), { status: r.status });
    return text ? JSON.parse(text) : null;
  }) as Client;
  return { client };
}

describe('claiming accounts with single sign-on', () => {
  it('never takes over a local administrator account by its name – an administrator binds it first', async () => {
    const { user } = await s.api('POST', '/users', { username: 'max@contoso.example', roles: ['admin'], password: 'Local-admin-pw-123' });
    const refused = await signIn(a, 'a1f3'); // Max Admin
    expect(refused.error).toContain('local administrator account');
    const bound = await s.api('PUT', `/users/${user.id}`, { provider: a });
    expect(bound.authSource).toBe(a);
    const [entry] = await s.api('GET', '/audit?action=user.sso_bound&limit=1');
    expect(entry.summary).toContain('max@contoso.example');
    const ok = await signIn(a, 'a1f3');
    expect((await ok.client!('GET', '/auth/me')).user.id).toBe(user.id);
  });

  it('lets only the chosen provider claim an account without a password', async () => {
    const { user } = await s.api('POST', '/users', { username: 'erik@contoso.example', roles: ['designer'], provider: a });
    expect(user.authSource).toBe(a);
    const other = await signIn(b, 'b2e4');
    expect(other.error).toContain('belongs to another sign-in provider');
    const own = await signIn(a, 'b2e4');
    expect((await own.client!('GET', '/auth/me')).user.id).toBe(user.id);
    const unknown = await s.api('POST', '/users', { username: 'x1', roles: [], provider: 'idp_nope' }).catch((e) => e);
    expect(unknown.message).toContain('SSO_PROVIDER_UNKNOWN');
  });

  it('does not hand a linked account to another identity with the same name', async () => {
    const { db } = await import('../src/db.js');
    const { user } = await s.api('POST', '/users', { username: 'sofia@contoso.example', roles: ['approver'], provider: a });
    db().run('UPDATE users SET external_id = ? WHERE id = ?', `${a}:someone-else`, user.id);
    const r = await signIn(a, 'd4c6'); // Sofia, a different subject than the one the account is linked to
    expect(r.error).toContain('linked to another');
  });

  it('needs a confirmed e-mail address when the user name comes from the e-mail claim', async () => {
    const p = (await s.api('GET', '/sso/providers')).find((x: { id: string }) => x.id === b);
    const { id: _i, hasClientSecret: _h, createdAt: _c, updatedAt: _u, ...input } = p;
    await s.api('PUT', `/sso/providers/${b}`, { ...input, usernameClaim: 'upn' }); // no such claim: the e-mail claim names the account
    const r = await signIn(b, 'c3d5');
    expect(r.error).toContain('email_verified');
  });

  it('ends a password session when password sign-in is turned off, also after the account was linked to single sign-on', async () => {
    await s.api('POST', '/users', { username: 'oskar@contoso.example', roles: ['operator'], password: 'Oskar-local-pw-123' });
    const { db } = await import('../src/db.js');
    db().run("UPDATE users SET must_change_password = 0 WHERE username = 'oskar@contoso.example'");
    const byPassword = await s.as('oskar@contoso.example', 'Oskar-local-pw-123');
    const linked = await signIn(a, 'c3d5'); // links the local account to the provider
    expect((await linked.client!('GET', '/auth/me')).user.authSource).toBe(a);
    process.env.SM_PASSWORD_LOGIN = 'none';
    try {
      await expect(byPassword('GET', '/auth/me')).rejects.toMatchObject({ status: 401 });
      expect((await linked.client!('GET', '/auth/me')).user.username).toBe('oskar@contoso.example');
    } finally {
      delete process.env.SM_PASSWORD_LOGIN;
    }
    // sessions from before the method was recorded count as password sessions
    const old = (await signIn(a, 'c3d5')).client!;
    db().run("UPDATE sessions SET method = NULL WHERE method = 'sso'");
    process.env.SM_PASSWORD_LOGIN = 'none';
    try {
      await expect(old('GET', '/auth/me')).rejects.toMatchObject({ status: 401 });
    } finally {
      delete process.env.SM_PASSWORD_LOGIN;
    }
  });

  it('with password sign-in off and several providers, a new account needs the provider chosen', async () => {
    const max = (await signIn(a, 'a1f3')).client!;
    process.env.SM_PASSWORD_LOGIN = 'none';
    try {
      const e = await max('POST', '/users', { username: 'new@contoso.example', roles: ['viewer'] }).catch((x) => x);
      expect(e.message).toContain('SSO_PROVIDER_CHOICE_REQUIRED');
      const { user } = await max('POST', '/users', { username: 'new@contoso.example', roles: ['viewer'], provider: b });
      expect(user.authSource).toBe(b);
    } finally {
      delete process.env.SM_PASSWORD_LOGIN;
    }
  });
});
