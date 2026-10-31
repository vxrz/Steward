import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dashboardDefinitionSchema, isMutating, validateProcess, type ProcessDefinition } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

const EXAMPLES = path.resolve(__dirname, '..', '..', 'examples');
const processFiles = fs.readdirSync(path.join(EXAMPLES, 'processes')).filter((f) => f.endsWith('.yaml'));
const dashboardFiles = fs.readdirSync(path.join(EXAMPLES, 'dashboards')).filter((f) => f.endsWith('.yaml'));

let s: TestServer;
let adam: Client;
let demo: any;
const platformByKind: Record<string, string> = {};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  demo = await s.api('POST', '/demo/setup', {});
  adam = await s.as('adam', demo.password);
  for (const p of await s.api('GET', '/platforms')) platformByKind[p.kind] = p.id;
  // the diagnosis runbook probes an URL below the "Web probe (demo)" platform
  INPUTS['gatus-diagnose-outage'] = { endpointUrl: `${s.base}/mock/gatus-apps/historian/health`, errors: '[STATUS] (503) == 200' };
});
afterAll(async () => {
  await s?.app.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Drive a run to its end: open tasks are decided (preselected items / approve), four-eyes tasks by Adam. */
async function finish(runId: string): Promise<any> {
  for (let i = 0; i < 600; i++) {
    const r = await s.api('GET', `/runs/${runId}`);
    if (['succeeded', 'failed', 'cancelled'].includes(r.status)) return r;
    for (const t of r.tasks.filter((x: any) => x.status === 'open')) {
      if (t.mode === 'manual') {
        await finishManual(t);
        continue;
      }
      const decision = { approved: true, selectedKeys: t.items.filter((x: any) => x.preselected).map((x: any) => x.key), comment: 'automated test' };
      const client = t.canDecide ? s.api : adam;
      await client('POST', `/tasks/${t.id}/complete`, decision);
    }
    await sleep(100);
  }
  throw new Error(`run ${runId} did not finish`);
}

/** Manual steps: everything ticked, sample values, missing evidence "not available"; verified by Adam (or the admin). */
async function finishManual(t: any): Promise<void> {
  const spec = t.manual.spec;
  if (t.manual.stage === 'verify') {
    const client = t.canDecide ? s.api : adam;
    await client('POST', `/tasks/${t.id}/verify`, { approved: true, comment: 'automated test' });
    return;
  }
  const sample: Record<string, string> = {
    text: 'SN-0001',
    number: '12',
    datetime: new Date().toISOString(),
    link: 'https://example.com/x',
    ticket: 'CHG0000001',
  };
  await (t.canDecide ? s.api : adam)('POST', `/tasks/${t.id}/complete`, {
    checked: spec.checklist.map((_: string, i: number) => i),
    fields: spec.fields.map((f: any) => ({ id: f.id, value: sample[f.type] })),
    notAvailable: spec.evidence === 'required' && !t.manual.evidence.length ? [{ target: 'evidence', reason: 'automated test' }] : [],
    comment: 'automated test',
  });
}

function hasWrites(def: ProcessDefinition): boolean {
  return def.nodes.some((n) => (n.type === 'http' && isMutating(n)) || (n.type === 'browser' && n.mutating));
}

const INPUTS: Record<string, Record<string, unknown>> = {
  'ih-offboard-users': { users: 'karla.lang@example.com\nnobody@example.com' },
  'generic-endpoint-check': { paths: '/api/identitymanagement/v3/Users' },
  'gatus-report-check': { path: '/api/identitymanagement/v3/Users' },
};
/** Slots without a kind are bound to the Insights Hub demo tenant, except these. */
const SLOT_KIND: Record<string, string> = { portal: 'industrial-edge-management' };

describe('example library', () => {
  it.each(processFiles)('process %s is valid', (f) => {
    const r = validateProcess(YAML.parse(fs.readFileSync(path.join(EXAMPLES, 'processes', f), 'utf8')));
    expect(r.issues).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it.each(dashboardFiles)('dashboard %s is valid', (f) => {
    const r = dashboardDefinitionSchema.safeParse(YAML.parse(fs.readFileSync(path.join(EXAMPLES, 'dashboards', f), 'utf8')));
    expect(r.success).toBe(true);
  });

  it('demo setup creates dashboards, schedules and runs the feeders', async () => {
    expect(demo.dashboards).toBe(dashboardFiles.length);
    expect(demo.schedules).toBeGreaterThanOrEqual(9);
    expect(demo.runs).toBeGreaterThanOrEqual(9);
    const dashboards = await s.api('GET', '/dashboards');
    expect(dashboards.map((d: any) => d.id)).toEqual(expect.arrayContaining(['platform-operations', 'access-governance', 'edge-fleet', 'uptime']));
    const schedules = await s.api('GET', '/schedules');
    expect(schedules.filter((x: any) => x.name.startsWith('Demo:') && x.enabled && x.owner === 'admin').length).toBeGreaterThanOrEqual(9);
    for (let i = 0; i < 300; i++) {
      const active = await s.api('GET', '/runs?status=running,waiting');
      if (active.length === 0) break;
      await sleep(100);
    }
    const runs = await s.api('GET', '/runs?limit=50');
    const failed = runs.filter((r: any) => r.status !== 'succeeded').map((r: any) => `${r.processName}: ${r.status} ${r.error ?? ''}`);
    expect(failed).toEqual([]);
  });

  it.each(processFiles)('runs %s against the demo platforms', async (f) => {
    const id = f.replace(/\.yaml$/, '').replace(/^\d+-/, '');
    const proc = await s.api('GET', `/processes/${id}`);
    const bindings: Record<string, string> = {};
    for (const c of proc.definition.connections) bindings[c.slot] = platformByKind[c.kind ?? SLOT_KIND[c.slot] ?? 'insights-hub']!;
    const { id: runId } = await s.api('POST', '/runs', { processId: id, bindings, inputs: INPUTS[id] ?? {}, dryRun: hasWrites(proc.definition) });
    const r = await finish(runId);
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    // the headline, value and items of its checks (#144) evaluate
    expect(JSON.stringify(r.logs ?? [])).not.toContain('could not be evaluated');
  });

  it('Gatus – uptime overview (from /metrics) publishes what the Gatus metrics say', async () => {
    // runs after "runs 74-…" above: the mock Gatus' /metrics (server/src/mock/mockGatusMetrics.ts), no Gatus login
    const d = await s.api('GET', '/datasets/gatus-uptime-metrics');
    const by = Object.fromEntries(d.rows.map((r: any) => [r.Endpoint, r]));
    expect(Object.keys(by).sort()).toEqual(['Historian API', 'MES frontend', 'OPC UA gateway', 'Steward API']);
    expect(by['Historian API']).toMatchObject({ Group: 'plant', Healthy: 'no', _status: 'critical' });
    expect(by['Steward API']).toMatchObject({ Healthy: 'yes', 'Last response (ms)': 14, 'Certificate expires in (days)': 61, Type: 'HTTP' });
    expect(by['OPC UA gateway']).toMatchObject({ 'Certificate expires in (days)': '–', Type: 'TCP' });
    expect(typeof by['MES frontend']['Uptime (%)']).toBe('number');
  });

  it('CheckMk – trend summary finds the level crossed and the series heading for CRIT', async () => {
    // runs after "runs 78-…" above, against the mock CheckMk (server/src/mock/mockCheckmk.ts): /var on db01 grows 0.8 % a day to 82 %
    const d = await s.api('GET', '/datasets/checkmk.trends');
    const by = Object.fromEntries(d.rows.map((r: any) => [r.series, r]));
    expect(Object.keys(by).sort()).toEqual(['db01 / CPU load', 'db01 / Filesystem /var', 'web01 / Memory']);
    const v = by['db01 / Filesystem /var'];
    expect(v).toMatchObject({ crossed: true, _status: 'warning', error: '' });
    expect(v.latest).toBeCloseTo(82, 0);
    expect(v.daysToCrit).toBeGreaterThan(8);
    expect(v.daysToCrit).toBeLessThan(18);
    expect(v.weekChangePct).toBeGreaterThan(3);
    expect(by['web01 / Memory']).toMatchObject({ crossed: false, daysToCrit: null, _status: 'good' });
    expect(d.metrics).toMatchObject({ series: 3, crossed: 1, trending: 1 });
  });

  it('Kubernetes – namespace health finds the deployment not fully ready, the crash-looping pod and the certificate ending soon', async () => {
    // runs after "runs 79-…" above, against the mock API server (server/src/mock/mockKubernetes.ts)
    const d = await s.api('GET', '/datasets/k8s.health');
    const by = Object.fromEntries(d.rows.map((r: any) => [r._key, r]));
    expect(by['shop-prod/deployment/worker']).toMatchObject({ Ready: '1/2', 'Pods not well': 'worker-5d4b-y2', _status: 'warning' });
    expect(by['shop-prod/deployment/web']).toMatchObject({ Ready: '3/3', _status: 'good' });
    expect(by['shop-prod/certificate/shop-tls']).toMatchObject({ Ready: 'ready', _status: 'warning' });
    expect(by['shop-prod/certificate/api-tls']._status).toBe('good');
    expect(d.metrics).toMatchObject({ deployments: 5, notReady: 1, unhealthyPods: 1, certsEnding: 1 });
  });

  it('GitHub – repository health finds the failing default branch and the high alert', async () => {
    // runs after "runs 82-…" above, against the mock GitHub (server/src/mock/mockGitPlatforms.ts)
    const d = await s.api('GET', '/datasets/git.repositories');
    const by = Object.fromEntries(d.rows.map((r: any) => [r._key, r]));
    expect(by['acme/shop-web']).toMatchObject({
      Pipeline: 'passed',
      'Latest release': 'v2.4.1',
      'Open alerts': '0 critical, 1 high, 2 other',
      _status: 'warning',
    });
    expect(by['acme/shop-api']).toMatchObject({ Pipeline: 'failed: CI', 'Latest release': '–', _status: 'critical' });
    expect(d.metrics).toMatchObject({ repositories: 2, failing: 1, critical: 0, high: 1 });
  });

  it('Dependency-Track – vulnerabilities per project counts only open findings', async () => {
    // runs after "runs 86-…" above, against the mock Dependency-Track (server/src/mock/mockDtrack.ts): the latest versions only
    const d = await s.api('GET', '/datasets/dt.vulnerabilities');
    const by = Object.fromEntries(d.rows.map((r: any) => [r.Project, r]));
    expect(Object.keys(by).sort()).toEqual(['crm-api@1.0.0', 'shop-web@2.5.0']);
    expect(by['shop-web@2.5.0']).toMatchObject({
      'Open findings': '0 critical, 0 high, 1 medium, 0 low',
      'Policy violations': '0 failing, 1 warnings',
      _status: 'good',
    });
    expect(d.metrics).toMatchObject({ projects: 2, critical: 0, high: 0, policyFail: 0 });
  });

  it('Kafka – topic standards finds the topics not to standard and the lagging consumer', async () => {
    // topic components read from the simulated cluster (server/src/mock/mockKafka.ts), then the process on that application
    const kafka = platformByKind.kafka!;
    const app = await s.api('POST', '/applications', { name: 'Shop events', owners: [] });
    for (const name of ['orders', 'payments', 'shop-events']) {
      const a = await s.api('POST', `/applications/${app.id}/components`, { type: 'kafka-topic', name, platformId: kafka });
      await s.api('POST', `/applications/${app.id}/components/${a.components.find((c: any) => c.name === name).id}/topic`, {});
    }
    const { id: runId } = await s.api('POST', '/runs', { processId: 'kafka-topic-standards', inputs: { apps: [app.id] } });
    expect((await finish(runId)).status).toBe('succeeded');
    const d = await s.api('GET', '/datasets/kafka.topics');
    const by = Object.fromEntries(d.rows.map((r: any) => [r.Topic, r]));
    expect(by.orders).toMatchObject({
      'Partitions × replicas': '3 × 3',
      Retention: '7 days',
      Schema: 'orders-value v2',
      'Most lag': 3323,
      'Not to standard': '–',
      _status: 'warning',
    });
    expect(by.payments).toMatchObject({ Schema: 'payments-value v1', 'Not to standard': '2 partitions (at least 3)', _status: 'warning' });
    expect(by['shop-events']).toMatchObject({ Retention: 'compacted', Schema: '–', _status: 'warning' });
    expect(by['shop-events']['Not to standard']).toBe(
      '1 partitions (at least 3); 1 replicas (at least 3); min.insync.replicas 1 (at least 2); no schema shop-events-value',
    );
    expect(d.metrics).toMatchObject({ topics: 3, violations: 2, lagging: 1, quiet: 0 });
  });

  it('published sensible datasets', async () => {
    const users = await s.api('GET', '/datasets/ih.users');
    expect(users.rowCount).toBe(15);
    expect(users.metrics.inactive90).toBeGreaterThan(0);
    expect(users.metrics.admins).toBe(4);
    expect(users.statusCounts.critical).toBeGreaterThan(0);

    const devices = await s.api('GET', '/datasets/iem.devices');
    const byName = Object.fromEntries(devices.rows.map((r: any) => [r.Device, r._status]));
    expect(byName['edge-line-1']).toBe('good');
    expect(byName['edge-warehouse']).toBe('warning'); // online, firmware 1.9.0
    expect(byName['edge-test-bench']).toBe('serious'); // offline for hours
    expect(byName['edge-old-line-7']).toBe('critical'); // offline for weeks
    expect(byName['edge-lab']).toBe('critical'); // inactive
    expect(devices.metrics).toMatchObject({ total: 9, offline: 4, outdated: 4 });

    const freshness = await s.api('GET', '/datasets/ih.data-freshness');
    expect(freshness.rows.find((r: any) => r.Asset === 'Pump P4')._status).toBe('critical');
    expect(freshness.metrics.noData).toBeGreaterThan(0);

    const privileged = await s.api('GET', '/datasets/ih.privileged');
    expect(privileged.rowCount).toBe(4);
    expect(privileged.statusCounts.critical).toBe(2);

    const apps = await s.api('GET', '/datasets/iem.app-compliance');
    expect(apps.metrics.outdated).toBeGreaterThan(0);
    expect(apps.statusCounts.unknown).toBeGreaterThan(0);

    const groups = await s.api('GET', '/datasets/ih.groups');
    expect(groups.metrics.empty).toBeGreaterThanOrEqual(1);
    expect(groups.metrics.onlyDefaultRole).toBeGreaterThanOrEqual(1);

    expect((await s.api('GET', '/datasets/ih.health')).statusCounts.good).toBe(2);
    expect((await s.api('GET', '/datasets/platform.service-report')).rowCount).toBe(5);
    expect((await s.api('GET', '/datasets/ih.attribute-optimization')).metrics.potentialSavings).toBeGreaterThan(0);
    expect((await s.api('GET', '/datasets/iem.firmware')).metrics.outdated).toBe(4);

    const uptime = await s.api('GET', '/datasets/gatus-uptime');
    // six monitored endpoints plus the external endpoint the demo monitors report to
    expect(uptime.rowCount).toBe(7);
    expect(uptime.metrics.endpoints).toBe(7);
    // the Historian API is down; the external endpoint's state depends on the demo monitors' timing
    expect(uptime.metrics.down).toBe(uptime.rows.filter((r: any) => r.Healthy === 'no').length);
    expect(uptime.metrics.down).toBeGreaterThanOrEqual(1);
    expect(uptime.metrics.avgUptime).toBeGreaterThan(90);
    const byEndpoint = Object.fromEntries(uptime.rows.map((r: any) => [r.Endpoint, r]));
    expect(byEndpoint['Historian API']).toMatchObject({ _status: 'critical', Healthy: 'no', Group: 'plant' });
    expect(byEndpoint['Historian API']['Last error']).toContain('[STATUS] (503) == 200');
    expect(byEndpoint['MES frontend']._status).toBe('warning'); // 95.83 % uptime (24h)
    expect(byEndpoint['OPC UA gateway']._status).toBe('warning'); // ~1450 ms average
    expect(byEndpoint['Steward API']).toMatchObject({ _status: 'good', 'Uptime (%)': 100 });
  });

  it('tenant usage: figures against the limits, attributes per asset type, a KPI of the usage service, checks that notify', async () => {
    const hub = { hub: platformByKind['insights-hub'] };
    const checks = (r: any) => Object.fromEntries(r.steps.filter((x: any) => x.type === 'check').map((x: any) => [x.stepId, x.status]));

    // without inputs (the run of all examples above): everything is counted, nothing is compared, no KPI is read
    const counted = await s.api('GET', '/datasets/ih.usage');
    expect(counted.rows.map((r: any) => r._key).sort()).toEqual(['agents', 'assets', 'attributes', 'users']);
    expect(counted.rows.every((r: any) => r._status === 'good' && r.Limit === '–')).toBe(true);
    expect(counted.metrics).toMatchObject({ critical: 0, warning: 0, unread: 0, maxPercent: 0 });

    // the licence of the simulated tenant (as in the demo schedule) and a KPI of the simulated usage service:
    // breaches fail the checks (check.failed notifications), the run itself succeeds
    const inputs = {
      userLimit: 25,
      assetLimit: 15,
      agentLimit: 10,
      attributeLimit: 500,
      utsProvider: 'demoprovider',
      utsApplication: 'steward-demo',
      utsKpi: 'monthly-credits',
      utsKpiLimit: 10000,
    };
    const run = await finish((await s.api('POST', '/runs', { processId: 'ih-tenant-usage', bindings: hub, inputs })).id);
    expect(run.status).toBe('succeeded');
    expect(checks(run)).toMatchObject({ readCheck: 'succeeded', criticalCheck: 'failed', warningCheck: 'failed' });
    const usage = await s.api('GET', '/datasets/ih.usage');
    const byKey = Object.fromEntries(usage.rows.map((r: any) => [r._key, r]));
    expect(Object.keys(byKey).sort()).toEqual(['agents', 'assets', 'attributes', 'kpi', 'users']);
    expect(byKey.users).toMatchObject({ _status: 'good', Used: 15, Limit: 25, 'Used (%)': 60 }); // 15 of 25 licensed users
    expect(byKey.assets).toMatchObject({ _status: 'warning', Used: 12, 'Used (%)': 80 }); // 80 % = warning level
    expect(byKey.agents._status).toBe('warning'); // 9 of 10
    expect(byKey.attributes).toMatchObject({ _status: 'good', Limit: 500, Source: 'Asset Management' });
    expect(byKey.kpi).toMatchObject({ _status: 'critical', Limit: 10000, Source: 'Usage Transparency' }); // ≥ 95 % of the credits
    expect(byKey.kpi.Figure).toMatch(/^Monthly credits \(\w+\)$/);
    expect(usage.metrics).toMatchObject({ usersPercent: 60, assetsPercent: 80, critical: 1, warning: 2, unread: 0 });
    expect(usage.metrics.maxPercent).toBeGreaterThanOrEqual(95);
    // attributes per asset type add up to the figure
    const attrs = await s.api('GET', '/datasets/ih.usage-attributes');
    expect(attrs.rows.length).toBeGreaterThan(0);
    expect(attrs.metrics.attributes).toBe(byKey.attributes.Used);
    expect(attrs.rows.reduce((n: number, r: any) => n + r.Attributes, 0)).toBe(byKey.attributes.Used);
    // the dashboard reads only metrics the datasets have
    const dash = await s.api('GET', '/dashboards/tenant-usage');
    const metricsOf: Record<string, string[]> = { 'ih.usage': Object.keys(usage.metrics), 'ih.usage-attributes': Object.keys(attrs.metrics) };
    for (const w of dash.definition.widgets.filter((x: any) => x.dataset)) {
      expect(Object.keys(metricsOf), w.id).toContain(w.dataset);
      for (const m of [w.metric, ...(w.metrics ?? [])].filter(Boolean)) expect(metricsOf[w.dataset], `${w.id}: ${m}`).toContain(m);
    }
    // a KPI the usage service does not know: the figure is unknown, the platform's answer stays in the run
    const wrong = await finish(
      (await s.api('POST', '/runs', { processId: 'ih-tenant-usage', bindings: hub, inputs: { ...inputs, utsKpi: 'no-such-kpi' } })).id,
    );
    expect(wrong.status).toBe('succeeded');
    expect(checks(wrong)).toMatchObject({ readCheck: 'failed' });
    const step = wrong.steps.find((x: any) => x.stepId === 'kpi');
    expect(step.status).toBe('failed');
    expect(step.error).toContain('HTTP 404');
    expect(step.error).toContain("No KPI 'no-such-kpi'");
    const unknown = (await s.api('GET', '/datasets/ih.usage')).rows.find((r: any) => r._key === 'kpi');
    expect(unknown).toMatchObject({ _status: 'unknown', Used: '–' });
    expect(unknown._statusText).toContain('Usage Transparency KPI of the month');

    // configurable thresholds: with 99 % / 100 % nothing is critical any more
    const relaxed = await finish(
      (
        await s.api('POST', '/runs', {
          processId: 'ih-tenant-usage',
          bindings: hub,
          inputs: { ...inputs, warnPercent: 99, criticalPercent: 100, utsKpiLimit: 20000 },
        })
      ).id,
    );
    expect(relaxed.status).toBe('succeeded');
    const after = await s.api('GET', '/datasets/ih.usage');
    expect(after.metrics.critical).toBe(0);
    expect(after.rows.find((r: any) => r._key === 'kpi').Limit).toBe(20000);
  });

  it('privileged access review removes stale admins after a second person confirms', async () => {
    const { id: runId } = await s.api('POST', '/runs', { processId: 'ih-privileged-access-review', bindings: { hub: platformByKind['insights-hub'] } });
    const r = await finish(runId);
    expect(r.status).toBe('succeeded');
    const confirm = r.tasks.find((t: any) => t.mode === 'approve');
    expect(confirm.decidedBy).toBe('adam');
    expect(r.stats.writes).toBe(2);
    const hub = platformByKind['insights-hub'];
    const group = await s.api('POST', `/platforms/${hub}/request`, {
      method: 'GET',
      path: '/api/identitymanagement/v3/Groups',
      query: { filter: 'displayName eq "mdsp:core:TenantAdmin"' },
    });
    const members = await s.api('POST', `/platforms/${hub}/request`, {
      method: 'GET',
      path: `/api/identitymanagement/v3/Groups/${group.body.resources[0].id}/members`,
    });
    expect(members.body).toHaveLength(2); // the two recently active admins stay
    const ds = await s.api('GET', '/datasets/ih.privileged');
    expect(ds.rows.filter((x: any) => x.Review === 'removed')).toHaveLength(2);
    expect(ds.rows.filter((x: any) => x.Review === 'kept')).toHaveLength(2);
  });
});
