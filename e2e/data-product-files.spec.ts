import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json } from './support/helpers';

/**
 * Object storage and large imports (0.25.0, ADR 0037 part 2, docs/DATA-PRODUCTS.md#object-storage): the demo's S3
 * landing prefix with its readout (objects, format, partitions), the file-based product _Sales files_ with its file
 * port (format, partitioning, the S3 location as the ODCS server) and its form, a discovery source on the AWS account
 * with S3 prefixes, and an import of more than 1,000 elements that runs in the background with its progress – with
 * axe, and on a phone without sideways scroll.
 */

test.use({ storageState: authFile('dana') });

test.beforeAll(async ({ apiAs }) => {
  const admin = await apiAs('admin');
  expect((await admin.put('/api/settings/modules/dataProducts', { data: { enabled: true } })).ok()).toBe(true);
});

async function idOf(api: APIRequestContext, url: string): Promise<string> {
  const page = await json<{ items: { id: string; qualifiedName?: string; key?: string }[] }>(await api.get(url));
  return page.items[0]!.id;
}

test('an S3 prefix: its objects, format and partitions from the listing', async ({ page, apiAs }) => {
  const dana = await apiAs('dana');
  const id = await idOf(dana, `/api/data-elements?kind=files.path&prefix=${encodeURIComponent('s3://invented-landing.example/orders/')}`);
  await page.goto(`/data-elements/${id}`);
  await settle(page);
  const readout = page.getByTestId('element-readout');
  await expect(readout).toContainText('Objects');
  await expect(readout).toContainText('Parquet');
  await expect(readout).toContainText('Partitioned by');
  await expect(readout).toContainText('dt');
  await expectAccessible(page, 'S3 prefix element');
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalScroll(page);
});

test('the file port of Sales files: format, partitioning and the S3 location; its form', async ({ page, apiAs }) => {
  const dana = await apiAs('dana');
  const id = await idOf(dana, '/api/data-products?q=Sales%20files');
  await page.goto(`/data-products/${id}/ports`);
  await settle(page);
  const port = page.getByTestId('port-daily sales files');
  await expect(port.getByTestId('port-files')).toContainText('CSV files · partitioned by dt');
  await expect(port.getByTestId('binding-object-storage')).toContainText('s3://invented-shop-lake.example/exports/daily-sales/');
  await expectAccessible(page, 'file port');
  await port.getByRole('button', { name: 'Change the port daily sales files' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('port-file-format')).toHaveValue('CSV');
  await expect(dialog.getByTestId('port-partitioning')).toBeVisible();
  await expectAccessible(page, 'file port form');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalScroll(page);
});

test('a discovery source on the AWS account names S3 prefixes', async ({ page }) => {
  await page.goto('/data-products/discovery');
  await settle(page);
  await page.getByTestId('source-new').first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByTestId('source-name').fill('Invented lake');
  await chooseOption(page, /^Platform/, 'AWS (demo)');
  await expect(dialog.getByText(/S3 prefixes as s3:\/\/bucket\/prefix\//)).toBeVisible();
  const scope = dialog.getByTestId('source-scope');
  await scope.fill('invented-shop-lake.example/raw');
  await scope.press('Enter');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByText('Name S3 prefixes as s3://bucket/prefix/')).toBeVisible();
  await expectAccessible(page, 'discovery source on AWS');
});

test('an import of more than 1,000 elements runs in the background with its progress', async ({ page }) => {
  const tag = `F${Date.now().toString(36).toUpperCase()}`;
  const file = JSON.stringify({
    version: 1,
    elements: Array.from({ length: 1_200 }, (_, i) => ({ kind: 'other', qualified_name: `INVENTED.${tag}.T${i}`, environment: 'prod' })),
  });
  await page.goto('/data-products');
  await settle(page);
  await page.getByTestId('products-transfer').click();
  await page.getByTestId('products-import').click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'many.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  await dialog.getByTestId('import-preview-run').click();
  await expect(dialog.getByTestId('import-count-add')).toContainText(/1,?200/);
  await dialog.getByTestId('import-run').click();
  await expect(page.getByText(/1,?200 added/)).toBeVisible({ timeout: 60_000 });
});
