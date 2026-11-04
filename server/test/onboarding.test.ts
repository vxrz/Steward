import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Onboarding (v0.4.0): template bundles (list, set up with bindings, schedules and monitors off, one dry run per
 * process, idempotent re-runs with update or skip, the "turn on" step, audit), what's next with a platform, and platform
 * health (last test, periodic test, "Platform connection failing" for the platform's managers).
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let olivia: Client;
let dana: Client;
let platforms: any[];
const byName = (n: string) => platforms.find((p) => p.name === n)!;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  platforms = await s.api('GET', '/platforms');
  olivia = await s.as('olivia', PW);
  dana = await s.as('dana', PW);
});
afterAll(async () => {
  await s?.app.close();
});

/** The demo set up every template: archive the processes and remove the dashboards and monitors, so a setup creates them anew. */
async function fresh(processIds: string[], dashboardIds: string[], monitorKeys: string[]) {
  for (const id of processIds) await s.api('DELETE', `/processes/${id}`).catch(() => undefined);
  for (const id of dashboardIds) await s.api('DELETE', `/dashboards/${id}`).catch(() => undefined);
  const monitors = await s.api('GET', '/monitors');
  for (const m of monitors.filter((x: any) => monitorKeys.includes(x.key))) await s.api('DELETE', `/monitors/${m.id}`);
}

describe('template bundles', () => {
  it('lists the bundles with their platforms, processes, schedules, dashboards and monitors', async () => {
    const list = await s.api('GET', '/template-bundles');
    expect(list.map((b: any) => b.id)).toEqual([
      '10-ih-access-governance',
      '15-entra-id-access-governance',
      '20-ih-tenant-usage',
      '30-snowflake',
      '40-git-repositories',
      '50-aws',
      '60-prometheus-slo',
      '70-kubernetes',
      '80-dependency-track',
    ]);
    for (const b of list) expect(b.problems, b.id).toEqual([]);
    const ag = list[0];
    expect(ag).toMatchObject({ name: 'Access governance (Insights Hub)', kinds: ['insights-hub'], minVersion: '0.4.0' });
    expect(ag.dashboards).toEqual([{ template: '20-access-governance', name: 'Access governance', existing: expect.anything() }]);
    // the demo set up the inventory snapshot already
    const inv = ag.processes.find((p: any) => p.template === '15-ih-inventory-snapshot');
    expect(inv).toMatchObject({ schedule: { cron: '7 * * * *' }, connections: { hub: 'hub' } });
    // the template's own recommendation, when the bundle names none
    expect(ag.processes.find((p: any) => p.template === '14-ih-group-hygiene').schedule.cron).toBe('30 6 * * 1');
    const git = list.find((b: any) => b.id === '40-git-repositories');
    expect(git.kinds).toEqual(['forgejo', 'github', 'gitlab']);
    expect(git.monitors).toMatchObject([{ file: '53-repository-pipelines.yaml', optional: true }]);
  });

  it('refuses a setup without the right platform or by someone who may not create processes', async () => {
    await expect(s.api('POST', '/template-bundles/30-snowflake/setup', { bindings: {} })).rejects.toMatchObject({
      status: 400,
      body: { code: 'BUNDLE_BINDING_MISSING' },
    });
    await expect(s.api('POST', '/template-bundles/30-snowflake/setup', { bindings: { snowflake: byName('GitHub (demo)').id } })).rejects.toMatchObject({
      status: 400,
      body: { code: 'BUNDLE_BINDING_KIND' },
    });
    await expect(olivia('POST', '/template-bundles/30-snowflake/setup', { bindings: { snowflake: byName('Snowflake (demo)').id } })).rejects.toMatchObject({
      status: 403,
    });
    await expect(s.api('POST', '/template-bundles/nope/setup', { bindings: {} })).rejects.toMatchObject({ status: 404, body: { code: 'BUNDLE_NOT_FOUND' } });
  });

  it('sets a bundle up: processes, dashboard, disabled schedules and monitors, one dry run per process; a re-run skips or updates', async () => {
    const gitlab = byName('GitLab (demo)');
    await fresh(['github-repository-health', 'git-member-review'], ['repositories'], ['repository-pipelines']);
    const r = await dana('POST', '/template-bundles/40-git-repositories/setup', { bindings: { git: gitlab.id } });
    expect(r.bundle).toEqual({ id: '40-git-repositories', name: 'Git repositories (health and members)' });
    const of = (type: string) => r.items.filter((i: any) => i.type === type);
    expect(of('process').map((i: any) => [i.id, i.action])).toEqual([
      ['github-repository-health-2', 'created'],
      ['git-member-review-2', 'created'],
    ]);
    expect(of('dashboard')).toMatchObject([{ id: 'repositories', action: 'created', link: '/dashboards/repositories' }]);
    expect(of('schedule').map((i: any) => i.action)).toEqual(['created', 'created']);
    expect(of('monitor')).toMatchObject([{ action: 'created' }]);
    expect(of('dryRun').map((i: any) => i.action)).toEqual(['started', 'started']);
    // schedules and the monitor are off until the "turn on" step; schedules are bound to the platform
    const schedules = (await s.api('GET', '/schedules')).filter((x: any) => r.turnOn.schedules.includes(x.id));
    expect(schedules).toHaveLength(2);
    for (const x of schedules) expect(x.enabled).toBe(false);
    expect(schedules.map((x: any) => Object.values(x.bindings))).toEqual([[gitlab.id], [gitlab.id]]);
    expect(schedules.map((x: any) => x.cron).sort()).toEqual(['0 * * * *', '0 7 1 1,4,7,10 *']);
    const monitor = await s.api('GET', `/monitors/${r.turnOn.monitors[0]}`);
    expect(monitor.enabled).toBe(false);
    expect(JSON.stringify(monitor.definition)).toContain(gitlab.id);
    // the dry runs are dry runs on the bound platform
    const run = await s.api('GET', `/runs/${of('dryRun')[0].id}`);
    expect(run).toMatchObject({ dryRun: true, processId: 'github-repository-health-2' });
    expect(run.bindings.github.platformId).toBe(gitlab.id);

    // again: everything exists – skipped and kept, no second schedule or monitor
    const again = await dana('POST', '/template-bundles/40-git-repositories/setup', { bindings: { git: gitlab.id }, dryRuns: false });
    expect(again.items.map((i: any) => `${i.type}:${i.action}`)).toEqual([
      'process:skipped',
      'schedule:kept',
      'process:skipped',
      'schedule:kept',
      'dashboard:skipped',
      'monitor:kept',
    ]);
    expect(again.turnOn).toEqual({ schedules: [], monitors: [] });
    const list = await dana('GET', '/template-bundles');
    const git = list.find((b: any) => b.id === '40-git-repositories');
    expect(git.processes.every((p: any) => p.existing && p.existingSchedule)).toBe(true);
    // update: a process changed since is brought back to the template's version
    const p = await dana('GET', '/processes/git-member-review-2');
    await dana('PUT', '/processes/git-member-review-2', { definition: { ...p.definition, description: 'changed by hand' } });
    const upd = await dana('POST', '/template-bundles/40-git-repositories/setup', {
      bindings: { git: gitlab.id },
      existing: 'update',
      dryRuns: false,
      monitors: false,
    });
    expect(upd.items.filter((i: any) => i.type === 'process').map((i: any) => i.action)).toEqual(['skipped', 'updated']);
    expect(upd.items.some((i: any) => i.type === 'monitor')).toBe(false);
    expect((await dana('GET', '/processes/git-member-review-2')).currentVersion).toBe(3);

    // the "turn on" step
    const on = await dana('POST', '/template-bundles/40-git-repositories/turn-on', r.turnOn);
    expect(on.items.map((i: any) => `${i.type}:${i.action}`)).toEqual(['schedule:updated', 'schedule:updated', 'monitor:updated']);
    for (const x of (await s.api('GET', '/schedules')).filter((x: any) => r.turnOn.schedules.includes(x.id))) expect(x.enabled).toBe(true);
    expect((await s.api('GET', `/monitors/${r.turnOn.monitors[0]}`)).enabled).toBe(true);
    // an operator may not set bundles up or turn them on
    await expect(olivia('POST', '/template-bundles/40-git-repositories/turn-on', { schedules: r.turnOn.schedules })).rejects.toMatchObject({ status: 403 });

    const log = await s.api('GET', '/audit?entityType=template_bundle&limit=20');
    const entries = log as any[];
    expect(entries.map((e) => e.action)).toEqual(expect.arrayContaining(['template_bundle.setup', 'template_bundle.turned_on']));
    // the first setup (newest entries first): two processes, two schedules, the dashboard and the monitor, two dry runs
    expect(entries.filter((e) => e.action === 'template_bundle.setup').at(-1).summary).toBe(
      'Template bundle "Git repositories (health and members)" set up on "GitLab (demo)": 6 created, 0 updated, 0 kept, 0 failed, 2 dry run(s)',
    );
  });

  it('sets up a bundle whose processes read through applications (AWS) and maps monitor references by kind', async () => {
    await fresh(['aws-iam-key-age', 'aws-costs-per-application'], [], ['snowflake-account']);
    const r = await s.api('POST', '/template-bundles/50-aws/setup', { bindings: { aws: byName('AWS (demo)').id }, dryRuns: false });
    expect(r.items.filter((i: any) => i.action === 'failed')).toEqual([]);
    expect(r.items.filter((i: any) => i.type === 'process').map((i: any) => i.id)).toEqual(['aws-iam-key-age-2', 'aws-costs-per-application-2']);
    // the demo's dashboard is there already: skipped
    expect(r.items.find((i: any) => i.type === 'dashboard')).toMatchObject({ action: 'skipped', id: 'cloud-costs-and-keys' });
    const sch = (await s.api('GET', '/schedules')).filter((x: any) => r.turnOn.schedules.includes(x.id));
    expect(sch.map((x: any) => x.cron).sort()).toEqual(['0 7 3 * *', '40 6 * * *']);
    const sf = await s.api('POST', '/template-bundles/30-snowflake/setup', { bindings: { snowflake: byName('Snowflake (demo)').id }, dryRuns: false });
    const mon = sf.items.find((i: any) => i.type === 'monitor');
    expect(mon).toMatchObject({ action: 'created' });
    const def = (await s.api('GET', `/monitors/${mon.id}`)).definition;
    expect(def.checks.every((c: any) => c.platform === byName('Snowflake (demo)').id)).toBe(true);
  });
});

describe('template bundles and rights on what exists', () => {
  it('does not schedule an existing process the user may not run', async () => {
    for (const x of (await s.api('GET', '/schedules')).filter((x: any) => x.processId === 'prometheus-slo-report')) await s.api('DELETE', `/schedules/${x.id}`);
    await s.api('PUT', '/processes/prometheus-slo-report/access', { acl: [{ subject: 'user:dana', permissions: ['view'] }] });
    const r = await dana('POST', '/template-bundles/60-prometheus-slo/setup', { bindings: { prometheus: byName('Prometheus (demo)').id }, monitors: false });
    expect(r.items.filter((i: any) => i.type !== 'dashboard').map((i: any) => `${i.type}:${i.action}`)).toEqual([
      'process:skipped',
      'schedule:failed',
      'dryRun:failed',
    ]);
    expect(r.items.find((i: any) => i.type === 'schedule').message).toMatch(/may not run/);
    expect((await s.api('GET', '/schedules')).some((x: any) => x.processId === 'prometheus-slo-report')).toBe(false);
  });
});

describe('what next with a platform', () => {
  it('lists matching templates, bundles, monitor types and examples, access sources and the MCP hint', async () => {
    const g = await s.api('GET', `/platforms/${byName('Snowflake (demo)').id}/get-started`);
    expect(g.kind).toBe('snowflake');
    expect(g.templates.map((t: any) => t.id)).toEqual(['61-snowflake-project-access-review', '62-snowflake-account-hygiene']);
    expect(g.bundles.map((b: any) => b.id)).toEqual(['30-snowflake']);
    expect(g.monitorTypes).toEqual(['snowflake']);
    expect(g.monitorExamples.map((e: any) => e.file)).toEqual(['50-snowflake-account.yaml']);
    expect(g.accessSources).toEqual(['snowflake']);
    expect(g.mcp).toBe(false);
    const gh = await olivia('GET', `/platforms/${byName('GitHub (demo)').id}/get-started`);
    expect(gh.monitorTypes).toEqual(['git', 'platform']);
    expect(gh.accessSources).toEqual(['git']);
    expect(gh.bundles.map((b: any) => b.id)).toEqual(['40-git-repositories']);
    expect(gh.mcp).toBe(true);
    const aws = await s.api('GET', `/platforms/${byName('AWS (demo)').id}/get-started`);
    expect(aws.templates.map((t: any) => t.id)).toEqual(['63-aws-iam-key-age', '64-aws-costs-per-application']);
    // Entra ID (v0.5.0): the five templates, the bundle, the monitor check and the access source
    const entra = await s.api('GET', `/platforms/${byName('Microsoft Graph (demo)').id}/get-started`);
    expect(entra).toMatchObject({
      kind: 'microsoft-graph',
      bundles: [{ id: '15-entra-id-access-governance', name: 'Entra ID access governance' }],
      monitorTypes: ['entra', 'platform'],
      monitorExamples: [{ file: '58-entra-app-credentials.yaml', name: 'Entra ID app credentials' }],
      accessSources: ['entra'],
      mcp: true,
    });
    expect(entra.templates.map((t: any) => t.id)).toEqual([
      '21-entra-guest-review',
      '22-entra-privileged-role-review',
      '23-entra-stale-accounts',
      '24-entra-group-review',
      '25-entra-app-credentials',
    ]);
  });
});

describe('platform health', () => {
  it('shows the last connection test, turns a periodic test on and notifies the managers once when it starts failing', async () => {
    const p = await s.api('POST', '/platforms', {
      name: 'Health probe',
      kind: 'generic',
      baseUrl: `${s.base}/mock/confluent`,
      config: { auth: { type: 'basic' }, variables: {}, http: { proxy: 'none' }, testPath: '/iam/v2/users' },
      secrets: {},
    });
    expect((await s.api('GET', `/platforms/${p.id}/health`)).lastTest).toBeNull();
    const t = await s.api('POST', `/platforms/${p.id}/test`, {});
    expect(t.ok).toBe(false);
    const h0 = await s.api('GET', `/platforms/${p.id}/health`);
    expect(h0).toMatchObject({ lastTest: { ok: false, by: 'admin' }, periodic: { enabled: false, intervalMinutes: 60, nextAt: null }, failingSince: null });
    expect(h0.lastTest.message).toMatch(/HTTP 401/);
    // only managers turn it on; intervals from the list
    await expect(olivia('PUT', `/platforms/${p.id}/health`, { enabled: true, intervalMinutes: 15 })).rejects.toMatchObject({ status: 403 });
    await expect(s.api('PUT', `/platforms/${p.id}/health`, { enabled: true, intervalMinutes: 7 })).rejects.toMatchObject({ status: 400 });
    const h1 = await s.api('PUT', `/platforms/${p.id}/health`, { enabled: true, intervalMinutes: 15 });
    expect(h1.periodic).toMatchObject({ enabled: true, intervalMinutes: 15, updatedBy: 'admin' });

    const health = await import('../src/platforms/health.js');
    const notifications = await import('../src/notifications/service.js');
    const failing = async () =>
      (await s.api('GET', '/notifications?limit=100')).items.filter((n: any) => n.event === 'platform.failing' && n.link === `/platforms/${p.id}`);
    expect(await health.runPlatformHealthJob()).toBeGreaterThanOrEqual(1);
    await notifications.flushNotifications();
    const h2 = await s.api('GET', `/platforms/${p.id}/health`);
    expect(h2.failingSince).not.toBeNull();
    expect(h2.lastTest).toMatchObject({ ok: false, by: 'system' });
    expect(await failing()).toHaveLength(1);
    expect((await failing())[0].title).toBe('Platform connection failing: Health probe');
    // not due again yet; when due and still failing: no second message
    expect(await health.runPlatformHealthJob()).toBe(0);
    health.resetHealthClock();
    await health.runPlatformHealthJob();
    await notifications.flushNotifications();
    expect(await failing()).toHaveLength(1);
    // fixed: the next test passes and the failure ends
    const { DEMO_CONFLUENT } = await import('../src/mock/mockConfluent.js');
    await s.api('PUT', `/platforms/${p.id}/secrets`, { username: DEMO_CONFLUENT.cloudKey, password: DEMO_CONFLUENT.cloudSecret });
    health.resetHealthClock();
    await health.runPlatformHealthJob();
    const h3 = await s.api('GET', `/platforms/${p.id}/health`);
    expect(h3.failingSince).toBeNull();
    expect(h3.lastTest.ok).toBe(true);
    const list = await s.api('GET', '/platforms');
    expect(list.find((x: any) => x.id === p.id).lastTest.ok).toBe(true);
    const log = await s.api('GET', `/audit?entityId=${p.id}&limit=50`);
    expect((log as any[]).map((e) => e.action)).toContain('platform.health_changed');
  });
});
