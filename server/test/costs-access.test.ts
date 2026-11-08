import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Platform costs and the reader's rights (#226, security review of 0.9.0): what a service owner who may not see every
 * application of their service learns – through the scheduled "Cost change" check, FOCUS imports and pushes, budgets
 * (the state only), the check's amounts with "Hide amounts from viewers" – and that a large FOCUS file does not block
 * the server.
 *
 * Setup: team "Secret team" owns the application "Secret app", so olivia (operator) may not see it. The service "Mixed
 * service" (owner olivia) holds "Visible app" (owner olivia) and "Secret app". olivia may use and manage a platform.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let olivia: Client;
let vera: Client;
let platform: string;
let tiedPlatform: string;
let visible: string;
let secret: string;
let seen: string;
let tied: string;
let service: string;
let team: string;
const today = new Date().toISOString().slice(0, 10);
const month = today.slice(0, 7);
const prevMonth = (() => {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
})();
const HEAD = 'ChargePeriodStart,ChargePeriodEnd,BilledCost,BillingCurrency,ProviderName,ServiceName,ResourceId,Tags';
const tags = (o: Record<string, string>) => `"${JSON.stringify(o).replaceAll('"', '""')}"`;
const row = (day: string, billed: string, app: string, res: string) =>
  [`${day}T00:00:00Z`, `${day}T01:00:00Z`, billed, 'EUR', 'Azure', 'VM', res, tags({ application: app })].join(',');
const csv = (...rows: string[]) => [HEAD, ...rows].join('\n');
const eur = (d: { currencies: { currency: string; thisMonth: string | null; lastMonth: string | null }[] }) => d.currencies.find((c) => c.currency === 'EUR');

async function newPlatform(name: string): Promise<string> {
  const { db } = await import('../src/db.js');
  const id = (
    await s.api('POST', '/platforms', {
      name,
      kind: 'generic',
      baseUrl: 'https://management.example.com',
      config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none' } },
    })
  ).id;
  db().run('UPDATE platforms SET acl = ? WHERE id = ?', JSON.stringify([{ subject: 'user:olivia', permissions: ['use', 'manage'] }]), id);
  return id;
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  olivia = await s.as('olivia', PW);
  vera = await s.as('vera', PW);
  const { db } = await import('../src/db.js');
  platform = await newPlatform('Exports (olivia)');
  tiedPlatform = await newPlatform('Exports (shared)');
  team = (await s.api('POST', '/teams', { name: 'Secret team' })).id;
  const hide = (id: string) =>
    db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('application', ?, ?, ?)", id, team, new Date().toISOString());
  visible = (await s.api('POST', '/applications', { name: 'Visible app', owners: ['user:olivia'] })).id;
  secret = (await s.api('POST', '/applications', { name: 'Secret app' })).id;
  hide(secret);
  // olivia sees this one, but may not change it
  seen = (await s.api('POST', '/applications', { name: 'Seen app' })).id;
  // hidden from olivia, but it has a component on the shared platform: tied to it
  tied = (await s.api('POST', '/applications', { name: 'Tied app' })).id;
  hide(tied);
  const now = new Date().toISOString();
  db().run(
    `INSERT INTO application_components (id, application_id, type, name, url, note, environment, platform_id, dt_platform_id, dt_project, created_at, created_by, updated_at, updated_by)
     VALUES ('comp_tied', ?, 'generic', 'tied-resource', '', '', '', ?, NULL, NULL, ?, 'admin', ?, 'admin')`,
    tied,
    tiedPlatform,
    now,
    now,
  );
  service = (await s.api('POST', '/services', { name: 'Mixed service', owners: ['user:olivia'] })).id;
  await s.api('PUT', `/services/${service}/applications/${visible}`, {});
  await s.api('PUT', `/services/${service}/applications/${secret}`, {});
}, 240_000);

describe('FOCUS imports link by name only to applications the importer may change, or that the platform belongs to', () => {
  const probe = async (target: string, name: string) =>
    (await olivia('POST', `/costs/platform/${target}/imports/preview`, { csv: csv(row(`${prevMonth}-03`, '1', name, 'r')), fileName: 'x.csv' })).assigned;

  it('olivia cannot see the secret application', async () => {
    await expect(olivia('GET', `/costs/application/${secret}`)).rejects.toMatchObject({ status: 404 });
    await expect(olivia('GET', `/applications/${secret}`)).rejects.toMatchObject({ status: 404 });
    await expect(olivia('GET', `/applications/${tied}`)).rejects.toMatchObject({ status: 404 });
    expect((await olivia('GET', `/applications/${seen}`)).canEdit).toBe(false);
  });

  it('the preview tells nothing about hidden applications', async () => {
    expect(await probe(platform, 'Visible app')).toBe(1);
    expect(await probe(platform, 'Secret app')).toBe(0);
    expect(await probe(platform, 'No such app')).toBe(0);
    // seen, but not hers to change
    expect(await probe(platform, 'Seen app')).toBe(0);
    // tied to the platform, but hidden from her: counted as unassigned like a missing one
    expect(await probe(tiedPlatform, 'Tied app')).toBe(0);
    expect(await probe(tiedPlatform, 'tied-resource')).toBe(0);
    // the administrator's preview counts them
    const admin = await s.api('POST', `/costs/platform/${platform}/imports/preview`, { csv: csv(row(`${prevMonth}-03`, '1', 'Secret app', 'r')) });
    expect(admin.assigned).toBe(1);
  });

  it("an import books nothing on another team's application", async () => {
    await olivia('POST', `/costs/platform/${platform}/imports`, {
      csv: csv(
        row(`${month}-01`, '5000', 'Secret app', 'evil'),
        row(`${month}-01`, '7', 'Seen app', 'seen'),
        row(`${month}-01`, '100', 'Visible app', 'ok'),
        row(`${prevMonth}-01`, '100', 'Visible app', 'ok'),
      ),
      fileName: 'f.csv',
      mode: 'add',
    });
    expect((await s.api('GET', `/costs/application/${secret}`)).currencies).toEqual([]);
    expect((await s.api('GET', `/costs/application/${seen}`)).currencies).toEqual([]);
    expect(eur(await s.api('GET', `/costs/application/${visible}`))?.thisMonth).toBe('100.00');
    const pl = await s.api('GET', `/costs/platform/${platform}`);
    expect(pl.unassigned.find((u: { currency: string }) => u.currency === 'EUR').thisMonth).toBe('5007.00');
    // a line of an application tied to the platform is booked on it, also when olivia imports it
    await olivia('POST', `/costs/platform/${tiedPlatform}/imports`, { csv: csv(row(`${month}-02`, '3', 'Tied app', 't')), fileName: 't.csv', mode: 'add' });
    expect(eur(await s.api('GET', `/costs/application/${tied}`))?.thisMonth).toBe('3.00');
  });

  it("a push links with the rights of the token's creator", async () => {
    (await import('../src/costs/push.js')).resetCostPushState();
    const t = await olivia('POST', `/costs/platform/${platform}/push-tokens`, { name: 'ci' });
    const res = await fetch(`${s.base}/api/hooks/costs/${platform}?mode=add`, {
      method: 'POST',
      headers: { 'content-type': 'text/csv', authorization: `Bearer ${t.token}` },
      body: csv(row(`${prevMonth}-07`, '900', 'Secret app', 'push'), row(`${prevMonth}-07`, '11', 'Visible app', 'push')),
    });
    expect(res.status).toBe(200);
    expect((await s.api('GET', `/costs/application/${secret}`)).currencies).toEqual([]);
    const v = await s.api('GET', `/costs/application/${visible}`);
    expect(eur(v)?.lastMonth).toBe('111.00');
  });

  it("the daily linking keeps each import's rights", async () => {
    // the administrator may link to every application
    await s.api('POST', `/costs/platform/${platform}/imports`, { csv: csv(row(`${month}-02`, '5000', 'Secret app', 'admin')), fileName: 'a.csv', mode: 'add' });
    expect(eur(await s.api('GET', `/costs/application/${secret}`))?.thisMonth).toBe('5000.00');
    const { remap } = await import('../src/costs/store.js');
    remap(platform, 'focus');
    remap(tiedPlatform, 'focus');
    expect(eur(await s.api('GET', `/costs/application/${secret}`))?.thisMonth).toBe('5000.00');
    expect(eur(await s.api('GET', `/costs/application/${visible}`))?.thisMonth).toBe('100.00');
    expect(eur(await s.api('GET', `/costs/application/${tied}`))?.thisMonth).toBe('3.00');
    expect((await s.api('GET', `/costs/application/${seen}`)).currencies).toEqual([]);
  });
});

describe('the scheduled "Cost change" check', () => {
  const check = {
    id: 'c',
    name: 'c',
    type: 'cost' as const,
    scope: 'service' as const,
    period: 'monthToDate' as const,
    maxIncreasePct: 1,
    failAs: 'degraded' as const,
    noData: 'unknown' as const,
    currency: 'EUR',
  };

  it("counts only what the monitor owner may see, also without a request (the monitor engine's call)", async () => {
    const { costCheck } = await import('../src/costs/check.js');
    const r = costCheck({ ...check, target: service } as never, { owner: 'olivia', now: () => Date.now() });
    expect(r.message).toContain('Service "Mixed service"');
    expect((r.value as { current: string }).current).toBe('100.00');
    expect(eur(await olivia('GET', `/costs/service/${service}`))?.thisMonth).toBe('100.00');
    // the administrator's check counts everything
    const a = costCheck({ ...check, target: service } as never, { owner: 'admin', now: () => Date.now() });
    expect((a.value as { current: string }).current).toBe('5100.00');
  });

  it('never carries amounts while "Hide amounts from viewers" is on – every monitor viewer reads the result', async () => {
    const { costCheck } = await import('../src/costs/check.js');
    await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: true, defaultCurrency: 'USD' });
    try {
      for (const owner of ['olivia', 'admin']) {
        const r = costCheck({ ...check, target: service, maxIncrease: '1' } as never, { owner, now: () => Date.now() });
        expect(r.message).not.toMatch(/EUR/);
        expect(r.value).not.toHaveProperty('current');
        expect(r.value).not.toHaveProperty('previous');
        expect(r.value).not.toHaveProperty('change');
        expect(r.value).toHaveProperty('changePct');
      }
    } finally {
      await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: false, defaultCurrency: 'USD' });
    }
    // with the setting off, amounts are back for an owner who may see them
    const r = costCheck({ ...check, target: service } as never, { owner: 'olivia', now: () => Date.now() });
    expect(r.message).toContain('EUR');
  });
});

describe('budgets show only their state to who does not see the whole scope', () => {
  beforeAll(async () => {
    // 5100 of 6000: 85 %
    await s.api('PUT', '/costs/budgets', { scope: 'service', scopeId: service, amount: '6000', currency: 'EUR' });
    await new Promise((r) => setTimeout(r, 300));
  });

  it('in the costs pages and the overview', async () => {
    const d = await olivia('GET', `/costs/service/${service}`);
    expect(JSON.stringify(d)).not.toContain('Secret app');
    expect(eur(d)?.thisMonth).toBe('100.00');
    expect(d.budget).toMatchObject({ state: 'warning', stateOnly: true, used: null, pct: null, forecastPct: null, amount: '6000.00', currency: 'EUR' });
    const row0 = (await olivia('GET', '/costs?scope=service')).rows.find((r: { id: string }) => r.id === service);
    expect(row0).toMatchObject({ budgetPct: null, budgetState: 'warning' });
    // the administrator sees everything: the whole figures
    const full = await s.api('GET', `/costs/service/${service}`);
    expect(full.budget).toMatchObject({ state: 'warning', stateOnly: false, used: '5100.00', pct: 85 });
    expect((await s.api('GET', '/costs?scope=service')).rows.find((r: { id: string }) => r.id === service).budgetPct).toBe(85);
    // an application's budget covers just the application: who sees it sees all of it
    await s.api('PUT', '/costs/budgets', { scope: 'application', scopeId: visible, amount: '1000', currency: 'EUR' });
    expect((await olivia('GET', `/costs/application/${visible}`)).budget).toMatchObject({ stateOnly: false, used: '100.00', pct: 10 });
  });

  it('in the scorecard', async () => {
    for (const c of [olivia, vera]) {
      const card = await c('GET', `/scorecard/services/${service}`);
      expect(card.costs).toMatchObject({ status: 'pending', stateOnly: true, budgetPct: null, forecastPct: null, thisMonth: null });
    }
    const card = await s.api('GET', `/scorecard/services/${service}`);
    expect(card.costs).toMatchObject({ stateOnly: false, budgetPct: 85, thisMonth: '5100.00' });
  });

  it('in the report section', async () => {
    const { reportSection } = await import('../src/reports/sections.js');
    await import('../src/costs/report-section.js');
    const sec = reportSection('costs')!;
    const { runAs } = await import('../src/auth/context.js');
    const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
    const from = Date.parse(`${month}-01T00:00:00Z`);
    const to = Date.now() + 1000;
    const build = (user: string) =>
      runAs(toAuthUser(findUserByName(user)!), () =>
        sec.build(sec.schema.parse({ scope: 'service', ids: [service] }), { from, to, now: Date.now(), lang: 'en' }),
      ) as {
        rows: { name: string; budget: { pct: number | null; state: string } | null }[];
      };
    expect(build('olivia').rows[0]!.budget).toEqual({ amount: '6000.00', pct: null, state: 'warning' });
    expect(build('admin').rows[0]!.budget).toMatchObject({ pct: 85, state: 'warning' });
  });

  it('in /api/v1', async () => {
    const token = (await olivia('POST', '/me/tokens', { name: 'costs', scope: 'read' })).token as string;
    const v1 = async (path: string) => {
      const res = await fetch(`${s.base}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, json: await res.json() };
    };
    const one = await v1(`/costs/service/${service}`);
    expect(one.status).toBe(200);
    expect(one.json.budget).toMatchObject({ state: 'warning', stateOnly: true, used: null, pct: null });
    const list = await v1('/costs?scope=service&limit=200');
    expect(list.json.items.find((r: { id: string }) => r.id === service)).toMatchObject({ budgetPct: null, budgetState: 'warning' });
  });

  it('in the budget notice', async () => {
    const mine = (await olivia('GET', '/notifications')).items.filter((x: { event: string }) => x.event === 'cost.budget');
    expect(mine.map((x: { title: string }) => x.title)).toEqual(['Cost budget at 80 %: Service “Mixed service”']);
    const body = mine[0].body as string;
    expect(body).not.toMatch(/5[.,]?100|85|6[.,]?000/);
    expect(body).toContain('80 %');
  });
});

describe('a large FOCUS file', () => {
  it('is read and linked without blocking the server for long', async () => {
    const { db } = await import('../src/db.js');
    const big = await newPlatform('Exports (large)');
    const now = new Date().toISOString();
    db().tx(() => {
      for (let i = 0; i < 2000; i++)
        db().run(
          `INSERT INTO application_components (id, application_id, type, name, url, note, environment, platform_id, dt_platform_id, dt_project, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, 'generic', ?, '', '', '', ?, NULL, NULL, ?, 'admin', ?, 'admin')`,
          `comp_big_${i}`,
          visible,
          `Comp ${i}`,
          big,
          now,
          now,
        );
    });
    const lines = ['ChargePeriodStart,ChargePeriodEnd,BilledCost,BillingCurrency,ResourceId,Tags'];
    for (let i = 0; i < 120_000; i++) lines.push(`${prevMonth}-01T00:00:00Z,${prevMonth}-01T01:00:00Z,1,EUR,r${i},"{""application"":""comp ${i % 4000}""}"`);
    const file = lines.join('\n');
    // the longest time the event loop did not come round while the server read the file
    let last = performance.now();
    let longest = 0;
    const tick = setInterval(() => {
      const t = performance.now();
      longest = Math.max(longest, t - last);
      last = t;
    }, 5);
    const started = performance.now();
    try {
      const p = await s.api('POST', `/costs/platform/${big}/imports/preview`, { csv: file, fileName: 'big.csv' });
      expect(p).toMatchObject({ lines: 120_000, assigned: 60_000, unassigned: 60_000 });
    } finally {
      clearInterval(tick);
    }
    // measured: about 1.5 s and pauses of 0.2 s at most (before: 44 s in one piece)
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(longest).toBeLessThan(1000);
    // the import itself: linked the same way, within a time budget
    const t0 = performance.now();
    const r = await s.api('POST', `/costs/platform/${big}/imports`, { csv: file, fileName: 'big.csv', mode: 'add' });
    expect(r.inserted).toBe(120_000);
    expect(performance.now() - t0).toBeLessThan(60_000);
    const linked = db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_records WHERE source_platform_id = ? AND component_id IS NOT NULL', big)!;
    expect(Number(linked.n)).toBe(60_000);
  }, 180_000);
});
