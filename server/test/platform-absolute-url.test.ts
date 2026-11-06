import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * An absolute URL in place of a platform path (0.8.0): it still works, but goes through the outbound policy like
 * every other request – the platform's own origins (base URL, trusted origins) or the allow-list. Platform and
 * freshness checks (GET and POST), Check now, test connections, ad-hoc requests and process http steps; a host
 * outside the policy is refused before anything is sent, with what to do.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let base: http.Server;
let outside: http.Server;
let hits = { base: 0, outside: 0 };
let platformId = '';
let outsideUrl = '';
const answer = (which: 'base' | 'outside') => (_req: http.IncomingMessage, res: http.ServerResponse) => {
  hits[which]++;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
};
const port = (x: http.Server) => (x.address() as AddressInfo).port;
const preview = (check: Record<string, unknown>) => s.api('POST', '/monitors/check-preview', { check: { id: 'c', name: 'C', platform: platformId, ...check } });
const BLOCKED = /Blocked by the outbound policy: http:\/\/127\.0\.0\.1:\d+ is not a configured platform or on the allow-list/;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  base = http.createServer(answer('base'));
  outside = http.createServer(answer('outside'));
  await new Promise<void>((r) => base.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => outside.listen(0, '127.0.0.1', r));
  outsideUrl = `http://127.0.0.1:${port(outside)}`;
  const p = await s.api('POST', '/platforms', {
    name: 'Line API',
    kind: 'generic',
    baseUrl: `http://127.0.0.1:${port(base)}/api`,
    config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none', retry: { maxRetries: 0 } } },
  });
  platformId = p.id;
});
afterAll(async () => {
  base?.close();
  outside?.close();
  await s?.app.close();
});
beforeEach(() => {
  hits = { base: 0, outside: 0 };
});

describe('an absolute URL in a platform path', () => {
  it('a platform check: refused for a host outside the policy, nothing is sent; the base URL works as before', async () => {
    const r = await preview({ type: 'platform', path: `${outsideUrl}/status` });
    expect(r).toMatchObject({ status: 'down' });
    expect(r.message).toMatch(BLOCKED);
    expect(r.message).toMatch(/outboundAllowList/);
    expect(hits.outside).toBe(0);
    expect(await preview({ type: 'platform', path: '/status' })).toMatchObject({ status: 'up' });
    // an absolute URL on the base URL's own origin is what a path is
    expect(await preview({ type: 'platform', path: `http://127.0.0.1:${port(base)}/api/status` })).toMatchObject({ status: 'up' });
    expect(hits.base).toBe(2);
  });

  it('a freshness check, also with POST: refused the same way', async () => {
    for (const method of ['GET', 'POST']) {
      const r = await preview({
        type: 'freshness',
        source: 'platform',
        path: `${outsideUrl}/search`,
        method,
        ...(method === 'POST' ? { body: { q: 1 } } : {}),
        timestamp: 'ts',
        mode: 'maxAge',
        maxAgeSeconds: 600,
      });
      expect(r.status, method).toBe('unknown');
      expect(r.message, method).toMatch(BLOCKED);
    }
    expect(hits.outside).toBe(0);
  });

  it('an ad-hoc request and a test connection: refused the same way', async () => {
    await expect(s.api('POST', `/platforms/${platformId}/request`, { method: 'GET', path: `${outsideUrl}/x` })).rejects.toThrow(
      /Blocked by the outbound policy/,
    );
    const other = await s.api('POST', '/platforms', {
      name: 'Line API (test path elsewhere)',
      kind: 'generic',
      baseUrl: `http://127.0.0.1:${port(base)}/api`,
      config: { auth: { type: 'none' }, variables: {}, testPath: `${outsideUrl}/health`, http: { proxy: 'none', retry: { maxRetries: 0 } } },
    });
    const t = await s.api('POST', `/platforms/${other.id}/test`, {});
    expect(t.ok).toBe(false);
    expect(t.message).toMatch(/Blocked by the outbound policy/);
    expect(hits.outside).toBe(0);
  });

  it('a process http step: refused the same way (the step checked it already, before 0.8.0)', async () => {
    const proc = await s.api('POST', '/processes', {
      definition: {
        name: 'Absolute URL',
        connections: [{ slot: 'api' }],
        inputs: [],
        nodes: [
          { id: 'start', type: 'start', x: 0, y: 0 },
          { id: 'call', type: 'http', connection: 'api', method: 'GET', path: `${outsideUrl}/x`, saveAs: 'res', x: 0, y: 0 },
        ],
        wires: [{ from: 'start', port: 'out', to: 'call' }],
      },
    });
    const { id } = await s.api('POST', '/runs', { processId: proc.id, bindings: { api: platformId }, inputs: {} });
    const run = await s.waitRun(id, ['succeeded', 'failed', 'cancelled']);
    expect(run.status).toBe('failed');
    expect(JSON.stringify(run)).toMatch(/Blocked by the outbound policy/);
    expect(hits.outside).toBe(0);
  });

  it('works for a host on the allow-list or among the platform’s trusted origins', async () => {
    const before = await s.api('GET', '/settings');
    await s.api('PUT', '/settings', { outboundAllowList: [outsideUrl] });
    try {
      expect(await preview({ type: 'platform', path: `${outsideUrl}/status` })).toMatchObject({ status: 'up' });
      expect((await s.api('POST', `/platforms/${platformId}/request`, { method: 'GET', path: `${outsideUrl}/x` })).status).toBe(200);
    } finally {
      await s.api('PUT', '/settings', { outboundAllowList: before.outboundAllowList ?? [] });
    }
    const trusted = await s.api('POST', '/platforms', {
      name: 'Line API (trusted)',
      kind: 'generic',
      baseUrl: `http://127.0.0.1:${port(base)}/api`,
      config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none', retry: { maxRetries: 0 }, trustedOrigins: [outsideUrl] } },
    });
    expect(
      await s.api('POST', '/monitors/check-preview', { check: { id: 'c', name: 'C', type: 'platform', platform: trusted.id, path: `${outsideUrl}/s` } }),
    ).toMatchObject({
      status: 'up',
    });
    expect(hits.outside).toBe(3);
  });

  it('with the allow-list policy, a platform check needs its base URL on the list, as other checks do', async () => {
    const before = await s.api('GET', '/settings');
    await s.api('PUT', '/settings', { outboundPolicy: 'allowList', outboundAllowList: [] });
    try {
      const r = await preview({ type: 'platform', path: '/status' });
      expect(r.status).toBe('down');
      expect(r.message).toMatch(/Blocked by the outbound policy/);
      await s.api('PUT', '/settings', { outboundAllowList: [`http://127.0.0.1:${port(base)}`] });
      expect(await preview({ type: 'platform', path: '/status' })).toMatchObject({ status: 'up' });
    } finally {
      await s.api('PUT', '/settings', { outboundPolicy: before.outboundPolicy, outboundAllowList: before.outboundAllowList ?? [] });
    }
  });
});
