import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll, uniq } from './support/helpers';

/**
 * Changing ids and many entries at once in the plant registry (0.11.0): the "Change id" dialog with live checking and
 * what refers to the entry, an old address that leads to the new one, the old ids in the settings, the import's id
 * mapping step with renames and removals in the preview, and Edit selected / Remove selected in the asset list – on a
 * desktop and on a phone, with axe. Every test works on entries of its own (other specs use the demo enterprise).
 */

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };

async function plantOn(api: APIRequestContext) {
  const res = await api.put('/api/settings/plant', { data: SETTINGS });
  expect(res.ok(), await res.text()).toBe(true);
}

/** A site of its own with assets (ids `<site>-a1` …). */
async function siteWithAssets(api: APIRequestContext, n: number): Promise<{ site: string; assets: string[] }> {
  const site = uniq('e2e-ids').toLowerCase().replace(' ', '-');
  const s = await api.post('/api/plant/sites', { data: { id: site, name: `Site ${site}` } });
  expect(s.ok(), await s.text()).toBe(true);
  const assets: string[] = [];
  for (let i = 1; i <= n; i++) {
    const id = `${site}-a${i}`;
    const a = await api.post('/api/plant/assets', { data: { id, name: `Machine ${i} of ${site}`, siteId: site } });
    expect(a.ok(), await a.text()).toBe(true);
    assets.push(id);
  }
  return { site, assets };
}

test.describe('as a designer', () => {
  test.use({ storageState: authFile('dana') });
  test.beforeEach(async ({ apiAs }) => plantOn(await apiAs('admin')));

  test('Change id: checked while typing, shows what follows, and the old address leads to the new one', async ({ page, apiAs }) => {
    const { site } = await siteWithAssets(await apiAs('dana'), 2);
    await page.goto(`/plant/sites/${site}`);
    await page.getByTestId('detail-actions').click();
    await page.getByTestId('change-id').click();
    const dialog = page.getByRole('dialog', { name: /Change the id of/ });
    const input = dialog.getByTestId('change-id-input');
    await input.fill('Not An Id');
    await expect(dialog).toContainText('Use lower-case letters');
    await expect(dialog.getByTestId('change-id-confirm')).toBeDisabled();
    await input.fill(`${site}-new`);
    const preview = dialog.getByTestId('change-id-preview');
    await expect(preview).toContainText('2 assets');
    await expect(preview).toContainText(`${site} still leads here`);
    await expectAccessible(page, 'change id dialog');
    await dialog.getByTestId('change-id-confirm').click();
    await expect(page).toHaveURL(new RegExp(`/plant/sites/${site}-new$`));
    // a bookmark with the old id
    await page.goto(`/plant/sites/${site}`);
    await expect(page).toHaveURL(new RegExp(`/plant/sites/${site}-new$`));
    await expect(page.getByRole('heading', { name: `Site ${site}` })).toBeVisible();
  });

  test('Change id of an area from its menu in the site tree', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const { site } = await siteWithAssets(api, 0);
    const n = await api.post(`/api/plant/sites/${site}/nodes`, { data: { id: `${site}-area`, level: 'area', name: 'Paint shop' } });
    expect(n.ok(), await n.text()).toBe(true);
    await page.goto(`/plant/sites/${site}`);
    const tree = page.getByTestId('plant-hierarchy');
    await tree.getByRole('button', { name: 'Actions for Paint shop' }).click();
    await page.getByTestId(`change-id-${site}-area`).click();
    const dialog = page.getByRole('dialog', { name: 'Change the id of “Paint shop”' });
    await dialog.getByTestId('change-id-input').fill(`${site}-paint`);
    await expect(dialog.getByTestId('change-id-preview')).toBeVisible();
    await dialog.getByTestId('change-id-confirm').click();
    await expect(dialog).toBeHidden();
    await expect(tree.getByTestId(`node-${site}-paint`)).toContainText('Paint shop');
    await expect(page).toHaveURL(new RegExp(`/plant/sites/${site}$`));
  });

  test('the import maps old to new ids: renames in the preview, apart from the other changes', async ({ page, apiAs }) => {
    const { site, assets } = await siteWithAssets(await apiAs('dana'), 2);
    const yaml = `version: 1\nassets:\n${assets.map((a, i) => `  - id: ${a}\n    name: Machine ${i + 1} of ${site}\n    status: maintenance\n    location: { site: ${site} }\n`).join('')}`;
    await page.goto('/plant/import');
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({ name: 'ids.yaml', mimeType: 'application/yaml', buffer: Buffer.from(yaml) });
    const mapping = page.getByTestId('import-id-mapping');
    await mapping.getByTestId('import-id-mapping-toggle').click();
    await mapping.getByTestId('import-id-map').fill(assets.map((a) => `asset,${a},${a}-renamed`).join('\n'));
    await expect(mapping.getByTestId('import-id-map-count')).toHaveText('2 ids read');
    await page.getByTestId('mode-update').click();
    await page.getByTestId('import-preview').click();
    const result = page.getByTestId('import-preview-result');
    await expect(result.getByTestId('import-renames')).toContainText(`${assets[0]} → ${assets[0]}-renamed`);
    await expect(result).toContainText('confirm that it is you');
    await expect(result.getByTestId('import-counts')).not.toContainText('Add');
    await expectAccessible(page, 'import with id mapping');
    await result.getByTestId('import-apply').click();
    await expect(page.getByTestId('import-result')).toBeVisible();
    const api = await apiAs('dana');
    const a = await (await api.get(`/api/plant/assets/${assets[0]}-renamed`)).json();
    expect(a.status).toBe('maintenance');
  });

  test('the import removes entries that are not in the files, only with what belongs to them when asked', async ({ page, apiAs }) => {
    const { site, assets } = await siteWithAssets(await apiAs('dana'), 3);
    const yaml = `version: 1\nsite:\n  id: ${site}\n  name: Site ${site}\n  assets:\n    - id: ${assets[0]}\n      name: Machine 1 of ${site}\n`;
    await page.goto('/plant/import');
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({ name: 'site.yaml', mimeType: 'application/yaml', buffer: Buffer.from(yaml) });
    await page.getByTestId('import-id-mapping-toggle').click();
    await page.getByTestId('import-remove-missing').check();
    await page.getByTestId('mode-update').click();
    await page.getByTestId('import-preview').click();
    const removals = page.getByTestId('import-removals');
    await expect(removals).toContainText('2 entries are removed');
    await expect(removals).toContainText(assets[2]!);
    await expectAccessible(page, 'import with removals');
    await page.getByTestId('import-preview-result').getByTestId('import-apply').click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page.getByTestId('import-result')).toBeVisible();
    const api = await apiAs('dana');
    expect((await api.get(`/api/plant/assets/${assets[1]}`)).status()).toBe(404);
    expect((await api.get(`/api/plant/assets/${assets[0]}`)).ok()).toBe(true);
  });

  test('Edit selected and Remove selected in the asset list, each with a preview', async ({ page, apiAs }) => {
    const { site, assets } = await siteWithAssets(await apiAs('dana'), 3);
    await page.goto(`/plant/assets?site=${site}`);
    const table = page.getByTestId('plant-asset-table');
    await expect(table.getByRole('link', { name: `Machine 1 of ${site}` })).toBeVisible();
    await table.getByTestId('select-all').check();
    const bar = page.getByTestId('bulk-bar');
    await expect(bar).toContainText('3 selected');
    await bar.getByTestId('bulk-edit').click();
    const dialog = page.getByRole('dialog', { name: 'Edit 3 entries' });
    await dialog.getByTestId('bulk-field-status').click();
    await page.getByRole('option', { name: 'Maintenance' }).click();
    await dialog.getByTestId('bulk-preview-button').click();
    await expect(dialog.getByTestId('bulk-preview')).toContainText('Changes: 3');
    await expectAccessible(page, 'bulk edit preview');
    await dialog.getByTestId('bulk-apply').click();
    await expect(dialog).toBeHidden();
    await expect(table.getByText('Maintenance')).toHaveCount(3);
    // remove two of them
    await table.getByTestId(`select-${assets[2]}`).uncheck();
    await bar.getByTestId('bulk-remove').click();
    const remove = page.getByRole('dialog', { name: 'Remove 2 entries' });
    await expect(remove.getByTestId('bulk-preview')).toContainText('Removed: 2');
    await expect(remove).toContainText('confirm that it is you');
    await expectAccessible(page, 'bulk remove preview');
    await remove.getByTestId('bulk-apply').click();
    await expect(remove).toBeHidden();
    await expect(table.getByRole('link', { name: `Machine 1 of ${site}` })).toBeHidden();
    await expect(table.getByRole('link', { name: `Machine 3 of ${site}` })).toBeVisible();
  });
});

test.describe('as an administrator', () => {
  test.use({ storageState: authFile('admin') });

  test('the old ids are listed in the plant settings and can be removed', async ({ page, apiAs }) => {
    const api = await apiAs('admin');
    await plantOn(api);
    const { site } = await siteWithAssets(api, 0);
    const r = await api.post('/api/plant/ids/rename', { data: { kind: 'site', id: site, newId: `${site}-x` } });
    expect(r.ok(), await r.text()).toBe(true);
    await page.goto('/settings/modules');
    const card = page.getByTestId('plant-aliases');
    const row = card
      .getByRole('row')
      .filter({ hasText: site })
      .filter({ hasText: `${site}-x` })
      .first();
    await expect(row).toBeVisible();
    await expectAccessible(page, 'plant old ids');
    await row.getByRole('button', { name: `Remove old id ${site}` }).click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(card.getByRole('row').filter({ hasText: `${site}-x` })).toHaveCount(0);
  });
});

test.describe('on a phone', () => {
  test.use({ storageState: authFile('dana') });
  test.beforeEach(async ({ apiAs }) => plantOn(await apiAs('admin')));

  test('the Change id dialog, the selection of assets and the import mapping fit the screen @mobile', async ({ page, apiAs }) => {
    const { site, assets } = await siteWithAssets(await apiAs('dana'), 2);
    await page.goto(`/plant/assets/${assets[0]}`);
    await page.getByTestId('detail-actions').click();
    await page.getByTestId('change-id').click();
    const dialog = page.getByRole('dialog', { name: /Change the id of/ });
    await dialog.getByTestId('change-id-input').fill(`${assets[0]}-m`);
    await expect(dialog.getByTestId('change-id-preview')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'change id dialog on a phone');
    await page.keyboard.press('Escape');
    await page.goto(`/plant/assets?site=${site}`);
    const cards = page.getByTestId('plant-asset-cards');
    await cards.getByTestId(`select-${assets[1]}`).check();
    await expect(page.getByTestId('bulk-bar')).toContainText('1 selected');
    await settle(page);
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'asset selection on a phone');
    await page.goto('/plant/import');
    await page.getByTestId('import-id-mapping-toggle').click();
    await page.getByTestId('import-id-add-rule').click();
    await expect(page.getByTestId('import-id-rule-0')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'import mapping on a phone');
  });
});
