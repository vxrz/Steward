import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll } from './support/helpers';

/**
 * The plant registry, part 2 (#219): device profiles with their interfaces and data points, a data point and who
 * delivers it, KPI definitions, an asset's data and KPI instances with what Steward checks, the search and the checks
 * page – on a desktop and on a phone, with axe. The demo loads invented profiles, KPI definitions and assignments;
 * milling centre 2 has a KPI instance whose interface is not set up (a check problem on purpose).
 */

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };

async function plantOn(api: APIRequestContext) {
  const res = await api.put('/api/settings/plant', { data: SETTINGS });
  expect(res.ok(), await res.text()).toBe(true);
}

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });

test.describe('as a designer', () => {
  test.use({ storageState: authFile('dana') });
  test.beforeEach(async ({ apiAs }) => plantOn(await apiAs('admin')));

  test('device profiles: the list, a profile with its interfaces, a new data point and its page', async ({ page, apiAs }) => {
    await page.goto('/plant/profiles');
    const plant = sidebar(page).getByRole('group', { name: 'Plant', exact: true });
    await expect(plant.getByRole('link', { name: 'Device profiles' })).toBeVisible();
    await expect(plant.getByRole('link', { name: 'KPI definitions' })).toBeVisible();
    const table = page.getByTestId('plant-profile-table');
    await expect(table.getByRole('link', { name: 'Example Controls C80 CNC controller' })).toBeVisible();
    await expect(table).toContainText('Example Meters');
    await expectAccessible(page, 'device profiles');

    // a copy to change, so the demo profile stays as it is
    const api = await apiAs('dana');
    const id = `e2e-profile-${Date.now()}`;
    const copy = await api.post('/api/plant/profiles/example-meters-pm200/duplicate', { data: { name: 'E2E power meter', key: id } });
    expect(copy.ok(), await copy.text()).toBe(true);
    await page.goto(`/plant/profiles/${id}`);
    await expect(page.getByRole('heading', { name: /E2E power meter/ })).toBeVisible();
    const modbus = page.getByTestId('interface-modbus-tcp');
    await expect(modbus).toContainText('Modbus/TCP');
    // a Modbus address says what it reads
    await expect(modbus.getByTestId('data-point-table').first()).toContainText('Input registers 13–14 (2) · function code 04');
    await expectAccessible(page, 'device profile');

    await modbus.getByRole('button', { name: 'Add data point' }).click();
    const dialog = page.getByRole('dialog', { name: 'New data point' });
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Reactive power');
    await expect(dialog.getByRole('textbox', { name: 'ID' })).toHaveValue('reactive_power');
    await dialog.getByRole('textbox', { name: 'Address' }).fill('register 71');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByText(/Use table:address,count/)).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Address' }).fill('input:71,2');
    await dialog.getByRole('combobox', { name: 'Data type' }).fill('float');
    await expectAccessible(page, 'new data point dialog');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await modbus.getByRole('link', { name: 'Reactive power' }).click();
    await expect(page).toHaveURL(new RegExp(`/plant/profiles/${id}/points/reactive_power$`));
    await expect(page.getByTestId('point-facts')).toContainText('Float');
    await expect(page.getByTestId('point-facts')).toContainText('input:71,2');
    await expectAccessible(page, 'data point');
    await api.delete(`/api/plant/profiles/${id}`);
  });

  test('a data point names the assets that deliver it and the KPIs that read it', async ({ page }) => {
    await page.goto('/plant/profiles/example-controls-c80/points/program_status');
    const assets = page.getByTestId('point-assets');
    await expect(assets.getByRole('link', { name: 'Milling centre 1' })).toBeVisible();
    await expect(assets).toContainText('Delivers it');
    await expect(assets).toContainText('Interface not active');
    await expect(page.getByTestId('point-kpis').getByRole('link', { name: 'Time in machine state' })).toBeVisible();
    await page.getByRole('link', { name: 'Show in the assets list' }).click();
    await expect(page).toHaveURL(/profile=example-controls-c80&dataPoint=program_status/);
    await expect(page.getByTestId('filter-data-point')).toContainText('program_status');
    await expect(page.getByTestId('plant-asset-table').getByRole('row')).toHaveCount(2);
  });

  test('KPI definitions: the list and a definition with its inputs, parameters, columns and instances', async ({ page }) => {
    await page.goto('/plant/kpis');
    const table = page.getByTestId('plant-kpi-table');
    await expect(table.getByRole('link', { name: 'Time in machine state' })).toBeVisible();
    await expectAccessible(page, 'KPI definitions');
    await table.getByRole('link', { name: 'Time in machine state' }).click();
    await expect(page.getByTestId('kpi-iso')).toContainText('Higher is better');
    await expect(page.getByTestId('kpi-inputs').getByRole('link', { name: 'Example Controls C80 CNC controller' })).toBeVisible();
    await expect(page.getByTestId('kpi-parameters')).toContainText('offline_timeout_ms');
    await expect(page.getByTestId('kpi-columns')).toContainText('running / planned_production_time × 100');
    await expect(page.getByTestId('kpi-instances')).toContainText('1 problem');
    await expectAccessible(page, 'KPI definition');
    await page.getByTestId('kpi-parameters').getByRole('button', { name: 'Add parameter' }).click();
    const dialog = page.getByRole('dialog', { name: 'New parameter' });
    await expect(dialog.getByRole('textbox', { name: 'Name' })).toBeVisible();
    await expectAccessible(page, 'new parameter dialog');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('an asset shows what it delivers, its KPI instances and the checks; a new KPI instance is checked', async ({ page, apiAs }) => {
    await page.goto('/plant/assets/rvs-mill-02');
    const data = page.getByTestId('asset-data');
    await expect(data.getByRole('link', { name: 'Example Controls C80 CNC controller' })).toBeVisible();
    await expect(data.getByTestId('asset-checks')).toContainText('interface “OPC UA server” is not set up as active on this asset');
    await expect(data.getByTestId('assigned-opc-ua')).toContainText('Not active');
    await expectAccessible(page, 'asset data');

    // identifiers in the publications table stay whole (they wrap after / . _ only, else the table scrolls); at 1280 px
    // the column was narrower than "ProgramStatus"
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/plant/assets/rvs-mill-01');
    const name = page.getByTestId('assignment-publications').getByRole('cell', { name: 'ProgramStatus', exact: true });
    await expect(name).toBeVisible();
    const lines = await name.evaluate((td) => {
      const r = document.createRange();
      r.selectNodeContents(td);
      return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
    });
    expect(lines).toBe(1);

    // a fresh asset: assign a profile, add a KPI instance with a parameter outside its range
    const api = await apiAs('dana');
    const id = `e2e-mill-${Date.now()}`;
    expect((await api.post('/api/plant/assets', { data: { id, siteId: 'riverside', name: 'E2E mill', areaId: 'rvs-machining' } })).ok()).toBe(true);
    const put = await api.put(`/api/plant/assets/${id}/assignment`, {
      data: { profileId: 'example-controls-c80', interfaces: [{ interface: 'opc-ua', endpoint: 'opc.tcp://e2e.example.com:4840' }] },
    });
    expect(put.ok(), await put.text()).toBe(true);
    await page.goto(`/plant/assets/${id}`);
    await expect(page.getByTestId('assignment-possible')).toContainText('Time in machine state');
    await page.getByTestId('assignment-possible').getByRole('button', { name: 'Add' }).click();
    const dialog = page.getByRole('dialog', { name: 'New KPI instance' });
    await dialog.getByRole('textbox', { name: 'Job' }).fill('e2e-machine-state');
    await dialog.getByRole('textbox', { name: /offline_timeout_ms/ }).fill('5');
    await expectAccessible(page, 'new KPI instance dialog');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('kpi-instance-e2e-machine-state')).toContainText('offline_timeout_ms = 5');
    await expect(page.getByTestId('asset-checks')).toContainText('Parameter offline_timeout_ms is 5, outside 1000 to 3600000.');
    await api.delete(`/api/plant/assets/${id}`);
  });

  test('explore: who delivers a data point, which KPIs an asset can have; the checks page', async ({ page }) => {
    await page.goto('/plant/explore');
    await page.getByRole('searchbox', { name: 'Search data points' }).fill('spindle');
    const results = page.getByTestId('explore-table');
    await expect(results.getByRole('link', { name: 'Spindle speed' })).toBeVisible();
    await expect(page).toHaveURL(/q=spindle/);
    await expectAccessible(page, 'explore data points');
    await page.getByTestId('explore-mode').getByText('KPIs for an asset').click();
    await page.getByTestId('explore-asset').click();
    await page.getByRole('option', { name: /Milling centre 1 \(rvs-mill-01\)/ }).click();
    await expect(page.getByTestId('explore-asset-result')).toContainText('Time in machine state');
    await expectAccessible(page, 'explore KPIs for an asset');

    await page.goto('/plant/checks');
    const groups = page.getByTestId('check-groups');
    await expect(groups.getByRole('link', { name: 'Milling centre 2' })).toBeVisible();
    await expect(groups).toContainText('rvs-mill-02-machine-state');
    await expectAccessible(page, 'plant checks');
  });

  test('an import preview shows what Steward checks in the files', async ({ page }) => {
    const yaml = [
      'version: 1',
      'kpi_definition:',
      '  id: e2e-ratio',
      '  name: E2E ratio',
      '  columns:',
      '    - { name: share, kind: ratio, numerator: part }',
      '    - { name: part }',
    ].join('\n');
    await page.goto('/plant/import');
    await page.locator('input[type="file"]').setInputFiles({ name: 'e2e-kpi.yaml', mimeType: 'application/yaml', buffer: Buffer.from(yaml) });
    await page.getByTestId('mode-add').click();
    await page.getByTestId('import-preview').click();
    const result = page.getByTestId('import-preview-result');
    await expect(result.getByTestId('import-changes')).toContainText('KPI definition');
    await expect(result.getByTestId('import-checks')).toContainText('Column share is a ratio without a denominator');
    await expectAccessible(page, 'plant import preview with checks');
  });
});

test.describe('as a viewer', () => {
  test.use({ storageState: authFile('vera') });
  test.beforeEach(async ({ apiAs }) => plantOn(await apiAs('admin')));

  test('the catalogues and the asset data are read-only', async ({ page }) => {
    await page.goto('/plant/profiles');
    await expect(page.getByTestId('plant-profile-table').getByRole('link', { name: 'Example Controls C80 CNC controller' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New device profile' })).toBeHidden();
    await page.goto('/plant/profiles/example-controls-c80');
    await expect(page.getByRole('button', { name: 'Add interface' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Edit' })).toBeHidden();
    await page.goto('/plant/assets/rvs-press-01');
    await expect(page.getByTestId('asset-data')).toContainText('Whoever manages the site assigns device profiles and KPI instances.');
    await expectAccessible(page, 'asset data (viewer)');
  });
});

test.describe('on a phone', () => {
  test.use({ storageState: authFile('dana') });
  test.beforeEach(async ({ apiAs }) => plantOn(await apiAs('admin')));

  test('profiles, a profile, a data point, KPI definitions, a KPI, an asset, explore and checks fit the screen @mobile', async ({ page }) => {
    const pages: [string, string, (p: Page) => Promise<void>][] = [
      [
        '/plant/profiles',
        'device profiles',
        (p) => expect(p.getByTestId('plant-profile-cards').getByRole('link', { name: 'Example Controls C80 CNC controller', exact: true })).toBeVisible(),
      ],
      ['/plant/profiles/example-controls-c80', 'device profile', (p) => expect(p.getByTestId('data-point-cards').first()).toBeVisible()],
      ['/plant/profiles/example-controls-c80/points/program_status', 'data point', (p) => expect(p.getByTestId('point-facts')).toBeVisible()],
      ['/plant/kpis', 'KPI definitions', (p) => expect(p.getByTestId('plant-kpi-cards').getByRole('link', { name: 'Time in machine state' })).toBeVisible()],
      ['/plant/kpis/machine-state-time', 'KPI definition', (p) => expect(p.getByTestId('kpi-columns')).toBeVisible()],
      ['/plant/assets/rvs-mill-01', 'asset data', (p) => expect(p.getByTestId('assignment-kpis')).toContainText('Time in machine state')],
      ['/plant/explore?q=energy', 'explore', (p) => expect(p.getByTestId('explore-cards')).toBeVisible()],
      ['/plant/checks', 'checks', (p) => expect(p.getByTestId('check-groups')).toContainText('Milling centre 2')],
    ];
    for (const [url, name, ready] of pages) {
      await page.goto(url);
      await ready(page);
      await settle(page);
      await expectNoHorizontalScroll(page);
      await expectAccessible(page, `${name} on a phone`);
    }
  });
});
