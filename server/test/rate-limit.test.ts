import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { authHeaders, loginCookie, setup, startTestServer, ADMIN, type TestServer } from './helpers.js';

/**
 * General request rate limits (server/src/rateLimits.ts). The server trusts X-Forwarded-For from
 * loopback here, so every test can act from its own client address.
 */
let s: TestServer;
let cookies: Record<'admin' | 'vera' | 'dana', string>;
let ipCounter = 0;
/** A client address no other test used. */
const freshIp = () => `198.51.100.${++ipCounter}`;

interface Res {
  status: number;
  headers: Headers;
  body: any;
}
async function call(method: string, url: string, opts: { ip?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Res> {
  const res = await fetch(s.base + url, {
    method,
    headers: {
      'x-sm-client': '1',
      ...(opts.ip ? { 'x-forwarded-for': opts.ip } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, body };
}
const statuses = async (n: number, fn: () => Promise<Res>): Promise<number[]> => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await fn()).status);
  return out;
};
const limit = (v: string | undefined) => (v === undefined ? delete process.env.SM_RATE_LIMIT_PER_MINUTE : (process.env.SM_RATE_LIMIT_PER_MINUTE = v));
const fakeCookie = () => ({ cookie: `sm_session=${randomBytes(24).toString('base64url')}`, 'x-sm-session': randomBytes(16).toString('hex') });

beforeAll(async () => {
  process.env.SM_TRUST_PROXY = 'loopback';
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/users', { username: 'vera', roles: ['viewer'], password: 'Vera-password-123' });
  await s.api('POST', '/users', { username: 'dana', roles: ['designer'], password: 'Dana-password-123' });
  cookies = {
    admin: await loginCookie(s.base, ADMIN.username, ADMIN.password),
    vera: await loginCookie(s.base, 'vera', 'Vera-password-123'),
    dana: await loginCookie(s.base, 'dana', 'Dana-password-123'),
  };
});
afterAll(async () => {
  delete process.env.SM_TRUST_PROXY;
  await s?.app.close();
});
afterEach(() => {
  limit(undefined);
  vi.restoreAllMocks();
});

describe('general rate limit', () => {
  it('limits anonymous requests per client address, with Retry-After and RateLimit headers', async () => {
    limit('5');
    const ip = freshIp();
    const first = await call('GET', '/api/auth/status', { ip });
    expect(first.status).toBe(200);
    expect(first.headers.get('ratelimit-limit')).toBe('5');
    expect(first.headers.get('ratelimit-remaining')).toBe('4');
    expect(Number(first.headers.get('ratelimit-reset'))).toBeGreaterThan(0);
    expect(await statuses(4, () => call('GET', '/api/auth/status', { ip }))).toEqual([200, 200, 200, 200]);
    const r = await call('GET', '/api/auth/status', { ip });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(Number(r.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    expect(r.headers.get('ratelimit-remaining')).toBe('0');
    // the usual error format, with a code the web app translates
    expect(r.body).toMatchObject({ code: 'RATE_LIMITED', params: { context: 'wait' } });
    expect(r.body.params.seconds).toBeGreaterThanOrEqual(1);
    expect(r.body.error).toMatch(/^Too many requests/);
    // another address has its own bucket
    expect((await call('GET', '/api/auth/status', { ip: freshIp() })).status).toBe(200);
  });

  it('counts signed-in users per user, not per address', async () => {
    limit('5');
    const ip = freshIp();
    const vera = await statuses(6, () => call('GET', '/api/auth/me', { ip, headers: authHeaders(cookies.vera) }));
    expect(vera).toEqual([200, 200, 200, 200, 200, 429]);
    // same address, other user – and anonymous requests from it – are not affected
    expect((await call('GET', '/api/auth/me', { ip, headers: authHeaders(cookies.dana) })).status).toBe(200);
    expect((await call('GET', '/api/auth/status', { ip })).status).toBe(200);
    // vera stays limited from another address too
    expect((await call('GET', '/api/auth/me', { ip: freshIp(), headers: authHeaders(cookies.vera) })).status).toBe(429);
  });

  it('gives made-up session cookies and tokens no bucket of their own', async () => {
    limit('5');
    // public route: an unknown cookie counts as the address
    const ip1 = freshIp();
    expect(await statuses(6, () => call('GET', '/api/auth/status', { ip: ip1, headers: fakeCookie() }))).toEqual([200, 200, 200, 200, 200, 429]);
    // protected route: refused sign-ins (401) count against the address as well
    const ip2 = freshIp();
    expect(await statuses(6, () => call('GET', '/api/processes', { ip: ip2, headers: fakeCookie() }))).toEqual([401, 401, 401, 401, 401, 429]);
    const ip3 = freshIp();
    const bearer = () => ({ authorization: `Bearer smt_${randomBytes(24).toString('hex')}` });
    expect(await statuses(6, () => call('GET', '/api/processes', { ip: ip3, headers: bearer() }))).toEqual([401, 401, 401, 401, 401, 429]);
    // a cookie that is real but lacks its session key is no way around it either
    const ip4 = freshIp();
    const noKey = { cookie: cookies.dana };
    expect(await statuses(6, () => call('GET', '/api/processes', { ip: ip4, headers: noKey }))).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it('turns off with SM_RATE_LIMIT_PER_MINUTE=0', async () => {
    limit('0');
    const ip = freshIp();
    const r = await call('GET', '/api/auth/status', { ip });
    expect(r.headers.get('ratelimit-limit')).toBeNull();
    expect(await statuses(20, () => call('GET', '/api/auth/status', { ip }))).toEqual(Array(20).fill(200));
    expect(await statuses(12, () => call('GET', '/api/processes', { ip, headers: fakeCookie() }))).toEqual(Array(12).fill(401));
    limit('off');
    expect((await call('GET', '/api/auth/status', { ip })).status).toBe(200);
  });

  it('does not count health and readiness probes', async () => {
    limit('2');
    const ip = freshIp();
    expect(await statuses(5, () => call('GET', '/api/health', { ip }))).toEqual(Array(5).fill(200));
    const ready = await call('GET', '/api/ready', { ip });
    expect(ready.status).not.toBe(429);
    expect(ready.headers.get('ratelimit-limit')).toBeNull();
  });

  it('logs a limited key once per window, without secrets', async () => {
    const { logger } = await import('../src/log.js');
    const warn = vi.spyOn(logger, 'warn');
    limit('1');
    const ip = freshIp();
    const headers = fakeCookie();
    expect(await statuses(5, () => call('GET', '/api/auth/status', { ip, headers }))).toEqual([200, 429, 429, 429, 429]);
    const lines = warn.mock.calls.filter((c) => c[1] === 'rate limit reached');
    expect(lines).toHaveLength(1);
    expect(lines[0]![0]).toMatchObject({ key: `ip:${ip}`, limit: 'general', method: 'GET', route: '/api/auth/status' });
    expect(JSON.stringify(lines[0])).not.toContain(headers.cookie.split('=')[1]);
    // the access log does not warn about each refused request
    expect(warn.mock.calls.filter((c) => c[1] === 'request rejected')).toHaveLength(0);
  });
});

describe('per-route limits', () => {
  it('gives expensive routes a lower limit of their own', async () => {
    const ip = freshIp();
    const headers = authHeaders(cookies.admin);
    const verify = await statuses(31, () => call('GET', '/api/audit/verify', { ip, headers }));
    expect(verify.slice(0, 30)).toEqual(Array(30).fill(200));
    expect(verify[30]).toBe(429);
    const r = await call('GET', '/api/audit/verify', { ip, headers });
    expect(r.headers.get('ratelimit-limit')).toBe('30');
    expect(r.body.code).toBe('RATE_LIMITED');
    // the general bucket of the user is separate
    expect((await call('GET', '/api/auth/me', { ip, headers })).status).toBe(200);
    // ... and the per-route limits turn off with the general one
    limit('0');
    expect((await call('GET', '/api/audit/verify', { ip, headers })).status).toBe(200);
  });

  it('limits password changes tightly', async () => {
    const headers = authHeaders(cookies.dana);
    // a too short new password: refused by the policy, before any wrong-password lockout
    const r = await statuses(11, () => call('POST', '/api/auth/password', { headers, body: { current: 'Dana-password-123', next: 'x' } }));
    expect(r.slice(0, 10).every((x) => x !== 429)).toBe(true);
    expect(r[10]).toBe(429);
  });

  it('gives the web UI files and start-up reads a bucket per address of ten times the general limit', async () => {
    limit('1');
    const ip = freshIp();
    let i = 0;
    // the manifest and the theme share the bucket
    const r = await statuses(11, () => call('GET', i++ % 2 ? '/manifest.webmanifest' : '/api/theme', { ip }));
    expect(r.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(r[10]).toBe(429);
    const other = freshIp();
    expect(await statuses(10, () => call('GET', '/api/theme', { ip: other }))).toEqual(Array(10).fill(200));
    // the API bucket of the address is a different one
    expect((await call('GET', '/api/auth/status', { ip: other })).status).toBe(200);
    expect((await call('GET', '/api/auth/status', { ip: other })).status).toBe(429);
  });

  it('gives inbound webhooks a bucket per address of ten times the general limit', async () => {
    limit('1');
    const ip = freshIp();
    const hook = () => call('POST', '/api/hooks/no-such-trigger', { ip, body: {} });
    const r = await statuses(11, hook);
    expect(r.slice(0, 10).every((x) => x !== 429)).toBe(true);
    expect(r[10]).toBe(429);
  });
});

describe('public API v1', () => {
  it('keeps its own per-token limiter and is not counted twice', async () => {
    const { token } = await s.api('POST', '/me/tokens', { name: 'limits', scope: 'read' });
    limit('2');
    const ip = freshIp();
    const v1 = await statuses(5, () => call('GET', '/api/v1/me', { ip, headers: { authorization: `Bearer ${token}` } }));
    expect(v1).toEqual(Array(5).fill(200));
    const r = await call('GET', '/api/v1/me', { ip, headers: { authorization: `Bearer ${token}` } });
    // SM_API_RATE_LIMIT's default, not the general limit of 2
    expect(r.headers.get('ratelimit-limit')).toBe('600');
  });
});
