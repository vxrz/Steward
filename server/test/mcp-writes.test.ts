import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * MCP phase 2 (#11): changing gateway calls and runs become requests a person decides in Steward – off by default per
 * platform, the token owner confirms or a second person approves, once, as the token owner, audited, expiring.
 */
let s: TestServer;
const PW = 'Demo-password-1';
let olivia: Client, adam: Client, vera: Client;
const tok: Record<string, string> = {};
const MODERN = '2026-07-28';
const seen: string[] = [];

interface Res {
  status: number;
  headers: Headers;
  body: any;
  text: string;
}

async function post(token: string | null, body: unknown, headers: Record<string, string> = {}, raw?: string): Promise<Res> {
  const res = await fetch(`${s.base}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw ?? JSON.stringify(body),
  });
  const text = await res.text();
  seen.push(text);
  let parsed: any;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, headers: res.headers, body: parsed, text };
}

let nextId = 1;
/** A modern (2026-07-28) request with the required _meta and headers. */
function modern(token: string, method: string, params: Record<string, unknown> = {}, extra: Record<string, string> = {}): Promise<Res> {
  const name = method === 'resources/read' ? params.uri : method === 'tools/call' ? params.name : undefined;
  return post(
    token,
    {
      jsonrpc: '2.0',
      id: nextId++,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
        },
      },
    },
    { 'mcp-protocol-version': MODERN, 'mcp-method': method, ...(typeof name === 'string' ? { 'mcp-name': name } : {}), ...extra },
  );
}

/** tools/call → { isError, data } (data = structuredContent, or the error text). */
async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; data: any; res: Res }> {
  const res = await modern(token, 'tools/call', { name, arguments: args });
  expect(res.status, res.text).toBe(200);
  const r = res.body.result;
  expect(r, res.text).toBeTruthy();
  return { isError: !!r.isError, data: r.isError ? r.content[0].text : r.structuredContent, res };
}

async function toolNames(token: string): Promise<string[]> {
  const r = await modern(token, 'tools/list');
  expect(r.status, r.text).toBe(200);
  return r.body.result.tools.map((t: any) => t.name);
}

async function mcpToken(c: Client, name: string): Promise<string> {
  return (await c('POST', '/me/tokens', { name, scope: 'mcp' })).token;
}

let ih: any;
let proc: string;
const IDM = '/api/identitymanagement/v3';

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [olivia, adam, vera] = await Promise.all(['olivia', 'adam', 'vera'].map((u) => s.as(u, PW)));
  await s.api('PUT', '/mcp-server', { enabled: true });
  tok.olivia = await mcpToken(olivia, 'mcp olivia');
  tok.vera = await mcpToken(vera, 'mcp vera');
  ih = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'insights-hub');
  await s.api('PUT', `/platforms/${ih.id}/mcp-gateway`, { enabled: true });
  proc = (
    await s.api('POST', '/processes', {
      definition: {
        name: 'MCP run request',
        inputs: [{ name: 'note', type: 'string', label: 'Note' }],
        nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }],
        wires: [],
      },
    })
  ).id;
});
afterAll(async () => s?.app.close());

const create = (userName: string, reason = 'Onboard the new colleague for the plant project') =>
  call(tok.olivia, 'platform_call_operation', { platformId: ih.id, operation: 'createUser', body: { userName }, reason });
const userExists = async (userName: string) => {
  const r = await call(tok.olivia, 'platform_call_operation', { platformId: ih.id, operation: 'listUsers', query: { filter: `userName eq "${userName}"` } });
  return r.data.body.resources.length > 0;
};
const db = async () => (await import('../src/db.js')).db();

describe('MCP approved writes', () => {
  it('stay off until a platform manager allows them (confirmed, audited)', async () => {
    expect((await create('off@example.com')).data).toMatch(/read-only/);
    const f = await call(tok.olivia, 'platform_find_operations', { platformId: ih.id, query: 'users' });
    expect(f.data.items.map((o: any) => o.operation)).not.toContain('createUser');
    await expect(olivia('PUT', `/platforms/${ih.id}/mcp-gateway`, { enabled: true, writes: 'confirm' })).rejects.toMatchObject({ status: 403 });
    // turning changing calls on needs a recent confirmation (route-matrix.test.ts checks the rule; the client confirms)
    const p = await s.api('PUT', `/platforms/${ih.id}/mcp-gateway`, { enabled: true, writes: 'confirm' });
    expect(p.config.mcpGateway).toEqual({ enabled: true, writes: 'confirm' });
    // a change without a mode keeps it
    expect((await s.api('PUT', `/platforms/${ih.id}/mcp-gateway`, { enabled: true })).config.mcpGateway.writes).toBe('confirm');
    const audit = await s.api('GET', `/audit?action=platform.mcp_gateway_changed&entityId=${ih.id}`);
    expect((audit.items ?? audit)[0].summary).toMatch(/changing calls confirmed by the token owner/);
    const f2 = await call(tok.olivia, 'platform_find_operations', { platformId: ih.id, query: 'users' });
    expect(f2.data.items.find((o: any) => o.operation === 'createUser')).toMatchObject({ method: 'POST', needsApproval: 'confirm' });
    const d = await call(tok.olivia, 'platform_describe_operation', { platformId: ih.id, operation: 'createUser' });
    expect(d.data).toMatchObject({ callable: true, needsApproval: 'confirm' });
    // the call tool can create requests: clients must not treat it as read-only
    const tools = (await modern(tok.olivia, 'tools/list')).body.result.tools;
    expect(tools.find((t: any) => t.name === 'platform_call_operation').annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    expect(tools.find((t: any) => t.name === 'platform_find_operations').annotations.readOnlyHint).toBe(true);
  });

  it('turns a changing call into a request the token owner confirms; it runs once, as the owner', async () => {
    expect(
      (await call(tok.olivia, 'platform_call_operation', { platformId: ih.id, operation: 'createUser', body: { userName: 'x@example.com' } })).data,
    ).toMatch(/reason/);
    const r = await create('new.colleague@example.com');
    expect(r.isError, String(r.data)).toBe(false);
    expect(r.data).toMatchObject({ status: 'pending', needs: expect.stringMatching(/token owner/), requestId: expect.stringMatching(/^mrq_/) });
    const id = r.data.requestId;
    // nothing happened yet
    expect(await userExists('new.colleague@example.com')).toBe(false);
    expect((await call(tok.olivia, 'get_operation_request', { requestId: id })).data).toMatchObject({ status: 'pending', what: `POST ${IDM}/Users` });
    // others do not see it; vera's assistant neither
    expect((await call(tok.vera, 'get_operation_request', { requestId: id })).isError).toBe(true);
    await expect(vera('GET', `/mcp-requests/${id}`)).rejects.toMatchObject({ status: 404 });
    // the owner is told, in the app
    expect((await olivia('GET', '/notifications')).items.some((n: any) => n.event === 'mcp.request' && n.link === `/mcp-requests/${id}`)).toBe(true);
    const req = await olivia('GET', `/mcp-requests/${id}`);
    expect(req).toMatchObject({ kind: 'gateway', mode: 'confirm', method: 'POST', body: { userName: 'new.colleague@example.com' }, canApprove: true });
    expect((await olivia('GET', '/mcp-requests?scope=decide')).map((x: any) => x.id)).toContain(id);
    // an administrator cannot confirm for the owner (but may reject); an API token cannot decide at all
    await expect(s.api('POST', `/mcp-requests/${id}/decision`, { approve: true })).rejects.toMatchObject({ status: 403 });
    const rest = (await olivia('POST', '/me/tokens', { name: 'rest olivia', scope: 'full' })).token;
    const viaToken = await fetch(`${s.base}/api/mcp-requests/${id}/decision`, {
      method: 'POST',
      headers: { authorization: `Bearer ${rest}`, 'content-type': 'application/json' },
      body: JSON.stringify({ approve: true }),
    });
    expect(viaToken.status).toBe(403);
    expect((await viaToken.json()).code).toBe('SESSION_REQUIRED');
    const done = await olivia('POST', `/mcp-requests/${id}/decision`, { approve: true, comment: 'yes' });
    expect(done).toMatchObject({ status: 'done', decidedBy: 'olivia', resultStatus: 201, resultBody: { userName: 'new.colleague@example.com' } });
    expect(await userExists('new.colleague@example.com')).toBe(true);
    await expect(olivia('POST', `/mcp-requests/${id}/decision`, { approve: true })).rejects.toMatchObject({ status: 409 });
    expect((await call(tok.olivia, 'get_operation_request', { requestId: id })).data).toMatchObject({ status: 'done', resultStatus: 201 });
    const audit = await s.api('GET', `/audit?entityType=mcp_request&entityId=${id}`);
    expect((audit.items ?? audit).map((e: any) => e.action)).toEqual(
      expect.arrayContaining(['mcp.request_created', 'mcp.request_approved', 'mcp.request_executed']),
    );
    const call201 = (await s.api('GET', `/audit?action=mcp.gateway_call&entityId=${ih.id}`)).find((e: any) => e.details.requestId === id);
    expect(call201).toMatchObject({ actor: 'olivia', details: { method: 'POST', status: 201, owner: 'olivia' } });
  });

  it('can be withdrawn by the owner or rejected by an administrator; unanswered requests expire', async () => {
    const a = (await create('withdraw@example.com')).data.requestId;
    expect(await olivia('POST', `/mcp-requests/${a}/decision`, { approve: false, comment: 'not now' })).toMatchObject({ status: 'withdrawn' });
    const b = (await create('reject@example.com')).data.requestId;
    expect(await s.api('POST', `/mcp-requests/${b}/decision`, { approve: false, comment: 'not this way' })).toMatchObject({
      status: 'rejected',
      decidedBy: 'admin',
    });
    expect((await call(tok.olivia, 'get_operation_request', { requestId: b })).data).toMatchObject({ status: 'rejected', comment: 'not this way' });
    const c = (await create('late@example.com')).data.requestId;
    (await db()).run('UPDATE mcp_requests SET expires_at = ? WHERE id = ?', '2000-01-01T00:00:00.000Z', c);
    expect(await olivia('GET', `/mcp-requests/${c}`)).toMatchObject({ status: 'expired', canApprove: false });
    await expect(olivia('POST', `/mcp-requests/${c}/decision`, { approve: true })).rejects.toMatchObject({ status: 409 });
    for (const u of ['withdraw@example.com', 'reject@example.com', 'late@example.com']) expect(await userExists(u)).toBe(false);
  });

  it('with four-eyes, a second person who may use the platform approves – never the owner', async () => {
    await s.api('PUT', `/platforms/${ih.id}/mcp-gateway`, { enabled: true, writes: 'fourEyes' });
    const r = await create('four.eyes@example.com');
    const id = r.data.requestId;
    expect(r.data.needs).toMatch(/other than the token owner/);
    await expect(olivia('POST', `/mcp-requests/${id}/decision`, { approve: true })).rejects.toMatchObject({ status: 403 });
    // an approver without "use" on the platform does not see it
    await expect(adam('GET', `/mcp-requests/${id}`)).rejects.toMatchObject({ status: 404 });
    await s.api('PUT', `/platforms/${ih.id}/access`, {
      acl: [
        { subject: 'user:olivia', permissions: ['use'] },
        { subject: 'user:adam', permissions: ['use'] },
      ],
    });
    try {
      expect((await adam('GET', '/mcp-requests?scope=decide')).map((x: any) => x.id)).toContain(id);
      expect(await adam('POST', `/mcp-requests/${id}/decision`, { approve: true })).toMatchObject({ status: 'done', decidedBy: 'adam', resultStatus: 201 });
      expect(await userExists('four.eyes@example.com')).toBe(true);
    } finally {
      await s.api('PUT', `/platforms/${ih.id}/access`, { acl: [] });
    }
  });

  it('runs with the settings of the moment it is approved', async () => {
    await s.api('PUT', `/platforms/${ih.id}/mcp-gateway`, { enabled: true, writes: 'confirm' });
    const a = (await create('stricter@example.com')).data.requestId;
    await s.api('PUT', `/platforms/${ih.id}/mcp-gateway`, { enabled: true, writes: 'fourEyes' });
    expect(await olivia('POST', `/mcp-requests/${a}/decision`, { approve: true })).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/second person/),
    });
    await s.api('PUT', `/platforms/${ih.id}/mcp-gateway`, { enabled: true, writes: 'confirm' });
    const b = (await create('turned.off@example.com')).data.requestId;
    await s.api('PUT', `/platforms/${ih.id}/mcp-gateway`, { enabled: true, writes: 'off' });
    expect(await olivia('POST', `/mcp-requests/${b}/decision`, { approve: true })).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/turned off/),
    });
    expect(await userExists('stricter@example.com')).toBe(false);
    expect(await userExists('turned.off@example.com')).toBe(false);
  });

  it('asks to start runs only where the instance allows it; the owner confirms, the run is theirs', async () => {
    expect(await toolNames(tok.olivia)).not.toContain('request_run');
    await expect(olivia('PUT', '/mcp-server', { runRequests: true })).rejects.toMatchObject({ status: 403 });
    expect((await s.api('PUT', '/mcp-server', { runRequests: true })).runRequests).toBe(true);
    expect(await toolNames(tok.olivia)).toContain('request_run');
    expect((await call(tok.vera, 'request_run', { processId: proc, reason: 'Viewers may not run it' })).data).toMatch(/may not run/);
    const r = await call(tok.olivia, 'request_run', {
      processId: proc,
      inputs: { note: 'from the assistant' },
      reason: 'Refresh the numbers for the weekly report',
    });
    expect(r.isError, String(r.data)).toBe(false);
    const done = await olivia('POST', `/mcp-requests/${r.data.requestId}/decision`, { approve: true });
    expect(done).toMatchObject({ status: 'done', kind: 'run', runId: expect.stringMatching(/^run_/) });
    const run = await s.waitRun(done.runId, ['succeeded', 'failed']);
    expect(run).toMatchObject({ actor: 'olivia', inputs: { note: 'from the assistant' } });
    await s.api('PUT', '/mcp-server', { runRequests: false });
    expect(await toolNames(tok.olivia)).not.toContain('request_run');
  });
});
