import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

// Session cookie and lifetime behind an https:// public URL (OWASP ASVS V3.3, V3.4); see docs/REVIEW-2026-10.md.
let s: TestServer;
beforeAll(async () => {
  process.env.SM_PUBLIC_URL = 'https://steward.example.com';
  process.env.SM_SESSION_MAX_HOURS = '2';
  process.env.SM_SESSION_IDLE_MINUTES = '15';
  s = await startTestServer();
  await setup(s);
});
afterAll(async () => {
  await s?.app.close();
  for (const k of ['SM_PUBLIC_URL', 'SM_SESSION_MAX_HOURS', 'SM_SESSION_IDLE_MINUTES']) delete process.env[k];
});

async function signIn(): Promise<{ cookie: string; key: string; setCookie: string }> {
  const res = await fetch(`${s.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sm-client': '1' },
    body: JSON.stringify({ username: 'admin', password: 'Admin-password-1' }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie')!;
  return { cookie: setCookie.split(';')[0]!, key: res.headers.get('x-sm-session-key')!, setCookie };
}
const me = (c: { cookie: string; key: string }) => fetch(`${s.base}/api/auth/me`, { headers: { cookie: c.cookie, 'x-sm-session': c.key } });

describe('session cookie over HTTPS', () => {
  it('uses the __Host- prefix with Secure, Path=/ and no Domain, and lives as long as the session', async () => {
    const c = await signIn();
    expect(c.setCookie).toMatch(/^__Host-sm_session=/);
    expect(c.setCookie).toContain('; Secure');
    expect(c.setCookie).toContain('Path=/;');
    expect(c.setCookie).not.toMatch(/domain=/i);
    expect(c.setCookie).toContain(`Max-Age=${2 * 3600}`);
    expect((await (await me(c)).json()).user.username).toBe('admin');
    // the old cookie name is not accepted
    expect((await me({ cookie: c.cookie.replace('__Host-', ''), key: c.key })).status).toBe(401);
    const health = await fetch(`${s.base}/api/health`);
    expect(health.headers.get('strict-transport-security')).toContain('max-age=');
  });
});

describe('session lifetime', () => {
  it('ends a session after the idle time and after the maximum lifetime', async () => {
    const { db } = await import('../src/db.js');
    const row = () =>
      db().get<{ id: string; created_at: string; expires_at: string }>('SELECT id, created_at, expires_at FROM sessions ORDER BY created_at DESC LIMIT 1')!;
    const idle = await signIn();
    const r = row();
    const lifetime = Date.parse(r.expires_at) - Date.parse(r.created_at);
    expect(lifetime).toBeGreaterThanOrEqual(15 * 60_000);
    expect(lifetime).toBeLessThan(15 * 60_000 + 5000);
    db().run('UPDATE sessions SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), r.id);
    expect((await me(idle)).status).toBe(401);

    const old = await signIn();
    const r2 = row();
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    // used a minute ago, but signed in more than 2 hours ago
    db().run('UPDATE sessions SET created_at = ?, last_seen_at = ? WHERE id = ?', hoursAgo(2.1), hoursAgo(0.02), r2.id);
    expect((await me(old)).status).toBe(401);
  });

  it('never extends a session past its maximum lifetime', async () => {
    const { db } = await import('../src/db.js');
    const c = await signIn();
    const r = db().get<{ id: string }>('SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1')!;
    const created = new Date(Date.now() - (2 * 3_600_000 - 5 * 60_000)); // 5 minutes left
    db().run('UPDATE sessions SET created_at = ?, last_seen_at = ? WHERE id = ?', created.toISOString(), new Date(Date.now() - 120_000).toISOString(), r.id);
    expect((await (await me(c)).json()).user.username).toBe('admin');
    const after = db().get<{ expires_at: string }>('SELECT expires_at FROM sessions WHERE id = ?', r.id)!;
    expect(Date.parse(after.expires_at)).toBeLessThanOrEqual(created.getTime() + 2 * 3_600_000);
  });
});
