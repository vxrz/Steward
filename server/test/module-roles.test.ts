import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  MODULES,
  MODULE_ROLES,
  PLANT_CATALOGUE_PERMISSIONS,
  PLANT_PERMISSIONS,
  ROLES,
  coreRoleDefaults,
  moduleRoleFromCore,
  moduleRolesOf,
  type ModuleId,
  type Role,
} from '@sm/shared';
import { setup, ssoBinding, startTestServer, withRefusalReason, type Client, type TestServer } from './helpers.js';

/**
 * Module roles (0.23.0, ADR 0034 phase 2): viewer, contributor and manager per module, given to a user, a team or
 * through a single sign-on mapping; the defaults each core role gives (`fromCoreRoles`) reproduce the rules before, so
 * nobody gains or loses anything at the upgrade; the former instance role "plant" becomes the plant registry's
 * contributor grant (accepted as an alias for one release); manager settings; module-only users; widening asks for the
 * step-up access.grant and every change is an access change; the module policy is read once per request.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
const users: Record<string, Client> = {};
let dbm: typeof import('../src/db.js');
let mock: typeof import('../src/mock/mockOidc.js');
let teamId = '';

const status = async (p: Promise<unknown>) =>
  p.then(
    () => ({ status: 200, code: '' }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code ?? '' }),
  );
const db = () => dbm.db();

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  dbm = await import('../src/db.js');
  mock = await import('../src/mock/mockOidc.js');
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Invented Components AG', labels: {}, fields: {} });
  const { createUser } = await import('../src/auth/users.js');
  for (const [name, roles] of [
    ['pia', ['plant']],
    ['polly', ['plant', 'status']],
    ['pete', ['plant', 'viewer']],
    ['pam', ['plant']],
    ['stan', ['status']],
    ['nora', []],
    ['vic', ['viewer']],
    ['desi', ['designer']],
    ['otis', ['operator']],
  ] as const) {
    createUser({ username: name, roles: [...roles], password: PW });
    users[name] = await s.as(name, PW);
  }
  for (const id of ['rx-open', 'rx-listed', 'rx-team', 'rx-closed']) await s.api('POST', '/plant/sites', { id, name: `Invented site ${id}` });
  await s.api('PUT', '/plant/sites/rx-listed/access', { acl: [{ subject: 'role:plant', permissions: ['view'] }] });
  await s.api('PUT', '/plant/sites/rx-closed/access', { acl: [{ subject: 'user:desi', permissions: ['manage'] }] });
  teamId = (await s.api('POST', '/teams', { name: 'Invented plant engineering', members: ['pam', 'vic'] })).id;
  await s.api('PUT', '/owning-teams/site/rx-team', { teamIds: [teamId] });
  await s.api('POST', '/plant/profiles', { id: 'rx-profile', name: 'Invented profile' });
}, 240_000);
afterAll(async () => {
  await s?.app.close();
});
afterEach(() => mock?.resetMockIdentities());

describe('the registry declares module roles', () => {
  it('uses the fixed vocabulary; the defaults of every module reproduce the rules before 0.23.0 (per module)', async () => {
    // the plant registry before 0.23.0 (plant/access.ts DEFAULT_PLANT, plant/catalogue-access.ts DEFAULT_PLANT_CATALOGUE)
    const LEGACY_PLANT: Record<Role, string[]> = {
      admin: ['view', 'propose', 'manage'],
      designer: ['view', 'propose', 'manage'],
      operator: ['view', 'propose'],
      approver: ['view', 'propose'],
      auditor: ['view'],
      viewer: ['view'],
      status: [],
      plant: ['view', 'propose'],
    };
    const ALL = [...PLANT_CATALOGUE_PERMISSIONS];
    const LEGACY_CATALOGUE: Record<Role, string[]> = {
      admin: ALL,
      designer: ALL,
      operator: ['view', 'propose'],
      approver: ['view', 'propose'],
      auditor: ['view'],
      viewer: ['view'],
      status: [],
      plant: ['view', 'propose'],
    };
    expect(coreRoleDefaults('plant', 'site', PLANT_PERMISSIONS)).toEqual(LEGACY_PLANT);
    expect(coreRoleDefaults('plant', 'device_profile', PLANT_CATALOGUE_PERMISSIONS)).toEqual(LEGACY_CATALOGUE);
    expect(coreRoleDefaults('plant', 'kpi_definition', PLANT_CATALOGUE_PERMISSIONS)).toEqual(LEGACY_CATALOGUE);
    const { DEFAULT_PLANT } = await import('../src/plant/access.js');
    const { DEFAULT_PLANT_CATALOGUE } = await import('../src/plant/catalogue-access.js');
    expect(DEFAULT_PLANT).toEqual(LEGACY_PLANT);
    expect(DEFAULT_PLANT_CATALOGUE).toEqual(LEGACY_CATALOGUE);
    // who added sites before (SITE_CREATORS) and who were the costs managers (administrators and designers)
    for (const role of ROLES) {
      expect(moduleRoleFromCore('plant', [role]) === 'manager', `plant ${role}`).toBe(role === 'admin' || role === 'designer');
      expect(moduleRoleFromCore('costs', [role]) === 'manager', `costs ${role}`).toBe(role === 'admin' || role === 'designer');
    }
    for (const m of MODULES) {
      const declared = moduleRolesOf(m.id);
      for (const r of declared) expect(MODULE_ROLES, m.id).toContain(r);
      // the defaults only name roles the module declares; a module without roles gives none, so nothing changes
      for (const role of ROLES) {
        const r = moduleRoleFromCore(m.id, [role]);
        if (!declared.length) expect(r, `${m.id} ${role}`).toBeNull();
        else if (r) expect(declared, `${m.id} ${role}`).toContain(r);
      }
      // manager settings only where a manager role exists
      if (m.access?.managerSettings?.length) expect(declared, m.id).toContain('manager');
    }
  });

  it('the costs managers are administrators and designers by default, as in 0.21.0', async () => {
    const { isCostsManager } = await import('../src/costs/price-books.js');
    const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
    const { runAs } = await import('../src/auth/context.js');
    for (const [name, expected] of [
      ['admin', true],
      ['dana', true],
      ['olivia', false],
      ['vera', false],
      ['audrey', false],
    ] as const) {
      const u = toAuthUser(findUserByName(name)!);
      expect(
        runAs(u, () => isCostsManager(u)),
        name,
      ).toBe(expected);
    }
  });
});

/** Every user's rights on every site and catalogue entry, the routes they reach and what the web app hears. */
async function snapshot(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const names = ['pia', 'polly', 'pete', 'pam', 'stan', 'nora', 'vic', 'desi', 'otis', 'vera', 'dana', 'audrey'];
  for (const name of names) {
    for (const site of ['rx-open', 'rx-listed', 'rx-team', 'rx-closed'])
      out[`${name} site ${site}`] = (await s.api('GET', `/access/explain?kind=site&id=${site}&user=${name}`)).permissions;
    out[`${name} profile`] = (await s.api('GET', `/access/explain?kind=device_profile&id=rx-profile&user=${name}`)).permissions;
    const c = (users[name] ??= await s.as(name, PW));
    out[`${name} services`] = (await status(c('GET', '/services'))).code || 'ok';
    out[`${name} sites`] = (await status(c('GET', '/plant/sites'))).code || 'ok';
    out[`${name} statusPages`] = (await status(c('GET', '/status-pages'))).code || 'ok';
    const caps = (await c('GET', '/auth/status')).me.capabilities;
    out[`${name} caps`] = { plant: caps.plant, plantManage: caps.plantManage, plantOnly: caps.plantOnly ?? false };
  }
  return out;
}

describe('the role "plant" becomes the contributor grant of the plant registry (ADR 0034 part 5)', () => {
  it('is converted once, audited, and nobody gains or loses a right, a route or a sidebar entry', async () => {
    const { convertDeprecatedRoles } = await import('../src/modules/user-roles.js');
    // the users the API made are converted already (the alias); give them the role back as an older version stored it
    for (const [name, roles] of [
      ['pia', ['plant']],
      ['polly', ['plant', 'status']],
      ['pete', ['plant', 'viewer']],
      ['pam', ['plant']],
    ] as const) {
      db().run('UPDATE users SET roles = ? WHERE username = ?', JSON.stringify(roles), name);
      db().run("DELETE FROM module_grants WHERE subject = ? AND module_id = 'plant'", `user:${name}`);
    }
    // an account of a provider that synchronises roles: its grant is synchronised (the next sign-in keeps or drops it)
    db().run("UPDATE users SET auth_source = 'idp-invented' WHERE username = 'pam'");
    db().run("INSERT INTO identity_providers (id, config, enabled, created_at, updated_at) VALUES ('idp-invented', '{\"syncRoles\":true}', 0, 'now', 'now')");
    const before = await snapshot();
    expect(convertDeprecatedRoles()).toBe(4);
    expect(convertDeprecatedRoles()).toBe(0);
    db().run("DELETE FROM identity_providers WHERE id = 'idp-invented'");
    db().run("UPDATE users SET auth_source = 'local' WHERE username = 'pam'");
    const after = await snapshot();
    expect(after).toEqual(before);
    // what changed is where the right comes from
    const grants = db().all<{ subject: string; role: string; source: string | null; created_by: string }>(
      "SELECT subject, role, source, created_by FROM module_grants WHERE module_id = 'plant' ORDER BY subject",
    );
    expect(grants).toEqual([
      { subject: 'user:pam', role: 'contributor', source: 'sso', created_by: 'system' },
      { subject: 'user:pete', role: 'contributor', source: null, created_by: 'system' },
      { subject: 'user:pia', role: 'contributor', source: null, created_by: 'system' },
      { subject: 'user:polly', role: 'contributor', source: null, created_by: 'system' },
    ]);
    expect(JSON.parse(db().get<{ roles: string }>("SELECT roles FROM users WHERE username = 'polly'")!.roles)).toEqual(['status']);
    const explain = await s.api('GET', '/access/explain?kind=site&id=rx-open&user=pia');
    expect(explain.reasons).toEqual([
      expect.objectContaining({ source: 'moduleRole', moduleRole: 'contributor', subject: 'user:pia', permissions: ['view', 'propose'] }),
    ]);
    expect(explain.module).toMatchObject({ role: 'contributor', roleThrough: [{ source: 'user', role: 'contributor' }] });
    // the access list entry "role:plant" still names them
    expect((await s.api('GET', '/access/explain?kind=site&id=rx-listed&user=pia')).permissions).toEqual(['view']);
    const audit = (await s.api('GET', '/audit?action=access.module_access_changed&limit=20')) as { actor: string; details: any }[];
    expect(
      audit
        .filter((e) => e.details?.via === 'roleAlias' && e.actor === 'system' && e.details.user)
        .map((e) => e.details.user)
        .sort(),
    ).toEqual(['pam', 'pete', 'pia', 'polly']);
  });

  it('keeps the role of an account the restricted plant registry leaves out: converting it must not let them in', async () => {
    const { convertDeprecatedRoles } = await import('../src/modules/user-roles.js');
    const before = await s.api('GET', '/settings/modules/plant/access');
    const kept = before.grants
      .filter((g: { subject: string; source: string }) => g.source !== 'sso' && g.subject !== 'user:pia' && g.subject !== 'user:pete')
      .map((g: { subject: string; role?: string | null }) => ({ subject: g.subject, role: g.role ?? null }));
    await s.api('PUT', '/settings/modules/plant/access', { mode: 'selected', grants: [...kept, { subject: 'user:pete' }] });
    try {
      for (const name of ['pia', 'pete']) {
        db().run('UPDATE users SET roles = ? WHERE username = ?', JSON.stringify(['plant']), name);
        db().run("DELETE FROM module_grants WHERE subject = ? AND module_id = 'plant' AND role IS NOT NULL", `user:${name}`);
      }
      const pia = await s.as('pia', PW);
      const refused = await status(pia('GET', '/plant/sites'));
      expect(refused.status).toBeGreaterThanOrEqual(400);
      // pete is on the list: his role becomes the grant; pia is not: she keeps the role (and with it what she had – nothing here)
      expect(convertDeprecatedRoles()).toBe(1);
      expect(JSON.parse(db().get<{ roles: string }>("SELECT roles FROM users WHERE username = 'pia'")!.roles)).toEqual(['plant']);
      expect(db().get("SELECT 1 AS x FROM module_grants WHERE subject = 'user:pia' AND module_id = 'plant'")).toBeUndefined();
      expect(await status(pia('GET', '/plant/sites'))).toEqual(refused);
      expect((await status(pia('GET', '/services'))).code).toBe('PLANT_VIEWER_ONLY');
    } finally {
      await s.api('PUT', '/settings/modules/plant/access', { mode: before.mode, grants: kept });
      db().run("UPDATE users SET roles = '[]' WHERE username IN ('pia', 'pete')");
      db().run("DELETE FROM module_grants WHERE subject IN ('user:pia', 'user:pete') AND module_id = 'plant'");
      for (const name of ['pia', 'pete'])
        db().run(
          "INSERT INTO module_grants (id, module_id, subject, role, created_by, created_at) VALUES (?, 'plant', ?, 'contributor', 'test', 'now')",
          `mg_t_${name}`,
          `user:${name}`,
        );
      db().run("UPDATE users SET roles = ? WHERE username = 'pete'", JSON.stringify(['viewer']));
    }
  });

  it('the API still takes the role as an alias for one release, says so, and stores the grant', async () => {
    // a raw session: the answer's headers matter here
    const login = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'x-sm-client': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Admin-password-1' }),
    });
    const headers = {
      'x-sm-client': '1',
      'content-type': 'application/json',
      cookie: login.headers.get('set-cookie')!.split(';')[0]!,
      'x-sm-session': login.headers.get('x-sm-session-key')!,
    };
    const res = await fetch(`${s.base}/api/users`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'alias-user', roles: ['plant'], password: 'Alias-password-1' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('deprecation')).toBe('true');
    const made = (await res.json()).user;
    expect(made.roles).toEqual([]);
    expect(made.moduleRoles).toEqual([{ module: 'plant', role: 'contributor', source: 'admin' }]);
    // a manager stays a manager when the alias comes again
    await s.api('PUT', `/users/${made.id}`, { moduleRoles: [{ module: 'plant', role: 'manager' }] });
    const again = await s.api('PUT', `/users/${made.id}`, { roles: ['plant', 'viewer'] });
    expect(again.roles).toEqual(['viewer']);
    expect(again.moduleRoles).toEqual([{ module: 'plant', role: 'manager', source: 'admin' }]);
    const listed = (await s.api('GET', '/users')).find((u: { username: string }) => u.username === 'alias-user');
    expect(listed.moduleRoles).toEqual([{ module: 'plant', role: 'manager', source: 'admin' }]);
  });
});

describe('module roles given in Settings → Modules', () => {
  it('a team gets a module role on an open module: step-up, audit, preview of whose role changes; narrowing asks nothing', async () => {
    const admin = await s.as('admin', 'Admin-password-1', { autoStepUp: false });
    await admin('DELETE', '/auth/step-up');
    // the dialog sends the whole list: the grants of the former plant viewers stay as they are (single sign-on's are not the dialog's)
    const kept = ((await s.api('GET', '/settings/modules/plant/access')).grants as { subject: string; role: string | null; source: string }[])
      .filter((g) => g.source === 'admin')
      .map((g) => ({ subject: g.subject, role: g.role }));
    expect(kept.map((g) => g.subject)).toEqual(expect.arrayContaining(['user:pete', 'user:pia', 'user:polly']));
    const body = { mode: 'everyone', grants: [...kept, { subject: 'team:invented plant engineering', role: 'manager' }] };
    const p = await admin('POST', '/settings/modules/plant/access/preview', body);
    expect(p.widens).toBe(true);
    expect(p.gains).toEqual([]);
    expect(p.roleChanges).toEqual(expect.arrayContaining([expect.objectContaining({ username: 'vic', before: 'viewer', after: 'manager' })]));
    expect(await status(admin('PUT', '/settings/modules/plant/access', body))).toEqual({ status: 403, code: 'STEP_UP_REQUIRED' });
    const v = await s.api('PUT', '/settings/modules/plant/access', body);
    expect(v).toMatchObject({ mode: 'everyone', roles: ['viewer', 'contributor', 'manager'] });
    expect(v.grants).toEqual(
      expect.arrayContaining([expect.objectContaining({ subject: 'team:invented plant engineering', role: 'manager', source: 'admin' })]),
    );
    // a team's module role is module-wide, like an instance role: vic manages the open site and adds sites
    expect((await s.api('GET', '/access/explain?kind=site&id=rx-open&user=vic')).permissions).toEqual(['view', 'propose', 'manage']);
    expect((await s.api('GET', '/access/explain?kind=site&id=rx-open&user=vic')).reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'moduleRole', moduleRole: 'manager', subject: 'team:invented plant engineering' })]),
    );
    await users.vic!('POST', '/plant/sites', { id: 'rx-by-vic', name: 'Invented site of a manager' });
    // an access list still decides: the closed site stays closed
    expect((await s.api('GET', '/access/explain?kind=site&id=rx-closed&user=vic')).permissions).toEqual([]);
    const entry = (await s.api('GET', '/audit?action=access.module_access_changed&limit=1'))[0];
    expect(entry.details.roles).toEqual([{ subject: 'team:invented plant engineering', before: null, after: 'manager' }]);
    expect(entry.details.assurance?.[0]?.point).toBe('access.grant');
    // taking it away narrows: no step-up
    await admin('PUT', '/settings/modules/plant/access', { mode: 'everyone', grants: kept });
    expect((await s.api('GET', '/access/explain?kind=site&id=rx-open&user=vic')).permissions).toEqual(['view']);
  });

  it('refuses a role the module does not declare, a module without roles on an open list, and API tokens', async () => {
    expect(await status(s.api('PUT', '/settings/modules/costs/access', { mode: 'everyone', grants: [{ subject: 'user:vera', role: 'viewer' }] }))).toEqual({
      status: 400,
      code: 'MODULE_ROLE_UNKNOWN',
    });
    expect(await status(s.api('PUT', '/settings/modules/statusPages/access', { mode: 'everyone', grants: [] }))).toEqual({
      status: 400,
      code: 'MODULE_NOT_RESTRICTABLE',
    });
    const token = (await s.api('POST', '/me/tokens', { name: 'module roles', scope: 'full' })).token as string;
    const res = await fetch(`${s.base}/api/settings/modules/plant/access`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'everyone', grants: [{ subject: 'user:vera', role: 'manager' }] }),
    });
    expect((await res.json()).code).toBe('SESSION_REQUIRED');
  });

  it('on a restricted module a grant with a role means "uses it" too; taking the role keeps the use', async () => {
    const kept = ((await s.api('GET', '/settings/modules/plant/access')).grants as { subject: string; role: string | null; source: string }[])
      .filter((g) => g.source === 'admin')
      .map((g) => ({ subject: g.subject, role: g.role }));
    await s.api('PUT', '/settings/modules/plant/access', { mode: 'selected', grants: [...kept, { subject: 'user:vera', role: 'contributor' }] });
    try {
      const forVera = await s.api('GET', '/access/explain?kind=site&id=rx-open&user=vera');
      expect(forVera.module).toMatchObject({ uses: true, role: 'contributor', through: [{ source: 'user' }] });
      expect(forVera.permissions).toEqual(['view', 'propose']);
      expect((await s.api('GET', '/access/explain?kind=site&id=rx-open&user=vic')).module).toMatchObject({ uses: false, role: null });
      const vera = await s.as('vera', PW);
      const veraUser = (await s.api('GET', '/users')).find((u: { username: string }) => u.username === 'vera');
      await s.api('PUT', `/users/${veraUser.id}`, { moduleRoles: [{ module: 'plant', role: null }] });
      expect((await vera('GET', '/auth/status')).me.capabilities.moduleAccess.plant).toBe('on');
      expect((await s.api('GET', '/settings/modules/plant/access')).grants).toEqual(
        expect.arrayContaining([expect.objectContaining({ subject: 'user:vera', role: null, source: 'admin' })]),
      );
      // single sign-on's grant of the former plant viewer pam is listed, read-only, and also means "uses it"
      expect((await s.api('GET', '/access/explain?kind=site&id=rx-open&user=pam')).module).toMatchObject({ uses: true, through: [{ source: 'sso' }] });
    } finally {
      // opened again: the grants without a role go, those with one stay
      await s.api('PUT', '/settings/modules/plant/access', { mode: 'everyone', grants: kept });
    }
  });
});

describe('the user form', () => {
  it('gives and takes a person’s module roles: widening asks for the step-up, every change is an access change', async () => {
    const admin = await s.as('admin', 'Admin-password-1', { autoStepUp: false });
    await admin('DELETE', '/auth/step-up');
    const id = (await s.api('GET', '/users')).find((u: { username: string }) => u.username === 'otis').id;
    expect(await status(admin('PUT', `/users/${id}`, { moduleRoles: [{ module: 'plant', role: 'manager' }] }))).toEqual({
      status: 403,
      code: 'STEP_UP_REQUIRED',
    });
    expect((await s.api('PUT', `/users/${id}`, { moduleRoles: [{ module: 'plant', role: 'manager' }] })).moduleRoles).toEqual([
      { module: 'plant', role: 'manager', source: 'admin' },
    ]);
    const entry = (await s.api('GET', '/audit?action=access.module_access_changed&limit=1'))[0];
    expect(entry.details).toMatchObject({ via: 'userForm', roles: [{ subject: 'user:otis', before: null, after: 'manager' }] });
    // lowering is a narrowing: no step-up
    expect((await admin('PUT', `/users/${id}`, { moduleRoles: [{ module: 'plant', role: null }] })).moduleRoles).toEqual([]);
    expect(await status(s.api('PUT', `/users/${id}`, { moduleRoles: [{ module: 'costs', role: 'viewer' }] }))).toEqual({
      status: 400,
      code: 'MODULE_ROLE_UNKNOWN',
    });
  });
});

describe('manager settings (ADR 0034 decision 11)', () => {
  it('a granted manager changes the content settings, never the switch; a designer (manager by core role) does not', async () => {
    const id = (await s.api('GET', '/users')).find((u: { username: string }) => u.username === 'vic').id;
    await s.api('PUT', `/users/${id}`, { moduleRoles: [{ module: 'plant', role: 'manager' }] });
    try {
      const vic = await s.as('vic', PW);
      expect((await vic('GET', '/auth/status')).me.capabilities).toMatchObject({ moduleSettings: ['plant'], moduleRoles: { plant: 'manager' } });
      const current = await vic('GET', '/plant/settings');
      const next = await vic('PUT', '/plant/settings', { ...pick(current), enterprise: 'Invented Components AG (renamed)' });
      expect(next.enterprise).toBe('Invented Components AG (renamed)');
      expect((await s.api('GET', '/audit?action=plant.settings_changed&limit=1'))[0].actor).toBe('vic');
      // the switch stays the administrators'
      expect((await status(vic('PUT', '/settings/plant', { ...pick(current), enabled: false }))).status).toBe(403);
      // a designer is a manager of the registry's items by core role, not of its settings – nobody gained them at the upgrade
      expect((await users.desi!('GET', '/auth/status')).me.capabilities.moduleSettings).toEqual([]);
      expect(await status(users.desi!('PUT', '/plant/settings', pick(current)))).toEqual({ status: 403, code: 'FORBIDDEN' });
      // API tokens do not change settings
      const token = (await vic('POST', '/me/tokens', { name: 'vic', scope: 'full' })).token as string;
      const res = await fetch(`${s.base}/api/plant/settings`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(pick(current)),
      });
      expect(res.status).toBe(403);
    } finally {
      await s.api('PUT', `/users/${id}`, { moduleRoles: [{ module: 'plant', role: null }] });
    }
  });

  it('a granted costs manager maintains exchange rates; the Costs module declares only the manager role', async () => {
    expect(moduleRolesOf('costs')).toEqual(['manager']);
    const id = (await s.api('GET', '/users')).find((u: { username: string }) => u.username === 'vera').id;
    const vera = await s.as('vera', PW);
    const rate = { base: 'USD', quote: 'EUR', date: '2026-01-02', rate: '0.9' };
    expect((await status(vera('PUT', '/costs/fx-rates', rate))).status).toBe(403);
    await s.api('PUT', `/users/${id}`, { moduleRoles: [{ module: 'costs', role: 'manager' }] });
    try {
      expect((await status(vera('PUT', '/costs/fx-rates', rate))).status).toBe(200);
    } finally {
      await s.api('PUT', `/users/${id}`, { moduleRoles: [{ module: 'costs', role: null }] });
    }
  });
});

const pick = (x: Record<string, unknown>) => ({ enterprise: x.enterprise, labels: x.labels, fields: x.fields, documentReview: x.documentReview });

describe('module-only users', () => {
  it('reach only their modules and their profile: plant users keep PLANT_VIEWER_ONLY, others get MODULE_ONLY_USER', async () => {
    const nora = users.nora!;
    expect((await nora('GET', '/auth/status')).me.capabilities.plantOnly).toBe(false);
    const id = (await s.api('GET', '/users')).find((u: { username: string }) => u.username === 'nora').id;
    await s.api('PUT', `/users/${id}`, { moduleRoles: [{ module: 'costs', role: 'manager' }] });
    try {
      expect(await status(nora('GET', '/services'))).toEqual({ status: 403, code: 'MODULE_ONLY_USER' });
      expect((await status(nora('GET', '/costs/fx-rates'))).status).toBe(200);
      // the link picker (a route plant viewers reach) finds nothing outside their modules: no dashboard names
      expect(await s.api('GET', '/link-targets?kind=dashboard')).not.toEqual([]);
      for (const kind of ['dashboard', 'site', 'process']) expect(await nora('GET', `/link-targets?kind=${kind}`), kind).toEqual([]);
      // a Costs manager without a core role maintains instance price books and reads the exchange rates they set
      const book = (await nora('POST', '/costs/price-books', { name: 'Invented module-only book', kind: 'list', provider: 'Invented', currency: 'USD' })).id;
      // the Access tab (a route plant viewers reach): their modules' kinds only – not a core item, even one shared with them
      const proc = ((await s.api('GET', '/processes')) as { id: string }[])[0]!.id;
      await s.api('PUT', `/access/process/${proc}/shares`, { shares: [{ subject: 'user:nora', level: 'view' }] });
      try {
        expect((await nora('GET', '/costs/price-books')).map((b: { id: string }) => b.id)).toContain(book);
        await nora('PUT', `/costs/price-books/${book}/entries`, { entries: [{ sku: 'x', name: 'X', unit: 'h', price: '1', currency: 'USD' }] });
        expect((await nora('GET', '/costs/fx-rates')).length).toBe((await s.api('GET', '/costs/fx-rates')).length);
        expect((await status(nora('GET', `/access/process/${proc}/shares`))).status).toBe(404);
        expect((await nora('GET', `/access/cost_price_book/${book}/shares`)).canManage).toBe(true);
      } finally {
        await s.api('PUT', `/access/process/${proc}/shares`, { shares: [] });
        await s.api('DELETE', `/costs/price-books/${book}`);
      }
      expect((await status(nora('GET', '/auth/status'))).status).toBe(200);
      await s.api('PUT', `/users/${id}`, {
        moduleRoles: [
          { module: 'costs', role: null },
          { module: 'plant', role: 'viewer' },
        ],
      });
      expect(await status(nora('GET', '/services'))).toEqual({ status: 403, code: 'PLANT_VIEWER_ONLY' });
      expect((await status(nora('GET', '/plant/sites'))).status).toBe(200);
      const st = (await nora('GET', '/auth/status')).me.capabilities;
      expect(st).toMatchObject({ plantOnly: true, plant: true, moduleRoles: { plant: 'viewer' } });
      // a viewer sees, does not propose
      expect((await nora('GET', '/plant/sites/rx-open')).permissions).toEqual(['view']);
    } finally {
      await s.api('PUT', `/users/${id}`, { moduleRoles: [{ module: 'plant', role: null }] });
    }
    // a status viewer with a plant role (the former "plant" and "status" pair) reaches both
    expect((await status(users.polly!('GET', '/plant/sites'))).status).toBe(200);
    expect((await status(users.polly!('GET', '/status-pages'))).status).toBe(200);
    expect((await status(users.polly!('GET', '/services'))).code).toBe('PLANT_VIEWER_ONLY');
  });
});

describe('single sign-on (ADR 0034 part 6)', () => {
  let p = '';
  const provider = async (): Promise<Record<string, any>> => {
    const x = (await s.api('GET', '/sso/providers')).find((y: { id: string }) => y.id === p);
    const { id: _i, hasClientSecret: _h, createdAt: _c, updatedAt: _u, warnings: _w, ...input } = x;
    return input;
  };
  async function signIn(login: string): Promise<{ client?: Client; error?: string }> {
    const start = await fetch(`${s.base}/api/auth/oidc/${p}/start`, { redirect: 'manual' });
    const authorize = new URL(start.headers.get('location')!);
    authorize.pathname += '/approve';
    authorize.searchParams.set('login', login);
    const approve = await fetch(authorize, { redirect: 'manual' });
    const res = await fetch(new URL(approve.headers.get('location')!), { redirect: 'manual', headers: { cookie: ssoBinding(start) } });
    if (res.status !== 200) return { error: await withRefusalReason(s, res.headers.get('location') ?? String(res.status)) };
    return {};
  }

  it('a mapping gives module roles, synchronised at each sign-in; the role "plant" of a mapping is the contributor grant', async () => {
    p = (await s.api('GET', '/sso/providers'))[0].id;
    await s.api('PUT', `/sso/providers/${p}`, {
      ...(await provider()),
      requireMapping: false,
      syncRoles: true,
      defaultRoles: [],
      mappings: [
        { claimValue: 'SM.PlantManagers', roles: ['viewer'], teams: [], moduleRoles: [{ module: 'plant', role: 'manager' }] },
        { claimValue: 'SM.PlantViewers', roles: ['plant'], teams: [] },
      ],
    });
    mock.setMockIdentity('mira', { preferred_username: 'mira@contoso.example', idToken: { roles: ['SM.PlantManagers'] } });
    expect((await signIn('mira')).error).toBeUndefined();
    const name = ((await s.api('GET', '/users')) as { username: string }[]).find((u) => u.username.startsWith('mira'))!.username;
    const grants = () =>
      db().all<{ role: string; source: string }>("SELECT role, source FROM module_grants WHERE module_id = 'plant' AND subject = ?", `user:${name}`);
    expect(grants()).toEqual([{ role: 'manager', source: 'sso' }]);
    const entry = (await s.api('GET', '/audit?action=access.module_access_changed&limit=1'))[0];
    expect(entry.details).toMatchObject({ via: 'sso', roles: [{ subject: `user:${name}`, before: null, after: 'manager' }] });
    // the next sign-in with the other group: the deprecated role gives the contributor grant, and it is not stored as a role
    mock.setMockIdentity('mira', { preferred_username: 'mira@contoso.example', idToken: { roles: ['SM.PlantViewers'] } });
    expect((await signIn('mira')).error).toBeUndefined();
    expect(grants()).toEqual([{ role: 'contributor', source: 'sso' }]);
    expect(JSON.parse(db().get<{ roles: string }>('SELECT roles FROM users WHERE username = ?', name)!.roles)).toEqual([]);
    // an administrator's grant of the same person stays when single sign-on drops its own
    const id = (await s.api('GET', '/users')).find((u: { username: string }) => u.username === name).id;
    await s.api('PUT', `/users/${id}`, { moduleRoles: [{ module: 'plant', role: 'viewer' }] });
    mock.setMockIdentity('mira', { preferred_username: 'mira@contoso.example', idToken: { roles: [] } });
    expect((await signIn('mira')).error).toBeUndefined();
    expect(grants()).toEqual([{ role: 'viewer', source: null }]);
    const listed = (await s.api('GET', '/users')).find((u: { username: string }) => u.username === name);
    expect(listed.moduleRoles).toEqual([{ module: 'plant', role: 'viewer', source: 'admin' }]);
  });

  it('the role "plant" of a mapping does not put a person on the list of a restricted plant registry: they keep the role', async () => {
    const before = await s.api('GET', '/settings/modules/plant/access');
    const kept = before.grants
      .filter((g: { source: string; subject: string }) => g.source !== 'sso' && !g.subject.startsWith('user:nina'))
      .map((g: { subject: string; role?: string | null }) => ({ subject: g.subject, role: g.role ?? null }));
    await s.api('PUT', '/settings/modules/plant/access', { mode: 'selected', grants: kept });
    try {
      mock.setMockIdentity('nina', { preferred_username: 'nina@contoso.example', idToken: { roles: ['SM.PlantViewers'] } });
      expect((await signIn('nina')).error).toBeUndefined();
      const name = ((await s.api('GET', '/users')) as { username: string }[]).find((u) => u.username.startsWith('nina'))!.username;
      // no grant (it would put her on the list), the role kept: what the mapping gave her in 0.22 – nothing here
      expect(db().all("SELECT role FROM module_grants WHERE module_id = 'plant' AND subject = ?", `user:${name}`)).toEqual([]);
      expect(JSON.parse(db().get<{ roles: string }>('SELECT roles FROM users WHERE username = ?', name)!.roles)).toEqual(['plant']);
      // once an administrator lets her use it, the next sign-in turns the role into the synchronised grant
      await s.api('PUT', '/settings/modules/plant/access', { mode: 'selected', grants: [...kept, { subject: `user:${name}` }] });
      expect((await signIn('nina')).error).toBeUndefined();
      expect(db().all("SELECT role, source FROM module_grants WHERE module_id = 'plant' AND subject = ? AND source = 'sso'", `user:${name}`)).toEqual([
        { role: 'contributor', source: 'sso' },
      ]);
      expect(JSON.parse(db().get<{ roles: string }>('SELECT roles FROM users WHERE username = ?', name)!.roles)).toEqual([]);
    } finally {
      await s.api('PUT', '/settings/modules/plant/access', { mode: before.mode, grants: kept });
    }
  });
});

describe('the data products module (ADR 0036 part 12)', () => {
  it('core roles give what 0.22.0 gave; a granted contributor creates entries, a granted manager changes them', async () => {
    const { FROM_CORE_ROLES } = await import('../src/dataproducts/access.js');
    for (const role of ROLES) expect(moduleRoleFromCore('dataProducts', [role]), role).toBe(FROM_CORE_ROLES[role]);
    expect(moduleRolesOf('dataProducts')).toEqual(['viewer', 'contributor', 'manager']);
    await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
    const vera = await s.as('vera', PW);
    expect((await status(vera('POST', '/data-products', { key: 'invented-roles-a', name: 'Invented product A' }))).status).toBe(403);
    const id = (await s.api('GET', '/users')).find((u: { username: string }) => u.username === 'vera').id;
    await s.api('PUT', `/users/${id}`, { moduleRoles: [{ module: 'dataProducts', role: 'contributor' }] });
    try {
      const made = await vera('POST', '/data-products', { key: 'invented-roles-b', name: 'Invented product B' });
      const product = await s.api('POST', '/data-products', { key: 'invented-roles-c', name: 'Invented product C' });
      // a contributor sees, does not change what others made
      expect((await status(vera('PUT', `/data-products/${product.id}`, { key: 'invented-roles-c', name: 'Renamed' }))).status).toBe(403);
      await s.api('PUT', `/users/${id}`, { moduleRoles: [{ module: 'dataProducts', role: 'manager' }] });
      const explain = await s.api('GET', `/access/explain?kind=data_product&id=${product.id}&user=vera`);
      expect(explain.permissions).toEqual(expect.arrayContaining(['view', 'edit', 'manage']));
      expect(explain.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'moduleRole', moduleRole: 'manager' })]));
      expect(made.id).toBeTruthy();
    } finally {
      await s.api('PUT', `/users/${id}`, { moduleRoles: [{ module: 'dataProducts', role: null }] });
    }
  });
});

describe('the module policy is read once per request', () => {
  it('deciding every site costs the same statements however many grants there are', async () => {
    const { siteRights } = await import('../src/plant/access.js');
    const { requestDbStats } = await import('../src/database/timing.js');
    const { runAs } = await import('../src/auth/context.js');
    const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
    const rows = () => db().all<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites');
    const count = (name: string) => {
      const u = toAuthUser(findUserByName(name)!);
      const st = { statements: 0, ms: 0 };
      runAs(u, () => requestDbStats.run(st, () => siteRights(rows(), u)));
      return st.statements;
    };
    count('vic');
    const few = count('vic');
    const teams: string[] = [];
    for (let i = 0; i < 25; i++) teams.push((await s.api('POST', '/teams', { name: `Invented grant team ${i}`, members: ['vic'] })).id);
    await s.api('PUT', '/settings/modules/plant/access', {
      mode: 'everyone',
      grants: Array.from({ length: 25 }, (_, i) => ({ subject: `team:invented grant team ${i}`, role: 'contributor' })),
    });
    for (let i = 0; i < 20; i++) await s.api('POST', '/plant/sites', { id: `rx-many-${i}`, name: `Invented many ${i}` });
    try {
      const many = count('vic');
      expect(many).toBe(few);
      expect(many).toBeLessThan(15);
    } finally {
      await s.api('PUT', '/settings/modules/plant/access', { mode: 'everyone', grants: [] });
      for (const t of teams) await s.api('DELETE', `/teams/${t}`);
    }
  });
});

export type { ModuleId };
