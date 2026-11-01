import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tinyPng } from './png.js';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Team defaults (#136): which new resources of its members a team owns, the daily summary its members get unless they
 * chose their own, and report branding that overrides the instance's in the team's reports. A person sees where each
 * value comes from (their own choice, a team default or the instance default) and can go back to the default.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
let s: TestServer;
let tara: Client; // designer, member of Orders and Payments
let dave: Client; // designer, no team
let orders: string;
let payments: string;
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status?: number }) => e.status ?? 0,
  );
const definition = (name: string) => ({
  name,
  nodes: [
    { id: 'start', type: 'start', x: 0, y: 0 },
    { id: 'chk', type: 'check', name: 'Done', condition: 'true', x: 1, y: 0 },
  ],
  wires: [{ from: 'start', port: 'out', to: 'chk' }],
});
const owners = async (kind: string, id: string): Promise<string[]> =>
  ((await s.api('GET', `/owning-teams/${kind}/${id}`)).teams as { name: string }[]).map((t) => t.name).sort();

const png = (): string => tinyPng().toString('base64');

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const users = await import('../src/auth/users.js');
  users.createUser({ username: 'tara', roles: ['designer'], password: PW, mustChangePassword: false });
  users.createUser({ username: 'dave', roles: ['designer'], password: PW, mustChangePassword: false });
  [tara, dave] = await Promise.all(['tara', 'dave'].map((u) => s.as(u, PW)));
  orders = (await s.api('POST', '/teams', { name: 'Orders', members: ['tara'] })).id;
  payments = (await s.api('POST', '/teams', { name: 'Payments', members: ['tara'] })).id;
});
afterAll(async () => {
  await s?.app.close();
});

describe('new resources of members', () => {
  it('by default ("auto") stay the whole instance\'s until the team owns something, as before', async () => {
    const t = await s.api('GET', `/teams/${orders}/settings`);
    expect(t.newResources).toBe('auto');
    expect(await tara('GET', '/me/new-resource-teams')).toMatchObject({ teams: [], source: { from: 'instance' }, chosen: null });
    const p = await tara('POST', '/processes', { definition: definition('Before any team owns something') });
    expect(await owners('process', p.id)).toEqual([]);
  });

  it('"always": the team owns its members\' new resources from the start; "never" leaves the team out', async () => {
    await s.api('PUT', `/teams/${orders}/settings`, { newResources: 'always' });
    expect(await tara('GET', '/me/new-resource-teams')).toMatchObject({ teams: [{ name: 'Orders' }], source: { from: 'team' } });
    const p = await tara('POST', '/processes', { definition: definition('Orders from the start') });
    expect(await owners('process', p.id)).toEqual(['Orders']);
    // Payments owns something now (auto): both teams
    await s.api('PUT', `/owning-teams/process/${p.id}`, { teamIds: [orders, payments] });
    const both = await tara('POST', '/processes', { definition: definition('Both teams') });
    expect(await owners('process', both.id)).toEqual(['Orders', 'Payments']);
    await s.api('PUT', `/teams/${payments}/settings`, { newResources: 'never' });
    const one = await tara('POST', '/processes', { definition: definition('Not Payments') });
    expect(await owners('process', one.id)).toEqual(['Orders']);
    expect((await tara('GET', '/me/new-resource-teams')).choices.map((c: { name: string }) => c.name)).toEqual(['Orders']);
    const audit = (await s.api('GET', '/audit?action=team.settings_changed&limit=1'))[0];
    expect(audit.summary).toContain('new resources of members: never');
    expect(audit.details.scope).toBe('team:Payments');
  });

  it("a member chooses one of their teams for their new resources, and goes back to the teams' defaults", async () => {
    await s.api('PUT', `/teams/${payments}/settings`, { newResources: 'auto' });
    expect(await status(tara('PUT', '/me/new-resource-teams', { teamId: 'team_nope' }))).toBe(400);
    expect(await status(dave('PUT', '/me/new-resource-teams', { teamId: orders }))).toBe(400); // not a member
    const chosen = await tara('PUT', '/me/new-resource-teams', { teamId: payments });
    expect(chosen).toMatchObject({ teams: [{ name: 'Payments' }], source: { from: 'own' }, chosen: payments });
    const p = await tara('POST', '/processes', { definition: definition('Chosen team') });
    expect(await owners('process', p.id)).toEqual(['Payments']);
    // a team set to "never" cannot be (or stay) chosen
    await s.api('PUT', `/teams/${payments}/settings`, { newResources: 'never' });
    expect(await tara('GET', '/me/new-resource-teams')).toMatchObject({ chosen: null, source: { from: 'team' }, teams: [{ name: 'Orders' }] });
    await s.api('PUT', `/teams/${payments}/settings`, { newResources: 'auto' });
    expect((await tara('PUT', '/me/new-resource-teams', { teamId: null })).source).toEqual({ from: 'team' });
    expect((await s.api('GET', '/audit?action=user.new_resource_team_changed')).length).toBeGreaterThanOrEqual(2);
  });
});

describe('daily summary for members', () => {
  const prefs = { enabled: true, time: '08:15', timeZone: 'Europe/Berlin', days: 'weekdays', channel: 'inApp', sections: ['runs', 'tasks'], skipEmpty: false };

  it('members without their own settings get the team default; the instance default without one', async () => {
    expect((await tara('GET', '/me/daily-summary')).source).toEqual({ from: 'instance' });
    // the first team by name that sets one
    await s.api('PUT', `/teams/${payments}/settings`, { summary: { ...prefs, time: '09:00' } });
    await s.api('PUT', `/teams/${orders}/settings`, { summary: prefs });
    const st = await tara('GET', '/me/daily-summary');
    expect(st.source).toEqual({ from: 'team', team: 'Orders' });
    expect(st.prefs).toMatchObject({ enabled: true, time: '08:15', sections: ['runs', 'tasks'] });
    expect((await dave('GET', '/me/daily-summary')).source).toEqual({ from: 'instance' });
    // administrators see them as subscribers; the job sends them a summary
    expect((await s.api('GET', '/settings/daily-summary')).subscribers.map((x: { username: string }) => x.username)).toContain('tara');
    const summary = await import('../src/notifications/summary.js');
    // a Monday, 08:20 in Berlin
    expect(summary.runDailySummaries(Date.parse('2026-11-02T07:20:00Z'))).toBe(1);
  });

  it('their own settings win; "back to the default" removes them', async () => {
    const own = await tara('PUT', '/me/daily-summary', { ...prefs, enabled: false });
    expect(own.source).toEqual({ from: 'own' });
    expect((await s.api('GET', '/settings/daily-summary')).subscribers.map((x: { username: string }) => x.username)).not.toContain('tara');
    const back = await tara('DELETE', '/me/daily-summary');
    expect(back.source).toEqual({ from: 'team', team: 'Orders' });
    expect(back.prefs.enabled).toBe(true);
    await s.api('PUT', `/teams/${orders}/settings`, { summary: null });
    expect((await tara('GET', '/me/daily-summary')).source).toEqual({ from: 'team', team: 'Payments' });
    await s.api('PUT', `/teams/${payments}/settings`, { summary: null });
    expect((await tara('GET', '/me/daily-summary')).source).toEqual({ from: 'instance' });
  });
});

describe('report branding of a team', () => {
  let schedule: string;

  it('overrides the instance branding field by field, with its own logo; members see it, only administrators change it', async () => {
    await s.api('PUT', '/reports/branding', { companyName: 'Example AG', classification: 'Internal' });
    expect(await status(tara('PUT', `/teams/${orders}/settings`, { branding: { companyName: 'Orders unit' } }))).toBe(403);
    const t = await s.api('PUT', `/teams/${orders}/settings`, {
      branding: { companyName: 'Orders unit', accentColor: '#2b8a3e', classification: null, footerNote: null },
    });
    expect(t.branding).toEqual({ companyName: 'Orders unit', accentColor: '#2b8a3e', classification: null, footerNote: null, customLogo: false });
    expect(t.instance.branding.companyName).toBe('Example AG');
    expect(
      await status(s.api('PUT', `/teams/${orders}/settings`, { branding: { companyName: 'x', accentColor: 'green', classification: null, footerNote: null } })),
    ).toBe(400);
    expect(await status(s.api('POST', `/teams/${orders}/settings/logo`, { contentBase64: Buffer.from('not an image').toString('base64') }))).toBe(400);
    const withLogo = await s.api('POST', `/teams/${orders}/settings/logo`, { contentBase64: png() });
    expect(withLogo.branding.customLogo).toBe(true);
    expect((await tara('GET', `/teams/${orders}/settings`)).branding.companyName).toBe('Orders unit');
    expect(await status(dave('GET', `/teams/${orders}/settings/logo`))).toBe(404);
    expect(await status(tara('GET', `/teams/${orders}/settings/logo`))).toBe(200);
  });

  it('a report schedule of the team uses it; its owner must be a member', async () => {
    const body = (team: string | null) => ({
      name: 'Orders weekly',
      preset: 'weekly',
      timezone: 'UTC',
      lang: 'en',
      sections: { runs: { processIds: null } },
      recipients: { users: [], teams: [], emails: [] },
      team,
    });
    expect(await status(dave('POST', '/report-schedules', body('Orders')))).toBe(400);
    expect(await status(tara('POST', '/report-schedules', body('Nobody')))).toBe(400);
    const r = await tara('POST', '/report-schedules', body('Orders'));
    schedule = r.id;
    expect(r.team).toEqual({ id: orders, name: 'Orders' });
    expect((await s.api('GET', `/teams/${orders}/settings`)).reportSchedules).toEqual([{ id: schedule, name: 'Orders weekly' }]);
    const schedules = await import('../src/reports/schedules.js');
    const rec = await schedules.runReportSchedule(schedule, { actor: 'tara', compress: false });
    const text = rec.texts.join('\n');
    expect(text).toContain('Orders unit');
    expect(text).not.toContain('Example AG');
    // classification: the team sets none, so the instance's
    expect(text).toContain('INTERNAL');
  });

  it('follows a renamed team, and goes back to the instance branding when reset', async () => {
    await s.api('PUT', `/teams/${orders}`, { name: 'Order intake' });
    expect((await tara('GET', `/report-schedules/${schedule}`)).team).toEqual({ id: orders, name: 'Order intake' });
    const reset = await s.api('PUT', `/teams/${orders}/settings`, { branding: null });
    expect(reset.branding).toBeNull();
    const schedules = await import('../src/reports/schedules.js');
    const rec = await schedules.runReportSchedule(schedule, { actor: 'tara', compress: false });
    expect(rec.texts.join('\n')).toContain('Example AG');
  });
});

describe('migration packages', () => {
  it("carry team defaults, the team logo and members' choices", async () => {
    const { exportedDefaults, importedDefaults } = await import('../src/teams/settings.js');
    await s.api('PUT', `/teams/${payments}/settings`, {
      newResources: 'always',
      branding: { companyName: 'Payments', accentColor: null, classification: 'Confidential', footerNote: null },
    });
    await s.api('POST', `/teams/${payments}/settings/logo`, { contentBase64: png() });
    const out = exportedDefaults(payments);
    expect(out.defaults).toMatchObject({ newResources: 'always', branding: { companyName: 'Payments' } });
    const back = importedDefaults(out.defaults, out.logo);
    expect(JSON.parse(back.defaults!)).toMatchObject({ newResources: 'always', branding: { classification: 'Confidential' } });
    expect(back.logo).toBe(out.logo);
    // anything invalid is left out
    expect(importedDefaults({ newResources: 'sometimes', branding: { accentColor: 'red' } }, 'bm90IGFuIGltYWdl')).toEqual({ defaults: null, logo: null });
  });
});
