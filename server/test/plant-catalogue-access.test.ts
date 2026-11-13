import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Device profiles and KPI definitions with owning teams and shares (0.21.0, #293; ADR 0033 parts 3 and 4): nobody loses
 * access on the upgrade (entries without owning teams behave as before, new ones belong to nobody), a team restricts
 * one deliberately; designers among its members manage it (decision 13). A hidden profile on a visible asset stays the
 * asset's model without being named (decision 10) – on the asset, the KPI definition, coverage, checks, data flow,
 * Explore data, documents, the export, the import, /api/v1 and MCP – and a form or file keeps it by its placeholder,
 * while choosing it anew reads like an unknown one. Lists count what they leave out; coverage reads a fixed number of
 * statements, however many entries are hidden.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Plant-password-1';
const C80 = 'example-controls-c80';
const C80_NAME = 'Example Controls C80 CNC controller';
let s: TestServer;
let dana: Client; // instance designer, in no team
let vera: Client; // viewer
let tom: Client; // operator in the instance, designer in team Machines
let aud: Client; // auditor
let machines = '';

const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );
/** Neither the id nor the name of the hidden profile anywhere in an answer. */
const unnamed = (x: unknown) => {
  const text = typeof x === 'string' ? x : JSON.stringify(x);
  expect(text).not.toContain(C80);
  expect(text).not.toContain(C80_NAME);
};
const db = async () => (await import('../src/db.js')).db();

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Invented Plant AG', labels: {}, fields: {} });
  const { createUser } = await import('../src/auth/users.js');
  for (const [name, role] of [
    ['dana', 'designer'],
    ['vera', 'viewer'],
    ['tom', 'operator'],
    ['aud', 'auditor'],
  ] as const)
    createUser({ username: name, roles: [role], password: PW });
  dana = await s.as('dana', PW);
  vera = await s.as('vera', PW);
  tom = await s.as('tom', PW);
  aud = await s.as('aud', PW);
  machines = (await s.api('POST', '/teams', { name: 'Machines', members: ['tom'], memberRoles: { tom: ['designer'] } })).id;
});
afterAll(async () => {
  await s?.app.close();
});

describe('the upgrade and new entries', () => {
  it('changes nothing for entries without owning teams; a new profile belongs to nobody, whoever adds it', async () => {
    expect((await vera('GET', '/plant/profiles')).map((p: { id: string }) => p.id)).toContain(C80);
    expect(await vera('GET', '/plant/catalogue/hidden')).toEqual({ profiles: 0, kpis: 0 });
    const p = await dana('GET', `/plant/profiles/${C80}`);
    expect(p).toMatchObject({ canManage: true, canPropose: true, permissions: ['view', 'propose', 'edit', 'manage'] });
    expect((await vera('GET', `/plant/profiles/${C80}`)).permissions).toEqual(['view']);
    // a derived profile of the base, made before the team restricts the base
    await dana('POST', '/plant/profiles', { id: 'example-c80-plus', name: 'Example C80 plus', extends: C80 });
    expect((await dana('GET', '/owning-teams/device_profile/example-c80-plus')).teams).toEqual([]);
    expect((await dana('GET', '/owning-teams/kpi_definition/machine-state-time')).teams).toEqual([]);
  });
});

describe('a profile of a team', () => {
  beforeAll(async () => {
    await s.api('PUT', `/owning-teams/device_profile/${C80}`, { teamIds: [machines] });
  });

  it('is seen by its members (designers manage it) and auditors, and is unknown to everyone else', async () => {
    expect(await tom('GET', `/plant/profiles/${C80}`)).toMatchObject({ canManage: true, permissions: ['view', 'propose', 'edit', 'manage'] });
    expect(await aud('GET', `/plant/profiles/${C80}`)).toMatchObject({ canManage: false, permissions: ['view'] });
    for (const c of [vera, dana]) {
      expect(await status(c('GET', `/plant/profiles/${C80}`))).toEqual({ status: 404, code: 'PLANT_PROFILE_NOT_FOUND' });
      expect(await status(c('GET', `/plant/profiles/${C80}/points/program_status`))).toEqual({ status: 404, code: 'PLANT_PROFILE_NOT_FOUND' });
      expect(await status(c('GET', `/plant/profiles/${C80}/points/program_status/lineage`))).toEqual({ status: 404, code: 'PLANT_PROFILE_NOT_FOUND' });
      expect(await status(c('GET', `/plant/documents?kind=device-profile&id=${C80}`))).toEqual({ status: 404, code: 'PLANT_PROFILE_NOT_FOUND' });
      expect(await status(c('PUT', `/plant/profiles/${C80}`, { name: 'Renamed' }))).toEqual({ status: 404, code: 'PLANT_PROFILE_NOT_FOUND' });
      expect(await status(c('DELETE', `/plant/profiles/${C80}`))).toEqual({ status: 404, code: 'PLANT_PROFILE_NOT_FOUND' });
      const list = await c('GET', '/plant/profiles');
      expect(list.map((p: { id: string }) => p.id)).not.toContain(C80);
      unnamed(list);
      expect(await c('GET', '/plant/catalogue/hidden')).toEqual({ profiles: 1, kpis: 0 });
    }
    // the reasons: a designer of the owning team
    const why = await tom('GET', `/access/explain?kind=device_profile&id=${C80}`);
    expect(why.reasons).toContainEqual(expect.objectContaining({ source: 'teamRole', role: 'designer', team: 'Machines' }));
  });

  it('stays the model of an asset the reader sees, without its name (decision 10)', async () => {
    const v = await vera('GET', '/plant/assets/rvs-mill-01/assignment');
    expect(v.profileHidden).toBe(true);
    expect(v.profile).toMatchObject({ id: '~hidden-1', name: '~hidden', manufacturer: '', model: '', extends: null });
    expect(v.assignment.profileId).toBe('~hidden-1');
    // its interfaces and data points are what the asset delivers
    expect(v.model.flatMap((i: any) => i.groups.flatMap((g: any) => g.dataPoints.map((d: any) => d.id)))).toContain('program_status');
    unnamed(v);
    // the KPI that reads it keeps working; the asset's checks still run
    const two = await vera('GET', '/plant/assets/rvs-mill-02/assignment');
    expect(two.checks.map((c: { code: string }) => c.code)).toEqual(['kpi_interface_inactive']);
    unnamed(two);
    // the data flow and the checks of the registry
    unnamed(await vera('GET', '/plant/assets/rvs-mill-01/flow'));
    unnamed(await vera('GET', '/plant/checks'));
    // the members see it as before
    expect((await tom('GET', '/plant/assets/rvs-mill-01/assignment')).profile.id).toBe(C80);
  });

  it('is counted, not named, by KPI definitions, coverage, Explore data and documents', async () => {
    const k = await vera('GET', '/plant/kpis/machine-state-time');
    expect(k.inputs[0].profile).toBe('~hidden-1');
    expect(k.profileNames).toEqual({ '~hidden-1': '~hidden' });
    expect(k.instances.length).toBeGreaterThan(0);
    unnamed(k);
    unnamed(await vera('GET', '/plant/kpis'));
    const cov = await vera('GET', '/plant/views/coverage');
    expect(cov.options.profiles.map((p: { id: string }) => p.id)).not.toContain(C80);
    expect(cov.rows.find((r: any) => r.asset.id === 'rvs-mill-01').profile).toEqual({ id: '~hidden-1', name: '~hidden', hidden: true });
    unnamed(cov);
    // a filter by the hidden profile reads like one by an unknown profile
    expect((await vera('GET', `/plant/views/coverage?profile=${C80}`)).rows).toEqual([]);
    expect(await vera('GET', `/plant/assets?profile=${C80}`)).toEqual([]);
    // who delivers a data point: the hidden profile's points are counted (the open profile that extends it has them, too)
    expect((await vera('GET', '/plant/explore/points?q=program_status')).map((h: { profile: { id: string } }) => h.profile.id)).toEqual(['example-c80-plus']);
    expect(await vera('GET', '/plant/catalogue/hidden?q=program_status')).toEqual({ profiles: 1, kpis: 0, points: 1 });
    expect((await tom('GET', '/plant/explore/points?q=program_status')).length).toBeGreaterThan(0);
    // the documents an asset inherits from the hidden profile: counted only
    await tom('POST', '/records', {
      type: 'DOC',
      title: 'C80 manual (example)',
      links: [{ kind: 'device-profile', id: C80, note: '' }],
    });
    const docs = await vera('GET', '/plant/documents?kind=asset&id=rvs-mill-01');
    const from = docs.inherited.find((g: any) => g.from?.kind === 'device-profile');
    expect(from).toMatchObject({ from: { id: '~hidden-1', label: '~hidden', path: null }, documents: [], hidden: 1 });
    unnamed(docs);
  });

  it('files follow the profile: a document made on its page gets its owning teams', async () => {
    const rec = await tom('POST', '/records', { type: 'DOC', title: 'C80 wiring (example)', links: [{ kind: 'device-profile', id: C80, note: '' }] });
    expect((await s.api('GET', `/owning-teams/record/${rec.id}`)).teams.map((t: { name: string }) => t.name)).toEqual(['Machines']);
    expect(await status(vera('GET', `/records/${rec.id}`))).toMatchObject({ status: 404 });
  });

  it('a derived profile reads the inherited data points and marks the base hidden', async () => {
    const d = await vera('GET', '/plant/profiles/example-c80-plus');
    expect(d.bases).toEqual([{ id: '~hidden-1', name: '~hidden', exists: true, hidden: true }]);
    expect(d.own.extends).toBe('~hidden-1');
    expect(d.extends).toBe('~hidden-1');
    expect(d.interfaces.length).toBeGreaterThan(0);
    expect(d.origins.points.program_status.from).toBe('~hidden-1');
    unnamed(d);
    unnamed(await vera('GET', '/plant/profiles/example-c80-plus/points/program_status'));
    unnamed(await vera('GET', '/plant/profiles'));
    // the base counts the profiles that extend it which the reader may not see – here none: the derived one is open
    expect((await tom('GET', `/plant/profiles/${C80}`)).extendedBy.map((x: { id: string }) => x.id)).toEqual(['example-c80-plus']);
    // saving the derived profile with its placeholder keeps the base
    const { own } = await dana('GET', '/plant/profiles/example-c80-plus');
    const { id: _id, ...body } = own;
    await dana('PUT', '/plant/profiles/example-c80-plus', { ...body, description: 'A variant (example)' });
    expect((await (await db()).get<{ base_id: string }>("SELECT base_id FROM plant_profiles WHERE id = 'example-c80-plus'"))?.base_id).toBe(C80);
    // only who sees a base may extend it: naming it anew reads like an unknown one
    expect(await status(dana('POST', '/plant/profiles', { id: 'example-c80-other', name: 'Other', extends: C80 }))).toEqual({
      status: 404,
      code: 'PLANT_PROFILE_NOT_FOUND',
    });
  });

  it('keeps the hidden profile on save; choosing it anew reads like an unknown one', async () => {
    const v = await dana('GET', '/plant/assets/rvs-mill-01/assignment');
    await dana('PUT', '/plant/assets/rvs-mill-01/assignment', { ...v.assignment, notes: 'Checked (example)' });
    expect((await (await db()).get<{ profile_id: string }>("SELECT profile_id FROM plant_assignments WHERE asset_id = 'rvs-mill-01'"))?.profile_id).toBe(C80);
    // another asset: the hidden id answers as an unknown one
    const hidden = await status(dana('PUT', '/plant/assets/rvs-mill-01-meter/assignment', { profileId: C80 }));
    const unknown = await status(dana('PUT', '/plant/assets/rvs-mill-01-meter/assignment', { profileId: 'no-such-profile' }));
    expect(hidden).toEqual(unknown);
    expect(hidden).toEqual({ status: 400, code: 'PLANT_ASSIGNMENT_INVALID' });
    // a placeholder it does not have reads like an unknown id, too
    expect(await status(dana('PUT', '/plant/assets/rvs-mill-01-meter/assignment', { profileId: '~hidden-1' }))).toEqual(unknown);
    // a KPI input naming it anew
    expect(await status(dana('POST', '/plant/kpis', { id: 'example-hidden-input', name: 'Hidden input', inputs: [{ profile: C80, dataPoints: ['x'] }] }))).toEqual({
      status: 404,
      code: 'PLANT_PROFILE_NOT_FOUND',
    });
    // the KPI that names it keeps it
    const k = await dana('GET', '/plant/kpis/machine-state-time');
    const { id: _k, canManage: _c, ...rest } = k;
    const body = Object.fromEntries(
      Object.entries(rest).filter(([key]) =>
        ['name', 'names', 'category', 'type', 'description', 'unit', 'trend', 'inputs', 'parameters', 'columns', 'computation', 'notes'].includes(key),
      ),
    );
    await dana('PUT', '/plant/kpis/machine-state-time', { ...body, description: 'Kept (example)' });
    const stored = JSON.parse((await (await db()).get<{ inputs: string }>("SELECT inputs FROM plant_kpis WHERE id = 'machine-state-time'"))!.inputs);
    expect(stored[0].profile).toBe(C80);
    // a new id the hidden profile has: refused neutrally
    expect(await status(dana('POST', '/plant/profiles', { id: C80, name: 'Mine' }))).toEqual({ status: 409, code: 'PLANT_ID_UNAVAILABLE' });
    expect(await status(dana('POST', '/plant/profiles', { id: 'example-meters-pm200', name: 'Mine' }))).toEqual({ status: 409, code: 'PLANT_ID_TAKEN' });
  });

  it('the export carries the visible catalogue; its placeholders import back unchanged', async () => {
    const res = await dana('GET', '/plant/export');
    const text = typeof res === 'string' ? res : JSON.stringify(res);
    unnamed(text);
    const doc = YAML.parse(text);
    expect(doc.device_profiles.map((p: { id: string }) => p.id)).not.toContain(C80);
    expect(doc.assignments.find((a: { asset: string }) => a.asset === 'rvs-mill-01').profile).toBe('~hidden-1');
    expect(doc.device_profiles.find((p: { id: string }) => p.id === 'example-c80-plus').extends).toBe('~hidden-1');
    expect(await status(dana('GET', `/plant/export?profile=${C80}`))).toEqual({ status: 404, code: 'PLANT_PROFILE_NOT_FOUND' });
    const preview = await dana('POST', '/plant/import/preview', { mode: 'update', files: [{ name: 'export.plant.yaml', content: text }] });
    expect(preview.problems).toEqual([]);
    unnamed(preview);
    // a file that names the hidden profile is refused like one that names an unknown profile
    const named = await dana('POST', '/plant/import/preview', {
      mode: 'update',
      files: [{ name: 'a.plant.yaml', content: YAML.stringify({ version: 1, assignments: [{ asset: 'rvs-mill-01-meter', profile: C80 }] }) }],
    });
    expect(named.problems.map((p: { message: string }) => p.message)).toEqual([`There is no device profile "${C80}"`]);
    const defined = await dana('POST', '/plant/import/preview', {
      mode: 'update',
      files: [{ name: 'b.plant.yaml', content: YAML.stringify({ version: 1, device_profiles: [{ id: C80, name: 'Mine' }] }) }],
    });
    expect(defined.problems.map((p: { message: string }) => p.message)).toEqual([`The id "${C80}" cannot be used – choose another one`]);
    expect(JSON.stringify(defined)).not.toContain(C80_NAME);
  });

  it('the public API and MCP apply it with the token owner’s rights', async () => {
    const { token } = await vera('POST', '/me/tokens', { name: 'v1', scope: 'read' });
    const v1 = async (url: string) => {
      const r = await fetch(`${s.base}/api/v1${url}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: r.status, body: await r.json() };
    };
    const list = await v1('/plant/profiles');
    expect(list.body.items.map((p: { id: string }) => p.id)).not.toContain(C80);
    expect((await v1(`/plant/profiles/${C80}`)).status).toBe(404);
    const asg = await v1('/plant/assets/rvs-mill-01/assignment');
    expect(asg.body).toMatchObject({ profileHidden: true, profile: { id: '~hidden-1', name: '~hidden' } });
    unnamed(asg.body);
    unnamed((await v1('/plant/kpis/machine-state-time')).body);
    unnamed((await v1('/plant/checks')).body);
    await s.api('PUT', '/mcp-server', { enabled: true });
    const mcp = (await vera('POST', '/me/tokens', { name: 'mcp', scope: 'mcp' })).token;
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await fetch(`${s.base}/api/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${mcp}`,
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
      return (await r.json()).result;
    };
    const profiles = await call('list_device_profiles', {});
    unnamed(profiles.structuredContent);
    expect((await call('get_device_profile', { profileId: C80 })).isError).toBe(true);
    unnamed((await call('get_device_profile', { profileId: 'example-c80-plus' })).structuredContent);
    unnamed((await call('search_data_points', { query: 'program' })).structuredContent);
    unnamed((await call('get_plant_asset', { assetId: 'rvs-mill-01' })).structuredContent);
  });
});

describe('shares and Restricted', () => {
  it('a share gives one user the profile; Restricted keeps it to its shares', async () => {
    const d = await db();
    d.run(
      'INSERT INTO resource_shares (kind, resource_id, subject, level, actions, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      'device_profile',
      C80,
      'user:vera',
      'view',
      '[]',
      null,
      'admin',
      new Date().toISOString(),
    );
    expect(await vera('GET', `/plant/profiles/${C80}`)).toMatchObject({ canManage: false, permissions: ['view'] });
    const why = await vera('GET', `/access/explain?kind=device_profile&id=${C80}`);
    expect(why.reasons).toContainEqual(expect.objectContaining({ source: 'share', subject: 'user:vera', level: 'view' }));
    expect((await vera('GET', '/plant/assets/rvs-mill-01/assignment')).profileHidden).toBeUndefined();
    // Restricted, without owning teams: instance roles give nothing on it
    d.run('INSERT INTO resource_restrictions (kind, resource_id, created_by, created_at) VALUES (?, ?, ?, ?)', 'kpi_definition', 'energy-consumption', 'admin', '');
    expect(await status(dana('GET', '/plant/kpis/energy-consumption'))).toEqual({ status: 404, code: 'PLANT_KPI_NOT_FOUND' });
    expect(await dana('GET', '/plant/catalogue/hidden')).toEqual({ profiles: 1, kpis: 1 });
    expect((await s.api('GET', '/plant/kpis/energy-consumption')).canManage).toBe(true);
    const cov = await dana('GET', '/plant/views/coverage');
    expect(cov.kpis.map((k: { id: string }) => k.id)).not.toContain('energy-consumption');
    expect(cov.hiddenKpis).toBe(1);
    d.run("DELETE FROM resource_restrictions WHERE kind = 'kpi_definition' AND resource_id = 'energy-consumption'");
  });

  it('renaming a profile id takes its owning teams and shares along; removing one forgets them', async () => {
    await s.api('POST', '/plant/ids/rename', { kind: 'profile', scope: '', id: C80, newId: 'example-controls-c80-gen2' });
    expect((await s.api('GET', '/owning-teams/device_profile/example-controls-c80-gen2')).teams.map((t: { name: string }) => t.name)).toEqual(['Machines']);
    expect((await vera('GET', '/plant/profiles/example-controls-c80-gen2')).permissions).toEqual(['view']);
    await s.api('POST', '/plant/ids/rename', { kind: 'profile', scope: '', id: 'example-controls-c80-gen2', newId: C80 });
    const made = await dana('POST', '/plant/profiles', { id: 'example-short-lived', name: 'Short-lived (example)' });
    await s.api('PUT', `/owning-teams/device_profile/${made.id}`, { teamIds: [machines] });
    await tom('DELETE', `/plant/profiles/${made.id}`);
    const left = await (await db()).get('SELECT 1 FROM resource_teams WHERE kind = ? AND resource_id = ?', 'device_profile', made.id);
    expect(left).toBeUndefined();
  });
});

describe('performance', () => {
  it('coverage reads a fixed number of statements, however many profiles are hidden', async () => {
    const { coverage } = await import('../src/plant/views.js');
    const { requestDbStats } = await import('../src/database/timing.js');
    const { runAs } = await import('../src/auth/context.js');
    const users = await import('../src/auth/users.js');
    const u = users.toAuthUser(users.findUserByName('vera')!);
    const statements = () => {
      const st = { statements: 0, ms: 0 };
      runAs(u, () => requestDbStats.run(st, () => coverage({})));
      return st.statements;
    };
    statements(); // what a server reads once (settings, module access) is read
    const few = statements();
    const before = (await vera('GET', '/plant/catalogue/hidden')).profiles;
    for (let i = 0; i < 40; i++) {
      const id = `example-team-profile-${i}`;
      await dana('POST', '/plant/profiles', { id, name: `Team profile ${i}` });
      await s.api('PUT', `/owning-teams/device_profile/${id}`, { teamIds: [machines] });
    }
    expect((await vera('GET', '/plant/catalogue/hidden')).profiles).toBe(before + 40);
    const many = statements();
    expect(many).toBe(few);
    expect(many).toBeLessThan(60);
  });
});
