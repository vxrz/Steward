import { beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, loginCookie, setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Plant change sets, 0.13.0 (docs/PLANT.md "Change sets", docs/NOTIFICATIONS.md): who is told that a change set waits
 * for review (plant.change_proposed: who may apply it on its sites, never an author, never who may not see the site)
 * and that it was decided (plant.change_decided: its authors, with the reviewer's comment, not who decided); held
 * messages about a change set decided meanwhile; and the routes behind the web app's forms for who may only propose –
 * the import's and bulk change's preview and "Add to draft", the propose flag of device profiles, KPI definitions, the
 * OT network and data collections.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Plant-password-1';
const users: Record<string, Client> = {};
const db = async () => (await import('../src/db.js')).db();

/** The in-app notifications of an event a person got (after the background sends settled). */
async function inbox(who: string, event: string): Promise<{ title: string; body: string; link: string }[]> {
  const { flushNotifications } = await import('../src/notifications/service.js');
  await new Promise((r) => setTimeout(r, 30));
  await flushNotifications();
  const c = who === 'admin' ? s.api : users[who]!;
  const list = await c('GET', '/notifications?limit=200');
  return list.items.filter((n: { event: string }) => n.event === event);
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

/** A person's draft with one change of an asset, proposed. */
async function proposeAsset(who: string, asset: string, patch: Record<string, unknown>): Promise<string> {
  const c = users[who]!;
  const a = await c('GET', `/plant/assets/${asset}`);
  const d = await c('POST', '/plant/change-sets/current/operations', { op: 'set', kind: 'asset', id: asset, value: assetBody(a, patch), revision: a.revision });
  await c('POST', `/plant/change-sets/${d.id}/propose`);
  return d.id;
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  for (const [name, role] of [
    ['dana', 'designer'],
    ['dirk', 'designer'],
    ['olaf', 'operator'],
    ['otto', 'operator'],
    ['vera', 'viewer'],
  ] as const) {
    createUser({ username: name, roles: [role], password: PW });
    users[name] = await s.as(name, PW);
  }
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  await s.api('POST', '/plant/sites', { id: 'north', name: 'North Works' });
  await s.api('POST', '/plant/assets', { id: 'press-1', siteId: 'north', name: 'Press 1', manufacturer: 'Example Presses' });
  // a site Dirk may not see: only Dana manages it, Olaf may propose there
  await s.api('POST', '/plant/sites', { id: 'east', name: 'East Works' });
  await s.api('POST', '/plant/assets', { id: 'kiln-1', siteId: 'east', name: 'Kiln 1' });
  await s.api('PUT', '/plant/sites/east/access', {
    acl: [
      { subject: 'user:dana', permissions: ['view', 'manage'] },
      { subject: 'user:olaf', permissions: ['view', 'propose'] },
    ],
  });
});

describe('plant.change_proposed and plant.change_decided', () => {
  it('a proposal tells who may apply it – never its author, never who may not change the site', async () => {
    const id = await proposeAsset('olaf', 'press-1', { model: 'P-200' });
    const dana = await inbox('dana', 'plant.change_proposed');
    expect(dana).toHaveLength(1);
    expect(dana[0]).toMatchObject({ title: 'Plant change to review: Changes by olaf', link: `/plant/changes/${id}` });
    expect(dana[0]!.body).toContain('olaf proposes 1 change to the plant registry (sites north)');
    expect(await inbox('dirk', 'plant.change_proposed')).toHaveLength(1);
    expect(await inbox('admin', 'plant.change_proposed')).toHaveLength(1);
    // the author, and who may only propose or view, are not told
    expect(await inbox('olaf', 'plant.change_proposed')).toHaveLength(0);
    expect(await inbox('otto', 'plant.change_proposed')).toHaveLength(0);
    expect(await inbox('vera', 'plant.change_proposed')).toHaveLength(0);

    // rejected with a comment: the author learns it, in their language; who rejected it does not
    await users.olaf!('PATCH', '/me', { locale: 'de' });
    await users.dana!('POST', `/plant/change-sets/${id}/reject`, { comment: 'Das Modell stimmt nicht.' });
    const decided = await inbox('olaf', 'plant.change_decided');
    expect(decided).toHaveLength(1);
    expect(decided[0]!.title).toBe('Ihre Werksänderung wurde abgelehnt: Changes by olaf');
    expect(decided[0]!.body).toContain('dana hat Ihre Änderung abgelehnt.');
    expect(decided[0]!.body).toContain('Kommentar: Das Modell stimmt nicht.');
    expect(await inbox('dana', 'plant.change_decided')).toHaveLength(0);
    await users.olaf!('PATCH', '/me', { locale: 'en' });
  });

  it('returned and applied: the authors are told, who decided is not', async () => {
    const id = await proposeAsset('olaf', 'press-1', { model: 'P-300' });
    await users.dirk!('POST', `/plant/change-sets/${id}/return`, { comment: 'Add the role too' });
    let decided = await inbox('olaf', 'plant.change_decided');
    expect(decided[0]).toMatchObject({ title: 'Your plant change was returned to you: Changes by olaf' });
    expect(decided[0]!.body).toContain('dirk returned your change set to you as a draft');
    expect(decided[0]!.body).toContain('Comment: Add the role too');
    await users.olaf!('POST', `/plant/change-sets/${id}/propose`);
    const seen = await users.dirk!('POST', `/plant/change-sets/${id}/preview`);
    await users.dirk!('POST', `/plant/change-sets/${id}/apply`, { fingerprint: seen.fingerprint });
    decided = await inbox('olaf', 'plant.change_decided');
    expect(decided[0]).toMatchObject({ title: 'Your plant change was applied: Changes by olaf' });
    expect(decided[0]!.body).toContain('dirk applied your change set.');
    expect(await inbox('dirk', 'plant.change_decided')).toHaveLength(0);
  });

  it('a change set of a site someone may not see is not shown to them', async () => {
    const before = (await inbox('dirk', 'plant.change_proposed')).length;
    const id = await proposeAsset('olaf', 'kiln-1', { model: 'K-2' });
    const dana = await inbox('dana', 'plant.change_proposed');
    expect(dana.map((n) => n.link)).toContain(`/plant/changes/${id}`);
    expect(await inbox('dirk', 'plant.change_proposed')).toHaveLength(before);
    // the administrator may change every site
    expect((await inbox('admin', 'plant.change_proposed')).map((n) => n.link)).toContain(`/plant/changes/${id}`);
    await users.olaf!('POST', `/plant/change-sets/${id}/withdraw`);
    // withdrawn by its author: nobody is told
    expect((await inbox('olaf', 'plant.change_decided')).filter((n) => n.link === `/plant/changes/${id}`)).toHaveLength(0);
  });

  it('nobody is told about their own change set; an expired proposal tells its authors', async () => {
    // the administrator proposes: the designers are told, the administrator is not
    const a = await s.api('GET', '/plant/assets/press-1');
    const d = await s.api('POST', '/plant/change-sets/current/operations', { op: 'set', kind: 'asset', id: 'press-1', value: assetBody(a, { role: 'press' }) });
    const adminBefore = (await inbox('admin', 'plant.change_proposed')).length;
    await s.api('POST', `/plant/change-sets/${d.id}/propose`);
    expect(await inbox('admin', 'plant.change_proposed')).toHaveLength(adminBefore);
    expect((await inbox('dana', 'plant.change_proposed')).map((n) => n.link)).toContain(`/plant/changes/${d.id}`);
    // nobody decides in time
    (await db()).run("UPDATE plant_change_sets SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", d.id);
    const { expireChangeSets } = await import('../src/plant/changesets/core.js');
    expect(expireChangeSets()).toBe(1);
    const decided = (await inbox('admin', 'plant.change_decided')).filter((n) => n.link === `/plant/changes/${d.id}`);
    expect(decided).toHaveLength(1);
    expect(decided[0]!.title).toBe('Your plant change expired: Changes by admin');
  });

  it('routes the events to the app and by e-mail by default; held messages about a decided change set are left out', async () => {
    const settings = await s.api('GET', '/settings/notifications');
    expect(settings.routes['plant.change_proposed']).toEqual(['inApp', 'email']);
    expect(settings.routes['plant.change_decided']).toEqual(['inApp', 'email']);
    const id = await proposeAsset('olaf', 'press-1', { description: 'Held' });
    const outbox = await import('../src/notifications/outbox.js');
    const at = new Date().toISOString();
    outbox.holdMessage({
      target: 'team:plant',
      itemKey: `plant.change_proposed:${id}`,
      event: 'plant.change_proposed',
      reason: 'quiet',
      locale: 'en',
      state: { ts: at, title: 'Plant change to review: Changes by olaf', link: `/plant/changes/${id}` },
      about: { changeSet: id },
    });
    const rows = async () => (await db()).all("SELECT * FROM notification_outbox WHERE target = 'team:plant' AND released_at IS NULL") as never;
    const waiting = outbox.renderHeld(await rows(), 'catchup', 'en')!;
    expect(waiting.text).toContain('Decisions waiting for you (1)');
    await users.dana!('POST', `/plant/change-sets/${id}/reject`, { comment: '' });
    const after = outbox.renderHeld(await rows(), 'catchup', 'en')!;
    expect(after.text).toContain('1 decided by others meanwhile');
    expect(after.text).not.toContain('Plant change to review');
    // a person who may no longer see it: left out
    const { listUsers } = await import('../src/auth/users.js');
    const dirk = listUsers().find((u) => u.username === 'dirk')!;
    const id2 = await proposeAsset('olaf', 'kiln-1', { description: 'Held 2' });
    outbox.holdMessage({
      target: `email:${dirk.id}`,
      userId: dirk.id,
      itemKey: `plant.change_proposed:${id2}`,
      event: 'plant.change_proposed',
      reason: 'quiet',
      locale: 'en',
      state: { ts: at, title: 'Plant change to review', link: `/plant/changes/${id2}` },
      about: { changeSet: id2 },
    });
    const own = (await db()).all('SELECT * FROM notification_outbox WHERE target = ? AND released_at IS NULL', `email:${dirk.id}`);
    expect(outbox.renderHeld(own as never, 'catchup', 'en', dirk)).toBeNull();
    await users.olaf!('POST', `/plant/change-sets/${id2}/withdraw`);
  });
});

describe('the routes behind the forms of who may only propose', () => {
  it('device profiles, KPI definitions, the OT network and data collections say whether the reader may propose', async () => {
    await s.api('POST', '/plant/profiles', { id: 'example-plc', name: 'Example PLC', interfaces: [] });
    await s.api('POST', '/plant/kpis', { id: 'example-oee', name: 'Example OEE' });
    for (const url of [
      '/plant/profiles/example-plc',
      '/plant/kpis/example-oee',
      '/plant/sites/north/network',
      '/plant/assets/press-1/network',
      '/plant/assets/press-1/collections',
    ]) {
      expect(await users.olaf!('GET', url), url).toMatchObject({ canManage: false, canPropose: true });
      expect(await users.dana!('GET', url), url).toMatchObject({ canManage: true, canPropose: true });
      expect(await users.vera!('GET', url), url).toMatchObject({ canManage: false, canPropose: false });
    }
    // a profile edited by who may only propose goes into their draft
    const p = await users.olaf!('GET', '/plant/profiles/example-plc');
    const { id: _id, ...own } = p.own;
    const cookie = await loginCookie(s.base, 'olaf', PW);
    const r = await fetch(`${s.base}/api/plant/profiles/example-plc`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-sm-client': '1', 'x-sm-draft': '1', ...authHeaders(cookie) },
      body: JSON.stringify({ ...own, description: 'Proposed text', revision: p.revision }),
    });
    expect(r.status).toBe(202);
    expect((await r.json()).changeSet).toMatchObject({ state: 'draft', catalogue: true });
    expect((await s.api('GET', '/plant/profiles/example-plc')).description).toBe('');
    const draft = (await users.olaf!('GET', '/plant/config')).changeSets.draft;
    await users.olaf!('POST', `/plant/change-sets/${draft.id}/withdraw`);
  });

  it('who may only propose previews an import and a bulk change and adds them to the draft – nothing changes yet', async () => {
    const files = [{ name: 'north.plant.yaml', content: 'version: 1\nassets:\n  - { id: press-1, name: Press 1, model: Q-1, location: { site: north } }\n' }];
    const pre = await users.olaf!('POST', '/plant/import/preview', { files, mode: 'update' });
    expect(pre).toMatchObject({ ok: true, counts: { change: 1 } });
    // the import itself stays with who manages
    expect(await users.olaf!('POST', '/plant/import', { files, mode: 'update' }).catch((e) => e.status)).toBe(403);
    const d = await users.olaf!('POST', '/plant/change-sets/current/operations', { op: 'import', value: { files, mode: 'update' } });
    expect(d).toMatchObject({ state: 'draft', operationCount: 1 });
    const bulk = { kind: 'asset', action: 'edit', items: [{ scope: '', id: 'press-1' }], set: { status: 'maintenance' } };
    const bp = await users.olaf!('POST', '/plant/bulk/preview', bulk);
    expect(bp.counts).toMatchObject({ changed: 1, skipped: 0 });
    const d2 = await users.olaf!('POST', '/plant/change-sets/current/operations', { op: 'bulk', value: bulk });
    expect(d2).toMatchObject({ id: d.id, operationCount: 2 });
    const view = await users.olaf!('POST', `/plant/change-sets/${d.id}/preview`);
    expect(view.entries).toEqual([expect.objectContaining({ kind: 'asset', id: 'press-1', action: 'change' })]);
    expect(view.entries[0].diff.map((x: { path: string }) => x.path).sort()).toEqual(['model', 'status']);
    const now = await s.api('GET', '/plant/assets/press-1');
    expect([now.model, now.status]).not.toContain('Q-1');
    expect(now.status).not.toBe('maintenance');
    // a viewer may not even preview
    expect(await users.vera!('POST', '/plant/import/preview', { files, mode: 'update' }).catch((e) => e.status)).toBe(403);
    expect(await users.vera!('POST', '/plant/bulk/preview', bulk).catch((e) => e.status)).toBe(403);
    // nothing of the previews was audited or written
    expect((await db()).get<{ n: number }>("SELECT COUNT(*) AS n FROM plant_imports WHERE created_by = 'olaf'")!.n).toBe(0);
    await users.olaf!('POST', `/plant/change-sets/${d.id}/withdraw`);
  });
});
