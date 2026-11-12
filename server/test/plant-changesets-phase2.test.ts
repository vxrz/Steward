import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, authHeaders, loginCookie, setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Plant change sets, phase 2 (0.19.0, docs/adr/0020-plant-change-sets.md "Built in 0.19.0", docs/PLANT.md "Change
 * sets"): the import's flags of fields changed in Steward since the last import (Keep Steward's by default, per field
 * and for all), restoring removed entries with Revert, the collection import as a change set operation, and change sets
 * in /api/v1 with proposals from CI.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Plant-password-1';
const users: Record<string, Client> = {};
let adminCookie = '';
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

const assetBody = (a: any, patch: Record<string, unknown> = {}) => ({
  siteId: a.siteId,
  areaId: a.location.area?.id ?? null,
  workCenterId: a.location.workCenter?.id ?? null,
  workUnitId: a.location.workUnit?.id ?? null,
  buildingId: a.location.buildingId,
  name: a.name,
  manufacturer: a.manufacturer,
  model: a.model,
  status: a.status,
  parentId: a.parentId,
  domain: a.domain,
  processArea: a.processArea,
  role: a.role,
  tags: a.tags,
  commissioned: a.commissioned,
  endOfSupport: a.endOfSupport,
  description: a.description,
  capabilities: a.capabilities,
  imageName: a.imageName,
  refs: a.refs,
  fields: a.fields,
  ...patch,
});

/** An export as data, lists of entries with ids in the order of their ids, without its comment lines. */
const sorted = (yaml: string): unknown => {
  const walk = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(walk).sort((a: any, b: any) => (a && b && typeof a.id === 'string' && typeof b.id === 'string' ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : 0))
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
        : v;
  return walk(YAML.parse(yaml));
};
const example = (name: string) => ({ name, content: fs.readFileSync(path.resolve(__dirname, '../../examples/plant', name), 'utf8') });

/** A file of site "west" with lathes, each with a model and a description. */
const westFile = (lathes: { id: string; model: string; description?: string }[]) => ({
  name: 'west.yaml',
  content: [
    'version: 1',
    'sites:',
    '  - id: west',
    '    name: West Works',
    '    assets:',
    ...lathes.flatMap((l) => [
      `      - id: ${l.id}`,
      `        name: Lathe ${l.id}`,
      `        model: ${l.model}`,
      `        description: ${l.description ?? 'From the ERP'}`,
    ]),
  ].join('\n'),
});

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  for (const [name, role] of [
    ['dana', 'designer'],
    ['dirk', 'designer'],
    ['olaf', 'operator'],
  ] as const) {
    createUser({ username: name, roles: [role], password: PW });
    users[name] = await s.as(name, PW);
  }
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  adminCookie = await loginCookie(s.base, ADMIN.username, ADMIN.password);
});

describe('fields changed in Steward since the last import', () => {
  it('flags them in the preview and keeps Steward’s value by default; the file’s value is one choice away', async () => {
    const first = await s.api('POST', '/plant/import', { files: [westFile([{ id: 'lathe-1', model: 'L1' }])], mode: 'update' });
    expect(first.byKind.asset.add).toBe(1);
    expect(first.changedInSteward).toBeUndefined();
    // someone corrects the model in Steward
    const a = await s.api('GET', '/plant/assets/lathe-1');
    await s.api('PUT', '/plant/assets/lathe-1', assetBody(a, { model: 'L1-corrected' }));
    // the next file: a new model and description; the model was changed in Steward since
    const file = westFile([{ id: 'lathe-1', model: 'L2', description: 'From the ERP, again' }]);
    const pre = await s.api('POST', '/plant/import/preview', { files: [file], mode: 'update' });
    expect(pre.changedInSteward).toEqual({
      total: 1,
      kept: 1,
      flags: [
        {
          kind: 'asset',
          scope: '',
          id: 'lathe-1',
          name: 'Lathe lathe-1',
          path: 'model',
          lastImport: 'L1',
          steward: 'L1-corrected',
          file: 'L2',
          importId: first.import.id,
          choice: 'steward',
        },
      ],
    });
    // the preview shows what really happens: only the description changes
    const change = pre.changes.find((c: any) => c.id === 'lathe-1');
    expect(change).toMatchObject({ action: 'change', fields: ['description'] });
    const done = await s.api('POST', '/plant/import', { files: [file], mode: 'update', fingerprint: pre.fingerprint });
    expect(done.changedInSteward.kept).toBe(1);
    let now = await s.api('GET', '/plant/assets/lathe-1');
    expect([now.model, now.description]).toEqual(['L1-corrected', 'From the ERP, again']);
    // the audit entry names what was kept (paths, never values)
    const [imported] = await s.api('GET', '/audit?action=plant.imported&limit=1');
    expect(imported.details.keptInSteward).toEqual({ fields: 1, entries: ['asset:lathe-1 model'] });
    // the baseline says what the file said: the field stays flagged while Steward and the file differ
    const { baselineOf } = await import('../src/plant/changesets/track.js');
    expect(baselineOf('asset', '', 'lathe-1')).toMatchObject({ importId: done.import.id, values: { model: 'L2', description: 'From the ERP, again' } });
    const again = await s.api('POST', '/plant/import/preview', { files: [file], mode: 'update' });
    expect(again.changedInSteward.flags.map((f: any) => [f.path, f.lastImport, f.steward, f.file])).toEqual([['model', 'L2', 'L1-corrected', 'L2']]);
    expect(again.counts.change).toBe(0);
    // taking the file's value for this field
    const choice = { take: 'steward', fields: [{ kind: 'asset', id: 'lathe-1', path: 'model', choice: 'file' }] };
    const took = await s.api('POST', '/plant/import/preview', { files: [file], mode: 'update', changedInSteward: choice });
    expect(took.changedInSteward).toMatchObject({ total: 1, kept: 0, flags: [{ path: 'model', choice: 'file' }] });
    expect(took.counts.change).toBe(1);
    await s.api('POST', '/plant/import', { files: [file], mode: 'update', changedInSteward: choice, fingerprint: took.fingerprint });
    now = await s.api('GET', '/plant/assets/lathe-1');
    expect(now.model).toBe('L2');
    // nothing differs from the last import now
    expect((await s.api('POST', '/plant/import/preview', { files: [file], mode: 'update' })).changedInSteward).toBeUndefined();
  });

  it('take all from the file; a field the file did not change is flagged too; add only flags nothing', async () => {
    const a = await s.api('GET', '/plant/assets/lathe-1');
    await s.api('PUT', '/plant/assets/lathe-1', assetBody(a, { description: 'Checked on site' }));
    // the same file as last time: its description is what the last import wrote, Steward's is newer
    const file = westFile([{ id: 'lathe-1', model: 'L2', description: 'From the ERP, again' }]);
    const pre = await s.api('POST', '/plant/import/preview', { files: [file], mode: 'update' });
    expect(pre.changedInSteward.flags.map((f: any) => [f.path, f.lastImport, f.steward, f.file])).toEqual([
      ['description', 'From the ERP, again', 'Checked on site', 'From the ERP, again'],
    ]);
    expect((await s.api('POST', '/plant/import/preview', { files: [file], mode: 'add' })).changedInSteward).toBeUndefined();
    const all = await s.api('POST', '/plant/import/preview', { files: [file], mode: 'update', changedInSteward: { take: 'file' } });
    expect(all.changedInSteward).toMatchObject({ total: 1, kept: 0 });
    await s.api('POST', '/plant/import', { files: [file], mode: 'update', changedInSteward: { take: 'file' } });
    expect((await s.api('GET', '/plant/assets/lathe-1')).description).toBe('From the ERP, again');
  });

  it('a replace import keeps Steward’s value of a field the file leaves out', async () => {
    const first = await s.api('POST', '/plant/import', { files: [westFile([{ id: 'lathe-2', model: 'M1' }])], mode: 'update' });
    const a = await s.api('GET', '/plant/assets/lathe-2');
    await s.api('PUT', '/plant/assets/lathe-2', assetBody(a, { manufacturer: 'Invented Lathes AG' }));
    const file = westFile([
      { id: 'lathe-1', model: 'L2', description: 'From the ERP, again' },
      { id: 'lathe-2', model: 'M1' },
    ]);
    const pre = await s.api('POST', '/plant/import/preview', { files: [file], mode: 'replace', replaces: first.import.id, missing: 'mark' });
    expect(pre.changedInSteward.flags.map((f: any) => [f.id, f.path, f.steward, f.file])).toEqual([['lathe-2', 'manufacturer', 'Invented Lathes AG', '']]);
    await s.api('POST', '/plant/import', { files: [file], mode: 'replace', replaces: first.import.id, missing: 'mark' });
    expect((await s.api('GET', '/plant/assets/lathe-2')).manufacturer).toBe('Invented Lathes AG');
  });

  it('an entry imported before 0.13 and edited since is flagged as a whole', async () => {
    await s.api('POST', '/plant/import', { files: [westFile([{ id: 'lathe-3', model: 'N1' }])], mode: 'update' });
    const d = await db();
    // as 0.12 left it: no baseline, edited after its import
    d.run("DELETE FROM plant_entry_baselines WHERE kind = 'asset' AND entry_id = 'lathe-3'");
    d.run("UPDATE plant_assets SET model = 'N1-hand', updated_at = '2999-01-01T00:00:00.000Z' WHERE id = 'lathe-3'");
    const pre = await s.api('POST', '/plant/import/preview', { files: [westFile([{ id: 'lathe-3', model: 'N2', description: 'New' }])], mode: 'update' });
    expect(pre.changedInSteward.flags.map((f: any) => [f.path, f.lastImport, f.wholeEntry, f.choice])).toEqual([
      ['description', null, true, 'steward'],
      ['model', null, true, 'steward'],
    ]);
  });

  it('names nothing of a site the reader may not see', async () => {
    await s.api('POST', '/plant/import', {
      files: [
        {
          name: 'east.yaml',
          content: 'version: 1\nsites:\n  - id: east\n    name: East Works\n    assets:\n      - id: drill-1\n        name: Drill 1\n        model: D1\n',
        },
      ],
      mode: 'update',
    });
    const a = await s.api('GET', '/plant/assets/drill-1');
    await s.api('PUT', '/plant/assets/drill-1', assetBody(a, { model: 'D1-hand' }));
    await s.api('PUT', '/plant/sites/east/access', { acl: [{ subject: `user:${ADMIN.username}`, permissions: ['view', 'manage'] }] });
    const pre = await users.dana!('POST', '/plant/import/preview', {
      files: [
        {
          name: 'east.yaml',
          content: 'version: 1\nsites:\n  - id: east\n    name: East Works\n    assets:\n      - id: drill-1\n        name: Drill 1\n        model: D2\n',
        },
      ],
      mode: 'update',
    });
    expect(pre.ok).toBe(false);
    expect(JSON.stringify(pre.changedInSteward ?? null)).not.toContain('drill-1');
    await s.api('PUT', '/plant/sites/east/access', { acl: [] });
  });

  it('an import added to a draft keeps its choices; a proposal from an assistant takes its values and records no baseline', async () => {
    const a = await s.api('GET', '/plant/assets/lathe-1');
    await s.api('PUT', '/plant/assets/lathe-1', assetBody(a, { model: 'L2-hand' }));
    const file = westFile([{ id: 'lathe-1', model: 'L3', description: 'From the ERP, again' }]);
    await users.olaf!('POST', '/plant/change-sets', { title: 'Sync west' });
    const d = await users.olaf!('POST', '/plant/change-sets/current/operations', { op: 'import', value: { files: [file], mode: 'update' } });
    const p = await users.olaf!('POST', `/plant/change-sets/${d.id}/preview`);
    // the draft's preview keeps Steward's model: nothing else changes
    expect(p.problems).toEqual([{ seq: null, code: 'PLANT_CHANGESET_EMPTY', message: 'It changes nothing' }]);
    await users.olaf!('POST', `/plant/change-sets/${d.id}/withdraw`);
  });
});

describe('restoring removed entries with Revert', () => {
  it('a removal with what went with it is reverted by a draft that adds it all again, as it was', async () => {
    await s.api('POST', '/plant/import', {
      files: [example('brightwater.plant.yaml'), example('brightwater-data-points.plant.yaml'), example('brightwater-ot-network.plant.yaml')],
      mode: 'update',
    });
    const exported = async () => (await fetch(`${s.base}/api/plant/export?site=riverside`, { headers: authHeaders(adminCookie) })).text();
    const before = await exported();
    const asset = await s.api('GET', '/plant/assets/rvs-mill-01');
    const network = await s.api('GET', '/plant/assets/rvs-mill-01/network');
    expect(network.devices.length).toBeGreaterThan(0);
    // removed with what belongs to it (its assignment, devices, data paths, collections)
    const removed = await s.api('POST', '/plant/bulk', { kind: 'asset', action: 'remove', items: [{ id: 'rvs-mill-01' }], cascade: true, set: {} });
    expect(removed.removed ?? removed.counts?.remove ?? 1).toBeTruthy();
    expect(await status(s.api('GET', '/plant/assets/rvs-mill-01'))).toMatchObject({ status: 404 });
    const [applied] = (await s.api('GET', '/plant/change-sets?box=applied&source=bulk')).items;
    const detail = await s.api('GET', `/plant/change-sets/${applied.id}`);
    expect(detail.applied.filter((e: any) => e.action === 'remove').length).toBeGreaterThan(2);
    // the asset's site History lists the removal of a device with a Revert
    const h = await s.api('GET', '/plant/history?kind=site&id=riverside&children=1');
    expect(h.items.length).toBeGreaterThan(0);
    const reverted = await s.api('POST', `/plant/change-sets/${applied.id}/revert`);
    expect(reverted.source).toBe('revert');
    const adds = reverted.operations.filter((o: any) => o.op === 'add');
    expect(adds[0]).toMatchObject({ kind: 'asset', id: 'rvs-mill-01' });
    expect(adds.map((o: any) => o.kind)).toEqual(expect.arrayContaining(['assignment', 'device', 'data_path']));
    const pre = await s.api('POST', `/plant/change-sets/${reverted.id}/preview`);
    expect(pre.problems).toEqual([]);
    expect(pre.stepUp).toBe(false);
    await s.api('POST', `/plant/change-sets/${reverted.id}/apply`, { fingerprint: pre.fingerprint });
    const back = await s.api('GET', '/plant/assets/rvs-mill-01');
    expect(back).toMatchObject({ name: asset.name, model: asset.model, siteId: asset.siteId });
    expect((await s.api('GET', '/plant/assets/rvs-mill-01/network')).devices.length).toBe(network.devices.length);
    // everything as it was: the export of the site is the same (restored entries come last in their lists: their place
    // in a list is not part of the history)
    expect(sorted(await exported())).toEqual(sorted(before));
    // its history goes on: added again by the revert
    const hist = await s.api('GET', '/plant/history?kind=asset&id=rvs-mill-01');
    expect(hist.items[0]).toMatchObject({ op: 'add', changeSet: { source: 'revert' } });
  });

  it('one row of history: a removed device comes back while its asset is there; never what the person may not see', async () => {
    const network = await s.api('GET', '/plant/assets/rvs-mill-01/network');
    const device = network.devices[0];
    await s.api('DELETE', `/plant/assets/rvs-mill-01/devices/${device.id}`);
    const h = await s.api('GET', '/plant/history?kind=asset&id=rvs-mill-01&children=1');
    const row = h.items.find((x: any) => x.op === 'remove' && x.entryId === device.id);
    expect(row.canRevert).toBe(true);
    // olaf does not see the site: nothing to revert for him
    await s.api('PUT', '/plant/sites/riverside/access', { acl: [{ subject: `user:${ADMIN.username}`, permissions: ['view', 'manage'] }] });
    expect(await status(users.olaf!('POST', `/plant/history/${row.id}/revert`))).toMatchObject({ status: 409, code: 'PLANT_CHANGESET_NOTHING' });
    await s.api('PUT', '/plant/sites/riverside/access', { acl: [] });
    const draft = await s.api('POST', `/plant/history/${row.id}/revert`);
    expect(draft.operations).toMatchObject([{ op: 'add', kind: 'device', scope: 'rvs-mill-01', id: device.id }]);
    const pre = await s.api('POST', `/plant/change-sets/${draft.id}/preview`);
    await s.api('POST', `/plant/change-sets/${draft.id}/apply`, { fingerprint: pre.fingerprint });
    const again = (await s.api('GET', '/plant/assets/rvs-mill-01/network')).devices.find((d: any) => d.id === device.id);
    expect(again).toMatchObject({ hostname: device.hostname, address: device.address });
    // there again: the removal is no longer offered for revert
    const h2 = await s.api('GET', '/plant/history?kind=asset&id=rvs-mill-01&children=1');
    expect(h2.items.find((x: any) => x.id === row.id).canRevert).toBe(false);
  });
});

describe('the collection import as an operation of a change set', () => {
  const GW = { kind: 'job', ref: 'line-gateway-7', host: null };
  const body = (name = 'gw.csv', extra = '') => ({
    collector: GW,
    files: [
      { name, content: `collection,source_address,output_name\nstate,/Bag/State/opMode[u1],OpMode\nstate,/Bag/State/progStatus[u1],ProgStatus${extra}\n` },
    ],
  });

  it('applies at once without review, as a change set with one collections operation and its history', async () => {
    const done = await s.api('POST', '/plant/assets/rvs-mill-01/collections/import', body());
    expect(done.collections.added).toBe(1);
    expect(done.changeSetId).toMatch(/^pcs_/);
    const cs = await s.api('GET', `/plant/change-sets/${done.changeSetId}`);
    expect(cs).toMatchObject({ state: 'applied', source: 'import' });
    expect(cs.operations).toMatchObject([{ op: 'collections', value: { assetId: 'rvs-mill-01', collector: GW } }]);
    // the files are not repeated in the operation (they are kept as the collector's sources)
    expect(JSON.stringify(cs.operations[0].value)).not.toContain('OpMode');
    expect(cs.applied).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'collection', action: 'add' })]));
    const [audit] = await s.api('GET', '/audit?action=plant.collection_imported&limit=1');
    expect(audit.details.changeSetId).toBe(done.changeSetId);
  });

  it('where review is required it becomes a proposed change set that a second person applies – never its author', async () => {
    await setPolicy('optional');
    await s.api('PUT', '/plant/sites/riverside/review', { review: true });
    const r = await raw(adminCookie, 'POST', '/plant/assets/rvs-mill-01/collections/import', body('gw2.csv', '\nstate,/Bag/State/feed[u1],Feed'));
    expect(r.status).toBe(202);
    expect(r.body.changeSet).toMatchObject({ state: 'proposed', source: 'import', review: true });
    const before = await s.api('GET', '/plant/assets/rvs-mill-01/collections');
    expect(before.collections.find((c: any) => c.id === 'state').items.length).toBe(2);
    const id = r.body.changeSet.id;
    const own = await s.api('POST', `/plant/change-sets/${id}/preview`);
    expect(own.applyBlocked).toMatchObject({ code: 'PLANT_CHANGESET_OWN' });
    const pre = await users.dana!('POST', `/plant/change-sets/${id}/preview`);
    expect(pre.problems).toEqual([]);
    expect(pre.entries).toEqual([expect.objectContaining({ kind: 'collection', id: 'state', action: 'change' })]);
    await users.dana!('POST', `/plant/change-sets/${id}/apply`, { fingerprint: pre.fingerprint });
    const after = await s.api('GET', '/plant/assets/rvs-mill-01/collections');
    expect(after.collections.find((c: any) => c.id === 'state').items.length).toBe(3);
    await s.api('PUT', '/plant/sites/riverside/review', { review: false });
    await setPolicy('off');
  });

  it('who may only propose previews it and adds it to their draft; applying it needs the manage right', async () => {
    const pv = await users.olaf!('POST', '/plant/assets/rvs-mill-01/collections/import/preview', body('gw3.csv', '\nstate,/Bag/State/temp[u1],Temp'));
    expect(pv.problems).toEqual([]);
    expect(await status(users.olaf!('POST', '/plant/assets/rvs-mill-01/collections/import', body('gw3.csv')))).toMatchObject({ status: 403 });
    const d = await users.olaf!('POST', '/plant/change-sets/current/operations', {
      op: 'collections',
      value: { assetId: 'rvs-mill-01', ...body('gw3.csv', '\nstate,/Bag/State/temp[u1],Temp'), decisions: [] },
    });
    expect(d.operations.at(-1)).toMatchObject({ op: 'collections', value: { assetId: 'rvs-mill-01' } });
    const pre = await users.olaf!('POST', `/plant/change-sets/${d.id}/preview`);
    expect(pre.entries).toEqual([expect.objectContaining({ kind: 'collection', id: 'state', action: 'change' })]);
    expect(pre.applyBlocked).toMatchObject({ code: 'FORBIDDEN' });
    // an asset of a site olaf may not see reads as missing
    await s.api('PUT', '/plant/sites/riverside/access', { acl: [{ subject: `user:${ADMIN.username}`, permissions: ['view', 'manage'] }] });
    expect(
      await status(
        users.olaf!('POST', '/plant/change-sets/current/operations', { op: 'collections', value: { assetId: 'rvs-mill-01', ...body(), decisions: [] } }),
      ),
    ).toMatchObject({ status: 404, code: 'PLANT_ENTRY_NOT_FOUND' });
    await s.api('PUT', '/plant/sites/riverside/access', { acl: [] });
    await users.olaf!('POST', `/plant/change-sets/${d.id}/withdraw`);
  });
});

describe('change sets in /api/v1 and proposals from CI', () => {
  const tokens: Record<string, string> = {};
  const v1 = async (token: string, url: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await fetch(`${s.base}/api/v1${url}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  const profileDoc = (aliases: string[]) => ({
    version: 1,
    device_profile: {
      id: 'ci-sensor-v1',
      name: 'CI sensor, version 1',
      interfaces: [
        {
          id: 'opc',
          protocol: 'opc_ua',
          groups: [
            {
              name: 'Values',
              data_points: [{ id: 'temp', name: 'Temperature', aliases, source: { document: 'CI sensor manual v1', page: '12', section: '3.1 Variables' } }],
            },
          ],
        },
      ],
    },
  });

  beforeAll(async () => {
    tokens.full = (await users.olaf!('POST', '/me/tokens', { name: 'ci-full', scope: 'full' })).token;
    tokens.read = (await users.olaf!('POST', '/me/tokens', { name: 'ci-read', scope: 'read' })).token;
    tokens.dana = (await users.dana!('POST', '/me/tokens', { name: 'dana-read', scope: 'read' })).token;
  });

  it('a proposal from CI lands for review like an assistant’s – never applied by the call', async () => {
    const read = await v1(tokens.read!, '/plant/proposals', {
      method: 'POST',
      body: { title: 'CI sensor', rationale: 'From the repository', document: profileDoc([]) },
    });
    expect(read.status).toBe(403);
    expect(read.body.type).toMatch(/#token-scope$/);
    const r = await v1(tokens.full!, '/plant/proposals', {
      method: 'POST',
      body: { title: 'CI sensor profile', rationale: 'Device profiles kept in the plant repository', document: profileDoc(['T1']) },
    });
    expect(r.status).toBe(201);
    expect(r.headers.get('location')).toBe(`/api/v1/plant/change-sets/${r.body.changeSet.id}`);
    expect(r.body).toMatchObject({ counts: { add: 1, change: 0 }, changeSet: { state: 'proposed', source: 'api', createdBy: 'olaf', catalogue: true } });
    // nothing is written
    expect(await status(s.api('GET', '/plant/profiles/ci-sensor-v1'))).toMatchObject({ status: 404 });
    const id = r.body.changeSet.id;
    const d = await s.api('GET', `/plant/change-sets/${id}`);
    expect(d.proposal).toMatchObject({ rationale: 'Device profiles kept in the plant repository', tokenName: 'ci-full' });
    expect(d.proposal.sources[0]).toMatchObject({ points: [expect.objectContaining({ id: 'temp' })] });
    expect(d.canReturn).toBe(false);
    const [audit] = await s.api('GET', '/audit?action=plant.proposal_created&limit=1');
    expect(audit.details).toMatchObject({ via: 'api', changeSetId: id });
    // a reviewer applies it in Steward
    const pre = await s.api('POST', `/plant/change-sets/${id}/preview`);
    expect(pre.problems).toEqual([]);
    await s.api('POST', `/plant/change-sets/${id}/apply`, { fingerprint: pre.fingerprint });
    expect((await s.api('GET', '/plant/profiles/ci-sensor-v1')).name).toBe('CI sensor, version 1');
    // a proposal is a change in Steward, not a load from a source: no baseline
    expect((await db()).get("SELECT * FROM plant_entry_baselines WHERE kind = 'profile' AND entry_id = 'ci-sensor-v1'")).toBeUndefined();
    // the status, read by the CI job
    const st = await v1(tokens.full!, `/plant/change-sets/${id}`);
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ state: 'applied', decidedBy: ADMIN.username, hiddenOperations: 0, counts: { add: 1 }, proposal: { tokenName: 'ci-full' } });
    const ops = await v1(tokens.read!, `/plant/change-sets/${id}/operations`);
    expect(ops.body).toMatchObject({ items: [{ seq: 1, op: 'import', kind: null, value: { proposal: true } }], nextCursor: null });
  });

  it('refuses what a proposal may not do, with the places', async () => {
    const send = (body: unknown) => v1(tokens.full!, '/plant/proposals', { method: 'POST', body });
    const base = { title: 'CI change', rationale: 'From the repository' };
    const secret = await send({
      ...base,
      document: { version: 1, sites: [{ id: 'west', name: 'West Works', description: 'x', fields: { password: 'hunter2' } }] },
    });
    expect(secret.status).toBe(400);
    expect(secret.body.type).toMatch(/#proposal-refused$/);
    expect(JSON.stringify(secret.body)).not.toContain('hunter2');
    const removing = await send({ ...base, document: { version: 1, remove: [{ kind: 'asset', id: 'lathe-1' }] } });
    expect(removing.status).toBe(400);
    const mode = await send({ ...base, mode: 'replace', document: profileDoc(['T1']) });
    expect(mode.status).toBe(400);
    expect(mode.body.errors).toEqual([expect.objectContaining({ in: 'body', name: 'mode' })]);
    // a list given replaces the list: dropping the known-as name T1 is refused
    const drops = await send({ ...base, document: profileDoc([]) });
    expect(drops.status).toBe(400);
    expect(drops.body.errors[0].message).toContain('would lose');
    const nothing = await send({ ...base, document: profileDoc(['T1']) });
    expect(nothing.status).toBe(400);
    expect(nothing.body.detail).toContain('changes nothing');
    const problems = await send({ ...base, document: { version: 1, assets: [{ id: 'x-1', name: 'X' }] } });
    expect(problems.status).toBe(400);
    expect(problems.body.errors.length).toBeGreaterThan(0);
  });

  it('lists what the token owner may see: their own drafts, others’ change sets of sites they see', async () => {
    await users.olaf!('POST', '/plant/change-sets', { title: 'Olaf’s private draft', current: false });
    const mine = await v1(tokens.read!, '/plant/change-sets?limit=200');
    expect(mine.status).toBe(200);
    expect(mine.body.items.some((x: any) => x.title === 'Olaf’s private draft')).toBe(true);
    const others = await v1(tokens.dana!, '/plant/change-sets?limit=200');
    expect(others.body.items.some((x: any) => x.title === 'Olaf’s private draft')).toBe(false);
    // a site dana may not see: its change sets are neither listed nor counted, nor readable
    const [hidden] = (await s.api('GET', '/plant/change-sets?box=applied&source=import')).items.filter((x: any) => x.sites.includes('east'));
    expect(hidden).toBeTruthy();
    await s.api('PUT', '/plant/sites/east/access', { acl: [{ subject: `user:${ADMIN.username}`, permissions: ['view', 'manage'] }] });
    const all = await v1(tokens.dana!, '/plant/change-sets?limit=200');
    expect(all.body.items.some((x: any) => x.id === hidden.id)).toBe(false);
    expect((await v1(tokens.dana!, `/plant/change-sets/${hidden.id}`)).status).toBe(404);
    await s.api('PUT', '/plant/sites/east/access', { acl: [] });
    // paging: newest first, the cursor goes on where the last page stopped
    const first = await v1(tokens.read!, '/plant/change-sets?limit=2');
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await v1(tokens.read!, `/plant/change-sets?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items[0].createdAt <= first.body.items[1].createdAt).toBe(true);
    expect(second.body.items.map((x: any) => x.id)).not.toContain(first.body.items[1].id);
    const applied = await v1(tokens.read!, '/plant/change-sets?state=applied&source=api');
    expect(applied.body.items.every((x: any) => x.state === 'applied' && x.source === 'api')).toBe(true);
  });
});

describe('at scale', () => {
  it('a large import flags thousands of fields with a bounded number of statements', async () => {
    const N = 3000;
    const big = (model: (i: number) => string) => ({
      name: 'big.yaml',
      content: [
        'version: 1',
        'sites:',
        '  - id: big',
        '    name: Big Works',
        '    assets:',
        ...Array.from({ length: N }, (_, i) => [
          `      - id: big-${i}`,
          `        name: Big ${i}`,
          `        model: ${model(i)}`,
          '        status: operational',
        ]).flat(),
      ].join('\n'),
    });
    await s.api('POST', '/plant/import', { files: [big(() => 'B1')], mode: 'update' });
    const { requestDbStats } = await import('../src/database/timing.js');
    const { stewardCandidates } = await import('../src/plant/changesets/steward.js');
    const count = () => {
      const st = { statements: 0, ms: 0 };
      let n = 0;
      requestDbStats.run(st, () => (n = stewardCandidates(['asset']).size));
      return { n, statements: st.statements };
    };
    // two changed in Steward, then a thousand (besides those of the tests before)
    const before = count().n;
    await s.api('POST', '/plant/bulk', { kind: 'asset', action: 'edit', items: [{ id: 'big-0' }, { id: 'big-1' }], set: { status: 'maintenance' } });
    const few = count();
    expect(few.n - before).toBe(2);
    for (let k = 0; k < 2; k++)
      await s.api('POST', '/plant/bulk', {
        kind: 'asset',
        action: 'edit',
        items: Array.from({ length: 500 }, (_, i) => ({ id: `big-${2 + k * 500 + i}` })),
        set: { status: 'maintenance' },
      });
    const many = count();
    expect(many.n - before).toBe(1002);
    // per kind: the candidates, the entries imported before 0.13, their references and history – per 500, never per entry
    expect(many.statements).toBeLessThanOrEqual(few.statements + 4);
    expect(many.statements).toBeLessThan(12);
    // the preview of the next file: every changed status is flagged (the first 1,000 listed) and kept
    const started = performance.now();
    const pre = await s.api('POST', '/plant/import/preview', { files: [big((i) => (i % 2 ? 'B2' : 'B1'))], mode: 'update' });
    const ms = performance.now() - started;
    expect(pre.changedInSteward).toMatchObject({ total: 1002, kept: 1002 });
    expect(pre.changedInSteward.flags).toHaveLength(1000);
    expect(pre.byKind.asset.change).toBe(N / 2);
    expect(ms).toBeLessThan(60_000);
    const done = await s.api('POST', '/plant/import', { files: [big((i) => (i % 2 ? 'B2' : 'B1'))], mode: 'update', fingerprint: pre.fingerprint });
    expect(done.changedInSteward.kept).toBe(1002);
    expect((await s.api('GET', '/plant/assets/big-1')).status).toBe('maintenance');
    expect((await s.api('GET', '/plant/assets/big-1')).model).toBe('B2');
  }, 180_000);
});

describe('history of external references', () => {
  it('a change of only the external references raises the revision and is in the history', async () => {
    const a = await s.api('GET', '/plant/assets/lathe-1');
    const saved = await s.api('PUT', '/plant/assets/lathe-1', assetBody(a, { refs: [{ system: 'erp', id: '42', url: '', label: '' }] }));
    expect(saved.revision).toBe(a.revision + 1);
    const h = await s.api('GET', '/plant/history?kind=asset&id=lathe-1');
    expect(h.items[0].diff).toEqual([expect.objectContaining({ path: expect.stringContaining('refs') })]);
  });
});
