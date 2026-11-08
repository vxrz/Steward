import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Duplicating (0.4.0): POST /api/<kind>/:id/duplicate. The rules for every kind – secrets are never copied, the copy
 * gets a new name and key (checked before saving), it belongs to who creates it (their default owning teams), the
 * original's access settings only for who may manage the original, history stays with the original, schedules and the
 * like start disabled, and the copy records where it came from (audited as <entity>.duplicated).
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client; // designer
let olivia: Client; // operator
let vera: Client; // viewer
let tara: Client; // designer, member of team Orders (which takes its members' new resources)
let orders: string;

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status?: number }) => e.status ?? 0,
  );
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { body?: { code?: string } }) => e.body?.code ?? '',
  );
const owners = async (kind: string, id: string): Promise<string[]> =>
  ((await s.api('GET', `/owning-teams/${kind}/${id}`)).teams as { name: string }[]).map((t) => t.name).sort();
const lastAudit = async (action: string) => (await s.api('GET', `/audit?action=${action}&limit=1`))[0];
const definition = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  nodes: [
    { id: 'start', type: 'start', x: 0, y: 0 },
    { id: 'chk', type: 'check', name: 'Done', condition: 'true', x: 1, y: 0 },
  ],
  wires: [{ from: 'start', port: 'out', to: 'chk' }],
  ...extra,
});

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  const users = await import('../src/auth/users.js');
  users.createUser({ username: 'tara', roles: ['designer'], password: PW, mustChangePassword: false });
  [dana, olivia, vera, tara] = await Promise.all(['dana', 'olivia', 'vera', 'tara'].map((u) => s.as(u, PW)));
  orders = (await s.api('POST', '/teams', { name: 'Orders', members: ['tara'] })).id;
  await s.api('PUT', `/teams/${orders}/settings`, { newResources: 'always' });
}, 180_000);

describe('monitors', () => {
  let original: { id: string; key: string };
  let secret: string;
  beforeAll(async () => {
    const r = await dana('POST', '/monitors', {
      key: 'shop-health',
      definition: {
        name: 'Shop health',
        checks: [
          { id: 'web', name: 'Web', type: 'http', url: 'https://shop.example.com/health', x: 0, y: 0 },
          { id: 'hb', name: 'Nightly job', type: 'heartbeat', key: 'shop.nightly', mode: 'maxAge', maxAgeSeconds: 600, x: 0, y: 150 },
        ],
        links: [{ from: 'web', to: 'hb', mode: 'soft' }],
      },
    });
    original = r.monitor;
    secret = r.secrets[0].secret;
    await dana('PUT', `/monitors/${original.id}/access`, { acl: [{ subject: 'user:olivia', permissions: ['view', 'edit'] }] });
  });

  it('suggests a free name and key, and checks the key before saving', async () => {
    const sug = await dana('GET', `/duplicates/monitor/${original.id}`);
    expect(sug).toMatchObject({ name: 'Shop health (copy)', key: 'shop-health-copy', accessApplies: true, canCopyAccess: true, startsDisabled: false });
    expect((await dana('GET', `/duplicates/monitor/${original.id}?lang=de`)).name).toBe('Shop health (Kopie)');
    expect(await code(dana('POST', `/monitors/${original.id}/duplicate`, { key: 'shop-health' }))).toBe('DUPLICATE_KEY_TAKEN');
    expect(await code(dana('POST', `/monitors/${original.id}/duplicate`, { key: 'wall' }))).toBe('DUPLICATE_KEY_TAKEN');
  });

  it('gets new heartbeat secrets, not the gateway key, no history, and records where it came from', async () => {
    const r = await dana('POST', `/monitors/${original.id}/duplicate`, {});
    expect(r).toMatchObject({
      kind: 'monitor',
      key: 'shop-health-copy',
      name: 'Shop health (copy)',
      path: `/monitors/${r.id}`,
      editPath: `/monitors/${r.id}/edit`,
    });
    expect(r.secrets).toHaveLength(1);
    expect(r.secrets[0].secret).not.toBe(secret);
    const copy = await dana('GET', `/monitors/${r.id}`);
    expect(copy.definition.checks.map((c: any) => c.id)).toEqual(['web', 'hb']);
    expect(copy.definition.checks.find((c: any) => c.id === 'hb').key).toBeUndefined();
    expect(copy.definition.links).toEqual([{ from: 'web', to: 'hb', mode: 'soft' }]);
    expect(copy.owner).toBe('dana');
    expect(copy.acl).toEqual([]); // not asked for
    // only its own history (it starts "unknown"), nothing of the original's
    const history = await dana('GET', `/monitors/${r.id}/history`);
    expect(history.every((h: any) => h.ts >= copy.createdAt)).toBe(true);
    expect(await dana('GET', `/monitors/${r.id}/checks/web/results`)).toEqual([]);
    // the old secret is not accepted for the copy's heartbeat
    const hb = copy.checks.find((c: any) => c.checkId === 'hb').heartbeat;
    expect(
      (await fetch(`${s.base}${hb.path}`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: '{}' }))
        .status,
    ).toBe(401);
    expect(
      (
        await fetch(`${s.base}${hb.path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${r.secrets[0].secret}`, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBeLessThan(300);
    const a = await lastAudit('monitor.duplicated');
    expect(a).toMatchObject({ entityId: r.id });
    expect(a.details).toMatchObject({ sourceId: original.id, copyAccess: false });
    expect(JSON.stringify(a)).not.toContain(r.secrets[0].secret);
    expect((await dana('GET', `/duplicates/monitor/${r.id}/source`)).copiedFrom).toMatchObject({
      sourceId: original.id,
      sourceName: 'Shop health',
      by: 'dana',
    });
    expect((await dana('GET', `/duplicates/monitor/${original.id}/source`)).copiedFrom).toBeNull();
    // the next suggestion is free again
    expect((await dana('GET', `/duplicates/monitor/${original.id}`)).key).toBe('shop-health-copy-2');
  });

  it('copies the access list only for who may manage the original', async () => {
    // olivia may edit, not manage – and operators may not create monitors anyway
    expect(await status(olivia('POST', `/monitors/${original.id}/duplicate`, {}))).toBe(403);
    expect(await status(vera('POST', `/monitors/${original.id}/duplicate`, {}))).toBe(404);
    const withAccess = await dana('POST', `/monitors/${original.id}/duplicate`, { copyAccess: true, key: 'shop-health-shared' });
    expect((await dana('GET', `/monitors/${withAccess.id}`)).acl).toEqual([{ subject: 'user:olivia', permissions: ['view', 'edit'] }]);
    expect((await lastAudit('monitor.duplicated')).details.copyAccess).toBe(true);
    // tara (a designer who may see it, not manage it) gets a copy of her own, without the list
    await dana('PUT', `/monitors/${original.id}/access`, { acl: [] });
    expect((await tara('GET', `/duplicates/monitor/${original.id}`)).canCopyAccess).toBe(false);
    expect(await code(tara('POST', `/monitors/${original.id}/duplicate`, { copyAccess: true }))).toBe('FORBIDDEN');
    const hers = await tara('POST', `/monitors/${original.id}/duplicate`, {});
    const copy = await tara('GET', `/monitors/${hers.id}`);
    expect(copy).toMatchObject({ owner: 'tara', acl: [] });
    expect(await owners('monitor', hers.id)).toEqual(['Orders']);
  });

  it('is saved as a template with the chosen fields as parameters', async () => {
    const r = await dana('POST', `/monitors/${original.id}/duplicate`, {
      name: 'Shop health template',
      key: 'shop-health-tpl',
      template: { parameters: [{ name: 'url', label: 'Health URL', fields: [{ checkId: 'web', field: 'url' }] }] },
    });
    expect(r.secrets).toEqual([]);
    const t = await dana('GET', `/monitors/${r.id}`);
    expect(t.isTemplate).toBe(true);
    expect(t.definition.checks[0].url).toBe('{{ params.url }}');
    expect(t.definition.parameters).toEqual([{ name: 'url', label: 'Health URL', type: 'string', required: true, default: 'https://shop.example.com/health' }]);
    const inst = await dana('POST', `/monitors/${r.id}/instances`, { rows: [{ params: { url: 'https://other.example.com/health' }, name: 'Other shop' }] });
    expect(inst[0].monitor.name).toBe('Other shop');
    expect((await lastAudit('monitor.duplicated')).details).toMatchObject({ sourceId: original.id, asTemplate: true, parameters: ['url'] });
    expect(
      await code(dana('POST', `/monitors/${original.id}/duplicate`, { template: { parameters: [{ name: 'x', fields: [{ checkId: 'web', field: 'id' }] }] } })),
    ).toBe('DUPLICATE_TEMPLATE_FIELD');
  });
});

describe('processes and dashboards', () => {
  it('a process copy gets a new id, no runs, no secret defaults, and the access list only for its managers', async () => {
    const p = await dana('POST', '/processes', {
      definition: definition('Rotate keys', {
        inputs: [
          { name: 'token', type: 'secret', default: 'hunter2' },
          { name: 'env', type: 'string', default: 'prod' },
        ],
      }),
    });
    await dana('PUT', `/processes/${p.id}/access`, { acl: [{ subject: 'user:olivia', permissions: ['view', 'run'] }] });
    const run = await dana('POST', '/runs', { processId: p.id, inputs: { token: 'x' } });
    await s.waitRun(run.id);
    expect((await dana('GET', `/duplicates/process/${p.id}`)).key).toBe('rotate-keys-copy');
    expect(await code(dana('POST', `/processes/${p.id}/duplicate`, { key: p.id }))).toBe('DUPLICATE_KEY_TAKEN');
    expect(await code(dana('POST', `/processes/${p.id}/duplicate`, { key: 'Not A Slug' }))).toBe('DUPLICATE_KEY_TAKEN');
    const r = await dana('POST', `/processes/${p.id}/duplicate`, {});
    expect(r).toMatchObject({ id: 'rotate-keys-copy', name: 'Rotate keys (copy)', path: '/processes/rotate-keys-copy' });
    const copy = await dana('GET', `/processes/${r.id}`);
    expect(copy.acl).toEqual([]);
    expect(copy.owner).toBe('dana');
    expect(copy.currentVersion).toBe(1);
    expect(copy.definition.inputs.find((i: any) => i.name === 'token').default).toBeUndefined();
    expect(copy.definition.inputs.find((i: any) => i.name === 'env').default).toBe('prod');
    expect(await dana('GET', `/runs?processId=${r.id}`)).toEqual([]);
    expect(await status(olivia('POST', `/processes/${p.id}/duplicate`, {}))).toBe(403); // may not create processes
    const shared = await dana('POST', `/processes/${p.id}/duplicate`, { copyAccess: true });
    expect((await dana('GET', `/processes/${shared.id}`)).acl).toEqual([{ subject: 'user:olivia', permissions: ['view', 'run'] }]);
    expect(shared.id).toBe('rotate-keys-copy-2');
    // tara does not see it (its access list names olivia only); she sees one of the whole instance, but may not manage it
    expect(await code(tara('POST', `/processes/${p.id}/duplicate`, {}))).toBe('PROCESS_NOT_FOUND');
    const open = await dana('POST', '/processes', { definition: definition('Open rotation') });
    expect((await tara('GET', `/duplicates/process/${open.id}`)).canCopyAccess).toBe(false);
    expect(await code(tara('POST', `/processes/${open.id}/duplicate`, { copyAccess: true }))).toBe('FORBIDDEN');
    const hers = await tara('POST', `/processes/${open.id}/duplicate`, { key: 'taras-rotation' });
    expect(await owners('process', hers.id)).toEqual(['Orders']);
    expect((await lastAudit('process.duplicated')).details).toMatchObject({ sourceId: open.id, copyAccess: false });
  });

  it('a dashboard copy gets a free id, the owning teams only for who may change the original', async () => {
    const d = await tara('POST', '/dashboards', { definition: { name: 'Orders board', widgets: [] } });
    expect(await owners('dashboard', d.id)).toEqual(['Orders']);
    const mine = await dana('POST', '/dashboards', { definition: { name: 'Ops board', widgets: [] } });
    // dana cannot see tara's team board
    expect(await status(dana('POST', `/dashboards/${d.id}/duplicate`, {}))).toBe(404);
    const copy = await tara('POST', `/dashboards/${d.id}/duplicate`, { copyAccess: true });
    expect(copy.id).toBe('orders-board-copy');
    expect(await owners('dashboard', copy.id)).toEqual(['Orders']);
    expect(await code(tara('POST', `/dashboards/${mine.id}/duplicate`, { copyAccess: true }))).toBe('FORBIDDEN');
    expect(await code(tara('POST', `/dashboards/${mine.id}/duplicate`, { key: mine.id }))).toBe('DUPLICATE_KEY_TAKEN');
    const other = await tara('POST', `/dashboards/${mine.id}/duplicate`, { key: 'taras-ops-board' });
    expect(other.id).toBe('taras-ops-board');
    expect(await owners('dashboard', other.id)).toEqual(['Orders']);
  });
});

describe('schedules, report schedules, maintenance windows and access checks start disabled', () => {
  it('a schedule copy is disabled and asks for its secret inputs again', async () => {
    const p = await dana('POST', '/processes', {
      definition: definition('Nightly sync', {
        inputs: [
          { name: 'pw', type: 'secret' },
          { name: 'n', type: 'number' },
        ],
      }),
    });
    const sch = await dana('POST', '/schedules', { name: 'Nightly', processId: p.id, cron: '0 2 * * *', inputs: { pw: 'top-secret', n: 3 }, enabled: true });
    expect(sch.inputs.pw).toBe('***');
    expect(await dana('GET', `/duplicates/schedule/${sch.id}`)).toMatchObject({ startsDisabled: true, accessApplies: false, key: null });
    expect(await status(vera('POST', `/schedules/${sch.id}/duplicate`, {}))).toBe(403); // may not run the process
    const r = await dana('POST', `/schedules/${sch.id}/duplicate`, {});
    expect(r.skipped).toEqual([{ what: 'secretInputs', count: 1 }]);
    const copy = (await dana('GET', '/schedules')).find((x: any) => x.id === r.id);
    expect(copy).toMatchObject({ name: 'Nightly (copy)', enabled: false, nextRunAt: null, lastRunAt: null, owner: 'dana', inputs: { n: 3 } });
    const { db } = await import('../src/db.js');
    expect(db().get<{ sealed_inputs: string | null }>('SELECT sealed_inputs FROM schedules WHERE id = ?', r.id)!.sealed_inputs).toBeNull();
    expect(await code(dana('POST', `/schedules/${sch.id}/duplicate`, { copyAccess: true }))).toBe('DUPLICATE_NO_ACCESS_SETTINGS');
    expect((await lastAudit('schedule.duplicated')).summary).toContain('disabled');
  });

  it('a report schedule copy is disabled and keeps its recipients only for its owner', async () => {
    const body = {
      name: 'Weekly report',
      preset: 'weekly',
      timezone: 'Europe/Berlin',
      sections: { credentials: { dueWithinDays: 30 } },
      recipients: { users: ['olivia'], teams: [], emails: [] },
    };
    const rs = await dana('POST', '/report-schedules', body);
    const copy = await dana('POST', `/report-schedules/${rs.id}/duplicate`, { copyAccess: true });
    expect(await dana('GET', `/report-schedules/${copy.id}`)).toMatchObject({
      enabled: false,
      nextRunAt: null,
      recipients: { users: ['olivia'] },
      owner: 'dana',
    });
    // olivia is a recipient (she sees it), not its owner: a copy without the recipients
    expect(await code(olivia('POST', `/report-schedules/${rs.id}/duplicate`, { copyAccess: true }))).toBe('FORBIDDEN');
    const hers = await olivia('POST', `/report-schedules/${rs.id}/duplicate`, {});
    expect(await olivia('GET', `/report-schedules/${hers.id}`)).toMatchObject({
      owner: 'olivia',
      enabled: false,
      recipients: { users: [], teams: [], emails: [] },
    });
  });

  it('a maintenance window copy is disabled: it neither applies nor is listed by the public API until enabled', async () => {
    const app = await dana('POST', '/applications', { name: 'Billing' });
    const now = Date.now();
    const w = await dana('POST', '/maintenance-windows', {
      title: 'Patch now',
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 3_600_000).toISOString(),
      targets: [{ kind: 'application', id: app.id }],
    });
    expect(w.enabled).toBe(true);
    const r = await dana('POST', `/maintenance-windows/${w.id}/duplicate`, {});
    const copy = await dana('GET', `/maintenance-windows/${r.id}`);
    expect(copy).toMatchObject({ title: 'Patch now (copy)', enabled: false });
    // the public API lists only windows that take place
    const token = (await dana('POST', '/me/tokens', { name: 'dup-v1', scope: 'read' })).token;
    const v1 = await (await fetch(`${s.base}/api/v1/maintenance-windows`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(v1.windows.map((x: any) => x.id)).toContain(w.id);
    expect(v1.windows.map((x: any) => x.id)).not.toContain(r.id);
    expect(v1.occurrences.some((o: any) => o.windowId === r.id)).toBe(false);
    expect(v1.windows[0].enabled).toBeUndefined();
    const { objectiveInMaintenance } = await import('../src/catalogue/maintenance.js');
    // cancel the original: only the (disabled) copy is left, which does not apply
    await dana('POST', `/maintenance-windows/${w.id}/cancel`, { reason: 'test' });
    expect(objectiveInMaintenance({ service_id: 'svc_none', application_id: app.id }, Date.now() + 120_000)).toBe(false);
    // enabled: it applies
    await dana('PUT', `/maintenance-windows/${r.id}`, {
      title: copy.title,
      note: copy.note,
      startsAt: copy.startsAt,
      endsAt: copy.endsAt,
      targets: [{ kind: 'application', id: app.id }],
      enabled: true,
    });
    expect(objectiveInMaintenance({ service_id: 'svc_none', application_id: app.id }, Date.now() + 120_000)).toBe(true);
  });

  it('an access check copy is disabled; its ignored rights only for administrators', async () => {
    const hub = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'insights-hub').id;
    const c = await s.api('POST', '/compliance/access-checks', {
      name: 'Hub access',
      platformId: hub,
      source: 'insights-hub',
      cron: '0 5 * * *',
      timezone: 'UTC',
      ignoreRights: ['mdsp:core:StandardUser'],
    });
    const mine = await dana('POST', `/compliance/access-checks/${c.id}/duplicate`, {});
    expect(mine.skipped).toEqual([{ what: 'ignoredRights', count: 1 }]);
    expect(await dana('GET', `/compliance/access-checks/${mine.id}`)).toMatchObject({ enabled: false, owner: 'dana', ignoreRights: [] });
    const admins = await s.api('POST', `/compliance/access-checks/${c.id}/duplicate`, {});
    expect(await s.api('GET', `/compliance/access-checks/${admins.id}`)).toMatchObject({ enabled: false, ignoreRights: ['mdsp:core:StandardUser'] });
    expect((await lastAudit('access_check.duplicated')).details.sourceId).toBe(c.id);
  });
});

describe('the service catalogue', () => {
  it('an application copy takes the chosen parts along, never its platforms, owners only with the access settings', async () => {
    const platform = (await s.api('GET', '/platforms'))[0].id;
    const sys = await s.api('POST', '/systems', { name: 'db-host-1', kind: 'server' });
    const a = await s.api('POST', '/applications', { name: 'Shop', owners: ['user:olivia'], cmdb: { system: 'SNOW', id: 'CI123', url: '' } });
    await s.api('POST', `/applications/${a.id}/components`, { type: 'repository', name: 'shop-web', url: 'https://git.example.com/shop-web' });
    await s.api('POST', `/applications/${a.id}/systems`, { systemId: sys.id, environment: '' });
    await s.api('POST', `/applications/${a.id}/platforms`, { platformId: platform });
    await s.api('POST', `/applications/${a.id}/links`, { url: 'https://wiki.example.com/shop', label: 'Wiki' });
    const sug = await dana('GET', `/duplicates/application/${a.id}`);
    expect(sug).toMatchObject({ name: 'Shop (copy)', key: null, canCopyAccess: true });
    expect(sug.options).toEqual([
      { option: 'components', count: 1 },
      { option: 'systems', count: 1 },
      { option: 'documents', count: 0 },
    ]);
    expect(await code(dana('POST', `/applications/${a.id}/duplicate`, { name: 'Shop' }))).toBe('DUPLICATE_NAME_TAKEN');
    expect(await code(dana('POST', `/applications/${a.id}/duplicate`, { options: ['applications'] }))).toBe('DUPLICATE_OPTION_UNKNOWN');
    const r = await dana('POST', `/applications/${a.id}/duplicate`, { options: ['components'] });
    const copy = await dana('GET', `/applications/${r.id}`);
    expect(copy).toMatchObject({ name: 'Shop (copy)', owners: [], cmdb: null, integrations: [], systems: [] });
    expect(copy.components.map((c: any) => c.name)).toEqual(['shop-web']);
    expect(copy.links.map((l: any) => l.url)).toEqual(['https://wiki.example.com/shop']);
    const all = await dana('POST', `/applications/${a.id}/duplicate`, { copyAccess: true });
    const full = await dana('GET', `/applications/${all.id}`);
    expect(full).toMatchObject({ name: 'Shop (copy 2)', owners: ['user:olivia'], integrations: [] });
    expect(full.systems.map((x: any) => x.systemId)).toEqual([sys.id]);
    // operators may not create applications
    expect(await status(olivia('POST', `/applications/${a.id}/duplicate`, {}))).toBe(403);
    expect((await lastAudit('application.duplicated')).details).toMatchObject({
      sourceId: a.id,
      options: ['components', 'systems', 'documents'],
      copyAccess: true,
    });
  });

  it('a service copy takes its applications along; tara may not copy the owners of a service she may not change', async () => {
    const app = await s.api('POST', '/applications', { name: 'Payments API' });
    const svc = await s.api('POST', '/services', { name: 'Payments', owners: ['user:olivia'] });
    await s.api('PUT', `/services/${svc.id}/applications/${app.id}`, { role: 'primary' });
    const copy = await tara('POST', `/services/${svc.id}/duplicate`, {});
    const got = await tara('GET', `/services/${copy.id}`);
    expect(got).toMatchObject({ name: 'Payments (copy)', owners: [] });
    expect(got.applications.map((x: any) => [x.id, x.role])).toEqual([[app.id, 'primary']]);
    expect(await owners('service', copy.id)).toEqual(['Orders']);
  });

  it('a status page copy has no public link', async () => {
    const svc = await s.api('POST', '/services', { name: 'Status svc' });
    const page = await dana('POST', '/status-pages', { title: 'Customers', serviceIds: [svc.id] });
    await dana('POST', `/status-pages/${page.id}/link`);
    const r = await dana('POST', `/status-pages/${page.id}/duplicate`, {});
    expect(await dana('GET', `/status-pages/${r.id}`)).toMatchObject({ title: 'Customers (copy)', publicLink: false, serviceIds: [svc.id] });
    expect(await status(olivia('POST', `/status-pages/${page.id}/duplicate`, {}))).toBe(403);
  });

  it('a credentials register entry copy keeps its documentation, not its dates or owners', async () => {
    const c = await olivia('POST', '/credentials', {
      name: 'Shop DB password',
      type: 'password',
      ownerSubjects: ['user:olivia'],
      expiresAt: '2030-01-01',
      rotationIntervalDays: 90,
      lastRotatedAt: '2026-01-01',
      location: { text: 'KeePass › Shop › DB' },
    });
    const r = await dana('POST', `/credentials/${c.id}/duplicate`, {});
    const copy = await dana('GET', `/credentials/${r.id}`);
    expect(copy).toMatchObject({ name: 'Shop DB password (copy)', ownerSubjects: [], expiresAt: null, lastRotatedAt: null, rotationIntervalDays: 90 });
    expect(copy.location.text).toBe('KeePass › Shop › DB');
    expect(await status(vera('POST', `/credentials/${c.id}/duplicate`, {}))).not.toBe(200);
  });
});
