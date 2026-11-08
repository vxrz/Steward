import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Platform costs, part two (#226): monthly budgets with their 80 % and 100 % notices and the step-up for raising one
 * (control point cost.budget), the monitor check "Cost change", the scorecard part "Costs", the report section, the
 * built-in dataset and /api/v1/costs – each with the reader's rights.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let service: string;
let shop: string;
let aws: string;
const month = new Date().toISOString().slice(0, 7);

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  shop = (await s.api('GET', '/applications')).find((a: { name: string }) => a.name === 'Webshop (demo)').id;
  aws = (await s.api('GET', '/platforms')).find((p: { name: string }) => p.name === 'AWS (demo)').id;
  service = (await s.api('POST', '/services', { name: 'Online shop', owners: ['user:olivia'] })).id;
  await s.api('PUT', `/services/${service}/applications/${shop}`, {});
}, 240_000);
afterAll(async () => {
  await s?.app.close();
});

describe('budgets', () => {
  it('are set by who may change the service; raising one needs a step-up and is audited', async () => {
    const vera = await s.as('vera', PW);
    await expect(vera('PUT', '/costs/budgets', { scope: 'service', scopeId: service, amount: '100', currency: 'USD' })).rejects.toMatchObject({ status: 403 });
    const dana = await s.as('dana', PW, { autoStepUp: false });
    await dana('DELETE', '/auth/step-up').catch(() => undefined);
    // a first budget lowers "no budget": no confirmation
    const b = await dana('PUT', '/costs/budgets', { scope: 'service', scopeId: service, amount: '100000', currency: 'USD', comment: 'first' });
    expect(b.budget).toMatchObject({ amount: '100000.00', currency: 'USD', state: 'ok' });
    expect(await dana('PUT', '/costs/budgets', { scope: 'service', scopeId: service, amount: '50000', currency: 'USD' })).toBeTruthy();
    for (const raise of [
      { amount: '60000', currency: 'USD' },
      { amount: '10', currency: 'EUR' },
      { amount: null, currency: 'USD' },
    ])
      await expect(dana('PUT', '/costs/budgets', { scope: 'service', scopeId: service, ...raise })).rejects.toMatchObject({
        status: 403,
        body: { code: 'STEP_UP_REQUIRED', stepUp: { action: 'changeCostBudget' } },
      });
    const [audit] = await s.api('GET', `/audit?action=cost.budget_changed&entityId=${service}`);
    expect(audit.summary).toBe('Cost budget of service "Online shop" changed: 50000.00 USD a month (was 100000.00 USD)');
    expect(audit.details).toMatchObject({ raised: false, before: { amount: '100000.00' }, after: { amount: '50000.00', currency: 'USD' } });
    // the suite's admin client confirms with its password
    await s.api('PUT', '/costs/budgets', { scope: 'service', scopeId: service, amount: '60000', currency: 'USD', comment: 'more traffic' });
    const [raised] = await s.api('GET', `/audit?action=cost.budget_changed&entityId=${service}`);
    expect(raised.details).toMatchObject({ raised: true, comment: 'more traffic' });
    expect(raised.details.assurance?.[0]).toMatchObject({ point: 'cost.budget' });
    expect(JSON.stringify(await s.api('GET', '/assurance/policy'))).toContain('cost.budget');
  });

  it('sends the 80 % and the 100 % notice once a month to the owners', async () => {
    const { db } = await import('../src/db.js');
    const used = Number(
      db().get<{ e: number }>(
        "SELECT SUM(effective_cost) AS e FROM cost_records WHERE application_id = ? AND month = ? AND billing_currency = 'USD'",
        shop,
        month,
      )!.e,
    );
    expect(used).toBeGreaterThan(0);
    // a budget a little above this month so far: 80 % reached
    const amount = ((used / 1_000_000) * 1.1).toFixed(2);
    await s.api('PUT', '/costs/budgets', { scope: 'service', scopeId: service, amount, currency: 'USD' });
    const { checkBudgetNotices } = await import('../src/costs/budgets.js');
    expect(checkBudgetNotices()).toBe(0); // sent with the change already
    const olivia = await s.as('olivia', PW);
    const inbox = async () => (await olivia('GET', '/notifications')).items.filter((x: { event: string }) => x.event === 'cost.budget');
    await new Promise((r) => setTimeout(r, 300));
    expect((await inbox()).map((x: { title: string }) => x.title)).toEqual(['Cost budget at 80 %: Service “Online shop”']);
    const lower = ((used / 1_000_000) * 0.9).toFixed(2);
    await s.api('PUT', '/costs/budgets', { scope: 'service', scopeId: service, amount: lower, currency: 'USD' });
    await new Promise((r) => setTimeout(r, 300));
    const titles = (await inbox()).map((x: { title: string }) => x.title);
    expect(titles).toContain('Cost budget reached: Service “Online shop”');
    expect(checkBudgetNotices()).toBe(0);
    const d = await olivia('GET', `/costs/service/${service}`);
    expect(d.budget).toMatchObject({ state: 'exceeded', currency: 'USD' });
    expect(d.budget.pct).toBeGreaterThan(100);
  });
});

describe('the scorecard', () => {
  it('has the part "Costs" from the budget; amounts only for who may see them', async () => {
    const card = await s.api('GET', `/scorecard/services/${service}`);
    expect(card.costs).toMatchObject({ status: 'attention', currency: 'USD' });
    expect(card.costs.thisMonth).not.toBeNull();
    expect(card.attention).toBe(true);
    await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: true, defaultCurrency: 'USD' });
    const vera = await s.as('vera', PW);
    const hidden = await vera('GET', `/scorecard/services/${service}`);
    expect(hidden.costs).toMatchObject({ status: 'attention', thisMonth: null, budget: null });
    await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: false, defaultCurrency: 'USD' });
  });
});

describe('the monitor check "Cost change"', () => {
  it('compares a scope with the month before and refuses scopes the editor may not see', async () => {
    const { costCheck } = await import('../src/costs/check.js');
    const base = {
      id: 'c1',
      name: 'Shop costs',
      type: 'cost' as const,
      scope: 'application' as const,
      target: shop,
      period: 'month' as const,
      failAs: 'degraded' as const,
      noData: 'unknown' as const,
    };
    // the demo account grows a little every month
    const ok = costCheck({ ...base, maxIncreasePct: 50 }, { owner: 'admin', now: () => Date.now() });
    expect(ok.status).toBe('up');
    expect(ok.message).toMatch(/^Application "Webshop \(demo\)": costs \+\d/);
    const up = costCheck({ ...base, maxIncreasePct: 0.5 }, { owner: 'admin', now: () => Date.now() });
    expect(up.status).toBe('degraded');
    expect(up.message).toContain('more than 0.5 %');
    const amount = costCheck({ ...base, maxIncrease: '1' }, { owner: 'admin', now: () => Date.now() });
    expect(amount.status).toBe('degraded');
    const none = costCheck({ ...base, scope: 'platform', target: aws, currency: 'EUR', maxIncreasePct: 10 }, { owner: 'admin', now: () => Date.now() });
    expect(none.status).toBe('unknown');
    // saving a monitor with a scope the editor may not see
    const { db } = await import('../src/db.js');
    const team = (await s.api('POST', '/teams', { name: 'Hidden costs' })).id;
    const hiddenApp = (await s.api('POST', '/applications', { name: 'Hidden app' })).id;
    db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('application', ?, ?, ?)", hiddenApp, team, new Date().toISOString());
    const dana = await s.as('dana', PW);
    await expect(
      dana('POST', '/monitors', { definition: { name: 'Costs', checks: [{ ...base, target: hiddenApp, maxIncreasePct: 10 }] } }),
    ).rejects.toMatchObject({ status: 400, body: expect.objectContaining({ code: 'COST_SCOPE_NOT_FOUND' }) });
    await expect(s.api('POST', '/monitors', { definition: { name: 'Costs', checks: [{ ...base, maxIncreasePct: undefined }] } })).rejects.toMatchObject({
      status: 400,
    });
    const { monitor } = await dana('POST', '/monitors', { definition: { name: 'Shop costs', checks: [{ ...base, maxIncreasePct: 50 }] } });
    expect(monitor.id).toBeTruthy();
  });
});

describe('reports, the dataset and /api/v1', () => {
  it("reports the costs of the period with the owner's rights", async () => {
    const { reportSection } = await import('../src/reports/sections.js');
    await import('../src/reports/schedules.js');
    const sec = reportSection('costs')!;
    const { runAs } = await import('../src/auth/context.js');
    const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
    const d = new Date();
    const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
    const to = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const cfg = sec.schema.parse({ scope: 'platform' });
    const asAdmin = runAs(toAuthUser(findUserByName('admin')!), () => sec.build(cfg, { from, to, now: Date.now(), lang: 'en' })) as {
      rows: { name: string; period: string | null }[];
      totals: unknown[];
    };
    expect(asAdmin.rows.map((r) => r.name)).toContain('AWS (demo)');
    expect(asAdmin.totals.length).toBeGreaterThan(0);
    // a viewer sees no platform at all
    const asViewer = runAs(toAuthUser(findUserByName('vera')!), () => sec.build(cfg, { from, to, now: Date.now(), lang: 'en' })) as { rows: unknown[] };
    expect(asViewer.rows).toEqual([]);
    expect(() => runAs(toAuthUser(findUserByName('vera')!), () => sec.validate!(sec.schema.parse({ scope: 'platform', ids: [aws] })))).toThrow(/not found/);
  });

  it('publishes the dataset "Costs" for administrators and auditors', async () => {
    const { publishCostsDataset } = await import('../src/costs/dataset.js');
    expect(publishCostsDataset(true)).toBe(true);
    const ds = await s.api('GET', '/datasets/costs.overview');
    expect(ds.rows.some((r: { Kind: string; Name: string }) => r.Kind === 'platform' && r.Name === 'AWS (demo)')).toBe(true);
    expect(ds.metrics.thisMonth).toBeGreaterThan(0);
    const audrey = await s.as('audrey', PW);
    expect((await audrey('GET', '/datasets/costs.overview')).rows.length).toBeGreaterThan(0);
    const vera = await s.as('vera', PW);
    await expect(vera('GET', '/datasets/costs.overview')).rejects.toMatchObject({ status: 404 });
  });

  it("serves /api/v1/costs with the token owner's rights", async () => {
    const token = (await s.api('POST', '/me/tokens', { name: 'costs', scope: 'read' })).token as string;
    const v1 = async (path: string) => {
      const res = await fetch(`${s.base}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, json: await res.json() };
    };
    const list = await v1('/costs?scope=platform&limit=2');
    expect(list.status).toBe(200);
    expect(list.json.items).toHaveLength(2);
    expect(list.json.nextCursor).toBeTruthy();
    const one = await v1(`/costs/application/${shop}`);
    expect(one.status).toBe(200);
    expect(one.json.currencies[0].months).toHaveLength(13);
    expect((await v1('/costs/application/app_missing')).status).toBe(404);
    expect((await v1('/costs/nothing/x')).status).toBe(404);
  });
});
