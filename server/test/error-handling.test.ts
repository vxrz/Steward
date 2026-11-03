import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Error answers and request ids (0.3.1): an unexpected error never shows its message to the caller (OWASP ASVS
 * V7.4.1) – only a request id, which every response carries in X-Request-Id; deliberate errors keep their message;
 * the public readiness probe names no database detail.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let s: TestServer;
let origin: string;

beforeAll(async () => {
  const { HttpError } = await import('../src/util.js');
  s = await startTestServer({
    routes: (app) => {
      // test-only routes outside /api (no sign-in needed); the app's error handler applies
      app.get('/__test/boom', async () => {
        const upstream: { body?: { items: unknown[] } } = {};
        try {
          return upstream.body!.items;
        } catch (e) {
          throw new TypeError(`${(e as Error).message} – while reading https://hub.internal.example.com/api/v3/users?token=abc`);
        }
      });
      app.get('/__test/upstream', async () => {
        throw new HttpError(502, 'The platform answered 502 Bad Gateway', 'UPSTREAM_FAILED');
      });
    },
  });
  await setup(s);
  origin = new URL(s.base).origin;
});
afterAll(async () => {
  vi.restoreAllMocks();
  await s?.app.close();
});

describe('unexpected errors', () => {
  it('answer with a generic message and the request id, not the error text', async () => {
    const res = await fetch(`${origin}/__test/boom`);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('hub.internal.example.com');
    expect(text).not.toContain('Cannot read');
    const body = JSON.parse(text);
    const id = res.headers.get('x-request-id')!;
    expect(id).toMatch(UUID);
    expect(body).toEqual({ error: `Internal error (request id ${id})`, code: 'INTERNAL_ERROR', params: { requestId: id } });
  });

  it('deliberate errors and validation keep their message', async () => {
    const res = await fetch(`${origin}/__test/upstream`);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'The platform answered 502 Bad Gateway', code: 'UPSTREAM_FAILED' });
    await expect(s.api('POST', '/cron/preview', { cron: 'not a cron' })).rejects.toMatchObject({
      status: 400,
      body: { error: expect.stringContaining('Invalid cron expression') },
    });
    await expect(s.api('POST', '/cron/preview', { cron: 5 })).rejects.toMatchObject({ status: 400, body: { code: 'INVALID_INPUT' } });
  });
});

describe('request ids', () => {
  it('are UUIDs, returned on every response, and differ per request', async () => {
    const a = await fetch(`${s.base}/api/ready`);
    const b = await fetch(`${s.base}/api/runs`); // not signed in
    const c = await fetch(`${origin}/__test/no-such-route`);
    expect(b.status).toBe(401);
    expect(c.status).toBe(404);
    const ids = [a, b, c].map((r) => r.headers.get('x-request-id'));
    for (const id of ids) expect(id).toMatch(UUID);
    expect(new Set(ids).size).toBe(3);
  });

  it("honour the caller's X-Request-Id when it is short and plain, else replace it", async () => {
    const own = await fetch(`${s.base}/api/ready`, { headers: { 'x-request-id': 'lb-7f3a.42:1_x' } });
    expect(own.headers.get('x-request-id')).toBe('lb-7f3a.42:1_x');
    for (const bad of ['a'.repeat(65), 'has space', 'semi;colon', '<script>', 'ünïcode'])
      expect((await fetch(`${s.base}/api/ready`, { headers: { 'x-request-id': bad } })).headers.get('x-request-id'), bad).toMatch(UUID);
  });
});

describe('readiness', () => {
  it('names no database detail publicly; administrators see it on the system status', async () => {
    const { db } = await import('../src/db.js');
    const d = db();
    const get = d.get.bind(d);
    vi.spyOn(d, 'get').mockImplementation(((sql: string, ...args: unknown[]) => {
      if (sql === 'SELECT 1') throw new Error('SQLITE_CANTOPEN: unable to open database file /srv/secret-volume/steward.db');
      return get(sql, ...(args as []));
    }) as typeof d.get);
    try {
      const res = await fetch(`${s.base}/api/ready`);
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).not.toContain('secret-volume');
      expect(JSON.parse(text).checks.database).toEqual({ ok: false, message: 'Database not available' });
      const status = await s.api('GET', '/system/status');
      expect(JSON.stringify(status)).toContain('secret-volume');
    } finally {
      vi.restoreAllMocks();
    }
    expect((await fetch(`${s.base}/api/ready`)).status).toBe(200);
  });
});
