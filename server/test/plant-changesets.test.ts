import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, authHeaders, loginCookie, setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Plant change sets (0.13.0, docs/adr/0020-plant-change-sets.md, docs/PLANT.md "Change sets"): revisions and 409
 * PLANT_ENTRY_CHANGED on the edit forms' routes, history and its tamper evidence, fingerprints of imports, bulk changes
 * and renames, the import's baselines, drafts and proposals by people who may only propose, four-eyes under review
 * (plant.changeSet), the three-way merge, Revert, and the 0.12 script sequence that must keep working.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Plant-password-1';
const users: Record<string, Client> = {};
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string; body?: any }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code, body: e.body }),
  );
const db = async () => (await import('../src/db.js')).db();
/** The raw answer (status and body) – 202 is a success the client does not tell apart. */
let adminCookie = '';
async function raw(cookie: string, method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${s.base}/api${url}`, {
    method,
    headers: { 'x-sm-client': '1', ...authHeaders(cookie), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
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

async function setPolicy(level: 'off' | 'optional' | 'required') {
  const { currentPolicy, writePolicy } = await import('../src/auth/assurance-policy.js');
  const p = currentPolicy();
  writePolicy({ ...p, version: p.version + 1, points: { ...p.points, 'plant.changeSet': { fourEyes: level } } }, new Date().toISOString());
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  for (const [name, role] of [
    ['dana', 'designer'],
    ['dirk', 'designer'],
    ['olaf', 'operator'],
    ['vera', 'viewer'],
  ] as const) {
    createUser({ username: name, roles: [role], password: PW });
    users[name] = await s.as(name, PW);
  }
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  adminCookie = await loginCookie(s.base, ADMIN.username, ADMIN.password);
  await s.api('POST', '/plant/sites', { id: 'north', name: 'North Works' });
  await s.api('POST', '/plant/sites/north/nodes', { id: 'hall-a', level: 'area', name: 'Hall A' });
  await s.api('POST', '/plant/assets', { id: 'press-1', siteId: 'north', name: 'Press 1', manufacturer: 'Example Presses' });
  await s.api('POST', '/plant/sites', { id: 'south', name: 'South Works' });
  await s.api('POST', '/plant/assets', { id: 'mill-1', siteId: 'south', name: 'Mill 1' });
});

describe('revisions and 409 PLANT_ENTRY_CHANGED', () => {
  it('a save of what the form loaded raises the revision; an older revision is refused with a choice per field', async () => {
    const a = await s.api('GET', '/plant/assets/press-1');
    expect(a.revision).toBe(1);
    const saved = await s.api('PUT', '/plant/assets/press-1', { ...assetBody(a, { model: 'P-200' }), revision: 1 });
    expect(saved.revision).toBe(2);
    // nothing changed: no new revision
    expect((await s.api('PUT', '/plant/assets/press-1', { ...assetBody(saved), revision: 2 })).revision).toBe(2);
    // someone else's form still has revision 1
    const stale = await raw(adminCookie, 'PUT', '/plant/assets/press-1', { ...assetBody(a, { model: 'P-300', description: 'Mine' }), revision: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('PLANT_ENTRY_CHANGED');
    expect(stale.body.entryChanged).toMatchObject({ kind: 'asset', id: 'press-1', revision: 2 });
    expect(stale.body.entryChanged.base.model).toBe('');
    expect(stale.body.entryChanged.current.model).toBe('P-200');
    expect(stale.body.entryChanged.conflicts).toEqual([{ path: 'model', keys: ['model'], base: '', theirs: 'P-200', mine: 'P-300' }]);
    // the form sends the chosen values with the revision now
    const again = await s.api('PUT', '/plant/assets/press-1', { ...assetBody(a, { model: 'P-200', description: 'Mine' }), revision: 2 });
    expect(again).toMatchObject({ model: 'P-200', description: 'Mine', revision: 3 });
  });

  it('a body without revision writes as before (scripts and 0.12 clients)', async () => {
    const a = await s.api('GET', '/plant/assets/press-1');
    const saved = await s.api('PUT', '/plant/assets/press-1', assetBody(a, { role: 'press' }));
    expect(saved.role).toBe('press');
    expect(saved.revision).toBe(a.revision + 1);
  });

  it('nested entries carry theirs too: nodes, devices, VLANs, collections, profiles', async () => {
    const site = await s.api('GET', '/plant/sites/north');
    expect(site.revision).toBeGreaterThanOrEqual(1);
    expect(site.areas[0].revision).toBe(1);
    const moved = await s.api('PUT', '/plant/sites/north/nodes/hall-a', { name: 'Hall A1', revision: 1 });
    expect(moved.areas[0]).toMatchObject({ name: 'Hall A1', revision: 2 });
    expect(await status(s.api('PUT', '/plant/sites/north/nodes/hall-a', { name: 'Hall A2', revision: 1 }))).toMatchObject({
      status: 409,
      code: 'PLANT_ENTRY_CHANGED',
    });
    const net = await s.api('POST', '/plant/assets/press-1/devices', { id: 'plc', hostname: 'press-plc' });
    expect(net.devices[0].revision).toBe(1);
    await s.api('POST', '/plant/profiles', { id: 'press-ctl', name: 'Press controller' });
    expect((await s.api('GET', '/plant/profiles/press-ctl')).revision).toBe(1);
  });
});

describe('history', () => {
  it('keeps every change with full values, the change set and who applied it; audit entries carry its id and hashes', async () => {
    const h = await s.api('GET', '/plant/history?kind=asset&id=press-1');
    expect(h.items.length).toBeGreaterThanOrEqual(4);
    const add = h.items.at(-1);
    expect(add).toMatchObject({ op: 'add', revision: 1, by: 'admin', appliedBy: 'admin', changeSet: { source: 'edit' } });
    const model = h.items.find((i: any) => i.diff.some((d: any) => d.path === 'model' && d.after === 'P-200'));
    expect(model).toMatchObject({ op: 'set', revision: 2 });
    expect(h.auditPath).toBe('/audit?q=press-1');
    const [updated] = await s.api('GET', '/audit?action=asset.updated&limit=1');
    expect(updated.details.changeSetId).toMatch(/^pcs_/);
    const [applied] = await s.api('GET', `/audit?action=plant.change_set_applied&limit=1`);
    expect(applied.details).toMatchObject({
      source: 'edit',
      operationsSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      historySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // the hash of the history rows written matches the rows in the database (a row changed later would not)
    const { createHash } = await import('node:crypto');
    // (0.15.0: values stored compressed are decompressed first – raw DEFLATE with the preset dictionary of values.ts)
    const { historyText } = await import('../src/plant/changesets/values.js');
    const rows = (await db()).all<any>('SELECT * FROM plant_entry_history WHERE change_set_id = ? ORDER BY kind, scope, entry_id', applied.entityId);
    const hash = createHash('sha256');
    for (const r of rows)
      hash.update(
        `${r.kind}\u0000${r.scope}\u0000${r.entry_id}\u0000${Number(r.revision)}\u0000${r.op}\u0000${historyText(r.before_values)}\u0000${historyText(r.after_values)}\n`,
      );
    expect(hash.digest('hex')).toBe(applied.details.historySha256);
    const { historySha256Of } = await import('../src/plant/changesets/track.js');
    expect(historySha256Of(applied.entityId)).toBe(applied.details.historySha256);
  });

  it('who cannot see the site sees no history', async () => {
    await s.api('PUT', '/plant/sites/south/access', { acl: [{ subject: 'user:dana', permissions: ['view', 'manage'] }] });
    expect(await status(users.vera!('GET', '/plant/history?kind=asset&id=mill-1'))).toMatchObject({ status: 404 });
    expect((await users.dana!('GET', '/plant/history?kind=asset&id=mill-1')).items.length).toBe(1);
    await s.api('PUT', '/plant/sites/south/access', { acl: [] });
  });
});

const FILE = (model: string) => ({
  name: 'north.yaml',
  content: `version: 1\nsites:\n  - id: north\n    name: North Works\n    assets:\n      - id: press-2\n        name: Press 2\n        model: ${model}\n`,
});

describe('fingerprints: import, bulk change, rename', () => {
  it('an import applies what its preview showed – or refuses; without the fingerprint it applies as before; baselines are recorded', async () => {
    const pre = await s.api('POST', '/plant/import/preview', { files: [FILE('X1')], mode: 'update' });
    expect(pre.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    // meanwhile the registry changed: the same files would write something else
    await s.api('POST', '/plant/assets', { id: 'press-2', siteId: 'north', name: 'Press 2', model: 'Y' });
    expect(await status(s.api('POST', '/plant/import', { files: [FILE('X1')], mode: 'update', fingerprint: pre.fingerprint }))).toMatchObject({
      status: 409,
      code: 'PLANT_IMPORT_CHANGED',
    });
    expect((await s.api('GET', '/plant/assets/press-2')).model).toBe('Y');
    const now = await s.api('POST', '/plant/import/preview', { files: [FILE('X1')], mode: 'update' });
    const done = await s.api('POST', '/plant/import', { files: [FILE('X1')], mode: 'update', fingerprint: now.fingerprint });
    expect(done.counts.change).toBe(1);
    const { baselineOf } = await import('../src/plant/changesets/track.js');
    expect(baselineOf('asset', '', 'press-2')).toMatchObject({ importId: done.import.id, values: { model: 'X1' } });
    // 0.15.0: stored as the revision the import left (its values are read back through the history)
    const base = (await db()).get<any>("SELECT * FROM plant_entry_baselines WHERE kind = 'asset' AND entry_id = 'press-2'");
    expect(base).toMatchObject({ import_id: done.import.id, field_values: null });
    expect(Number(base.revision)).toBe((await s.api('GET', '/plant/assets/press-2')).revision);
    // a script without fingerprint
    const script = await s.api('POST', '/plant/import', { files: [FILE('X2')], mode: 'update' });
    expect(script.counts.change).toBe(1);
    const [imported] = await s.api('GET', '/audit?action=plant.imported&limit=1');
    expect(imported.details.changeSetId).toMatch(/^pcs_/);
    const h = await s.api('GET', '/plant/history?kind=asset&id=press-2');
    expect(h.items[0]).toMatchObject({
      op: 'set',
      changeSet: { source: 'import', importId: script.import.id },
      diff: [{ path: 'model', before: 'X1', after: 'X2' }],
    });
  });

  it('a bulk change and a rename: the fingerprint of the preview, refused when different', async () => {
    const body = { kind: 'asset', action: 'edit', items: [{ id: 'press-1' }, { id: 'press-2' }], set: { status: 'maintenance' } };
    const pre = await s.api('POST', '/plant/bulk/preview', body);
    await s.api('PUT', '/plant/assets/press-2', assetBody(await s.api('GET', '/plant/assets/press-2'), { status: 'maintenance' }));
    expect(await status(s.api('POST', '/plant/bulk', { ...body, fingerprint: pre.fingerprint }))).toMatchObject({ status: 409, code: 'PLANT_BULK_CHANGED' });
    const now = await s.api('POST', '/plant/bulk/preview', body);
    expect((await s.api('POST', '/plant/bulk', { ...body, fingerprint: now.fingerprint })).counts.changed).toBe(1);
    const r = await s.api('POST', '/plant/ids/rename/preview', { kind: 'asset', id: 'press-2', newId: 'press-02' });
    expect(r.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    await s.api('POST', '/plant/ids/rename', { kind: 'asset', id: 'press-2', newId: 'press-02', fingerprint: r.fingerprint });
    // the history follows the rename; the old id still reads
    const h = await s.api('GET', '/plant/history?kind=asset&id=press-02');
    expect(h.items[0]).toMatchObject({ op: 'rename', diff: [{ path: 'id', before: 'press-2', after: 'press-02' }] });
    expect(h.items.some((i: any) => i.changeSet?.source === 'import')).toBe(true);
    expect((await s.api('GET', '/plant/history?kind=asset&id=press-2')).items[0].entryId).toBe('press-02');
  });
});

describe('drafts, proposals and four-eyes', () => {
  it('who may only propose keeps a draft (the route itself still refuses them while nothing needs review)', async () => {
    const a = await users.olaf!('GET', '/plant/assets/press-1');
    expect(a).toMatchObject({ canManage: false, canPropose: true });
    expect(await status(users.olaf!('PUT', '/plant/assets/press-1', assetBody(a, { domain: 'forming' })))).toMatchObject({ status: 403 });
    expect(
      await status(users.vera!('POST', '/plant/change-sets/current/operations', { op: 'set', kind: 'asset', id: 'press-1', value: assetBody(a) })),
    ).toMatchObject({
      status: 403,
    });
    const d = await users.olaf!('POST', '/plant/change-sets/current/operations', {
      op: 'set',
      kind: 'asset',
      id: 'press-1',
      value: assetBody(a, { domain: 'forming' }),
      revision: a.revision,
    });
    expect(d).toMatchObject({ state: 'draft', source: 'draft', operationCount: 1, canPropose: true, canApply: false });
    // the person's draft: in the config, on the entry's chip, not visible to others
    expect((await users.olaf!('GET', '/plant/config')).changeSets.draft.id).toBe(d.id);
    expect(await users.olaf!('GET', '/plant/change-sets/open?kind=asset&id=press-1')).toMatchObject({ count: 1, mine: 1 });
    expect(await status(users.dana!('GET', `/plant/change-sets/${d.id}`))).toMatchObject({ status: 404 });
    const pre = await users.olaf!('POST', `/plant/change-sets/${d.id}/preview`);
    expect(pre).toMatchObject({ ok: true, review: false, applyBlocked: { code: 'FORBIDDEN' } });
    expect(pre.entries).toEqual([
      expect.objectContaining({ kind: 'asset', id: 'press-1', action: 'change', diff: [{ path: 'domain', before: '', after: 'forming' }] }),
    ]);
    const proposed = await users.olaf!('POST', `/plant/change-sets/${d.id}/propose`);
    expect(proposed.state).toBe('proposed');
    // a manager reviews and applies it with the fingerprint of the preview they saw
    const list = await users.dana!('GET', '/plant/change-sets?box=review');
    expect(list.items.map((x: any) => x.id)).toContain(d.id);
    const seen = await users.dana!('POST', `/plant/change-sets/${d.id}/preview`);
    expect(seen.applyBlocked).toBeNull();
    expect(await status(users.dana!('POST', `/plant/change-sets/${d.id}/apply`, { fingerprint: 'x' }))).toMatchObject({
      status: 409,
      code: 'PLANT_CHANGESET_CHANGED',
    });
    const applied = await users.dana!('POST', `/plant/change-sets/${d.id}/apply`, { fingerprint: seen.fingerprint });
    expect(applied).toMatchObject({ state: 'applied', decidedBy: 'dana' });
    expect((await s.api('GET', '/plant/assets/press-1')).domain).toBe('forming');
    const h = await s.api('GET', '/plant/history?kind=asset&id=press-1');
    expect(h.items[0]).toMatchObject({ by: 'olaf', appliedBy: 'dana', changeSet: { id: d.id } });
  });

  it('under review every edit goes into the author’s draft (202); no author applies it, administrators included', async () => {
    await setPolicy('optional');
    expect(await status(users.olaf!('PUT', '/plant/sites/north/review', { review: true }))).toMatchObject({ status: 403 });
    expect((await s.api('PUT', '/plant/sites/north/review', { review: true })).review).toBe(true);
    const a = await s.api('GET', '/plant/assets/press-1');
    const r = await raw(adminCookie, 'PUT', '/plant/assets/press-1', { ...assetBody(a, { processArea: 'stamping' }), revision: a.revision });
    expect(r.status).toBe(202);
    // the answer is the asset as it would be, with the draft
    expect(r.body).toMatchObject({ processArea: 'stamping', changeSet: { state: 'draft', createdBy: 'admin' } });
    expect((await s.api('GET', '/plant/assets/press-1')).processArea).toBe('');
    const id = r.body.changeSet.id;
    expect(await status(s.api('POST', `/plant/change-sets/${id}/apply`, { fingerprint: 'x' }))).toMatchObject({
      status: 409,
      code: 'PLANT_CHANGESET_PROPOSE_FIRST',
    });
    await s.api('POST', `/plant/change-sets/${id}/propose`);
    const pre = await s.api('POST', `/plant/change-sets/${id}/preview`);
    expect(pre.applyBlocked).toMatchObject({ code: 'PLANT_CHANGESET_OWN' });
    expect(await status(s.api('POST', `/plant/change-sets/${id}/apply`, { fingerprint: pre.fingerprint }))).toMatchObject({
      status: 409,
      code: 'PLANT_CHANGESET_OWN',
    });
    // a second person: back to the author first, then applied
    await users.dirk!('POST', `/plant/change-sets/${id}/return`, { comment: 'Name the area' });
    expect((await s.api('GET', `/plant/change-sets/${id}`)).state).toBe('draft');
    await s.api('POST', `/plant/change-sets/${id}/propose`);
    const seen = await users.dirk!('POST', `/plant/change-sets/${id}/preview`);
    await users.dirk!('POST', `/plant/change-sets/${id}/apply`, { fingerprint: seen.fingerprint });
    expect((await s.api('GET', '/plant/assets/press-1')).processArea).toBe('stamping');
    // a site without review: as before
    const m = await s.api('GET', '/plant/assets/mill-1');
    expect((await raw(adminCookie, 'PUT', '/plant/assets/mill-1', assetBody(m, { role: 'mill' }))).status).toBe(200);
    // an import into a reviewed site becomes a proposal (also for scripts)
    const imp = await raw(adminCookie, 'POST', '/plant/import', { files: [FILE('X3')], mode: 'update' });
    expect(imp.status).toBe(202);
    expect(imp.body.changeSet).toMatchObject({ state: 'proposed', source: 'import' });
    const ip = await users.dirk!('POST', `/plant/change-sets/${imp.body.changeSet.id}/preview`);
    await users.dirk!('POST', `/plant/change-sets/${imp.body.changeSet.id}/apply`, { fingerprint: ip.fingerprint });
    expect((await s.api('GET', '/plant/assets/press-02')).model).toBe('X3');
    // a rejected one stays rejected; its author may copy it into a new draft
    const r2 = await raw(adminCookie, 'PUT', '/plant/sites/north', { name: 'North Works 2' });
    await s.api('POST', `/plant/change-sets/${r2.body.changeSet.id}/propose`);
    await users.dirk!('POST', `/plant/change-sets/${r2.body.changeSet.id}/reject`, { comment: 'No' });
    expect(await s.api('GET', `/plant/change-sets/${r2.body.changeSet.id}`)).toMatchObject({ state: 'rejected', comment: 'No', canCopy: true });
    const copy = await s.api('POST', `/plant/change-sets/${r2.body.changeSet.id}/copy`);
    expect(copy).toMatchObject({ state: 'draft', copiedFrom: r2.body.changeSet.id, operationCount: 1 });
    await s.api('POST', `/plant/change-sets/${copy.id}/withdraw`);
    await s.api('PUT', '/plant/sites/north/review', { review: false });
    await setPolicy('off');
  });
});

describe('the three-way merge and Revert', () => {
  it('merges what others changed meanwhile; a field both changed is a conflict resolved per field', async () => {
    const a = await users.olaf!('GET', '/plant/assets/press-1');
    const d = await users.olaf!('POST', '/plant/change-sets/current/operations', {
      op: 'set',
      kind: 'asset',
      id: 'press-1',
      value: assetBody(a, { manufacturer: 'Mine Presses', model: 'P-500' }),
      revision: a.revision,
    });
    // meanwhile someone else changes one field the same and one differently, and one the draft did not touch
    await s.api('PUT', '/plant/assets/press-1', assetBody(a, { model: 'P-400', tags: ['line-a'] }));
    const pre = await users.olaf!('POST', `/plant/change-sets/${d.id}/preview`);
    expect(pre.stale).toBe(true);
    expect(pre.ok).toBe(false);
    expect(pre.conflicts).toEqual([expect.objectContaining({ path: 'model', base: 'P-200', theirs: 'P-400', mine: 'P-500', choice: null })]);
    await users.olaf!('POST', `/plant/change-sets/${d.id}/resolve`, { choices: [{ seq: 1, path: 'model', choice: 'theirs' }] });
    const ok = await users.olaf!('POST', `/plant/change-sets/${d.id}/preview`);
    expect(ok.ok).toBe(true);
    await users.olaf!('POST', `/plant/change-sets/${d.id}/propose`);
    const seen = await users.dana!('POST', `/plant/change-sets/${d.id}/preview`);
    await users.dana!('POST', `/plant/change-sets/${d.id}/apply`, { fingerprint: seen.fingerprint });
    expect(await s.api('GET', '/plant/assets/press-1')).toMatchObject({ manufacturer: 'Mine Presses', model: 'P-400', tags: ['line-a'] });
  });

  it('Revert writes a new draft with the inverse operations; a later edit conflicts instead of being overwritten', async () => {
    const before = await s.api('GET', '/plant/assets/press-1');
    const r = await s.api('PUT', '/plant/assets/press-1', assetBody(before, { description: 'Reverted soon', role: 'stamping press' }));
    const cs = (await s.api('GET', '/plant/history?kind=asset&id=press-1')).items[0].changeSet.id;
    expect(r.description).toBe('Reverted soon');
    // a later edit of one of the fields
    await s.api('PUT', '/plant/assets/press-1', assetBody(r, { role: 'servo press' }));
    const rev = await s.api('POST', `/plant/change-sets/${cs}/revert`);
    expect(rev).toMatchObject({ state: 'draft', source: 'revert', reverts: cs, operationCount: 1 });
    const pre = await s.api('POST', `/plant/change-sets/${rev.id}/preview`);
    expect(pre.conflicts.map((c: any) => c.path)).toEqual(['role']);
    await s.api('POST', `/plant/change-sets/${rev.id}/resolve`, { choices: [{ seq: 1, path: 'role', choice: 'theirs' }] });
    const ok = await s.api('POST', `/plant/change-sets/${rev.id}/preview`);
    await s.api('POST', `/plant/change-sets/${rev.id}/apply`, { fingerprint: ok.fingerprint });
    expect(await s.api('GET', '/plant/assets/press-1')).toMatchObject({ description: before.description, role: 'servo press' });
    // an added entry is reverted by removing it; one history row on its own
    await s.api('POST', '/plant/assets', { id: 'temp-1', siteId: 'north', name: 'Temporary' });
    const row = (await s.api('GET', '/plant/history?kind=asset&id=temp-1')).items[0];
    expect(row.canRevert).toBe(true);
    const undo = await s.api('POST', `/plant/history/${row.id}/revert`);
    expect(undo.operations[0]).toMatchObject({ op: 'remove', kind: 'asset', id: 'temp-1' });
    const p2 = await s.api('POST', `/plant/change-sets/${undo.id}/preview`);
    await s.api('POST', `/plant/change-sets/${undo.id}/apply`, { fingerprint: p2.fingerprint });
    expect(await status(s.api('GET', '/plant/assets/temp-1'))).toMatchObject({ status: 404 });
    // the history of the removed entry stays (kept 3 years)
    const gone = (await db()).all<any>("SELECT op, removed_at FROM plant_entry_history WHERE kind = 'asset' AND entry_id = 'temp-1' ORDER BY at");
    expect(gone.map((x) => x.op)).toEqual(['add', 'remove']);
    expect(gone.every((x) => !!x.removed_at)).toBe(true);
  });
});

describe('assistants’ proposals', () => {
  /** tools/call of the MCP endpoint → { isError, data } */
  async function call(token: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any }> {
    const res = await fetch(`${s.base}/api/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': name,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name,
          arguments: args,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
          },
        },
      }),
    });
    const body = (await res.json()) as any;
    if (body.error) return { isError: true, data: body.error.message };
    return { isError: !!body.result.isError, data: body.result.isError ? body.result.content[0].text : body.result.structuredContent };
  }
  const doc = (description: string) => ({ version: 1, device_profile: { id: 'press-ctl', name: 'Press controller', description } });

  it('are proposed change sets on their AI request; with the propose right; under review the token owner never applies', async () => {
    await s.api('PUT', '/mcp-server', { enabled: true });
    // an operator may propose (0.13.0) – not only who may import
    const olafToken = (await users.olaf!('POST', '/me/tokens', { name: 'olaf assistant', scope: 'mcp' })).token;
    const p1 = await call(olafToken, 'propose_plant_changes', {
      title: 'Describe the controller',
      rationale: 'From the vendor manual (example)',
      document: doc('Example text 1'),
    });
    expect(p1.isError, String(p1.data)).toBe(false);
    const cs1 = (await db()).get<{ id: string; state: string; source: string }>(
      'SELECT id, state, source FROM plant_change_sets WHERE mcp_request_id = ?',
      p1.data.requestId,
    )!;
    expect(cs1).toMatchObject({ state: 'proposed', source: 'assistant' });
    const list = await users.dana!('GET', '/plant/change-sets?box=review&source=assistant');
    expect(list.items.map((x: any) => x.id)).toContain(cs1.id);
    // applied from Plant → Changes: through its request (both inboxes agree)
    const pre = await users.dana!('POST', `/plant/change-sets/${cs1.id}/preview`);
    expect(pre.entries).toEqual([expect.objectContaining({ kind: 'profile', id: 'press-ctl', action: 'change' })]);
    await users.dana!('POST', `/plant/change-sets/${cs1.id}/apply`, { fingerprint: pre.fingerprint });
    expect((await s.api('GET', `/mcp-requests/${p1.data.requestId}`)).status).toBe('done');
    expect((await s.api('GET', `/plant/change-sets/${cs1.id}`)).state).toBe('applied');
    expect((await s.api('GET', '/plant/history?kind=profile&id=press-ctl')).items[0]).toMatchObject({
      by: 'olaf',
      appliedBy: 'dana',
      changeSet: { source: 'assistant' },
    });

    // the catalogue needs a second person: Dana's own assistant's proposal is applied by someone else
    await setPolicy('optional');
    await s.api('PUT', '/plant/change-sets/settings', { catalogueReview: true });
    const danaToken = (await users.dana!('POST', '/me/tokens', { name: 'dana assistant', scope: 'mcp' })).token;
    const p2 = await call(danaToken, 'propose_plant_changes', {
      title: 'Describe it again',
      rationale: 'From the vendor manual (example)',
      document: doc('Example text 2'),
    });
    expect(p2.isError, String(p2.data)).toBe(false);
    expect(await status(users.dana!('POST', `/mcp-requests/${p2.data.requestId}/decision`, { approve: true, comment: '' }))).toMatchObject({ status: 403 });
    const cs2 = (await db()).get<{ id: string }>('SELECT id FROM plant_change_sets WHERE mcp_request_id = ?', p2.data.requestId)!.id;
    const pre2 = await users.dirk!('POST', `/plant/change-sets/${cs2}/preview`);
    expect((await users.dana!('POST', `/plant/change-sets/${cs2}/preview`)).applyBlocked).toMatchObject({ code: 'PLANT_CHANGESET_OWN' });
    await users.dirk!('POST', `/mcp-requests/${p2.data.requestId}/decision`, { approve: true, comment: 'Checked' });
    expect((await s.api('GET', `/plant/change-sets/${cs2}`)).state).toBe('applied');
    expect(pre2.ok).toBe(true);
    // rejected through AI requests: the change set follows
    const p3 = await call(danaToken, 'propose_plant_changes', {
      title: 'And once more',
      rationale: 'From the vendor manual (example)',
      document: doc('Example text 3'),
    });
    await users.dirk!('POST', `/mcp-requests/${p3.data.requestId}/decision`, { approve: false, comment: 'No' });
    expect((await (await db()).get<{ state: string }>('SELECT state FROM plant_change_sets WHERE mcp_request_id = ?', p3.data.requestId))!.state).toBe(
      'rejected',
    );
    await s.api('PUT', '/plant/change-sets/settings', { catalogueReview: false });
    await setPolicy('off');
  });
});

describe('limits', () => {
  it('a person keeps at most 20 open change sets', async () => {
    const { PLANT_CHANGESET_LIMITS } = await import('@sm/shared');
    const open = Number(
      (await db()).get<{ n: number }>("SELECT COUNT(*) AS n FROM plant_change_sets WHERE created_by = 'dirk' AND state IN ('draft', 'proposed')")!.n,
    );
    for (let i = open; i < PLANT_CHANGESET_LIMITS.openPerUser; i++) await users.dirk!('POST', '/plant/change-sets', { title: `Draft ${i}`, current: false });
    expect(await status(users.dirk!('POST', '/plant/change-sets', { title: 'One more' }))).toMatchObject({ status: 409, code: 'PLANT_CHANGESET_LIMIT' });
    const big = {
      op: 'set',
      kind: 'asset',
      id: 'press-1',
      value: { ...assetBody(await s.api('GET', '/plant/assets/press-1')), description: 'x'.repeat(300_000) },
    };
    expect(await status(users.olaf!('POST', '/plant/change-sets/current/operations', big))).toMatchObject({ status: 400 });
  });
});

describe('0.12 scripts keep working (plant.changeSet off)', () => {
  it('create, change, import, bulk change, rename and remove without revisions or fingerprints', async () => {
    const t = await s.api('POST', '/me/tokens', { name: 'nightly', scope: 'write' }).catch(() => null);
    void t;
    const site = await s.api('POST', '/plant/sites', { id: 'legacy', name: 'Legacy Works' });
    expect(site).toMatchObject({ id: 'legacy', name: 'Legacy Works', permissions: ['view', 'manage'] });
    const asset = await s.api('POST', '/plant/assets', { id: 'legacy-1', siteId: 'legacy', name: 'Legacy 1' });
    expect(asset.id).toBe('legacy-1');
    const changed = await s.api('PUT', '/plant/assets/legacy-1', { siteId: 'legacy', name: 'Legacy One' });
    expect(changed.name).toBe('Legacy One');
    const pre = await s.api('POST', '/plant/import/preview', {
      files: [
        { name: 'l.yaml', content: 'version: 1\nsites:\n  - id: legacy\n    name: Legacy Works\n    assets:\n      - id: legacy-2\n        name: Legacy 2\n' },
      ],
      mode: 'update',
    });
    expect(pre.ok).toBe(true);
    const imp = await s.api('POST', '/plant/import', {
      files: [
        { name: 'l.yaml', content: 'version: 1\nsites:\n  - id: legacy\n    name: Legacy Works\n    assets:\n      - id: legacy-2\n        name: Legacy 2\n' },
      ],
      mode: 'update',
    });
    expect(imp.counts.add).toBe(1);
    const bulk = await s.api('POST', '/plant/bulk', {
      kind: 'asset',
      action: 'edit',
      items: [{ id: 'legacy-1' }, { id: 'legacy-2' }],
      set: { status: 'planned' },
    });
    expect(bulk).toMatchObject({ applied: true, counts: { changed: 2 } });
    const ren = await s.api('POST', '/plant/ids/rename', { kind: 'asset', id: 'legacy-2', newId: 'legacy-two' });
    expect(ren).toMatchObject({ newId: 'legacy-two', path: '/plant/assets/legacy-two' });
    expect(await s.api('DELETE', '/plant/assets/legacy-two')).toEqual({ ok: true });
    const rm = await s.api('POST', '/plant/bulk', { kind: 'asset', action: 'remove', items: [{ id: 'legacy-1' }] });
    expect(rm.counts.removed).toBe(1);
    expect(await s.api('DELETE', '/plant/sites/legacy')).toEqual({ ok: true });
    // every step a change set of its own, applied at once
    const sources = (await db())
      .all<{ source: string }>("SELECT source FROM plant_change_sets WHERE state = 'applied' ORDER BY created_at DESC LIMIT 8")
      .map((r) => r.source);
    expect(new Set(sources)).toEqual(new Set(['edit', 'import', 'bulk', 'rename']));
  });
});

describe('copying someone else’s change set (security review 0.19.0)', () => {
  it('is refused when it has changes in sites the copier may not see; its author copies it', async () => {
    const a = await s.api('GET', '/plant/assets/press-1');
    const m = await s.api('GET', '/plant/assets/mill-1');
    const d = await s.api('POST', '/plant/change-sets/current/operations', {
      op: 'set',
      kind: 'asset',
      id: 'press-1',
      value: assetBody(a, { description: 'Copy north' }),
      revision: a.revision,
    });
    await s.api('POST', '/plant/change-sets/current/operations', {
      op: 'set',
      kind: 'asset',
      id: 'mill-1',
      value: assetBody(m, { description: 'Copy south' }),
      revision: m.revision,
    });
    await s.api('POST', `/plant/change-sets/${d.id}/withdraw`);
    // South for the administrator only: dirk sees the change set through North
    await s.api('PUT', '/plant/sites/south/access', { acl: [{ subject: `user:${ADMIN.username}`, permissions: ['view', 'manage'] }] });
    try {
      expect(await users.dirk!('GET', `/plant/change-sets/${d.id}`)).toMatchObject({ hiddenOperations: 1, canCopy: false });
      expect(await status(users.dirk!('POST', `/plant/change-sets/${d.id}/copy`))).toMatchObject({ status: 409, code: 'PLANT_CHANGESET_COPY_PARTIAL' });
      const copy = await s.api('POST', `/plant/change-sets/${d.id}/copy`);
      expect(copy).toMatchObject({ state: 'draft', operationCount: 2 });
      await s.api('POST', `/plant/change-sets/${copy.id}/withdraw`);
    } finally {
      await s.api('PUT', '/plant/sites/south/access', { acl: [] });
    }
  });
});
