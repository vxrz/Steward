import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, loginCookie, setup, startTestServer, type TestServer } from './helpers.js';

// Regression tests for the holistic security review of October 2026 (docs/REVIEW-2026-10.md).
const PW = 'Demo-password-1';
let s: TestServer;
let vera: (method: string, url: string, body?: unknown) => Promise<Response>;
let audrey: typeof vera;
let olivia: typeof vera;
let restricted = '';
let specId = '';

const client = (cookie: string) => (method: string, url: string, body?: unknown) =>
  fetch(`${s.base}/api${url}`, {
    method,
    headers: { 'x-sm-client': '1', ...authHeaders(cookie), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  vera = client(await loginCookie(s.base, 'vera', PW));
  audrey = client(await loginCookie(s.base, 'audrey', PW));
  olivia = client(await loginCookie(s.base, 'olivia', PW));
  // a platform only administrators may see, with an API specification
  const p = (await s.api<{ id: string; kind: string }[]>('GET', '/platforms')).find((x) => x.kind === 'gatus')!;
  restricted = p.id;
  await s.api('PUT', `/platforms/${restricted}/access`, { acl: [{ subject: 'user:dana', permissions: ['use'] }] });
  specId = (await s.api<{ id: string }[]>('GET', `/platforms/${restricted}/specs`))[0]!.id;
});
afterAll(async () => s?.app.close());

describe('platform API specifications', () => {
  it('are hidden like the platform itself', async () => {
    expect((await olivia('GET', `/platforms/${restricted}`)).status).toBe(404);
    for (const url of [`/platforms/${restricted}/specs`, `/platforms/${restricted}/operations`, `/specs/${specId}/content`]) {
      expect((await olivia('GET', url)).status, url).toBe(404);
      expect((await vera('GET', url)).status, url).toBe(404);
    }
    expect((await s.api('GET', `/platforms/${restricted}/operations`)).length).toBeGreaterThan(0);
    expect(await s.api('GET', `/specs/${specId}/content`)).toBeTruthy();
    expect((await vera('GET', '/specs/sp_unknown/content')).status).toBe(404);
  });
});

describe('API tokens', () => {
  it('cannot manage users, teams, sign-in or the vault (no lasting access from a leaked token)', async () => {
    const token = (await s.api('POST', '/me/tokens', { name: 'automation', scope: 'full' })).token as string;
    const call = (method: string, url: string, body?: unknown) =>
      fetch(`${s.base}/api${url}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
    const users = await s.api<{ id: string; username: string }[]>('GET', '/users');
    const dana = users.find((u) => u.username === 'dana')!;
    const created = await call('POST', '/users', { username: 'mallory', roles: ['admin'], password: 'Mallory-password-1' });
    expect(created.status).toBe(403);
    expect((await created.json()).code).toBe('SESSION_REQUIRED');
    expect((await call('POST', `/users/${dana.id}/reset-password`)).status).toBe(403);
    expect((await call('PUT', `/users/${dana.id}`, { roles: ['admin'] })).status).toBe(403);
    expect((await call('PUT', '/settings', { outboundPolicy: 'open' })).status).toBe(403);
    expect((await call('POST', '/vault/passphrase', { current: 'correct horse battery', next: 'another long passphrase' })).status).toBe(403);
    expect((await s.api<{ username: string }[]>('GET', '/users')).some((u) => u.username === 'mallory')).toBe(false);
    // ordinary automation keeps working
    expect((await fetch(`${s.base}/api/users`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });
});

describe('webhook mapping preview', () => {
  it('is for people who may set up triggers, and bounded', async () => {
    const body = { inputMapping: { a: 'body.x' }, payload: { x: 1 } };
    expect((await vera('POST', '/triggers/preview-mapping', body)).status).toBe(403);
    expect((await audrey('POST', '/triggers/preview-mapping', body)).status).toBe(403);
    const ok = await olivia('POST', '/triggers/preview-mapping', body);
    expect(ok.status).toBe(200);
    expect((await ok.json()).inputs).toEqual({ a: 1 });
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`in${i}`, 'body.x']));
    expect((await olivia('POST', '/triggers/preview-mapping', { inputMapping: many, payload: {} })).status).toBe(400);
  });
});

describe('query strings', () => {
  it('are validated (no database errors, no unbounded lists)', async () => {
    const ds = (await s.api<{ key: string }[]>('GET', '/datasets'))[0]!.key;
    const mon = (await s.api<{ id: string }[]>('GET', '/monitors'))[0]!.id;
    for (const url of [
      '/runs?limit=abc',
      '/runs?limit=-1',
      '/runs?status=a&status=b',
      '/audit?limit=abc',
      '/audit?runId=a&runId=b',
      `/datasets/${ds}/metrics?days=abc`,
      `/datasets/${ds}/metrics?names=a&names=b`,
      `/monitors/${mon}/history?limit=abc`,
      `/monitors/${mon}/checks/x/results?limit=abc`,
      '/tasks?status=a&status=b',
      '/bundle/export?processes=a&processes=b',
      '/processes/ih-health-check/scope?runId=a&runId=b',
      '/processes/ih-health-check?version=abc',
      '/notifications?limit=0',
    ]) {
      const res = await fetch(`${s.base}/api${url}`, { headers: { 'x-sm-client': '1', ...authHeaders(await adminCookie()) } });
      expect(res.status, url).toBe(400);
    }
  });

  it('never answers with raw database errors', async () => {
    const { isDatabaseError } = await import('../src/app.js');
    const { db } = await import('../src/db.js');
    let err: unknown;
    try {
      db().all('SELECT * FROM no_such_table');
    } catch (e) {
      err = e;
    }
    expect(isDatabaseError(err)).toBe(true);
    expect(isDatabaseError(new Error('Login request failed with HTTP 401'))).toBe(false);
  });
});

let admin = '';
const adminCookie = async () => (admin ||= await loginCookie(s.base, 'admin', 'Admin-password-1'));

describe('password change', () => {
  it('limits guessing the current password with a session', async () => {
    const adam = client(await loginCookie(s.base, 'adam', PW));
    for (let i = 0; i < 5; i++) expect((await adam('POST', '/auth/password', { current: `wrong-${i}`, next: 'New-password-123' })).status).toBe(400);
    const blocked = await adam('POST', '/auth/password', { current: PW, next: 'New-password-123' });
    expect(blocked.status).toBe(429);
    const audit = await s.api<{ action: string }[]>('GET', '/audit?action=user.password_change_failed');
    expect(audit.length).toBe(5);
  });
});

describe('single sign-on start', () => {
  it('keeps the sign-ins in progress bounded', async () => {
    const { pendingSignIns, MAX_PENDING_SIGN_INS } = await import('../src/auth/sso.js');
    const st = await (await fetch(`${s.base}/api/auth/status`)).json();
    const id = st.ssoProviders[0].id as string;
    const before = pendingSignIns();
    const res = await fetch(`${s.base}/api/auth/oidc/${id}/start?returnTo=/${'a'.repeat(2000)}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(pendingSignIns()).toBe(before + 1);
    expect(MAX_PENDING_SIGN_INS).toBeLessThanOrEqual(10000);
  });
});

describe('security headers', () => {
  it('are on every kind of response: JSON, errors, downloads, HTML, the public API and webhooks', async () => {
    const cookie = await adminCookie();
    const h = { 'x-sm-client': '1', ...authHeaders(cookie) };
    const responses = await Promise.all([
      fetch(`${s.base}/api/runs?limit=1`, { headers: h }),
      fetch(`${s.base}/api/runs?limit=abc`, { headers: h }),
      fetch(`${s.base}/api/no-such-route`, { headers: h }),
      fetch(`${s.base}/api/processes`),
      fetch(`${s.base}/api/audit/export?format=csv`, { headers: h }),
      fetch(`${s.base}/`),
      fetch(`${s.base}/api/v1/runs`),
      fetch(`${s.base}/api/hooks/wht_unknown`, { method: 'POST', body: '{}' }),
      fetch(`${s.base}/api/health`),
    ]);
    for (const r of responses) {
      const where = `${r.url} → ${r.status}`;
      expect(r.headers.get('x-content-type-options'), where).toBe('nosniff');
      expect(r.headers.get('x-frame-options'), where).toBe('DENY');
      expect(r.headers.get('content-security-policy'), where).toContain("frame-ancestors 'none'");
      expect(r.headers.get('referrer-policy'), where).toBe('no-referrer');
      expect(r.headers.get('access-control-allow-origin'), where).toBeNull();
      await r.arrayBuffer();
    }
  });
});

describe('startup warnings', () => {
  it('name insecure deployment settings', async () => {
    const { securityWarnings } = await import('../src/config.js');
    const safe = { host: '127.0.0.1', demo: false, secureCookies: false };
    expect(securityWarnings({}, safe, false)).toEqual([]);
    expect(securityWarnings({ SM_ALLOWED_HOSTS: 'steward.example.com' }, safe, false).join()).toMatch(/without HTTPS/);
    expect(securityWarnings({ SM_ALLOWED_HOSTS: 'steward.example.com' }, { ...safe, secureCookies: true }, false)).toEqual([]);
    expect(securityWarnings({}, { ...safe, host: '0.0.0.0', demo: true }, false).join()).toMatch(/Demo mode/);
    expect(securityWarnings({}, safe, true).join()).toMatch(/SM_MASTER_PASSPHRASE_FILE/);
    expect(securityWarnings({ SM_METRICS_PUBLIC: '1' }, safe, false).join()).toMatch(/metrics/);
  });
});
