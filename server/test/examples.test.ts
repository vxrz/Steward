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
      const decision = { approved: true, selectedKeys: t.items.filter((x: any) => x.preselected).map((x: any) => x.key), comment: 'automated test' };
      const client = t.canDecide ? s.api : adam;
      await client('POST', `/tasks/${t.id}/complete`, decision);
    }
    await sleep(100);
  }
  throw new Error(`run ${runId} did not finish`);
}

function hasWrites(def: ProcessDefinition): boolean {
  return def.nodes.some((n) => (n.type === 'http' && isMutating(n)) || (n.type === 'browser' && n.mutating));
}

const INPUTS: Record<string, Record<string, unknown>> = {
  'ih-offboard-users': { users: 'karla.lang@example.com\nnobody@example.com' },
  'generic-endpoint-check': { paths: '/api/identitymanagement/v3/Users' },
};

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
    expect(dashboards.map((d: any) => d.id)).toEqual(expect.arrayContaining(['platform-operations', 'access-governance', 'edge-fleet']));
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
    for (const c of proc.definition.connections) bindings[c.slot] = platformByKind[c.kind ?? (c.slot === 'portal' ? 'industrial-edge-management' : 'insights-hub')]!;
    const { id: runId } = await s.api('POST', '/runs', { processId: id, bindings, inputs: INPUTS[id] ?? {}, dryRun: hasWrites(proc.definition) });
    const r = await finish(runId);
    expect([r.status, r.error]).toEqual(['succeeded', null]);
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
