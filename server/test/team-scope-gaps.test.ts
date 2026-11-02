import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Places where owning teams (#131) were not yet applied (security review before v0.3.0): maintenance windows, status
 * pages, adding an application to a service, and owning teams of deleted resources. Items without owning teams keep
 * the behaviour of v0.2.10.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
let s: TestServer;
let tara: Client; // designer, member of Orders
let dave: Client; // designer, not a member
let orders: string;
let teamService: string; // belongs to Orders
let openService: string; // whole instance
let teamApp: string; // part of the Orders service only: belongs to Orders

const hour = 3_600_000;
const windowFor = (targets: { kind: string; id: string }[], title = 'Patch day') => ({
  title,
  startsAt: new Date(Date.now() + hour).toISOString(),
  endsAt: new Date(Date.now() + 2 * hour).toISOString(),
  targets,
  quietMonitors: true,
  pauseMessages: true,
});

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const users = await import('../src/auth/users.js');
  users.createUser({ username: 'tara', roles: ['designer'], password: PW, mustChangePassword: false });
  users.createUser({ username: 'dave', roles: ['designer'], password: PW, mustChangePassword: false });
  [tara, dave] = await Promise.all(['tara', 'dave'].map((u) => s.as(u, PW)));
  orders = (await s.api('POST', '/teams', { name: 'Orders', members: ['tara'] })).id;
  teamService = (await s.api('POST', '/services', { name: 'Orders service', owners: [] })).id;
  openService = (await s.api('POST', '/services', { name: 'Open service', owners: [] })).id;
  await s.api('PUT', `/owning-teams/service/${teamService}`, { teamIds: [orders] });
  teamApp = (await s.api('POST', '/applications', { name: 'Orders app', owners: [] })).id;
  await s.api('PUT', `/services/${teamService}/applications/${teamApp}`, {});
});
afterAll(async () => {
  await s?.app.close();
});

describe('maintenance windows', () => {
  it('are planned for a team’s items only by those who may change them', async () => {
    await expect(dave('POST', '/maintenance-windows', windowFor([{ kind: 'service', id: teamService }]))).rejects.toThrow(/400|403/);
    await expect(dave('POST', '/maintenance-windows', windowFor([{ kind: 'application', id: teamApp }]))).rejects.toThrow(/400|403/);
    const w = await tara('POST', '/maintenance-windows', windowFor([{ kind: 'service', id: teamService }], 'Orders patch day'));
    expect(w.targets).toEqual([expect.objectContaining({ id: teamService, name: 'Orders service' })]);
    // and changed or cancelled by them as well
    await expect(dave('POST', `/maintenance-windows/${w.id}/cancel`, {})).rejects.toThrow(/403|404/);
  });

  it('of the whole instance are planned by every designer, as before', async () => {
    const w = await dave('POST', '/maintenance-windows', windowFor([{ kind: 'service', id: openService }], 'Open patch day'));
    expect(w.canEdit).toBe(true);
  });

  it('of a team are not listed, and their items not named, for others', async () => {
    const titles = (c: Client) => c('GET', '/maintenance-windows').then((l: { windows: { title: string }[] }) => l.windows.map((w) => w.title));
    expect(await titles(tara)).toEqual(expect.arrayContaining(['Orders patch day', 'Open patch day']));
    expect(await titles(dave)).toEqual(['Open patch day']);
    const list = await dave('GET', '/maintenance-windows');
    expect(JSON.stringify(list)).not.toContain(teamService);
    const own = (await tara('GET', '/maintenance-windows')).windows.find((w: { title: string }) => w.title === 'Orders patch day');
    await expect(dave('GET', `/maintenance-windows/${own.id}`)).rejects.toThrow(/404/);
  });
});

describe('status pages', () => {
  it('show a team’s service only when someone who may change it adds it', async () => {
    await expect(dave('POST', '/status-pages', { title: 'Shop', serviceIds: [teamService] })).rejects.toThrow(/400/);
    const open = await dave('POST', '/status-pages', { title: 'Open', serviceIds: [openService] });
    expect(open.serviceIds).toEqual([openService]);
    const page = await tara('POST', '/status-pages', { title: 'Orders', serviceIds: [teamService] });
    // another page editor may change the rest of the page; the team's service stays
    const changed = await dave('PUT', `/status-pages/${page.id}`, { title: 'Orders status', serviceIds: [teamService, openService] });
    expect(changed.serviceIds).toEqual([teamService, openService]);
  });
});

describe('adding an application to a service', () => {
  it('does not make a team’s application one of the whole instance, except by an administrator', async () => {
    await expect(tara('PUT', `/services/${openService}/applications/${teamApp}`, {})).rejects.toThrow(/403/);
    // an outsider does not even find it
    await expect(dave('PUT', `/services/${openService}/applications/${teamApp}`, {})).rejects.toThrow(/404/);
    await expect(dave('GET', `/applications/${teamApp}`)).rejects.toThrow(/403|404/);
    await s.api('PUT', `/services/${openService}/applications/${teamApp}`, {});
    expect((await dave('GET', `/applications/${teamApp}`)).name).toBe('Orders app');
  });
});

describe('owning teams of deleted resources', () => {
  it('go with the resource: a new dashboard of the same name does not inherit them', async () => {
    const yaml = 'name: Ops overview\nwidgets: []\n';
    const d = await s.api('POST', '/dashboards', { text: yaml });
    await s.api('PUT', `/owning-teams/dashboard/${d.id}`, { teamIds: [orders] });
    await s.api('DELETE', `/dashboards/${d.id}`);
    const again = await s.api('POST', '/dashboards', { text: yaml });
    expect(again.id).toBe(d.id);
    expect((await s.api('GET', `/owning-teams/dashboard/${again.id}`)).teams).toEqual([]);
    expect((await dave('GET', `/dashboards/${again.id}`)).name).toBe('Ops overview');
  });
});
