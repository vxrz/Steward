import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Platform } from '@sm/shared';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Server review 0.27.0: regression tests of the fixes in the process engine, the scheduler, platform calls, monitors,
 * maintenance windows and datasets. Each test failed before its fix.
 */

describe('maintenance windows', () => {
  it('a monthly window started years ago keeps all its occurrences (the skip-ahead estimate never passes them)', async () => {
    const { occurrencesBetween } = await import('../../shared/src/maintenance.js');
    const monthly = { startsAt: '2020-01-15T02:00:00Z', endsAt: '2020-01-15T04:00:00Z', recurrence: { freq: 'monthly' as const, interval: 1 }, timeZone: 'UTC' };
    const starts = (from: string, to: string, w = monthly) => occurrencesBetween(w, Date.parse(from), Date.parse(to)).map((o) => new Date(o.start).toISOString());
    expect(starts('2026-03-01T00:00:00Z', '2026-06-01T00:00:00Z')).toEqual(['2026-03-15T02:00:00.000Z', '2026-04-15T02:00:00.000Z', '2026-05-15T02:00:00.000Z']);
    // the occurrence going on is found from inside it (what "in maintenance now" asks)
    expect(starts('2026-03-15T03:00:00Z', '2026-03-15T03:00:01Z')).toEqual(['2026-03-15T02:00:00.000Z']);
    // every third month, the 31st (the last day of shorter months), in a zone with daylight saving time
    const quarterly = {
      startsAt: '2019-01-31T21:00:00Z',
      endsAt: '2019-01-31T23:00:00Z',
      recurrence: { freq: 'monthly' as const, interval: 3 },
      timeZone: 'Europe/Berlin',
    };
    expect(starts('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', quarterly)).toEqual([
      '2026-01-31T21:00:00.000Z',
      '2026-04-30T20:00:00.000Z',
      '2026-07-31T20:00:00.000Z',
      '2026-10-31T21:00:00.000Z',
    ]);
  });
});

describe('platform calls', () => {
  let server: http.Server;
  let port = 0;
  let calls: Record<string, number> = {};
  let s: TestServer;
  beforeAll(async () => {
    s = await startTestServer();
    await setup(s);
    server = http.createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0]!;
      calls[path] = (calls[path] ?? 0) + 1;
      if (path === '/dropped' && calls[path] === 1) {
        // the headers arrive, then the connection drops in the middle of the body
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
        res.write('{"items": [');
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, path }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  });

  const platform = (config: Partial<Platform['config']> = {}, base = `http://127.0.0.1:${port}`): Platform =>
    ({
      id: `p_${Math.random().toString(36).slice(2)}`,
      name: 'Invented platform',
      kind: 'generic',
      description: '',
      baseUrl: base,
      environment: '',
      config: { auth: { type: 'none' }, http: { proxy: 'none', retry: { baseDelayMs: 10, maxDelayMs: 20 } }, ...config },
      secretKeys: [],
      acl: [],
      permissions: ['use'],
      createdAt: '',
      updatedAt: '',
    }) as unknown as Platform;

  it('retries a GET whose connection dropped while the body was read', async () => {
    const { platformRequest } = await import('../src/platforms/http.js');
    calls = {};
    const r = await platformRequest(platform(), {}, { method: 'GET', url: '/dropped' });
    expect(r).toMatchObject({ status: 200, body: { ok: true, path: '/dropped' }, attempts: 2 });
    expect(calls['/dropped']).toBe(2);
  });

  it('never names the query of a failed call in its error – an API key in the query stays out of logs and monitor results', async () => {
    const { platformRequest } = await import('../src/platforms/http.js');
    // a port nobody listens on: the connection is refused
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const p = platform(
      { auth: { type: 'apiKey', apiKeyIn: 'query', apiKeyName: 'api_key' }, http: { proxy: 'none', retry: { maxRetries: 0 } } } as Partial<Platform['config']>,
      `http://127.0.0.1:${closedPort}`,
    );
    const err = await platformRequest(p, { apiKey: 'invented-query-key-123' }, { method: 'GET', url: '/items', query: { page: 2 } }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(new RegExp(`^GET http://127\\.0\\.0\\.1:${closedPort}/items failed`));
    expect(err?.message).not.toContain('invented-query-key-123');
    expect(err?.message).not.toContain('page=2');
  });
});
