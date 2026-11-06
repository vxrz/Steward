import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { selfSignedCertificate } from '../../e2e/support/selfsigned.js';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * The outbound policy on every redirect hop (0.9.0, #243): a redirect target goes through the same rules as the first
 * request. Same-origin redirects, http → https on the same host, the platform's own origins (base URL, trusted
 * origins) and allowed hosts pass; any other host fails with a message that names it and how to allow it, before
 * anything is sent there. Ad-hoc requests, connection tests, process http steps, monitor checks (http and platform),
 * a built-in reader (endoflife.date), the OpenAPI import by URL and monitor webhooks; the MCP gateway returns a
 * redirect instead of following it.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

type Name = 'base' | 'allowed' | 'outside' | 'trusted' | 'dual';
let s: TestServer;
const servers: net.Server[] = [];
const origin: Record<Name, string> = { base: '', allowed: '', outside: '', trusted: '', dual: '' };
let hits: Record<Name, number> = { base: 0, allowed: 0, outside: 0, trusted: 0, dual: 0 };
const outsideBodies: string[] = [];
/** "<server> <path>" → [status, location]; a location starting with a server name is made absolute. */
const redirects = new Map<string, [number, string]>();
let line = ''; // a platform on the base server
let trusting = ''; // the same, with the trusted server among its trusted origins

function handler(name: Name, scheme = 'http') {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    hits[name]++;
    const path = (req.url ?? '/').split('?')[0]!;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (name === 'outside') outsideBodies.push(body);
      const r = redirects.get(`${name} ${path}`);
      if (r) {
        res.writeHead(r[0], { location: r[1] });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, server: name, scheme, path, ts: new Date().toISOString() }));
    });
  };
}

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

const BLOCKED = (to: string) =>
  new RegExp(
    `Blocked by the outbound policy: http://127\\.0\\.0\\.1:\\d+ redirected to ${to.replace(/[.]/g, '\\.')}, which is not a configured platform or on the allow-list`,
  );
const preview = (check: Record<string, unknown>) => s.api('POST', '/monitors/check-preview', { check: { id: 'c', name: 'C', ...check } });
const request = (platformId: string, path: string, method = 'GET', body?: unknown) =>
  s.api('POST', `/platforms/${platformId}/request`, { method, path, ...(body ? { body } : {}) });
async function withSettings(change: Record<string, unknown>, fn: () => Promise<void>): Promise<void> {
  const before = await s.api('GET', '/settings');
  await s.api('PUT', '/settings', change);
  try {
    await fn();
  } finally {
    await s.api('PUT', '/settings', { outboundPolicy: before.outboundPolicy, outboundAllowList: before.outboundAllowList ?? [] });
  }
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  for (const name of ['base', 'allowed', 'outside', 'trusted'] as const) {
    origin[name] = `http://127.0.0.1:${await listen(http.createServer(handler(name)))}`;
  }
  // one port that speaks http and https (the first byte of a TLS handshake is 0x16): http → https on the same host
  const cert = selfSignedCertificate({ commonName: '127.0.0.1', notAfter: new Date(Date.now() + 86400000) });
  const plain = http.createServer(handler('dual', 'http'));
  const tls = https.createServer({ cert: cert.pem, key: cert.privateKeyPem }, handler('dual', 'https'));
  const dual = net.createServer((socket) => {
    socket.once('readable', () => {
      const first = socket.read(1) as Buffer | null;
      if (!first) return socket.destroy();
      socket.unshift(first);
      (first[0] === 0x16 ? tls : plain).emit('connection', socket);
    });
  });
  origin.dual = `http://127.0.0.1:${await listen(dual)}`;

  const http0 = { proxy: 'none', retry: { maxRetries: 0 } };
  line = (
    await s.api('POST', '/platforms', {
      name: 'Line API',
      kind: 'generic',
      baseUrl: `${origin.base}/api`,
      config: { auth: { type: 'bearer' }, variables: {}, http: http0 },
      secrets: { token: 'line-secret-token-0123456789' },
    })
  ).id;
  trusting = (
    await s.api('POST', '/platforms', {
      name: 'Line API (trusting)',
      kind: 'generic',
      baseUrl: `${origin.base}/api`,
      config: { auth: { type: 'none' }, variables: {}, http: { ...http0, trustedOrigins: [origin.trusted] } },
    })
  ).id;
  await s.api('PUT', '/settings', { outboundAllowList: [origin.allowed] });

  redirects.set('base /api/same', [302, '/api/ok']);
  redirects.set('base /api/to-allowed', [302, `${origin.allowed}/ok`]);
  redirects.set('base /api/to-outside', [302, `${origin.outside}/data`]);
  redirects.set('base /api/to-outside-307', [307, `${origin.outside}/data`]);
  redirects.set('base /api/via-allowed', [302, `${origin.allowed}/to-outside`]);
  redirects.set('allowed /to-outside', [302, `${origin.outside}/data`]);
  redirects.set('allowed /to-outside-307', [307, `${origin.outside}/data`]);
  redirects.set('allowed /same', [301, '/ok']);
  redirects.set('base /api/to-private', [302, 'http://10.0.0.7:8080/admin']);
  redirects.set('base /api/to-metadata', [302, 'http://169.254.169.254/latest/meta-data/']);
  redirects.set('base /api/to-trusted', [302, `${origin.trusted}/sign-in`]);
  redirects.set('base /api/to-dual', [302, `${origin.dual}/start`]);
  redirects.set('dual /start', [301, `${origin.dual.replace('http:', 'https:')}/secure`]);
  redirects.set('base /eol/api/v1/products/nodejs', [302, `${origin.outside}/api/v1/products/nodejs`]);
});
afterAll(async () => {
  for (const x of servers) x.close();
  await s?.app.close();
});
beforeEach(() => {
  hits = { base: 0, allowed: 0, outside: 0, trusted: 0, dual: 0 };
  outsideBodies.length = 0;
});

describe('the outbound policy on every redirect hop', () => {
  it('a redirect on the same origin, to an allowed host and http → https on the same host pass', async () => {
    expect(await request(line, '/same')).toMatchObject({ status: 200, body: { server: 'base', path: '/api/ok' } });
    expect(await request(line, '/to-allowed')).toMatchObject({ status: 200, body: { server: 'allowed', path: '/ok' } });
    // the dual server is no platform and not on the allow-list: https://127.0.0.1:<its port> only passes as the upgrade of
    // the http URL the request was just sent to
    const insecure = await s.api('POST', '/platforms', {
      name: 'Dual',
      kind: 'generic',
      baseUrl: origin.dual,
      config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none', insecureTls: true, retry: { maxRetries: 0 } } },
    });
    expect(await request(insecure.id, '/start')).toMatchObject({ status: 200, body: { server: 'dual', scheme: 'https', path: '/secure' } });
    expect(hits.dual).toBe(2);
    // without that platform, its origin is just another host
    await s.api('DELETE', `/platforms/${insecure.id}`);
    await expect(request(line, '/to-dual')).rejects.toThrow(/Blocked by the outbound policy/);
    expect(hits.dual).toBe(2);
  });

  it('a redirect to a host outside the policy fails before anything is sent there, with the host and what to do', async () => {
    const e = await request(line, '/to-outside').catch((x) => x);
    expect(e.status).toBe(403);
    expect(e.body.error).toMatch(BLOCKED(origin.outside));
    expect(e.body.error).toMatch(/Settings → Outbound access \(outboundAllowList\)/);
    expect(e.body.error).toMatch(/trusted origins of platform "Line API"/);
    expect(e.body).toMatchObject({ code: 'PLATFORM_REDIRECT_BLOCKED', params: { to: origin.outside, platform: 'Line API' } });
    // a 307 would send the body on: refused all the same
    await expect(request(line, '/to-outside-307', 'POST', { secret: 'x' })).rejects.toThrow(BLOCKED(origin.outside));
    // the second hop of a chain is checked too
    await expect(request(line, '/via-allowed')).rejects.toThrow(/redirected to http:\/\/127\.0\.0\.1:\d+, which is not/);
    expect(hits.outside).toBe(0);
    expect(hits.base).toBe(3);
    expect(hits.allowed).toBe(1);
    // the platform's own retries do not repeat a refused hop
    const retrying = await s.api('POST', '/platforms', {
      name: 'Line API (retries)',
      kind: 'generic',
      baseUrl: `${origin.base}/api`,
      config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none', retry: { maxRetries: 3, baseDelayMs: 1 } } },
    });
    await expect(request(retrying.id, '/to-outside')).rejects.toThrow(/Blocked by the outbound policy/);
    expect(hits.base).toBe(4);
  });

  it('works once the target is allowed', async () => {
    await withSettings({ outboundAllowList: [origin.allowed, origin.outside] }, async () => {
      expect(await request(line, '/to-outside')).toMatchObject({ status: 200, body: { server: 'outside' } });
    });
    expect(hits.outside).toBe(1);
  });

  it('cloud-metadata addresses stay refused on every hop', async () => {
    await expect(request(line, '/to-metadata')).rejects.toThrow(/Blocked: request to a link-local \/ cloud metadata address/);
    await withSettings({ outboundPolicy: 'open' }, async () => {
      await expect(request(line, '/to-metadata')).rejects.toThrow(/link-local \/ cloud metadata address/);
    });
  });

  it('allow-list policy: a private address is refused, the platform’s trusted origins and the allow-list pass', async () => {
    await withSettings({ outboundPolicy: 'allowList', outboundAllowList: [origin.base, origin.allowed] }, async () => {
      const e = await request(line, '/to-private').catch((x) => x);
      expect(e.status).toBe(403);
      expect(e.body.error).toMatch(/redirected to http:\/\/10\.0\.0\.7:8080, which is not a configured platform or on the allow-list/);
      // another platform's trusted origin is not this platform's own origin, and not on the list
      await expect(request(line, '/to-trusted')).rejects.toThrow(BLOCKED(origin.trusted));
      expect(hits.trusted).toBe(0);
      // the trusting platform's own origin: allowed exactly as for its first request
      expect(await request(trusting, '/to-trusted')).toMatchObject({ status: 200, body: { server: 'trusted', path: '/sign-in' } });
      expect(await request(line, '/to-allowed')).toMatchObject({ status: 200, body: { server: 'allowed' } });
      expect(await request(line, '/same')).toMatchObject({ status: 200 });
    });
    expect(hits.trusted).toBe(1);
  });

  it('a connection test fails with the message', async () => {
    const p = await s.api('POST', '/platforms', {
      name: 'Line API (test path redirects)',
      kind: 'generic',
      baseUrl: `${origin.base}/api`,
      config: { auth: { type: 'none' }, variables: {}, testPath: '/to-outside', http: { proxy: 'none', retry: { maxRetries: 0 } } },
    });
    const t = await s.api('POST', `/platforms/${p.id}/test`, {});
    expect(t.ok).toBe(false);
    expect(t.message).toMatch(BLOCKED(origin.outside));
    expect(hits.outside).toBe(0);
  });

  it('a process http step fails with the message; a same-origin redirect works', async () => {
    const run = async (path: string) => {
      const proc = await s.api('POST', '/processes', {
        definition: {
          name: `Redirect ${path}`,
          connections: [{ slot: 'api' }],
          inputs: [],
          nodes: [
            { id: 'start', type: 'start', x: 0, y: 0 },
            { id: 'call', type: 'http', connection: 'api', method: 'GET', path, saveAs: 'res', x: 0, y: 0 },
          ],
          wires: [{ from: 'start', port: 'out', to: 'call' }],
        },
      });
      const { id } = await s.api('POST', '/runs', { processId: proc.id, bindings: { api: line }, inputs: {} });
      return s.waitRun(id, ['succeeded', 'failed', 'cancelled']);
    };
    const failed = await run('/to-outside');
    expect(failed.status).toBe('failed');
    expect(JSON.stringify(failed)).toMatch(BLOCKED(origin.outside));
    expect(hits.outside).toBe(0);
    expect((await run('/same')).status).toBe('succeeded');
  });

  it('monitor checks: an http check and a platform check', async () => {
    const h = await preview({ type: 'http', url: `${origin.base}/api/to-outside` });
    expect(h.status).toBe('unknown');
    expect(h.message).toMatch(/^Target not allowed: /);
    expect(h.message).toMatch(BLOCKED(origin.outside));
    expect(await preview({ type: 'http', url: `${origin.base}/api/to-allowed` })).toMatchObject({ status: 'up' });
    expect(await preview({ type: 'http', url: `${origin.allowed}/same` })).toMatchObject({ status: 'up' });
    const p = await preview({ type: 'platform', platform: line, path: '/to-outside' });
    expect(p.status).toBe('down');
    expect(p.message).toMatch(BLOCKED(origin.outside));
    const f = await preview({
      type: 'freshness',
      source: 'platform',
      platform: line,
      path: '/to-outside',
      timestamp: 'ts',
      mode: 'maxAge',
      maxAgeSeconds: 600,
    });
    expect(f.status).toBe('unknown');
    expect(f.message).toMatch(BLOCKED(origin.outside));
    expect(await preview({ type: 'platform', platform: line, path: '/same' })).toMatchObject({ status: 'up' });
    expect(hits.outside).toBe(0);
  });

  it('the MCP gateway returns a redirect instead of following it', async () => {
    await s.api('PUT', '/mcp-server', { enabled: true });
    await s.api('PUT', `/platforms/${line}/mcp-gateway`, { enabled: true, allowedPathPrefixes: ['/to-outside'] });
    const token = (await s.api('POST', '/me/tokens', { name: 'redirect test', scope: 'mcp' })).token;
    const MODERN = '2026-07-28';
    const res = await fetch(`${s.base}/api/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'mcp-protocol-version': MODERN,
        'mcp-method': 'tools/call',
        'mcp-name': 'platform_call_operation',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'platform_call_operation',
          arguments: { platformId: line, path: '/to-outside' },
          _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} },
        },
      }),
    });
    const out = (await res.json()) as { result: { isError?: boolean; structuredContent: { status: number; headers: Record<string, string> } } };
    expect(out.result.isError).toBeFalsy();
    expect(out.result.structuredContent.status).toBe(302);
    expect(hits.base).toBe(1);
    expect(hits.outside).toBe(0);
  });

  it('a built-in reader (endoflife.date) records the refused redirect for the product', async () => {
    await s.api('POST', '/platforms', {
      name: 'endoflife.date (local)',
      kind: 'endoflife-date',
      baseUrl: `${origin.base}/eol`,
      config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none', retry: { maxRetries: 0 } } },
    });
    await s.api('POST', '/systems', { name: 'node01', kind: 'server', stack: [{ product: 'nodejs', version: '24.11.0' }] });
    const st = await s.api('POST', '/catalogue/lifecycle/refresh');
    expect(st.errors).toEqual([{ product: 'nodejs', error: expect.stringMatching(BLOCKED(origin.outside)) }]);
    expect(hits.base).toBe(1);
    expect(hits.outside).toBe(0);
  });

  it('the OpenAPI import by URL and a monitor webhook (one URL without a platform) check every hop too', async () => {
    const e = await s.api('POST', `/platforms/${line}/specs`, { url: `${origin.allowed}/to-outside` }).catch((x) => x);
    expect(e.status).toBe(403);
    expect(e.body).toMatchObject({ code: 'OUTBOUND_REDIRECT_BLOCKED', params: { to: origin.outside } });
    expect(e.body.error).toMatch(/An administrator can allow it under Settings → Outbound access \(outboundAllowList\)\.$/);
    // the webhook outputs' and the OpenAPI import's fetch
    const { fetchCheckingRedirects } = await import('../src/platforms/outbound.js');
    const { outboundContext } = await import('../src/platforms/policyContext.js');
    const post = (path: string) =>
      fetchCheckingRedirects(
        `${origin.allowed}${path}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"event":1}' },
        outboundContext(),
      );
    await expect(post('/to-outside-307')).rejects.toThrow(/redirected to http:\/\/127\.0\.0\.1:\d+, which is not/);
    const ok = await post('/same');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ server: 'allowed', path: '/ok' });
    expect(hits.outside).toBe(0);
    expect(outsideBodies).toEqual([]);
  });

  it('the rule itself: what counts as staying where the request went', async () => {
    const { assertRedirectAllowed } = await import('../src/platforms/outbound.js');
    const { outboundContext } = await import('../src/platforms/policyContext.js');
    const ctx = outboundContext();
    const ok = (to: string, sent: string[], opts = {}) => expect(assertRedirectAllowed(to, sent, ctx, opts)).resolves.toBeUndefined();
    const no = (to: string, sent: string[], opts = {}) => expect(assertRedirectAllowed(to, sent, ctx, opts)).rejects.toMatchObject({ statusCode: 403 });
    await ok('http://198.51.100.7/b', ['http://198.51.100.7/a']);
    await ok('https://198.51.100.7/b', ['http://198.51.100.7/a']);
    await ok('https://198.51.100.7:8443/b', ['http://198.51.100.7:8443/a']);
    await ok('https://198.51.100.7/b', ['http://198.51.100.7:8080/a']);
    await no('https://198.51.100.7:9443/b', ['http://198.51.100.7:8080/a']);
    await no('http://198.51.100.7/b', ['https://198.51.100.7/a']); // a downgrade is another origin
    await no('http://198.51.100.8/b', ['http://198.51.100.7/a']);
    await ok('http://198.51.100.8/b', ['http://198.51.100.7/a'], { own: true });
    await ok('http://198.51.100.8/b', ['http://198.51.100.7/a'], { platformOrigins: ['http://198.51.100.8'] });
    // address safety is never skipped, also on the same origin (Steward's own API is a path)
    await expect(assertRedirectAllowed(`${s.base}/api/settings`, [`${s.base}/mock/x`], ctx, { own: true })).rejects.toThrow(/may not call the Steward server/);
  });
});
