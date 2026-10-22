import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

let s: TestServer;
let hub: string;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  hub = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'insights-hub').id;
});
afterAll(async () => {
  await s?.app.close();
});

const flow = {
  name: 'Publish users',
  connections: [{ slot: 'hub' }],
  nodes: [
    { id: 'start', type: 'start', x: 0, y: 0 },
    { id: 'users', type: 'http', connection: 'hub', method: 'GET', path: '/api/identitymanagement/v3/Users', paginate: { mode: 'scim' }, saveAs: 'users', x: 1, y: 0 },
    {
      id: 'pub',
      type: 'publish',
      dataset: 'test.users',
      title: 'Users',
      rows: 'vars.users.body',
      columns: [
        { label: 'User', value: 'userName' },
        { label: 'Groups', value: '$count(groups)' },
      ],
      key: 'id',
      status: "$exists(lastLogonTime) and $daysSince(lastLogonTime) < 90 ? 'good' : ($exists(lastLogonTime) ? 'warning' : 'critical')",
      statusText: "$exists(lastLogonTime) ? $daysSince(lastLogonTime) & ' days' : 'never signed in'",
      metrics: { total: '$count(vars.users.body)', inactive: "$count(vars.users.body[$not($exists(lastLogonTime)) or $daysSince(lastLogonTime) >= 90])" },
      staleAfterMinutes: 60,
      x: 2,
      y: 0,
    },
  ],
  wires: [
    { from: 'start', port: 'out', to: 'users' },
    { from: 'users', port: 'out', to: 'pub' },
  ],
};

describe('datasets & dashboards', () => {
  let processId: string;
  it('publishes a snapshot with statuses and metrics', async () => {
    processId = (await s.api('POST', '/processes', { definition: flow })).id;
    for (let i = 0; i < 2; i++) {
      const { id } = await s.api('POST', '/runs', { processId, bindings: { hub } });
      expect((await s.waitRun(id, ['succeeded', 'failed'])).status).toBe('succeeded');
    }
    const d = await s.api('GET', '/datasets/test.users');
    expect(d.columns).toEqual(['User', 'Groups']);
    expect(d.rowCount).toBe(15);
    expect(d.rows[0]).toHaveProperty('_status');
    expect(d.statusCounts.good + d.statusCounts.warning + d.statusCounts.critical).toBe(15);
    expect(d.metrics.total).toBe(15);
    expect(d.stale).toBe(false);
    const series = await s.api('GET', '/datasets/test.users/metrics?names=total,inactive&days=7');
    expect(series.find((x: any) => x.name === 'total').points).toHaveLength(2);
  });

  it('answers unchanged data with 304', async () => {
    const res1 = await s.app.inject({ method: 'GET', url: '/api/datasets/test.users', headers: { cookie: await cookieOf() } });
    const etag = res1.headers.etag as string;
    const res2 = await s.app.inject({ method: 'GET', url: '/api/datasets/test.users', headers: { cookie: await cookieOf(), 'if-none-match': etag } });
    expect(res2.statusCode).toBe(304);
  });

  it('hides datasets of processes the user may not view', async () => {
    const vera = await s.as('vera', 'Demo-password-1');
    expect((await vera('GET', '/datasets')).map((d: any) => d.key)).toContain('test.users');
    await s.api('PUT', `/processes/${processId}/access`, { acl: [{ subject: 'role:operator', permissions: ['view', 'run'] }] });
    expect((await vera('GET', '/datasets')).map((d: any) => d.key)).not.toContain('test.users');
    await expect(vera('GET', '/datasets/test.users')).rejects.toThrow(/404/);
    await s.api('PUT', `/processes/${processId}/access`, { acl: [] });
  });

  let dashId: string;
  it('creates, exports and re-imports dashboards; refresh re-runs feeders', async () => {
    const yaml = `name: Test board\nwidgets:\n  - { id: k1, type: kpi, dataset: test.users, metric: total, width: 3 }\n  - { id: t1, type: table, dataset: test.users, problemsOnly: true }\n`;
    const d = await s.api('POST', '/dashboards', { text: yaml });
    dashId = d.id;
    expect(d.definition.widgets).toHaveLength(2);
    const exported = await s.api('GET', `/dashboards/${d.id}/export`);
    expect(exported).toContain('Test board');
    const r = await s.api('POST', `/dashboards/${d.id}/refresh`, {});
    expect(r.started.map((x: any) => x.processId)).toEqual([processId]);
    await s.waitRun(r.started[0].runId, ['succeeded', 'failed']);
    await expect(s.api('POST', '/dashboards', { text: 'name: x\nwidgets:\n  - { id: a, type: nope }' })).rejects.toThrow(/400/);
  });

  it('exports and imports bundles', async () => {
    const bundle = await s.api('GET', `/bundle/export?processes=${processId}&dashboards=${dashId}`);
    expect(bundle.processes).toHaveLength(1);
    expect(bundle.dashboards).toHaveLength(1);
    const again = await s.api('POST', '/bundle/import', { bundle, onConflict: 'newVersion' });
    expect(again.updated).toEqual(expect.arrayContaining([processId, dashId]));
    const copy = await s.api('POST', '/bundle/import', { bundle, onConflict: 'copy' });
    expect(copy.created).toHaveLength(2);
  });
});

async function cookieOf(): Promise<string> {
  const res = await fetch(`${s.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sm-client': '1' },
    body: JSON.stringify({ username: 'admin', password: 'Admin-password-1' }),
  });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}
