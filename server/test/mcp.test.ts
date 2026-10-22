import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * MCP server (POST /api/mcp): transport and protocol rules (both eras), authentication and scope,
 * permission filtering of every tool, limits, and the read-only platform gateway.
 */
let s: TestServer;
const PW = 'Demo-password-1';
let vera: Client, audrey: Client, olivia: Client, dana: Client;
const tok: Record<string, string> = {};
let readToken: string;
const MODERN = '2026-07-28';
const SECRETS = ['gw-secret-token-0123456789'];
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
let restricted: string;
let publicProc: string;
let runId: string;
let gw: any;

beforeAll(async () => {
  s = await startTestServer();
  // imported after the test server set SM_DEMO (config.ts reads it once)
  const { DEMO_CREDENTIALS } = await import('../src/mock/mockPlatform.js');
  SECRETS.push(DEMO_CREDENTIALS.client.secret, DEMO_CREDENTIALS.iem.password);
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [vera, audrey, olivia, dana] = await Promise.all(['vera', 'audrey', 'olivia', 'dana'].map((u) => s.as(u, PW)));
  tok.admin = await mcpToken(s.api, 'mcp admin');
  tok.vera = await mcpToken(vera, 'mcp vera');
  tok.audrey = await mcpToken(audrey, 'mcp audrey');
  tok.olivia = await mcpToken(olivia, 'mcp olivia');
  tok.dana = await mcpToken(dana, 'mcp dana');
  readToken = (await s.api('POST', '/me/tokens', { name: 'rest', scope: 'read' })).token;
  ih = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'insights-hub');

  const def = (name: string) => ({
    name,
    nodes: [
      { id: 'start', type: 'start', x: 0, y: 0 },
      {
        id: 'pub',
        type: 'publish',
        dataset: `mcp.${name.toLowerCase().replace(/\W+/g, '')}`,
        title: name,
        rows: '[{"name":"a","state":"ok"},{"name":"b","state":"down"}]',
        status: 'state',
        metrics: { total: '2' },
        x: 1,
        y: 0,
      },
    ],
    wires: [{ from: 'start', port: 'out', to: 'pub' }],
  });
  publicProc = (await s.api('POST', '/processes', { definition: def('MCP public') })).id;
  restricted = (await s.api('POST', '/processes', { definition: def('MCP secret project') })).id;
  await s.api('PUT', `/processes/${restricted}/access`, { acl: [{ subject: 'user:dana', permissions: ['view'] }] });
  runId = (await s.api('POST', '/runs', { processId: publicProc })).id;
  expect((await s.waitRun(runId, ['succeeded', 'failed'])).status).toBe('succeeded');
  const r2 = (await s.api('POST', '/runs', { processId: restricted })).id;
  await s.waitRun(r2, ['succeeded', 'failed']);

  // a platform without an API specification for the path-prefix mode (bearer token, echoed back by the mock)
  gw = await s.api('POST', '/platforms', {
    name: 'Gateway test',
    kind: 'generic',
    baseUrl: `${s.base}/mock/test`,
    config: { auth: { type: 'bearer' }, variables: {}, http: { proxy: 'none' } },
    secrets: { token: 'gw-secret-token-0123456789' },
  });
});
afterAll(async () => s?.app.close());

describe('MCP server: off by default, settings', () => {
  it('refuses every request while turned off', async () => {
    const r = await modern(tok.admin, 'server/discover');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe(-31000);
    expect((await s.api('GET', '/mcp-server')).enabled).toBe(false);
  });

  it('only administrators turn it on; the change is audited', async () => {
    await expect(vera('PUT', '/mcp-server', { enabled: true })).rejects.toMatchObject({ status: 403 });
    const st = await s.api('PUT', '/mcp-server', { enabled: true });
    expect(st).toMatchObject({ enabled: true, path: '/api/mcp', protocolVersions: [MODERN, '2025-11-25', '2025-06-18'] });
    // every signed-in user may read how to connect
    expect((await vera('GET', '/mcp-server')).enabled).toBe(true);
    const audit = await s.api('GET', '/audit?action=mcp.settings_changed');
    expect((audit.items ?? audit).some((e: any) => e.action === 'mcp.settings_changed')).toBe(true);
  });
});

describe('MCP transport and authentication', () => {
  it('needs a bearer token with scope "mcp"', async () => {
    const none = await modern('', 'server/discover');
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toContain('Bearer');
    expect(none.body.error.code).toBe(-31001);
    expect((await modern('smt_invalidinvalidinvalidinvalid', 'server/discover')).status).toBe(401);
    const rest = await modern(readToken, 'server/discover');
    expect(rest.status).toBe(403);
    expect(rest.body.error.message).toMatch(/not enabled for MCP/);
    // tokens in the URL are refused
    const res = await fetch(`${s.base}/api/mcp?access_token=${tok.admin}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(400);
    // a session cookie is no substitute
    const cookieOnly = await fetch(`${s.base}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'sm_session=x' },
      body: '{}',
    });
    expect(cookieOnly.status).toBe(401);
  });

  it('MCP tokens work nowhere else', async () => {
    const v1 = await fetch(`${s.base}/api/v1/me`, { headers: { authorization: `Bearer ${tok.admin}` } });
    expect(v1.status).toBe(403);
    expect((await v1.json()).type).toMatch(/token-scope/);
    const internal = await fetch(`${s.base}/api/processes`, { headers: { authorization: `Bearer ${tok.admin}` } });
    expect(internal.status).toBe(403);
    const write = await fetch(`${s.base}/api/settings`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${tok.admin}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(write.status).toBe(403);
  });

  it('validates Origin (DNS rebinding)', async () => {
    const evil = await modern(tok.admin, 'server/discover', {}, { origin: 'http://evil.example' });
    expect(evil.status).toBe(403);
    expect((await modern(tok.admin, 'server/discover', {}, { origin: 'null' })).status).toBe(403);
    expect((await modern(tok.admin, 'server/discover', {}, { origin: s.base })).status).toBe(200);
  });

  it('answers GET and DELETE with 405, wrong types with 415/406, bad JSON with -32700', async () => {
    for (const method of ['GET', 'DELETE']) {
      const r = await fetch(`${s.base}/api/mcp`, { method, headers: { authorization: `Bearer ${tok.admin}` } });
      expect(r.status).toBe(405);
      expect(r.headers.get('allow')).toBe('POST');
    }
    expect((await post(tok.admin, {}, { 'content-type': 'text/plain' }, '{}')).status).toBe(415);
    expect((await post(tok.admin, {}, { accept: 'text/html' }, '{}')).status).toBe(406);
    const bad = await post(tok.admin, null, { 'mcp-protocol-version': MODERN }, '{"jsonrpc":');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe(-32700);
  });

  it('refuses oversized requests and batches', async () => {
    const big = await post(tok.admin, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(70 * 1024) } });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe(-31013);
    const batch = await post(tok.admin, [{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    expect(batch.status).toBe(400);
    expect(batch.body.error.code).toBe(-32600);
    const noVersion = await post(tok.admin, { id: 1, method: 'ping' });
    expect(noVersion.body.error.code).toBe(-32600);
    const nullId = await post(tok.admin, { jsonrpc: '2.0', id: null, method: 'ping' });
    expect(nullId.body.error.code).toBe(-32600);
  });

  it('rate-limits per token', async () => {
    const t = await mcpToken(s.api, 'mcp rate');
    process.env.SM_MCP_RATE_LIMIT = '3';
    try {
      for (let i = 0; i < 3; i++) expect((await modern(t, 'server/discover')).status).toBe(200);
      const r = await modern(t, 'server/discover');
      expect(r.status).toBe(429);
      expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(r.body.error.code).toBe(-31029);
      expect((await modern(tok.admin, 'server/discover')).status).toBe(200); // other tokens are not affected
    } finally {
      delete process.env.SM_MCP_RATE_LIMIT;
    }
  });
});

describe('MCP protocol: legacy handshake and modern per-request metadata', () => {
  it('legacy clients: initialize negotiates a legacy revision, without a session', async () => {
    const r = await post(tok.admin, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '1' } },
    });
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'steward' } });
    expect(r.body.result.instructions).toMatch(/untrusted data/);
    expect(r.headers.get('mcp-session-id')).toBeNull();
    const older = await post(tok.admin, {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'old', version: '1' } },
    });
    expect(older.body.result.protocolVersion).toBe('2025-11-25');
    expect((await post(tok.admin, { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-protocol-version': '2025-06-18' })).status).toBe(202);
    const ping = await post(tok.admin, { jsonrpc: '2.0', id: 3, method: 'ping' }, { 'mcp-protocol-version': '2025-11-25' });
    expect(ping.body).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
    const list = await post(tok.admin, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, { 'mcp-protocol-version': '2025-06-18' });
    expect(list.body.result.tools.length).toBeGreaterThan(10);
    expect(list.body.result.resultType).toBeUndefined();
    // without the version header (2025-03-26 and older) or with an unknown version: 400
    expect((await post(tok.admin, { jsonrpc: '2.0', id: 5, method: 'tools/list' })).status).toBe(400);
    const unknown = await post(tok.admin, { jsonrpc: '2.0', id: 6, method: 'tools/list' }, { 'mcp-protocol-version': '2024-11-05' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatchObject({ code: -32022, data: { requested: '2024-11-05' } });
    expect((await post(tok.admin, { jsonrpc: '2.0', id: 7, method: 'initialize', params: {} })).body.error.code).toBe(-32602);
  });

  it('modern clients: server/discover and the result envelope', async () => {
    const r = await modern(tok.admin, 'server/discover');
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({
      resultType: 'complete',
      supportedVersions: [MODERN],
      capabilities: { tools: {}, resources: {} },
      cacheScope: 'private',
    });
    expect(r.body.result.ttlMs).toBeGreaterThan(0);
    expect(r.body.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('steward');
    expect((await modern(tok.admin, 'ping')).status).toBe(404); // removed in 2026-07-28
    const nf = await modern(tok.admin, 'prompts/list');
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe(-32601);
  });

  it('modern clients: headers must match the body', async () => {
    const meta = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} };
    const send = (params: Record<string, unknown>, headers: Record<string, string>, method = 'tools/list') =>
      post(tok.admin, { jsonrpc: '2.0', id: 9, method, params }, headers);
    const noHeader = await send({ _meta: meta }, { 'mcp-method': 'tools/list' });
    expect(noHeader.status).toBe(400);
    expect(noHeader.body.error.code).toBe(-32020);
    expect((await send({ _meta: meta }, { 'mcp-protocol-version': MODERN })).body.error.code).toBe(-32020); // Mcp-Method missing
    expect((await send({ _meta: meta }, { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call' })).body.error.code).toBe(-32020);
    expect(
      (
        await send(
          { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2026-01-01' } },
          { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' },
        )
      ).body.error.code,
    ).toBe(-32020);
    const future = await send(
      { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } },
      { 'mcp-protocol-version': '2099-01-01', 'mcp-method': 'tools/list' },
    );
    expect(future.status).toBe(400);
    expect(future.body.error).toMatchObject({ code: -32022, data: { supported: [MODERN], requested: '2099-01-01' } });
    const noCaps = await send({ _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } }, { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/list' });
    expect(noCaps.status).toBe(400);
    expect(noCaps.body.error.code).toBe(-32602);
    // tools/call needs Mcp-Name = params.name (plain or Base64 sentinel)
    const callBody = { name: 'get_system_status', arguments: {}, _meta: meta };
    expect((await send(callBody, { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call' }, 'tools/call')).body.error.code).toBe(-32020);
    expect(
      (await send(callBody, { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call', 'mcp-name': 'search_processes' }, 'tools/call')).body.error.code,
    ).toBe(-32020);
    const b64 = `=?base64?${Buffer.from('get_system_status').toString('base64')}?=`;
    expect(
      (await send(callBody, { 'mcp-protocol-version': MODERN, 'mcp-method': 'tools/call', 'mcp-name': b64 }, 'tools/call')).body.result.isError,
    ).toBeFalsy();
  });

  it('notifications get 202 without a body; unknown tools and bad arguments are reported', async () => {
    const n = await post(tok.admin, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }, { 'mcp-protocol-version': MODERN });
    expect(n.status).toBe(202);
    expect(n.text).toBe('');
    const unknown = await modern(tok.admin, 'tools/call', { name: 'delete_everything', arguments: {} });
    expect(unknown.body.error.code).toBe(-32602);
    const bad = await call(tok.admin, 'list_runs', { limit: 5000 });
    expect(bad.isError).toBe(true);
    expect(bad.data).toMatch(/Invalid arguments: limit/);
    const extra = await call(tok.admin, 'get_system_status', { sql: 'DROP TABLE runs' });
    expect(extra.isError).toBe(true);
  });

  it('offers the semantic model as a resource', async () => {
    const list = await modern(tok.vera, 'resources/list');
    expect(list.body.result.resources.map((r: any) => r.uri)).toContain('steward://semantic-model');
    const read = await modern(tok.vera, 'resources/read', { uri: 'steward://semantic-model' });
    expect(read.body.result.contents[0]).toMatchObject({ uri: 'steward://semantic-model', mimeType: 'application/yaml' });
    expect(read.body.result.contents[0].text).toContain('semantic_model:');
    expect((await modern(tok.vera, 'resources/read', { uri: 'file:///etc/passwd' })).body.error.code).toBe(-32602);
    const legacy = await post(
      tok.vera,
      { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'steward://nothing' } },
      { 'mcp-protocol-version': '2025-11-25' },
    );
    expect(legacy.body.error.code).toBe(-32002);
  });
});

describe("MCP tools: the token owner's rights", () => {
  it("lists read-only tools, depending on the owner's rights, in a stable order", async () => {
    const r = await modern(tok.admin, 'tools/list');
    for (const t of r.body.result.tools) {
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.inputSchema.type).toBe('object');
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.name).toMatch(/^[a-z_]{1,64}$/);
    }
    expect(await toolNames(tok.admin)).toEqual(await toolNames(tok.admin));
    expect(await toolNames(tok.admin)).toContain('search_audit_log');
    expect(await toolNames(tok.audrey)).toContain('search_audit_log');
    expect(await toolNames(tok.vera)).not.toContain('search_audit_log');
    // no gateway tools while no platform has the gateway on
    expect((await toolNames(tok.admin)).some((n) => n.startsWith('platform_'))).toBe(false);
  });

  it('processes and runs: only what the owner may view', async () => {
    const adminList = (await call(tok.admin, 'search_processes', { query: 'MCP', limit: 100 })).data.items.map((p: any) => p.id);
    expect(adminList).toEqual(expect.arrayContaining([publicProc, restricted]));
    const veraList = (await call(tok.vera, 'search_processes', { query: 'MCP', limit: 100 })).data.items.map((p: any) => p.id);
    expect(veraList).toContain(publicProc);
    expect(veraList).not.toContain(restricted);
    expect((await call(tok.dana, 'search_processes', { query: 'secret project' })).data.items.map((p: any) => p.id)).toEqual([restricted]);
    // the same filter as the internal API
    const internal = (await vera('GET', '/processes')).map((p: any) => p.id).sort();
    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const page = (await call(tok.vera, 'search_processes', { limit: 2, ...(cursor ? { cursor } : {}) })).data;
      all.push(...page.items.map((p: any) => p.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(all.sort()).toEqual(internal);

    const p = await call(tok.vera, 'get_process', { processId: publicProc });
    expect(p.isError).toBe(false);
    expect(p.data.nodes.map((n: any) => n.type)).toEqual(['start', 'publish']);
    expect((await call(tok.vera, 'get_process', { processId: restricted })).isError).toBe(true);
    expect((await call(tok.admin, 'get_process', { processId: restricted })).isError).toBe(false);

    const runs = (await call(tok.vera, 'list_runs', { limit: 100 })).data.items;
    expect(runs.some((r: any) => r.id === runId)).toBe(true);
    expect(runs.some((r: any) => r.processId === restricted)).toBe(false);
    const run = await call(tok.vera, 'get_run', { runId });
    expect(run.data).toMatchObject({ id: runId, status: 'succeeded', processId: publicProc });
    expect(run.data.steps.length).toBeGreaterThan(0);
    expect(run.data.steps[0].input).toBeUndefined();
    const step = await call(tok.vera, 'get_run_step', { runId, stepId: run.data.steps[0].id });
    expect(step.isError).toBe(false);
    const hidden = (await call(tok.admin, 'list_runs', { processId: restricted })).data.items[0].id;
    expect((await call(tok.vera, 'get_run', { runId: hidden })).isError).toBe(true);
    expect((await call(tok.vera, 'get_run_step', { runId: hidden, stepId: 1 })).isError).toBe(true);
    expect((await call(tok.vera, 'list_runs', { cursor: 'not-a-cursor' })).isError).toBe(true);
  });

  it('datasets, dashboards, monitors, schedules and triggers', async () => {
    const ds = (await call(tok.vera, 'list_datasets', { limit: 100 })).data.items.map((d: any) => d.key);
    expect(ds).toContain('mcp.mcppublic');
    expect(ds).not.toContain('mcp.mcpsecretproject');
    const rows = await call(tok.vera, 'read_dataset', { key: 'mcp.mcppublic', limit: 1 });
    expect(rows.data.items).toHaveLength(1);
    expect(rows.data.nextCursor).toBeTruthy();
    const next = await call(tok.vera, 'read_dataset', { key: 'mcp.mcppublic', limit: 1, cursor: rows.data.nextCursor });
    expect(next.data.items[0].name).toBe('b');
    expect((await call(tok.vera, 'read_dataset', { key: 'mcp.mcpsecretproject' })).isError).toBe(true);
    expect((await call(tok.vera, 'list_dashboards')).isError).toBe(false);

    const mons = (await call(tok.admin, 'list_monitors', { limit: 100 })).data.items;
    expect(mons.length).toBeGreaterThan(0);
    const m = await call(tok.admin, 'get_monitor', { monitor: mons[0].key });
    expect(m.data.checks.length).toBeGreaterThan(0);
    expect((await call(tok.admin, 'get_monitor_history', { monitor: mons[0].id })).isError).toBe(false);
    expect((await call(tok.admin, 'get_monitor', { monitor: 'no-such-monitor' })).isError).toBe(true);
    // the same monitors the owner sees in the UI
    expect((await call(tok.vera, 'list_monitors', { limit: 100 })).data.items.length).toBe((await vera('GET', '/monitors')).length);

    const sch = await call(tok.admin, 'list_schedules');
    expect(sch.isError).toBe(false);
    for (const x of sch.data.items) expect(x).not.toHaveProperty('inputs');
    const trig = await s.api('POST', '/triggers', {
      name: 'MCP hook',
      processId: restricted,
      enabled: true,
      dryRun: true,
      inputMapping: {},
      bindings: {},
      authMode: 'token',
      allowedCidrs: [],
      allowedHeaders: [],
      rateLimitPerMinute: 60,
      dedupeSeconds: 0,
      skipIfRunning: false,
    });
    const adminTriggers = (await call(tok.admin, 'list_triggers')).data.items;
    expect(adminTriggers.map((t: any) => t.id)).toContain(trig.trigger.id);
    expect(JSON.stringify(adminTriggers)).not.toContain(trig.secret);
    expect(JSON.stringify(adminTriggers)).not.toMatch(/secretPrefix|inputMapping|allowedCidrs/);
    expect((await call(tok.vera, 'list_triggers')).data.items.map((t: any) => t.id)).not.toContain(trig.trigger.id);
  });

  it('platforms: metadata of platforms the owner has rights on', async () => {
    expect((await call(tok.vera, 'list_platforms')).data.items).toEqual([]);
    const ol = (await call(tok.olivia, 'list_platforms')).data.items;
    expect(ol.length).toBeGreaterThan(1);
    expect(JSON.stringify(ol)).not.toMatch(/"(secrets|secretKeys|clientSecret|password|variables|acl|config)"/);
  });

  it('audit log: auditors and administrators only', async () => {
    expect((await modern(tok.vera, 'tools/call', { name: 'search_audit_log', arguments: {} })).body.error.code).toBe(-32602);
    const a = await call(tok.audrey, 'search_audit_log', { action: 'mcp.', limit: 5 });
    expect(a.isError).toBe(false);
    expect(a.data.items.length).toBeGreaterThan(0);
    // first use of each token per day is audited, ordinary tool calls are not
    const used = await call(tok.admin, 'search_audit_log', { action: 'mcp.token_used', limit: 50 });
    expect(used.data.items.some((e: any) => e.entityId && e.actor === 'vera')).toBe(true);
    const n = used.data.items.filter((e: any) => e.actor === 'vera').length;
    await call(tok.vera, 'list_runs');
    expect((await call(tok.admin, 'search_audit_log', { action: 'mcp.token_used', limit: 50 })).data.items.filter((e: any) => e.actor === 'vera').length).toBe(
      n,
    );
  });

  it('system status: health details only for auditors and administrators', async () => {
    const admin = await call(tok.admin, 'get_system_status');
    expect(admin.data.status.view).toBe('limited');
    expect(admin.data.you.username).toBe('admin');
    const v = await call(tok.vera, 'get_system_status');
    expect(v.data.status).toBeUndefined();
    expect(v.data.you.roles).toEqual(['viewer']);
  });

  it("a deactivated owner's token stops working", async () => {
    const adam = (await s.api('GET', '/users')).find((u: any) => u.username === 'adam');
    const tk = await mcpToken(await s.as('adam', PW), 'temp');
    expect((await modern(tk, 'server/discover')).status).toBe(200);
    await s.api('PUT', `/users/${adam.id}`, { active: false });
    try {
      expect((await modern(tk, 'server/discover')).status).toBe(403);
    } finally {
      await s.api('PUT', `/users/${adam.id}`, { active: true });
    }
  });
});

describe('MCP platform gateway (read-only)', () => {
  it('is off per platform; only "manage" turns it on (audited)', async () => {
    expect((await toolNames(tok.olivia)).some((n) => n.startsWith('platform_'))).toBe(false);
    await expect(vera('PUT', `/platforms/${ih.id}/mcp-gateway`, { enabled: true })).rejects.toMatchObject({ status: 404 });
    await expect(olivia('PUT', `/platforms/${ih.id}/mcp-gateway`, { enabled: true })).rejects.toMatchObject({ status: 403 });
    await expect(s.api('PUT', `/platforms/${ih.id}/mcp-gateway`, { enabled: true, allowedPathPrefixes: ['/x/../y'] })).rejects.toMatchObject({ status: 400 });
    const p = await s.api('PUT', `/platforms/${ih.id}/mcp-gateway`, { enabled: true });
    expect(p.config.mcpGateway).toEqual({ enabled: true });
    expect(p.integrity).toBe('ok');
    const audit = await s.api('GET', `/audit?action=platform.mcp_gateway_changed&entityId=${ih.id}`);
    expect((audit.items ?? audit).length).toBeGreaterThan(0);
    // an ordinary platform update neither turns it off nor on
    await s.api('PUT', `/platforms/${ih.id}`, { config: { ...p.config, mcpGateway: undefined } });
    expect((await s.api('GET', `/platforms/${ih.id}`)).config.mcpGateway).toEqual({ enabled: true });
    const other = (await s.api('GET', '/platforms')).find((x: any) => x.kind === 'industrial-edge-management');
    await s.api('PUT', `/platforms/${other.id}`, { config: { ...other.config, mcpGateway: { enabled: true } } });
    expect((await s.api('GET', `/platforms/${other.id}`)).config.mcpGateway).toBeUndefined();
    // a new platform never starts with it
    const copy = await s.api('POST', '/platforms', {
      name: 'Copy',
      kind: 'generic',
      baseUrl: 'https://example.com',
      config: { auth: { type: 'none' }, variables: {}, http: {}, mcpGateway: { enabled: true } },
    });
    expect(copy.config.mcpGateway).toBeUndefined();
    await s.api('DELETE', `/platforms/${copy.id}`);
  });

  it('needs "use" on the platform', async () => {
    expect(await toolNames(tok.olivia)).toEqual(expect.arrayContaining(['platform_find_operations', 'platform_describe_operation', 'platform_call_operation']));
    expect((await toolNames(tok.vera)).some((n) => n.startsWith('platform_'))).toBe(false);
    expect(
      (await modern(tok.vera, 'tools/call', { name: 'platform_call_operation', arguments: { platformId: ih.id, operation: 'listUsers' } })).body.error.code,
    ).toBe(-32602);
    await s.api('PUT', `/platforms/${ih.id}/access`, { acl: [{ subject: 'user:dana', permissions: ['use'] }] });
    try {
      // olivia lost "use": the gateway tools disappear for her
      expect((await modern(tok.olivia, 'tools/call', { name: 'platform_find_operations', arguments: { platformId: ih.id } })).body.error.code).toBe(-32602);
      expect((await call(tok.dana, 'platform_find_operations', { platformId: ih.id })).isError).toBe(false);
    } finally {
      await s.api('PUT', `/platforms/${ih.id}/access`, { acl: [] });
    }
  });

  it('finds and describes read operations only', async () => {
    const f = await call(tok.olivia, 'platform_find_operations', { platformId: ih.id, query: 'users' });
    const ops = f.data.items.map((o: any) => o.operation);
    expect(ops).toEqual(expect.arrayContaining(['listUsers', 'getUser']));
    expect(ops).not.toContain('createUser');
    expect(f.data.writeOperationsHidden).toBeGreaterThan(0);
    const d = await call(tok.olivia, 'platform_describe_operation', { platformId: ih.id, operation: 'getUser' });
    expect(d.data).toMatchObject({ method: 'GET', callable: true });
    expect(d.data.parameters.find((x: any) => x.name === 'id')).toMatchObject({ in: 'path', required: true });
    expect(d.data.response.status).toBe('200');
    const w = await call(tok.olivia, 'platform_describe_operation', { platformId: ih.id, operation: 'createUser' });
    expect(w.data.callable).toBe(false);
  });

  it("calls GET operations with Steward's credentials, audited, never returning them", async () => {
    const r = await call(tok.olivia, 'platform_call_operation', { platformId: ih.id, operation: 'listUsers', query: { count: 2 } });
    expect(r.isError, String(r.data)).toBe(false);
    expect(r.data.status).toBe(200);
    expect(r.data.body.resources.length).toBeGreaterThan(0);
    const id = r.data.body.resources[0].id;
    const one = await call(tok.olivia, 'platform_call_operation', {
      platformId: ih.id,
      operation: 'GET /api/identitymanagement/v3/Users/{id}',
      pathParams: { id },
    });
    expect(one.data.status).toBe(200);
    const audit = await call(tok.admin, 'search_audit_log', { action: 'mcp.gateway_call', entityId: ih.id, limit: 5 });
    const e = audit.data.items[0];
    expect(e.actor).toBe('olivia');
    expect(e.details).toMatchObject({ method: 'GET', pathTemplate: '/api/identitymanagement/v3/Users/{id}', status: 200, outcome: 'ok', owner: 'olivia' });
    expect(e.details.tokenId).toMatch(/^tok_/);
    expect(e.details.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('refuses writes, undeclared parameters and path tricks (and audits the refusals)', async () => {
    for (const op of ['createUser', 'deleteUser', 'POST /api/identitymanagement/v3/Users']) {
      const r = await call(tok.olivia, 'platform_call_operation', {
        platformId: ih.id,
        operation: op,
        pathParams: op === 'deleteUser' ? { id: 'x' } : undefined,
      });
      expect(r.isError).toBe(true);
      expect(r.data).toMatch(/read-only/);
    }
    const refused = await call(tok.admin, 'search_audit_log', { action: 'mcp.gateway_refused', entityId: ih.id, limit: 10 });
    expect(refused.data.items.some((x: any) => x.details.outcome === 'write_refused' && x.details.method === 'POST')).toBe(true);
    for (const id of ['..', '.', '../Groups', 'a/b', '%2e%2e', 'x\\y', 'a\nb']) {
      const r = await call(tok.olivia, 'platform_call_operation', { platformId: ih.id, operation: 'getUser', pathParams: { id } });
      expect(r.isError, id).toBe(true);
    }
    expect((await call(tok.olivia, 'platform_call_operation', { platformId: ih.id, operation: 'listUsers', query: { evil: '1' } })).isError).toBe(true);
    expect((await call(tok.olivia, 'platform_call_operation', { platformId: ih.id, operation: 'listUsers', query: { count: 'many' } })).isError).toBe(true);
    expect((await call(tok.olivia, 'platform_call_operation', { platformId: ih.id, operation: 'getUser', pathParams: { id: 'a', other: 'b' } })).isError).toBe(
      true,
    );
    // a literal path needs an allow-listed prefix
    expect((await call(tok.olivia, 'platform_call_operation', { platformId: ih.id, path: '/api/identitymanagement/v3/Users' })).isError).toBe(true);
    // the arguments do not allow headers, bodies or other methods
    for (const extra of [{ headers: { authorization: 'x' } }, { body: {} }, { method: 'POST' }]) {
      expect((await call(tok.olivia, 'platform_call_operation', { platformId: ih.id, path: '/x', ...extra })).isError).toBe(true);
    }
  });

  it('path-prefix mode for platforms without a specification', async () => {
    await s.api('PUT', `/platforms/${gw.id}/mcp-gateway`, { enabled: true, allowedPathPrefixes: ['/echo-headers', '/big', '/redirect'] });
    const f = await call(tok.olivia, 'platform_find_operations', { platformId: gw.id });
    expect(f.data.allowedPathPrefixes).toEqual(['/echo-headers', '/big', '/redirect']);
    const ok = await call(tok.olivia, 'platform_call_operation', { platformId: gw.id, path: '/echo-headers', query: { a: 'b' } });
    expect(ok.isError, String(ok.data)).toBe(false);
    // the mock echoes the request headers: the bearer token Steward added is masked
    expect(ok.data.body.headers.authorization).toBe('***');
    expect(ok.res.text).not.toContain('gw-secret-token-0123456789');
    for (const path of [
      '/echo-headers/../delay',
      '/delay',
      '//evil.example/x',
      'http://evil.example/',
      '/echo-headers%2f..%2fdelay',
      '/echo-headers?x=1',
      '/echo-headers#x',
      '/x@evil.example',
      '/echo-headersX',
      '\\\\evil',
    ]) {
      const r = await call(tok.olivia, 'platform_call_operation', { platformId: gw.id, path });
      expect(r.isError, path).toBe(true);
    }
    // redirects are returned, not followed
    const red = await call(tok.olivia, 'platform_call_operation', { platformId: gw.id, path: '/redirect' });
    expect(red.data.status).toBe(302);
    // big responses are cut
    const big = await call(tok.olivia, 'platform_call_operation', { platformId: gw.id, path: '/big', query: { kb: 700 } });
    expect(big.data.truncated).toBe(true);
    expect(big.res.text.length).toBeLessThan(300_000);
  });

  it('obeys the outbound policy', async () => {
    const before = await s.api('GET', '/settings');
    await s.api('PUT', '/settings', { ...before, outboundPolicy: 'allowList', outboundAllowList: [] });
    try {
      const r = await call(tok.olivia, 'platform_call_operation', { platformId: gw.id, path: '/echo-headers' });
      expect(r.isError).toBe(true);
      expect(r.data).toMatch(/outbound policy/);
      const refused = await call(tok.admin, 'search_audit_log', { action: 'mcp.gateway_refused', entityId: gw.id, limit: 5 });
      expect(refused.data.items[0].details.outcome).toBe('policy_refused');
    } finally {
      await s.api('PUT', '/settings', { ...before });
    }
  });

  it('rate-limits per token and platform', async () => {
    process.env.SM_MCP_GATEWAY_RATE_LIMIT = '2';
    try {
      const t = await mcpToken(olivia, 'gw rate');
      expect((await call(t, 'platform_call_operation', { platformId: gw.id, path: '/echo-headers' })).isError).toBe(false);
      expect((await call(t, 'platform_call_operation', { platformId: gw.id, path: '/echo-headers' })).isError).toBe(false);
      const r = await call(t, 'platform_call_operation', { platformId: gw.id, path: '/echo-headers' });
      expect(r.isError).toBe(true);
      expect(r.data).toMatch(/Rate limit/);
      // another platform has its own budget
      expect((await call(t, 'platform_call_operation', { platformId: ih.id, operation: 'listUsers' })).isError).toBe(false);
    } finally {
      delete process.env.SM_MCP_GATEWAY_RATE_LIMIT;
    }
  });

  it('turning it off removes the tools', async () => {
    await s.api('PUT', `/platforms/${gw.id}/mcp-gateway`, { enabled: false });
    expect((await call(tok.olivia, 'platform_find_operations', { platformId: gw.id })).isError).toBe(true);
  });
});

describe('MCP: nothing secret leaves', () => {
  it('no platform secret or token appears in any MCP response', async () => {
    const all = seen.join('\n');
    for (const secret of SECRETS) expect(all).not.toContain(secret);
    for (const t of [...Object.values(tok), readToken]) expect(all).not.toContain(t);
  });

  it('turning the server off refuses tokens again', async () => {
    await s.api('PUT', '/mcp-server', { enabled: false });
    expect((await modern(tok.admin, 'tools/list')).status).toBe(403);
  });
});
