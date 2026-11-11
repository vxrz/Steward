import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Statements per request of the pages that are opened most and polled (security review 0.19.0 H2): the start page
 * (/api/dashboard), the scorecard, the costs overview and the monitor list read their items in bulk – the number of
 * statements does not grow with the number of services, processes, schedules, platforms or monitors. On PostgreSQL every
 * statement is a round trip that blocks the event loop, so a statement per item made these pages slow for everyone.
 * The pattern of the cost plan test (cost-plans.test.ts): the same count before and after adding many items.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let dana: Client;
const counted = new Map<string, number>();

const PAGES = ['/dashboard', '/scorecard', '/costs?scope=service', '/costs?scope=application', '/monitors', '/platforms', '/processes', '/schedules'];

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
}, 180_000);

/** Statements of one GET as the signed-in user of `c` (the second call: caches of the first are warm). */
async function statements(c: Client, url: string): Promise<number> {
  await c('GET', url);
  counted.delete(`/api${url}`);
  await c('GET', url);
  return counted.get(`/api${url}`) ?? -1;
}

async function countAll(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [who, c] of [
    ['admin', s.api],
    ['dana', dana],
  ] as const)
    for (const url of PAGES) out[`${who} ${url}`] = await statements(c, url);
  return out;
}

/** Adds `n` services, processes with an enabled schedule each, and monitors. */
async function grow(n: number, tag: string): Promise<void> {
  const [sch] = (await s.api('GET', '/schedules')) as { processId: string; inputs: unknown; bindings: unknown }[];
  const proc = await s.api('GET', `/processes/${sch!.processId}`);
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
    await s.api('POST', '/monitors', {
      definition: { name: `Invented monitor ${tag} ${i}`, checks: [{ id: 'hb', name: 'Heartbeat', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600 }] },
    });
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
    // and few: no page reads per item
    for (const [k, n] of Object.entries(after)) expect(n, k).toBeLessThan(k.includes('/dashboard') ? 160 : 80);
  }, 300_000);
});
