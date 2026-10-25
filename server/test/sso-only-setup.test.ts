import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * SM_PASSWORD_LOGIN=none on a new installation: the first administrator sets it up with a password, and single
 * sign-on only takes effect once an administrator signed in with single sign-on – then for good.
 */
let s: TestServer;

beforeAll(async () => {
  process.env.SM_PASSWORD_LOGIN = 'none';
  s = await startTestServer();
});
afterAll(async () => {
  delete process.env.SM_PASSWORD_LOGIN;
  await s?.app.close();
});

async function ssoClient(provider: string, login: string): Promise<Client> {
  const start = await fetch(`${s.base}/api/auth/oidc/${provider}/start`, { redirect: 'manual' });
  const authorize = new URL(start.headers.get('location')!);
  authorize.pathname += '/approve';
  authorize.searchParams.set('login', login);
  const approve = await fetch(authorize, { redirect: 'manual' });
  const res = await fetch(new URL(approve.headers.get('location')!), { redirect: 'manual' });
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const key = /localStorage\.setItem\("sm\.sessionKey","([^"]+)"\)/.exec(await res.text())![1]!;
  return (async (method: string, url: string, body?: unknown) => {
    const r = await fetch(s.base + '/api' + url, {
      method,
      headers: { 'x-sm-client': '1', cookie, 'x-sm-session': key, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw Object.assign(new Error(`${method} ${url} → ${r.status}: ${text}`), { status: r.status });
    return text ? JSON.parse(text) : null;
  }) as Client;
}

describe('SM_PASSWORD_LOGIN=none on a new installation', () => {
  let provider = '';

  it('lets the first administrator set it up and keep working with the setup session', async () => {
    await setup(s);
    expect((await s.api('GET', '/auth/me')).user.username).toBe('admin');
    const settings = await s.api('GET', '/settings');
    expect(settings.passwordLogin).toBe('adminsOnly');
    expect(settings.passwordLoginPending).toBe('none');
    expect(settings.passwordLoginFromEnv).toBe(true);
    expect((await s.api('GET', '/system/status')).security.passwordLoginPending).toBe('none');
    // configuring single sign-on works from the password session, also saving the settings page as shown
    await s.api('POST', '/demo/setup', {});
    provider = (await s.api('GET', '/sso/providers'))[0].id;
    await s.api('PUT', '/settings', { passwordLogin: 'adminsOnly', browserTimeoutMs: 31000 });
    expect((await s.api('GET', '/auth/me')).user.username).toBe('admin');
  });

  it('takes effect at the first single sign-on of an administrator, audited, and ends the password session', async () => {
    const max = await ssoClient(provider, 'a1f3'); // Max Admin
    expect((await max('GET', '/auth/me')).user.roles).toContain('admin');
    const settings = await max('GET', '/settings');
    expect(settings.passwordLogin).toBe('none');
    expect(settings.passwordLoginPending).toBeUndefined();
    await expect(s.api('GET', '/auth/me')).rejects.toMatchObject({ status: 401 });
    const login = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'x-sm-client': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Admin-password-1' }),
    });
    expect(login.status).toBe(401);
    const [entry] = await max('GET', '/audit?action=settings.password_login_effective&limit=1');
    expect(entry.summary).toContain('SM_PASSWORD_LOGIN=none');
    // for good: disabling the provider does not bring passwords back
    const { db } = await import('../src/db.js');
    db().run('UPDATE identity_providers SET enabled = 0');
    const { passwordLoginMode } = await import('../src/settings.js');
    expect(passwordLoginMode()).toBe('none');
    db().run('UPDATE identity_providers SET enabled = 1');
  });
});
