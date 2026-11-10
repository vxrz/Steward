import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The plant registry for AI assistants (0.12.0): read tools with the token owner's rights (site rights; not listed and
 * refused while the module is off; plant viewers stay without MCP) and proposals – a document of the import format,
 * previewed without writing, reviewed in the AI requests inbox and applied by a person through the import core. A
 * proposal only adds and changes; removing and renaming are refused. Rights are checked when proposed and when applied;
 * a preview that changed since needs the reviewer's confirmation; proposals expire.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Plant-password-1';
let dana: Client, vera: Client, olaf: Client;
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
const toolNames = async (token: string): Promise<string[]> => (await rpc(token, 'tools/list')).body.result.tools.map((t: any) => t.name);
const mcpToken = async (c: Client, name: string): Promise<string> => (await c('POST', '/me/tokens', { name, scope: 'mcp' })).token;
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );
const db = async () => (await import('../src/db.js')).db();
const auditActions = async (entityId: string) =>
  (await db()).all<{ action: string }>('SELECT action FROM audit_log WHERE entity_id = ? ORDER BY seq', entityId).map((r) => r.action);

const PLANT_TOOLS = [
  'list_plant_sites',
  'get_plant_site',
  'list_plant_assets',
  'get_plant_asset',
  'list_device_profiles',
  'get_device_profile',
  'search_data_points',
  'get_data_point',
  'list_kpi_definitions',
  'get_kpi_definition',
  'list_data_collections',
  'get_data_collection',
  'get_plant_import_format',
];

const BASE = {
  id: 'example-cnc',
  name: 'Example CNC controller',
  manufacturer: 'Example Controls',
  description: 'A CNC controller with an OPC UA server.',
  interfaces: [
    {
      id: 'opc',
      name: 'OPC UA server',
      protocol: 'opc_ua',
      groups: [
        {
          name: 'Spindle',
          dataPoints: [{ id: 'spindle_speed', name: 'Spindle speed', unit: '/min', address: 'ns=2;s=/Spindle/Speed', aliases: ['Spindle_speedActSP1'] }],
        },
      ],
    },
  ],
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  createUser({ username: 'dana', roles: ['designer'], password: PW });
  createUser({ username: 'vera', roles: ['viewer'], password: PW });
  createUser({ username: 'olaf', roles: ['designer'], password: PW });
  createUser({ username: 'pia', roles: ['plant'], password: PW });
  [dana, vera, olaf] = await Promise.all(['dana', 'vera', 'olaf'].map((u) => s.as(u, PW)));
  await s.api('PUT', '/mcp-server', { enabled: true });
  tok.dana = await mcpToken(dana, 'mcp dana');
  tok.vera = await mcpToken(vera, 'mcp vera');
  tok.olaf = await mcpToken(olaf, 'mcp olaf');
  tok.pia = await mcpToken(await s.as('pia', PW), 'mcp pia');
});
afterAll(async () => {
  await s?.app.close();
});

describe('while the module is off', () => {
  it('lists no plant tool and refuses a call', async () => {
    const names = await toolNames(tok.dana);
    for (const t of [...PLANT_TOOLS, 'propose_plant_changes']) expect(names).not.toContain(t);
    const r = await call(tok.dana, 'list_plant_sites');
    expect(r.isError).toBe(true);
    expect(r.data).toMatch(/Unknown tool/);
  });
});

describe('read tools', () => {
  beforeAll(async () => {
    await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
    await s.api('POST', '/plant/sites', { id: 'north', name: 'North works' });
    await s.api('POST', '/plant/sites', { id: 'east', name: 'East works' });
    // only olaf sees and manages the east site
    await s.api('PUT', '/plant/sites/east/access', { acl: [{ subject: 'user:olaf', permissions: ['view', 'manage'] }] });
    await s.api('POST', '/plant/assets', { id: 'north-mill-1', siteId: 'north', name: 'Mill 1' });
    await s.api('POST', '/plant/assets', { id: 'east-mill-1', siteId: 'east', name: 'East mill 1' });
    await s.api('POST', '/plant/profiles', BASE);
    await s.api('POST', '/plant/profiles', {
      id: 'example-cnc-v2',
      name: 'Example CNC controller v2',
      extends: 'example-cnc',
      pointOverrides: [{ dataPoint: 'spindle_speed', address: 'ns=3;s=/Spindle/Speed' }],
    });
    await s.api('PUT', '/plant/assets/north-mill-1/assignment', {
      profileId: 'example-cnc-v2',
      interfaces: [{ interface: 'opc', active: true, endpoint: 'opc.tcp://north-mill-1.example.com:4840' }],
      overrides: [{ dataPoint: 'spindle_speed', address: 'ns=3;s=/Mill1/Speed', notes: 'On this mill: the main spindle.' }],
    });
    await s.api('POST', '/plant/assets/north-mill-1/collections', {
      id: 'gw',
      name: 'Gateway',
      collector: { kind: 'job', ref: 'example-gateway' },
      interfaceId: 'opc',
      description: 'What the edge gateway reads.',
      items: [
        { address: 'ns=3;s=/Mill1/Speed', outputName: 'Spindle_speedActSP1', dataPoint: 'spindle_speed' },
        { address: 'ns=3;s=/Mill1/Unknown', outputName: 'Mystery' },
      ],
    });
    await s.api('POST', '/plant/kpis', {
      id: 'example-speed-avg',
      name: 'Average spindle speed',
      inputs: [{ profile: 'example-cnc', dataPoints: ['spindle_speed'] }],
    });
  });

  it('are listed for everyone who sees the registry; plant viewers stay without MCP', async () => {
    expect(await toolNames(tok.vera)).toEqual(expect.arrayContaining(PLANT_TOOLS));
    expect(await toolNames(tok.vera)).not.toContain('propose_plant_changes');
    expect(await toolNames(tok.dana)).toEqual(expect.arrayContaining([...PLANT_TOOLS, 'propose_plant_changes']));
    const pia = await rpc(tok.pia, 'tools/list');
    expect(pia.status).toBe(403);
  });

  it('respect site rights', async () => {
    const sites = (await call(tok.vera, 'list_plant_sites', { limit: 100 })).data.items.map((x: any) => x.id);
    expect(sites).toContain('north');
    expect(sites).not.toContain('east');
    expect((await call(tok.olaf, 'list_plant_sites', { limit: 100 })).data.items.map((x: any) => x.id)).toEqual(expect.arrayContaining(['east', 'north']));
    const assets = await call(tok.vera, 'list_plant_assets', { query: 'mill 1' });
    expect(assets.data.items.map((x: any) => x.id)).toEqual(['north-mill-1']);
    expect(assets.data.items[0].profile).toBe('example-cnc-v2');
    expect((await call(tok.olaf, 'list_plant_assets', { siteId: 'east' })).data.items.map((x: any) => x.id)).toEqual(['east-mill-1']);
    expect((await call(tok.vera, 'list_plant_assets', { siteId: 'east' })).data.items).toEqual([]);
    const hidden = await call(tok.vera, 'get_plant_asset', { assetId: 'east-mill-1' });
    expect(hidden.isError).toBe(true);
    expect(hidden.data).toMatch(/not found/);
    expect((await call(tok.vera, 'list_data_collections', { assetId: 'east-mill-1' })).isError).toBe(true);
    expect((await call(tok.olaf, 'get_plant_asset', { assetId: 'east-mill-1' })).data.youMayChange).toBe(true);
  });

  it('read an asset with its assignment, overrides and the assignment in the import format', async () => {
    const a = (await call(tok.vera, 'get_plant_asset', { assetId: 'north-mill-1' })).data;
    expect(a.assignment.profile).toEqual({ id: 'example-cnc-v2', name: 'Example CNC controller v2' });
    expect(a.assignment.overrides[0]).toMatchObject({ dataPoint: 'spindle_speed', address: 'ns=3;s=/Mill1/Speed', notes: 'On this mill: the main spindle.' });
    expect(a.assignmentFile).toMatchObject({ asset: 'north-mill-1', profile: 'example-cnc-v2', overrides: [{ data_point: 'spindle_speed' }] });
    expect(a.youMayChange).toBe(false);
    expect(JSON.stringify(a)).not.toMatch(/acl|permissions/);
  });

  it('read a profile resolved, with its chain, where items come from and its own part', async () => {
    const p = (await call(tok.vera, 'get_device_profile', { profileId: 'example-cnc-v2' })).data;
    expect(p).toMatchObject({
      extends: 'example-cnc',
      bases: [{ id: 'example-cnc' }],
      description: 'A CNC controller with an OPC UA server.',
      descriptionFrom: 'example-cnc',
    });
    const point = p.interfaces[0].groups[0].dataPoints[0];
    expect(point).toMatchObject({
      id: 'spindle_speed',
      address: 'ns=3;s=/Spindle/Speed',
      knownAs: ['Spindle_speedActSP1'],
      origin: 'inherited from example-cnc, changed here: address',
    });
    expect(p.file).toEqual({
      id: 'example-cnc-v2',
      name: 'Example CNC controller v2',
      extends: 'example-cnc',
      interfaces: [{ id: 'opc', groups: [{ name: 'Spindle', data_points: [{ id: 'spindle_speed', address: 'ns=3;s=/Spindle/Speed' }] }] }],
    });
    const slim = (await call(tok.vera, 'get_device_profile', { profileId: 'example-cnc-v2', points: false })).data;
    expect(slim.interfaces[0].groups[0]).toEqual({ name: 'Spindle', dataPointCount: 1 });
  });

  it('find data points by a known-as name and read who delivers them and which collections read them', async () => {
    const hits = (await call(tok.vera, 'search_data_points', { query: 'speedActSP1' })).data;
    expect(hits.items.map((h: any) => `${h.profile.id}/${h.dataPoint.id}`)).toEqual(['example-cnc/spindle_speed', 'example-cnc-v2/spindle_speed']);
    const d = (await call(tok.vera, 'get_data_point', { profileId: 'example-cnc-v2', pointId: 'spindle_speed' })).data;
    expect(d.assets).toEqual([
      expect.objectContaining({ asset: expect.objectContaining({ id: 'north-mill-1' }), delivers: true, address: 'ns=3;s=/Mill1/Speed' }),
    ]);
    expect(d.collections).toEqual([expect.objectContaining({ assetId: 'north-mill-1', collection: 'gw', as: ['Spindle_speedActSP1'] })]);
    expect(d.kpis.map((k: any) => k.id)).toEqual(['example-speed-avg']);
  });

  it('read KPI definitions and data collections with their coverage, in pages', async () => {
    expect((await call(tok.vera, 'list_kpi_definitions', { query: 'spindle' })).data.items.map((k: any) => k.id)).toEqual(['example-speed-avg']);
    const k = (await call(tok.vera, 'get_kpi_definition', { kpiId: 'example-speed-avg' })).data;
    expect(k.file).toMatchObject({ id: 'example-speed-avg', inputs: [{ profile: 'example-cnc', data_points: ['spindle_speed'] }] });
    const list = (await call(tok.vera, 'list_data_collections', { assetId: 'north-mill-1' })).data;
    expect(list.collections).toEqual([
      expect.objectContaining({ id: 'gw', description: 'What the edge gateway reads.', items: 2, coverage: expect.objectContaining({ mapped: 1, raw: 1 }) }),
    ]);
    const first = (await call(tok.vera, 'get_data_collection', { assetId: 'north-mill-1', collectionId: 'gw', limit: 1 })).data;
    expect(first.items).toEqual([
      expect.objectContaining({ index: 0, outputName: 'Spindle_speedActSP1', dataPoint: 'spindle_speed', assetAddress: 'ns=3;s=/Mill1/Speed' }),
    ]);
    expect(first.coverage.unknownAddresses).toEqual([1]);
    const next = (await call(tok.vera, 'get_data_collection', { assetId: 'north-mill-1', collectionId: 'gw', limit: 1, cursor: first.nextCursor })).data;
    expect(next.items).toEqual([expect.objectContaining({ index: 1, dataPoint: null })]);
    expect(next.nextCursor).toBeNull();
  });

  it('read a KPI input of several profiles with its mapping and roll-up (0.13), in the import format and the schema', async () => {
    await s.api('POST', '/plant/profiles', {
      id: 'example-lathe',
      name: 'Example lathe controller',
      interfaces: [
        { id: 'mqtt', protocol: 'mqtt', groups: [{ name: '', dataPoints: [{ id: 'SpindleRpm', name: 'Spindle speed', unit: '/min', address: 'lathe/rpm' }] }] },
      ],
    });
    await s.api('POST', '/plant/kpis', {
      id: 'example-speed-any',
      name: 'Spindle speed (any controller)',
      rollUp: 'parts',
      inputs: [{ profiles: ['example-cnc', 'example-lathe'], dataPoints: ['spindle_speed'], mapping: { 'example-lathe': { spindle_speed: 'SpindleRpm' } } }],
    });
    const list = (await call(tok.vera, 'list_kpi_definitions', { query: 'any controller' })).data;
    expect(list.items).toEqual([expect.objectContaining({ id: 'example-speed-any', profiles: ['example-cnc', 'example-lathe'] })]);
    const k = (await call(tok.vera, 'get_kpi_definition', { kpiId: 'example-speed-any' })).data;
    expect(k.file).toMatchObject({
      roll_up: 'parts',
      inputs: [{ profiles: ['example-cnc', 'example-lathe'], data_points: ['spindle_speed'], mapping: { 'example-lathe': { spindle_speed: 'SpindleRpm' } } }],
    });
    expect(k.file.inputs[0].profile).toBeUndefined();
    const part = (await call(tok.vera, 'get_plant_import_format', { part: 'KpiDefinition' })).data;
    expect(Object.keys(part.schema.properties)).toContain('roll_up');
    expect(Object.keys(part.schema.properties.inputs.items.properties)).toEqual(expect.arrayContaining(['profile', 'profiles', 'mapping']));
  });

  it('describe the import format, as a whole and by part', async () => {
    const top = (await call(tok.vera, 'get_plant_import_format')).data;
    expect(top.$id).toMatch(/plant-registry-1\.schema\.json$/);
    expect(top.parts).toEqual(expect.arrayContaining(['DeviceProfile', 'Assignment']));
    const part = (await call(tok.vera, 'get_plant_import_format', { part: 'DeviceProfile' })).data;
    expect(part.schema.properties.extends).toBeTruthy();
    expect((await call(tok.vera, 'get_plant_import_format', { part: 'Nope' })).isError).toBe(true);
  });
});

const V2_DOC = (address: string, description?: string) => ({
  version: 1,
  device_profile: {
    id: 'example-cnc-v2',
    name: 'Example CNC controller v2',
    extends: 'example-cnc',
    ...(description ? { description } : {}),
    interfaces: [{ id: 'opc', groups: [{ name: 'Spindle', data_points: [{ id: 'spindle_speed', address }] }] }],
  },
});

describe('proposals', () => {
  const propose = (token: string, args: Record<string, unknown>) =>
    call(token, 'propose_plant_changes', { title: 'Firmware 2 addresses', rationale: 'From the vendor’s firmware 2 manual (example)', ...args });

  it('refuse removals, renames, other modes and documents with problems – nothing is stored', async () => {
    const count = async () => Number((await (await db()).get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_proposals'))!.n);
    const before = await count();
    const removal = await propose(tok.dana, { document: { version: 1, remove: [{ kind: 'asset', id: 'north-mill-1' }] } });
    expect(removal).toMatchObject({ isError: true, data: expect.stringMatching(/only add and change/) });
    const missing = await propose(tok.dana, { document: V2_DOC('ns=3;s=x'), removeMissing: true });
    expect(missing).toMatchObject({ isError: true, data: expect.stringMatching(/only add and change/) });
    const rename = await propose(tok.dana, { document: V2_DOC('ns=3;s=x'), idMap: { 'example-cnc-v2': 'example-cnc-2' } });
    expect(rename).toMatchObject({ isError: true, data: expect.stringMatching(/cannot change ids/) });
    const mode = await propose(tok.dana, { document: V2_DOC('ns=3;s=x'), mode: 'replace' });
    expect(mode).toMatchObject({ isError: true, data: expect.stringMatching(/update/) });
    const bad = await propose(tok.dana, { document: { version: 1, device_profile: { id: 'Bad Id', name: 'x' } } });
    expect(bad).toMatchObject({ isError: true, data: expect.stringMatching(/problem/) });
    const same = await propose(tok.dana, { document: V2_DOC('ns=3;s=/Spindle/Speed') });
    expect(same).toMatchObject({ isError: true, data: expect.stringMatching(/changes nothing/) });
    const big = await propose(tok.dana, { document: { ...V2_DOC('ns=3;s=x'), padding: 'x'.repeat(50_000) } });
    expect(big).toMatchObject({ isError: true, data: expect.stringMatching(/too large/) });
    // a site the proposer may not change
    const east = await propose(tok.dana, { document: { version: 1, assignment: { asset: 'east-mill-1', profile: 'example-cnc' } } });
    expect(east.isError).toBe(true);
    // a viewer has no such tool
    expect((await propose(tok.vera, { document: V2_DOC('ns=3;s=x') })).data).toMatch(/Unknown tool/);
    expect(await count()).toBe(before);
  });

  let id = '';
  it('stores a proposal after a preview; nothing changes until a person applies it', async () => {
    const r = await propose(tok.dana, { document: V2_DOC('ns=4;s=/Spindle/Speed', 'The second generation.') });
    expect(r.isError, r.data).toBe(false);
    expect(r.data).toMatchObject({ status: 'pending', added: 0, changed: 1 });
    id = r.data.requestId;
    expect((await s.api('GET', '/plant/profiles/example-cnc-v2')).interfaces[0].groups[0].dataPoints[0].address).toBe('ns=3;s=/Spindle/Speed');
    expect(await auditActions(id)).toEqual(['mcp.request_created', 'plant.proposal_created']);
    const inbox = await s.api('GET', '/mcp-requests?scope=decide');
    expect(inbox.find((x: any) => x.id === id)).toMatchObject({
      kind: 'plant',
      mode: 'review',
      proposalSummary: { type: 'plant', title: 'Firmware 2 addresses', changed: 1 },
    });
    // a viewer may not see it, the proposer may see it but not apply what they may change themselves only through the inbox
    expect(await status(vera('GET', `/mcp-requests/${id}`))).toMatchObject({ status: 404 });
    const detail = await s.api('GET', `/mcp-requests/${id}`);
    expect(detail.canApprove).toBe(true);
    expect(detail.reason).toBe('From the vendor’s firmware 2 manual (example)');
    const p = detail.proposal;
    expect(p).toMatchObject({ type: 'plant', title: 'Firmware 2 addresses', changedSince: false, hidden: 0 });
    expect(p.proposed.changes).toEqual([
      expect.objectContaining({
        kind: 'profile',
        action: 'change',
        id: 'example-cnc-v2',
        diff: expect.arrayContaining([
          { path: 'description', before: '', after: 'The second generation.' },
          { path: 'pointOverrides[spindle_speed].address', before: 'ns=3;s=/Spindle/Speed', after: 'ns=4;s=/Spindle/Speed' },
        ]),
      }),
    ]);
    expect(p.now.ok).toBe(true);
    expect(p.now.changes).toEqual(p.proposed.changes);
  });

  it('is applied by a person through the import core: what the preview showed is what is written', async () => {
    const done = await s.api('POST', `/mcp-requests/${id}/decision`, { approve: true, comment: 'Checked against the manual' });
    expect(done.status).toBe('done');
    expect(done.resultBody).toMatchObject({ added: 0, changed: 1, importId: expect.stringMatching(/^pim_/) });
    expect(done.proposal.importId).toBe(done.resultBody.importId);
    const v2 = await s.api('GET', '/plant/profiles/example-cnc-v2');
    expect(v2.interfaces[0].groups[0].dataPoints[0].address).toBe('ns=4;s=/Spindle/Speed');
    expect(v2).toMatchObject({ description: 'The second generation.', descriptionFrom: 'example-cnc-v2' });
    expect(await auditActions(id)).toEqual(['mcp.request_created', 'plant.proposal_created', 'mcp.request_approved', 'mcp.request_executed']);
    expect(await auditActions(done.resultBody.importId)).toEqual(['plant.imported', 'plant.proposal_applied']);
  });

  it('a preview that changed since needs the reviewer’s confirmation; the request stays open until then', async () => {
    const r = await propose(tok.dana, {
      title: 'Address of mill 1',
      document: { version: 1, assignment: { asset: 'north-mill-1', overrides: [{ data_point: 'spindle_speed', address: 'ns=3;s=/Mill1/SpeedAct' }] } },
    });
    expect(r.isError, r.data).toBe(false);
    const rid = r.data.requestId;
    // the registry changes in the meantime: what has no part in the proposal is no change of it …
    const a = await s.api('GET', '/plant/assets/north-mill-1/assignment');
    await s.api('PUT', '/plant/assets/north-mill-1/assignment', { ...a.assignment, firmware: '2.1' });
    expect((await s.api('GET', `/mcp-requests/${rid}`)).proposal.changedSince).toBe(false);
    // … the address it changes is
    await s.api('PUT', '/plant/assets/north-mill-1/assignment', {
      ...a.assignment,
      firmware: '2.1',
      overrides: [{ ...a.assignment.overrides[0], address: 'ns=3;s=/Mill1/SpeedNew' }],
    });
    const detail = await s.api('GET', `/mcp-requests/${rid}`);
    expect(detail.proposal.now.changes[0].diff).toEqual(
      expect.arrayContaining([{ path: 'overrides[spindle_speed].address', before: 'ns=3;s=/Mill1/SpeedNew', after: 'ns=3;s=/Mill1/SpeedAct' }]),
    );
    expect(detail.proposal.changedSince).toBe(true);
    expect(await status(s.api('POST', `/mcp-requests/${rid}/decision`, { approve: true, comment: '' }))).toEqual({
      status: 409,
      code: 'PLANT_PROPOSAL_CHANGED',
    });
    expect(
      await status(s.api('POST', `/mcp-requests/${rid}/decision`, { approve: true, comment: '', selection: { plant: { fingerprint: 'stale' } } })),
    ).toEqual({
      status: 409,
      code: 'PLANT_PROPOSAL_CHANGED',
    });
    expect((await s.api('GET', `/mcp-requests/${rid}`)).status).toBe('pending');
    const ok = await s.api('POST', `/mcp-requests/${rid}/decision`, {
      approve: true,
      comment: '',
      selection: { plant: { fingerprint: detail.proposal.now.fingerprint } },
    });
    expect(ok.status).toBe('done');
    const after = await s.api('GET', '/plant/assets/north-mill-1/assignment');
    expect(after.assignment).toMatchObject({ firmware: '2.1', overrides: [expect.objectContaining({ address: 'ns=3;s=/Mill1/SpeedAct' })] });
  });

  it('rights are checked again when applied: a reviewer who may not change the site cannot apply it', async () => {
    const r = await propose(tok.olaf, { title: 'East mill profile', document: { version: 1, assignment: { asset: 'east-mill-1', profile: 'example-cnc' } } });
    expect(r.isError, r.data).toBe(false);
    const rid = r.data.requestId;
    // dana manages the catalogues, but not the east site: no entry of it is shown to her, and she cannot apply it
    const seen = await dana('GET', `/mcp-requests/${rid}`);
    expect(seen.proposal).toMatchObject({ hidden: 1, proposed: { changes: [] } });
    expect(seen.proposal.now.ok).toBe(false);
    expect(await status(dana('POST', `/mcp-requests/${rid}/decision`, { approve: true, comment: '' }))).toEqual({
      status: 409,
      code: 'PLANT_PROPOSAL_INVALID',
    });
    expect((await s.api('GET', `/mcp-requests/${rid}`)).status).toBe('pending');
    // rejected with a comment: nothing changes, audited
    const rejected = await s.api('POST', `/mcp-requests/${rid}/decision`, { approve: false, comment: 'Not this mill' });
    expect(rejected).toMatchObject({ status: 'rejected', comment: 'Not this mill' });
    expect((await s.api('GET', '/plant/assets/east-mill-1/assignment')).assignment).toBeNull();
    expect(await auditActions(rid)).toEqual(['mcp.request_created', 'plant.proposal_created', 'plant.proposal_rejected', 'mcp.request_rejected']);
  });

  it('refuse dropping an item from a list inside an entry – when proposed, and when applying would drop one now', async () => {
    // the assignment's overrides as an empty list, the known-as names without the one there is
    const noOverrides = await propose(tok.dana, { title: 'No overrides', document: { version: 1, assignment: { asset: 'north-mill-1', overrides: [] } } });
    expect(noOverrides).toMatchObject({ isError: true, data: expect.stringMatching(/assignment "north-mill-1" would lose overrides\[spindle_speed\]/) });
    const v2 = (name: string, aliases: string[]) => ({
      version: 1,
      device_profile: {
        id: 'example-cnc-v2',
        name,
        extends: 'example-cnc',
        interfaces: [{ id: 'opc', groups: [{ name: 'Spindle', data_points: [{ id: 'spindle_speed', address: 'ns=4;s=/Spindle/Speed', aliases }] }] }],
      },
    });
    const lost = await propose(tok.dana, { title: 'Rename alias', document: v2('Example CNC controller v2', ['SpindleSpeed']) });
    expect(lost).toMatchObject({ isError: true, data: expect.stringMatching(/would lose .*aliases: Spindle_speedActSP1/) });
    // adding a name keeps the one there is: proposed
    const r = await propose(tok.dana, { title: 'One more alias', document: v2('Example CNC controller v2', ['Spindle_speedActSP1', 'SpindleSpeed']) });
    expect(r.isError, r.data).toBe(false);
    const rid = r.data.requestId;
    // someone adds a third name in the meantime: applying the proposal would drop it now
    const own = (await s.api('GET', '/plant/profiles/example-cnc-v2')).own;
    const { id: _id, ...body } = own;
    body.pointOverrides = body.pointOverrides.map((o: any) => (o.dataPoint === 'spindle_speed' ? { ...o, aliases: ['Spindle_speedActSP1', 'Third'] } : o));
    await s.api('PUT', '/plant/profiles/example-cnc-v2', body);
    const detail = await s.api('GET', `/mcp-requests/${rid}`);
    expect(detail.proposal.now.ok).toBe(false);
    expect(detail.proposal.now.problems.map((p: any) => p.message).join(' ')).toMatch(/would lose .*aliases: Third/);
    expect(
      await status(
        s.api('POST', `/mcp-requests/${rid}/decision`, { approve: true, comment: '', selection: { plant: { fingerprint: detail.proposal.now.fingerprint } } }),
      ),
    ).toEqual({ status: 409, code: 'PLANT_PROPOSAL_REMOVES' });
    expect((await s.api('GET', `/mcp-requests/${rid}`)).status).toBe('pending');
    expect((await s.api('GET', '/plant/profiles/example-cnc-v2')).own.pointOverrides[0].aliases).toEqual(['Spindle_speedActSP1', 'Third']);
    await s.api('POST', `/mcp-requests/${rid}/decision`, { approve: false, comment: '' });
  });

  it('take data collections and their sinks end to end; never credentials, never a dropped item', async () => {
    const current = (await call(tok.dana, 'get_data_collection', { assetId: 'north-mill-1', collectionId: 'gw', file: true })).data;
    expect(current.file.collections[0]).toMatchObject({ id: 'gw', items: [{ output_name: 'Spindle_speedActSP1' }, { output_name: 'Mystery' }] });
    const net = (extra: object) => ({ version: 1, asset_networks: [{ asset: 'north-mill-1', ...extra }] });
    // a new collection with an item mapped, a raw one, and a sink with a transformation step
    const collection = {
      id: 'etl',
      name: 'Nightly ETL',
      collector: { kind: 'job', ref: 'example-etl' },
      interface: 'opc',
      items: [
        { address: 'ns=3;s=/Mill1/Speed', output_name: 'speed', data_point: 'spindle_speed', description: 'Averaged per minute' },
        { address: 'ns=3;s=/Mill1/Temp', output_name: 'temp' },
      ],
      settings: [{ key: 'bufferEnabled', value: 'true' }],
    };
    const sinks = {
      collection: 'etl',
      sinks: [{ id: 'lake', name: 'Data lake', object: 'raw/mill1', transforms: [{ kind: 'aggregate', field: 'speed', window: '1 min', function: 'avg' }] }],
    };
    // a credential anywhere is refused, a redacted one is fine
    const secret = await propose(tok.dana, {
      title: 'ETL',
      document: net({ collections: [{ ...collection, settings: [{ key: 'password', value: 'hunter2' }] }], collection_sinks: [sinks] }),
    });
    expect(secret).toMatchObject({ isError: true, data: expect.stringMatching(/looks like a credential[\s\S]*collections\[0\]\.settings\[0\]\.value/) });
    const url = await propose(tok.dana, {
      title: 'Endpoint',
      document: {
        version: 1,
        assignment: { asset: 'north-mill-1', interfaces: [{ interface: 'opc', endpoint: 'opc.tcp://ops:s3cret@north-mill-1.example.com:4840' }] },
      },
    });
    expect(url).toMatchObject({ isError: true, data: expect.stringMatching(/credential[\s\S]*assignment\.interfaces\[0\]\.endpoint/) });
    // dropping an item of an existing collection, or one of its sinks, is refused
    const fewer = await propose(tok.dana, {
      title: 'Fewer',
      document: net({ collections: [{ ...current.file.collections[0], items: current.file.collections[0].items.slice(0, 1) }] }),
    });
    expect(fewer).toMatchObject({ isError: true, data: expect.stringMatching(/collection "north-mill-1\/gw" would lose items\[ns=3;s=\/Mill1\/Unknown\]/) });
    const ok = await propose(tok.dana, {
      title: 'Nightly ETL of mill 1',
      document: net({ collections: [{ ...collection, settings: [{ key: 'apiKey', value: '[redacted]' }] }], collection_sinks: [sinks] }),
    });
    expect(ok.isError, ok.data).toBe(false);
    expect(ok.data).toMatchObject({ added: 1, changed: 1 });
    const detail = await s.api('GET', `/mcp-requests/${ok.data.requestId}`);
    expect(detail.proposal.proposed.changes.map((c: any) => `${c.kind}:${c.action}:${c.id}`)).toEqual([
      'collection:add:north-mill-1/etl',
      'collection_sinks:change:north-mill-1/etl',
    ]);
    const done = await s.api('POST', `/mcp-requests/${ok.data.requestId}/decision`, { approve: true, comment: '' });
    expect(done.status).toBe('done');
    const etl = await s.api('GET', '/plant/assets/north-mill-1/collections/etl');
    expect(etl).toMatchObject({ collector: { ref: 'example-etl' }, sinks: [{ id: 'lake', transforms: [{ kind: 'aggregate', window: '1 min' }] }] });
    expect(etl.items.map((i: any) => i.dataPoint)).toEqual(['spindle_speed', null]);
    // now a sink less is a dropped item
    const noSink = await propose(tok.dana, { title: 'No sink', document: net({ collection_sinks: [{ collection: 'etl', sinks: [] }] }) });
    expect(noSink).toMatchObject({ isError: true, data: expect.stringMatching(/would lose sinks\[lake\]/) });
  });

  it('expires like other proposals; the module off hides the tools again', async () => {
    const r = await propose(tok.dana, {
      title: 'New KPI',
      document: { version: 1, kpi_definition: { id: 'example-speed-max', name: 'Highest spindle speed' } },
    });
    expect(r.isError, r.data).toBe(false);
    const { expireRequests } = await import('../src/mcp/requests.js');
    expireRequests(new Date(Date.now() + 15 * 86_400_000).toISOString());
    expect((await s.api('GET', `/mcp-requests/${r.data.requestId}`)).status).toBe('expired');
    expect(await status(s.api('GET', '/plant/kpis/example-speed-max'))).toMatchObject({ status: 404 });
    await s.api('PUT', '/settings/plant', { enabled: false, enterprise: 'Brightwater Components', labels: {}, fields: {} });
    expect(await toolNames(tok.dana)).not.toContain('propose_plant_changes');
    expect(await toolNames(tok.dana)).not.toContain('list_plant_sites');
    await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  });
});
