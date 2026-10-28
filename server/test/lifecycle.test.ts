import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * End of life of the tech stack (#104): release cycles read from endoflife.date (the demo's mock) through a platform
 * of kind endoflife-date, versions matched to cycles, the state on every stack entry, the settings, messages to the
 * application owners (once per product and cycle), the optional scorecard part, and the input type applications.
 *
 * The mock dates are relative to today: the newest cycle of a product is supported, the second ends in 45 days, older
 * ones are past their end of life (Node.js: 26 supported, 25 ending, 24 and older past).
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
let dana: Client, olivia: Client, vera: Client;
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const code = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { body: unknown }) => ((typeof e.body === 'string' ? JSON.parse(e.body) : e.body) as { code?: string }).code,
  );

let app: any;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, vera] = await Promise.all(['dana', 'olivia', 'vera'].map((u) => s.as(u, PW)));
  app = await dana('POST', '/applications', { name: 'Orders (eol)', owners: ['user:olivia'] });
  await olivia('POST', `/applications/${app.id}/components`, {
    type: 'container-image',
    name: 'ghcr.io/acme/orders',
    stack: [
      { product: 'nodejs', version: '24.11.0' },
      { product: 'python', version: '3.14.1' },
      { product: 'postgresql', version: '' },
    ],
  });
  await olivia('POST', `/applications/${app.id}/components`, {
    type: 'container-image',
    name: 'ghcr.io/acme/worker',
    stack: [{ product: 'nodejs', version: 'v26.1.0' }],
  });
});
afterAll(async () => {
  await s?.app.close();
});

describe('matching versions to release cycles', () => {
  it('takes the longest cycle the version starts with', async () => {
    const { cycleFor } = await import('../src/catalogue/lifecycle.js');
    expect(cycleFor('24.11.0', ['26', '25', '24', '2'])).toBe('24');
    expect(cycleFor('3.20.3', ['3.21', '3.20', '3.2', '3'])).toBe('3.20');
    expect(cycleFor('3.2.1', ['3.20', '3.2'])).toBe('3.2');
    expect(cycleFor('v26.1.0', ['26'])).toBe('26');
    expect(cycleFor('2.4.62-alpine', ['2.4'])).toBe('2.4');
    expect(cycleFor('24', ['24'])).toBe('24');
    expect(cycleFor('', ['24'])).toBeNull();
    expect(cycleFor('241.0', ['24'])).toBeNull();
  });
});

describe('end of life', () => {
  it('has no data before the first refresh; the demo platform is used', async () => {
    const st = await dana('GET', '/catalogue/lifecycle');
    expect(st).toMatchObject({ platform: { name: 'endoflife.date (demo)' }, products: 3, withData: 0, canEdit: false, canRefresh: true });
    expect((await dana('GET', `/applications/${app.id}`)).components[0].stack[0].lifecycle).toBeNull();
  });

  it('refreshes from endoflife.date and shows the state of every stack entry', async () => {
    expect(await status(vera('POST', '/catalogue/lifecycle/refresh'))).toBe(403);
    const st = await dana('POST', '/catalogue/lifecycle/refresh');
    expect(st).toMatchObject({ products: 3, withData: 3, errors: [] });
    expect(st.refreshedAt).toBeTruthy();
    const a = await vera('GET', `/applications/${app.id}`);
    const image = a.components.find((c: any) => c.name === 'ghcr.io/acme/orders');
    const by = Object.fromEntries(image.stack.map((x: any) => [x.product, x.lifecycle]));
    expect(by.nodejs).toMatchObject({ state: 'eol', cycle: '24' });
    expect(by.nodejs.daysLeft).toBeLessThan(0);
    expect(by.python).toMatchObject({ state: 'ending', cycle: '3.14' });
    expect(by.python.daysLeft).toBeGreaterThan(40);
    expect(by.python.daysLeft).toBeLessThanOrEqual(45);
    // no version: no cycle
    expect(by.postgresql).toMatchObject({ state: 'unknown', cycle: null });
    const worker = a.components.find((c: any) => c.name === 'ghcr.io/acme/worker');
    expect(worker.stack[0].lifecycle).toMatchObject({ state: 'supported', cycle: '26', isLts: true, latest: '26.4' });
    // the rollup carries it too
    expect(a.stack.find((x: any) => x.product === 'nodejs' && x.version === '24.11.0').lifecycle.state).toBe('eol');
    const audit = await s.api('GET', '/audit?action=catalogue.lifecycle_refreshed&limit=5');
    expect(audit[0]).toMatchObject({ actor: 'dana' });
  });

  it('settings: administrators only, a platform of the right kind, the warning period', async () => {
    const before = await s.api('GET', '/catalogue/lifecycle');
    const body = { platformId: null, warnDays: 30, notify: true, scorecard: false };
    expect(await status(dana('PUT', '/catalogue/lifecycle', body))).toBe(403);
    const gatus = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'gatus');
    expect(await code(s.api('PUT', '/catalogue/lifecycle', { ...body, platformId: gatus.id }))).toBe('LIFECYCLE_PLATFORM_KIND');
    expect(await status(s.api('PUT', '/catalogue/lifecycle', { ...body, warnDays: 0 }))).toBe(400);
    await s.api('PUT', '/catalogue/lifecycle', body);
    // 30 days: Python 3.14 (45 days left) is no longer "ending"
    const a = await dana('GET', `/applications/${app.id}`);
    expect(a.components[0].stack.find((x: any) => x.product === 'python').lifecycle.state).toBe('supported');
    await s.api('PUT', '/catalogue/lifecycle', { ...before.settings });
  });

  it('messages the application owners once per product and cycle', async () => {
    const { checkLifecycleNotices } = await import('../src/catalogue/lifecycle.js');
    const { flushNotifications } = await import('../src/notifications/service.js');
    expect(await checkLifecycleNotices()).toBe(2);
    expect(await checkLifecycleNotices()).toBe(0);
    await new Promise((r) => setImmediate(r));
    await flushNotifications();
    const inbox = (await olivia('GET', '/notifications?limit=100')).items.filter((n: any) => n.event === 'stack.eol');
    expect(inbox.map((n: any) => n.title).sort()).toEqual(['End of life reached: Node.js 24 in Orders (eol)', 'End of life soon: Python 3.14 in Orders (eol)']);
    expect(inbox.find((n: any) => n.title.startsWith('End of life reached')).body).toContain('ghcr.io/acme/orders');
    const audit = await s.api('GET', `/audit?entityType=application&entityId=${app.id}&limit=20`);
    expect(audit.filter((e: any) => e.action === 'application.eol_notice_sent')).toHaveLength(2);
  });

  it('counts on the scorecard only when turned on', async () => {
    const svc = await dana('POST', '/services', { name: 'Orders service (eol)', owners: [] });
    await dana('PUT', `/services/${svc.id}/applications/${app.id}`, { role: 'primary' });
    const card = async () => (await dana('GET', '/scorecard')).services.find((x: any) => x.serviceId === svc.id);
    expect((await card()).lifecycle).toEqual({ status: 'none', enabled: false, entries: 0, eol: 0, ending: 0, items: [] });
    const st = await s.api('GET', '/catalogue/lifecycle');
    await s.api('PUT', '/catalogue/lifecycle', { ...st.settings, scorecard: true });
    const c = await card();
    expect(c.lifecycle).toMatchObject({ status: 'attention', enabled: true, entries: 4, eol: 1, ending: 1 });
    expect(c.lifecycle.items[0]).toMatchObject({ state: 'eol', label: 'Node.js', version: '24.11.0', cycle: '24', componentName: 'ghcr.io/acme/orders' });
    expect(c.attention).toBe(true);
    // the daily snapshot stores the part
    const { snapshotScorecards } = await import('../src/scorecard/jobs.js');
    snapshotScorecards(Date.now(), true);
    const detail = await dana('GET', `/scorecard/services/${svc.id}`);
    expect(detail.history.at(-1).parts.lifecycle).toBe('attention');
    await s.api('PUT', '/catalogue/lifecycle', { ...st.settings, scorecard: false });
  });

  it('gives processes several applications – all when the input is empty', async () => {
    const p = await s.api('POST', '/processes', {
      definition: {
        name: 'End-of-life overview (test)',
        connections: [],
        inputs: [{ name: 'apps', type: 'applications' }],
        outputs: {
          names: 'inputs.apps.name',
          eol: "$count(inputs.apps.components.stack[lifecycle.state = 'eol'])",
        },
        steps: [{ id: 'show', type: 'log', message: '{{ $count(inputs.apps) }}' }],
      },
    });
    const run = async (inputs: Record<string, unknown>) => {
      const { id } = await s.api('POST', '/runs', { processId: p.id, bindings: {}, inputs });
      return s.waitRun(id, ['succeeded', 'failed']);
    };
    let r = await run({ apps: ['Orders (eol)'] });
    expect(r.outputs).toEqual({ names: 'Orders (eol)', eol: 1 });
    r = await run({});
    expect(r.status).toBe('succeeded');
    expect(r.inputs.apps.map((a: any) => a.name)).toContain('Orders (eol)');
    expect(r.inputs.apps.length).toBe((await s.api('GET', '/applications')).length);
  });

  it('the example "End of life – tech stack overview" publishes one row per application, component and product', async () => {
    const definition = YAML.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'examples', 'processes', '77-end-of-life-overview.yaml'), 'utf8'));
    const p = await s.api('POST', '/processes', { definition });
    const { id } = await s.api('POST', '/runs', { processId: p.id, bindings: {}, inputs: { apps: ['Orders (eol)'] } });
    const r = await s.waitRun(id, ['succeeded', 'failed']);
    expect(r.status).toBe('succeeded');
    const check = r.steps.find((x: any) => x.key === 'noEol');
    expect(check.summary).toBe('✘ Orders (eol): Node.js 24 (ghcr.io/acme/orders)');
    const ds = await s.api('GET', '/datasets/eol-overview');
    expect(ds.metrics).toMatchObject({ entries: 4, eol: 1, ending: 1, noData: 1 });
    // one row per application, component and product, by its key; the columns as published
    expect(ds.rows.map((x: any) => x._key).sort()).toEqual([
      'Orders (eol) / ghcr.io/acme/orders / nodejs',
      'Orders (eol) / ghcr.io/acme/orders / postgresql',
      'Orders (eol) / ghcr.io/acme/orders / python',
      'Orders (eol) / ghcr.io/acme/worker / nodejs',
    ]);
    const nodeRow = ds.rows.find((x: any) => x._key === 'Orders (eol) / ghcr.io/acme/orders / nodejs');
    expect(nodeRow).toMatchObject({ _status: 'critical', Product: 'Node.js', Version: '24.11.0', Cycle: '24' });
    expect(nodeRow._statusText).toMatch(/^end of life since \d{4}-\d{2}-\d{2}$/);
    expect(ds.rows.map((x: any) => x._status).sort()).toEqual(['critical', 'good', 'unknown', 'warning']);
  });

  it('refuses a refresh without an endoflife.date platform', async () => {
    const st = await s.api('GET', '/catalogue/lifecycle');
    await s.api('DELETE', `/platforms/${st.platform.id}`);
    expect(await code(dana('POST', '/catalogue/lifecycle/refresh'))).toBe('LIFECYCLE_NO_PLATFORM');
    // the cached data stays
    expect((await dana('GET', `/applications/${app.id}`)).components[0].stack[0].lifecycle.state).toBe('eol');
  });
});
