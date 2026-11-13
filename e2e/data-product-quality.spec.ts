import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json } from './support/helpers';

/**
 * Quality and the scorecard over time (0.24.0, ADR 0036 phase 2, docs/DATA-PRODUCTS.md#quality-results): the monitor
 * editor's volume mode of the _Data element_ check (Check now against the demo Snowflake account records a quality
 * result), the element's quality panel, the personal fields of the bound contract on the product and the element, and
 * the maturity trend on the product's overview – with axe, and on a phone without sideways scroll.
 */

test.use({ storageState: authFile('dana') });

interface Seed {
  element: string;
  product: string;
}
let seeded: Promise<Seed> | null = null;

async function seed(admin: APIRequestContext): Promise<Seed> {
  expect((await admin.put('/api/settings/modules/dataProducts', { data: { enabled: true } })).ok()).toBe(true);
  const token = `Q${Date.now().toString(36).toUpperCase()}`;
  const platforms = await json<{ id: string; kind: string }[]>(await admin.get('/api/platforms'));
  const sf = platforms.find((p) => p.kind === 'snowflake')!.id;
  const found = await json<{ items: { id: string }[] }>(await admin.get(`/api/data-elements?platformId=${sf}&prefix=SHOP.SALES.ORDERS&environment=prod`));
  const element =
    found.items[0]?.id ??
    (
      await json<{ id: string }>(
        await admin.post('/api/data-elements', { data: { platformId: sf, kind: 'snowflake.table', qualifiedName: 'SHOP.SALES.ORDERS', environment: 'prod' } }),
      )
    ).id;
  const yaml = [
    'apiVersion: v3.0.2',
    'kind: DataContract',
    `id: ${token.toLowerCase()}-orders`,
    `name: Invented orders ${token}`,
    'version: 1.0.0',
    'status: active',
    'schema:',
    '  - name: orders',
    '    properties:',
    '      - name: customer_email',
    '        logicalType: string',
    '        classification: confidential',
    '        customProperties: [{ property: personalData, value: true }]',
    '',
  ].join('\n');
  const contract = (await json<{ id: string }>(await admin.post('/api/data-contracts', { data: { yaml, links: [] } }))).id;
  const product = (await json<{ id: string }>(await admin.post('/api/data-products', { data: { key: `${token.toLowerCase()}-q`, name: `Quality ${token}` } })))
    .id;
  const port = (
    await json<{ id: string }>(await admin.post(`/api/data-products/${product}/ports`, { data: { direction: 'output', name: 'orders', type: 'table' } }))
  ).id;
  const bound = await admin.put(`/api/data-products/${product}/ports/${port}/bindings/prod`, {
    data: { elementIds: [element], contractId: contract, objectives: { completenessPct: 95 } },
  });
  expect(bound.ok(), await bound.text()).toBe(true);
  return { element, product };
}

test.describe('quality of data products', () => {
  let s: Seed;
  test.beforeEach(async ({ apiAs }) => {
    seeded ??= (async () => seed(await apiAs('admin')))();
    s = await seeded;
  });

  test('the volume mode in the monitor editor, the element’s quality and personal fields', async ({ page }) => {
    await page.goto('/monitors/new');
    await settle(page);
    const form = page.getByTestId('check-form');
    await page.getByLabel('Check palette').getByRole('button', { name: 'Data element', exact: true }).click();
    await form.getByRole('combobox', { name: /^Data element/ }).fill('SALES.ORDERS');
    await page.getByRole('option', { name: /SHOP\.SALES\.ORDERS \(prod\)/ }).click();
    await chooseOption(page, 'What is checked', 'Volume');
    await expect(form.getByRole('textbox', { name: 'Growth at least' })).toBeVisible();
    await form.getByRole('button', { name: 'Check now' }).click();
    await expect(form.getByTestId('check-preview')).toContainText('rows');
    await expectAccessible(page, 'monitor editor: volume mode');
    // the reading is a completeness result of the element
    await page.goto(`/data-elements/${s.element}`);
    const quality = page.getByTestId('element-quality');
    await expect(quality).toContainText('volume:rows');
    await expect(quality).toContainText('Completeness');
    // each result with what was measured (the row count of the volume reading)
    await expect(quality.getByRole('columnheader', { name: 'Value' })).toBeVisible();
    await expect(quality.getByTestId('quality-result').filter({ hasText: 'volume:rows' }).getByRole('cell').nth(3)).toHaveText(/^[\d,]+$/);
    await expect(page.getByTestId('personal-fields')).toContainText('orders.customer_email');
    await settle(page);
    await expectAccessible(page, 'element quality');
  });

  test('the product’s personal fields, maturity trend and completeness objective', async ({ page }) => {
    await page.goto(`/data-products/${s.product}`);
    await expect(page.getByTestId('personal-fields')).toContainText('Personal');
    await expect(page.getByTestId('product-scorecard-trend')).toBeVisible();
    await expect(page.getByTestId('scorecard-confidentiality')).toBeVisible();
    await page.getByTestId('product-tab-ports').click();
    await expect(page.getByText('95 % complete').first()).toBeVisible();
    await page.getByTestId('product-tab-overview').click();
    await settle(page);
    await expectAccessible(page, 'product overview with quality');
  });

  test('the maturity trend of the demo’s Orders: a picture of the days with a table beside it', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    const list = await json<{ items: { id: string; key: string }[] }>(await admin.get('/api/data-products?q=orders&limit=50'));
    const orders = list.items.find((p) => p.key === 'orders')!.id;
    await page.goto(`/data-products/${orders}`);
    const trend = page.getByTestId('product-scorecard-trend');
    // the demo's history: 30 days behind today, maturity that rose twice
    const picture = trend.getByTestId('scorecard-trend-picture');
    await expect(picture).toBeVisible();
    await expect(picture).toHaveAttribute('aria-label', /: 0 at the start, 2 now$/);
    await trend.getByText('Table', { exact: true }).click();
    const rows = trend.getByTestId('scorecard-trend-table').getByRole('row');
    await expect(rows).toHaveCount(32);
    await expect(rows.nth(1)).toContainText('Maturity 2');
    await expect(rows.last()).toContainText('Maturity 0');
    await settle(page);
    await expectAccessible(page, 'maturity trend', { wcag22: true });
  });

  test('quality on a phone @mobile', async ({ page }) => {
    await page.goto(`/data-products/${s.product}`);
    await expect(page.getByTestId('personal-fields')).toBeVisible();
    // a card per field, no table
    await expect(page.getByTestId('personal-fields').getByTestId('personal-field').first()).toBeVisible();
    await expect(page.getByTestId('personal-fields').locator('table')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await page.goto(`/data-elements/${s.element}`);
    // a card per result on a phone
    await expect(page.getByTestId('element-quality').getByTestId('quality-result').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
