import { getEventListeners } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Platform } from '@sm/shared';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Server review 0.27.0: regression tests of the fixes in the process engine, the scheduler, platform calls, monitors,
 * maintenance windows and datasets. Each test failed before its fix.
 */

let s: TestServer;
beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  // fires and runs start only where a test starts them
  (await import('../src/scheduler.js')).stopScheduler();
});

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
  let issued = 0;
  /** Tokens the API accepts (a revoked one is taken out) */
  const accepted = new Set<string>();
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0]!;
      calls[path] = (calls[path] ?? 0) + 1;
      if (path === '/oauth/token') {
        // a slow identity provider: requests that need a token at the same time must share one sign-in
        const token = `token-${++issued}`;
        setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: token, expires_in: 1800 })), 80);
        return;
      }
      if (path === '/data') {
        const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        if (!accepted.has(token)) return void res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"invalid_token"}');
        // a little later, so that the refused requests overlap
        setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token })), 20);
        return;
      }
      if (path === '/huge') {
        // announces 100 MB: never read without a limit of the caller's
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(100 * 1024 * 1024) });
        res.write('[');
        return;
      }
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

  const oauth = () =>
    platform({
      auth: { type: 'oauth2_client_credentials', tokenUrl: `http://127.0.0.1:${port}/oauth/token`, clientAuth: 'body' },
      http: { proxy: 'none', retry: { maxRetries: 0 } },
    } as Partial<Platform['config']>);
  const secrets = { clientId: 'invented-client', clientSecret: 'invented-client-secret' };

  it('signs in once for requests that need a token at the same time', async () => {
    const { platformRequest } = await import('../src/platforms/http.js');
    const p = oauth();
    issued = 0;
    accepted.clear();
    accepted.add('token-1');
    const answers = await Promise.all(Array.from({ length: 6 }, () => platformRequest(p, secrets, { method: 'GET', url: '/data' })));
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(issued).toBe(1);
    // a request that stops waiting does not fail the sign-in of the others
    const { renewToken } = await import('../src/platforms/http.js');
    accepted.add('token-2');
    const ctl = new AbortController();
    const [cancelled, renewed] = await Promise.allSettled([renewToken(p, secrets, ctl.signal), (ctl.abort(), platformRequest(p, secrets, { method: 'GET', url: '/data' }))]);
    expect(cancelled.status).toBe('rejected');
    expect(renewed).toMatchObject({ status: 'fulfilled', value: { status: 200, body: { token: 'token-2' } } });
    expect(issued).toBe(2);
  });

  it('a refused token is replaced once for all requests it was refused for, and every one of them gets through', async () => {
    const { platformRequest } = await import('../src/platforms/http.js');
    const p = oauth();
    issued = 0;
    accepted.clear();
    accepted.add('token-1');
    expect((await platformRequest(p, secrets, { method: 'GET', url: '/data' })).status).toBe(200);
    // the platform revokes the token before it expires: every request with it is refused
    accepted.clear();
    accepted.add('token-2');
    const answers = await Promise.all(Array.from({ length: 6 }, () => platformRequest(p, secrets, { method: 'GET', url: '/data' })));
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(answers.map((a) => (a.body as { token: string }).token)).toEqual(Array(6).fill('token-2'));
    expect(issued).toBe(2);
  });

  it('retries a GET whose connection dropped while the body was read', async () => {
    const { platformRequest } = await import('../src/platforms/http.js');
    calls = {};
    const r = await platformRequest(platform(), {}, { method: 'GET', url: '/dropped' });
    expect(r).toMatchObject({ status: 200, body: { ok: true, path: '/dropped' }, attempts: 2 });
    expect(calls['/dropped']).toBe(2);
  });

  it('reads at most the default ceiling of an answer when the caller sets no limit', async () => {
    const { platformRequest, DEFAULT_MAX_RESPONSE_BYTES } = await import('../src/platforms/http.js');
    const err = await platformRequest(platform({ http: { proxy: 'none', retry: { maxRetries: 0 } } } as Partial<Platform['config']>), {}, { method: 'GET', url: '/huge' }).then(
      () => null,
      (e: Error & { code?: string }) => e,
    );
    expect(err).toMatchObject({ code: 'ETOOLARGE', retryable: false, max: DEFAULT_MAX_RESPONSE_BYTES });
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

describe('schedules', () => {
  it('two fires at the same moment start one run of a schedule that does not allow overlapping runs', async () => {
    await s.api('POST', '/processes', {
      definition: { name: 'Overlap target', steps: [{ id: 'ok', type: 'userTask', mode: 'approve', title: 'Approve the overlap test', x: 1, y: 0 }] },
    });
    const sch = await s.api<{ id: string }>('POST', '/schedules', { name: 'No overlap', processId: 'overlap-target', cron: '0 3 * * *', enabled: false });
    // a cron fire and the catch-up run at start (both as the owner) at the same moment
    const { fire } = await import('../src/scheduler.js');
    const started = await Promise.all([fire(sch.id), fire(sch.id, false, { catchUp: true })]);
    expect(started.filter(Boolean)).toHaveLength(1);
    const { db } = await import('../src/db.js');
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE schedule_id = ?', sch.id)!.n).toBe(1);
    expect(db().get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'schedule.skipped' AND entity_id = ?", sch.id)!.n).toBe(1);
  });
});

describe('monitors', () => {
  it('the scheduler tick reads maintenance windows in one statement, not one per monitor', async () => {
    const { tick, loadAll } = await import('../src/monitors/engine.js');
    const { requestDbStats } = await import('../src/database/timing.js');
    const statementsOfTick = () => {
      const stats = { statements: 0, ms: 0 };
      requestDbStats.run(stats, () => tick());
      return stats.statements;
    };
    const create = async (n: number) => {
      for (let i = 0; i < n; i++) await s.api('POST', '/monitors', { definition: { name: `Invented tick monitor ${Math.random()}`, checks: [] } });
      loadAll();
    };
    await create(2);
    tick();
    const few = statementsOfTick();
    await create(10);
    tick();
    expect(statementsOfTick()).toBe(few);
  });
});

describe('datasets', () => {
  it("a weekday schedule's Friday data is not stale over the weekend; a regular schedule keeps 2.5 × its interval", async () => {
    const { freshnessOf } = await import('../src/dashboards/datasets.js');
    const part = (updated: string) => ({ schedule_id: 'sch_x', stale_after_minutes: null, stale_fixed: 0, expected_minutes: null, updated_at: updated });
    const facts = (cron: string, minutes: number) => ({ name: 'x', processId: 'p', processName: 'p', minutes, nextRunAt: null, cron, timezone: 'UTC' });
    // read on a weekend: the next two runs are Monday's and Tuesday's, one day apart
    const weekdays = freshnessOf(part('2026-11-13T06:05:00.000Z'), facts('0 6 * * 1-5', 1440));
    // stale once Monday's and Tuesday's runs are missed (Tuesday 18:00), not on Sunday evening
    expect(Date.parse('2026-11-13T06:05:00.000Z') + weekdays.staleAfterMinutes * 60000).toBe(Date.parse('2026-11-17T18:00:00.000Z'));
    expect(weekdays).toMatchObject({ staleReason: 'schedule', expectedMinutes: 1440 });
    // hourly: 2.5 hours as before
    expect(freshnessOf(part('2026-11-13T10:00:30.000Z'), facts('0 * * * *', 60))).toMatchObject({ staleAfterMinutes: 150, staleReason: 'schedule' });
    // the schedule is gone: the stored interval
    expect(freshnessOf({ ...part('2026-11-13T06:05:00.000Z'), expected_minutes: 1440 }, null)).toMatchObject({ staleAfterMinutes: 3600 });
  });
});

describe('process engine', () => {
  it('a loop over sub-process runs leaves no listeners behind on the run', async () => {
    // every AbortSignal that gets an abort listener during the run, and how many it still holds at the end
    const signals = new Set<EventTarget>();
    const add = EventTarget.prototype.addEventListener;
    const spy = vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (this: EventTarget, ...args) {
      if (this instanceof AbortSignal && args[0] === 'abort') signals.add(this);
      return add.apply(this, args);
    });
    try {
      await s.api('POST', '/processes', { definition: { name: 'Leak child', steps: [{ id: 'note', type: 'log', message: 'child' }] } });
      const parent = await s.api<{ id: string }>('POST', '/processes', {
        definition: {
          name: 'Leak parent',
          inputs: [{ name: 'items', type: 'list' }],
          steps: [{ id: 'loop', type: 'forEach', items: 'inputs.items', as: 'it', steps: [{ id: 'child', type: 'subprocess', process: 'leak-child' }] }],
        },
      });
      const run = await s.api<{ id: string }>('POST', '/runs', { processId: parent.id, inputs: { items: Array.from({ length: 15 }, (_, i) => `i${i}`) } });
      expect((await s.waitRun(run.id, ['succeeded', 'failed'])).status).toBe('succeeded');
    } finally {
      spy.mockRestore();
    }
    const most = Math.max(0, ...[...signals].map((x) => getEventListeners(x, 'abort').length));
    expect(most).toBeLessThan(5);
  });
});
