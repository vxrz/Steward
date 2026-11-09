import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Data collections (0.11.0, ADR 0019): what a collector reads from an asset. The importers (gateway JSON with
 * datasets, the generic CSV/YAML table, the Industrial Edge OPC UA connector export, Node-RED flows), address and name
 * matching against the asset's model (two assets of one profile with different addresses, known-as names, remembered
 * mappings, mapping files, fuzzy suggestions that wait for confirmation), what confirming writes (the asset's address,
 * known-as names, asset additions), coverage, the data flow and lineage through collections, rights and audit.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Plant-password-1';
const users: Record<string, Client> = {};
const EX = path.resolve(import.meta.dirname, '../../examples/plant/collections');
const example = (name: string) => ({ name, content: fs.readFileSync(path.join(EX, name), 'utf8') });
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );
const GW = { kind: 'job', ref: 'edge-gateway-1', host: null };
const preview = (asset: string, body: object) => s.api('POST', `/plant/assets/${asset}/collections/import/preview`, { collector: GW, ...body });
const apply = (asset: string, body: object, as: Client = s.api) => as('POST', `/plant/assets/${asset}/collections/import`, { collector: GW, ...body });
type Item = {
  index: number;
  address: string;
  outputName: string;
  suggestion: { dataPoint: string | null; reason: string; confidence: number; accepted: boolean };
};
const items = (p: { collections: { items: Item[] }[] }) => p.collections.flatMap((c) => c.items);
const byName = (p: { collections: { items: Item[] }[] }, n: string) => items(p).find((i) => i.outputName === n)!;

const PROFILE = {
  id: 'example-cnc-840',
  name: 'Example CNC 840',
  interfaces: [
    {
      id: 'cnc',
      name: 'CNC variables',
      protocol: 'other',
      groups: [
        {
          name: 'State',
          dataPoints: [
            { id: 'program_status', name: 'Program status', dataType: 'Int32', address: '/Channel/State/progStatus[u1]', aliases: ['ProgStatus'] },
            { id: 'operating_mode', name: 'Operating mode', dataType: 'Int32', address: '/Bag/State/opMode[u1]' },
            { id: 'active_program', name: 'Active program', dataType: 'String' },
            { id: 'spindle_speed', name: 'Spindle speed', unit: '/min', address: '/Channel/Spindle/actSpeed[u1]' },
            { id: 'spindle_load', name: 'Spindle load', unit: '%' },
            { id: 'feed_override', name: 'Feed override', unit: '%' },
            { id: 'coolant_level', name: 'Coolant level', unit: '%' },
          ],
        },
      ],
    },
    { id: 'plc', name: 'PLC', protocol: 'other', groups: [{ name: '', dataPoints: [{ id: 'door_closed', name: 'Door closed', address: 'db13.dbx2.0' }] }] },
  ],
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  for (const [name, role] of [
    ['vera', 'viewer'],
    ['pia', 'plant'],
    ['olaf', 'operator'],
  ] as const) {
    createUser({ username: name, roles: [role], password: PW });
    users[name] = await s.as(name, PW);
  }
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  await s.api('POST', '/plant/sites', { id: 'east', name: 'East works' });
  await s.api('POST', '/plant/profiles', PROFILE);
  for (const [id, prog] of [
    ['east-mill-1', '/Channel/ProgramPointer/progName[u1,1]'],
    ['east-mill-2', '/NC/_N_CH_GD2_ACX/PROG_NAME'],
  ]) {
    await s.api('POST', '/plant/assets', { id, siteId: 'east', name: id });
    // the same data point under another address on each asset: the asset's binding (an override)
    await s.api('PUT', `/plant/assets/${id}/assignment`, {
      profileId: 'example-cnc-840',
      interfaces: [
        { interface: 'cnc', active: true },
        { interface: 'plc', active: true },
      ],
      overrides: [{ dataPoint: 'active_program', address: prog }],
    });
  }
});
afterAll(async () => {
  await s?.app.close();
});

describe('importers', () => {
  it('gateway JSON with datasets: one collection per dataset, triggers, access patterns and settings – detected by structure', async () => {
    const p = await preview('east-mill-1', { files: [example('example-gateway-datasets.json')] });
    expect(p.problems).toEqual([]);
    expect(p.format).toBe('gateway_json');
    expect(p.preview).toBe(false);
    expect(p.collections.map((c: { name: string; action: string }) => `${c.name}:${c.action}`)).toEqual([
      'machine-state:add',
      'spindle:add',
      'axes:add',
      'part-counter:add',
    ]);
    expect(items(p)).toHaveLength(35);
    const state = p.collections[0].values;
    expect(state).toMatchObject({ mode: 'on_change', debounceMs: 250, composition: 'any' });
    expect(state.triggers).toEqual([
      { name: 'program status changed', condition: 'anychange', referencePoint: '/Channel/State/progStatus[u1]', referenceValue: '' },
    ]);
    expect(p.collections[1].values).toMatchObject({ mode: 'interval', intervalMs: 1000 });
    expect(p.collections[3].values.triggers).toHaveLength(2);
    expect(state.access).toEqual({
      read: ['/Channel/', '/Bag/', '/Nck/', '/DriveHsa/', '/NC/', 'DB13.', 'DB20.'],
      write: ['/NC/_N_CH_GD2_ACX/', 'DB20.'],
      create: [],
      delete: [],
    });
    expect(state.settings).toEqual(
      expect.arrayContaining([
        { key: 'type', value: 'example-gateway-config' },
        { key: 'bufferEnabled', value: 'true' },
        { key: 'eventsToIgnore', value: 'heartbeat' },
      ]),
    );
    // another value of `type` – or none – reads the same
    const other = JSON.parse(example('example-gateway-datasets.json').content);
    delete other.type;
    const q = await preview('east-mill-1', { files: [{ name: 'x.json', content: JSON.stringify(other) }] });
    expect(q.format).toBe('gateway_json');
    expect(items(q)).toHaveLength(35);
  });

  it('the generic table: CSV with ";" and a header row, YAML with the same keys', async () => {
    const csv = await preview('east-mill-1', { files: [example('example-table.csv')] });
    expect(csv.problems).toEqual([]);
    expect(csv.format).toBe('table');
    expect(csv.collections.map((c: { name: string; items: unknown[] }) => `${c.name}:${c.items.length}`)).toEqual(['energy:3', 'state:1']);
    expect(csv.collections[0].values).toMatchObject({ mode: 'interval', intervalMs: 10000, destination: { ref: 'plant.energy' } });
    expect(csv.collections[0].items[0].transform.note).toBe('scale 0.001 (W to kW)');
    const yaml = await preview('east-mill-1', { files: [example('example-table.yaml')] });
    expect(yaml.collections.map((c: { name: string; items: unknown[] }) => `${c.name}:${c.items.length}`)).toEqual(['energy:2', 'state:1']);
    const bad = await preview('east-mill-1', { files: [{ name: 'bad.csv', content: 'a,b\n1,2\n' }] });
    expect(bad.problems.length).toBeGreaterThan(0);
  });

  it('the Industrial Edge OPC UA connector export (preview): one collection per connection, cycle and mode; no sign-in data', async () => {
    const p = await preview('east-mill-1', { files: [example('example-ie-opcua-connector.json')] });
    expect(p).toMatchObject({ format: 'ie_opcua', preview: true, problems: [] });
    expect(
      p.collections.map((c: { name: string; values: { mode: string; intervalMs: number } }) => `${c.name}|${c.values.mode}|${c.values.intervalMs}`),
    ).toEqual(['mill-line-1 · 1000 ms CyclicOnChange|on_change|1000', 'mill-line-1 · 100 ms Cyclic|interval|100']);
    expect(p.collections[0].values.access.write).toEqual(['ns=2;s=Channel1.FeedOverride']);
    expect(JSON.stringify(p)).not.toMatch(/userID|password/i);
  });

  it('a Node-RED flow: sources followed to their sinks, transforms named, debug ignored, credentials never imported', async () => {
    const p = await preview('east-mill-1', { files: [example('example-node-red-flow.json')] });
    expect(p).toMatchObject({ format: 'node_red', problems: [] });
    expect(p.collections.map((c: { name: string }) => c.name)).toEqual(['broker', 'energy API']);
    const [mqtt, http] = p.collections;
    // the sink node is the collection's sink (0.12): its target is the broker the config node names (never its credentials)
    expect(mqtt.values).toMatchObject({ intervalMs: 5000, destination: { ref: 'mqtt.example.com:8883', path: 'plant/rvs-mill-01/spindle' } });
    expect(mqtt.values.sinks).toMatchObject([{ name: 'broker', ref: 'mqtt.example.com:8883', object: 'plant/rvs-mill-01/spindle', imported: true }]);
    expect(mqtt.items.map((i: Item) => `${i.outputName}@${i.address}`)).toEqual([
      'SpindleSpeed@ns=2;s=Spindle1.ActualSpeed',
      'SpindleLoad@ns=2;s=Spindle1.Load',
    ]);
    expect(mqtt.items[0].transform.note).toBe('change "to topic" (set msg.topic to plant/rvs-mill-01/spindle) → function "rpm to 1/s"');
    expect(http.items[0]).toMatchObject({ outputName: 'MeterPower', address: 'input:65,2' });
    expect(http.values.intervalMs).toBe(10000);
    expect(JSON.stringify(p)).not.toContain('never-imported');
  });
});

describe('addresses and names', () => {
  it('normalises addresses: whitespace in indexes, case where the protocol ignores it, Modbus spellings, OPC UA string ids', async () => {
    const { sameAddress, addressKeys } = await import('../src/plant/collections-model.js');
    expect(sameAddress('/Channel/ProgramPointer/progName[u1, 1]', '/Channel/ProgramPointer/progName[u1,1]', null)).toBe(true);
    expect(sameAddress('DB13.DBX2.0', 'db13.dbx2.0', 'other')).toBe(true);
    expect(sameAddress('hr:100', 'holding:100', 'modbus_tcp')).toBe(true);
    expect(sameAddress('ns=2;s=/Channel/State/progStatus[u1]', '/Channel/State/progStatus[u1]', 'opc_ua')).toBe(true);
    expect(sameAddress('ns=2;s=Spindle.Speed', 'ns=2;s=spindle.speed', 'opc_ua')).toBe(false);
    expect(addressKeys('', null)).toEqual([]);
  });

  it('two assets of one profile: each matches its own address of the same data point', async () => {
    const a = await preview('east-mill-1', { files: [example('example-gateway-datasets.json')] });
    const b = await preview('east-mill-2', { files: [example('example-gateway-datasets.json')] });
    // asset 1 reads the program name at the gateway's address, asset 2 at the NC user data
    expect(byName(a, 'NCProgram').suggestion).toMatchObject({ dataPoint: 'active_program', reason: 'address', accepted: true });
    expect(byName(b, 'NCProgram').suggestion.reason).not.toBe('address');
    expect(byName(a, 'ProgStatus').suggestion).toMatchObject({ dataPoint: 'program_status', reason: 'address' });
    expect(byName(a, 'DoorClosed').suggestion).toMatchObject({ dataPoint: 'door_closed', reason: 'address' });
    // a known-as name, a name, a fuzzy name that waits for confirmation
    expect(byName(a, 'OperatingMode').suggestion).toMatchObject({ dataPoint: 'operating_mode', reason: 'address' });
    expect(byName(a, 'FeedOverride').suggestion).toMatchObject({ dataPoint: 'feed_override', reason: 'name', accepted: true });
    expect(byName(a, 'SpindleLoad').suggestion).toMatchObject({ dataPoint: 'spindle_load', reason: 'name' });
    const fuzzy = byName(a, 'SpindleMotorTemp').suggestion;
    expect(fuzzy.reason === 'fuzzy' ? fuzzy.accepted : false).toBe(false);
    expect(byName(a, 'X_Pos').suggestion.dataPoint === null || byName(a, 'X_Pos').suggestion.accepted === false).toBe(true);
  });
});

describe('applying an import', () => {
  it('writes the collections, the asset’s address, known-as names, an asset addition; a re-import needs no new work', async () => {
    const pv = await preview('east-mill-2', { files: [example('example-gateway-datasets.json')] });
    const at = (n: string) => {
      const c = pv.collections.find((x: { items: Item[] }) => x.items.some((i) => i.outputName === n));
      return { collection: c.id, index: c.items.find((i: Item) => i.outputName === n).index };
    };
    const r = await apply('east-mill-2', {
      files: [example('example-gateway-datasets.json')],
      decisions: [
        // the gateway reads the program name at another address: confirm it, and record it as this asset's address
        { ...at('NCProgram'), dataPoint: 'active_program', recordAddress: true, alias: 'profile' },
        // a gateway name only this collector uses
        { ...at('SpindleMotorTemp'), dataPoint: 'coolant_level', alias: 'collector' },
        // an unknown address becomes a data point of this asset
        { ...at('X_Pos'), dataPoint: null, add: { target: 'asset', id: 'axis_x_position', name: 'X axis position', interface: 'cnc', group: 'Axes' } },
        // two items to one data point within a collection: allowed, flagged
        { ...at('ChannelStatus'), dataPoint: 'program_status' },
      ],
    });
    expect(r.collections).toMatchObject({ added: 4, changed: 0, removed: 0 });
    expect(r).toMatchObject({ addresses: 1, aliases: { profile: 1, collector: 1 }, added: { asset: 1, profile: 0 } });
    const a = await s.api('GET', '/plant/assets/east-mill-2/assignment');
    expect(a.assignment.overrides.find((o: { dataPoint: string }) => o.dataPoint === 'active_program').address).toBe('/Channel/ProgramPointer/progName[u1, 1]');
    expect(a.assignment.additions.dataPoints).toMatchObject([{ id: 'axis_x_position', interface: 'cnc', group: 'Axes', aliases: ['X_Pos'] }]);
    const prof = await s.api('GET', '/plant/profiles/example-cnc-840');
    expect(prof.interfaces[0].groups[0].dataPoints.find((d: { id: string }) => d.id === 'active_program').aliases).toEqual(['NCProgram']);
    const list = await s.api('GET', '/plant/assets/east-mill-2/collections');
    const state = list.collections.find((c: { name: string }) => c.name === 'machine-state');
    expect(state.coverage.duplicates).toEqual([{ dataPoint: 'program_status', items: [0, 1] }]);
    expect(state.writes).toBe(true);
    expect(list.totals.mapped).toBeGreaterThanOrEqual(8);
    // every confirmed pair is remembered: a re-import changes nothing and needs no decisions
    const again = await preview('east-mill-2', { files: [example('example-gateway-datasets.json')] });
    // … except where the address just recorded for this asset now matches another item (the program name at a part)
    expect(again.collections.map((c: { action: string }) => c.action)).toEqual(['unchanged', 'unchanged', 'unchanged', 'change']);
    expect(byName(again, 'NCProgram_AtPart').suggestion).toMatchObject({ dataPoint: 'active_program', reason: 'address' });
    expect(byName(again, 'SpindleMotorTemp').suggestion).toMatchObject({ dataPoint: 'coolant_level', reason: 'remembered', accepted: true });
    expect(byName(again, 'X_Pos').suggestion).toMatchObject({ dataPoint: 'axis_x_position' });
    // the collector alias holds for its other assets; the profile's known-as name for every collector
    const other = await preview('east-mill-1', { files: [example('example-gateway-datasets.json')] });
    expect(byName(other, 'SpindleMotorTemp').suggestion).toMatchObject({ dataPoint: 'coolant_level', reason: 'collector_alias' });
    const node = await s.api('POST', '/plant/assets/east-mill-1/collections/import/preview', {
      collector: { kind: 'job', ref: 'another-job', host: null },
      files: [{ name: 't.csv', content: 'collection,source_address,output_name\nc,/x/y,NCProgram\n' }],
    });
    expect(byName(node, 'NCProgram').suggestion).toMatchObject({ dataPoint: 'active_program', reason: 'alias' });
  });

  it('a mapping file maps by gateway name or address; the collection page exports its mapping in that format', async () => {
    const list = await s.api('GET', '/plant/assets/east-mill-2/collections');
    const spindle = list.collections.find((c: { name: string }) => c.name === 'spindle');
    const csv = await s.api('GET', `/plant/assets/east-mill-2/collections/${spindle.id}/mapping?format=csv`);
    expect(csv.split('\n')[0]).toBe('gateway_name,address,data_point');
    expect(csv).toContain('Spindle_speedActSP1,/Channel/Spindle/actSpeed[u1],spindle_speed');
    const p = await preview('east-mill-1', {
      files: [example('example-gateway-datasets.json')],
      mappingFile: { name: 'm.csv', content: 'gateway_name,address,data_point\nSpindleTorque,,spindle_load\n,/Nck/MachineAxis/aaLoad[1],spindle_load\n' },
    });
    expect(byName(p, 'SpindleTorque').suggestion).toMatchObject({ dataPoint: 'spindle_load', reason: 'mapping_file', confidence: 1 });
    expect(byName(p, 'X_Load').suggestion).toMatchObject({ dataPoint: 'spindle_load', reason: 'mapping_file' });
    const y = await s.api('GET', `/plant/assets/east-mill-2/collections/${spindle.id}/mapping?format=yaml`);
    expect(y).toContain('gateway_name: Spindle_speedActSP1');
  });

  it('coverage: data points of the interface no collection reads; edits keep the mapping', async () => {
    const list = await s.api('GET', '/plant/assets/east-mill-2/collections');
    expect(list.points.map((p: { id: string }) => p.id)).toContain('axis_x_position');
    // the data points no collection of the asset reads: the model without every mapped one
    const read = new Set(list.collections.flatMap((c: { items: { dataPoint: string | null }[] }) => c.items.map((i) => i.dataPoint).filter(Boolean)));
    const expected = list.points.map((p: { id: string }) => p.id).filter((id: string) => !read.has(id));
    expect(list.totals.notCollected).toBe(expected.length);
    const nc = new Set(list.collections.flatMap((c: { coverage: { notCollected: { id: string }[] } }) => c.coverage.notCollected.map((p) => p.id)));
    expect([...nc].sort()).toEqual([...expected].sort());
    const axes = list.collections.find((c: { name: string }) => c.name === 'axes');
    expect(axes.coverage.unknown.length).toBeGreaterThan(0);
    const {
      id: _id,
      assetId: _a,
      assetName: _n,
      siteId: _s,
      collectorRef: _c,
      collectorHost: _h,
      destinationRef: _d,
      sinkRefs: _r,
      points: _p,
      coverage: _v,
      writes: _w,
      importId: _i,
      notInSource: _x,
      updatedAt: _u,
      updatedBy: _b,
      ...body
    } = axes;
    const changed = await s.api('PUT', `/plant/assets/east-mill-2/collections/${axes.id}`, { ...body, notes: 'Axes, read by the edge gateway' });
    expect(changed.notes).toBe('Axes, read by the edge gateway');
    expect(await status(s.api('PUT', `/plant/assets/east-mill-2/collections/${axes.id}`, { ...body, interfaceId: 'nope' }))).toEqual({
      status: 400,
      code: 'PLANT_COLLECTION_INVALID',
    });
  });

  it('the data flow and the lineage run through the collections: collector → destination', async () => {
    await s.api('POST', '/plant/assets/east-mill-1/collections', {
      id: 'opc-to-historian',
      name: 'To the historian',
      collector: { kind: 'job', ref: 'historian-etl' },
      interfaceId: 'cnc',
      destination: { kind: 'other', ref: 'Plant historian', path: 'mill/state' },
      items: [{ address: '/Channel/State/progStatus[u1]', outputName: 'ProgStatus', dataPoint: 'program_status' }],
    });
    const flow = await s.api('GET', '/plant/assets/east-mill-1/flow');
    const ids = flow.nodes.map((n: { id: string }) => n.id);
    expect(ids).toContain('coll:job:historian-etl');
    const path = flow.paths.find((p: { id: string }) => p.id === 'program_status');
    expect(path.nodes).toEqual(expect.arrayContaining(['coll:job:historian-etl', expect.stringMatching(/^tgt:/)]));
    const lineage = await s.api('GET', '/plant/profiles/example-cnc-840/points/program_status/lineage');
    expect(lineage.nodes.map((n: { id: string }) => n.id)).toContain('coll:job:historian-etl');
    const readers = await s.api('GET', '/plant/profiles/example-cnc-840/points/program_status/collections');
    expect(readers.map((r: { assetId: string; id: string; outputNames: string[] }) => `${r.assetId}/${r.id}:${r.outputNames}`)).toContain(
      'east-mill-1/opc-to-historian:ProgStatus',
    );
    const mine = await s.api('GET', '/plant/collections?collectorKind=job&collectorRef=edge-gateway-1');
    expect(mine.map((c: { assetId: string }) => c.assetId)).toEqual(['east-mill-2', 'east-mill-2', 'east-mill-2', 'east-mill-2']);
  });
});

describe('rights, audit and the public API', () => {
  it('who sees the site sees its collections; who manages it imports; the profile needs the catalogue right', async () => {
    expect((await users.vera!('GET', '/plant/assets/east-mill-2/collections')).collections.length).toBe(4);
    expect((await users.pia!('GET', '/plant/assets/east-mill-2/collections')).canManage).toBe(false);
    expect(await status(apply('east-mill-2', { files: [example('example-table.csv')] }, users.vera!))).toMatchObject({ status: 403 });
    expect(await status(users.vera!('DELETE', '/plant/assets/east-mill-1/collections/opc-to-historian'))).toMatchObject({ status: 403 });
    // a site manager who may not change profiles: a known-as name on the profile is refused, one for the collector is not
    await s.api('PUT', '/plant/sites/east/access', { acl: [{ subject: 'user:olaf', permissions: ['view', 'manage'] }] });
    const pv = await users.olaf!('POST', '/plant/assets/east-mill-1/collections/import/preview', {
      collector: GW,
      files: [{ name: 't.csv', content: 'collection,source_address,output_name\nc,/Bag/State/opMode[u1],OpMode\n' }],
    });
    expect(pv.canManageCatalogue).toBe(false);
    const d = { collection: pv.collections[0].id, index: 0, dataPoint: 'operating_mode' };
    const body = { collector: GW, files: [{ name: 't.csv', content: 'collection,source_address,output_name\nc,/Bag/State/opMode[u1],OpMode\n' }] };
    expect(await status(users.olaf!('POST', '/plant/assets/east-mill-1/collections/import', { ...body, decisions: [{ ...d, alias: 'profile' }] }))).toEqual({
      status: 400,
      code: 'PLANT_COLLECTION_IMPORT_INVALID',
    });
    const ok = await users.olaf!('POST', '/plant/assets/east-mill-1/collections/import', { ...body, decisions: [{ ...d, alias: 'collector' }] });
    expect(ok.aliases.collector).toBe(1);
    // a site the reader may not see: its asset's collections answer 404
    await s.api('PUT', '/plant/sites/east/access', { acl: [{ subject: 'role:admin', permissions: ['view', 'manage'] }] });
    expect(await status(users.vera!('GET', '/plant/assets/east-mill-2/collections'))).toMatchObject({ status: 404 });
    expect(await users.vera!('GET', '/plant/collections?collectorKind=job&collectorRef=edge-gateway-1')).toEqual([]);
    await s.api('PUT', '/plant/sites/east/access', { acl: [] });
  });

  it('every change is audited; the public API reads them like data paths', async () => {
    for (const action of ['plant.collection_imported', 'plant.collection_created', 'plant.collection_updated'])
      expect((await s.api('GET', `/audit?action=${action}`)).length, action).toBeGreaterThan(0);
    await s.api('DELETE', '/plant/assets/east-mill-1/collections/opc-to-historian');
    expect((await s.api('GET', '/audit?action=plant.collection_deleted')).length).toBe(1);
    const res = await fetch(`${s.base}/api/v1/plant/assets/east-mill-2/collections`, { headers: { authorization: `Bearer ${await token()}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.collections).toHaveLength(4);
    expect(body.canManage).toBeUndefined();
  });

  it('removing the asset removes its collections and remembered mappings', async () => {
    await s.api('DELETE', '/plant/assets/east-mill-2');
    const { db } = await import('../src/db.js');
    expect(db().get("SELECT 1 FROM plant_collections WHERE asset_id = 'east-mill-2'")).toBeUndefined();
    expect(db().get("SELECT 1 FROM plant_collection_mappings WHERE asset_id = 'east-mill-2'")).toBeUndefined();
    // the collector alias (no asset) stays
    expect(db().get("SELECT 1 FROM plant_collection_mappings WHERE asset_id = '' AND gateway_name = 'SpindleMotorTemp'")).toBeDefined();
  });
});

async function token(): Promise<string> {
  const t = await s.api('POST', '/me/tokens', { name: 'collections-test', scope: 'read' });
  return t.token as string;
}
