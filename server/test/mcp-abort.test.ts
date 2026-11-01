import http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * MCP: what happens when a tool call does not finish (#23) – the client goes away, the time limit is reached, the
 * platform behind the gateway cannot be reached. Each stops the work, answers (or not) as the protocol wants, and is
 * counted and audited.
 */

const MODERN = '2026-07-28';
let s: TestServer;
let token: string;
let gw: { id: string };
let closedPort: number;

const meta = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} };
const toolCall = (name: string, args: Record<string, unknown>, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args, _meta: meta },
});
const headers = (name: string) => ({
  'content-type': 'application/json',
  accept: 'application/json',
  authorization: `Bearer ${token}`,
  'mcp-protocol-version': MODERN,
  'mcp-method': 'tools/call',
  'mcp-name': name,
});

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('PUT', '/mcp-server', { enabled: true });
  token = (await s.api('POST', '/me/tokens', { name: 'abort test', scope: 'mcp' })).token;
  gw = await s.api('POST', '/platforms', {
    name: 'Slow platform',
    kind: 'generic',
    baseUrl: `${s.base}/mock/test`,
    config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none' } },
  });
  await s.api('PUT', `/platforms/${gw.id}/mcp-gateway`, { enabled: true, allowedPathPrefixes: ['/delay'] });
  // a port nobody listens on
  closedPort = await new Promise<number>((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
});
afterAll(async () => {
  await s?.app.close();
});

describe('MCP tool calls that do not finish', () => {
  it('a client that goes away cancels the call: the platform request is stopped and audited', async () => {
    // a failed platform call is audited as a refused gateway call, outcome "failed"
    const before = await s.api('GET', '/audit?action=mcp.gateway_refused&limit=200');
    await new Promise<void>((resolve) => {
      const u = new URL(`${s.base}/api/mcp`);
      const body = JSON.stringify(toolCall('platform_call_operation', { platformId: gw.id, path: '/delay', query: { ms: 5000 } }));
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: { ...headers('platform_call_operation'), 'content-length': Buffer.byteLength(body) },
      });
      req.on('error', () => resolve());
      req.on('close', () => resolve());
      req.end(body);
      // the platform answers after 5 s; the client leaves after 300 ms
      setTimeout(() => req.destroy(), 300);
    });
    // the gateway notices the abort and records the call as failed, well before the platform would have answered
    let entry: any;
    for (let i = 0; i < 50 && !entry; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const after = await s.api('GET', '/audit?action=mcp.gateway_refused&limit=200');
      entry = after.find((a: any) => a.entityId === gw.id && !before.some((b: any) => b.seq === a.seq));
    }
    expect(entry?.details).toMatchObject({ outcome: 'failed', status: null });
  });

  it('the time limit stops a tool and answers with an error result, counted as a timeout', async () => {
    const { handleMessage } = await import('../src/mcp/server.js');
    const { requestContext } = await import('../src/auth/context.js');
    const users = await import('../src/auth/users.js');
    const admin = users.findUserByName('admin')!;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const out = await requestContext.run({ user: users.toAuthUser(admin), ip: '127.0.0.1' }, () =>
      handleMessage(
        toolCall('platform_call_operation', { platformId: gw.id, path: '/delay', query: { ms: 3000 } }),
        { protocolVersion: MODERN, method: 'tools/call', name: 'platform_call_operation' },
        { principal: { user: admin, tokenId: 'tok_test', tokenName: 'test' }, signal: ac.signal, ip: '127.0.0.1' },
        () => true,
      ),
    );
    expect(out.status).toBe(200);
    const result = (out.body as any).result;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/took longer than 30 s and was stopped/);
  });

  it('an aborted call before it starts is answered at once', async () => {
    const { handleMessage } = await import('../src/mcp/server.js');
    const { requestContext } = await import('../src/auth/context.js');
    const users = await import('../src/auth/users.js');
    const admin = users.findUserByName('admin')!;
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    const out = await requestContext.run({ user: users.toAuthUser(admin), ip: '127.0.0.1' }, () =>
      handleMessage(
        toolCall('get_system_status', {}),
        { protocolVersion: MODERN, method: 'tools/call', name: 'get_system_status' },
        { principal: { user: admin, tokenId: 'tok_test', tokenName: 'test' }, signal: ac.signal, ip: '127.0.0.1' },
      ),
    );
    expect(Date.now() - t0).toBeLessThan(2000);
    expect((out.body as any).result.isError).toBe(true);
  });

  it('a platform that cannot be reached: the tool reports the failure, the gateway audits it', async () => {
    const down = await s.api('POST', '/platforms', {
      name: 'Unreachable platform',
      kind: 'generic',
      baseUrl: `http://127.0.0.1:${closedPort}`,
      config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none' } },
    });
    await s.api('PUT', `/platforms/${down.id}/mcp-gateway`, { enabled: true, allowedPathPrefixes: ['/x'] });
    const res = await fetch(`${s.base}/api/mcp`, {
      method: 'POST',
      headers: headers('platform_call_operation'),
      body: JSON.stringify(toolCall('platform_call_operation', { platformId: down.id, path: '/x' })),
    });
    const body = await res.json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/^The call failed: /);
    const entry = (await s.api('GET', '/audit?action=mcp.gateway_refused&limit=5')).find((a: any) => a.entityId === down.id);
    expect(entry?.details).toMatchObject({ outcome: 'failed', status: null, pathTemplate: '/x' });
    expect(entry.summary).toContain('ECONNREFUSED');
  });
});
