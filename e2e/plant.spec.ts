import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll } from './support/helpers';

/**
 * The plant registry (#218, opt-in module): turned on, the demo loads its invented enterprise (two sites, their
 * hierarchy, buildings and assets). The pages – sites, a site with its ISA-95 tree and buildings, assets with filters,
 * an asset with its location and equipment, the import with its preview – on a desktop and on a phone, with axe.
 */

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };

/** The module on (idempotent; the first time the demo enterprise is imported). */
async function plantOn(api: APIRequestContext) {
  const res = await api.put('/api/settings/plant', { data: SETTINGS });
  expect(res.ok(), await res.text()).toBe(true);
}

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });

test.describe('as an administrator', () => {
  test.use({ storageState: authFile('admin') });

  test('Settings → Modules holds the switch; on, the sidebar has the Plant area', async ({ page, apiAs }) => {
    await plantOn(await apiAs('admin'));
    await page.goto('/settings/modules');
    const card = page.getByTestId('plant-settings');
    await expect(card.getByRole('heading', { name: 'Plant registry' })).toBeVisible();
    await expect(card.getByRole('switch', { name: 'Turn on the plant registry' })).toBeChecked();
    await expect(card.getByRole('textbox', { name: 'Enterprise' })).toHaveValue('Brightwater Components');
    await card.getByRole('button', { name: 'Own fields' }).click();
    await expect(card.getByRole('button', { name: 'Add field' }).first()).toBeVisible();
    await expectAccessible(page, 'plant registry settings');
    const plant = sidebar(page).getByRole('group', { name: 'Plant', exact: true });
    const toggle = plant.getByRole('button', { name: 'Plant', exact: true });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(plant.getByRole('link', { name: 'Sites' })).toBeVisible();
    await expect(plant.getByRole('link', { name: 'Assets' })).toBeVisible();
    await expect(plant.getByRole('link', { name: 'Import' })).toBeVisible();
  });
});

test.describe('as a designer', () => {
  test.use({ storageState: authFile('dana') });
  test.beforeEach(async ({ apiAs }) => plantOn(await apiAs('admin')));

  test('the sites, and a site with its hierarchy and buildings', async ({ page }) => {
    await page.goto('/plant/sites');
    await expect(page.getByRole('heading', { name: /Sites/ })).toBeVisible();
    const table = page.getByTestId('plant-site-table');
    await expect(table.getByRole('link', { name: 'Riverside Works', exact: true })).toBeVisible();
    await expect(table.getByRole('link', { name: 'Hillcrest Plant', exact: true })).toBeVisible();
    // the position links to OpenStreetMap (no map library)
    await expect(table.getByRole('link', { name: /Riverside Works in OpenStreetMap/ })).toHaveAttribute('href', /openstreetmap\.org/);
    await expectAccessible(page, 'plant sites');

    await table.getByRole('link', { name: 'Riverside Works', exact: true }).click();
    await expect(page).toHaveURL(/\/plant\/sites\/riverside$/);
    const tree = page.getByTestId('plant-hierarchy');
    await expect(tree.getByTestId('node-rvs-machining')).toContainText('Machining');
    // the work unit inherits the building of its work center; the test bench names its own floor
    await expect(tree.getByTestId('node-rvs-mill-line-1-cell-1').getByTestId('node-building').first()).toHaveText('Hall 1');
    await expect(tree.getByTestId('node-rvs-final-assembly-test').getByTestId('node-building').first()).toHaveText('Hall 2, mezzanine');
    await expect(page.getByTestId('plant-buildings')).toContainText('Yard');
    await expectAccessible(page, 'plant site');

    // add an area and remove it again
    await tree.getByRole('button', { name: 'Add area' }).click();
    const dialog = page.getByRole('dialog', { name: 'New area' });
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E paint shop');
    await expect(dialog.getByRole('textbox', { name: 'Id' })).toHaveValue('e2e-paint-shop');
    await expectAccessible(page, 'new area dialog');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    const node = tree.getByTestId('node-e2e-paint-shop');
    await expect(node).toContainText('E2E paint shop');
    await node.getByRole('button', { name: 'Actions for E2E paint shop' }).click();
    await page.getByRole('menuitem', { name: 'Remove' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
    await expect(node).toBeHidden();
  });

  test('assets: filters in the address, an asset with its location, equipment and references', async ({ page }) => {
    await page.goto('/plant/assets?site=riverside');
    const table = page.getByTestId('plant-asset-table');
    await expect(table.getByRole('link', { name: 'Milling centre 1', exact: true })).toBeVisible();
    await expect(table.getByRole('link', { name: 'Moulding machine 1' })).toBeHidden();
    await page.getByRole('combobox', { name: 'Status' }).click();
    await page.getByRole('option', { name: 'Maintenance' }).click();
    await expect(page).toHaveURL(/status=maintenance/);
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table).toContainText('Milling centre 3');
    await expectAccessible(page, 'plant assets');

    await page.goto('/plant/assets/rvs-mill-01');
    await expect(page.getByRole('heading', { name: /Milling centre 1/ })).toBeVisible();
    const location = page.getByTestId('asset-location');
    await expect(location.getByRole('link', { name: 'Riverside Works', exact: true })).toBeVisible();
    await expect(location.getByRole('link', { name: 'Milling cell 1' })).toBeVisible();
    await expect(location).toContainText('Hall 1');
    await expect(page.getByTestId('asset-equipment').getByRole('link', { name: 'Power meter of milling centre 1' })).toBeVisible();
    await expect(page.getByTestId('external-refs')).toContainText('EQ-2231');
    await expect(page.getByTestId('asset-capabilities')).toContainText('5-axis simultaneous milling');
    await expectAccessible(page, 'plant asset');
    // the part names its parent
    await page.getByTestId('asset-equipment').getByRole('link', { name: 'Power meter of milling centre 1' }).click();
    await expect(page.getByTestId('asset-equipment').getByRole('link', { name: /Milling centre 1/ })).toBeVisible();
  });

  test('an import shows what changes before it is applied', async ({ page, apiAs }) => {
    const id = `e2e-press-${Date.now()}`;
    const yaml = `version: 1\nassets:\n  - id: ${id}\n    name: E2E press\n    status: planned\n    location:\n      site: hillcrest\n      area: hlc-logistics\n`;
    await page.goto('/plant/import');
    await expect(page.getByRole('heading', { name: /Import YAML/ })).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({ name: 'e2e-press.yaml', mimeType: 'application/yaml', buffer: Buffer.from(yaml) });
    await expect(page.getByTestId('import-files')).toContainText('e2e-press.yaml');
    await page.getByTestId('mode-add').click();
    await page.getByTestId('import-preview').click();
    const result = page.getByTestId('import-preview-result');
    await expect(result.getByTestId('import-counts')).toContainText('Add: 1');
    await expect(result.getByTestId('import-changes')).toContainText('E2E press');
    await expectAccessible(page, 'plant import preview');
    await result.getByTestId('import-apply').click();
    await expect(page.getByTestId('import-result')).toContainText('1 added');
    await expect(page.getByTestId('import-history')).toContainText('e2e-press.yaml');
    const api = await apiAs('dana');
    const a = await api.get(`/api/plant/assets/${id}`);
    expect(a.ok()).toBe(true);
    await api.delete(`/api/plant/assets/${id}`);
  });
});

test.describe('as a viewer', () => {
  test.use({ storageState: authFile('vera') });
  test.beforeEach(async ({ apiAs }) => plantOn(await apiAs('admin')));

  test('the registry is read-only: no new site, no import', async ({ page }) => {
    await page.goto('/plant/sites');
    await expect(page.getByTestId('plant-site-table').getByRole('link', { name: 'Riverside Works', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /New site/ })).toBeHidden();
    await expect(page.getByRole('link', { name: 'Import', exact: true })).toBeHidden();
    await page.goto('/plant/sites/riverside');
    await expect(page.getByTestId('plant-hierarchy').getByRole('button', { name: 'Add area' })).toBeHidden();
    await expect(page.getByTestId('site-access')).toBeHidden();
    await expectAccessible(page, 'plant site (viewer)');
  });
});

test.describe('on a phone', () => {
  test.use({ storageState: authFile('dana') });
  test.beforeEach(async ({ apiAs }) => plantOn(await apiAs('admin')));

  test('sites, a site, assets, an asset and the import fit the screen @mobile', async ({ page }) => {
    await page.goto('/plant/sites');
    await expect(page.getByTestId('plant-site-cards').getByRole('link', { name: 'Riverside Works', exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'plant sites on a phone');
    await page.goto('/plant/sites/riverside');
    await expect(page.getByTestId('plant-hierarchy').getByTestId('node-rvs-machining')).toBeVisible();
    await settle(page);
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'plant site on a phone');
    await page.goto('/plant/assets');
    // the filters fold behind a button
    await expect(page.getByRole('button', { name: 'Filters' })).toBeVisible();
    await expect(page.getByTestId('plant-asset-cards').getByRole('link', { name: 'Milling centre 1', exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'plant assets on a phone');
    await page.goto('/plant/assets/rvs-test-bench-01');
    await expect(page.getByTestId('asset-location')).toContainText('Hall 2, mezzanine');
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'plant asset on a phone');
    await page.goto('/plant/import');
    await expect(page.getByTestId('import-choose')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'plant import on a phone');
  });
});
