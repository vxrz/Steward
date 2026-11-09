import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Data collections in the plant import format (0.12): `asset_networks[].collections` with their items (each mapped to a
 * data point of the asset's model, or raw) and descriptions, next to `collection_sinks`. The export writes them and they
 * import back unchanged; an import adds and changes them with the preview and the rights of other entries, checks the
 * data points against the asset's model after the import, and never removes a collection.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let vera: Client;
const PW = 'Plant-password-1';
const file = (content: object, name = 'collections.plant.yaml') => ({ name, content: YAML.stringify({ version: 1, ...content }) });
const preview = (content: object, as: Client = s.api) => as('POST', '/plant/import/preview', { files: [file(content)], mode: 'update' });
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );

const COLLECTION = {
  id: 'edge',
  name: 'Edge gateway – machine state',
  collector: { kind: 'job', ref: 'example-edge-gateway' },
  interface: 'opc',
  mode: 'on_change',
  debounce_ms: 500,
  description: 'What the edge gateway reads for the availability KPI.',
  access: { read: ['ns=2;s=/Channel/*'] },
  settings: [{ key: 'bufferEnabled', value: 'true' }],
  items: [
    { address: 'ns=2;s=/Channel/State/progStatus', output_name: 'ProgStatus', data_point: 'prog_status', description: 'The NC program state.' },
    { address: 'ns=2;s=/Channel/State/feedOvr', output_name: 'FeedOverride', data_point: 'feed_override' },
    { address: 'ns=2;s=/Channel/Unknown', output_name: 'Mystery' },
  ],
};
const SINKS = {
  collection: 'edge',
  sinks: [
    {
      id: 'historian',
      name: 'Historian',
      object: 'plant/south/mill-1',
      transforms: [{ kind: 'rename', field: 'ProgStatus', expression: 'prog_status' }],
      mappings: [{ item: 'ProgStatus', target: 'prog_status' }],
    },
  ],
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  createUser({ username: 'vera', roles: ['viewer'], password: PW });
  vera = await s.as('vera', PW);
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  await s.api('POST', '/plant/sites', { id: 'south', name: 'South works' });
  await s.api('POST', '/plant/assets', { id: 'south-mill-1', siteId: 'south', name: 'Mill 1' });
  await s.api('POST', '/plant/profiles', {
    id: 'example-nc',
    name: 'Example NC controller',
    interfaces: [
      {
        id: 'opc',
        name: 'OPC UA',
        protocol: 'opc_ua',
        groups: [{ name: 'State', dataPoints: [{ id: 'prog_status', name: 'Program status', address: 'ns=2;s=/Channel/State/progStatus' }] }],
      },
    ],
  });
  await s.api('PUT', '/plant/assets/south-mill-1/assignment', { profileId: 'example-nc', interfaces: [{ interface: 'opc', active: true }] });
});
afterAll(async () => {
  await s?.app.close();
});

describe('data collections in the file format', () => {
  it('are checked against the asset’s model after the import: a data point the same file adds counts', async () => {
    // feed_override is not in the model yet
    const alone = await preview({ asset_networks: [{ asset: 'south-mill-1', collections: [COLLECTION] }] });
    expect(alone.problems.map((p: { message: string }) => p.message)).toEqual(['The asset has no data point "feed_override"']);
    // the same file adds it to the asset: fine
    const assignment = {
      asset: 'south-mill-1',
      profile: 'example-nc',
      interfaces: [{ interface: 'opc' }],
      additions: { data_points: [{ interface: 'opc', group: 'State', id: 'feed_override', name: 'Feed override', address: 'ns=2;s=/Channel/State/feedOvr' }] },
    };
    const doc = { assignments: [assignment], asset_networks: [{ asset: 'south-mill-1', collections: [COLLECTION], collection_sinks: [SINKS] }] };
    const p = await preview(doc);
    expect(p.problems).toEqual([]);
    expect(p.changes.filter((c: { kind: string }) => c.kind === 'collection' || c.kind === 'collection_sinks')).toMatchObject([
      { kind: 'collection', action: 'add', id: 'south-mill-1/edge' },
      { kind: 'collection_sinks', action: 'change', id: 'south-mill-1/edge' },
    ]);
    await s.api('POST', '/plant/import', { files: [file(doc)], mode: 'update' });
    const c = await s.api('GET', '/plant/assets/south-mill-1/collections/edge');
    expect(c).toMatchObject({
      name: 'Edge gateway – machine state',
      collector: { kind: 'job', ref: 'example-edge-gateway', host: null },
      mode: 'on_change',
      debounceMs: 500,
      description: 'What the edge gateway reads for the availability KPI.',
      sinks: [{ id: 'historian', transforms: [{ kind: 'rename', expression: 'prog_status' }], mappings: [{ item: 'ProgStatus', target: 'prog_status' }] }],
    });
    expect(c.items.map((i: { dataPoint: string | null }) => i.dataPoint)).toEqual(['prog_status', 'feed_override', null]);
    expect(c.coverage).toMatchObject({ mapped: 2, raw: 1 });
  });

  it('are exported and import back unchanged; a change shows field by field', async () => {
    const out = YAML.parse(await s.api('GET', '/plant/export?site=south'));
    const net = (out.asset_networks ?? [out.asset_network]).find((a: { asset: string }) => a.asset === 'south-mill-1');
    expect(net.collections).toEqual([
      {
        id: 'edge',
        name: 'Edge gateway – machine state',
        collector: { kind: 'job', ref: 'example-edge-gateway' },
        interface: 'opc',
        mode: 'on_change',
        debounce_ms: 500,
        access: { read: ['ns=2;s=/Channel/*'] },
        settings: [{ key: 'bufferEnabled', value: 'true' }],
        items: [
          { address: 'ns=2;s=/Channel/State/progStatus', output_name: 'ProgStatus', data_point: 'prog_status', description: 'The NC program state.' },
          { address: 'ns=2;s=/Channel/State/feedOvr', output_name: 'FeedOverride', data_point: 'feed_override' },
          { address: 'ns=2;s=/Channel/Unknown', output_name: 'Mystery' },
        ],
        description: 'What the edge gateway reads for the availability KPI.',
      },
    ]);
    expect(net.collection_sinks[0].sinks[0]).toMatchObject({ id: 'historian', mappings: [{ item: 'ProgStatus', target: 'prog_status' }] });
    const back = await s.api('POST', '/plant/import/preview', { files: [{ name: 'south.yaml', content: YAML.stringify(out) }], mode: 'update' });
    expect(back.problems).toEqual([]);
    expect(back.changes.filter((c: { action: string }) => c.action !== 'unchanged')).toEqual([]);
    // the raw item mapped: a change of that item
    const changed = structuredClone(net);
    changed.collections[0].items[2].data_point = 'prog_status';
    const p = await preview({ asset_networks: [{ asset: 'south-mill-1', collections: changed.collections }] });
    const c = p.changes.find((x: { kind: string }) => x.kind === 'collection');
    expect(c).toMatchObject({ action: 'change', fields: ['items'] });
    expect(c.diff).toEqual([{ path: 'items[ns=2;s=/Channel/Unknown].dataPoint', before: null, after: 'prog_status' }]);
    expect(c.drops).toBeUndefined();
    // a shorter list of items: the preview says what it drops
    const fewer = await preview({
      asset_networks: [{ asset: 'south-mill-1', collections: [{ id: 'edge', name: 'Edge gateway – machine state', items: [] }] }],
    });
    expect(fewer.changes.find((x: { kind: string }) => x.kind === 'collection').drops).toHaveLength(3);
  });

  it('need the manage right of the site, a collector when new, and are never removed by an import', async () => {
    const r = await preview({ asset_networks: [{ asset: 'south-mill-1', collections: [{ ...COLLECTION, id: 'other' }] }] }, vera).catch(
      (e: { status: number }) => e,
    );
    expect(r.status ?? 200).toBe(403);
    const noCollector = await preview({ asset_networks: [{ asset: 'south-mill-1', collections: [{ id: 'new-one', name: 'New' }] }] });
    expect(noCollector.problems.map((p: { message: string }) => p.message)).toEqual(['Required (a new data collection needs its collector)']);
    const unknownInterface = await preview({ asset_networks: [{ asset: 'south-mill-1', collections: [{ ...COLLECTION, id: 'x', interface: 'nope' }] }] });
    expect(unknownInterface.problems.map((p: { message: string }) => p.message)).toEqual(['The asset has no interface "nope"']);
    // an asset's OT network without its collections leaves them where they are
    const imp = await s.api('POST', '/plant/import', { files: [file({ asset_networks: [{ asset: 'south-mill-1', devices: [] }] })], mode: 'update' });
    expect(imp.counts.remove).toBe(0);
    expect(await status(s.api('GET', '/plant/assets/south-mill-1/collections/edge'))).toEqual({ status: 200 });
  });
});
