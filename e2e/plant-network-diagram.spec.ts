import fs from 'node:fs';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { ROOT, authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll, json } from './support/helpers';

/**
 * The OT network diagram (#230, view 5, on #220's data): IEC 62443-3-2 zones as areas with their VLANs and assets, the
 * conduit between the zones, data paths drawn across it in their direction, devices and VLANs on hover, live status
 * only from linked checks, the table alternative, reduced motion, the export – on a desktop and on a phone, with axe.
 * The invented example (examples/plant/brightwater-ot-network.plant.yaml) is imported once; an edge server in the DMZ
 * segment and a data path of milling centre 2 to it make a way across the conduit.
 */

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };
const EXAMPLE = 'brightwater-ot-network.plant.yaml';
const PATH = 'e2e-to-edge';

/** The module on, the example imported, an edge server in VLAN 900's segment, and a data path of milling centre 2 to it. */
async function setup(api: APIRequestContext) {
  expect((await api.put('/api/settings/plant', { data: SETTINGS })).ok()).toBe(true);
  let n = await json(await api.get('/api/plant/sites/riverside/network'));
  if (!n.vlans.some((v: { id: string }) => v.id === 'rvs-vlan-110')) {
    const content = fs.readFileSync(path.join(ROOT, 'examples/plant', EXAMPLE), 'utf8');
    await json(await api.post('/api/plant/import', { data: { files: [{ name: EXAMPLE, content }], mode: 'add' } }));
    n = await json(await api.get('/api/plant/sites/riverside/network'));
  }
  let segmentId = n.vlans.find((v: { id: string }) => v.id === 'rvs-vlan-900').segmentId as string | null;
  if (!segmentId) {
    const made = await json(await api.post('/api/plant/sites/riverside/vlans/rvs-vlan-900/segment', { data: { name: 'E2E OT DMZ' } }));
    segmentId = made.vlans.find((v: { id: string }) => v.id === 'rvs-vlan-900').segmentId;
  }
  const systems = await json<{ id: string; name: string }[]>(await api.get('/api/systems'));
  let edge = systems.find((x) => x.name === 'E2E edge server');
  if (!edge) edge = await json(await api.post('/api/systems', { data: { name: 'E2E edge server', kind: 'server' } }));
  // already a member: a conflict, fine
  await api.post(`/api/systems/${edge!.id}/segments`, { data: { segmentId, address: '192.0.2.10' } });
  const own = await json(await api.get('/api/plant/assets/rvs-mill-02/network'));
  if (own.dataPaths.some((p: { id: string }) => p.id === PATH)) return;
  // tests run side by side: a second one may have added it meanwhile (a conflict, fine)
  await (
    await api.post('/api/plant/assets/rvs-mill-02/paths', {
      data: {
        id: PATH,
        subject: 'E2E machine state to the edge',
        devices: ['rvs-mill-02-ipc'],
        collector: { kind: 'job', ref: 'e2e-edge-collector', host: edge!.id },
        transfers: [{ protocol: 'opc-ua', mode: 'pull', peerKind: 'device', peer: 'rvs-mill-02-ipc', port: 4840 }],
        destinations: [{ kind: 'dataset', ref: 'e2e.machine-state' }],
      },
    })
  ).text();
}

async function picture(page: Page) {
  await page.getByTestId('view-mode').getByText('Picture').click();
}

test.describe('as a designer', () => {
  // one after the other: one test links a monitor to milling centre 2 for a while
  test.describe.configure({ mode: 'serial' });
  test.use({ storageState: authFile('dana') });
  test.beforeEach(async ({ apiAs }) => setup(await apiAs('admin')));

  test('zones, VLANs, the conduit, data paths across it, devices on hover, the table and the export', async ({ page }) => {
    await page.goto('/plant/sites/riverside/network');
    await page.getByTestId('network-tab-diagram').click();
    await expect(page).toHaveURL(/\/plant\/sites\/riverside\/network\/diagram$/);
    await picture(page);
    const graph = page.getByTestId('flow-graph');
    await expect(graph.getByTestId('flow-area-zone:rvs-zone-cells')).toContainText('Production cells');
    await expect(graph.getByTestId('flow-area-zone:rvs-zone-cells')).toContainText('SL-T 2');
    await expect(graph.getByTestId('flow-area-zone:rvs-zone-dmz')).toContainText('SL-T open');
    await expect(graph.getByTestId('flow-area-vlan:rvs-vlan-110')).toContainText('VID 110');
    await expect(graph.getByTestId('flow-node-asset:rvs-mill-01')).toBeVisible();
    await expect(graph.getByTestId('flow-node-cdt:rvs-cdt-cells-dmz')).toContainText('Cells to DMZ');
    // the edge server is in the DMZ: the data path of milling centre 2 runs through the conduit
    await expect(graph.getByTestId('flow-edge-asset:rvs-mill-02>cdt:rvs-cdt-cells-dmz')).toBeAttached();
    await expect(graph.getByTestId('flow-edge-cdt:rvs-cdt-cells-dmz>col:job:e2e-edge-collector')).toBeAttached();
    await expect(graph.getByTestId('flow-edge-zone:rvs-zone-cells>cdt:rvs-cdt-cells-dmz')).toHaveAttribute('data-conduit', 'true');
    // nothing is linked to milling centre 1: documentation only, never green
    await expect(graph.getByTestId('flow-node-asset:rvs-mill-01').locator('[data-live]')).toHaveCount(0);
    await expect(graph).toHaveAttribute('data-animated', 'true');
    await expect(page.getByTestId('view-legend')).toContainText('no data');
    await expectAccessible(page, 'OT network diagram');

    // devices and VLANs on hover (and focus)
    await graph.getByTestId('flow-node-asset:rvs-mill-01').hover();
    await expect(page.getByTestId('flow-node-info')).toContainText('rvs-mill-01-ipc');
    await expect(page.getByTestId('flow-node-info')).toContainText('10.20.110.21');
    const vlan = graph.locator('.react-flow__node[data-id="vlan:rvs-vlan-110"]');
    await expect(vlan).toHaveAttribute('aria-label', /VLAN: Machining cells/);
    await vlan.focus();
    await expect(page.getByTestId('flow-node-info')).toContainText('10.20.110.0/24');
    // a data path highlights its way
    await page.getByTestId(`flow-path-rvs-mill-02/${PATH}`).hover();
    await expect(graph.getByTestId('flow-node-cdt:rvs-cdt-cells-dmz')).toHaveAttribute('data-hl', 'true');
    await expect(page.getByTestId(`flow-path-rvs-mill-02/${PATH}`)).toContainText('Not watched');

    // the export
    const download = page.waitForEvent('download');
    await page.getByTestId('view-export').click();
    await page.getByTestId('export-svg').click();
    expect((await download).suggestedFilename()).toBe('ot-network-of-riverside-works.svg');

    // the table says the same in words
    await page.getByTestId('view-mode').getByText('Table').click();
    const parts = page.getByTestId('flow-parts-table');
    await expect(parts).toContainText('Zone');
    await expect(parts).toContainText('Conduit');
    await expect(parts).toContainText('in Machining cells');
    await expect(page.getByTestId('flow-paths-table')).toContainText('E2E machine state to the edge');
    await expectAccessible(page, 'OT network diagram as a table');
    await picture(page);
  });

  test('a linked monitor gives an asset its live status; reduced motion keeps everything still', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const monitors = await json<{ id: string; key: string; isTemplate: boolean }[]>(await api.get('/api/monitors'));
    const m = monitors.find((x) => !x.isTemplate)!;
    await json(await api.put('/api/plant/assets/rvs-mill-02/checks', { data: { checks: [{ kind: 'monitor', ref: m.key }] } }));
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/plant/sites/riverside/network/diagram');
      await picture(page);
      const graph = page.getByTestId('flow-graph');
      await expect(graph.getByTestId('flow-node-asset:rvs-mill-02').locator('[data-live]')).toBeVisible();
      await expect(graph).not.toHaveAttribute('data-animated', 'true');
      await expect(graph.locator('.pv-edge-flow')).toHaveCount(0);
      await expect(page.getByRole('switch', { name: 'Animation off' })).toBeDisabled();
      await expectAccessible(page, 'OT network diagram with live status');
    } finally {
      await api.put('/api/plant/assets/rvs-mill-02/checks', { data: { checks: [] } });
    }
  });

  test('the site structure leads to the diagram', async ({ page }) => {
    await page.goto('/plant/sites/riverside/structure');
    await page.getByTestId('structure-network-link').click();
    await expect(page).toHaveURL(/\/plant\/sites\/riverside\/network\/diagram$/);
    await expect(page.getByTestId('ot-network-diagram')).toBeVisible();
  });
});

test.describe('on a phone', () => {
  test.use({ storageState: authFile('dana') });
  test.beforeEach(async ({ apiAs }) => setup(await apiAs('admin')));

  test('the diagram fits the screen – table first, the picture a tap away @mobile', async ({ page }) => {
    await page.goto('/plant/sites/riverside/network/diagram');
    await expect(page.getByTestId('network-diagram-view')).toBeVisible();
    await settle(page);
    await expect(page.getByTestId('view-mode').locator('input[value="table"]')).toBeChecked();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'OT network diagram on a phone (table)');
    await picture(page);
    await expect(page.getByTestId('flow-graph')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'OT network diagram on a phone (picture)');
    await page.getByTestId('view-mode').getByText('Table').click();
  });
});
