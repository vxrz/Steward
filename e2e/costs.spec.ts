import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll, json, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

/**
 * Platform costs (#226, docs/COSTS.md): the overview per service, application, team and platform, one application's
 * months with chart, table, trend and budget, a platform's source with a FOCUS import (preview, import, the list) and
 * a push token – on a desktop and a phone, with axe.
 */

const month = new Date().toISOString().slice(0, 7);
const prev = (() => {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
})();
const FOCUS = [
  'ChargePeriodStart,ChargePeriodEnd,BilledCost,EffectiveCost,BillingCurrency,ProviderName,ServiceName,ServiceCategory,ResourceId,Tags',
  `${prev}-02T00:00:00Z,${prev}-03T00:00:00Z,120.50,118.00,EUR,Azure,Virtual Machines,Compute,vm-1,"{""application"":""Webshop (demo)""}"`,
  `${prev}-02T00:00:00Z,${prev}-03T00:00:00Z,30,30,EUR,Azure,Storage,Storage,disk-1,{}`,
].join('\n');

async function newPlatform(api: APIRequestContext) {
  return json<{ id: string; name: string }>(
    await api.post('/api/platforms', {
      data: {
        name: uniq('Cloud invoices'),
        kind: 'generic',
        baseUrl: 'https://billing.example.com',
        config: { auth: { type: 'none' }, variables: {}, http: {} },
      },
    }),
  );
}

async function overview(page: Page, mobile: boolean) {
  await page.goto('/costs?scope=application');
  const list = page.getByTestId('costs-page');
  await expect(list.getByRole('heading', { name: 'Costs', level: 1 })).toBeVisible();
  await expect(list.getByRole('link', { name: 'Webshop (demo)' }).first()).toBeVisible();
  await expectAccessible(page, 'costs: applications');
  if (mobile) await expectNoHorizontalScroll(page);
  await page.getByTestId('cost-scope').getByText('Platforms').click();
  await expect(page).toHaveURL(/scope=platform/);
  await expect(page.getByTestId('cost-total').first()).toContainText('USD');
  await expect(list.getByRole('link', { name: 'AWS (demo)' }).first()).toBeVisible();
  await expectAccessible(page, 'costs: platforms');
  if (mobile) await expectNoHorizontalScroll(page);
}

async function application(page: Page, mobile: boolean) {
  await page.goto('/costs?scope=application');
  await page.getByTestId('costs-page').getByRole('link', { name: 'Webshop (demo)' }).first().click();
  await expect(page.getByRole('heading', { name: 'Webshop (demo)', level: 1 })).toBeVisible();
  const usd = page.getByTestId('cost-currency-USD');
  await expect(usd.getByTestId('cost-chart')).toBeVisible();
  await expect(usd).toContainText('This month so far');
  await expect(page.getByTestId('cost-by-service')).toContainText('Amazon Relational Database Service');
  await expect(page.getByTestId('cost-parts')).toContainText('AWS (demo)');
  await expectAccessible(page, 'costs: application');
  if (mobile) await expectNoHorizontalScroll(page);
  // the table twin of the chart
  await usd.getByRole('button', { name: 'Show as table' }).click();
  await expect(usd.getByTestId('cost-months')).toContainText('so far');
  await expectAccessible(page, 'costs: months table');
  if (mobile) await expectNoHorizontalScroll(page);
  await usd.getByRole('button', { name: 'Show as chart' }).click();
  // a budget below this month so far: reached
  await page.getByTestId('edit-budget').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Amount per month' }).fill('10');
  await dialog.getByRole('textbox', { name: 'Currency' }).fill('USD');
  await expectAccessible(page, 'costs: budget dialog');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('budget-state').first()).toHaveText('Budget reached');
  await expect(page.getByTestId('cost-budget')).toContainText('of US$10.00 this month');
  await expect(usd.getByTestId('budget-line')).toHaveCount(1);
  await expectAccessible(page, 'costs: application with budget');
  if (mobile) await expectNoHorizontalScroll(page);
}

async function source(page: Page, api: APIRequestContext, mobile: boolean) {
  const p = await newPlatform(api);
  await page.goto(`/costs/platform/${p.id}`);
  await expect(page.getByRole('heading', { name: p.name, level: 1 })).toBeVisible();
  await expect(page.getByText('No costs here yet')).toBeVisible();
  await page.getByTestId('tab-source').click();
  await expect(page).toHaveURL((u) => u.pathname.endsWith(`/costs/platform/${p.id}/source`));
  const card = page.getByTestId('cost-import');
  await expect(card.getByText('No file imported yet')).toBeVisible();
  await expectAccessible(page, 'costs: source (empty)');
  if (mobile) await expectNoHorizontalScroll(page);
  await card.locator('input[type="file"]').setInputFiles({ name: 'azure-focus.csv', mimeType: 'text/csv', buffer: Buffer.from(FOCUS) });
  const preview = page.getByTestId('cost-import-preview');
  await expect(preview).toContainText('azure-focus.csv: 2 rows, 2 cost lines');
  await expect(preview).toContainText('Lines linked to applications: 1, unassigned: 1');
  await expectAccessible(page, 'costs: import preview');
  if (mobile) await expectNoHorizontalScroll(page);
  await preview.getByTestId('cost-import-run').click();
  await expect(card.getByTestId('cost-imports')).toContainText('azure-focus.csv');
  // a push token for CI: shown once
  await page.getByTestId('cost-push-new').click();
  const dialog = page.getByRole('dialog', { name: 'New push token' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Nightly export');
  await dialog.getByTestId('cost-push-create').click();
  const secret = page.getByTestId('cost-push-secret');
  await expect(secret).toContainText('scp_');
  await expect(secret).toContainText(`/api/hooks/costs/${p.id}`);
  await expectAccessible(page, 'costs: push token secret');
  await secret.getByTestId('cost-push-done').click();
  await expect(page.getByTestId('cost-push-tokens')).toContainText('Nightly export');
  await expectAccessible(page, 'costs: source');
  if (mobile) await expectNoHorizontalScroll(page);
  // the overview of the platform: EUR, with what no application is linked to
  await page.getByRole('link', { name: 'Overview' }).click();
  await expect(page.getByTestId('cost-currency-EUR')).toBeVisible();
  await expect(page.getByTestId('cost-unassigned')).toContainText('€30.00');
  await expectAccessible(page, 'costs: platform overview');
  if (mobile) await expectNoHorizontalScroll(page);
  return p;
}

test('costs: overview, an application with chart and budget, a platform source with a FOCUS import and a push token', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  await overview(page, false);
  await application(page, false);
  const p = await source(page, api, false);
  // the way from a service, application or platform to its costs
  await page.goto(`/platforms/${p.id}`);
  await page.getByTestId('open-costs').click();
  await expect(page).toHaveURL((u) => u.pathname.endsWith(`/costs/platform/${p.id}`));
  // the cost settings (administrators)
  await page.goto('/costs');
  await page.getByTestId('cost-settings').click();
  const dialog = page.getByRole('dialog', { name: 'Cost settings' });
  await expect(dialog.getByTestId('hide-amounts')).toBeVisible();
  await expectAccessible(page, 'costs: settings');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await api.delete(`/api/platforms/${p.id}`);
});

test('costs on a phone @mobile', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  await overview(page, true);
  await application(page, true);
  const p = await source(page, api, true);
  await api.delete(`/api/platforms/${p.id}`);
});

/** A service with an application olivia may not see: its budget shows her the state only (no figures to subtract). */
async function stateOnly(loginAs: (u: 'olivia') => Promise<Page>, api: APIRequestContext, mobile: boolean) {
  const team = await json<{ id: string }>(await api.post('/api/teams', { data: { name: uniq('Cost team') } }));
  const mine = await json<{ id: string }>(await api.post('/api/applications', { data: { name: uniq('Olivia app'), owners: ['user:olivia'] } }));
  const other = await json<{ id: string }>(await api.post('/api/applications', { data: { name: uniq('Other team app') } }));
  const service = await json<{ id: string; name: string }>(
    await api.post('/api/services', { data: { name: uniq('Shared service'), owners: ['user:olivia'] } }),
  );
  try {
    expect((await api.put(`/api/owning-teams/application/${other.id}`, { data: { teamIds: [team.id] } })).ok()).toBe(true);
    for (const a of [mine, other]) expect((await api.put(`/api/services/${service.id}/applications/${a.id}`, { data: {} })).ok()).toBe(true);
    expect((await api.put('/api/costs/budgets', { data: { scope: 'service', scopeId: service.id, amount: '1000', currency: 'USD' } })).ok()).toBe(true);
    const page = await loginAs('olivia');
    await page.goto(`/costs/service/${service.id}`);
    await expect(page.getByRole('heading', { name: service.name, level: 1 })).toBeVisible();
    const budget = page.getByTestId('cost-budget');
    await expect(budget.getByTestId('budget-state')).toHaveText('Within budget');
    await expect(budget.getByTestId('budget-state-only')).toContainText('Only the budget');
    await expect(budget).toContainText('Budget: US$1,000.00 a month');
    await expect(budget).not.toContainText('this month');
    await expect(budget.getByRole('progressbar')).toHaveCount(0);
    await expectAccessible(page, 'costs: budget state only');
    if (mobile) await expectNoHorizontalScroll(page);
    // the scorecard part "Costs": the state, no percentage
    await page.goto(`/services/${service.id}/scorecard`);
    const part = page.getByTestId('part-costs');
    await expect(part).toContainText('Within the budget this month');
    await expect(part).toContainText('Only the budget');
    await expect(part).not.toContainText('%');
    await expectAccessible(page, 'scorecard: costs as state only');
    if (mobile) await expectNoHorizontalScroll(page);
  } finally {
    await api.put('/api/costs/budgets', { data: { scope: 'service', scopeId: service.id, amount: null, currency: 'USD' } });
    // services are archived, not deleted (an active service of olivia's would add a start page tile for later specs)
    expect((await api.post(`/api/services/${service.id}/archive`, { data: { archived: true } })).ok()).toBe(true);
    for (const a of [mine, other]) await api.post(`/api/applications/${a.id}/archive`, { data: { archived: true } });
    await api.put(`/api/owning-teams/application/${other.id}`, { data: { teamIds: [] } });
    await api.delete(`/api/teams/${team.id}`);
  }
}

test('costs: a budget shows only its state to who does not see every application', async ({ apiAs, loginAs }) => {
  await stateOnly(loginAs, await apiAs('admin'), false);
});

test('costs: budget state only on a phone @mobile', async ({ apiAs, loginAs }) => {
  await stateOnly(loginAs, await apiAs('admin'), true);
});
