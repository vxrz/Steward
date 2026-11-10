import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { appHref, authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

/**
 * Service cost planning (ADR 0026, docs/COSTS.md#planning-per-service): the fiscal year start in the cost settings, a
 * service's Costs tab with plan lines (one for an application of the service), an entry on a line and an unplanned
 * one, the year view with its totals, grouping, the month table – on a desktop and as cards on a phone, with axe.
 */

async function fixture(api: APIRequestContext) {
  const app = await json<{ id: string; name: string }>(await api.post('/api/applications', { data: { name: uniq('Historian app') } }));
  const service = await json<{ id: string; name: string }>(await api.post('/api/services', { data: { name: uniq('Planned service') } }));
  expect((await api.put(`/api/services/${service.id}/applications/${app.id}`, { data: {} })).ok()).toBe(true);
  return { app, service };
}

async function cleanup(api: APIRequestContext, f: { app: { id: string }; service: { id: string } }) {
  expect((await api.post(`/api/services/${f.service.id}/archive`, { data: { archived: true } })).ok()).toBe(true);
  await api.post(`/api/applications/${f.app.id}/archive`, { data: { archived: true } });
}

/** `start`: the fiscal year's start month when the test set it (then "expected" is known: the support is planned for the months to come). */
async function plan(page: Page, f: { app: { name: string }; service: { id: string; name: string } }, mobile: boolean, start?: number) {
  await page.goto(`/services/${f.service.id}`);
  await page.getByTestId('service-tab-costs').click();
  await expect(page).toHaveURL((u) => u.pathname.endsWith(`/services/${f.service.id}/costs`));
  const view = page.getByTestId('service-cost-plan');
  await expect(view.getByRole('heading', { name: 'Cost plan' })).toBeVisible();
  await expect(view.getByText(/^No plan for FY /)).toBeVisible();
  await expectAccessible(page, 'cost plan: empty');
  if (mobile) await expectNoHorizontalScroll(page);

  // a yearly licence for the service's application
  await view.getByTestId('plan-add-line').click();
  let dialog = page.getByRole('dialog', { name: /^New plan line, FY / });
  await dialog.getByRole('textbox', { name: 'Title' }).fill('Historian licences');
  await chooseOption(page, 'For', f.app.name);
  await dialog.getByRole('textbox', { name: 'Vendor or contract' }).fill('Kestrel Historian (invented)');
  await dialog.getByRole('textbox', { name: 'Amount per year' }).fill('1200');
  await dialog.getByRole('textbox', { name: 'Currency' }).fill('EUR');
  await expectAccessible(page, 'cost plan: line dialog');
  await dialog.getByTestId('plan-line-save').click();
  await expect(dialog).toBeHidden();
  // a monthly support contract
  await view.getByTestId('plan-add-line').click();
  dialog = page.getByRole('dialog', { name: /^New plan line, FY / });
  await dialog.getByRole('textbox', { name: 'Title' }).fill('Support contract');
  await chooseOption(page, 'Category', 'Service and support');
  await chooseOption(page, 'Cadence', 'Monthly');
  await dialog.getByRole('textbox', { name: 'Amount per month' }).fill('100');
  await dialog.getByRole('textbox', { name: 'Currency' }).fill('EUR');
  await dialog.getByTestId('plan-line-save').click();
  await expect(dialog).toBeHidden();
  await expect(view.getByTestId('plan-lines')).toContainText('Support contract');

  // an entry on the licence line, and an unplanned one
  await view.getByTestId('plan-add-entry').click();
  dialog = page.getByRole('dialog', { name: 'New cost entry' });
  await dialog.getByRole('textbox', { name: 'Amount' }).fill('1200');
  await chooseOption(page, 'Plan line', 'Historian licences (EUR)');
  await dialog.getByRole('textbox', { name: 'Reference' }).fill('INV-88412');
  await expectAccessible(page, 'cost plan: entry dialog');
  await dialog.getByTestId('plan-entry-save').click();
  await expect(dialog).toBeHidden();
  await view.getByTestId('plan-add-entry').click();
  dialog = page.getByRole('dialog', { name: 'New cost entry' });
  await dialog.getByRole('textbox', { name: 'Amount' }).fill('50');
  await dialog.getByRole('textbox', { name: 'Reference' }).fill('PO-55790');
  await dialog.getByTestId('plan-entry-save').click();
  await expect(dialog).toBeHidden();

  // the year in EUR: 1,200 + 12 × 100 planned; the licence is paid, nothing of the support booked yet, 50 unplanned
  const eur = view.getByTestId('plan-currency-EUR');
  await expect(eur.getByTestId('plan-total-planned')).toContainText('€2,400.00');
  await expect(eur.getByTestId('plan-total-incurred')).toContainText('€1,250.00');
  if (start) {
    const cur = (new Date().getUTCMonth() + 1 - start + 12) % 12;
    const expected = 1200 + 100 * (12 - cur) + 50;
    await expect(eur.getByTestId('plan-total-expected')).toContainText(`€${expected.toLocaleString('en-GB')}.00`);
  }
  await expect(eur.getByTestId('plan-unplanned-total')).toContainText('1 unplanned entry');
  await expect(view.getByTestId('plan-entries').getByTestId('entry-unplanned').first()).toBeVisible();
  await expect(view.getByTestId('plan-entries')).toContainText('INV-88412');
  if (mobile) {
    await expect(view.getByTestId('plan-line-card').first()).toBeVisible();
    await expect(view.getByTestId('plan-entry-card').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  } else {
    await expect(eur.getByTestId('plan-chart')).toBeVisible();
    // the line's application links to it
    await expect(view.getByTestId('plan-lines').getByRole('link', { name: f.app.name })).toHaveAttribute('href', /\/applications\//);
  }
  await expectAccessible(page, 'cost plan: year');
  // grouped by application or system
  await view.getByTestId('plan-group').getByText('Application or system').click();
  await expect(view.getByTestId('plan-group-section').first()).toContainText(f.app.name);
  await expect(view.getByTestId('plan-group-section').nth(1)).toContainText('Not for one application or system');
  // the table twin of the chart
  await eur.getByRole('button', { name: 'Show as table' }).click();
  await expect(eur.getByTestId('plan-months')).toBeVisible();
  await expectAccessible(page, 'cost plan: months table');
  if (mobile) await expectNoHorizontalScroll(page);
}

test('cost plan: fiscal year start, plan lines, entries and the year view', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const before = await json<{ hideAmountsFromViewers: boolean; defaultCurrency: string; fiscalYearStartMonth: number }>(await api.get('/api/costs/settings'));
  const f = await fixture(api);
  try {
    // the fiscal year start (administrators)
    await page.goto('/costs');
    await page.getByTestId('cost-settings').click();
    const dialog = page.getByRole('dialog', { name: 'Cost settings' });
    await chooseOption(page, 'Fiscal year starts in', 'April');
    await expectAccessible(page, 'costs: settings with the fiscal year');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    expect((await json<{ fiscalYearStartMonth: number }>(await api.get('/api/costs/settings'))).fiscalYearStartMonth).toBe(4);
    await plan(page, f, false, 4);
    // the CSV export of the plan
    const csv = await api.get(`/api/costs/plans/${f.service.id}/export?what=plan`);
    expect(csv.ok()).toBe(true);
    expect(await csv.text()).toContain('Historian licences');
    // the service page links its tab below the base path
    await page.goto(`/services/${f.service.id}`);
    await expect(page.getByTestId('service-tab-costs')).toHaveAttribute('href', appHref(`/services/${f.service.id}/costs`));
  } finally {
    await api.put('/api/costs/settings', { data: before });
    await cleanup(api, f);
  }
});

test('cost plan on a phone @mobile', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const f = await fixture(api);
  try {
    await plan(page, f, true);
  } finally {
    await cleanup(api, f);
  }
});
