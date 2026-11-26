import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlantBlueprintCoverageView, PlantBlueprintDetail } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Machine blueprints in assistants' proposals (0.30.0 step 2, ADR 0041): a document of the plant import format with
 * blueprints, mappings and KPI links is previewed without writing, listed with its entries, and applied only when a
 * person accepts it – with their own rights. Not-applicable marks and dropped items are refused; the team scope holds.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Plant-password-1';
let dana: Client, olaf: Client, vera: Client;
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

const PROFILE = {
  id: 'comp-ctl',
  name: 'Example compressor controller',
  interfaces: [
    {
      id: 'mb',
      name: 'Modbus',
      protocol: 'modbus_tcp',
      groups: [{ name: 'g', dataPoints: [{ id: 'p_out', name: 'Pressure', dataType: 'Float', address: 'holding:100' }] }],
    },
  ],
};
const BLUEPRINT = {
  id: 'compressor',
  name: 'Compressor',
  reference: 'Own experience',
  version: '1',
  signals: [
    { id: 'pressure', name: 'Pressure', importance: 'must', kpis: ['specific-energy'] },
    { id: 'run_hours', name: 'Run hours', importance: 'should' },
  ],
};
const DOC = {
  version: 1,
  blueprint: BLUEPRINT,
  device_profile: {
    id: 'comp-ctl',
    name: 'Example compressor controller',
    blueprints: ['compressor'],
    blueprint_mappings: [{ blueprint: 'compressor', signal: 'pressure', data_points: ['p_out'] }],
  },
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Invented Plant AG', labels: {}, fields: {} });
  const { createUser } = await import('../src/auth/users.js');
  createUser({ username: 'dana', roles: ['designer'], password: PW });
  createUser({ username: 'olaf', roles: ['designer'], password: PW });
  createUser({ username: 'vera', roles: ['viewer'], password: PW });
  [dana, olaf, vera] = await Promise.all(['dana', 'olaf', 'vera'].map((u) => s.as(u, PW)));
  await s.api('PUT', '/mcp-server', { enabled: true });
  tok.dana = await mcpToken(dana, 'mcp dana');
  await s.api('POST', '/plant/profiles', PROFILE);
  await s.api('POST', '/plant/kpis', { id: 'specific-energy', name: 'Specific energy', inputs: [{ profile: 'comp-ctl', dataPoints: ['p_out'] }] });
});
afterAll(async () => {
  await s?.app.close();
});

const propose = (args: Record<string, unknown>) =>
  call(tok.dana, 'propose_plant_changes', { title: 'Compressor blueprint', rationale: 'From the compressor data sheet (example)', ...args });

describe('proposals with blueprints', () => {
  let id = '';
  it('are previewed with their entries; nothing is written until a person accepts', async () => {
    const r = await propose({ document: DOC });
    expect(r.isError, r.data).toBe(false);
    expect(r.data).toMatchObject({ status: 'pending', added: 1, changed: 1 });
    id = r.data.requestId;
    expect(await s.api('GET', '/plant/blueprints')).toEqual([]);
    const detail = await s.api('GET', `/mcp-requests/${id}`);
    expect(detail.proposal.proposed.changes.map((c: any) => `${c.kind}:${c.action}:${c.id}`).sort()).toEqual([
      'blueprint:add:compressor',
      'blueprint_use:change:comp-ctl',
    ]);
    expect(detail.proposal.now.ok).toBe(true);
  });

  it('are applied by the person who accepts them, audited, and then count in the coverage', async () => {
    const done = await s.api('POST', `/mcp-requests/${id}/decision`, { approve: true, comment: 'Checked' });
    expect(done.status).toBe('done');
    const bp = (await s.api('GET', '/plant/blueprints/compressor')) as PlantBlueprintDetail;
    expect(bp.signals.find((x) => x.id === 'pressure')!.kpis).toEqual(['specific-energy']);
    const cov = (await s.api('GET', '/plant/profiles/comp-ctl/blueprints')) as PlantBlueprintCoverageView;
    expect(cov.blueprints[0]!.signals.find((x) => x.signal.id === 'pressure')!.state).toBe('covered');
    expect(await auditActions('compressor')).toEqual(expect.arrayContaining(['blueprint.created', 'blueprint.assigned', 'blueprint.mapping_changed']));
    expect(await auditActions(done.resultBody.importId)).toEqual(['plant.imported', 'plant.proposal_applied']);
  });

  it('may not mark signals not applicable: that stays with people', async () => {
    const r = await propose({
      document: {
        version: 1,
        device_profile: {
          id: 'comp-ctl',
          name: 'Example compressor controller',
          blueprint_not_applicable: [{ blueprint: 'compressor', signal: 'run_hours', reason: 'Not measured' }],
        },
      },
    });
    expect(r).toMatchObject({ isError: true, data: expect.stringMatching(/not applicable/) });
    expect(((await s.api('GET', '/plant/profiles/comp-ctl/blueprints')) as PlantBlueprintCoverageView).blueprints[0]!.signals[1]!.state).toBe('missing');
  });

  it('may not drop what a list holds: an assignment, a mapped data point, a link', async () => {
    const noBlueprints = await propose({ document: { version: 1, device_profile: { id: 'comp-ctl', name: 'Example compressor controller', blueprints: [] } } });
    expect(noBlueprints).toMatchObject({ isError: true, data: expect.stringMatching(/would lose blueprints: compressor/) });
    const noKpi = await propose({
      document: {
        version: 1,
        blueprint: { ...BLUEPRINT, signals: [{ id: 'pressure', name: 'Pressure', importance: 'must', kpis: [] }, BLUEPRINT.signals[1]] },
      },
    });
    expect(noKpi).toMatchObject({ isError: true, data: expect.stringMatching(/signals\[pressure\]\.kpis: specific-energy/) });
    const noSignal = await propose({ document: { version: 1, blueprint: { ...BLUEPRINT, signals: [BLUEPRINT.signals[0]] } } });
    expect(noSignal).toMatchObject({ isError: true, data: expect.stringMatching(/would lose signals\[run_hours\]/) });
  });

  it('refuse a document that changes nothing, and links to KPI definitions that are not there', async () => {
    expect((await propose({ document: DOC })).data).toMatch(/changes nothing/);
    const r = await propose({
      document: {
        version: 1,
        blueprint: {
          ...BLUEPRINT,
          signals: [{ id: 'pressure', name: 'Pressure', importance: 'must', kpis: ['specific-energy', 'ghost'] }, BLUEPRINT.signals[1]],
        },
      },
    });
    // an unknown link is skipped with a warning, so the document changes nothing
    expect(r.isError).toBe(true);
  });

  it('a reviewer who may not see or change the blueprint any more cannot apply it; a reader sees it counted, not named', async () => {
    const r = await propose({
      document: { version: 1, blueprint: { ...BLUEPRINT, version: '2', signals: [...BLUEPRINT.signals, { id: 'leak', name: 'Leakage', importance: 'nice' }] } },
    });
    expect(r.isError, r.data).toBe(false);
    const rid = r.data.requestId;
    const { createUser } = await import('../src/auth/users.js');
    void createUser;
    const team = (await s.api('POST', '/teams', { name: 'Machines', members: ['dana'], memberRoles: { dana: ['designer'] } })).id;
    await s.api('PUT', '/owning-teams/blueprint/compressor', { teamIds: [team] });
    // olaf is a designer outside the team: the blueprint is unknown to them
    const seen = await olaf('GET', `/mcp-requests/${rid}`);
    expect(seen.proposal.hidden).toBe(1);
    expect(seen.proposal.proposed.changes).toEqual([]);
    expect(await status(olaf('POST', `/mcp-requests/${rid}/decision`, { approve: true, comment: '' }))).toMatchObject({ status: 409 });
    expect((await s.api('GET', '/plant/blueprints/compressor')).version).toBe('1');
    expect(await status(vera('GET', `/mcp-requests/${rid}`))).toMatchObject({ status: 404 });
    await s.api('PUT', '/owning-teams/blueprint/compressor', { teamIds: [] });
    const ok = await s.api('POST', `/mcp-requests/${rid}/decision`, { approve: true, comment: '' });
    expect(ok.status).toBe('done');
    expect((await s.api('GET', '/plant/blueprints/compressor')).signalCount).toBe(3);
  });
});
