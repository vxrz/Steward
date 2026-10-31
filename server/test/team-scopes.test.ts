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
