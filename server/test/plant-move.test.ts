import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, loginCookie, ADMIN, setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Moving devices and data collections between assets and duplicating a device (0.16, docs/PLANT.md "Moving devices and
 * data collections"): what follows a moved device (its data paths, the collections of those paths – left and unlinked
 * by default, or moved –, maintenance windows, links, Insights Hub state, history, old ids), id conflicts, the rules
 * across sites and the rights, a collection on its own, a duplicate without what identifies the original, and the
 * change sets: preview field by field, fingerprint, revert, drafts of who may only propose, review by a second person.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let dana: Client;
let olaf: Client;
let adminCookie = '';
const PW = 'Plant-password-1';
const read = (f: string) => fs.readFileSync(path.resolve(__dirname, `../../examples/plant/${f}`), 'utf8');
const db = async () => (await import('../src/db.js')).db();
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string; body?: any }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code, body: e.body }),
  );
async function raw(cookie: string, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${s.base}/api${url}`, {
    method,
    headers: { 'x-sm-client': '1', ...authHeaders(cookie), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function setPolicy(level: 'off' | 'optional' | 'required') {
  const { currentPolicy, writePolicy } = await import('../src/auth/assurance-policy.js');
  const p = currentPolicy();
  writePolicy({ ...p, version: p.version + 1, points: { ...p.points, 'plant.changeSet': { fourEyes: level } } }, new Date().toISOString());
}
const devicesOf = async (asset: string) => (await s.api('GET', `/plant/assets/${asset}/network`)).devices.map((d: { id: string }) => d.id).sort();
const pathsOf = async (asset: string) => (await s.api('GET', `/plant/assets/${asset}/network`)).dataPaths;

const ITEM = { address: 'ns=3;s=State', outputName: 'State', dataPoint: null };
const collection = (id: string, dataPathId: string | null) => ({
  id,
  name: `Collection ${id}`,
  collector: { kind: 'job', ref: 'rvs-edge-collector' },
  dataPathId,
  destination: { kind: 'other', ref: 'Plant historian', path: 'mill/state' },
  items: [ITEM],
});

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  adminCookie = await loginCookie(s.base, ADMIN.username, ADMIN.password);
  const { createUser } = await import('../src/auth/users.js');
  createUser({ username: 'dana', roles: ['designer'], password: PW });
  createUser({ username: 'olaf', roles: ['operator'], password: PW });
  dana = await s.as('dana', PW);
  olaf = await s.as('olaf', PW);
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  await s.api('POST', '/plant/import', {
    files: [
      { name: 'brightwater.plant.yaml', content: read('brightwater.plant.yaml') },
      { name: 'ot.plant.yaml', content: read('brightwater-ot-network.plant.yaml') },
    ],
    mode: 'add',
  });
});

describe('moving devices to another asset', () => {
  let changeSetId = '';
  let windowId = '';

  it('previews the devices, the data path that names only them and the collection that stays (unlinked by default)', async () => {
    await s.api('POST', '/plant/assets/rvs-mill-01/collections', collection('state-to-historian', 'machine-state'));
    // what names the device and the collection from elsewhere
    const w = await s.api('POST', '/maintenance-windows', {
      title: 'Gateway firmware',
      startsAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
      endsAt: new Date(Date.now() + 74 * 3600_000).toISOString(),
      targets: [{ kind: 'device', id: 'rvs-mill-01/rvs-mill-01-ipc' }],
    });
    windowId = w.id;
    // an old id of the gateway (renamed once)
    await s.api('POST', '/plant/ids/rename', { kind: 'device', scope: 'rvs-mill-01', id: 'rvs-mill-01-gw', newId: 'rvs-mill-01-edge' });
    const p = await dana('POST', '/plant/move/preview', {
      kind: 'device',
      items: [
        { asset: 'rvs-mill-01', id: 'rvs-mill-01-ipc' },
        { asset: 'rvs-mill-01', id: 'rvs-mill-01-edge' },
      ],
      toAsset: 'rvs-mill-03',
    });
    expect(p.ok).toBe(true);
    expect(p.crossSite).toBe(false);
    expect(p.entries.map((e: any) => `${e.kind}:${e.id}:${e.why}`)).toEqual([
      'device:rvs-mill-01-ipc:chosen',
      'device:rvs-mill-01-edge:chosen',
      'data_path:machine-state:follows',
    ]);
    expect(p.unlinked).toEqual([{ asset: 'rvs-mill-01', id: 'state-to-historian', name: 'Collection state-to-historian', dataPath: 'machine-state' }]);
    expect(p.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    // field by field: three entries moved (asset: rvs-mill-01 → rvs-mill-03), the collection loses its data path
    const moved = p.changes.filter((c: any) => c.action === 'move');
    expect(moved.map((c: any) => `${c.kind}:${c.fromScope}→${c.scope}`).sort()).toEqual([
      'data_path:rvs-mill-01→rvs-mill-03',
      'device:rvs-mill-01→rvs-mill-03',
      'device:rvs-mill-01→rvs-mill-03',
    ]);
    expect(moved[0].diff).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'asset', before: 'rvs-mill-01', after: 'rvs-mill-03' })]));
    expect(p.changes.find((c: any) => c.kind === 'collection')).toMatchObject({ action: 'change', id: 'state-to-historian' });
    expect(p.references).toEqual(expect.arrayContaining([{ what: 'maintenance', count: 1 }]));
    // nothing changed yet
    expect(await devicesOf('rvs-mill-01')).toEqual(['rvs-mill-01-edge', 'rvs-mill-01-ipc']);
  });

  it('applies in one change set: the data path, the window, old ids and history follow; the collection stays unlinked', async () => {
    const body = {
      kind: 'device',
      items: [
        { asset: 'rvs-mill-01', id: 'rvs-mill-01-ipc' },
        { asset: 'rvs-mill-01', id: 'rvs-mill-01-edge' },
      ],
      toAsset: 'rvs-mill-03',
    };
    const p = await dana('POST', '/plant/move/preview', body);
    const r = await dana('POST', '/plant/move', { ...body, fingerprint: p.fingerprint });
    expect(r.applied).toBe(true);
    changeSetId = r.changeSetId;
    expect(await devicesOf('rvs-mill-01')).toEqual([]);
    expect(await devicesOf('rvs-mill-03')).toEqual(['rvs-mill-01-edge', 'rvs-mill-01-ipc']);
    const paths = await pathsOf('rvs-mill-03');
    expect(paths.map((x: any) => x.id)).toEqual(['machine-state']);
    expect(paths[0].devices).toEqual(['rvs-mill-01-ipc']);
    expect(paths[0].transfers[0]).toMatchObject({ peerKind: 'device', peer: 'rvs-mill-01-ipc' });
    expect(await pathsOf('rvs-mill-01')).toEqual([]);
    const c = await s.api('GET', '/plant/assets/rvs-mill-01/collections/state-to-historian');
    expect(c.dataPathId).toBeNull();
    // the window names the device under its new asset
    expect((await s.api('GET', `/maintenance-windows/${windowId}`)).targets[0].id).toBe('rvs-mill-03/rvs-mill-01-ipc');
    // the old id leads to the device on its new asset (and no longer on the old one)
    const aliases = (await s.api('GET', '/plant/aliases')).filter((a: any) => a.kind === 'device');
    expect(aliases).toEqual([expect.objectContaining({ scope: 'rvs-mill-03', oldId: 'rvs-mill-01-gw', newId: 'rvs-mill-01-edge' })]);
    // history: one row per moved entry under its new asset, with its earlier rows (the rename) along
    const h = await s.api('GET', '/plant/history?kind=device&scope=rvs-mill-03&id=rvs-mill-01-edge');
    expect(h.items.map((x: any) => x.op)).toEqual(['move', 'rename', 'add']);
    expect(h.items[0].diff).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'asset', before: 'rvs-mill-01', after: 'rvs-mill-03' })]));
    const cs = await s.api('GET', `/plant/change-sets/${changeSetId}`);
    expect(cs).toMatchObject({ state: 'applied', source: 'move' });
    expect(cs.applied.filter((e: any) => e.action === 'move')).toHaveLength(3);
    expect(cs.applied.find((e: any) => e.kind === 'data_path')).toMatchObject({ from: 'machine-state', fromScope: 'rvs-mill-01' });
    const a = (await s.api('GET', '/audit?action=plant.moved&limit=1'))[0];
    expect(a).toMatchObject({ entityId: 'rvs-mill-03', actor: 'dana' });
    expect(a.details).toMatchObject({ kind: 'device', count: 3, crossSite: false, unlinked: ['rvs-mill-01/state-to-historian'], changeSetId });
  });

  it('a stale preview is refused; reverting moves everything back and links the collection again', async () => {
    const back = { kind: 'device', items: [{ asset: 'rvs-mill-03', id: 'rvs-mill-01-ipc' }], toAsset: 'rvs-mill-01' };
    expect(await status(dana('POST', '/plant/move', { ...back, fingerprint: '0'.repeat(32) }))).toMatchObject({ status: 409, code: 'PLANT_MOVE_CHANGED' });
    const d = await dana('POST', `/plant/change-sets/${changeSetId}/revert`);
    const draft = await dana('GET', `/plant/change-sets/${d.id}`);
    expect(draft.operations.map((o: any) => o.op)).toEqual(['move', 'set']);
    const pre = await dana('POST', `/plant/change-sets/${d.id}/preview`);
    expect(pre.problems).toEqual([]);
    await dana('POST', `/plant/change-sets/${d.id}/apply`, { fingerprint: pre.fingerprint });
    expect(await devicesOf('rvs-mill-01')).toEqual(['rvs-mill-01-edge', 'rvs-mill-01-ipc']);
    expect(await devicesOf('rvs-mill-03')).toEqual([]);
    expect((await pathsOf('rvs-mill-01')).map((x: any) => x.id)).toEqual(['machine-state']);
    expect((await s.api('GET', '/plant/assets/rvs-mill-01/collections/state-to-historian')).dataPathId).toBe('machine-state');
    expect((await s.api('GET', `/maintenance-windows/${windowId}`)).targets[0].id).toBe('rvs-mill-01/rvs-mill-01-ipc');
  });

  it('asks for a new id where the target has one, and refuses a data path that would be cut in two', async () => {
    await s.api('POST', '/plant/assets/rvs-mill-02/devices', { id: 'rvs-mill-01-edge', hostname: 'other-edge' });
    const body = { kind: 'device', items: [{ asset: 'rvs-mill-01', id: 'rvs-mill-01-edge' }], toAsset: 'rvs-mill-02' };
    const p = await dana('POST', '/plant/move/preview', body);
    expect(p.ok).toBe(false);
    expect(p.entries[0]).toMatchObject({ taken: true, suggested: 'rvs-mill-01-edge-2' });
    expect(p.problems[0]).toMatchObject({ code: 'PLANT_ID_TAKEN', kind: 'device', id: 'rvs-mill-01-edge' });
    expect(await status(dana('POST', '/plant/move', body))).toMatchObject({ status: 409, code: 'PLANT_ID_TAKEN' });
    const ok = await dana('POST', '/plant/move', {
      ...body,
      ids: [{ kind: 'device', asset: 'rvs-mill-01', id: 'rvs-mill-01-edge', newId: 'rvs-mill-01-edge-2' }],
    });
    expect(ok.entries[0]).toMatchObject({ newId: 'rvs-mill-01-edge-2' });
    expect(await devicesOf('rvs-mill-02')).toEqual(['rvs-mill-01-edge', 'rvs-mill-01-edge-2', 'rvs-mill-02-ipc']);
    // a data path that names a device that stays is not cut in two
    await s.api('PUT', '/plant/assets/rvs-mill-02/paths/nc-programs', {
      subject: 'NC programs',
      description: '',
      devices: ['rvs-mill-02-ipc', 'rvs-mill-01-edge-2'],
      collector: null,
      transfers: [],
      destinations: [],
      notes: '',
    });
    const split = await dana('POST', '/plant/move/preview', {
      kind: 'device',
      items: [{ asset: 'rvs-mill-02', id: 'rvs-mill-02-ipc' }],
      toAsset: 'rvs-mill-03',
    });
    expect(split.problems).toEqual([expect.objectContaining({ code: 'PLANT_MOVE_PATH_SPLIT', kind: 'data_path', id: 'nc-programs' })]);
    expect(split.problems[0].message).toContain('rvs-mill-01-edge-2');
  });

  it('takes the collections of a data path along when asked, with their links and Insights Hub state', async () => {
    const d = await db();
    const at = new Date().toISOString();
    d.run(
      "INSERT INTO item_links (id, from_kind, from_id, to_kind, to_id, created_at, created_by) VALUES ('lnk_move_1', 'service', 'svc-x', 'data-collection', 'rvs-mill-01/state-to-historian', ?, 'admin')",
      at,
    );
    d.run(
      "INSERT INTO plant_ih_monitor_links (asset_id, collection_id, sink_id, item, monitor_id, check_id, origin, created_at, created_by) VALUES ('rvs-mill-01', 'state-to-historian', 'sink', 'State', 'mon_x', 'chk_x', 'mapping', ?, 'admin')",
      at,
    );
    const body = { kind: 'device', items: [{ asset: 'rvs-mill-01', id: 'rvs-mill-01-ipc' }], toAsset: 'rvs-mill-03', collections: 'move' };
    const p = await dana('POST', '/plant/move/preview', body);
    expect(p.entries.map((e: any) => `${e.kind}:${e.id}`)).toEqual(['device:rvs-mill-01-ipc', 'data_path:machine-state', 'collection:state-to-historian']);
    expect(p.unlinked).toEqual([]);
    await dana('POST', '/plant/move', body);
    const c = await s.api('GET', '/plant/assets/rvs-mill-03/collections/state-to-historian');
    expect(c).toMatchObject({ assetId: 'rvs-mill-03', dataPathId: 'machine-state', items: [expect.objectContaining({ outputName: 'State' })] });
    expect(d.get<{ to_id: string }>("SELECT to_id FROM item_links WHERE id = 'lnk_move_1'")!.to_id).toBe('rvs-mill-03/state-to-historian');
    expect(d.get<{ asset_id: string }>("SELECT asset_id FROM plant_ih_monitor_links WHERE monitor_id = 'mon_x'")!.asset_id).toBe('rvs-mill-03');
    expect((await s.api('GET', '/plant/history?kind=collection&scope=rvs-mill-03&id=state-to-historian')).items[0].op).toBe('move');
  });
});

describe('the step-up of a move', () => {
  it('counts what moves along and the collections that lose their data path, and asks for every move to another site', async () => {
    const { moveStepUpFor } = await import('../src/plant/move.js');
    const { PLANT_MOVE } = await import('@sm/shared');
    const entries = (n: number, why: 'chosen' | 'follows') => Array.from({ length: n }, () => ({ why }) as never);
    // 20 chosen devices with 6 data paths that follow: 26 entries move
    expect(moveStepUpFor({ entries: [...entries(20, 'chosen'), ...entries(6, 'follows')], unlinked: [], crossSite: false })).toBe(true);
    expect(moveStepUpFor({ entries: entries(PLANT_MOVE.stepUp, 'chosen'), unlinked: [], crossSite: false })).toBe(false);
    expect(moveStepUpFor({ entries: entries(PLANT_MOVE.stepUp, 'chosen'), unlinked: [{} as never], crossSite: false })).toBe(true);
    expect(moveStepUpFor({ entries: entries(1, 'chosen'), unlinked: [], crossSite: true })).toBe(true);
    // a move on the same site with what follows: no step-up below the threshold
    const p = await s.api('POST', '/plant/move/preview', {
      kind: 'device',
      items: [{ asset: 'rvs-mill-02', id: 'rvs-mill-02-ipc' }],
      toAsset: 'rvs-mill-01',
      collections: 'leave',
    });
    expect(p.crossSite).toBe(false);
    expect(p.stepUp).toBe(false);
  });
});

describe('across sites and rights', () => {
  it('refuses a site the person may not change; who manages both moves, and the device leaves its VLAN', async () => {
    const site = await s.api('GET', '/plant/sites/hillcrest');
    await s.api('PUT', '/plant/sites/hillcrest/access', {
      acl: [
        { subject: 'user:admin', permissions: ['view', 'manage'] },
        { subject: 'user:dana', permissions: ['view'] },
      ],
    });
    const body = { kind: 'device', items: [{ asset: 'rvs-mill-03', id: 'rvs-mill-01-ipc' }], toAsset: 'hlc-im-01', collections: 'move' };
    expect(await status(dana('POST', '/plant/move/preview', body))).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(await status(dana('POST', '/plant/move', body))).toMatchObject({ status: 403 });
    await s.api('PUT', '/plant/sites/hillcrest/access', { acl: site.acl });
    const p = await dana('POST', '/plant/move/preview', body);
    expect(p.crossSite).toBe(true);
    expect(p.entries[0]).toMatchObject({ kind: 'device', leavesVlan: 'rvs-vlan-110' });
    // a move to another site always asks for a step-up, however few entries move (they leave their VLAN and zones)
    expect(p.stepUp).toBe(true);
    const fresh = await s.as('dana', PW, { autoStepUp: false });
    await fresh('DELETE', '/auth/step-up');
    expect(await status(fresh('POST', '/plant/move', body))).toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    await dana('POST', '/plant/move', body);
    const n = await s.api('GET', '/plant/assets/hlc-im-01/network');
    expect(n.devices.find((x: any) => x.id === 'rvs-mill-01-ipc')).toMatchObject({ vlan: null, address: '10.20.110.21' });
    expect((await s.api('GET', '/audit?action=plant.moved&limit=1'))[0].details.crossSite).toBe(true);
    // a viewer may not move anything
    const vera = await (async () => {
      const { createUser } = await import('../src/auth/users.js');
      createUser({ username: 'vera', roles: ['viewer'], password: PW });
      return s.as('vera', PW);
    })();
    expect(
      await status(vera('POST', '/plant/move/preview', { ...body, toAsset: 'rvs-mill-03', items: [{ asset: 'hlc-im-01', id: 'rvs-mill-01-ipc' }] })),
    ).toMatchObject({
      status: 403,
    });
  });
});

describe('a data collection on its own', () => {
  it('moves with its sinks, items and kept files; its data path stays and the link goes', async () => {
    await s.api('POST', '/plant/assets/rvs-mill-02/collections', collection('nc-feed', 'nc-programs'));
    const d = await db();
    d.run(
      `INSERT INTO plant_collection_sources (id, asset_id, collector_key, collector, version, file_name, format, sha256, size, content, redacted_sha256, collections, imported_by, imported_at)
       VALUES ('pcs_src_1', 'rvs-mill-02', 'job:rvs-edge-collector', '{}', 1, 'feed.json', 'json', 'x', 2, '{}', 'x', '["nc-feed"]', 'admin', ?)`,
      new Date().toISOString(),
    );
    const body = { kind: 'collection', items: [{ asset: 'rvs-mill-02', id: 'nc-feed' }], toAsset: 'rvs-mill-01' };
    const p = await dana('POST', '/plant/move/preview', body);
    expect(p.entries).toEqual([expect.objectContaining({ kind: 'collection', id: 'nc-feed', leavesDataPath: 'nc-programs' })]);
    const r = await dana('POST', '/plant/move', body);
    const c = await s.api('GET', '/plant/assets/rvs-mill-01/collections/nc-feed');
    expect(c).toMatchObject({
      dataPathId: null,
      sinks: [expect.objectContaining({ ref: 'Plant historian' })],
      items: [expect.objectContaining({ address: 'ns=3;s=State' })],
    });
    expect(d.get<{ asset_id: string }>("SELECT asset_id FROM plant_collection_sources WHERE id = 'pcs_src_1'")!.asset_id).toBe('rvs-mill-01');
    expect((await pathsOf('rvs-mill-02')).map((x: any) => x.id)).toEqual(['nc-programs']);
    // reverting brings it back with its link
    const rev = await dana('POST', `/plant/change-sets/${r.changeSetId}/revert`);
    const pre = await dana('POST', `/plant/change-sets/${rev.id}/preview`);
    await dana('POST', `/plant/change-sets/${rev.id}/apply`, { fingerprint: pre.fingerprint });
    expect((await s.api('GET', '/plant/assets/rvs-mill-02/collections/nc-feed')).dataPathId).toBe('nc-programs');
  });
});

describe('duplicating a device', () => {
  it('copies its fields, not what identifies the original or watches it', async () => {
    const n = await dana('POST', '/plant/assets/rvs-mill-02/devices/rvs-mill-02-ipc/duplicate', { toAsset: 'rvs-mill-02', id: 'rvs-mill-02-ipc-2' });
    const copy = n.devices.find((x: any) => x.id === 'rvs-mill-02-ipc-2');
    expect(copy).toMatchObject({
      hostname: '',
      address: '',
      mac: '',
      serial: '',
      switchPort: '',
      vlan: 'rvs-vlan-110',
      switch: 'rvs-sw-h1-a1',
      domain: 'ot.example.com',
    });
    expect(copy.checks).toEqual([]);
    expect(copy.notes).toBe('Address read from the machine’s display; port not checked yet.'.replace('’', "'"));
    // on another site its VLAN is left empty
    const other = await s.api('POST', '/plant/assets/rvs-mill-02/devices/rvs-mill-02-ipc/duplicate', { toAsset: 'hlc-im-02', id: 'hlc-im-02-ipc' });
    expect(other.devices.find((x: any) => x.id === 'hlc-im-02-ipc')).toMatchObject({ vlan: null, purpose: 'Machine PC' });
    expect(
      await status(dana('POST', '/plant/assets/rvs-mill-02/devices/rvs-mill-02-ipc/duplicate', { toAsset: 'rvs-mill-02', id: 'rvs-mill-02-ipc-2' })),
    ).toMatchObject({
      status: 409,
      code: 'PLANT_ID_TAKEN',
    });
    const a = (await s.api('GET', '/audit?action=asset.device_added&limit=1'))[0];
    expect(a.details.copiedFrom).toBe('rvs-mill-02/rvs-mill-02-ipc');
    // an added entry: Revert removes it
    const h = await s.api('GET', '/plant/history?kind=device&scope=hlc-im-02&id=hlc-im-02-ipc');
    expect(h.items[0].op).toBe('add');
  });
});

describe('revisions, open drafts and the registry of what names a collection', () => {
  it('an edit form that loaded the device before the move is refused (409); an open draft follows it to its new asset', async () => {
    const before = (await s.api('GET', '/plant/assets/rvs-mill-02/network')).devices.find((d: any) => d.id === 'rvs-mill-02-ipc');
    // olaf (may only propose) keeps a change of the device in his draft
    const bodyOf = (x: any, patch: Record<string, unknown> = {}) => ({
      hostname: x.hostname,
      domain: x.domain,
      purpose: x.purpose,
      mac: x.mac,
      serial: x.serial,
      vlan: x.vlan,
      addressType: x.addressType,
      address: x.address,
      switch: x.switch,
      switchPort: x.switchPort,
      wallOutlet: x.wallOutlet,
      cmdbPort: x.cmdbPort,
      state: x.state,
      flags: x.flags,
      confidence: x.confidence,
      owner: x.owner,
      monitoring: x.monitoring,
      checks: [],
      notes: x.notes,
      ...patch,
    });
    const draft = await olaf('POST', '/plant/change-sets/current/operations', {
      op: 'set',
      kind: 'device',
      scope: 'rvs-mill-02',
      id: 'rvs-mill-02-ipc',
      value: bodyOf(before, { owner: 'Shop floor IT' }),
      revision: before.revision,
    });
    // the data path that names it moves along once the other device is out of it
    await s.api('PUT', '/plant/assets/rvs-mill-02/paths/nc-programs', {
      subject: 'NC programs',
      description: '',
      devices: ['rvs-mill-02-ipc'],
      collector: null,
      transfers: [],
      destinations: [],
      notes: '',
    });
    await dana('POST', '/plant/move', {
      kind: 'device',
      items: [{ asset: 'rvs-mill-02', id: 'rvs-mill-02-ipc' }],
      toAsset: 'rvs-mill-03',
      collections: 'move',
    });
    const moved = (await s.api('GET', '/plant/assets/rvs-mill-03/network')).devices.find((d: any) => d.id === 'rvs-mill-02-ipc');
    expect(moved.revision).toBe(before.revision + 1);
    const body = bodyOf(moved, { purpose: 'Changed' });
    expect(await status(dana('PUT', '/plant/assets/rvs-mill-03/devices/rvs-mill-02-ipc', { ...body, revision: before.revision }))).toMatchObject({
      status: 409,
      code: 'PLANT_ENTRY_CHANGED',
    });
    // the draft's operation names the device where it is now; its preview changes it there
    const d = await olaf('GET', `/plant/change-sets/${draft.id}`);
    expect(d.operations.find((o: any) => o.kind === 'device')).toMatchObject({ scope: 'rvs-mill-03', id: 'rvs-mill-02-ipc' });
    const pre = await olaf('POST', `/plant/change-sets/${draft.id}/preview`);
    expect(pre.entries).toEqual([expect.objectContaining({ kind: 'device', scope: 'rvs-mill-03', id: 'rvs-mill-02-ipc', action: 'change' })]);
    await olaf('POST', `/plant/change-sets/${draft.id}/withdraw`);
  });

  it('lists every column that holds a data collection id (a new one fails until a move walks it)', async () => {
    const { COLLECTION_REFERENCES } = await import('../src/plant/rename.js');
    const d = await db();
    const columns: { table: string; column: string }[] =
      d.dialect === 'sqlite'
        ? d
            .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .flatMap((t) => d.all<{ name: string }>(`PRAGMA table_info(${t.name})`).map((c) => ({ table: t.name, column: c.name })))
        : d.all<{ table: string; column: string }>(
            'SELECT table_name AS "table", column_name AS "column" FROM information_schema.columns WHERE table_schema = current_schema()',
          );
    const walked = new Set(COLLECTION_REFERENCES.map((r) => r.table));
    // the kept files of collection imports follow in move.ts (when every collection they wrote goes)
    const missing = columns.filter((c) => /(^|_)collection_id$/.test(c.column) && !walked.has(c.table) && c.table !== 'plant_collection_sources');
    expect(missing).toEqual([]);
  });
});

describe('drafts and review', () => {
  it('who may only propose adds a move to their draft; someone who manages applies it', async () => {
    const body = { kind: 'device', items: [{ asset: 'rvs-mill-02', id: 'rvs-mill-02-ipc-2' }], toAsset: 'rvs-mill-01' };
    expect(await status(olaf('POST', '/plant/move', body))).toMatchObject({ status: 403 });
    const p = await olaf('POST', '/plant/move/preview', body);
    expect(p.ok).toBe(true);
    expect(p.changes).toHaveLength(1);
    const d = await olaf('POST', '/plant/change-sets/current/operations', { op: 'move', value: body });
    expect(d.operations).toEqual([expect.objectContaining({ op: 'move', kind: null })]);
    expect(d.sites).toEqual(['riverside']);
    const pre = await olaf('POST', `/plant/change-sets/${d.id}/preview`);
    expect(pre.counts).toMatchObject({ move: 1 });
    await olaf('POST', `/plant/change-sets/${d.id}/propose`);
    const pre2 = await dana('POST', `/plant/change-sets/${d.id}/preview`);
    await dana('POST', `/plant/change-sets/${d.id}/apply`, { fingerprint: pre2.fingerprint });
    expect(await devicesOf('rvs-mill-01')).toContain('rvs-mill-02-ipc-2');
  });

  it('where a site needs a second person, a move becomes a proposed change set', async () => {
    await setPolicy('required');
    try {
      const body = { kind: 'device', items: [{ asset: 'rvs-mill-01', id: 'rvs-mill-02-ipc-2' }], toAsset: 'rvs-mill-02' };
      const r = await raw(adminCookie, 'POST', '/plant/move', body);
      expect(r.status).toBe(202);
      expect(r.body.changeSet).toMatchObject({ state: 'proposed', source: 'move' });
      expect(await devicesOf('rvs-mill-01')).toContain('rvs-mill-02-ipc-2');
      // the author does not apply it; someone else does
      const pre = await s.api('POST', `/plant/change-sets/${r.body.changeSet.id}/preview`);
      expect(pre.applyBlocked).toMatchObject({ code: 'PLANT_CHANGESET_OWN' });
      const pre2 = await dana('POST', `/plant/change-sets/${r.body.changeSet.id}/preview`);
      await dana('POST', `/plant/change-sets/${r.body.changeSet.id}/apply`, { fingerprint: pre2.fingerprint });
      expect(await devicesOf('rvs-mill-02')).toContain('rvs-mill-02-ipc-2');
    } finally {
      await setPolicy('off');
    }
  });
});

describe('several assets at once', () => {
  it('moves selected assets to one place of their site (the single move’s rules) and reverts it', async () => {
    const body = { kind: 'asset', action: 'edit', items: [{ id: 'rvs-mill-01' }, { id: 'rvs-mill-02' }], set: { nodeId: 'rvs-assembly' } };
    const p = await dana('POST', '/plant/bulk/preview', body);
    expect(p.counts.changed).toBe(2);
    await dana('POST', '/plant/bulk', { ...body, fingerprint: p.fingerprint });
    for (const id of ['rvs-mill-01', 'rvs-mill-02'])
      expect((await s.api('GET', `/plant/assets/${id}`)).location).toMatchObject({
        area: expect.objectContaining({ id: 'rvs-assembly' }),
        workCenter: null,
        workUnit: null,
      });
    // a place of another site is refused for each asset
    const other = await dana('POST', '/plant/bulk/preview', { ...body, set: { nodeId: 'hlc-moulding' } });
    expect(other.items.map((i: any) => i.reason?.code)).toEqual(['PLANT_LOCATION_UNKNOWN', 'PLANT_LOCATION_UNKNOWN']);
    const cs = (await dana('GET', '/plant/change-sets?box=applied&source=bulk')).items[0];
    const rev = await dana('POST', `/plant/change-sets/${cs.id}/revert`);
    const pre = await dana('POST', `/plant/change-sets/${rev.id}/preview`);
    await dana('POST', `/plant/change-sets/${rev.id}/apply`, { fingerprint: pre.fingerprint });
    expect((await s.api('GET', '/plant/assets/rvs-mill-01')).location.area.id).toBe('rvs-machining');
  });
});
