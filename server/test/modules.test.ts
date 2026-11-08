import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODULES, moduleOfRoute } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The module registry (0.11.0, ADR 0016): Settings → Modules switches optional areas on and off. Off, a module's
 * routes answer 404 (internal API and /api/v1), its jobs do not run, its connectors are not offered, the web app
 * learns it in /auth/status; its data stays and is back when it is switched on.
 */

let s: TestServer;
const PW = 'Demo-password-1';
const as = (user: string, opts?: { autoStepUp?: boolean }) => s.as(user, PW, opts);

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
});
afterAll(async () => {
  const reg = await import('../src/jobs/registry.js');
  reg.resetJobs();
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

describe('the registry', () => {
  it('declares every module once, with a maturity; routes of two modules never overlap', () => {
    expect(new Set(MODULES.map((m) => m.id)).size).toBe(MODULES.length);
    for (const m of MODULES) {
      expect(['stable', 'beta', 'preview']).toContain(m.maturity);
      for (const r of m.routes) expect(moduleOfRoute(r), r).toBe(m.id);
    }
    expect(moduleOfRoute('/api/costs/:scope/:id')).toBe('costs');
    expect(moduleOfRoute('/api/v1/services/:serviceId/scorecard')).toBe('scorecard');
    expect(moduleOfRoute('/api/v1/services/:serviceId')).toBeUndefined();
    expect(moduleOfRoute('/api/costsx')).toBeUndefined();
    expect(moduleOfRoute('/api/processes')).toBeUndefined();
  });

  it('names registered routes only: every route prefix matches at least one route of the server', async () => {
    const { registeredRoutes } = await import('../src/app.js');
    const urls = registeredRoutes(s.app).map((r) => r.url);
    for (const m of MODULES)
      for (const p of m.routes)
        expect(
          urls.some((u) => moduleOfRoute(u) === m.id && (u === p || u.startsWith(`${p}/`))),
          p,
        ).toBe(true);
  });
});

describe('Settings → Modules', () => {
  it('has everything on by default, except the plant registry and its map', async () => {
    const v = await s.api('GET', '/settings/modules');
    const on = Object.fromEntries(v.modules.map((m: { id: string; enabled: boolean }) => [m.id, m.enabled]));
    for (const m of MODULES) expect(on[m.id], m.id).toBe(m.id !== 'plant' && m.id !== 'plantMap');
    const st = await s.api('GET', '/auth/status');
    expect(st.me.capabilities.modules.costs).toBe(true);
    expect(st.me.capabilities.modules.plant).toBe(false);
  });

  it('is for administrators, in a signed-in session, with a step-up; API tokens are refused', async () => {
    const dana = await as('dana');
    expect((await status(dana, 'GET', '/settings/modules')).status).toBe(403);
    expect((await status(dana, 'PUT', '/settings/modules/costs', { enabled: false })).status).toBe(403);
    const admin = await s.as('admin', 'Admin-password-1', { autoStepUp: false });
    // a fresh sign-in counts as a confirmation: forget it
    await admin('DELETE', '/auth/step-up');
    expect(await status(admin, 'PUT', '/settings/modules/costs', { enabled: false })).toEqual({ status: 403, code: 'STEP_UP_REQUIRED' });
    // repeating the current state is no change: no step-up, nothing written
    expect((await status(admin, 'PUT', '/settings/modules/costs', { enabled: true })).status).toBe(200);
    const token = (await s.api('POST', '/me/tokens', { name: 'modules', scope: 'full' })).token as string;
    const res = await fetch(`${s.base}/api/settings/modules/costs`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(403);
    expect((await status(s.api, 'PUT', '/settings/modules/nothing', { enabled: false })).status).toBe(404);
    expect(await status(s.api, 'PUT', '/settings/modules/plantMap', { enabled: true })).toEqual({ status: 400, code: 'MODULE_NOT_SWITCHABLE' });
    expect((await status(s.api, 'PUT', '/settings/modules/costs', { enabled: 'no' })).status).toBe(400);
  });

  it('switched off: routes 404 (also /api/v1), no job, no connector; back on, the data is back', async () => {
    const before = await s.api('GET', '/costs?scope=service');
    const contractsBefore = await s.api('GET', '/data-contracts');
    expect(contractsBefore.length).toBeGreaterThan(0);
    const token = (await s.api('POST', '/me/tokens', { name: 'modules-read', scope: 'read' })).token as string;
    const v1 = () => fetch(`${s.base}/api/v1/costs`, { headers: { authorization: `Bearer ${token}` } });
    expect((await v1()).status).toBe(200);

    await s.api('PUT', '/settings/modules/costs', { enabled: false });
    await s.api('PUT', '/settings/modules/dataContracts', { enabled: false });
    expect(await status(s.api, 'GET', '/costs?scope=service')).toEqual({ status: 404, code: 'MODULE_OFF' });
    expect(await status(s.api, 'GET', '/costs/settings')).toEqual({ status: 404, code: 'MODULE_OFF' });
    expect(await status(s.api, 'GET', '/data-contracts')).toEqual({ status: 404, code: 'MODULE_OFF' });
    const res = await v1();
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect((await res.json()).code).toBe('MODULE_OFF');
    // a caller who is not signed in learns nothing about the modules
    expect((await fetch(`${s.base}/api/costs`)).status).toBe(401);
    // the web app hears it, the connector list leaves out its kinds
    const st = await s.api('GET', '/auth/status');
    expect(st.me.capabilities.modules).toMatchObject({ costs: false, dataContracts: false, compliance: true });
    const kinds = (await s.api('GET', '/platform-presets')).map((p: { kind: string }) => p.kind);
    expect(kinds).not.toContain('datacontract');
    expect(kinds).toContain('kubernetes');
    // its job does not run: listed as switched off, "Run now" refused, a planned start skipped without a trace
    const reg = await import('../src/jobs/registry.js');
    const { registerBuiltInJobs } = await import('../src/jobs/builtin.js');
    registerBuiltInJobs();
    expect(reg.listJobs().find((j) => j.name === 'costs')).toMatchObject({ switchedOff: true, runs: 0 });
    expect(reg.listJobs().find((j) => j.name === 'duties')?.switchedOff).toBeUndefined();
    expect(await reg.runJob('costs')).toBe(false);
    expect(reg.listJobs().find((j) => j.name === 'costs')).toMatchObject({ runs: 0, lastStartedAt: null });
    expect(await status(s.api, 'POST', '/system/jobs/costs/run')).toEqual({ status: 409, code: 'MODULE_OFF' });
    // audited
    const audit = await s.api('GET', '/audit?action=module.disabled');
    const entries = audit as { action: string; entityId: string }[];
    expect(entries.filter((e) => e.action === 'module.disabled').map((e) => e.entityId)).toEqual(
      expect.arrayContaining(['module:costs', 'module:dataContracts']),
    );

    await s.api('PUT', '/settings/modules/costs', { enabled: true });
    await s.api('PUT', '/settings/modules/dataContracts', { enabled: true });
    expect(await s.api('GET', '/costs?scope=service')).toEqual(before);
    expect(await s.api('GET', '/data-contracts')).toEqual(contractsBefore);
    expect((await v1()).status).toBe(200);
    expect(reg.listJobs().find((j) => j.name === 'costs')?.switchedOff).toBeUndefined();
  });

  it('switches the plant registry with its own setting; its own switch asks for the same step-up', async () => {
    await s.api('PUT', '/settings/modules/plant', { enabled: true });
    expect((await s.api('GET', '/settings/plant')).enabled).toBe(true);
    expect((await s.api('GET', '/plant/sites')).length).toBeGreaterThan(0);
    const admin = await s.as('admin', 'Admin-password-1', { autoStepUp: false });
    await admin('DELETE', '/auth/step-up');
    const p = await s.api('GET', '/settings/plant');
    const body = { enabled: false, enterprise: p.enterprise, labels: p.labels, fields: p.fields };
    expect(await status(admin, 'PUT', '/settings/plant', body)).toEqual({ status: 403, code: 'STEP_UP_REQUIRED' });
    // other plant settings need no step-up
    expect((await status(admin, 'PUT', '/settings/plant', { ...body, enabled: true })).status).toBe(200);
    await s.api('PUT', '/settings/modules/plant', { enabled: false });
    expect(await status(s.api, 'GET', '/plant/sites')).toEqual({ status: 404, code: 'PLANT_MODULE_OFF' });
    const audit = await s.api('GET', '/audit?action=plant.module_disabled');
    expect((audit as { action: string }[]).some((e) => e.action === 'plant.module_disabled')).toBe(true);
  });
});
