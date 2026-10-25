import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, setup, startTestServer, type Client, type TestServer } from './helpers.js';

// Password sign-in switched off (single sign-on only), and emergency access from the server's command line.
let s: TestServer;
let providerId = '';
/** Max Admin, signed in with single sign-on (mock identity provider) */
let max: Client;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
});
afterAll(async () => {
  delete process.env.SM_PASSWORD_LOGIN;
  await s?.app.close();
});

/** A client signed in through the mock identity provider (browser redirects walked with fetch). */
async function ssoClient(login: string): Promise<Client> {
  const start = await fetch(`${s.base}/api/auth/oidc/${providerId}/start`, { redirect: 'manual' });
  const authorize = new URL(start.headers.get('location')!);
  authorize.pathname = authorize.pathname.replace(/\/authorize$/, '/authorize/approve');
  authorize.searchParams.set('login', login);
  const approve = await fetch(authorize, { redirect: 'manual' });
  const res = await fetch(new URL(approve.headers.get('location')!), { redirect: 'manual' });
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const key = /localStorage\.setItem\("sm\.sessionKey","([^"]+)"\)/.exec(await res.text())![1]!;
  return withSession(cookie, key);
}

function withSession(cookie: string, key: string): Client {
  return (async (method: string, url: string, body?: unknown) => {
    const res = await fetch(s.base + '/api' + url, {
      method,
      headers: { 'x-sm-client': '1', cookie, 'x-sm-session': key, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`${method} ${url} → ${res.status}: ${text}`), { status: res.status, body: text });
    return text ? JSON.parse(text) : null;
  }) as Client;
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(s.base + '/api' + url, { method: 'POST', headers: { 'x-sm-client': '1', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** Signs in with an emergency code; returns a client of that session. */
async function emergencySignIn(code: string): Promise<Client> {
  const res = await post('/auth/emergency', { code });
  if (res.status !== 200) throw Object.assign(new Error(`emergency sign-in → ${res.status}: ${await res.text()}`), { status: res.status });
  return withSession(res.headers.get('set-cookie')!.split(';')[0]!, res.headers.get('x-sm-session-key')!);
}

async function grant(username: string, minutes = 60) {
  const { createGrant, newCode, hashCode } = await import('../src/auth/emergency.js');
  const code = newCode();
  const g = createGrant({ username, minutes, actor: 'cli:test@host', codeHash: hashCode(code), via: 'cli' });
  return { code, ...g };
}

const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return (e as { status: number }).status;
  }
};

describe('password sign-in off (single sign-on only)', () => {
  it('cannot be switched off without an enabled single sign-on provider', async () => {
    const e = await s.api('PUT', '/settings', { passwordLogin: 'none' }).catch((x) => x);
    expect(e.status).toBe(400);
    expect(e.message).toContain('SSO_PROVIDER_REQUIRED');
  });

  it('cannot be switched off by an administrator who signed in with a password', async () => {
    await s.api('POST', '/demo/setup', {}); // "Microsoft Entra ID (simulated)" backed by /mock/oidc, demo users
    providerId = (await s.api('GET', '/auth/status')).ssoProviders[0].id;
    const e = await s.api('PUT', '/settings', { passwordLogin: 'none' }).catch((x) => x);
    expect(e.status).toBe(409);
    expect(e.message).toContain('SSO_ADMIN_REQUIRED');
    expect((await s.api('GET', '/settings')).passwordLogin).toBe('all');
  });

  it('is switched off by an administrator signed in with single sign-on, ends password sessions and is audited', async () => {
    max = await ssoClient('a1f3'); // Max Admin, role claim SM.Admins
    const viewer = await s.as('vera', 'Demo-password-1');
    const r = await max('PUT', '/settings', { passwordLogin: 'none' });
    expect(r.passwordLogin).toBe('none');
    expect((await max('GET', '/auth/status')).passwordLogin).toBe('none');
    // the local administrator's and the viewer's password sessions are over
    expect(await status(s.api('GET', '/runs'))).toBe(401);
    expect(await status(viewer('GET', '/runs'))).toBe(401);
    expect((await max('GET', '/auth/me')).user.username).toBe('max@contoso.example');
    const [entry] = await max('GET', '/audit?action=settings.updated&limit=1');
    expect(entry.summary).toContain('all → none');
    expect(entry.actor).toBe('max@contoso.example');
    const sys = await max('GET', '/system/status');
    expect(sys.security.passwordLogin).toBe('none');
  });

  it('refuses password sign-in with the usual answer, also with the right password', async () => {
    const res = await post('/auth/login', { username: ADMIN.username, password: ADMIN.password });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('WRONG_CREDENTIALS');
  });

  it('refuses new passwords: no password resets, no changes, new accounts without a password', async () => {
    const users = await max('GET', '/users');
    const vera = users.find((u: { username: string }) => u.username === 'vera');
    const reset = await max('POST', `/users/${vera.id}/reset-password`).catch((x) => x);
    expect(reset.status).toBe(409);
    expect(reset.message).toContain('PASSWORD_LOGIN_OFF');
    const withPw = await max('POST', '/users', { username: 'pw-user', roles: ['viewer'], password: 'Some-password-123' }).catch((x) => x);
    expect(withPw.status).toBe(409);
    const created = await max('POST', '/users', { username: 'erik@contoso.example', roles: ['viewer'] });
    expect(created.temporaryPassword).toBeUndefined();
    expect(created.user.mustChangePassword).toBe(false);
  });

  it('keeps single sign-on working (the account created without a password is linked at its first sign-in)', async () => {
    const erik = await ssoClient('b2e4'); // Erik Engineer: the account created above without a password
    const m = await erik('GET', '/auth/me');
    expect(m.user.username).toBe('erik@contoso.example');
    expect(m.user.authSource).toBe(providerId);
    const oskar = await ssoClient('c3d5'); // created on the first sign-in
    expect((await oskar('GET', '/auth/me')).user.username).toBe('oskar@contoso.example');
  });

  it('API tokens keep working (they are not a sign-in)', async () => {
    const { createToken } = await import('../src/auth/tokens.js');
    const { findUserByName } = await import('../src/auth/users.js');
    const t = createToken(findUserByName(ADMIN.username)!.id, { name: 'script', scope: 'read' });
    const res = await fetch(`${s.base}/api/runs?limit=1`, { headers: { authorization: `Bearer ${t.token}` } });
    expect(res.status).toBe(200);
  });

  it('SM_PASSWORD_LOGIN wins over the setting and locks it in the UI', async () => {
    process.env.SM_PASSWORD_LOGIN = 'adminsOnly';
    try {
      const st = await max('GET', '/settings');
      expect(st.passwordLogin).toBe('adminsOnly');
      expect(st.passwordLoginFromEnv).toBe(true);
      const e = await max('PUT', '/settings', { passwordLogin: 'none' }).catch((x) => x);
      expect(e.status).toBe(409);
      expect(e.message).toContain('PASSWORD_LOGIN_FROM_ENV');
      // the administrator can sign in with a password again while the variable says so
      const admin = await s.as(ADMIN.username, ADMIN.password);
      expect((await admin('GET', '/auth/me')).user.username).toBe(ADMIN.username);
    } finally {
      delete process.env.SM_PASSWORD_LOGIN;
    }
    expect((await max('GET', '/settings')).passwordLogin).toBe('none');
  });
});

describe('emergency access', () => {
  it('opens one session once for an administrator, marked and audited, and tells the other administrators', async () => {
    const g = await grant(ADMIN.username, 30);
    expect(Date.parse(g.expiresAt) - Date.now()).toBeGreaterThan(29 * 60_000);
    const c = await emergencySignIn(g.code);
    const m = await c('GET', '/auth/me');
    expect(m.user.username).toBe(ADMIN.username);
    expect(m.emergency.expiresAt).toBeTruthy();
    expect(Date.parse(m.emergency.expiresAt) - Date.now()).toBeLessThanOrEqual(60 * 60_000);
    // works although password sign-in is off; actions are flagged
    await c('PUT', '/settings', { browserTimeoutMs: 31000 });
    const [entry] = await max('GET', '/audit?action=settings.updated&limit=1');
    expect(entry.actor).toBe(ADMIN.username);
    expect(entry.summary).toMatch(/^\[Emergency access\]/);
    expect(entry.details.emergencyAccess).toBe(g.id);
    const actions = (await max('GET', '/audit?q=emergency&limit=20')).map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.emergency_access_granted', 'auth.emergency_sign_in']));
    // the other administrator gets a notification
    const { flushNotifications } = await import('../src/notifications/service.js');
    await flushNotifications();
    const inbox = await max('GET', '/notifications');
    expect(inbox.items.some((n: { event: string; title: string }) => n.event === 'security.emergency' && n.title.includes(ADMIN.username))).toBe(true);
    // no lasting access from an emergency session; no switching to single sign-on only from it
    const tok = await c('POST', '/me/tokens', { name: 'x', scope: 'read' }).catch((x) => x);
    expect(tok.status).toBe(403);
    expect(tok.message).toContain('EMERGENCY_NO_TOKENS');
    // a second use of the same code is refused
    const again = await post('/auth/emergency', { code: g.code });
    expect(again.status).toBe(401);
    expect((await again.json()).code).toBe('EMERGENCY_CODE_INVALID');
  });

  it('flags entries that name the person of the emergency session as the actor explicitly, not those of others', async () => {
    const { runAs } = await import('../src/auth/context.js');
    const { audit } = await import('../src/audit.js');
    const user = {
      id: 'u',
      username: ADMIN.username,
      displayName: 'Admin',
      roles: ['admin' as const],
      teams: [],
      emergency: { grantId: 'eag_x', expiresAt: 'later' },
    };
    const own = runAs(user, () => audit({ action: 'test.explicit', entityType: 'test', actor: ADMIN.username, summary: 'Check run' }));
    const implicit = runAs(user, () => audit({ action: 'test.implicit', entityType: 'test', summary: 'Settings' }));
    const other = runAs(user, () => audit({ action: 'test.system', entityType: 'test', actor: 'system', summary: 'Scheduler' }));
    expect(own.summary).toBe('[Emergency access] Check run');
    expect(own.details).toMatchObject({ emergencyAccess: 'eag_x' });
    expect(implicit.summary).toBe('[Emergency access] Settings');
    expect(other.summary).toBe('Scheduler');
    expect(JSON.stringify(other.details ?? null)).not.toContain('emergencyAccess');
  });

  it('works for single sign-on accounts too', async () => {
    const g = await grant('max@contoso.example');
    const c = await emergencySignIn(g.code);
    expect((await c('GET', '/auth/me')).emergency).toBeTruthy();
  });

  it('ends the session after one hour at the latest', async () => {
    const g = await grant(ADMIN.username);
    const c = await emergencySignIn(g.code);
    const { db } = await import('../src/db.js');
    db().run('UPDATE sessions SET created_at = ? WHERE emergency_grant_id = ?', new Date(Date.now() - 61 * 60_000).toISOString(), g.id);
    expect(await status(c('GET', '/runs'))).toBe(401);
  });

  it('refuses wrong, expired and replaced codes, and accounts that are no administrators', async () => {
    expect((await post('/auth/emergency', { code: 'x'.repeat(43) })).status).toBe(401);
    expect((await post('/auth/emergency', { code: 'short' })).status).toBe(401);
    const old = await grant(ADMIN.username);
    const { db } = await import('../src/db.js');
    db().run('UPDATE emergency_access_grants SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), old.id);
    expect((await post('/auth/emergency', { code: old.code })).status).toBe(401);
    const first = await grant(ADMIN.username);
    await grant(ADMIN.username); // a newer window replaces the older one
    expect((await post('/auth/emergency', { code: first.code })).status).toBe(401);
    await expect(grant('vera')).rejects.toThrow(/not an administrator/);
    await expect(grant('nobody')).rejects.toThrow(/No account/);
    await expect(grant(ADMIN.username, 24 * 60 + 1)).rejects.toThrow(/1 to 1440 minutes/);
    const refused = await max('GET', '/audit?action=auth.emergency_sign_in_failed&limit=10');
    expect(refused.length).toBeGreaterThanOrEqual(3);
  });

  it('accepts a grant signed with the vault key from this machine only, once, fresh and for this instance', async () => {
    const { writeInstanceFile, removeInstanceFile, currentInstanceId } = await import('../src/instance.js');
    const { makeSignedGrant, newCode, hashCode } = await import('../src/auth/emergency.js');
    writeInstanceFile(s.base);
    try {
      const code = newCode();
      const make = (over: Record<string, unknown> = {}) =>
        makeSignedGrant({
          instanceId: currentInstanceId()!,
          username: ADMIN.username,
          minutes: 15,
          codeHash: hashCode(code),
          actor: 'cli:ops@server',
          ...over,
        });
      // through a (local) reverse proxy: refused
      expect((await post('/auth/emergency/grant', make(), { 'x-forwarded-for': '203.0.113.9' })).status).toBe(403);
      // signature that does not match the content
      const forged = make();
      forged.grant.minutes = 1440;
      expect((await post('/auth/emergency/grant', forged)).status).toBe(403);
      // made for another server instance
      expect((await post('/auth/emergency/grant', make({ instanceId: 'other' }))).status).toBe(403);
      const ok = make();
      const res = await post('/auth/emergency/grant', ok);
      expect(res.status, await res.clone().text()).toBe(200);
      expect((await res.json()).minutes).toBe(15);
      // replayed
      expect((await post('/auth/emergency/grant', ok)).status).toBe(403);
      const c = await emergencySignIn(code);
      expect((await c('GET', '/auth/me')).user.username).toBe(ADMIN.username);
      const [granted] = await max('GET', '/audit?action=auth.emergency_access_granted&limit=1');
      expect(granted.actor).toBe('cli:ops@server');
      expect(granted.details.via).toBe('cli-running-server');
    } finally {
      removeInstanceFile();
    }
  });

  it('refuses a stale signed grant', async () => {
    const { writeInstanceFile, removeInstanceFile, currentInstanceId } = await import('../src/instance.js');
    const { signedGrantPayload, hashCode, newCode } = await import('../src/auth/emergency.js');
    const { vault } = await import('../src/vault.js');
    writeInstanceFile(s.base);
    try {
      const grant = {
        v: 1 as const,
        purpose: 'steward-emergency-access-v1' as const,
        instanceId: currentInstanceId()!,
        username: ADMIN.username,
        minutes: 15,
        codeHash: hashCode(newCode()),
        actor: 'cli:ops@server',
        issuedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        nonce: 'a'.repeat(32),
      };
      expect((await post('/auth/emergency/grant', { grant, signature: vault().sign(signedGrantPayload(grant)) })).status).toBe(403);
    } finally {
      removeInstanceFile();
    }
  });

  it('switching back to password sign-in works for an administrator', async () => {
    await max('PUT', '/settings', { passwordLogin: 'all' });
    const admin = await s.as(ADMIN.username, ADMIN.password);
    expect((await admin('GET', '/auth/me')).user.username).toBe(ADMIN.username);
  });
});
