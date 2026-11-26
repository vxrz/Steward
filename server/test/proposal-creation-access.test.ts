import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Access on the decide path of a proposal (0.31.0, ADR 0042): `selection.access` is what the accepting person chose
 * for the items the proposal creates. It is applied when they accept, with their own rights – a team they are not in,
 * or a share that needs the step-up they have not confirmed, fails the acceptance and creates nothing.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Plant-password-1';
let dana: Client, olaf: Client, vera: Client, strict: Client;
const tok: Record<string, string> = {};
const MODERN = '2026-07-28';
let nextId = 1;

async function rpc(token: string, method: string, params: Record<string, unknown> = {}): Promise<{ status: number; body: any; text: string }> {
  const name = method === 'tools/call' ? params.name : undefined;
  const res = await fetch(`${s.base}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'mcp-protocol-version': MODERN,
      'mcp-method': method,
      ...(typeof name === 'string' ? { 'mcp-name': name } : {}),
    },
    body: JSON.stringify({
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
    }),
  });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, text };
}

/** tools/call → { isError, data } (data = structuredContent, or the error text); an unknown tool → isError with its message. */
async function call(token: string, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; data: any }> {
  const res = await rpc(token, 'tools/call', { name, arguments: args });
  expect(res.status, res.text).toBe(200);
  if (res.body.error) return { isError: true, data: res.body.error.message };
  const r = res.body.result;
  return { isError: !!r.isError, data: r.isError ? r.content[0].text : r.structuredContent };
}
const mcpToken = async (c: Client, name: string): Promise<string> => (await c('POST', '/me/tokens', { name, scope: 'mcp' })).token;
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );
const db = async () => (await import('../src/db.js')).db();
const auditActions = async (entityId: string) =>
  (await db()).all<{ action: string }>('SELECT action FROM audit_log WHERE entity_id = ? ORDER BY seq', entityId).map((r) => r.action);

const blueprintCount = async () => (await db()).get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_blueprints')!.n;
let team = '';
let n = 0;
const doc = () => ({
  version: 1,
  blueprint: {
    id: `inv-bp-${++n}`,
    name: `Invented blueprint ${n}`,
    reference: 'Own experience',
    version: '1',
    signals: [{ id: 's', name: 'S', importance: 'must' }],
  },
});
const propose = async (document: { blueprint: { id: string } }) => {
  const r = await call(tok.dana, 'propose_plant_changes', { title: 'Blueprint', rationale: 'Invented example', document });
  expect(r.isError, r.data).toBe(false);
  return r.data.requestId as string;
};
const teamsOf = async (id: string) => ((await s.api('GET', `/owning-teams/blueprint/${id}`)) as { teams: { id: string }[] }).teams.map((t) => t.id);
const restricted = async (id: string) => !!(await db()).get('SELECT 1 FROM resource_restrictions WHERE kind = ? AND resource_id = ?', 'blueprint', id);

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Invented Plant AG', labels: {}, fields: {} });
  const { createUser } = await import('../src/auth/users.js');
  createUser({ username: 'dana', roles: ['designer'], password: PW });
  createUser({ username: 'olaf', roles: ['designer'], password: PW });
  createUser({ username: 'vera', roles: ['viewer'], password: PW });
  [dana, olaf, vera] = await Promise.all(['dana', 'olaf', 'vera'].map((u) => s.as(u, PW)));
  strict = await s.as(ADMIN.username, ADMIN.password, { autoStepUp: false });
  team = (await s.api('POST', '/teams', { name: 'Invented machines', members: ['dana'] })).id;
  await s.api('PUT', '/mcp-server', { enabled: true });
  tok.dana = await mcpToken(dana, 'mcp dana');
});
afterAll(async () => {
  await s?.app.close();
});

describe('selection.access on the decide path', () => {
  it('is applied on accept: owning team and Restricted, audited', async () => {
    const d = doc();
    const rid = await propose(d);
    const done = await s.api('POST', `/mcp-requests/${rid}/decision`, {
      approve: true,
      comment: '',
      selection: { access: { owningTeams: [team], restricted: true } },
    });
    expect(done.status).toBe('done');
    expect(await teamsOf(d.blueprint.id)).toEqual([team]);
    expect(await restricted(d.blueprint.id)).toBe(true);
    expect(await auditActions(d.blueprint.id)).toEqual(expect.arrayContaining(['access.owning_teams_changed', 'access.scope_changed']));
    expect(await status(vera('GET', `/plant/blueprints/${d.blueprint.id}`))).toMatchObject({ status: 404 });
  });

  it('without it the instance default applies', async () => {
    const d = doc();
    const rid = await propose(d);
    expect((await s.api('POST', `/mcp-requests/${rid}/decision`, { approve: true, comment: '' })).status).toBe('done');
    expect(await restricted(d.blueprint.id)).toBe(false);
  });

  it('is refused when the accepting person may not name the team: the request fails and nothing is created', async () => {
    const d = doc();
    const rid = await propose(d);
    const before = await blueprintCount();
    const done = await olaf('POST', `/mcp-requests/${rid}/decision`, { approve: true, comment: '', selection: { access: { owningTeams: [team] } } });
    expect(done.status).toBe('failed');
    expect(done.error).toBeTruthy();
    expect(await blueprintCount()).toBe(before);
  });

  it('is refused when it widens and the accepting person has not confirmed: the request fails and nothing is created', async () => {
    await strict('DELETE', '/auth/step-up');
    const d = doc();
    const rid = await propose(d);
    const before = await blueprintCount();
    const done = await strict('POST', `/mcp-requests/${rid}/decision`, {
      approve: true,
      comment: '',
      selection: { access: { owningTeams: [team], shares: [{ subject: 'user:vera', level: 'view' }] } },
    });
    expect(done.status).toBe('failed');
    expect(await blueprintCount()).toBe(before);
  });
});
