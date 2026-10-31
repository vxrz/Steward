import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Team-scoped access (#131), first part: owning teams on processes and platforms, roles per team, the policy's
 * explanation. A resource without owning teams behaves exactly as before.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
let s: TestServer;
let tara: Client; // designer, member of Orders
let olaf: Client; // viewer, member of Orders with the team role designer
let dave: Client; // designer, not a member
let vic: Client; // viewer, not a member
let aud: Client; // auditor
let orders: string;
let proc: string;
let platform: string;

const db = async () => (await import('../src/db.js')).db();
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status?: number }) => e.status ?? 0,
  );

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup');
  const users = await import('../src/auth/users.js');
  users.createUser({ username: 'tara', roles: ['designer'], password: PW, mustChangePassword: false });
  users.createUser({ username: 'olaf', roles: ['viewer'], password: PW, mustChangePassword: false });
  users.createUser({ username: 'dave', roles: ['designer'], password: PW, mustChangePassword: false });
  users.createUser({ username: 'vic', roles: ['viewer'], password: PW, mustChangePassword: false });
  users.createUser({ username: 'aud', roles: ['auditor'], password: PW, mustChangePassword: false });
  [tara, olaf, dave, vic, aud] = await Promise.all(['tara', 'olaf', 'dave', 'vic', 'aud'].map((u) => s.as(u, PW)));
  orders = (await s.api('POST', '/teams', { name: 'Orders', members: ['tara', 'olaf'], memberRoles: { olaf: ['designer'] } })).id;
  proc = (await s.api('GET', '/processes'))[0].id;
  platform = (await s.api('GET', '/platforms'))[0].id;
});
afterAll(async () => {
  await s?.app.close();
});

describe('team roles', () => {
  it('are kept per member, and listed with the team', async () => {
    const team = (await s.api('GET', '/teams')).find((t: any) => t.id === orders);
    expect(team).toMatchObject({ members: ['olaf', 'tara'], memberRoles: { olaf: ['designer'] } });
    // saving the members again keeps the roles they had
    await s.api('PUT', `/teams/${orders}`, { name: 'Orders', members: ['tara', 'olaf'] });
    expect((await s.api('GET', '/teams')).find((t: any) => t.id === orders).memberRoles).toEqual({ olaf: ['designer'] });
  });
});

describe('owning teams on a process', () => {
  it('change nothing while a process has none', async () => {
    expect((await s.api('GET', `/owning-teams/process/${proc}`)).teams).toEqual([]);
    expect((await dave('GET', `/processes/${proc}`)).permissions).toEqual(expect.arrayContaining(['view', 'edit', 'run']));
    expect((await vic('GET', `/processes/${proc}`)).permissions).toEqual(['view']);
  });

  it('are set by administrators, audited', async () => {
    await expect(tara('PUT', `/owning-teams/process/${proc}`, { teamIds: [orders] })).rejects.toThrow(/403/);
    await expect(s.api('PUT', `/owning-teams/process/${proc}`, { teamIds: ['team_nope'] })).rejects.toThrow(/Unknown team/);
    const r = await s.api('PUT', `/owning-teams/process/${proc}`, { teamIds: [orders] });
    expect(r.teams).toEqual([{ id: orders, name: 'Orders' }]);
    const audit = await s.api('GET', `/audit?action=access.owning_teams_changed`);
    expect(audit[0]).toMatchObject({ entityType: 'process', entityId: proc });
    expect(audit[0].summary).toContain('Orders');
  });

  it('give members their roles in the team, and hide the process from everyone else', async () => {
    expect((await tara('GET', `/processes/${proc}`)).permissions).toEqual(expect.arrayContaining(['view', 'edit', 'run']));
    // a viewer with the team role designer edits the team's process
    expect((await olaf('GET', `/processes/${proc}`)).permissions).toEqual(expect.arrayContaining(['view', 'edit', 'run']));
    // others: as if it did not exist – in lists too
    expect(await status(dave('GET', `/processes/${proc}`))).toBe(404);
    expect(await status(vic('GET', `/processes/${proc}`))).toBe(404);
    expect((await dave('GET', '/processes')).map((p: any) => p.id)).not.toContain(proc);
    expect((await tara('GET', '/processes')).map((p: any) => p.id)).toContain(proc);
    // auditors may view
    expect((await aud('GET', `/processes/${proc}`)).permissions).toEqual(['view']);
  });

  it('take access list entries as exceptions for others', async () => {
    const d = await db();
    d.run('UPDATE processes SET acl = ? WHERE id = ?', JSON.stringify([{ subject: 'user:dave', permissions: ['view'] }]), proc);
    try {
      expect((await dave('GET', `/processes/${proc}`)).permissions).toEqual(['view']);
      // members keep their team roles beside the list
      expect((await tara('GET', `/processes/${proc}`)).permissions).toEqual(expect.arrayContaining(['edit']));
      expect(await status(vic('GET', `/processes/${proc}`))).toBe(404);
    } finally {
      d.run("UPDATE processes SET acl = '[]' WHERE id = ?", proc);
    }
  });

  it('explain where a right comes from', async () => {
    const mine = await olaf('GET', `/access/explain?kind=process&id=${proc}`);
    expect(mine).toMatchObject({ user: 'olaf', owningTeams: [{ name: 'Orders' }] });
    expect(mine.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'teamRole', role: 'designer', team: 'Orders' }),
        expect.objectContaining({ source: 'teamRole', role: 'viewer', team: 'Orders' }),
      ]),
    );
    // others' rights: administrators and auditors only
    const theirs = await aud('GET', `/access/explain?kind=process&id=${proc}&user=tara`);
    expect(theirs.reasons).toEqual([expect.objectContaining({ source: 'teamRole', role: 'designer', team: 'Orders' })]);
    await expect(tara('GET', `/access/explain?kind=process&id=${proc}&user=olaf`)).rejects.toThrow(/403/);
    // those who cannot see the process learn nothing about it
    expect(await status(dave('GET', `/access/explain?kind=process&id=${proc}`))).toBe(404);
  });

  it('give the process back to the whole instance when removed', async () => {
    await s.api('PUT', `/owning-teams/process/${proc}`, { teamIds: [] });
    expect((await dave('GET', `/processes/${proc}`)).permissions).toEqual(expect.arrayContaining(['edit']));
    expect((await vic('GET', `/processes/${proc}`)).permissions).toEqual(['view']);
  });
});

describe('owning teams on a platform', () => {
  it('give members their rights and nobody else', async () => {
    const before = await s.api('GET', `/access/explain?kind=platform&id=${platform}&user=dave`);
    expect(before.permissions).toEqual(['use']);
    await s.api('PUT', `/owning-teams/platform/${platform}`, { teamIds: [orders] });
    try {
      expect((await s.api('GET', `/access/explain?kind=platform&id=${platform}&user=dave`)).permissions).toEqual([]);
      const t = await s.api('GET', `/access/explain?kind=platform&id=${platform}&user=tara`);
      expect(t).toMatchObject({ permissions: ['use'], reasons: [expect.objectContaining({ source: 'teamRole', team: 'Orders' })] });
      expect((await tara('GET', `/platforms/${platform}`)).permissions).toEqual(['use']);
    } finally {
      await s.api('PUT', `/owning-teams/platform/${platform}`, { teamIds: [] });
    }
  });

  it('are removed with their team', async () => {
    const t = (await s.api('POST', '/teams', { name: 'Short-lived', members: ['tara'] })).id;
    await s.api('PUT', `/owning-teams/process/${proc}`, { teamIds: [t] });
    await s.api('DELETE', `/teams/${t}`);
    expect((await s.api('GET', `/owning-teams/process/${proc}`)).teams).toEqual([]);
    expect((await dave('GET', `/processes/${proc}`)).permissions).toEqual(expect.arrayContaining(['edit']));
  });
});

describe('owning teams on the service catalogue', () => {
  let svc: string;
  let app: string;
  let other: string;

  beforeAll(async () => {
    svc = (await s.api('POST', '/services', { name: 'Order intake', owners: ['user:vic'] })).id;
    app = (await s.api('POST', '/applications', { name: 'Order portal', owners: [] })).id;
    other = (await s.api('POST', '/applications', { name: 'Shared wiki', owners: [] })).id;
    await s.api('PUT', `/services/${svc}/applications/${app}`, { role: 'primary' });
  });

  it('change nothing while a service has none', async () => {
    expect((await dave('GET', `/services/${svc}`)).canEdit).toBe(true);
    expect((await aud('GET', '/services')).map((x: any) => x.id)).toContain(svc);
  });

  it('show a team-owned service to its members, owners, administrators and auditors only', async () => {
    await s.api('PUT', `/owning-teams/service/${svc}`, { teamIds: [orders] });
    // members: designers change it, a viewer with the team role designer as well
    expect((await tara('GET', `/services/${svc}`)).canEdit).toBe(true);
    expect((await olaf('GET', `/services/${svc}`)).canEdit).toBe(true);
    // named owner (vic is a viewer outside the team): sees and changes it
    expect((await vic('GET', `/services/${svc}`)).canEdit).toBe(true);
    // auditors see it, without changing it
    expect((await aud('GET', `/services/${svc}`)).canEdit).toBe(false);
    // others: unknown, in lists, details, changes and link pickers
    expect(await status(dave('GET', `/services/${svc}`))).toBe(404);
    expect((await dave('GET', '/services')).map((x: any) => x.id)).not.toContain(svc);
    expect(await status(dave('PUT', `/services/${svc}`, { name: 'x', owners: [] }))).toBe(404);
    expect((await dave('GET', '/link-targets?kind=service&q=order')).map((x: any) => x.id)).not.toContain(svc);
    expect((await tara('GET', '/link-targets?kind=service&q=order')).map((x: any) => x.id)).toContain(svc);
  });

  it('give an application without teams of its own to the teams of its services', async () => {
    expect(await status(dave('GET', `/applications/${app}`))).toBe(404);
    expect((await tara('GET', `/applications/${app}`)).canEdit).toBe(true);
    // an application in no team-owned service stays visible
    expect((await dave('GET', `/applications/${other}`)).name).toBe('Shared wiki');
    const why = await s.api('GET', `/access/explain?kind=application&id=${app}&user=tara`);
    expect(why.owningTeams.map((t: any) => t.name)).toEqual(['Orders']);
    expect(why.reasons).toEqual([expect.objectContaining({ source: 'teamRole', team: 'Orders', permissions: ['view', 'edit'] })]);
  });

  it('give the service back to the whole instance when removed', async () => {
    await s.api('PUT', `/owning-teams/service/${svc}`, { teamIds: [] });
    expect((await dave('GET', `/services/${svc}`)).canEdit).toBe(true);
    expect((await dave('GET', `/applications/${app}`)).canEdit).toBe(true);
  });
});

describe('owning teams on records', () => {
  let rec: string;
  let apo: Client; // approver, not a member
  let ana: Client; // approver, member of Orders

  beforeAll(async () => {
    const users = await import('../src/auth/users.js');
    users.createUser({ username: 'apo', roles: ['approver'], password: PW, mustChangePassword: false });
    users.createUser({ username: 'ana', roles: ['approver'], password: PW, mustChangePassword: false });
    [apo, ana] = await Promise.all(['apo', 'ana'].map((u) => s.as(u, PW)));
    await s.api('PUT', `/teams/${orders}`, { name: 'Orders', members: ['tara', 'olaf', 'ana'], memberRoles: { olaf: ['designer'] } });
    rec = (await s.api('POST', '/records', { type: 'ADR', title: 'Order events on Kafka' })).id;
  });

  it('change nothing while a record has none', async () => {
    expect((await dave('GET', `/records/${rec}`)).permissions.edit).toBe(true);
    expect((await vic('GET', `/records/${rec}`)).permissions.edit).toBe(false);
    expect((await vic('GET', '/records')).map((x: any) => x.id)).toContain(rec);
  });

  it('show a team-owned record to its members, its owner, administrators and auditors only', async () => {
    await s.api('PUT', `/owning-teams/record/${rec}`, { teamIds: [orders] });
    expect((await tara('GET', `/records/${rec}`)).permissions.edit).toBe(true);
    // a viewer with the team role designer changes it
    expect((await olaf('GET', `/records/${rec}`)).permissions.edit).toBe(true);
    expect((await aud('GET', `/records/${rec}`)).permissions.edit).toBe(false);
    for (const c of [dave, vic, apo]) {
      expect(await status(c('GET', `/records/${rec}`))).toBe(404);
      expect((await c('GET', '/records')).map((x: any) => x.id)).not.toContain(rec);
    }
    expect(await status(dave('PUT', `/records/${rec}`, { title: 'x' }))).toBe(404);
    expect(await status(dave('GET', `/owning-teams/record/${rec}`))).toBe(404);
  });

  it('let approvers approve only when they are members', async () => {
    const accept = (r: any) => r.actions.find((a: any) => a.action === 'accept');
    await s.api('POST', `/records/${rec}/transition`, { action: 'propose' });
    expect(accept(await ana('GET', `/records/${rec}`))).toMatchObject({ allowed: true });
    const why = await s.api('GET', `/access/explain?kind=record&id=${rec}&user=ana`);
    expect(why.permissions).toEqual(['view', 'approve']);
    expect(why.reasons).toEqual([expect.objectContaining({ source: 'teamRole', role: 'approver', team: 'Orders' })]);
    expect((await s.api('GET', `/access/explain?kind=record&id=${rec}&user=apo`)).permissions).toEqual([]);
  });

  it('give new records their creator’s teams once the team owns something', async () => {
    // Orders owns rec: tara's new records belong to Orders, dave's (no team) to the whole instance
    const t = (await tara('POST', '/records', { type: 'ADR', title: 'Retry policy' })).id;
    expect((await s.api('GET', `/owning-teams/record/${t}`)).teams).toEqual([{ id: orders, name: 'Orders' }]);
    expect(await status(dave('GET', `/records/${t}`))).toBe(404);
    const d = (await dave('POST', '/records', { type: 'ADR', title: 'Shared logging' })).id;
    expect((await s.api('GET', `/owning-teams/record/${d}`)).teams).toEqual([]);
    // a team that owns nothing: new records stay the whole instance's
    const solo = (await s.api('POST', '/teams', { name: 'Solo', members: ['dave'] })).id;
    const d2 = (await dave('POST', '/records', { type: 'ADR', title: 'Shared tracing' })).id;
    expect((await s.api('GET', `/owning-teams/record/${d2}`)).teams).toEqual([]);
    await s.api('DELETE', `/teams/${solo}`);
  });

  it('give the record back to the whole instance when removed', async () => {
    await s.api('PUT', `/owning-teams/record/${rec}`, { teamIds: [] });
    expect((await vic('GET', `/records/${rec}`)).id).toBe(rec);
  });
});

describe('owning teams on credentials, monitors, dashboards and ticket references', () => {
  const items = (x: any): any[] => (Array.isArray(x) ? x : (x.items ?? x.monitors ?? x.tickets ?? x.references ?? []));
  const kinds = [
    { kind: 'credential', list: '/credentials', one: (id: string) => `/credentials/${id}` },
    { kind: 'monitor', list: '/monitors', one: (id: string) => `/monitors/${id}` },
    { kind: 'dashboard', list: '/dashboards', one: (id: string) => `/dashboards/${id}` },
    { kind: 'ticket', list: '/ticket-references', one: (id: string) => `/ticket-references/${id}` },
  ];
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    if (!items(await s.api('GET', '/ticket-references')).length)
      await s.api('POST', '/ticket-references', { source: 'vendor', externalNumber: 'CS-4711', title: 'Orders slow', vendor: 'Acme', responsible: [] });
    if (!items(await s.api('GET', '/credentials')).length)
      await s.api('POST', '/credentials', { name: 'svc-orders', type: 'technicalUser', rotationIntervalDays: 90, belongsTo: null });
    for (const k of kinds) {
      const all = items(await s.api('GET', k.list));
      // one dave sees today, without an access list
      const pick = all.find((x: any) => !x.acl?.length && !x.isTemplate) ?? all[0];
      expect(pick, k.kind).toBeTruthy();
      ids[k.kind] = pick.id;
    }
  });

  for (const k of kinds) {
    it(`hide a team-owned ${k.kind} from everyone outside the team`, async () => {
      const id = ids[k.kind]!;
      expect(await status(dave('GET', k.one(id)))).toBe(200);
      await s.api('PUT', `/owning-teams/${k.kind}/${id}`, { teamIds: [orders] });
      try {
        expect(await status(dave('GET', k.one(id)))).toBe(404);
        expect(items(await dave('GET', k.list)).map((x: any) => x.id)).not.toContain(id);
        expect(await status(tara('GET', k.one(id)))).toBe(200);
        expect(items(await tara('GET', k.list)).map((x: any) => x.id)).toContain(id);
        expect(await status(aud('GET', k.one(id)))).toBe(200);
        const why = await s.api('GET', `/access/explain?kind=${k.kind}&id=${id}&user=tara`);
        expect(why.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'teamRole', team: 'Orders' })]));
        expect((await s.api('GET', `/access/explain?kind=${k.kind}&id=${id}&user=dave`)).permissions).toEqual([]);
      } finally {
        await s.api('PUT', `/owning-teams/${k.kind}/${id}`, { teamIds: [] });
      }
      expect(await status(dave('GET', k.one(id)))).toBe(200);
    });
  }
});

describe('owning teams in bulk', () => {
  let svc: string;
  let app: string;
  let doc: string;

  beforeAll(async () => {
    svc = (await s.api('POST', '/services', { name: 'Payments', owners: [] })).id;
    app = (await s.api('POST', '/applications', { name: 'Payment gateway', owners: [] })).id;
    await s.api('PUT', `/services/${svc}/applications/${app}`, { role: 'primary' });
    doc = (await s.api('POST', '/records', { type: 'ADR', title: 'Card tokens', links: [{ kind: 'service', id: svc }] })).id;
  });

  it('preview all resources of a service: who gains and who loses visibility, nothing changed', async () => {
    const r = await s.api('POST', '/owning-teams/bulk', { service: svc, teamIds: [orders], preview: true });
    expect(r.applied).toBe(false);
    const byId = new Map(r.resources.map((x: any) => [x.id, x]));
    expect([...byId.keys()]).toEqual(expect.arrayContaining([svc, app, doc]));
    const service: any = byId.get(svc);
    expect(service).toMatchObject({ kind: 'service', before: [], after: ['Orders'], changed: true, gains: [] });
    expect(service.loses).toEqual(expect.arrayContaining(['dave', 'vic']));
    expect(service.loses).not.toContain('tara');
    expect(service.loses).not.toContain('aud');
    expect((await s.api('GET', `/owning-teams/service/${svc}`)).teams).toEqual([]);
    expect((await dave('GET', `/services/${svc}`)).id).toBe(svc);
  });

  it('apply, audited per resource, and take teams away again', async () => {
    await expect(tara('POST', '/owning-teams/bulk', { service: svc, teamIds: [orders] })).rejects.toThrow(/403/);
    const r = await s.api('POST', '/owning-teams/bulk', { service: svc, teamIds: [orders] });
    expect(r).toMatchObject({ applied: true });
    expect(r.changed).toBeGreaterThanOrEqual(3);
    for (const [kind, id] of [
      ['service', svc],
      ['application', app],
      ['record', doc],
    ])
      expect((await s.api('GET', `/owning-teams/${kind}/${id}`)).teams).toEqual([{ id: orders, name: 'Orders' }]);
    expect(await status(dave('GET', `/records/${doc}`))).toBe(404);
    const audit = await s.api('GET', `/audit?action=access.owning_teams_changed&limit=5`);
    expect(audit.some((a: any) => a.entityId === doc && a.summary.includes('bulk change'))).toBe(true);
    const back = await s.api('POST', '/owning-teams/bulk', { service: svc, teamIds: [orders], mode: 'remove' });
    expect(back.resources.find((x: any) => x.id === doc)).toMatchObject({ before: ['Orders'], after: [], gains: expect.arrayContaining(['dave']) });
    expect((await dave('GET', `/records/${doc}`)).id).toBe(doc);
  });
});
