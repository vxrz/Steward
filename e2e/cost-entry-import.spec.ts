import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

/**
 * Import entries (CSV) (ADR 0030, docs/COSTS.md#importing-entries-csv): map the columns of an ERP export (date format
 * and decimal separator chosen), the preview with a problem and a duplicate, the import, and "Remove import" – on a
 * desktop and on a phone, with axe.
 */

async function fixture(api: APIRequestContext) {
  return json<{ id: string; name: string }>(await api.post('/api/services', { data: { name: uniq('Importing service') } }));
}

/** Today (UTC) as DD.MM.YYYY, as the ERP writes it. */
const todayDe = () => {
  const d = new Date().toISOString().slice(0, 10);
  return `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
};

async function flow(page: Page, service: { id: string }, mobile: boolean) {
  const day = todayDe();
  const csv = [
    'Belegdatum;Rechnungsnummer;Betrag;Währung;Text',
    `${day};ERP-1001;1.234,50;EUR;Support, this month`,
    `${day};ERP-1002;abc;EUR;A row without a number`,
    `${day};ERP-1001;1.234,50;EUR;The same invoice, sent twice`,
  ].join('\n');
  await page.goto(`/services/${service.id}/costs`);
  const view = page.getByTestId('service-cost-plan');
  await view.getByTestId('plan-import-entries').click();
  const dialog = page.getByRole('dialog', { name: 'Import entries (CSV)' });
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'erp-export.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  await chooseOption(page, /^Date( \*)?$/, 'Belegdatum');
  await chooseOption(page, /^Date format( \*)?$/, 'DD.MM.YYYY');
  await chooseOption(page, /^Amount( \*)?$/, 'Betrag');
  await chooseOption(page, /^Decimal separator( \*)?$/, 'Comma (1.234,56)');
  await chooseOption(page, /^Currency$/, 'Währung');
  await chooseOption(page, /^Reference$/, 'Rechnungsnummer');
  await chooseOption(page, /^Note$/, 'Text');
  await expectAccessible(page, 'entry import: mapping');
  await dialog.getByTestId('import-preview').click();
  const rows = dialog.getByTestId('import-preview-rows');
  await expect(rows.getByTestId('import-row')).toHaveCount(3);
  await expect(rows.getByTestId('import-problem')).toContainText('Not a number');
  await expect(rows.getByTestId('import-duplicate')).toBeVisible();
  await expect(dialog.getByTestId('import-run')).toContainText('Import 1 row');
  await expectAccessible(page, 'entry import: preview');
  if (mobile) await expectNoHorizontalScroll(page);
  await dialog.getByTestId('import-run').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('1 entry imported')).toBeVisible();
  await expect(view.getByTestId('plan-entries')).toContainText('ERP-1001');

  // the import is kept as a record; removing it removes its entries
  const imports = view.getByTestId('entry-imports');
  await expect(imports).toContainText('erp-export.csv');
  await imports.getByTestId('entry-import-remove').click();
  await page.getByRole('dialog', { name: 'Confirm removal' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Import removed')).toBeVisible();
  await expect(view.getByTestId('plan-entries')).toHaveCount(0);
  await expectAccessible(page, 'entry import: removed');
}

test('import entries: map, preview with a problem and a duplicate, import, remove', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const service = await fixture(api);
  try {
    await flow(page, service, false);
  } finally {
    await api.post(`/api/services/${service.id}/archive`, { data: { archived: true } });
  }
});

test('import entries on a phone @mobile', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const service = await fixture(api);
  try {
    await flow(page, service, true);
  } finally {
    await api.post(`/api/services/${service.id}/archive`, { data: { archived: true } });
  }
});
