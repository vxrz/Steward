import { beforeAll, describe, expect, it } from 'vitest';
import { quiesce, setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Statements per request of the pages that are opened most and polled (security review 0.19.0 H2): the start page
 * (/api/dashboard), the scorecard, the costs overview and the monitor list read their items in bulk – the number of
 * statements does not grow with the number of services, processes, schedules, platforms or monitors. On PostgreSQL every
 * statement is a round trip that blocks the event loop, so a statement per item made these pages slow for everyone.
 * The pattern of the cost plan test (cost-plans.test.ts): the same count before and after adding many items.
 * The lists of the public API that filter by the processes a reader may view (runs, tasks, datasets; MCP shares the
 * same code, processes/service.ts visibleProcessIds) are counted the same way: they read a process's rights once each.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client;
const counted = new Map<string, number>();

const PAGES = [
  '/dashboard',
  '/scorecard',
  '/costs?scope=service',
  '/costs?scope=application',
  '/monitors',
  '/platforms',
  '/processes',
  '/schedules',
  // review 0.20.0: objectives with a source monitor each, the credentials register, users and teams
  '/objectives',
  '/credentials',
];
/** Administrators' pages: users and teams (the access pickers, the user list) */
const ADMIN_PAGES = ['/users', '/teams'];
/** Lists of the public API (/api/v1), read with an API token of each user. */
const V1_PAGES = ['/runs', '/tasks', '/datasets'];
const tokens: Record<string, string> = {};

beforeAll(async () => {
  s = await startTestServer({
    // the request's statement count (http-observability.ts), kept by URL for this test
    routes: (app) =>
      app.addHook('onSend', async (req, _reply, payload) => {
        const { requestDbTotals } = await import('../src/http-observability.js');
        counted.set(req.url, requestDbTotals(req)?.statements ?? -1);
        return payload;
      }),
  });
  await setup(s);
  await s.api('POST', '/demo/setup', { services: true });
  dana = await s.as('dana', PW);
  tokens.admin = (await s.api('POST', '/me/tokens', { name: 'Invented admin token', scope: 'read' })).token;
  tokens.dana = (await dana('POST', '/me/tokens', { name: 'Invented dana token', scope: 'read' })).token;
}, 180_000);

/** Statements of one GET as the signed-in user of `c` (the second call: caches of the first are warm). */
async function statements(c: Client, url: string): Promise<number> {
  await c('GET', url);
  counted.delete(`/api${url}`);
  await c('GET', url);
  return counted.get(`/api${url}`) ?? -1;
}

/** Statements of one GET of the public API with `token` (the second call, as above). */
async function v1Statements(token: string, url: string): Promise<number> {
  const get = async () => {
    const res = await fetch(`${s.base}/api/v1${url}`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status, url).toBe(200);
    await res.arrayBuffer();
  };
  await get();
  counted.delete(`/api/v1${url}`);
  await get();
  return counted.get(`/api/v1${url}`) ?? -1;
}

/**
 * Counts every page once the server is quiet. The demo's feeder schedules fire every 10 or 15 minutes: a fire between
 * the two counts gives the datasets it publishes a schedule to read (seen in CI: v1/datasets +6) – changed data, not a
 * read per process. So the cron jobs stop first (grow() arms its new schedules again) and the runs they started end.
 */
async function countAll(): Promise<Record<string, number>> {
  await quiesce();
  const out: Record<string, number> = {};
  for (const [who, c] of [
    ['admin', s.api],
    ['dana', dana],
  ] as const) {
    for (const url of PAGES) out[`${who} ${url}`] = await statements(c, url);
    for (const url of V1_PAGES) out[`${who} v1${url}`] = await v1Statements(tokens[who]!, url);
  }
  for (const url of ADMIN_PAGES) out[`admin ${url}`] = await statements(s.api, url);
  return out;
}

/**
 * Adds `n` services, processes with an enabled schedule each, monitors with an availability objective each (the
 * monitor as its source), credentials, users and teams.
 */
async function grow(n: number, tag: string): Promise<void> {
  const [sch] = (await s.api('GET', '/schedules')) as { processId: string; inputs: unknown; bindings: unknown }[];
  const proc = await s.api('GET', `/processes/${sch!.processId}`);
  const [plat] = (await s.api('GET', '/platforms')) as { id: string }[];
  for (let i = 0; i < n; i++) {
    await s.api('POST', '/services', { name: `Invented service ${tag} ${i}` });
    const p = await s.api('POST', '/processes', { definition: { ...proc.definition, name: `Invented process ${tag} ${i}` } });
    await s.api('POST', '/schedules', {
      name: `Invented schedule ${tag} ${i}`,
      processId: p.id,
      cron: '0 3 1 1 *',
      inputs: sch!.inputs,
      bindings: sch!.bindings,
      enabled: true,
    });
    const svc = await s.api('POST', '/services', { name: `Invented objective service ${tag} ${i}` });
    const m = await s.api('POST', '/monitors', {
      definition: { name: `Invented monitor ${tag} ${i}`, checks: [{ id: 'hb', name: 'Heartbeat', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600 }] },
    });
    await s.api('POST', '/objectives', {
      serviceId: svc.id,
      name: `Invented objective ${tag} ${i}`,
      monitorId: m.monitor.id,
      targets: { h24: 99.5, d30: 99.9 },
    });
    await s.api('POST', '/credentials', {
      name: `Invented credential ${tag} ${i}`,
      type: 'agentCertificate',
      platformId: plat!.id,
      platformText: '',
      environment: 'production',
      description: '',
      usedBy: { text: '', links: [] },
      owners: [],
      location: { text: 'Invented vault', url: '' },
    });
    await s.api('POST', '/users', { username: `invented-${tag}-${i}`, displayName: `Invented ${i}`, password: 'Invented-password-1', roles: ['viewer'] });
    await s.api('POST', '/teams', { name: `Invented team ${tag} ${i}`, members: [`invented-${tag}-${i}`] });
  }
}

describe('statements per request of the hot pages', () => {
  it('stay the same with more services, processes, schedules and monitors', async () => {
    await grow(3, 'a');
    // a cost budget (its own reads are per budget, not per service), and no stored scorecard yet: the start page
    // computes the scorecards then (a new installation, before the hourly job)
    const [svc] = (await s.api('GET', '/services')) as { id: string }[];
    await s.api('PUT', '/costs/budgets', { scope: 'service', scopeId: svc!.id, amount: '1000', currency: 'EUR' });
    const { db } = await import('../src/db.js');
    db().run('DELETE FROM scorecard_snapshots');
    const before = await countAll();
    await grow(25, 'b');
    const after = await countAll();
    if (process.env.H2_OUT) (await import('node:fs')).writeFileSync(process.env.H2_OUT, JSON.stringify({ before, after }, null, 1));
    expect(after).toEqual(before);
    // and few: no page reads per item (the public API's dataset list reads each dataset's latest values on its own:
    // about 90 statements with the demo's datasets, independent of the processes)
    for (const [k, n] of Object.entries(after)) expect(n, k).toBeLessThan(k.includes('/dashboard') || k.endsWith('v1/datasets') ? 160 : 80);
  }, 300_000);

  it('the run list of the public API reads the open tasks of its runs in one statement', async () => {
    // seen in CI: a fire of the demo's three feeder schedules every 15 minutes added a count per run (v1/runs +3)
    const { db } = await import('../src/db.js');
    const { fire } = await import('../src/scheduler.js');
    await quiesce();
    const before = await v1Statements(tokens.admin!, '/runs');
    const feeders = db().all<{ id: string }>("SELECT id FROM schedules WHERE cron = '*/15 * * * *' AND enabled = 1");
    expect(feeders.length).toBeGreaterThan(0);
    for (const f of feeders) expect(await fire(f.id)).toBeTruthy();
    await quiesce();
    expect(await v1Statements(tokens.admin!, '/runs')).toBe(before);
  }, 120_000);
});
