import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODULES, moduleOfMcpTool, moduleRestrictable, type ModuleId } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Module access (0.21.0, ADR 0034): a module that is on is used by everyone signed in (the default, so an upgrade
 * changes nothing) or by selected teams and users. Administrators and auditors always use every module. Someone who
 * does not use a module meets it like a switched-off one, on every surface: 404 MODULE_NO_ACCESS on its routes (the
 * internal API and /api/v1), no MCP tools, no notifications of its events, no report sections, links counted but not
 * named, and the web app learns it from /auth/status.
 */

let s: TestServer;
const PW = 'Demo-password-1';
let vera: Client, dana: Client, audrey: Client;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [vera, dana, audrey] = await Promise.all(['vera', 'dana', 'audrey'].map((u) => s.as(u, PW)));
}, 180_000);
afterAll(async () => {
  await s?.app.close();
});

const status = async (c: Client, method: string, url: string, body?: unknown) => {
  try {
    await c(method, url, body);
    return { status: 200, code: '' };
  } catch (e) {
    const err = e as { status: number; body?: { code?: string } };
    return { status: err.status, code: err.body?.code ?? '' };
  }
};

const restrict = (id: ModuleId, subjects: string[]) =>
  s.api('PUT', `/settings/modules/${id}/access`, { mode: 'selected', grants: subjects.map((subject) => ({ subject })) });
const open = (id: ModuleId) => s.api('PUT', `/settings/modules/${id}/access`, { mode: 'everyone', grants: [] });

describe('the registry declares who may restrict what', () => {
  it('every switchable module but the status pages can be restricted; the map follows the plant registry', () => {
    for (const m of MODULES) expect(moduleRestrictable(m.id), m.id).toBe(m.switchable && m.id !== 'statusPages');
    expect(MODULES.find((m) => m.id === 'plantMap')?.access?.follows).toBe('plant');
    expect(moduleOfMcpTool('get_service_cost_plan')).toBe('costs');
    expect(moduleOfMcpTool('list_plant_sites')).toBe('plant');
    expect(moduleOfMcpTool('list_runs')).toBeUndefined();
  });
});

describe('after an upgrade', () => {
  it('nobody loses a module: everything is open to everyone signed in', async () => {
    const v = await s.api('GET', '/settings/modules');
    for (const m of v.modules) expect(m.accessMode, m.id).toBe('everyone');
    for (const c of [vera, dana, audrey]) {
      const st = await c('GET', '/auth/status');
      for (const m of MODULES) expect(st.me.capabilities.moduleAccess[m.id], m.id).not.toBe('notYours');
    }
    const { usesModule } = await import('../src/modules/access.js');
    const { listUsers, toAuthUser } = await import('../src/auth/users.js');
    for (const u of listUsers()) for (const m of MODULES) expect(usesModule(toAuthUser(u), m.id), `${u.username} ${m.id}`).toBe(true);
  });
});

describe('Settings → Modules → Who may use it', () => {
  it('is for administrators in a signed-in session; widening asks for a step-up, narrowing does not; audited', async () => {
    expect((await status(dana, 'GET', '/settings/modules/costs/access')).status).toBe(403);
    expect((await status(dana, 'PUT', '/settings/modules/costs/access', { mode: 'selected', grants: [] })).status).toBe(403);
    const token = (await s.api('POST', '/me/tokens', { name: 'module access', scope: 'full' })).token as string;
    const res = await fetch(`${s.base}/api/settings/modules/costs/access`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('SESSION_REQUIRED');

    expect(await s.api('GET', '/settings/modules/costs/access')).toMatchObject({ module: 'costs', restrictable: true, mode: 'everyone', grants: [] });
    expect(await status(s.api, 'PUT', '/settings/modules/statusPages/access', { mode: 'selected', grants: [] })).toEqual({
      status: 400,
      code: 'MODULE_NOT_RESTRICTABLE',
    });
    expect(await status(s.api, 'PUT', '/settings/modules/costs/access', { mode: 'selected', grants: [{ subject: 'user:nobody-here' }] })).toEqual({
      status: 400,
      code: 'USER_UNKNOWN',
    });
    expect((await status(s.api, 'PUT', '/settings/modules/costs/access', { mode: 'selected', grants: [{ subject: 'role:viewer' }] })).status).toBe(400);

    const admin = await s.as('admin', 'Admin-password-1', { autoStepUp: false });
    await admin('DELETE', '/auth/step-up');
    // restricting narrows: confirmed in the dialog, no step-up
    const v = await admin('PUT', '/settings/modules/costs/access', { mode: 'selected', grants: [{ subject: 'user:dana' }] });
    expect(v).toMatchObject({ mode: 'selected', grants: [{ subject: 'user:dana', createdBy: 'admin', known: true }] });
    // adding someone and opening it widen: step-up
    expect(
      await status(admin, 'PUT', '/settings/modules/costs/access', { mode: 'selected', grants: [{ subject: 'user:dana' }, { subject: 'user:vera' }] }),
    ).toEqual({
      status: 403,
      code: 'STEP_UP_REQUIRED',
    });
    expect(await status(admin, 'PUT', '/settings/modules/costs/access', { mode: 'everyone', grants: [] })).toEqual({ status: 403, code: 'STEP_UP_REQUIRED' });
    // the preview: who gains, who loses – nothing changed
    const p = await admin('POST', '/settings/modules/costs/access/preview', { mode: 'everyone', grants: [] });
    expect(p.widens).toBe(true);
    expect(p.gains.map((u: { username: string }) => u.username)).toEqual(expect.arrayContaining(['vera', 'olivia']));
    expect(p.gains.map((u: { username: string }) => u.username)).not.toContain('admin');
    expect(p.loses).toEqual([]);
    const narrow = await admin('POST', '/settings/modules/costs/access/preview', { mode: 'selected', grants: [] });
    expect(narrow).toMatchObject({ widens: false, gains: [] });
    expect(narrow.loses.map((u: { username: string }) => u.username)).toEqual(['dana']);
    expect((await s.api('GET', '/settings/modules/costs/access')).grants.map((g: { subject: string }) => g.subject)).toEqual(['user:dana']);
    expect((await s.api('GET', '/settings/modules')).modules.find((m: { id: string }) => m.id === 'costs').accessMode).toBe('selected');

    await open('costs');
    const audit = (await s.api('GET', '/audit?action=access.module_access_changed')) as { action: string; entityId: string; details?: unknown }[];
    const entries = audit.filter((e) => e.action === 'access.module_access_changed' && e.entityId === 'module:costs');
    expect(entries.length).toBe(2);
  });
});

describe('a person who does not use a module', () => {
  it('gets 404 MODULE_NO_ACCESS on its routes, in the internal API and /api/v1; administrators and auditors are not affected', async () => {
    await restrict('costs', ['user:dana']);
    try {
      expect(await status(vera, 'GET', '/costs?scope=service')).toEqual({ status: 404, code: 'MODULE_NO_ACCESS' });
      expect(await status(vera, 'GET', '/costs/settings')).toEqual({ status: 404, code: 'MODULE_NO_ACCESS' });
      expect((await status(dana, 'GET', '/costs?scope=service')).status).toBe(200);
      expect((await status(audrey, 'GET', '/costs?scope=service')).status).toBe(200);
      expect((await status(s.api, 'GET', '/costs?scope=service')).status).toBe(200);
      const token = (await vera('POST', '/me/tokens', { name: 'vera read', scope: 'read' })).token as string;
      const res = await fetch(`${s.base}/api/v1/costs`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      expect((await res.json()).code).toBe('MODULE_NO_ACCESS');
      // a caller who is not signed in learns nothing
      expect((await fetch(`${s.base}/api/costs`)).status).toBe(401);
      // the web app hears it: hidden like a switched-off module, with its own state
      const st = await vera('GET', '/auth/status');
      expect(st.me.capabilities.modules.costs).toBe(false);
      expect(st.me.capabilities.moduleAccess.costs).toBe('notYours');
      expect(st.me.capabilities.moduleAccess.scorecard).toBe('on');
      expect((await dana('GET', '/auth/status')).me.capabilities.moduleAccess.costs).toBe('on');
      // its connectors are not offered to them
      await restrict('dataContracts', []);
      expect(((await vera('GET', '/platform-presets')) as { kind: string }[]).map((p) => p.kind)).not.toContain('datacontract');
      expect(((await s.api('GET', '/platform-presets')) as { kind: string }[]).map((p) => p.kind)).toContain('datacontract');
      expect((await vera('GET', '/me/visibility')).areas.dataContracts).toBeUndefined();
      expect((await s.api('GET', '/me/visibility')).areas.dataContracts).toBeDefined();
    } finally {
      await open('costs');
      await open('dataContracts');
    }
    expect((await status(vera, 'GET', '/costs?scope=service')).status).toBe(200);
  });

  it('uses it through a team; a renamed team keeps it, a deleted team stays a grant that matches nobody', async () => {
    const team = await s.api('POST', '/teams', { name: 'Invented cost office', members: ['vera'] });
    await restrict('costs', ['team:invented cost office']);
    try {
      expect((await status(vera, 'GET', '/costs?scope=service')).status).toBe(200);
      expect((await status(dana, 'GET', '/costs?scope=service')).code).toBe('MODULE_NO_ACCESS');
      await s.api('PUT', `/teams/${team.id}`, { name: 'Invented finance', members: ['vera'] });
      expect((await s.api('GET', '/settings/modules/costs/access')).grants.map((g: { subject: string }) => g.subject)).toEqual(['team:invented finance']);
      expect((await status(vera, 'GET', '/costs?scope=service')).status).toBe(200);
      const { subjectUsesModule } = await import('../src/modules/access.js');
      expect(subjectUsesModule('team:invented finance', 'costs')).toBe(true);
      expect(subjectUsesModule('user:vera', 'costs')).toBe(true);
      expect(subjectUsesModule('user:dana', 'costs')).toBe(false);
      expect(subjectUsesModule('user:audrey', 'costs')).toBe(true);
      expect(subjectUsesModule('user:dana', 'scorecard')).toBe(true);
      await s.api('DELETE', `/teams/${team.id}`);
      const grants = (await s.api('GET', '/settings/modules/costs/access')).grants;
      expect(grants).toMatchObject([{ subject: 'team:invented finance', known: false }]);
      expect((await status(vera, 'GET', '/costs?scope=service')).code).toBe('MODULE_NO_ACCESS');
    } finally {
      await open('costs');
    }
  });

  it('gets no MCP tools of the module, and a call is refused', async () => {
    await s.api('PUT', '/mcp-server', { enabled: true });
    const token = (await vera('POST', '/me/tokens', { name: 'vera mcp', scope: 'mcp' })).token as string;
    const rpc = async (method: string, params: Record<string, unknown> = {}) => {
      const res = await fetch(`${s.base}/api/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'mcp-protocol-version': '2025-06-18',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return res.json();
    };
    const names = async () => ((await rpc('tools/list')).result.tools as { name: string }[]).map((t) => t.name);
    expect(await names()).toContain('list_cost_commitments');
    await restrict('costs', ['user:dana']);
    try {
      const list = await names();
      expect(list).not.toContain('list_cost_commitments');
      expect(list).not.toContain('get_service_cost_plan');
      expect(list).toContain('search_processes');
      const called = await rpc('tools/call', { name: 'list_cost_commitments', arguments: {} });
      expect(called.error?.message).toMatch(/Unknown tool/);
    } finally {
      await open('costs');
    }
    expect(await names()).toContain('list_cost_commitments');
  });

  it('is sent no notification of its events, in no channel', async () => {
    const { notify } = await import('../src/notifications/service.js');
    const { findUserByName } = await import('../src/auth/users.js');
    const recipients = ['vera', 'dana'].map((n) => findUserByName(n)!);
    const send = (key: string) =>
      notify({ event: 'cost.budget', text: () => ({ title: `Budget ${key}`, body: '' }), recipients, inAppKey: key, externalKey: key });
    const titles = async (c: Client) => ((await c('GET', '/notifications')).items as { title: string }[]).map((n) => n.title);
    await restrict('costs', ['user:dana']);
    try {
      send('restricted');
      expect(await titles(dana)).toContain('Budget restricted');
      expect(await titles(vera)).not.toContain('Budget restricted');
    } finally {
      await open('costs');
    }
    send('open');
    expect(await titles(vera)).toContain('Budget open');
  });

  it('gets a scheduled report without the sections of a module they do not use; the full report is not theirs', async () => {
    const schedules = await import('../src/reports/schedules.js');
    const sch = await s.api('POST', '/report-schedules', {
      name: 'Weekly service review (modules)',
      preset: 'weekly',
      lang: 'en',
      sections: { runs: true, scorecard: true },
      recipients: { users: ['vera', 'dana'], teams: [], emails: [] },
      enabled: false,
    });
    await restrict('scorecard', ['user:dana']);
    try {
      const full = await schedules.runReportSchedule(sch.id, { actor: 'admin', compress: false });
      expect(full.modules).toEqual(['scorecard']);
      const link = async (c: Client) =>
        ((await c('GET', '/notifications')).items as { title: string; link?: string }[]).find((n) => n.title.includes('Weekly service review (modules)'))?.link;
      const danaLink = await link(dana);
      const veraLink = await link(vera);
      expect(danaLink).toContain(full.id);
      expect(veraLink).toBeDefined();
      expect(veraLink).not.toContain(full.id);
      const copyId = decodeURIComponent(veraLink!.split('report=')[1]!);
      const copy = await vera('GET', `/reports/${copyId}`);
      expect(copy.modules ?? []).toEqual([]);
      expect(await status(vera, 'GET', `/reports/${full.id}`)).toEqual({ status: 404, code: 'REPORT_NOT_FOUND' });
      expect((await status(dana, 'GET', `/reports/${full.id}`)).status).toBe(200);
      expect((await status(audrey, 'GET', `/reports/${full.id}`)).status).toBe(200);
    } finally {
      await open('scorecard');
    }
  });

  it('sees a link from a core item to an item of the module counted, not named; cannot add one or find it', async () => {
    await s.api('PUT', '/settings/modules/plant', { enabled: true });
    const site = ((await s.api('GET', '/plant/sites')) as { id: string; name: string }[])[0]!;
    // a service of the whole instance (no owning team): everyone sees it
    const svc = await s.api('POST', '/services', { name: 'Invented line service (modules)' });
    await s.api('PUT', `/owning-teams/service/${svc.id}`, { teamIds: [] });
    expect((await vera('GET', `/services/${svc.id}`)).id).toBe(svc.id);
    const link = await s.api('POST', `/services/${svc.id}/links`, { kind: 'site', id: site.id, note: `runs at ${site.name}` });
    await restrict('plant', []);
    try {
      const links = (await vera('GET', `/services/${svc.id}`)).links as {
        id: string;
        module?: string;
        label: string;
        note: string;
        targetId: string | null;
        visible: boolean;
      }[];
      const l = links.find((x) => x.id === link.id)!;
      expect(l).toMatchObject({ module: 'plant', label: '', note: '', targetId: null, visible: false });
      expect(JSON.stringify(links)).not.toContain(site.name);
      expect(JSON.stringify(links)).not.toContain(site.id);
      // the administrator still sees it named
      expect(((await s.api('GET', `/services/${svc.id}`)).links as { id: string; label: string }[]).find((x) => x.id === link.id)?.label).toBe(site.name);
      expect(await vera('GET', `/link-targets?kind=site&q=${encodeURIComponent(site.name.slice(0, 3))}`).catch((e: { status: number }) => e.status)).toEqual(
        [],
      );
      expect(await status(vera, 'GET', '/plant/sites')).toEqual({ status: 404, code: 'MODULE_NO_ACCESS' });
      expect((await vera('GET', '/auth/status')).me.capabilities).toMatchObject({
        plant: false,
        moduleAccess: { plant: 'notYours', plantMap: expect.any(String) },
      });
    } finally {
      await open('plant');
      await s.api('DELETE', `/services/${svc.id}/links/${link.id}`);
      await s.api('PUT', '/settings/modules/plant', { enabled: false });
    }
  });
});
