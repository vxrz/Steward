import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { FISCAL_YEAR_LOCK, FISCAL_YEAR_TIMEOUT, chooseOption, expectNoHorizontalScroll, json, uniq, withLock } from './support/helpers';

test.use({ storageState: authFile('admin') });

/**
 * Cost attribution, platform cost plans and volumes (ADR 0032, docs/COSTS.md#planning-per-platform): a platform's cost
 * plan with a line added in the app, the contract covering the platform and its prepaid volume, the commitments page
 * filtered by the platform, and an application's "Costs and contracts" – on a desktop and on a phone, with axe.
 */

interface Fixture {
  platform: { id: string; name: string };
  supplier: { id: string; name: string };
  contract: { id: string; title: string };
  app: { id: string; name: string };
  service: { id: string; name: string };
}

async function fixture(api: APIRequestContext): Promise<Fixture> {
  const platform = await json<{ id: string; name: string }>(
    await api.post('/api/platforms', { data: { name: uniq('Capacity platform'), kind: 'rest', baseUrl: 'https://capacity.example.com' } }),
  );
  const supplier = await json<{ id: string; name: string }>(
    await api.post('/api/suppliers', { data: { name: uniq('Invented Capacity AG'), type: 'serviceProvider' } }),
  );
  const today = new Date();
  const start = new Date(today.getTime() - 60 * 86_400_000).toISOString().slice(0, 10);
  const end = new Date(today.getTime() + 300 * 86_400_000).toISOString().slice(0, 10);
  const title = 'Platform capacity';
  const d = await json<{ contracts: { id: string; title: string }[] }>(
    await api.post(`/api/suppliers/${supplier.id}/contracts`, {
      data: { title, startsOn: start, endsOn: end, renewal: 'fixedEnd', platforms: [{ platformId: platform.id, purpose: 'Capacity' }] },
    }),
  );
  const contract = d.contracts.find((c) => c.title === title)!;
  expect(
    (
      await api.post('/api/costs/schedules', {
        data: {
          contractId: contract.id,
          platformId: platform.id,
          title: 'Prepaid capacity',
          category: 'cloud',
          amount: '5000',
          currency: 'USD',
          billing: 'volume',
          volume: { per: 'term', billing: 'prepaid', committed: 'full' },
        },
      })
    ).ok(),
  ).toBe(true);
  // an application of a service, named by a plan line of that service
  const app = await json<{ id: string; name: string }>(await api.post('/api/applications', { data: { name: uniq('Attributed app') } }));
  const service = await json<{ id: string; name: string }>(await api.post('/api/services', { data: { name: uniq('Attributing service') } }));
  await api.put(`/api/services/${service.id}/applications/${app.id}`, { data: {} });
  const plan = await json<{ fiscalYear: number }>(await api.get(`/api/costs/plans/${service.id}`));
  expect(
    (
      await api.post(`/api/costs/plans/${service.id}/lines`, {
        data: {
          fiscalYear: plan.fiscalYear,
          title: 'App licence',
          category: 'licence',
          amount: '1200',
          currency: 'EUR',
          cadence: 'yearly',
          target: { kind: 'application', id: app.id },
        },
      })
    ).ok(),
  ).toBe(true);
  return { platform, supplier, contract, app, service };
}

async function cleanup(api: APIRequestContext, f: Fixture) {
  await api.delete(`/api/suppliers/${f.supplier.id}/contracts/${f.contract.id}`);
  await api.post(`/api/suppliers/${f.supplier.id}/archive`, { data: { archived: true } });
  await api.delete(`/api/platforms/${f.platform.id}`);
  await api.post(`/api/services/${f.service.id}/archive`, { data: { archived: true } });
}

async function flow(page: Page, f: Fixture, mobile: boolean) {
  // ---- the platform's own cost plan ----
  await page.goto(`/platforms/${f.platform.id}?tab=costPlan`);
  const view = page.getByTestId('platform-cost-plan');
  await expect(view).toBeVisible();
  await expect(view.getByTestId('plan-volumes')).toContainText('Prepaid capacity');
  await expect(page.getByTestId('platform-contracts')).toContainText(f.contract.title);
  await view.getByTestId('plan-add-line').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByTestId('plan-line-title').fill('Support subscription');
  await dialog.getByTestId('plan-line-amount').fill('6000');
  await dialog.getByTestId('plan-line-currency').fill('USD');
  // a platform's lines name no application, system or platform
  await expect(dialog.getByTestId('plan-line-target')).toHaveCount(0);
  await expectAccessible(page, 'platform cost plan: line dialog');
  await dialog.getByTestId('plan-line-save').click();
  await expect(dialog).toBeHidden();
  await expect(view.getByTestId('plan-lines')).toContainText('Support subscription');
  await expectAccessible(page, 'platform cost plan');
  if (mobile) await expectNoHorizontalScroll(page);

  // ---- the commitments of the platform ----
  await page.goto('/costs/commitments');
  if (mobile) await page.getByRole('button', { name: /Filters/ }).click();
  await chooseOption(page, 'Platform', f.platform.name);
  const rows = page.getByTestId('commitments-page');
  await expect(rows.getByTestId('commitment-payer').first()).toContainText(f.platform.name);
  await expect(rows.getByTestId('volume-use').first()).toBeVisible();
  await expectAccessible(page, 'commitments of a platform');
  if (mobile) await expectNoHorizontalScroll(page);

  // ---- an application's costs and contracts ----
  await page.goto(`/applications/${f.app.id}`);
  const panel = page.getByTestId('application-costs');
  await expect(panel).toContainText('Costs and contracts');
  await expect(panel.getByTestId('attribution-lines')).toContainText('App licence');
  await expect(panel.getByTestId('attribution-totals')).toContainText('EUR');
  await expectAccessible(page, 'application costs and contracts');
  if (mobile) await expectNoHorizontalScroll(page);
}

test('platform cost plan, its volume and commitments, an application’s costs and contracts', async ({ page, apiAs }) => {
  test.setTimeout(FISCAL_YEAR_TIMEOUT);
  await withLock(FISCAL_YEAR_LOCK, async () => {
    const api = await apiAs('admin');
    const f = await fixture(api);
    try {
      await flow(page, f, false);
    } finally {
      await cleanup(api, f);
    }
  });
});

test('platform cost plan on a phone @mobile', async ({ page, apiAs }) => {
  test.setTimeout(FISCAL_YEAR_TIMEOUT);
  await withLock(FISCAL_YEAR_LOCK, async () => {
    const api = await apiAs('admin');
    const f = await fixture(api);
    try {
      await flow(page, f, true);
    } finally {
      await cleanup(api, f);
    }
  });
});
