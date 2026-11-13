import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlantExtractPreview } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The Access tab of device profiles and KPI definitions, and their copies (0.21.0, follow-ups of #293; ADR 0033 parts
 * 3 and 4, decisions 9, 10 and 13):
 *
 * - the share API (`/api/access/:kind/:id/…`) takes both kinds with plant ids of up to 80 characters: designers among
 *   the members manage a team's entry and share it (a widening asks for the step-up), administrators switch Restricted,
 *   a plant viewer reaches the tab of an entry they see – and no other kind;
 * - a copy – duplicated, or a base extracted from profiles – belongs where its original does (its owning teams,
 *   Restricted when it is), never to the whole instance when the original did not; shares are not copied; audited as
 *   owning-team and scope changes; refused when its creator would not see it;
 * - duplicating something that names an entry its creator may not see (a hidden base, a KPI input reading a hidden
 *   profile) keeps the reference by its placeholder instead of failing, and never names it.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Plant-password-1';
/** A profile id of the longest length plant ids have (80 characters). */
const LONG = `example-team-profile-${'x'.repeat(80 - 'example-team-profile-'.length)}`;
const LONG_KPI = `example-team-kpi-${'y'.repeat(80 - 'example-team-kpi-'.length)}`;
const SECRET = 'example-secret-base';
const SECRET_NAME = 'Invented secret controller';

let s: TestServer;
let tom: Client; // operator in the instance, designer in team Machines
let dina: Client; // designer in the instance and in team Machines
let dana: Client; // designer in the instance, in no team
let vera: Client; // viewer
let pia: Client; // plant viewer
let machines = '';

const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string; problem?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string; params?: { code?: string } } }) => ({
      status: e.status,
      code: e.body?.code,
      ...(e.body?.params?.code ? { problem: e.body.params.code } : {}),
    }),
  );
const db = async () => (await import('../src/db.js')).db();
const teamsOf = async (kind: string, id: string) =>
  (await db())
    .all<{ name: string }>('SELECT t.name FROM resource_teams r JOIN teams t ON t.id = r.team_id WHERE r.kind = ? AND r.resource_id = ?', kind, id)
    .map((r) => r.name);
const restricted = async (kind: string, id: string) => !!(await db()).get('SELECT 1 FROM resource_restrictions WHERE kind = ? AND resource_id = ?', kind, id);
const sharesOf = async (kind: string, id: string) =>
  (await db()).all<{ subject: string }>('SELECT subject FROM resource_shares WHERE kind = ? AND resource_id = ?', kind, id).map((r) => r.subject);
const audits = async (action: string, id: string) =>
  (await db()).all<{ summary: string; details: string; entity_type: string }>(
    'SELECT summary, details, entity_type FROM audit_log WHERE action = ? AND entity_id = ? ORDER BY seq',
    action,
    id,
  );
const exists = async (table: string, id: string) => !!(await db()).get(`SELECT 1 FROM ${table} WHERE id = ?`, id);
/** Neither the id nor the name of the hidden base anywhere in an answer. */
const unnamed = (x: unknown) => {
  const text = typeof x === 'string' ? x : JSON.stringify(x);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(SECRET_NAME);
};
const share = (kind: string, id: string, subject: string, level: string, actions: string[] = []) =>
  s.api('PUT', `/access/${kind}/${id}/shares`, { shares: [{ subject, level, actions }] });

const IFACE = (points: string[]) => [
  {
    id: 'opc',
    name: 'OPC UA server',
    protocol: 'opc_ua',
    groups: [{ name: 'State', dataPoints: points.map((p) => ({ id: p, name: `Point ${p}`, address: `ns=2;s=${p}`, unit: 'kW' })) }],
  },
];

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Invented Plant AG', labels: {}, fields: {} });
  const { createUser } = await import('../src/auth/users.js');
  for (const [name, role] of [
    ['tom', 'operator'],
    ['dina', 'designer'],
    ['dana', 'designer'],
    ['vera', 'viewer'],
    ['pia', 'plant'],
  ] as const)
    createUser({ username: name, roles: [role], password: PW });
  [tom, dina, dana, vera, pia] = await Promise.all(['tom', 'dina', 'dana', 'vera', 'pia'].map((u) => s.as(u, PW)));
  machines = (await s.api('POST', '/teams', { name: 'Machines', members: ['tom', 'dina'], memberRoles: { tom: ['designer'], dina: ['designer'] } })).id;
  await s.api('POST', '/plant/profiles', { id: LONG, name: 'Invented team profile', interfaces: IFACE(['power']) });
  await s.api('POST', '/plant/kpis', { id: LONG_KPI, name: 'Invented team KPI', inputs: [{ profile: LONG, dataPoints: ['power'] }] });
  for (const [kind, id] of [
    ['device_profile', LONG],
    ['kpi_definition', LONG_KPI],
  ])
    await s.api('PUT', `/owning-teams/${kind}/${id}`, { teamIds: [machines] });
});
afterAll(async () => {
  await s?.app.close();
});

describe('the Access tab of a device profile and a KPI definition', () => {
  it('takes both kinds with ids of 80 characters; designers among the members manage them, others do not see them', async () => {
    expect(LONG).toHaveLength(80);
    for (const [kind, id] of [
      ['device_profile', LONG],
      ['kpi_definition', LONG_KPI],
    ] as const) {
      const v = await tom('GET', `/access/${kind}/${id}/shares`);
      expect(v).toMatchObject({ kind, id, scope: 'teams', owningTeams: [{ name: 'Machines' }], canManage: true, canRestrict: false, actions: ['propose'] });
      expect(v.shares).toEqual([]);
      for (const c of [vera, dana]) expect((await status(c('GET', `/access/${kind}/${id}/shares`))).status).toBe(404);
      expect((await status(vera('POST', `/access/${kind}/${id}/preview`, { shares: [] }))).status).toBe(404);
    }
    // an id that names nothing, and a placeholder, answer like any unknown item
    expect((await status(tom('GET', '/access/device_profile/no-such-profile/shares'))).status).toBe(404);
    expect((await status(tom('GET', '/access/device_profile/~hidden-1/shares'))).status).toBe(404);
  });

  it('a share needs the step-up when it widens, shows who gains in the preview and opens the entry to its subject', async () => {
    const preview = await tom('POST', `/access/device_profile/${LONG}/preview`, { shares: [{ subject: 'user:vera', level: 'view', actions: ['propose'] }] });
    expect(preview.gains).toEqual([{ subject: 'user:vera', rights: ['propose', 'view'] }]);
    expect(preview.losses).toEqual([]);
    const unconfirmed = await s.as('tom', PW, { autoStepUp: false });
    await unconfirmed('DELETE', '/auth/step-up');
    expect(await status(unconfirmed('PUT', `/access/device_profile/${LONG}/shares`, { shares: [{ subject: 'user:vera', level: 'view' }] }))).toMatchObject({
      status: 403,
      code: 'STEP_UP_REQUIRED',
    });
    expect(await sharesOf('device_profile', LONG)).toEqual([]);
    const saved = await tom('PUT', `/access/device_profile/${LONG}/shares`, { shares: [{ subject: 'user:vera', level: 'view', actions: ['propose'] }] });
    expect(saved.shares).toMatchObject([{ subject: 'user:vera', level: 'view', actions: ['propose'] }]);
    expect(await vera('GET', `/plant/profiles/${LONG}`)).toMatchObject({ id: LONG, permissions: ['view', 'propose'] });
    const [entry] = await audits('access.share_added', LONG);
    expect(entry).toMatchObject({ entity_type: 'device_profile' });
    // the subject reads the tab (not the list: they do not manage it) and why they have access
    expect(await vera('GET', `/access/device_profile/${LONG}/shares`)).toMatchObject({ canManage: false, shares: null });
    // Edit may not re-share; administrators switch Restricted
    expect(await status(vera('PUT', `/access/device_profile/${LONG}/shares`, { shares: [] }))).toMatchObject({ status: 403 });
    expect(await status(tom('PUT', `/access/kpi_definition/${LONG_KPI}/scope`, { restricted: true }))).toMatchObject({ status: 403 });
    await tom('PUT', `/access/device_profile/${LONG}/shares`, { shares: [] });
    expect((await status(vera('GET', `/plant/profiles/${LONG}`))).status).toBe(404);
  });

  it('a plant viewer reaches the tab of an entry they see, and no other kind', async () => {
    await share('device_profile', LONG, 'user:pia', 'view');
    expect(await pia('GET', `/access/device_profile/${LONG}/shares`)).toMatchObject({ id: LONG, canManage: false, shares: null });
    const why = await pia('GET', `/access/explain?kind=device_profile&id=${LONG}`);
    expect(why.reasons).toContainEqual(expect.objectContaining({ source: 'share', subject: 'user:pia', level: 'view' }));
    expect((await status(pia('GET', `/access/kpi_definition/${LONG_KPI}/shares`))).status).toBe(404);
    for (const url of ['/access/service/x/shares', '/access/explain?kind=process&id=x']) expect((await status(pia('GET', url))).status, url).toBe(404);
    expect(await status(pia('POST', '/access/service/x/preview', { shares: [] }))).toMatchObject({ status: 404 });
    await s.api('PUT', `/access/device_profile/${LONG}/shares`, { shares: [] });
  });
});

describe('a copy belongs where its original does', () => {
  it('a duplicated team profile and KPI definition keep their owning teams, not their shares; audited', async () => {
    await share('device_profile', LONG, 'user:vera', 'view');
    const copy = await dina('POST', `/plant/profiles/${LONG}/duplicate`, { name: 'Invented team profile v2', key: 'example-team-profile-v2' });
    expect(copy.id).toBe('example-team-profile-v2');
    expect(await teamsOf('device_profile', copy.id)).toEqual(['Machines']);
    expect(await sharesOf('device_profile', copy.id)).toEqual([]);
    // not one everyone sees: the viewer saw the original by a share, the copy not at all
    expect((await status(vera('GET', `/plant/profiles/${copy.id}`))).status).toBe(404);
    expect((await dana('GET', '/plant/profiles')).map((p: { id: string }) => p.id)).not.toContain(copy.id);
    const [teams] = await audits('access.owning_teams_changed', copy.id);
    expect(teams).toMatchObject({ entity_type: 'device_profile' });
    expect(teams!.summary).toContain('Machines');
    expect(JSON.parse(teams!.details)).toMatchObject({ before: [], after: ['Machines'], from: LONG });
    const [dup] = await audits('device_profile.duplicated', copy.id);
    expect(JSON.parse(dup!.details)).toMatchObject({ owningTeams: ['Machines'], restricted: false, shares: 'not copied' });
    await s.api('PUT', `/access/device_profile/${LONG}/shares`, { shares: [] });

    const k = await dina('POST', `/plant/kpis/${LONG_KPI}/duplicate`, { name: 'Invented team KPI v2', key: 'example-team-kpi-v2' });
    expect(await teamsOf('kpi_definition', k.id)).toEqual(['Machines']);
    expect((await status(dana('GET', `/plant/kpis/${k.id}`))).status).toBe(404);
    expect(await audits('access.owning_teams_changed', k.id)).toHaveLength(1);
  });

  it('a copy of the whole instance’s entry stays the whole instance’s', async () => {
    await dana('POST', '/plant/profiles', { id: 'example-open-profile', name: 'Invented open profile' });
    const copy = await dana('POST', '/plant/profiles/example-open-profile/duplicate', { name: 'Invented open profile v2', key: 'example-open-profile-v2' });
    expect(await teamsOf('device_profile', copy.id)).toEqual([]);
    expect(await restricted('device_profile', copy.id)).toBe(false);
    expect(await audits('access.owning_teams_changed', copy.id)).toEqual([]);
    expect((await vera('GET', `/plant/profiles/${copy.id}`)).id).toBe(copy.id);
  });

  it('is refused when its creator would not see it (they reach the original by a share only); nothing is written', async () => {
    await share('device_profile', LONG, 'user:dana', 'edit');
    expect((await dana('GET', `/plant/profiles/${LONG}`)).id).toBe(LONG);
    expect(await status(dana('POST', `/plant/profiles/${LONG}/duplicate`, { name: 'Mine', key: 'example-dana-copy' }))).toEqual({
      status: 403,
      code: 'PLANT_COPY_NOT_VISIBLE',
    });
    expect(await exists('plant_profiles', 'example-dana-copy')).toBe(false);
    expect(await audits('device_profile.created', 'example-dana-copy')).toEqual([]);
    expect(await teamsOf('device_profile', 'example-dana-copy')).toEqual([]);
    await s.api('PUT', `/access/device_profile/${LONG}/shares`, { shares: [] });
  });

  it('a Restricted KPI definition is copied Restricted: its shares stay behind, so only administrators reach the copy', async () => {
    await s.api('POST', '/plant/kpis', { id: 'example-restricted-kpi', name: 'Invented restricted KPI' });
    await s.api('PUT', '/access/kpi_definition/example-restricted-kpi/scope', { restricted: true });
    await share('kpi_definition', 'example-restricted-kpi', 'user:dana', 'manage');
    expect(await status(dana('POST', '/plant/kpis/example-restricted-kpi/duplicate', { name: 'Mine', key: 'example-restricted-mine' }))).toMatchObject({
      status: 403,
      code: 'PLANT_COPY_NOT_VISIBLE',
    });
    const copy = await s.api('POST', '/plant/kpis/example-restricted-kpi/duplicate', { name: 'Invented restricted KPI v2', key: 'example-restricted-kpi-v2' });
    expect(await restricted('kpi_definition', copy.id)).toBe(true);
    expect(await sharesOf('kpi_definition', copy.id)).toEqual([]);
    expect((await status(dana('GET', `/plant/kpis/${copy.id}`))).status).toBe(404);
    const [scope] = await audits('access.scope_changed', copy.id);
    expect(JSON.parse(scope!.details)).toMatchObject({ before: 'open', after: 'restricted', from: 'example-restricted-kpi' });
    expect((await s.api('GET', `/access/kpi_definition/${copy.id}/shares`)).scope).toBe('restricted');
  });

  it('a base extracted from profiles belongs where the leading profile does', async () => {
    await s.api('POST', '/plant/profiles', { id: 'example-meter-team', name: 'Invented team meter', interfaces: IFACE(['power', 'energy']) });
    await s.api('POST', '/plant/profiles', { id: 'example-meter-open', name: 'Invented open meter', interfaces: IFACE(['power', 'energy', 'voltage']) });
    await s.api('PUT', '/owning-teams/device_profile/example-meter-team', { teamIds: [machines] });
    const input = (x: Record<string, unknown> = {}) => ({
      id: 'example-meter-base',
      name: 'Invented meter base',
      leading: 'example-meter-team',
      profiles: ['example-meter-team', 'example-meter-open'],
      points: ['power', 'energy'].map((p) => ({ id: p, from: { 'example-meter-team': p, 'example-meter-open': p } })),
      ...x,
    });
    // who manages the leading profile only by a share would not see the base: refused in the preview and when applied
    await share('device_profile', 'example-meter-team', 'user:dana', 'manage');
    const p = (await dana('POST', '/plant/profiles/extract-base/preview', input())) as PlantExtractPreview;
    expect(p.ok).toBe(false);
    expect(p.problems.map((x) => x.code)).toEqual(['hidden']);
    expect(await teamsOf('device_profile', 'example-meter-base')).toEqual([]);
    expect(await status(dana('POST', '/plant/profiles/extract-base', input()))).toMatchObject({
      status: 409,
      code: 'PLANT_EXTRACT_REFUSED',
      problem: 'hidden',
    });
    expect(await exists('plant_profiles', 'example-meter-base')).toBe(false);
    // the preview leaves the request deciding from what is stored: the share list reads as before
    expect((await dana('GET', '/plant/profiles/example-meter-team')).id).toBe('example-meter-team');
    await s.api('PUT', '/access/device_profile/example-meter-team/shares', { shares: [] });

    const done = (await dina('POST', '/plant/profiles/extract-base', input())) as PlantExtractPreview;
    expect(done.ok).toBe(true);
    expect(await teamsOf('device_profile', 'example-meter-base')).toEqual(['Machines']);
    expect(JSON.parse((await audits('access.owning_teams_changed', 'example-meter-base'))[0]!.details)).toMatchObject({
      after: ['Machines'],
      from: 'example-meter-team',
    });
    // the open meter keeps working for everyone: its base is "a base profile you may not see"
    const open = await vera('GET', '/plant/profiles/example-meter-open');
    expect(open.extends).toBe('~hidden-1');
    expect(open.interfaces[0].groups[0].dataPoints.map((d: { id: string }) => d.id)).toEqual(expect.arrayContaining(['power', 'energy', 'voltage']));
  });

  it('a base extracted with an open leading profile is the whole instance’s', async () => {
    await s.api('POST', '/plant/profiles', { id: 'example-valve-a', name: 'Invented valve A', interfaces: IFACE(['open', 'closed']) });
    await s.api('POST', '/plant/profiles', { id: 'example-valve-b', name: 'Invented valve B', interfaces: IFACE(['open', 'closed']) });
    await s.api('PUT', '/owning-teams/device_profile/example-valve-b', { teamIds: [machines] });
    await s.api('POST', '/plant/profiles/extract-base', {
      id: 'example-valve-base',
      name: 'Invented valve base',
      leading: 'example-valve-a',
      profiles: ['example-valve-a', 'example-valve-b'],
      points: ['open', 'closed'].map((p) => ({ id: p, from: { 'example-valve-a': p, 'example-valve-b': p } })),
    });
    expect(await teamsOf('device_profile', 'example-valve-base')).toEqual([]);
    expect(await audits('access.owning_teams_changed', 'example-valve-base')).toEqual([]);
    expect((await vera('GET', '/plant/profiles/example-valve-base')).id).toBe('example-valve-base');
  });
});

describe('a copy of something that names an entry its creator may not see', () => {
  beforeAll(async () => {
    await s.api('POST', '/plant/profiles', { id: SECRET, name: SECRET_NAME, manufacturer: 'Invented Controls AG', interfaces: IFACE(['status', 'speed']) });
    await s.api('POST', '/plant/profiles', { id: 'example-open-variant', name: 'Invented open variant', extends: SECRET });
    await s.api('POST', '/plant/kpis', {
      id: 'example-reads-secret',
      name: 'Invented KPI reading a secret',
      inputs: [{ profile: SECRET, dataPoints: ['speed'] }],
    });
    await s.api('PUT', `/owning-teams/device_profile/${SECRET}`, { teamIds: [machines] });
  });

  it('a derived profile with a hidden base duplicates with the same base, by its placeholder', async () => {
    const source = await dana('GET', '/plant/profiles/example-open-variant');
    expect(source.own.extends).toBe('~hidden-1');
    const suggestion = await dana('GET', '/duplicates/device-profile/example-open-variant');
    unnamed(suggestion);
    const copy = await dana('POST', '/plant/profiles/example-open-variant/duplicate', { name: 'Invented open variant v2', key: 'example-open-variant-v2' });
    unnamed(copy);
    expect((await (await db()).get<{ base_id: string }>("SELECT base_id FROM plant_profiles WHERE id = 'example-open-variant-v2'"))?.base_id).toBe(SECRET);
    const read = await dana('GET', '/plant/profiles/example-open-variant-v2');
    expect(read.own.extends).toBe('~hidden-1');
    expect(read.bases).toEqual([{ id: '~hidden-1', name: '~hidden', exists: true, hidden: true }]);
    expect(read.interfaces[0].groups[0].dataPoints.map((d: { id: string }) => d.id)).toEqual(['status', 'speed']);
    unnamed(read);
    unnamed(await dana('GET', '/duplicates/device-profile/example-open-variant-v2/source'));
    // the copy is the whole instance's, as its original
    expect(await teamsOf('device_profile', 'example-open-variant-v2')).toEqual([]);
    // the members of the base's team see the base of the copy by its name
    expect((await tom('GET', '/plant/profiles/example-open-variant-v2')).own.extends).toBe(SECRET);
    // choosing the hidden base anew still reads like an unknown one
    expect(await status(dana('POST', '/plant/profiles', { id: 'example-other-variant', name: 'Other', extends: '~hidden-1' }))).toEqual({
      status: 404,
      code: 'PLANT_PROFILE_NOT_FOUND',
    });
  });

  it('a KPI definition reading a hidden profile duplicates with the same input, by its placeholder', async () => {
    const source = await dana('GET', '/plant/kpis/example-reads-secret');
    expect(source.inputs[0].profile).toBe('~hidden-1');
    const copy = await dana('POST', '/plant/kpis/example-reads-secret/duplicate', { name: 'Invented KPI reading a secret v2', key: 'example-reads-secret-v2' });
    unnamed(copy);
    const stored = JSON.parse((await (await db()).get<{ inputs: string }>("SELECT inputs FROM plant_kpis WHERE id = 'example-reads-secret-v2'"))!.inputs);
    expect(stored[0]).toMatchObject({ profile: SECRET, dataPoints: ['speed'] });
    const read = await dana('GET', '/plant/kpis/example-reads-secret-v2');
    expect(read.inputs[0].profile).toBe('~hidden-1');
    unnamed(read);
    unnamed(await dana('GET', '/plant/kpis'));
  });
});
