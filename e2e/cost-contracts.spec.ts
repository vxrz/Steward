import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

/**
 * Contract payments (ADR 0030, docs/COSTS.md#contract-payments-and-commitments): a payment schedule with a price
 * change added on the supplier page, its lines confirmed for a fiscal year, the contract changed and the lines
 * updated, and the commitments page – on a desktop and on a phone, with axe.
 */

interface Fixture {
  service: { id: string; name: string };
  supplier: { id: string; name: string };
  contract: { id: string; title: string; startsOn: string; endsOn: string };
  fy: number;
  label: string;
}

async function fixture(api: APIRequestContext): Promise<Fixture> {
  const service = await json<{ id: string; name: string }>(await api.post('/api/services', { data: { name: uniq('Paying service') } }));
  // the next fiscal year: its fifth month starts the contract (part of the year, then a price change inside one)
  const now = await json<{ fiscalYear: number }>(await api.get(`/api/costs/plans/${service.id}`));
  const next = await json<{ fiscalYear: number; label: string; months: string[] }>(
    await api.get(`/api/costs/plans/${service.id}?fiscalYear=${now.fiscalYear + 1}`),
  );
  const startsOn = `${next.months[4]}-01`;
  const end = new Date(`${startsOn}T00:00:00Z`);
  end.setUTCFullYear(end.getUTCFullYear() + 3);
  end.setUTCDate(end.getUTCDate() - 1);
  const endsOn = end.toISOString().slice(0, 10);
  const supplier = await json<{ id: string; name: string }>(await api.post('/api/suppliers', { data: { name: uniq('Invented Gateway Ltd'), type: 'saas' } }));
  const title = 'Gateway subscription';
  const d = await json<{ contracts: { id: string }[] }>(
    await api.post(`/api/suppliers/${supplier.id}/contracts`, { data: { title, startsOn, endsOn, noticeDays: 90, renewal: 'fixedEnd' } }),
  );
  return { service, supplier, contract: { id: d.contracts[0]!.id, title, startsOn, endsOn }, fy: next.fiscalYear, label: next.label };
}

async function cleanup(api: APIRequestContext, f: Fixture) {
  await api.delete(`/api/suppliers/${f.supplier.id}/contracts/${f.contract.id}`);
  await api.post(`/api/suppliers/${f.supplier.id}/archive`, { data: { archived: true } });
  await api.post(`/api/services/${f.service.id}/archive`, { data: { archived: true } });
}

async function flow(page: Page, api: APIRequestContext, f: Fixture, mobile: boolean) {
  // ---- a payment schedule on the contract, +3 % per contract year ----
  await page.goto(`/suppliers/${f.supplier.id}`);
  const payments = page.getByTestId('contract-payments');
  await expect(payments).toContainText('No payment schedule yet');
  await payments.getByTestId('contract-payments-add').click();
  const dialog = page.getByRole('dialog', { name: /^Add payments/ });
  await dialog.getByTestId('schedule-title').fill('Base fee');
  await chooseOption(page, /^Paying service/, f.service.name);
  await dialog.getByTestId('schedule-amount').fill('1000');
  await dialog.getByTestId('schedule-currency').fill('EUR');
  await dialog.getByTestId('schedule-percent').fill('3');
  await dialog.getByTestId('schedule-fill').click();
  await expect(dialog.getByTestId('schedule-year-2')).toHaveValue('1030.00');
  await expect(dialog.getByTestId('schedule-year-3')).toHaveValue('1060.90');
  await expectAccessible(page, 'contract payments: dialog');
  await dialog.getByTestId('schedule-save').click();
  await expect(dialog).toBeHidden();
  await expect(payments.getByTestId('contract-schedule')).toContainText('Base fee');
  if (mobile) await expectNoHorizontalScroll(page);

  // ---- the cost plan of that fiscal year proposes the lines; a person confirms them ----
  await page.goto(`/services/${f.service.id}/costs`);
  const view = page.getByTestId('service-cost-plan');
  await chooseOption(page, 'Fiscal year', f.label);
  const proposals = view.getByTestId('plan-proposals');
  await expect(proposals).toContainText(`${f.contract.title} – Base fee`);
  await expectAccessible(page, 'cost plan: contract payments to plan');
  await proposals.getByTestId('plan-proposals-add').click();
  await expect(proposals).toBeHidden();
  await expect(view.getByTestId('plan-lines')).toContainText(`${f.contract.title} – Base fee`);
  await expect(view.getByTestId('service-contracts')).toContainText('Base fee');

  // ---- the contract ends earlier: Contract changed, Update lines ----
  const shorter = new Date(`${f.contract.startsOn}T00:00:00Z`);
  shorter.setUTCMonth(shorter.getUTCMonth() + 4);
  shorter.setUTCDate(shorter.getUTCDate() - 1);
  expect(
    (
      await api.put(`/api/suppliers/${f.supplier.id}/contracts/${f.contract.id}`, {
        data: { title: f.contract.title, startsOn: f.contract.startsOn, endsOn: shorter.toISOString().slice(0, 10), noticeDays: 90, renewal: 'fixedEnd' },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await chooseOption(page, 'Fiscal year', f.label);
  const changes = view.getByTestId('plan-contract-changes');
  await expect(changes).toContainText('Contract changed');
  await expect(view.getByTestId('plan-contract-changed').first()).toBeVisible();
  await expectAccessible(page, 'cost plan: contract changed');
  if (mobile) await expectNoHorizontalScroll(page);
  await changes.getByTestId('plan-update-lines').click();
  await expect(changes).toBeHidden();
  await expect(page.getByText('Lines updated')).toBeVisible();

  // ---- the commitments page ----
  await page.goto('/costs/commitments');
  await expect(page.getByTestId('commitments-page')).toContainText(f.supplier.name);
  await expect(page.getByTestId('commitments-page')).toContainText('Base fee');
  await page.getByTestId('commitments-group').getByText('Service', { exact: true }).click();
  await expect(page.getByTestId('commitment-group').filter({ hasText: f.service.name })).toBeVisible();
  await expectAccessible(page, 'commitments');
  if (mobile) await expectNoHorizontalScroll(page);
}

test('contract payments: a schedule, its lines confirmed, the contract changed, the commitments', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const f = await fixture(api);
  try {
    await flow(page, api, f, false);
  } finally {
    await cleanup(api, f);
  }
});

test('contract payments on a phone @mobile', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const f = await fixture(api);
  try {
    await flow(page, api, f, true);
  } finally {
    await cleanup(api, f);
  }
});
