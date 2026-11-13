import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll, json } from './support/helpers';

/**
 * Edge devices (0.25.0, ADR 0037 part 3) with the demo's edge device of milling line 1 (all invented): the
 * Industrial Edge suggestions on the systems page (dismissed and suggested again), the system's device status and
 * plant panels, the asset's _Edge device_ section with _Apps on this device_ and _Collects data from_, _Create element
 * from this sink_ on the collection's Databus sink, and the bridge step _… @ ied-line-01.example (prod)_ in the pipeline.
 * axe on each page; phones get no sideways scroll.
 */

const SYSTEM = 'ied-line-01.example';
let systemId = '';
let productId = '';

test.describe('edge devices', () => {
  test.use({ storageState: authFile('dana') });
  test.beforeEach(async ({ apiAs }) => {
    if (systemId) return;
    const admin = await apiAs('admin');
    for (const [url, data] of [
      ['/api/settings/modules/dataProducts', { enabled: true }],
      ['/api/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} }],
    ] as const) {
      const res = await admin.put(url, { data });
      expect(res.ok(), await res.text()).toBe(true);
    }
    const systems = await json<{ id: string; name: string }[]>(await admin.get('/api/systems'));
    systemId = systems.find((x) => x.name === SYSTEM)!.id;
    const products = await json<{ items: { id: string; key: string }[] }>(await admin.get('/api/data-products'));
    productId = products.items.find((x) => x.key === 'machine-measurements')!.id;
  });

  test('the Industrial Edge suggestions: dismissed, suggested again – nothing recorded on its own', async ({ page }) => {
    await page.goto('/systems');
    const inbox = page.getByTestId('edge-suggestions');
    await expect(inbox).toBeVisible();
    const databus = inbox.getByTestId('edge-suggestion').filter({ hasText: `IE Databus 2.1.0 runs on ${SYSTEM}` });
    await expect(databus).toBeVisible();
    await expectAccessible(page, 'systems with Industrial Edge suggestions');
    // the readout's device count is a plural, formatted
    await expect(inbox).toContainText(/\(\d+ devices?, /);
    await databus.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByText('Dismissed', { exact: true })).toBeVisible();
    await expect(databus).toHaveCount(0);
    // the card went with its buttons: the focus is on the next suggestion's first button, not lost
    await expect(inbox.getByTestId('edge-suggestion').locator('button:focus')).toHaveCount(1);
    await inbox.getByRole('button', { name: 'Suggest dismissed ones again' }).click();
    await expect(page.getByText('The dismissed suggestions are suggested again')).toBeVisible();
    await expect(databus).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalScroll(page);
  });

  test('the system shows its device status, its plant device and what collects data there', async ({ page }) => {
    await page.goto(`/systems/${systemId}`);
    await expect(page.getByTestId('iem-status')).toContainText('Online');
    await expect(page.getByTestId('iem-status')).toContainText('ied-os-2.4.0-12-amd64');
    const plant = page.getByTestId('system-edge');
    await expect(plant.getByTestId('system-plant-devices')).toContainText('Edge device line 1');
    await expect(plant.getByTestId('system-collects-from')).toContainText('Milling centre 1');
    await expect(plant.getByTestId('system-collects-from')).toContainText('Machine state to the Databus');
    await expectAccessible(page, 'edge system');
  });

  test('the edge asset: apps on this device, collects data from; the Databus sink makes an element', async ({ page }) => {
    await page.goto('/plant/assets/rvs-edge-01');
    const edge = page.getByTestId('asset-edge');
    await expect(edge.getByRole('link', { name: SYSTEM })).toBeVisible();
    await expect(edge.getByRole('link', { name: 'Edge Stream Bridge' })).toBeVisible();
    await expect(edge.getByRole('link', { name: 'OPC UA Connector' })).toBeVisible();
    await expect(edge.getByTestId('asset-collects-from')).toContainText('Milling centre 1');
    await expect(edge.getByTestId('iem-status')).toContainText('Online');
    await expectAccessible(page, 'edge asset');
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalScroll(page);
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.goto('/plant/assets/rvs-mill-01/collections?collection=edge-state');
    await page.getByRole('tab', { name: 'Where the data goes' }).click();
    const button = page.getByTestId('sink-element-databus');
    await expect(button).toBeVisible();
    await button.click();
    const dialog = page.getByRole('dialog', { name: 'Element from the sink Databus' });
    await expect(dialog.getByRole('textbox', { name: 'Topic' })).toHaveValue('ie/d/line-1/opcua/state');
    await expect(dialog.getByRole('textbox', { name: 'Broker (host:port)' })).toHaveValue('ie-databus:1883');
    await expectAccessible(page, 'create element from a sink');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });

  test('the bridge step runs on the edge device, in the table and the picture', async ({ page }) => {
    await page.goto(`/data-products/${productId}/pipeline`);
    await expect(page.getByTestId('product-steps')).toContainText(`Application @ ${SYSTEM} (prod)`);
    await expectAccessible(page, 'pipeline with a bridge on an edge device');
    // the picture's table names the application and its system
    await page.goto(`/data-products/${productId}/views/pipeline`);
    await page.getByTestId('view-mode').getByText('Table').click();
    await expect(page.getByText(`Edge Stream Bridge @ ${SYSTEM} (prod)`).first()).toBeVisible();
    await expectAccessible(page, 'pipeline table with a bridge');
  });
});
