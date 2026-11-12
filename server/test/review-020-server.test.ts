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
