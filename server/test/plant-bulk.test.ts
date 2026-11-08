import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Changing many plant entries at once (0.11.0, docs/PLANT.md#changing-many-entries-at-once): the import's id mapping
 * (rules and a table; mapped entries that exist are renamed, not duplicated), old ids in files, conflicts, the `remove:`
 * list and "Remove entries that are not in the files" (with and without what belongs to an entry), the step-up of bulk
 * changes, and "Edit selected" / "Remove selected" of the lists with their previews, rights and audit entry.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let dana: Client;
let vera: Client;
let token = '';
const PW = 'Plant-password-1';
const OT = fs.readFileSync(path.resolve(__dirname, '../../examples/plant/brightwater-ot-network.plant.yaml'), 'utf8');

const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );
const file = (name: string, content: string | object) => ({ name, content: typeof content === 'string' ? content : YAML.stringify(content) });
const exported = async (q: string) => {
  const res = await fetch(`${s.base}/api/plant/export?${q}`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return res.text();
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  createUser({ username: 'dana', roles: ['designer'], password: PW });
  createUser({ username: 'vera', roles: ['viewer'], password: PW });
  dana = await s.as('dana', PW);
  vera = await s.as('vera', PW);
  token = (await s.api('POST', '/me/tokens', { name: 'read', scope: 'read' })).token;
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  await s.api('POST', '/plant/import', { files: [file('ot.plant.yaml', OT)], mode: 'add' });
});

describe('the import with an id mapping', () => {
  it('export → map with a prefix rule → import renames the entries of a site instead of duplicating them', async () => {
    const yaml = await exported('site=hillcrest');
    const before = await s.api('GET', '/plant/sites/hillcrest');
    const assetsBefore = (await s.api('GET', '/plant/assets?site=hillcrest')).length;
    const body = {
      files: [file('hillcrest.plant.yaml', yaml)],
      mode: 'update',
      idMap: { entries: [], rules: [{ type: 'replacePrefix', from: 'hlc-', to: 'hc-', kinds: ['node', 'asset', 'building'] }] },
    };
    const preview = await s.api('POST', '/plant/import/preview', body);
    expect(preview.ok).toBe(true);
    expect(preview.renames.length).toBeGreaterThan(2);
    expect(preview.renames.every((r: { id: string; newId: string }) => r.id.startsWith('hlc-') && r.newId.startsWith('hc-'))).toBe(true);
    expect(preview.counts.add).toBe(0);
    expect(preview.stepUp).toBe(true);
    // nothing changed by the preview
    expect((await s.api('GET', '/plant/assets?site=hillcrest')).every((a: { id: string }) => a.id.startsWith('hlc-'))).toBe(true);
    // more than one rename: a step-up
    const strict = await s.as('dana', PW, { autoStepUp: false });
    await strict('DELETE', '/auth/step-up');
    expect(await status(strict('POST', '/plant/import', body))).toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    const r = await s.api('POST', '/plant/import', body);
    expect(r.renames.length).toBe(preview.renames.length);
    const after = await s.api('GET', '/plant/assets?site=hillcrest');
    expect(after).toHaveLength(assetsBefore);
    expect(after.every((a: { id: string }) => a.id.startsWith('hc-'))).toBe(true);
    expect((await s.api('GET', '/plant/sites/hillcrest')).areas.length).toBe(before.areas.length);
    // the old ids still read, and the assignments followed
    expect((await s.api('GET', '/plant/assets/hlc-im-01')).id).toBe('hc-im-01');
    expect((await s.api('GET', '/plant/assets/hc-im-01/assignment')).assignment).not.toBeNull();
    const log = await s.api('GET', '/audit?action=plant.ids_changed&limit=1');
    expect(log[0].details.count).toBe(preview.renames.length);
  });

  it('reads old ids in a file as the entries they lead to, with a note', async () => {
    const yaml = (await exported('site=hillcrest')).replace(/hc-im-01/g, 'hlc-im-01');
    const p = await s.api('POST', '/plant/import/preview', { files: [file('old.plant.yaml', yaml)], mode: 'update' });
    expect(p.ok).toBe(true);
    expect(p.aliasUses).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'asset', oldId: 'hlc-im-01', newId: 'hc-im-01' })]));
    expect(p.counts.add).toBe(0);
  });

  it('a mapping table with kinds; refuses two old ids for one new id, chains and taken ids', async () => {
    const yaml = await exported('site=hillcrest');
    const ids = (await s.api('GET', '/plant/assets?site=hillcrest')).map((a: { id: string }) => a.id).sort();
    const two = ids.slice(0, 2);
    const preview = (entries: unknown[]) =>
      s.api('POST', '/plant/import/preview', { files: [file('h.plant.yaml', yaml)], mode: 'update', idMap: { entries, rules: [] } });
    const merged = await preview(two.map((id: string) => ({ kind: 'asset', old: id, new: 'hc-one' })));
    expect(merged.ok).toBe(false);
    expect(merged.problems.map((x: { message: string }) => x.message).join('\n')).toMatch(/would all become asset "hc-one"/);
    const chain = await preview([
      { kind: 'asset', old: two[0], new: two[1] },
      { kind: 'asset', old: two[1], new: 'hc-x' },
    ]);
    expect(chain.ok).toBe(false);
    expect(chain.problems.map((x: { message: string }) => x.message).join('\n')).toMatch(/both an old and a new/);
    const taken = await preview([{ kind: 'asset', old: two[0], new: 'rvs-mill-02' }]);
    expect(taken.ok).toBe(false);
    expect(taken.problems.map((x: { message: string }) => x.message).join('\n')).toMatch(/already/);
    const one = await preview([{ kind: 'asset', old: two[0], new: 'hc-renamed' }]);
    expect(one).toMatchObject({ ok: true, stepUp: true, renames: [expect.objectContaining({ id: two[0], newId: 'hc-renamed' })] });
    // without the right to change the site
    expect(await status(vera('POST', '/plant/import/preview', { files: [file('h.plant.yaml', yaml)], mode: 'update' }))).toMatchObject({ status: 403 });
  });
});

describe('the import as a mass removal', () => {
  it('remove: refuses an entry that still has what belongs to it, unless asked; then removes it with it', async () => {
    const asset = 'rvs-mill-02';
    const f = file('remove.plant.yaml', { version: 1, remove: [{ kind: 'asset', id: asset }] });
    const refused = await s.api('POST', '/plant/import/preview', { files: [f], mode: 'update' });
    expect(refused.ok).toBe(false);
    expect(refused.removals.items[0]).toMatchObject({ id: asset, refused: { code: 'PLANT_REMOVE_HAS_ENTRIES' } });
    const p = await s.api('POST', '/plant/import/preview', { files: [f], mode: 'update', cascade: true });
    expect(p.ok).toBe(true);
    expect(p.removals.items[0].with.map((x: { what: string }) => x.what)).toEqual(expect.arrayContaining(['assignment', 'device']));
    expect(p.stepUp).toBe(false);
    await s.api('POST', '/plant/import', { files: [f], mode: 'update', cascade: true });
    expect(await status(s.api('GET', `/plant/assets/${asset}`))).toMatchObject({ status: 404 });
    const log = await s.api('GET', '/audit?action=plant.imported&limit=1');
    expect(log[0].details.removedEntries).toEqual(expect.arrayContaining([`asset:${asset}`]));
    // the same file again: the entry is not there any more, nothing to do
    const again = await s.api('POST', '/plant/import/preview', { files: [f], mode: 'update', cascade: true });
    expect(again.ok).toBe(true);
    expect(again.removals.items[0].refused.code).toBe('PLANT_ENTRY_NOT_FOUND');
  });

  it('a reference from an entry that stays refuses a removal; an entry in the file and in remove is refused', async () => {
    const vlan = file('v.plant.yaml', { version: 1, remove: [{ kind: 'vlan', site: 'riverside', id: 'rvs-vlan-110' }] });
    const p = await s.api('POST', '/plant/import/preview', { files: [vlan], mode: 'update', cascade: true });
    expect(p.ok).toBe(false);
    expect(p.removals.items[0].refused.code).toBe('PLANT_REMOVE_REFERENCED');
    const noScope = await s.api('POST', '/plant/import/preview', {
      files: [file('n.plant.yaml', { version: 1, remove: [{ kind: 'vlan', id: 'rvs-vlan-110' }] })],
      mode: 'update',
    });
    expect(noScope.ok).toBe(false);
  });

  it('"Remove entries that are not in the files" stays inside the kinds and sites of the files', async () => {
    const yaml = YAML.parse((await exported('site=riverside')).replace(/^#.*\n/gm, ''));
    const assets = yaml.site.assets as { id: string }[];
    const gone = assets.filter((a) => !a.id.includes('mill')).map((a) => a.id);
    yaml.site.assets = assets.filter((a) => a.id.includes('mill'));
    delete yaml.ot_network;
    delete yaml.asset_networks;
    const body = { files: [file('r.plant.yaml', yaml)], mode: 'update', removeMissing: true, cascade: true };
    const p = await s.api('POST', '/plant/import/preview', body);
    expect(p.ok).toBe(true);
    const removed = p.removals.items.map((i: { id: string }) => i.id).sort();
    expect(removed).toEqual(gone.sort());
    // nothing of hillcrest, no VLANs (the files list none), no device profiles
    expect(p.removals.items.every((i: { kind: string }) => i.kind === 'asset')).toBe(true);
    expect(p.stepUp).toBe(gone.length > 1);
    await s.api('POST', '/plant/import', body);
    expect((await s.api('GET', '/plant/assets?site=riverside')).every((a: { id: string }) => a.id.includes('mill'))).toBe(true);
    expect((await s.api('GET', '/plant/assets?site=hillcrest')).length).toBeGreaterThan(0);
  });
});

describe('Edit selected and Remove selected', () => {
  const ids = async (site: string) => (await s.api('GET', `/plant/assets?site=${site}`)).map((a: { id: string }) => a.id);

  it('previews and sets status and tags on many assets in one audited change', async () => {
    const items = (await ids('hillcrest')).map((id: string) => ({ id }));
    const body = { kind: 'asset', action: 'edit', items, set: { status: 'maintenance', addTags: ['bulk'] } };
    const p = await s.api('POST', '/plant/bulk/preview', body);
    expect(p.counts.changed).toBe(items.length);
    expect(p.items[0].fields).toEqual(expect.arrayContaining(['status', 'tags']));
    expect((await s.api('GET', `/plant/assets/${items[0].id}`)).status).not.toBe('maintenance');
    const r = await dana('POST', '/plant/bulk', body);
    expect(r.applied).toBe(true);
    for (const a of await s.api('GET', '/plant/assets?site=hillcrest'))
      expect(a).toMatchObject({ status: 'maintenance', tags: expect.arrayContaining(['bulk']) });
    const log = await s.api('GET', '/audit?action=plant.bulk_changed&limit=1');
    expect(log[0].details).toMatchObject({ kind: 'asset', counts: { changed: items.length } });
    expect(log[0].details.entries).toHaveLength(items.length);
  });

  it('refuses a place of another site and fields the kind does not have; viewers may not', async () => {
    const [first] = await ids('hillcrest');
    const p = await s.api('POST', '/plant/bulk/preview', { kind: 'asset', action: 'edit', items: [{ id: first }], set: { nodeId: 'rvs-machining' } });
    expect(p.items[0]).toMatchObject({ outcome: 'refused', reason: { code: 'PLANT_LOCATION_UNKNOWN' } });
    expect(await status(s.api('POST', '/plant/bulk/preview', { kind: 'asset', action: 'edit', items: [{ id: first }], set: { category: 'x' } }))).toEqual({
      status: 400,
      code: 'PLANT_BULK_FIELD',
    });
    expect(
      await status(vera('POST', '/plant/bulk/preview', { kind: 'asset', action: 'edit', items: [{ id: first }], set: { status: 'planned' } })),
    ).toMatchObject({
      status: 403,
    });
  });

  it('skips entries of a site the person may not change and reports them', async () => {
    const site = await s.api('GET', '/plant/sites/hillcrest');
    await s.api('PUT', '/plant/sites/hillcrest/access', {
      acl: [
        { subject: 'user:admin', permissions: ['view', 'manage'] },
        { subject: 'user:dana', permissions: ['view'] },
      ],
    });
    const items = [...(await ids('hillcrest')), ...(await ids('riverside'))].map((id: string) => ({ id }));
    const p = await dana('POST', '/plant/bulk/preview', { kind: 'asset', action: 'edit', items, set: { status: 'operational' } });
    expect(p.counts.skipped).toBe((await ids('hillcrest')).length);
    expect(p.items.find((i: { outcome: string }) => i.outcome === 'skipped').reason.code).toBe('FORBIDDEN');
    await s.api('PUT', '/plant/sites/hillcrest/access', { acl: site.acl });
  });

  it('removes many with a step-up; what belongs to an entry is refused unless asked', async () => {
    const items = (await ids('hillcrest')).map((id: string) => ({ id }));
    const body = { kind: 'asset', action: 'remove', items };
    const p = await s.api('POST', '/plant/bulk/preview', body);
    expect(p.stepUp).toBe(true);
    expect(p.counts.refused).toBeGreaterThan(0);
    const strict = await s.as('dana', PW, { autoStepUp: false });
    await strict('DELETE', '/auth/step-up');
    expect(await status(strict('POST', '/plant/bulk', { ...body, cascade: true }))).toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    const r = await s.api('POST', '/plant/bulk', { ...body, cascade: true });
    expect(r.counts.removed).toBe(items.length);
    expect(await ids('hillcrest')).toEqual([]);
    expect((await s.api('GET', '/audit?action=plant.bulk_removed&limit=1'))[0].details).toMatchObject({ cascade: true, counts: { removed: items.length } });
  });

  it('edits and removes catalogue entries and VLANs', async () => {
    const kpis = (await s.api('GET', '/plant/kpis')).map((k: { id: string }) => ({ id: k.id }));
    const r = await s.api('POST', '/plant/bulk', { kind: 'kpi', action: 'edit', items: kpis, set: { category: 'Bulk' } });
    expect(r.counts.changed).toBe(kpis.length);
    const vlans = await s.api('POST', '/plant/bulk/preview', {
      kind: 'vlan',
      action: 'edit',
      items: [{ scope: 'riverside', id: 'rvs-vlan-110' }],
      set: { managedBy: 'OT team', restricted: true },
    });
    expect(vlans.items[0]).toMatchObject({ outcome: 'changed' });
    const prof = await s.api('POST', '/plant/bulk/preview', { kind: 'profile', action: 'remove', items: [{ id: 'example-controls-c80' }] });
    expect(prof.items[0]).toMatchObject({ outcome: 'refused', reason: { code: 'PLANT_REMOVE_REFERENCED' } });
  });
});
