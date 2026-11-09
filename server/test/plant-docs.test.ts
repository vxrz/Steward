import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Documents on plant entries and the gateway configurations of collection imports (0.12, docs/PLANT.md "Documents"
 * and "Gateway configurations"): the link kinds device-profile, data-collection and data-sink with their rights,
 * renames and removals; the Documents panel with what profiles, assets and collections inherit; the kept files of
 * imports – secrets removed before anything is stored, never a value in the database, the audit log or a download –
 * their versions and the comparison of two; the gateway configuration document each import keeps up to date.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Plant-password-1';
const u: Record<string, Client> = {};
const EX = path.resolve(import.meta.dirname, '../../examples/plant/collections');
const example = (name: string) => ({ name, content: fs.readFileSync(path.join(EX, name), 'utf8') });
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );
const GW = { kind: 'job', ref: 'edge-gateway-7', host: null };
const apply = (asset: string, body: object, as: Client = s.api) => as('POST', `/plant/assets/${asset}/collections/import`, { collector: GW, ...body });
const docs = (kind: string, id: string, as: Client = s.api) => as('GET', `/plant/documents?kind=${kind}&id=${encodeURIComponent(id)}`);
const titles = (g: { documents: { title: string }[] }) => g.documents.map((d) => d.title);
const db = async () => (await import('../src/db.js')).db();

/** Invented secrets of an invented gateway: none may be stored anywhere. */
const SECRETS = ['gw-admin-secret-1', 'broker-secret-2', 'tok-secret-3', 'key-secret-4', 'hdr-secret-5', 'pem-secret-6'];
const gateway = (opMode = '/Bag/State/opMode[u1]') =>
  JSON.stringify(
    {
      type: 'example-gateway-config',
      password: 'gw-admin-secret-1',
      outputs: [
        {
          name: 'historian',
          broker: 'mqtts://gw:broker-secret-2@mqtt.example.com:8883',
          topic: 'plant/north/mill',
          format: 'json',
          batchSize: 50,
          auth: { token: 'tok-secret-3' },
        },
      ],
      datasets: [
        {
          name: 'state',
          mode: 'interval',
          interval: 1000,
          connection: {
            host: '192.0.2.20',
            apiKey: 'key-secret-4',
            headers: [{ key: 'Authorization', value: 'Bearer hdr-secret-5' }],
            privateKey: { pem: 'pem-secret-6' },
          },
          datapoints: [
            { address: '/Channel/State/progStatus[u1]', name: 'ProgStatus', type: 'int', target: 'prog_status' },
            { address: opMode, name: 'OpMode', type: 'int' },
          ],
        },
      ],
    },
    null,
    2,
  );

/** Every text of every table and the audit log, as one string. */
async function everything(): Promise<string> {
  const d = await db();
  const tables =
    d.dialect === 'sqlite'
      ? d.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((t) => t.name)
      : d
          .all<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'")
          .map((t) => t.name);
  return tables.map((t) => JSON.stringify(d.all(`SELECT * FROM ${t}`))).join('\n');
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  for (const [name, role] of [
    ['vera', 'viewer'],
    ['pia', 'plant'],
    ['dana', 'designer'],
    ['adam', 'approver'],
  ] as const) {
    createUser({ username: name, roles: [role], password: PW });
    u[name] = await s.as(name, PW);
  }
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  for (const id of ['north', 'south']) await s.api('POST', '/plant/sites', { id, name: `${id} works` });
  await s.api('POST', '/plant/profiles', {
    id: 'example-cnc',
    name: 'Example CNC',
    interfaces: [
      {
        id: 'cnc',
        name: 'CNC',
        protocol: 'other',
        groups: [{ name: '', dataPoints: [{ id: 'program_status', name: 'Program status', address: '/Channel/State/progStatus[u1]' }] }],
      },
    ],
  });
  await s.api('POST', '/plant/profiles', { id: 'example-cnc-5x', name: 'Example CNC 5-axis', extends: 'example-cnc' });
  await s.api('POST', '/plant/assets', { id: 'north-mill-1', siteId: 'north', name: 'North mill 1' });
  await s.api('POST', '/plant/assets', { id: 'south-mill-1', siteId: 'south', name: 'South mill 1' });
  for (const a of ['north-mill-1', 'south-mill-1'])
    await s.api('PUT', `/plant/assets/${a}/assignment`, { profileId: 'example-cnc-5x', interfaces: [{ interface: 'cnc', active: true }] });
});
afterAll(async () => {
  await s?.app.close();
});

describe('link kinds: device profiles, data collections, sinks', () => {
  it('records link to them; the link picker finds them; labels follow the reader’s rights', async () => {
    const base = await s.api('POST', '/records', {
      type: 'DOC',
      title: 'CNC operating manual',
      links: [{ kind: 'device-profile', id: 'example-cnc', note: '' }],
    });
    await s.api('POST', '/records', { type: 'DOC', title: '5-axis addendum', links: [{ kind: 'device-profile', id: 'example-cnc-5x', note: '' }] });
    expect(base.links[0]).toMatchObject({ kind: 'device-profile', targetId: 'example-cnc', label: 'Example CNC', path: '/plant/profiles/example-cnc' });
    const found = await s.api('GET', '/link-targets?kind=device-profile&q=5-axis');
    expect(found.map((x: { id: string }) => x.id)).toEqual(['example-cnc-5x']);
    // a collection and its sink, linked as <asset>/<collection>[/<sink>]
    await apply('north-mill-1', { files: [{ name: 'gateway.json', content: gateway() }] });
    expect((await s.api('GET', '/link-targets?kind=data-collection&q=state')).map((x: { id: string }) => x.id)).toEqual(['north-mill-1/state']);
    expect((await s.api('GET', '/link-targets?kind=data-sink&q=historian')).map((x: { id: string }) => x.id)).toEqual(['north-mill-1/state/historian']);
    const sink = await s.api('POST', '/records', {
      type: 'DOC',
      title: 'Historian topics',
      links: [{ kind: 'data-sink', id: 'north-mill-1/state/historian', note: '' }],
    });
    expect(sink.links[0]).toMatchObject({ label: 'historian', path: '/plant/assets/north-mill-1/collections?collection=state' });
    // a site the reader may not see: its collections are neither found nor named, and cannot be linked
    await s.api('PUT', '/plant/sites/north/access', { acl: [{ subject: 'role:admin', permissions: ['view', 'manage'] }] });
    expect(await u.dana!('GET', '/link-targets?kind=data-collection&q=state')).toEqual([]);
    const seen = await u.dana!('GET', `/records/${sink.id}`);
    expect(seen.links[0]).toMatchObject({ visible: false, label: '', targetId: null });
    expect(
      await status(u.dana!('POST', '/records', { type: 'DOC', title: 'x', links: [{ kind: 'data-collection', id: 'north-mill-1/state', note: '' }] })),
    ).toMatchObject({ status: 404, code: 'LINK_TARGET_NOT_FOUND' });
    await s.api('PUT', '/plant/sites/north/access', { acl: [] });
  });
});

describe('the Documents panel', () => {
  it('a derived profile lists its base’s documents as inherited; an asset its profile chain’s and its collections’', async () => {
    const p = await docs('device-profile', 'example-cnc-5x');
    expect(titles(p.own)).toEqual(['5-axis addendum']);
    expect(p.inherited.map((g: { from: { id: string } }) => g.from.id)).toEqual(['example-cnc']);
    expect(titles(p.inherited[0])).toEqual(['CNC operating manual']);
    await s.api('POST', '/records', { type: 'DOC', title: 'Mill 1 handover', links: [{ kind: 'asset', id: 'north-mill-1', note: '' }] });
    const a = await docs('asset', 'north-mill-1');
    // the gateway configuration document of the import is linked to the asset and the collection, marked as generated
    expect(titles(a.own)).toEqual(['Mill 1 handover', 'Gateway configuration – North mill 1 – edge-gateway-7 – state']);
    expect(a.own.documents[1]).toMatchObject({ generated: true, typeKey: 'GWC', workflow: 'document', status: 'draft', attachments: 1 });
    // what the asset shows as its own is not listed again under where it is inherited from
    const from = a.inherited.map((g: { from: { kind: string; id: string } }) => `${g.from.kind}:${g.from.id}`);
    expect(from).toEqual(['device-profile:example-cnc-5x', 'device-profile:example-cnc', 'data-sink:north-mill-1/state/historian']);
    const c = await docs('data-collection', 'north-mill-1/state');
    expect(c.inherited.map((g: { from: { id: string } }) => g.from.id)).toEqual(['north-mill-1/state/historian']);
    expect(c.canCreate).toBe(true);
  });

  it('a record the reader may not read is counted, not named; a plant viewer reads none', async () => {
    const p = await docs('device-profile', 'example-cnc-5x', u.pia!);
    expect(p.own).toMatchObject({ documents: [], hidden: 1 });
    expect(p.inherited[0]).toMatchObject({ documents: [], hidden: 1 });
    expect(p.canCreate).toBe(false);
    expect(JSON.stringify(p)).not.toContain('addendum');
    // a site the reader may not see: its asset's panel reads like a missing asset
    await s.api('PUT', '/plant/sites/north/access', { acl: [{ subject: 'role:admin', permissions: ['view', 'manage'] }] });
    expect(await status(docs('asset', 'north-mill-1', u.vera!))).toMatchObject({ status: 404 });
    expect(await status(docs('data-collection', 'north-mill-1/state', u.vera!))).toMatchObject({ status: 404 });
    await s.api('PUT', '/plant/sites/north/access', { acl: [] });
    expect(await status(docs('data-collection', 'north-mill-1', u.vera!))).toMatchObject({ status: 400, code: 'PLANT_DOC_ID' });
  });
});

describe('the kept files of an import', () => {
  it('removes secrets before keeping the file: nested keys, auth headers, user information, a private key – paths kept, never values', async () => {
    const list = await s.api('GET', '/plant/assets/north-mill-1/collection-sources');
    expect(list.sources).toHaveLength(1);
    const v1 = list.sources[0];
    expect(v1).toMatchObject({ version: 1, fileName: 'gateway.json', format: 'gateway_json', collections: ['state'], importedBy: 'admin' });
    expect(v1.redactedPaths).toEqual(
      expect.arrayContaining([
        'password',
        'outputs[0].broker',
        'outputs[0].auth',
        'datasets[0].connection.apiKey',
        'datasets[0].connection.headers[0].value',
        'datasets[0].connection.privateKey',
      ]),
    );
    const file = await s.api('GET', `/plant/assets/north-mill-1/collection-sources/${v1.id}/file`);
    expect(file.datasets[0].datapoints).toHaveLength(2);
    expect(file.outputs[0].broker).toBe('mqtts://gw:[redacted]@mqtt.example.com:8883');
    const text = JSON.stringify(file);
    for (const x of SECRETS) expect(text).not.toContain(x);
    // nothing anywhere: the tables (collections, sources, records, attachments' rows) and the audit log
    const all = await everything();
    for (const x of SECRETS) expect(all, x).not.toContain(x);
    const audit = (await s.api('GET', '/audit?action=plant.collection_imported'))[0];
    expect(audit.details.sources[0]).toMatchObject({ id: v1.id, version: 1, redactedPaths: v1.redactedPaths.length });
    // the sink names the broker's host, not its password
    const c = await s.api('GET', '/plant/assets/north-mill-1/collections/state');
    expect(c.sinks[0]).toMatchObject({ name: 'historian', ref: 'mqtt.example.com:8883', object: 'plant/north/mill', format: 'json', imported: true });
    expect(c.sinks[0].mappings).toEqual([{ item: 'ProgStatus', target: 'prog_status', transform: '' }]);
  });

  it('Node-RED: the credentials of nodes are never kept, read or stored; function code is text and never runs', async () => {
    const flow = JSON.parse(example('example-node-red-flow.json').content) as Record<string, unknown>[];
    const fn = flow.find((n) => n.id === 'fn1')!;
    fn.func = '(globalThis as any).__plantFlowRan = true; msg.payload = msg.payload / 60; return msg;';
    const r = await apply('south-mill-1', {
      files: [{ name: 'flows.json', content: JSON.stringify(flow) }],
      collector: { kind: 'job', ref: 'node-red-1', host: null },
    });
    expect((globalThis as { __plantFlowRan?: boolean }).__plantFlowRan).toBeUndefined();
    expect(r.sources[0].redactedPaths).toBeGreaterThan(0);
    const src = (await s.api('GET', '/plant/assets/south-mill-1/collection-sources')).sources[0];
    expect(src.redactedPaths.some((p: string) => p.endsWith('.credentials'))).toBe(true);
    const kept = await s.api('GET', `/plant/assets/south-mill-1/collection-sources/${src.id}/file`);
    expect(kept.find((n: { id: string }) => n.id === 'ep1')).not.toHaveProperty('credentials');
    expect(await everything()).not.toContain('never-imported');
    // the function's code is a step of the sink, kept as text
    const broker = (await s.api('GET', '/plant/assets/south-mill-1/collections')).collections.find((c: { name: string }) => c.name === 'broker');
    expect(broker.sinks[0].transforms.map((t: { kind: string }) => t.kind)).toEqual(['rename', 'compute']);
    expect(broker.sinks[0].transforms[1].expression).toContain('__plantFlowRan');
  });

  it('CSV: kept as it is, columns with a secret header blanked; a password in a URL removed', async () => {
    const { redactCsv, redactValue } = await import('../src/plant/collections-redact.js');
    const r = redactCsv(
      'collection,source_address,api_token,notes\nc1,DB1.DBW0,csv-secret-7,ok\nc1,DB1.DBW2,,see postgres://etl:csv-secret-8@db.example.com/x\n',
    );
    expect(r.value).toBe('collection,source_address,api_token,notes\nc1,DB1.DBW0,,ok\nc1,DB1.DBW2,,see postgres://etl:[redacted]@db.example.com/x\n');
    expect(r.paths).toEqual(['column "api_token"', '(URLs with a password)']);
    expect(redactCsv('a,b\n1,2\n')).toEqual({ value: 'a,b\n1,2\n', paths: [] });
    // settings that only look like secrets stay: an authentication mode is not a password
    expect(redactValue({ authenticationMode: 'Anonymous', tokenLifetime: 3600, deep: [{ Passwd: 'x' }] })).toEqual({
      value: { authenticationMode: 'Anonymous', tokenLifetime: 3600, deep: [{ Passwd: '[redacted]' }] },
      paths: ['deep[0].Passwd'],
    });
    // an import of a table with a connection string as destination
    const csv =
      'collection,source_address,output_name,destination,sink,target\nenergy,DB1.DBW0,Power,postgres://etl:csv-secret-9@db.example.com/plant,warehouse,power_kw\n';
    await apply('south-mill-1', { files: [{ name: 'energy.csv', content: csv }], collector: { kind: 'job', ref: 'etl-1', host: null } });
    const c = await s.api('GET', '/plant/assets/south-mill-1/collections/energy');
    expect(c.sinks[0]).toMatchObject({
      name: 'warehouse',
      ref: 'postgres://etl:[redacted]@db.example.com/plant',
      mappings: [{ item: 'Power', target: 'power_kw', transform: '' }],
    });
    expect(await everything()).not.toContain('csv-secret-9');
  });

  it('the files of the import have a size limit', async () => {
    const big = 'x'.repeat(4 * 1024 * 1024 + 10);
    expect(await status(apply('north-mill-1', { files: [{ name: 'big.csv', content: big }] }))).toMatchObject({ status: 400 });
  });

  it('versions: a changed file is the next version, the same file none; two versions compared by path and by line', async () => {
    await apply('north-mill-1', { files: [{ name: 'gateway.json', content: gateway() }] });
    expect((await s.api('GET', '/plant/assets/north-mill-1/collection-sources')).sources).toHaveLength(1);
    const r = await apply('north-mill-1', { files: [{ name: 'gateway.json', content: gateway('/Bag/State/opMode[u2]') }] });
    expect(r.sources[0].version).toBe(2);
    const [v2, v1] = (await s.api('GET', '/plant/assets/north-mill-1/collection-sources?collection=state')).sources;
    expect([v2.version, v1.version]).toEqual([2, 1]);
    const d = await s.api('GET', `/plant/assets/north-mill-1/collection-sources/diff?from=${v1.id}&to=${v2.id}`);
    expect(d.kind).toBe('structure');
    expect(d.changes).toEqual([{ op: 'changed', path: 'datasets[0].datapoints[1].address', before: '/Bag/State/opMode[u1]', after: '/Bag/State/opMode[u2]' }]);
    expect(d.lines.filter((l: { op: string }) => l.op === 'removed').map((l: { text: string }) => l.text.trim())).toEqual([
      '"address": "/Bag/State/opMode[u1]",',
    ]);
    expect(d.lines.filter((l: { op: string }) => l.op === 'added').map((l: { text: string }) => l.text.trim())).toEqual([
      '"address": "/Bag/State/opMode[u2]",',
    ]);
    // whoever sees the asset reads them; a viewer of another site does not
    expect((await u.vera!('GET', '/plant/assets/north-mill-1/collection-sources')).sources).toHaveLength(2);
    await s.api('PUT', '/plant/sites/north/access', { acl: [{ subject: 'role:admin', permissions: ['view', 'manage'] }] });
    expect(await status(u.vera!('GET', `/plant/assets/north-mill-1/collection-sources/${v1.id}/file`))).toMatchObject({ status: 404 });
    await s.api('PUT', '/plant/sites/north/access', { acl: [] });
    const { lineDiff } = await import('../src/plant/collections-sources.js');
    expect(lineDiff(['a', 'b', 'c'], ['a', 'x', 'c']).map((x) => `${x.op}:${x.text}`)).toEqual(['same:a', 'removed:b', 'added:x', 'same:c']);
  });
});

describe('the gateway configuration document', () => {
  it('one per collection: created by the first import, updated by the next – people’s text kept, the file replaced', async () => {
    const coll = (await docs('data-collection', 'north-mill-1/state')).own.documents;
    expect(coll).toHaveLength(1);
    const id = coll[0].id;
    let rec = await s.api('GET', `/records/${id}`);
    expect(rec.title).toBe('Gateway configuration – North mill 1 – edge-gateway-7 – state');
    expect(rec.body).toContain('## Gateway configuration (generated)');
    expect(rec.body).toMatch(/\| Version \| 2, imported/);
    expect(rec.attachments.filter((a: { kind: string }) => a.kind === 'file').map((a: { filename: string }) => a.filename)).toEqual([
      'gateway.v2.redacted.json',
    ]);
    expect(rec.links.map((l: { kind: string; targetId: string }) => `${l.kind}:${l.targetId}`).sort()).toEqual([
      'asset:north-mill-1',
      'data-collection:north-mill-1/state',
    ]);
    // someone writes their notes; the next import keeps them
    await s.api('PUT', `/records/${id}`, { body: `${rec.body.replace('## Notes', '## Notes\n\nThe broker is run by the IT team.')}` });
    const r = await apply('north-mill-1', { files: [{ name: 'gateway.json', content: gateway('/Bag/State/opMode[u3]') }] });
    expect(r.documents).toEqual([{ collection: 'state', action: 'updated', recordId: id, number: rec.number }]);
    rec = await s.api('GET', `/records/${id}`);
    expect(rec.body).toContain('The broker is run by the IT team.');
    expect(rec.body).toMatch(/\| Version \| 3, imported/);
    expect(rec.attachments.filter((a: { kind: string }) => a.kind === 'file').map((a: { filename: string }) => a.filename)).toEqual([
      'gateway.v3.redacted.json',
    ]);
    // a published document gets a new edition (the published one stays valid until it is approved)
    await s.api('POST', `/records/${id}/transition`, { action: 'submit', editionKind: 'major', changeSummary: 'First edition' });
    await u.adam!('POST', `/records/${id}/transition`, { action: 'approve', comment: 'Fine' });
    const next = await apply('north-mill-1', { files: [{ name: 'gateway.json', content: gateway('/Bag/State/opMode[u4]') }] });
    expect(next.documents[0]).toMatchObject({ action: 'revised', recordId: id });
    rec = await s.api('GET', `/records/${id}`);
    expect(rec.status).toBe('revising');
    expect(rec.document.currentEdition).toBe('1.0');
    // in review: left as it is, the version is kept all the same
    await s.api('POST', `/records/${id}/transition`, { action: 'submit', editionKind: 'minor', changeSummary: 'New file' });
    const held = await apply('north-mill-1', { files: [{ name: 'gateway.json', content: gateway('/Bag/State/opMode[u5]') }] });
    expect(held.documents[0]).toMatchObject({ action: 'skipped', reason: 'in_review' });
    expect(held.sources[0].version).toBe(5);
  });

  it('who may not create records gets the import without the document', async () => {
    await s.api('PUT', '/plant/sites/south/access', { acl: [{ subject: 'user:pia', permissions: ['view', 'manage'] }] });
    const r = await apply(
      'south-mill-1',
      { files: [{ name: 'gateway.json', content: gateway() }], collector: { kind: 'job', ref: 'edge-gateway-9', host: null } },
      u.pia!,
    );
    expect(r.collections.added).toBe(1);
    expect(r.documents).toEqual([{ collection: 'state', action: 'skipped', recordId: null, number: null, reason: 'forbidden' }]);
    await s.api('PUT', '/plant/sites/south/access', { acl: [] });
  });
});

describe('renames and removals', () => {
  it('renaming a profile or an asset updates the links to it, its collections and sinks, and the kept files', async () => {
    await s.api('POST', '/plant/ids/rename', { kind: 'profile', scope: '', id: 'example-cnc', newId: 'example-cnc-base' });
    const p = await docs('device-profile', 'example-cnc-5x');
    expect(p.inherited[0]).toMatchObject({ from: { id: 'example-cnc-base' } });
    expect(titles(p.inherited[0])).toEqual(['CNC operating manual']);
    await s.api('POST', '/plant/ids/rename', { kind: 'asset', scope: '', id: 'north-mill-1', newId: 'north-mill-01' });
    const a = await docs('asset', 'north-mill-01');
    expect(a.inherited.map((g: { from: { id: string } }) => g.from.id)).toEqual(['example-cnc-5x', 'example-cnc-base', 'north-mill-01/state/historian']);
    expect(titles(a.own)).toEqual(['Mill 1 handover', 'Gateway configuration – North mill 1 – edge-gateway-7 – state']);
    expect(titles(a.inherited.find((g: { from: { id: string } }) => g.from.id === 'north-mill-01/state/historian'))).toEqual(['Historian topics']);
    expect((await s.api('GET', '/plant/assets/north-mill-01/collection-sources')).sources.length).toBeGreaterThan(0);
  });

  it('records linking to a profile refuse its removal unless what belongs to it goes too', async () => {
    expect(await status(s.api('DELETE', '/plant/profiles/example-cnc-5x'))).toMatchObject({ status: 409 });
    await s.api('POST', '/plant/profiles', { id: 'example-spare', name: 'Spare profile' });
    await s.api('POST', '/records', { type: 'DOC', title: 'Spare manual', links: [{ kind: 'device-profile', id: 'example-spare', note: '' }] });
    expect(await status(s.api('DELETE', '/plant/profiles/example-spare'))).toMatchObject({ status: 409, code: 'PLANT_PROFILE_LINKED' });
    const refused = await s.api('POST', '/plant/bulk', { kind: 'profile', action: 'remove', items: [{ id: 'example-spare' }] });
    expect(refused.items[0]).toMatchObject({ outcome: 'refused', reason: { code: 'PLANT_REMOVE_HAS_ENTRIES' } });
    const done = await s.api('POST', '/plant/bulk', { kind: 'profile', action: 'remove', items: [{ id: 'example-spare' }], cascade: true });
    expect(done.items[0].outcome).toBe('removed');
    const d = await db();
    expect(d.get("SELECT 1 FROM item_links WHERE to_kind = 'device-profile' AND to_id = 'example-spare'")).toBeUndefined();
  });

  it('a collection with linked records goes only with them; its kept files go with its last collection, all with the asset', async () => {
    expect(await status(s.api('DELETE', '/plant/assets/north-mill-01/collections/state'))).toMatchObject({ status: 409, code: 'PLANT_COLLECTION_LINKED' });
    await s.api('DELETE', '/plant/assets/north-mill-01/collections/state?cascade=1');
    const d = await db();
    expect(d.get("SELECT 1 FROM item_links WHERE to_kind IN ('data-collection', 'data-sink') AND to_id LIKE 'north-mill-01/%'")).toBeUndefined();
    expect((await s.api('GET', '/plant/assets/north-mill-01/collection-sources')).sources).toEqual([]);
    // the document stays (records are never removed with plant entries)
    expect((await s.api('GET', '/records?q=Historian')).length).toBeGreaterThan(0);
    // an asset takes the links to its collections and the kept files with it
    const bulk = await s.api('POST', '/plant/bulk/preview', { kind: 'asset', action: 'remove', items: [{ id: 'south-mill-1' }], cascade: true });
    expect(bulk.items[0].with.map((w: { what: string }) => w.what)).toEqual(expect.arrayContaining(['collection_source', 'link']));
    await s.api('POST', '/plant/bulk', { kind: 'asset', action: 'remove', items: [{ id: 'south-mill-1' }], cascade: true });
    expect(d.get("SELECT 1 FROM plant_collection_sources WHERE asset_id = 'south-mill-1'")).toBeUndefined();
  });
});
