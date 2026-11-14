import { beforeAll, describe, expect, it } from 'vitest';
import type { AccessReason, Role } from '@sm/shared';
import { ADMIN, setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Shares on services, applications and systems (ADR 0033 phase 1, #291): a read-only share sees and cannot change,
 * Edit changes, Manage changes the shares; Restricted keeps instance roles out; owners are implied Edit (computed, not
 * stored) and naming one from outside still asks for the step-up; an application inherits its services' teams but
 * not their shares. Every surface asks the policy module, so a share counts on lists, pages, link pickers, the public
 * API and the start page alike – and lists read shares in bulk (statement counts).
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
let s: TestServer;
let vic: Client; // viewer, outside every team
let otto: Client; // operator, outside every team
let dana: Client; // designer, member of Orders
let pat: Client; // viewer, member of Payments
let aud: Client; // auditor
let orders = '';
let svc = ''; // owned by Orders
let app = ''; // in svc, no teams of its own
let sys = ''; // owned by Orders
const counted = new Map<string, number>();

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status?: number }) => e.status ?? 0,
  );
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { body?: { code?: string; params?: { context?: string } } }) => [e.body?.code, e.body?.params?.context].filter(Boolean).join(':') || 'error',
  );
const ids = (x: { id: string }[]) => x.map((y) => y.id);
const shares = (kind: string, id: string, list: unknown[]) => s.api('PUT', `/access/${kind}/${id}/shares`, { shares: list });

beforeAll(async () => {
  s = await startTestServer({
    routes: (a) =>
      a.addHook('onSend', async (req, _reply, payload) => {
        const { requestDbTotals } = await import('../src/http-observability.js');
        counted.set(req.url, requestDbTotals(req)?.statements ?? -1);
        return payload;
      }),
  });
  await setup(s);
  const users = await import('../src/auth/users.js');
  for (const [username, roles] of [
    ['vic', ['viewer']],
    ['otto', ['operator']],
    ['dana', ['designer']],
    ['pat', ['viewer']],
    ['aud', ['auditor']],
  ] as [string, Role[]][])
    users.createUser({ username, roles, password: PW, mustChangePassword: false });
  orders = (await s.api('POST', '/teams', { name: 'Orders', members: ['dana'] })).id;
  await s.api('POST', '/teams', { name: 'Payments', members: ['pat'] });
  svc = (await s.api('POST', '/services', { name: 'Invented order intake', owners: [] })).id;
  app = (await s.api('POST', '/applications', { name: 'Invented order portal', owners: [] })).id;
  sys = (await s.api('POST', '/systems', { name: 'Invented order database', kind: 'server', owners: [] })).id;
  await s.api('PUT', `/services/${svc}/applications/${app}`, { role: 'primary' });
  for (const [kind, id] of [
    ['service', svc],
    ['system', sys],
  ])
    await s.api('PUT', `/owning-teams/${kind}/${id}`, { teamIds: [orders] });
  [vic, otto, dana, pat, aud] = await Promise.all(['vic', 'otto', 'dana', 'pat', 'aud'].map((u) => s.as(u, PW)));
});

describe('a read-only share', () => {
  it('lets the subject see the item on every surface, without changing it', async () => {
    expect(await status(vic('GET', `/services/${svc}`))).toBe(404);
    expect(ids(await vic('GET', '/services'))).not.toContain(svc);
    await shares('service', svc, [{ subject: 'user:vic', level: 'view' }]);
    const d = await vic('GET', `/services/${svc}`);
    expect(d).toMatchObject({ id: svc, canEdit: false });
    expect(ids(await vic('GET', '/services'))).toContain(svc);
    expect(ids(await vic('GET', '/link-targets?kind=service&q=intake'))).toContain(svc);
    expect(await code(vic('PUT', `/services/${svc}`, { name: 'Changed', owners: [] }))).toBe('FORBIDDEN:changeService');
    const why = await vic('GET', `/access/explain?kind=service&id=${svc}`);
    expect(why.permissions).toEqual(['view']);
    expect(why.reasons).toEqual([expect.objectContaining({ source: 'share', subject: 'user:vic', level: 'view', permissions: ['view'] })]);
    // the share list is for who manages it: Vic sees his own reasons only
    expect((await vic('GET', `/access/service/${svc}/shares`)).shares).toBeNull();
  });

  it('counts on the public API and the start page as in the app', async () => {
    const token = (await vic('POST', '/me/tokens', { name: 'Invented vic token', scope: 'read' })).token as string;
    const v1 = async (path: string) => (await fetch(`${s.base}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } })).json();
    const list = (await v1('/services')) as { items?: { id: string }[] } | { id: string }[];
    expect(ids(Array.isArray(list) ? list : (list.items ?? []))).toContain(svc);
    expect((await v1(`/services/${svc}`)).id).toBe(svc);
    // Pat (no share) gets the same answer as for a missing service
    const patToken = (await pat('POST', '/me/tokens', { name: 'Invented pat token', scope: 'read' })).token as string;
    expect((await fetch(`${s.base}/api/v1/services/${svc}`, { headers: { authorization: `Bearer ${patToken}` } })).status).toBe(404);
  });

  it('does not flow to the applications of the service: they keep their own scope (the service’s teams)', async () => {
    expect(await status(vic('GET', `/applications/${app}`))).toBe(404);
    expect(ids(await vic('GET', '/applications'))).not.toContain(app);
    // the application inherits the service's teams: Dana (designer in Orders) changes it
    expect((await dana('GET', `/applications/${app}`)).canEdit).toBe(true);
    await shares('application', app, [{ subject: 'user:vic', level: 'view' }]);
    expect((await vic('GET', `/applications/${app}`)).canEdit).toBe(false);
    const view = await s.api('GET', `/access/application/${app}/shares`);
    expect(view).toMatchObject({ scope: 'teams', owningTeams: [{ name: 'Orders' }] });
  });

  it('a team share reaches the team’s members; a system follows the same rules', async () => {
    expect(await status(pat('GET', `/systems/${sys}`))).toBe(404);
    await shares('system', sys, [{ subject: 'team:payments', level: 'view' }]);
    expect((await pat('GET', `/systems/${sys}`)).name).toBe('Invented order database');
    expect(ids(await pat('GET', '/systems'))).toContain(sys);
    expect(await status(vic('GET', `/systems/${sys}`))).toBe(404);
  });
});

describe('Edit and Manage', () => {
  it('Edit changes the item but neither its shares nor owners from outside', async () => {
    await shares('service', svc, [
      { subject: 'user:vic', level: 'view' },
      { subject: 'user:otto', level: 'edit' },
    ]);
    expect((await otto('GET', `/services/${svc}`)).canEdit).toBe(true);
    expect(await code(otto('PUT', `/services/${svc}`, { name: 'Invented order intake', description: 'Changed by Otto', owners: [] }))).toBe('ok');
    expect(await code(otto('PUT', `/access/service/${svc}/shares`, { shares: [] }))).toBe('FORBIDDEN:right_manage');
    // naming Vic (outside Orders) as an owner needs Manage (ADR 0033 decision 3)
    expect(await code(otto('PUT', `/services/${svc}`, { name: 'Invented order intake', owners: ['user:vic'] }))).toBe('FORBIDDEN:nameOutside');
    // a covered subject (Dana, in Orders) needs Edit only
    expect(await code(otto('PUT', `/services/${svc}`, { name: 'Invented order intake', owners: ['user:dana'] }))).toBe('ok');
    await s.api('PUT', `/services/${svc}`, { name: 'Invented order intake', owners: [] });
  });

  it('designers among the members manage by role; a Manage share manages; nobody shares more than they hold', async () => {
    const v = await dana('GET', `/access/service/${svc}/shares`);
    expect(v).toMatchObject({ canManage: true, canRestrict: false, held: { level: 'manage' } });
    await dana('PUT', `/access/service/${svc}/shares`, {
      shares: [
        { subject: 'user:vic', level: 'view' },
        { subject: 'user:otto', level: 'manage' },
      ],
    });
    expect((await otto('GET', `/access/service/${svc}/shares`)).canManage).toBe(true);
    const why = await otto('GET', `/access/explain?kind=service&id=${svc}`);
    expect(why.permissions).toEqual(['view', 'edit', 'manage']);
    await s.api('PUT', `/access/service/${svc}/shares`, { shares: [{ subject: 'user:vic', level: 'view' }] });
  });
});

describe('owners are an implied Edit share', () => {
  it('naming an owner from outside asks for the step-up; the Access tab shows Owner – Edit (implied)', async () => {
    const danaSession = await s.as('dana', PW, { autoStepUp: false });
    await danaSession('DELETE', '/auth/step-up');
    expect(await code(danaSession('PUT', `/services/${svc}`, { name: 'Invented order intake', owners: ['user:otto'] }))).toBe('STEP_UP_REQUIRED:password');
    await dana('PUT', `/services/${svc}`, { name: 'Invented order intake', owners: ['user:otto'] });
    const v = await s.api('GET', `/access/service/${svc}/shares`);
    expect(v.implied).toEqual([{ subject: 'user:otto', level: 'edit', as: 'owner', outside: true, owningTeam: false }]);
    // not stored as a share
    expect(v.shares.map((x: { subject: string }) => x.subject)).toEqual(['user:vic']);
    const why = await otto('GET', `/access/explain?kind=service&id=${svc}`);
    expect(why.reasons).toEqual([
      expect.objectContaining({ source: 'implied', as: 'owner', subject: 'user:otto', level: 'edit', permissions: ['view', 'edit'] }),
    ]);
    // removing the owner removes the implied share
    await dana('PUT', `/services/${svc}`, { name: 'Invented order intake', owners: [] });
    expect((await s.api('GET', `/access/service/${svc}/shares`)).implied).toEqual([]);
    expect(await status(otto('GET', `/services/${svc}`))).toBe(404);
  });
});

describe('Restricted', () => {
  let open = '';
  beforeAll(async () => {
    open = (await s.api('POST', '/services', { name: 'Invented payroll', owners: ['user:pat'] })).id;
  });

  it('keeps instance roles out of an item without teams: only shares, owners, administrators and auditors', async () => {
    expect(ids(await vic('GET', '/services'))).toContain(open);
    expect(await code(dana('PUT', `/access/service/${open}/scope`, { restricted: true }))).toBe('FORBIDDEN:right_manage');
    await s.api('PUT', `/access/service/${open}/scope`, { restricted: true });
    expect(ids(await vic('GET', '/services'))).not.toContain(open);
    expect(await status(dana('GET', `/services/${open}`))).toBe(404);
    // the owner (implied Edit), auditors, administrators
    expect((await pat('GET', `/services/${open}`)).canEdit).toBe(true);
    expect((await aud('GET', `/services/${open}`)).canEdit).toBe(false);
    await shares('service', open, [{ subject: 'user:vic', level: 'view' }]);
    expect(ids(await vic('GET', '/services'))).toContain(open);
  });

  it('every new owner of a Restricted item is from outside: the step-up', async () => {
    const admin = await s.as(ADMIN.username, ADMIN.password, { autoStepUp: false });
    await admin('DELETE', '/auth/step-up');
    expect(await code(admin('PUT', `/services/${open}`, { name: 'Invented payroll', owners: ['user:pat', 'user:otto'] }))).toBe('STEP_UP_REQUIRED:password');
    expect((await s.api('POST', '/access/named-outside', { kind: 'service', id: open, subjects: ['user:otto'] })).outside).toEqual(['user:otto']);
  });

  it('switching it off gives the roles back, with the step-up', async () => {
    await s.api('PUT', `/access/service/${open}/scope`, { restricted: false });
    expect(ids(await dana('GET', '/services'))).toContain(open);
  });
});

describe('nobody gains or loses access by the upgrade', () => {
  /** The rule of 0.20 (auth/policy.ts catalogueAccess before shares), kept here to compare with. */
  type U = import('../src/auth/context.js').AuthUser;
  async function before(u: U, kind: 'service' | 'application' | 'system', id: string, owners: string[]) {
    const policy = await import('../src/auth/policy.js');
    const perms = await import('../src/auth/permissions.js');
    if (perms.isAdmin(u)) return { view: true, edit: true };
    const reasons: AccessReason[] = [];
    if (owners.some((o) => perms.matches(u, o))) reasons.push({ source: 'named', permissions: ['view', 'edit'] });
    const teams = policy.catalogueTeams(kind, id);
    const editors = ['admin', 'designer'];
    if (!teams.length) for (const role of u.roles) reasons.push({ source: 'instanceRole', permissions: editors.includes(role) ? ['view', 'edit'] : ['view'] });
    else {
      if (u.roles.includes('auditor')) reasons.push({ source: 'auditor', permissions: ['view'] });
      const mine = policy.memberships(u);
      for (const t of teams) {
        const m = mine.get(t.id);
        if (m)
          for (const role of new Set([...u.roles, ...m.roles]))
            reasons.push({ source: 'teamRole', permissions: editors.includes(role) ? ['view', 'edit'] : ['view'] });
      }
    }
    const g = new Set(reasons.flatMap((r) => r.permissions));
    return { view: g.has('view'), edit: g.has('edit') };
  }

  it('without shares or Restricted, every user has exactly the rights of 0.20 on every item', async () => {
    const { db } = await import('../src/db.js');
    const ctx = await import('../src/auth/context.js');
    const policy = await import('../src/auth/policy.js');
    const users = await import('../src/auth/users.js');
    // items as an upgraded instance has them: owned and not, outside owners, an application in an owned service
    const d = db();
    d.run('DELETE FROM resource_shares');
    d.run('DELETE FROM resource_restrictions');
    await s.api('PUT', `/services/${svc}`, { name: 'Invented order intake', owners: ['user:vic', 'team:payments'] });
    const all = users
      .listUsers()
      .filter((u) => u.active)
      .map((u) => users.toAuthUser(u));
    const problems: string[] = [];
    for (const [kind, table] of [
      ['service', 'services'],
      ['application', 'applications'],
      ['system', 'systems'],
    ] as const)
      for (const r of d.all<{ id: string; owners: string }>(`SELECT id, owners FROM ${table}`))
        for (const u of all) {
          const owners = JSON.parse(r.owners) as string[];
          const was = await before(u, kind, r.id, owners);
          const now = ctx.runAs(null, () => policy.catalogueAccess(u, { kind, id: r.id, owners }));
          if (was.view !== now.view || was.edit !== now.edit) problems.push(`${u.username} ${kind} ${r.id}: ${JSON.stringify(was)} → ${now.view}/${now.edit}`);
        }
    expect(problems).toEqual([]);
    await s.api('PUT', `/services/${svc}`, { name: 'Invented order intake', owners: [] });
  });
});

describe('lists read shares in bulk', () => {
  /** Statements of one GET (the second call: caches of the first are warm). */
  async function statements(c: Client, url: string): Promise<number> {
    await c('GET', url);
    counted.delete(`/api${url}`);
    await c('GET', url);
    return counted.get(`/api${url}`) ?? -1;
  }
  const LISTS = ['/services', '/applications', '/systems'];
  const countAll = async () => {
    const out: Record<string, number> = {};
    for (const u of LISTS) out[u] = await statements(vic, u);
    return out;
  };

  it('the statements of the lists stay the same when the items they show are shared and Restricted', async () => {
    const made: [string, string][] = [];
    for (let i = 0; i < 6; i++) {
      made.push(['service', (await s.api('POST', '/services', { name: `Invented counted service ${i}`, owners: [] })).id]);
      made.push(['application', (await s.api('POST', '/applications', { name: `Invented counted app ${i}`, owners: [] })).id]);
      made.push(['system', (await s.api('POST', '/systems', { name: `Invented counted system ${i}`, kind: 'server', owners: [] })).id]);
    }
    // the same items, seen through the whole instance and then through shares (half of them Restricted)
    const open = await countAll();
    for (const [i, [kind, id]] of made.entries()) {
      await shares(kind, id, [{ subject: 'user:vic', level: 'view' }]);
      if (i % 2) await s.api('PUT', `/access/${kind}/${id}/scope`, { restricted: true });
    }
    const shared = await countAll();
    expect(shared).toEqual(open);
    for (const u of LISTS) expect(ids(await vic('GET', u)).length, u).toBeGreaterThanOrEqual(6);
  });
});
