import dns from 'node:dns/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setEnv, setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Server-wide review 0.20.0: the limits that count per client address count an IPv6 client by its /64 network (one
 * subscriber gets a whole /64 and can pick any address in it), and the per-key limiters keep a bounded number of buckets.
 */

let s: TestServer;
const before = { api: process.env.SM_API_RATE_LIMIT, mcp: process.env.SM_MCP_RATE_LIMIT };

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
});
afterAll(async () => {
  await setEnv({ SM_API_RATE_LIMIT: before.api, SM_MCP_RATE_LIMIT: before.mcp });
});

/** An address of the invented documentation network 2001:db8:1:2::/64 (RFC 3849). */
const inNet = (i: number) => `2001:db8:1:2:${(i + 1).toString(16)}::${(i + 7).toString(16)}`;

describe('client addresses', () => {
  it('count an IPv6 address by its /64 network and an IPv4-mapped address as IPv4', async () => {
    const { clientAddress } = await import('../src/rateLimits.js');
    expect(clientAddress(inNet(1))).toBe(clientAddress(inNet(2)));
    expect(clientAddress('2001:db8:1:3::1')).not.toBe(clientAddress(inNet(1)));
    expect(clientAddress('::ffff:192.0.2.10')).toBe('192.0.2.10');
    expect(clientAddress('192.0.2.10')).toBe('192.0.2.10');
    expect(clientAddress(undefined)).toBe('');
  });

  it('share one bucket of the public API for addresses of one /64 without a token', async () => {
    await setEnv({ SM_API_RATE_LIMIT: '5' });
    const { limiter } = await import('../src/api/v1/auth.js');
    limiter.reset();
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await s.app.inject({ method: 'GET', url: '/api/v1/processes', remoteAddress: inNet(i) })).statusCode);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(5)).toEqual([429, 429, 429]);
    // another network has a bucket of its own
    expect((await s.app.inject({ method: 'GET', url: '/api/v1/processes', remoteAddress: '2001:db8:9::1' })).statusCode).toBe(401);
    limiter.reset();
    await setEnv({ SM_API_RATE_LIMIT: before.api });
  });

  it('share one bucket of the MCP endpoint for addresses of one /64 without a token', async () => {
    await setEnv({ SM_MCP_RATE_LIMIT: '3' });
    (await import('../src/settings.js')).writeSetting('mcp.enabled', true);
    const { mcpLimiter } = await import('../src/mcp/http.js');
    mcpLimiter.reset();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++)
      codes.push(
        (
          await s.app.inject({
            method: 'POST',
            url: '/api/mcp',
            remoteAddress: inNet(i),
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
          })
        ).statusCode,
      );
    expect(codes.slice(3)).toEqual([429, 429]);
    expect(codes.slice(0, 3)).not.toContain(429);
    mcpLimiter.reset();
    await setEnv({ SM_MCP_RATE_LIMIT: before.mcp });
  });

  it('count failed sign-ins of one /64 together, whichever address of it they come from', async () => {
    const { login } = await import('../src/auth/users.js');
    // the per-address limit is 50 failures in 15 minutes, across accounts (password spraying)
    for (let i = 0; i < 50; i++)
      await expect(login(`invented-spray-${i}`, 'Wrong-password-1', { ip: inNet(i) })).rejects.toMatchObject({ code: 'WRONG_CREDENTIALS' });
    await expect(login('invented-spray-next', 'Wrong-password-1', { ip: inNet(99) })).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
    // another network is not affected
    await expect(login('invented-spray-next', 'Wrong-password-1', { ip: '2001:db8:7::1' })).rejects.toMatchObject({ code: 'WRONG_CREDENTIALS' });
  }, 120_000);
});

describe('per-key limiters', () => {
  it('keep a bounded number of buckets, dropping idle ones first', async () => {
    const { TokenBucketLimiter } = await import('../src/api/v1/rateLimit.js');
    let t = 1_000_000;
    const l = new TokenBucketLimiter(() => t, 100);
    // a busy key: limited after its 3 requests a minute
    for (let i = 0; i < 3; i++) expect(l.take('busy', 3).allowed).toBe(true);
    expect(l.take('busy', 3).allowed).toBe(false);
    // a flood of new keys (addresses) a second later: the map stays at its bound
    t += 1000;
    for (let i = 0; i < 1000; i++) l.take(`ip:${i}`, 3);
    expect(l.size).toBeLessThanOrEqual(100);
  });
});

describe('indexes of frequent reads', () => {
  /** The plan of a statement on SQLite: no full scan of `table` (PostgreSQL has the same indexes, migration.test.ts). */
  async function scans(sql: string, params: unknown[], table: string): Promise<boolean> {
    const { db } = await import('../src/db.js');
    if (db().dialect !== 'sqlite') return false;
    const plan = db().all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params);
    return plan.some((p) => {
      const [op, name, ...rest] = p.detail.split(' ');
      return op === 'SCAN' && !p.detail.includes(' USING ') && (name === table || rest.join(' ') === `AS ${table}`);
    });
  }

  it("find a user's teams, the day's record changes and the day's AI usage by index", async () => {
    expect(await scans('SELECT t.id, t.name, m.roles FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ?', ['u'], 'm')).toBe(false);
    expect(
      await scans(
        'SELECT r.id FROM record_events e JOIN records r ON r.id = e.record_id WHERE e.to_status IS NOT NULL AND e.created_at >= ? AND e.created_at < ? AND lower(r.owner) = lower(?)',
        ['2026-01-01', '2026-01-02', 'x'],
        'e',
      ),
    ).toBe(false);
    // the budget check of an AI call: the statements it sends, as sent
    const { Db } = await import('../src/db.js');
    const seen: [string, unknown[]][] = [];
    const proto = Db.prototype as unknown as { get: (...a: unknown[]) => unknown };
    const orig = proto.get;
    proto.get = function (this: unknown, ...a: unknown[]) {
      if (typeof a[0] === 'string' && a[0].includes('FROM ai_usage')) seen.push([a[0], a.slice(1)]);
      return orig.apply(this, a);
    };
    try {
      (await import('../src/ai/usage.js')).budgetUse('installation', '');
    } finally {
      proto.get = orig;
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const [sql, params] of seen) expect(await scans(sql, params, 'ai_usage'), sql).toBe(false);
  });
});

describe('outbound calls', () => {
  it('connect the Kafka OAuth token request to the address that was checked (DNS rebinding)', async () => {
    await s.api('PUT', '/settings', { outboundPolicy: 'open' });
    // without a proxy (behind HTTPS_PROXY the proxy resolves names, docs/SECURITY-HARDENING.md)
    const proxies = Object.fromEntries(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].map((k) => [k, process.env[k]]));
    for (const k of Object.keys(proxies)) delete process.env[k];
    // the check sees a harmless address, the connection would see the cloud metadata address
    let calls = 0;
    const spy = vi.spyOn(dns, 'lookup').mockImplementation((async () => {
      calls++;
      return [{ address: calls === 1 ? '203.0.113.7' : '169.254.169.254', family: 4 }];
    }) as never);
    try {
      const { oauthToken } = await import('../src/kafka/client.js');
      const platform = { config: { variables: { tokenUrl: 'https://idp.invented.example/token' } } } as never;
      const err = (await oauthToken(platform, { clientId: 'invented', clientSecret: 'invented-secret' }).catch((e: unknown) => e)) as Error & {
        cause?: { code?: string };
      };
      expect(err).toBeInstanceOf(Error);
      expect(err.cause?.code).toBe('ESSRFBLOCKED');
      expect(calls).toBeGreaterThan(1);
    } finally {
      spy.mockRestore();
      for (const [k, v] of Object.entries(proxies)) if (v !== undefined) process.env[k] = v;
      await s.api('PUT', '/settings', { outboundPolicy: 'platforms' });
    }
  });
});

describe('security headers', () => {
  it('keep other sites from embedding answers (Cross-Origin-Resource-Policy)', async () => {
    for (const url of ['/api/health', '/api/theme', '/api/v1/openapi.json', '/'])
      expect((await s.app.inject({ method: 'GET', url })).headers['cross-origin-resource-policy'], url).toBe('same-origin');
  });
});

describe('downloads', () => {
  it('send a platform document whose name has characters outside Latin-1 (RFC 5987), not 500', async () => {
    const { ADMIN, authHeaders, loginCookie } = await import('./helpers.js');
    const cookie = await loginCookie(s.base, ADMIN.username, ADMIN.password);
    const [p] = (await s.api('GET', '/platforms')) as { id: string }[];
    const form = new FormData();
    form.append('file', new Blob(['Invented notes\n'], { type: 'text/plain' }), 'Prüfbericht – Halle 3 ✓.txt');
    const up = await fetch(`${s.base}/api/platforms/${p!.id}/docs`, { method: 'POST', headers: { 'x-sm-client': '1', ...authHeaders(cookie) }, body: form });
    expect(up.status).toBe(200);
    const doc = (await up.json()) as { id: string };
    const res = await fetch(`${s.base}/api/docs/${doc.id}/file`, { headers: authHeaders(cookie) });
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition')!;
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent('Prüfbericht – Halle 3 ✓.txt')}`);
    expect(cd).toMatch(/^(inline|attachment); filename="Pr_fbericht _ Halle 3 _.txt"/);
  });
});
