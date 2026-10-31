import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Dependency-Track (#119) against the demo: a component names its project (name@version, name@latest, UUID), the
 * readout counts open findings (not suppressed, not analysed as not affected or false positive) and policy
 * violations, a new critical finding goes into the application's history, and the monitor check.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let dt: string;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup');
  dt = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'dependency-track').id;
});
afterAll(async () => {
  await s?.app.close();
});

const read = async (appId: string, componentId: string) =>
  (await s.api('POST', `/applications/${appId}/components/${componentId}/dependency-track`, {})).components.find((c: any) => c.id === componentId);

describe('Dependency-Track', () => {
  it('tests the connection with the API key', async () => {
    expect(await s.api('POST', `/platforms/${dt}/test`, {})).toMatchObject({ ok: true, status: 200 });
  });

  it('links any component to its project and counts only open findings', async () => {
    const { resetDtrack } = await import('../src/mock/mockDtrack.js');
    resetDtrack();
    const app = await s.api('POST', '/applications', { name: 'Shop with vulnerabilities', owners: [] });
    await expect(
      s.api('POST', `/applications/${app.id}/components`, { type: 'repository', name: 'shop web', dependencyTrack: { platformId: dt, project: 'shop-web' } }),
    ).rejects.toThrow(/name@version/);
    const other = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'kafka').id;
    await expect(
      s.api('POST', `/applications/${app.id}/components`, {
        type: 'repository',
        name: 'shop web',
        dependencyTrack: { platformId: other, project: 'shop-web@2.4.1' },
      }),
    ).rejects.toThrow(/Dependency-Track platform/);
    const a = await s.api('POST', `/applications/${app.id}/components`, {
      type: 'container-image',
      name: 'shop-web image',
      dependencyTrack: { platformId: dt, project: 'shop-web@2.4.1' },
    });
    const cmp = a.components.find((c: any) => c.name === 'shop-web image');
    expect(cmp.dependencyTrack).toEqual({ platformId: dt, project: 'shop-web@2.4.1', readout: null });
    const r = (await read(app.id, cmp.id)).dependencyTrack.readout;
    // 6 findings: the suppressed one and the NOT_AFFECTED one do not count
    expect(r).toMatchObject({
      error: null,
      project: { name: 'shop-web', version: '2.4.1', uuid: '6b1f3c2a-0d4e-4c55-9a11-2f7f0e6b1a01' },
      counts: { critical: 1, high: 1, medium: 1, low: 1, unassigned: 0 },
      policy: { fail: 1, warn: 2, info: 0 },
    });
    expect(r.top[0]).toMatchObject({
      vulnId: 'CVE-2021-44228',
      severity: 'critical',
      component: 'org.apache.logging.log4j/log4j-core',
      fixedIn: '2.17.1',
      epss: 0.975,
    });
    expect(r.top.map((f: any) => f.vulnId)).not.toContain('CVE-2024-4068');
    // name@latest and the UUID
    const b = await s.api('PUT', `/applications/${app.id}/components/${cmp.id}`, {
      type: 'container-image',
      name: 'shop-web image',
      dependencyTrack: { platformId: dt, project: 'shop-web@latest' },
    });
    expect(b.components.find((c: any) => c.id === cmp.id).dependencyTrack.readout).toBeNull();
    expect((await read(app.id, cmp.id)).dependencyTrack.readout).toMatchObject({ project: { version: '2.5.0' }, counts: { critical: 0, medium: 1 } });
    await s.api('PUT', `/applications/${app.id}/components/${cmp.id}`, {
      type: 'container-image',
      name: 'shop-web image',
      dependencyTrack: { platformId: dt, project: '9c2d4e5f-1a2b-4c3d-8e9f-0a1b2c3d4e05' },
    });
    expect((await read(app.id, cmp.id)).dependencyTrack.readout).toMatchObject({ project: { name: 'crm-api' }, counts: { critical: 0 }, policy: { fail: 0 } });
    // a project that does not exist: the reason, the last read kept
    await s.api('PUT', `/applications/${app.id}/components/${cmp.id}`, {
      type: 'container-image',
      name: 'shop-web image',
      dependencyTrack: { platformId: dt, project: 'nope@1.0' },
    });
    expect((await read(app.id, cmp.id)).dependencyTrack.readout.error).toMatch(/no project nope@1.0/);
    // removing the link
    const c = await s.api('PUT', `/applications/${app.id}/components/${cmp.id}`, { type: 'container-image', name: 'shop-web image', dependencyTrack: null });
    expect(c.components.find((x: any) => x.id === cmp.id).dependencyTrack).toBeNull();
  });

  it('records new critical findings in the history and refreshes in the background', async () => {
    const { resetDtrack, addDtrackFinding } = await import('../src/mock/mockDtrack.js');
    resetDtrack();
    const app = await s.api('POST', '/applications', { name: 'Shop history', owners: [] });
    const a = await s.api('POST', `/applications/${app.id}/components`, {
      type: 'repository',
      name: 'acme/shop',
      dependencyTrack: { platformId: dt, project: 'shop-web@2.4.1' },
    });
    const cmp = a.components.find((c: any) => c.name === 'acme/shop');
    await read(app.id, cmp.id);
    addDtrackFinding('shop-web@2.4.1', { vulnId: 'CVE-2026-0001', severity: 'CRITICAL', component: { name: 'express', version: '4.17.1' }, patched: '4.21.2' });
    const r = (await read(app.id, cmp.id)).dependencyTrack.readout;
    expect(r.counts.critical).toBe(2);
    const audit = await s.api('GET', `/audit?entityType=application&entityId=${app.id}`);
    expect(audit.find((e: any) => e.action === 'application.vulnerabilities_found').summary).toMatch(/new critical CVE-2026-0001 in express/);
    const { runDtrackJob } = await import('../src/dtrack/service.js');
    expect(await runDtrackJob(Date.now())).toBe(0);
    expect(await runDtrackJob(Date.now() + 7 * 3_600_000)).toBeGreaterThanOrEqual(1);
  });

  it('checks a project in a monitor: critical findings, failing policies, high findings', async () => {
    const { resetDtrack, setDtrackPolicy } = await import('../src/mock/mockDtrack.js');
    resetDtrack();
    const eng = await import('../src/monitors/engine.js');
    const check = (id: string, project: string, extra: Record<string, unknown> = {}) => ({
      id,
      name: id,
      type: 'dependency-track',
      platform: 'Dependency-Track (demo)',
      project,
      ...extra,
    });
    const { monitor } = await s.api('POST', '/monitors', {
      definition: {
        name: 'Vulnerabilities',
        failuresBeforeDown: 1,
        checks: [
          check('old', 'shop-web@2.4.1'),
          check('latest', 'shop-web@latest', { maxHigh: 0 }),
          check('crm', 'crm-api@1.0.0'),
          check('policy-only', 'shop-web@2.4.1', { maxCritical: 5, failAs: 'degraded' }),
        ],
      },
    });
    await eng.evaluateMonitorNow(monitor.id);
    const st = await s.api('GET', `/monitors/${monitor.id}`);
    const by = Object.fromEntries(st.checks.map((c: any) => [c.checkId, { status: c.status, message: c.last?.message ?? '' }]));
    expect(by.old.status).toBe('down');
    expect(by.old.message).toMatch(/1 critical \(at most 0\): CVE-2021-44228 in org.apache.logging.log4j\/log4j-core; 1 failing policy/);
    expect(by.latest.status).toBe('up');
    expect(by.crm.status).toBe('up');
    expect(by['policy-only']).toMatchObject({ status: 'degraded', message: expect.stringMatching(/1 failing policy violation/) });
    setDtrackPolicy('shop-web@2.4.1', { fail: 0, warn: 0, info: 0 });
  });
});
