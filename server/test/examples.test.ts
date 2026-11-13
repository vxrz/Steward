import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import { dashboardDefinitionSchema, dashboardWidgetSchema, isMutating, validateProcess, type ProcessDefinition } from '@sm/shared';
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
const SLOT_KIND: Record<string, string> = { portal: 'industrial-edge-management', git: 'github', github: 'github' };

describe('example library', () => {
  it.each(processFiles)('process %s is valid', (f) => {
    const r = validateProcess(YAML.parse(fs.readFileSync(path.join(EXAMPLES, 'processes', f), 'utf8')));
    expect(r.issues).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it.each(dashboardFiles)('dashboard %s is valid', (f) => {
    const raw = YAML.parse(fs.readFileSync(path.join(EXAMPLES, 'dashboards', f), 'utf8'));
    const r = dashboardDefinitionSchema.safeParse(raw);
    expect(r.success).toBe(true);
    // unknown keys are dropped quietly; in a { … } line a comma in an unquoted title starts a new key
    const known = new Set(Object.keys(dashboardWidgetSchema.shape));
    expect(
      raw.widgets.flatMap((w: Record<string, unknown>) =>
        Object.keys(w)
          .filter((k) => !known.has(k))
          .map((k) => `${w.id}: ${k}`),
      ),
    ).toEqual([]);
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

  it('Gatus – Uptime overview (from /metrics) publishes what the Gatus metrics say', async () => {
    // runs after "runs 74-…" above: the mock Gatus' /metrics (server/src/mock/mockGatusMetrics.ts), no Gatus login
    const d = await s.api('GET', '/datasets/gatus-uptime-metrics');
    const by = Object.fromEntries(d.rows.map((r: any) => [r.Endpoint, r]));
    expect(Object.keys(by).sort()).toEqual(['Historian API', 'MES frontend', 'OPC UA gateway', 'Steward API']);
    expect(by['Historian API']).toMatchObject({ Group: 'plant', Healthy: 'no', _status: 'critical' });
    expect(by['Steward API']).toMatchObject({ Healthy: 'yes', 'Last response (ms)': 14, 'Certificate expires in (days)': 61, Type: 'HTTP' });
    expect(by['OPC UA gateway']).toMatchObject({ 'Certificate expires in (days)': '–', Type: 'TCP' });
    expect(typeof by['MES frontend']['Uptime (%)']).toBe('number');
  });

  it('Checkmk – Trend summary finds the level crossed and the series heading for CRIT', async () => {
    // runs after "runs 78-…" above, against the mock Checkmk (server/src/mock/mockCheckmk.ts): /var on db01 grows 0.8 % a day to 82 %
    const d = await s.api('GET', '/datasets/checkmk.trends');
    const by = Object.fromEntries(d.rows.map((r: any) => [r.series, r]));
    expect(Object.keys(by).sort()).toEqual(['db01 / CPU load', 'db01 / Filesystem /var', 'web01 / Memory']);
    const v = by['db01 / Filesystem /var'];
    expect(v).toMatchObject({ crossed: true, _status: 'warning', error: '' });
    // 82 % plus the mock's daily wave (at most ±0.52, depending on the time of day)
    expect(Math.abs(v.latest - 82)).toBeLessThanOrEqual(0.6);
    expect(v.daysToCrit).toBeGreaterThan(8);
    expect(v.daysToCrit).toBeLessThan(18);
    expect(v.weekChangePct).toBeGreaterThan(3);
    expect(by['web01 / Memory']).toMatchObject({ crossed: false, daysToCrit: null, _status: 'good' });
    expect(d.metrics).toMatchObject({ series: 3, crossed: 1, trending: 1 });
  });

  it('Kubernetes – Namespace health finds the deployment not fully ready, the crash-looping pod and the certificate ending soon', async () => {
    // runs after "runs 79-…" above, against the mock API server (server/src/mock/mockKubernetes.ts)
    const d = await s.api('GET', '/datasets/k8s.health');
    const by = Object.fromEntries(d.rows.map((r: any) => [r._key, r]));
    expect(by['shop-prod/deployment/worker']).toMatchObject({ Ready: '1/2', 'Pods not well': 'worker-5d4b-y2', _status: 'warning' });
    expect(by['shop-prod/deployment/web']).toMatchObject({ Ready: '3/3', _status: 'good' });
    expect(by['shop-prod/certificate/shop-tls']).toMatchObject({ Ready: 'ready', _status: 'warning' });
    expect(by['shop-prod/certificate/api-tls']._status).toBe('good');
    expect(d.metrics).toMatchObject({ deployments: 5, notReady: 1, unhealthyPods: 1, certsEnding: 1 });
  });

  it('Git – Repository health finds the failing default branch and the high alert', async () => {
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

  it('Dependency-Track – Vulnerabilities per project counts only open findings', async () => {
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

  it('Kafka – Topic standards finds the topics not to standard and the lagging consumer', async () => {
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

  describe('Industrial Edge examples against the simulated IEM (the Portal API shapes of IEM Pro)', () => {
    // server/src/mock/mockPlatform.ts: 10 devices – 7 reporting (dev-003 3 days, dev-007 45 days and dev-008 10 hours ago),
    // dev-005 PENDING, dev-009 ACTIVE without statistics (404), dev-010 DELETED; IED OS 1.9.0 … 2.4.0 in deviceVersion
    const iem = () => ({ iem: platformByKind['industrial-edge-management']! });
    const run = async (processId: string, more: Record<string, unknown> = {}) => {
      const { id } = await s.api('POST', '/runs', { processId, ...more, bindings: { ...iem(), ...(more.bindings as object) } });
      const r = await finish(id);
      expect([r.status, r.error]).toEqual(['succeeded', null]);
      expect(r.steps.filter((x: any) => x.status === 'failed' && x.type !== 'check').map((x: any) => `${x.key}: ${x.error}`)).toEqual([]);
      return r;
    };
    const calls = (r: any) => r.steps.filter((x: any) => x.type === 'http').map((x: any) => x.summary as string);
    const rowsBy = (d: any, col = 'Device') => Object.fromEntries(d.rows.map((x: any) => [x[col], x]));

    it('the mock answers like the Portal API: paged devices, details with deviceVersion, statistics with epoch-ms keys, app versions', async () => {
      const { DEMO_CREDENTIALS } = await import('../src/mock/mockPlatform.js');
      const base = `${s.base}/mock/iem/portal/api/v1`;
      const login = await fetch(`${base}/login/direct`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(DEMO_CREDENTIALS.iem),
      }).then((x) => x.json());
      const get = async (p: string) => {
        const res = await fetch(base + p, { headers: { authorization: `Bearer ${login.data.access_token}` } });
        return { status: res.status, body: await res.json() };
      };
      const first = await get('/devices');
      expect(first.body).toMatchObject({ pageNo: 1, pageSize: 5, totalPages: 2, totalCount: 10 }); // size 5 by default
      expect(first.body.data).toHaveLength(5);
      const last = await get('/devices?size=4&page=3');
      expect(last.body).toMatchObject({ pageNo: 3, pageSize: 4, totalPages: 3, totalCount: 10 });
      expect(last.body.data.map((d: any) => [d.deviceName, d.deviceStatus])).toEqual([
        ['edge-qa', 'ACTIVE'],
        ['edge-retired-cell', 'DELETED'],
      ]);
      // the list has neither an online state nor a version
      expect(Object.keys(first.body.data[0]).sort()).toEqual(
        ['createdDate', 'deviceId', 'deviceName', 'deviceStatus', 'modifiedDate', 'platformId', 'softwarePlatformName', 'swPlatformId', 'userId'].sort(),
      );
      expect((await get('/devices/dev-004')).body.data).toMatchObject({
        deviceName: 'edge-warehouse',
        deviceTypeId: 'core.ieipc',
        deviceVersion: 'ied-os-1.9.0-21-amd64',
      });
      expect((await get('/devices/dev-005')).body.data.deviceVersion).toBeUndefined(); // pending: no version yet
      const stats = (await get('/devices/dev-001/statistics')).body.data;
      const keys = Object.keys(stats).map(Number);
      expect(keys).toHaveLength(2);
      expect(Date.now() - Math.max(...keys)).toBeLessThan(3 * 60000);
      expect(JSON.parse(stats[String(Math.max(...keys))])).toMatchObject({
        DeviceId: 'dev-001',
        SystemInfo: { CpuPercentage: expect.any(String), Period: '60 minutes' },
      });
      expect((await get('/devices/dev-009/statistics')).status).toBe(404);
      expect((await get('/devices/dev-005/statistics')).body).toEqual({ data: {} });
      expect((await get('/applications')).body.data.every((a: any) => !('versionNumber' in a) && !('appVersions' in a))).toBe(true);
      expect((await get('/applications/app-3')).body).toMatchObject({
        id: 'app-3',
        title: 'OPC UA Connector',
        appVersions: expect.arrayContaining([{ versionId: 'ver-app-3-1.12.2', versionNumber: '1.12.2' }]),
      });
      expect((await get('/devices/installed-apps?deviceid=dev-002')).body.data.map((a: any) => a.versionNumber)).toEqual(['1.7.1', '2.1.0']);
    });

    it('Device status check: online from the newest statistics key, offline, unknown without statistics, pending not offline', async () => {
      const r = await run('iem-device-status');
      const c = calls(r);
      expect(c.filter((x: string) => x.includes('/statistics'))).toHaveLength(8); // ACTIVE devices only
      expect(c.filter((x: string) => /^GET \/portal\/api\/v1\/devices → /.test(x))).toEqual(['GET /portal/api/v1/devices → 10 item(s) in 1 page(s)']);
      expect(c).toHaveLength(9);
      const d = await s.api('GET', '/datasets/iem.device-status');
      const by = rowsBy(d);
      expect(Object.keys(by).sort()).not.toContain('edge-retired-cell'); // deleted
      expect(by['edge-line-1']).toMatchObject({ State: 'online', Onboarding: 'ACTIVE', 'Offline (h)': '–', _status: 'good' });
      expect(by['edge-line-1']['Last seen']).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
      expect(by['edge-test-bench']).toMatchObject({ State: 'offline', 'Offline (h)': 10, _status: 'critical', _statusText: 'offline for 10 h' });
      // reports once an hour (SystemInfo.Period "60 minutes"): a report 50 minutes old is online, also without grace
      expect(by['edge-press-hall']).toMatchObject({ State: 'online', 'Offline (h)': '–', _status: 'good' });
      expect(by['edge-qa']).toMatchObject({ State: 'unknown', 'Last seen': '–', _status: 'unknown', _statusText: 'no statistics reported' });
      expect(by['edge-lab']).toMatchObject({ State: 'not onboarded', Onboarding: 'PENDING', _status: 'unknown', _statusText: 'not onboarded yet (PENDING)' });
      expect(d.metrics).toMatchObject({ total: 9, online: 4, offline: 3, unknown: 1, pending: 1 });
      expect(r.steps.find((x: any) => x.stepId === 'allOnline').status).toBe('failed'); // three devices offline

      // a wider window: the device that stopped reporting 10 hours ago counts as online
      await run('iem-device-status', { inputs: { onlineWithinMinutes: 720 } });
      expect(rowsBy(await s.api('GET', '/datasets/iem.device-status'))['edge-test-bench']).toMatchObject({ State: 'online', _status: 'good' });
      await run('iem-device-status', { inputs: { onlineWithinMinutes: 0 } });
      expect(rowsBy(await s.api('GET', '/datasets/iem.device-status'))['edge-press-hall']).toMatchObject({ State: 'online' });
      await run('iem-device-status');
    });

    it('Inventory snapshot: online state, firmware from deviceVersion, onboarding; the catalogue with the newest appVersions entry', async () => {
      const r = await run('iem-inventory-snapshot');
      const c = calls(r);
      expect(c.filter((x: string) => /\/devices\/dev-\d+ → /.test(x))).toHaveLength(8); // details of the ACTIVE devices
      expect(c.filter((x: string) => x.includes('/statistics'))).toHaveLength(8);
      expect(c.filter((x: string) => /\/applications\/app-\d → /.test(x))).toHaveLength(4);
      expect(c).toHaveLength(1 + 16 + 1 + 4);
      const d = await s.api('GET', '/datasets/iem.devices');
      const by = rowsBy(d);
      expect(by['edge-line-1']).toMatchObject({
        State: 'online',
        Firmware: 'ied-os-2.4.0-12-amd64',
        Compliant: 'yes',
        'Device type': 'core.ieipc',
        _status: 'good',
      });
      expect(by['edge-warehouse']).toMatchObject({ State: 'online', Firmware: 'ied-os-1.9.0-21-amd64', Compliant: 'no', _status: 'warning' });
      expect(by['edge-warehouse']._statusText).toBe('firmware 1.9.0 below 2.3.0');
      expect(by['edge-test-bench']).toMatchObject({
        State: 'offline',
        Firmware: 'ied-os-2.4.0-12-amd64-develop',
        Compliant: 'yes',
        'Offline (h)': 10,
        _status: 'serious',
      });
      expect(by['edge-paint-shop']).toMatchObject({ State: 'offline', 'Offline (h)': 72, _status: 'critical' });
      expect(by['edge-old-line-7']._status).toBe('critical');
      expect(by['edge-qa']).toMatchObject({ State: 'unknown', Compliant: 'yes', _status: 'unknown', _statusText: 'no statistics reported' });
      expect(by['edge-lab']).toMatchObject({ State: 'not onboarded', Onboarding: 'PENDING', Firmware: '–', Compliant: 'unknown', _status: 'unknown' });
      expect(by['edge-retired-cell']).toBeUndefined();
      expect(d.metrics).toMatchObject({ total: 9, online: 4, offline: 3, unknown: 1, pending: 1, outdated: 4 });

      const apps = await s.api('GET', '/datasets/iem.apps');
      expect(Object.fromEntries(apps.rows.map((x: any) => [x.Application, x['Latest version']]))).toEqual({
        'Data Service': '1.8.0',
        'IE Databus': '2.1.0',
        'OPC UA Connector': '1.12.2', // not 1.9.0: compared as version numbers
        'Flow Creator': '1.17.0',
      });
      expect(apps.metrics).toMatchObject({ apps: 4 });
    });

    it('Inventory snapshot reads every page of the device list', async () => {
      // the same process with pages of 4: three pages, the same result
      const text = fs
        .readFileSync(path.join(EXAMPLES, 'processes', '51-iem-inventory-snapshot.yaml'), 'utf8')
        .replace('pageSize: 100', 'pageSize: 4')
        .replace(/^name: .*$/m, 'name: "Industrial Edge – Inventory snapshot in small pages"')
        .replace('dataset: iem.devices', 'dataset: iem.devices-paged')
        .replace('dataset: iem.apps', 'dataset: iem.apps-paged');
      const proc = await s.api('POST', '/processes', { text, id: 'iem-inventory-paged' });
      const r = await run(proc.id);
      expect(calls(r)[0]).toBe('GET /portal/api/v1/devices → 10 item(s) in 3 page(s)');
      const d = await s.api('GET', '/datasets/iem.devices-paged');
      expect(d.rowCount).toBe(9);
      expect(d.metrics).toMatchObject({ total: 9, online: 4, offline: 3, unknown: 1, pending: 1, outdated: 4 });
    });

    it('Firmware compliance: the version in deviceVersion against the minimum, the raw string shown, pending unknown', async () => {
      const r = await run('iem-firmware-compliance');
      expect(calls(r).filter((x: string) => /\/devices\/dev-\d+ → /.test(x))).toHaveLength(8);
      expect(calls(r).some((x: string) => x.includes('/statistics'))).toBe(false);
      const d = await s.api('GET', '/datasets/iem.firmware');
      const by = rowsBy(d);
      expect(by['edge-line-2']).toMatchObject({ Firmware: 'ied-os-2.4.0-12-amd64', Version: '2.4.0', Required: '2.3.0', _status: 'good' });
      expect(by['edge-qa']).toMatchObject({ Version: '2.3.0', _status: 'good' }); // equal is compliant
      expect(by['edge-press-hall']).toMatchObject({
        Firmware: 'ied-os-2.2.1-4-amd64',
        Version: '2.2.1',
        _status: 'warning',
        _statusText: 'update to 2.3.0 or later',
      });
      expect(by['edge-old-line-7']).toMatchObject({ Version: '1.9.4', _status: 'warning' });
      expect(by['edge-lab']).toMatchObject({ Firmware: '–', Version: '–', _status: 'unknown', _statusText: 'not onboarded yet' });
      expect(d.metrics).toMatchObject({ compliant: 4, outdated: 4, unknown: 1 });

      // a minimum with two parts and a higher patch level
      await run('iem-firmware-compliance', { inputs: { minFirmware: '2.4' } });
      expect((await s.api('GET', '/datasets/iem.firmware')).metrics).toMatchObject({ compliant: 3, outdated: 5 });
      await run('iem-firmware-compliance', { inputs: { minFirmware: '1.10.0' } });
      expect(rowsBy(await s.api('GET', '/datasets/iem.firmware'))['edge-warehouse']._status).toBe('warning'); // 1.9.0 < 1.10.0
      await run('iem-firmware-compliance'); // the default again, for the dataset checks below
    });

    it('Stale device cleanup offers only devices whose last report is old enough and deletes by deviceId', async () => {
      const c = await run('iem-stale-device-cleanup', { dryRun: true });
      expect(calls(c).filter((x: string) => x.includes('/statistics'))).toHaveLength(8);
      const pick = c.tasks.find((t: any) => t.stepKey === 'pick');
      expect(pick.items.map((x: any) => x.key)).toEqual(['dev-007']); // 45 days; not the pending device, not the one without statistics
      const deletes = c.steps.filter((x: any) => x.stepId === 'deleteDevice').map((x: any) => x.summary);
      expect(deletes).toEqual(['DRY RUN DELETE /portal/api/v1/devices/dev-007']);
      // two days: the paint shop (three days) as well
      const two = await run('iem-stale-device-cleanup', { dryRun: true, inputs: { offlineDays: 2 } });
      expect(two.tasks.find((t: any) => t.stepKey === 'pick').items.map((x: any) => x.key)).toEqual(['dev-007', 'dev-003']);
    });

    it('App version compliance reads installed-apps once, the versions of each installed app, and groups by device', async () => {
      const r = await run('iem-app-version-compliance');
      const http = calls(r);
      expect(http).toHaveLength(6); // devices, installed apps, 4 app details – no call per device
      expect(http.join('\n')).toContain('GET /portal/api/v1/devices/installed-apps → 200');
      expect(http.join('\n')).not.toMatch(/devices\/dev-/);
      expect(r.steps.find((x: any) => x.key === 'incomplete').status).toBe('skipped'); // the answer holds every entry

      const d = await s.api('GET', '/datasets/iem.app-compliance');
      const by = Object.fromEntries(d.rows.map((x: any) => [x._key, x]));
      expect(by['dev-001/app-1']).toMatchObject({ Device: 'edge-line-1', Application: 'Data Service', Installed: '1.8.0', Latest: '1.8.0', _status: 'good' });
      expect(by['dev-002/app-1']).toMatchObject({ Device: 'edge-line-2', Installed: '1.7.1', Latest: '1.8.0', _status: 'warning' });
      expect(by['dev-006/app-3']).toMatchObject({ Device: 'edge-press-hall', Installed: '1.10.0', Latest: '1.12.2', _status: 'warning' });
      expect(by['dev-001/app-3']).toMatchObject({ Installed: '1.12.2', Latest: '1.12.2', _status: 'good' });
      expect(by['dev-005/-']).toMatchObject({ Device: 'edge-lab', Application: '–', _status: 'unknown', _statusText: 'not onboarded yet' });
      expect(by['dev-007/-']).toMatchObject({ Device: 'edge-old-line-7', _status: 'unknown', _statusText: 'no installed apps reported' });
      expect(new Set(d.rows.map((x: any) => x.Device)).size).toBe(9); // without the deleted device
      expect(d.metrics).toMatchObject({ installations: 13, outdated: 4, unknownDevices: 2 });
    });

    it('Weekly service report counts the onboarded devices online from their statistics', async () => {
      const r = await run('weekly-service-report', { bindings: { hub: platformByKind['insights-hub'] } });
      expect(calls(r).filter((x: string) => x.includes('/statistics'))).toHaveLength(8);
      const d = await s.api('GET', '/datasets/platform.service-report');
      const row = d.rows.find((x: any) => x.Check === 'Devices online');
      expect(row).toMatchObject({ Value: '4 / 8 (1 without statistics)', _status: 'warning' });
      expect(d.metrics).toMatchObject({ iemDevices: 8, iemOffline: 3, iemOnline: 4 });
    });
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
    expect(byName['edge-lab']).toBe('unknown'); // pending: not onboarded yet, not offline
    expect(byName['edge-qa']).toBe('unknown'); // no statistics
    expect(devices.metrics).toMatchObject({ total: 9, offline: 3, outdated: 4, pending: 1, unknown: 1 });

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
