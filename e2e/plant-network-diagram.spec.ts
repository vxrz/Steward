import fs from 'node:fs';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { ROOT, authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll, json, withLock } from './support/helpers';

/**
 * The OT network diagram (#230, view 5, on #220's data): IEC 62443-3-2 zones in bands by their level with their VLANs
 * and assets, the conduit as a gate between the zones, data paths drawn through it in their direction, devices and
 * VLANs on hover, fit to view, full screen, the folding side panel, search and selection, the filters, the folded
 * legend, the keyboard, live status only from linked checks, the table alternative, reduced motion, the export – on a
 * desktop and on a phone, with axe.
 * The invented example (examples/plant/brightwater-ot-network.plant.yaml) is imported once; an edge server in the DMZ
 * segment and a data path of milling centre 2 to it make a way across the conduit.
 */

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };
const EXAMPLE = 'brightwater-ot-network.plant.yaml';
const PATH = 'e2e-to-edge';
/** The lock around linking a monitor to milling centre 2, and around the tests that read it as not watched */
const MILL_2_CHECKS = 'riverside-mill-02-checks';

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
    // tests run side by side: a second one may have made it meanwhile (a conflict, fine)
    await api.post('/api/plant/sites/riverside/vlans/rvs-vlan-900/segment', { data: { name: 'E2E OT DMZ' } });
    n = await json(await api.get('/api/plant/sites/riverside/network'));
    segmentId = n.vlans.find((v: { id: string }) => v.id === 'rvs-vlan-900').segmentId;
  }
  const systems = await json<{ id: string; name: string }[]>(await api.get('/api/systems'));
  let edge = systems.find((x) => x.name === 'E2E edge server');
  if (!edge) {
    // made by a test running side by side meanwhile: a conflict, fine
    await api.post('/api/systems', { data: { name: 'E2E edge server', kind: 'server' } });
    edge = (await json<{ id: string; name: string }[]>(await api.get('/api/systems'))).find((x) => x.name === 'E2E edge server');
  }
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

/** The data paths beside the picture: folded at 1440 px, one click away (and remembered). */
async function openPanel(page: Page) {
  if (await page.getByTestId('nd-panel-show').isVisible()) await page.getByTestId('nd-panel-show').click();
  await expect(page.getByTestId('nd-panel')).toBeVisible();
}

/** Every part of the picture lies inside its frame. */
async function expectAllInFrame(page: Page) {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const frame = document.querySelector('[data-testid="flow-graph"]')!.getBoundingClientRect();
          return [...document.querySelectorAll('.react-flow__node')]
            .map((n) => n.getBoundingClientRect())
            .filter((r) => r.left < frame.left - 1 || r.right > frame.right + 1 || r.top < frame.top - 1 || r.bottom > frame.bottom + 1).length;
        }),
      { message: 'parts outside the frame' },
    )
    .toBe(0);
}

test.describe('as a designer', () => {
  // one after the other: one test links a monitor to milling centre 2 for a while
  test.describe.configure({ mode: 'serial' });
  test.use({ storageState: authFile('dana') });
  test.beforeEach(async ({ apiAs }) => setup(await apiAs('admin')));

  test('zones in bands, the conduit as a gate, data paths through it, devices on hover, the table and the export', async ({ page }) => {
    // milling centre 2 is not watched here (the live status test links a monitor to it for a while)
    test.slow();
    await withLock(MILL_2_CHECKS, () => diagramTour(page));
  });

  async function diagramTour(page: Page) {
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
    // bands by level: the DMZ (3.5) above the cells (1) – data paths run upwards
    await expect(graph.getByTestId('band-dmz')).toContainText('Level 3.5');
    await expect(graph.getByTestId('band-control')).toContainText('Level 1');
    const cells = (await graph.getByTestId('flow-area-zone:rvs-zone-cells').boundingBox())!;
    const dmz = (await graph.getByTestId('flow-area-zone:rvs-zone-dmz').boundingBox())!;
    expect(dmz.y + dmz.height).toBeLessThan(cells.y);
    // the conduit is a gate between the two zones
    const gate = (await graph.getByTestId('flow-node-cdt:rvs-cdt-cells-dmz').boundingBox())!;
    await expect(graph.getByTestId('flow-node-cdt:rvs-cdt-cells-dmz')).toContainText('Cells to DMZ');
    expect(gate.y).toBeGreaterThanOrEqual(dmz.y + dmz.height - 1);
    expect(gate.y + gate.height).toBeLessThanOrEqual(cells.y + 1);
    // the edge server is in the DMZ: the data path of milling centre 2 runs through the conduit
    await expect(graph.getByTestId('flow-edge-asset:rvs-mill-02>cdt:rvs-cdt-cells-dmz')).toBeAttached();
    await expect(graph.getByTestId('flow-edge-cdt:rvs-cdt-cells-dmz>col:job:e2e-edge-collector')).toBeAttached();
    await expect(graph.getByTestId('flow-edge-zone:rvs-zone-cells>cdt:rvs-cdt-cells-dmz')).toHaveAttribute('data-conduit', 'true');
    // nothing is linked to milling centre 1: documentation only, never green
    await expect(graph.getByTestId('flow-node-asset:rvs-mill-01').locator('[data-live]')).toHaveCount(0);
    await expect(graph).toHaveAttribute('data-animated', 'true');
    await expectAccessible(page, 'OT network diagram');

    // devices and VLANs on hover (and focus); the level of a zone
    await graph.getByTestId('flow-node-asset:rvs-mill-01').hover();
    await expect(page.getByTestId('flow-node-info')).toContainText('rvs-mill-01-ipc');
    await expect(page.getByTestId('flow-node-info')).toContainText('10.20.110.21');
    const vlan = graph.locator('.react-flow__node[data-id="vlan:rvs-vlan-110"]');
    await expect(vlan).toHaveAttribute('aria-label', /VLAN: Machining cells/);
    await vlan.focus();
    await expect(page.getByTestId('flow-node-info')).toContainText('10.20.110.0/24');
    await graph.locator('.react-flow__node[data-id="zone:rvs-zone-cells"]').focus();
    await expect(page.getByTestId('flow-node-info')).toContainText('Level 1 – basic control, cells');
    // the labels of the ways show on pointing at a part, not all at once
    await page.mouse.move(1, 1);
    await expect(graph.getByTestId('edge-label-asset:rvs-mill-02>cdt:rvs-cdt-cells-dmz')).toHaveCount(0);
    await graph.getByTestId('flow-node-asset:rvs-mill-02').hover();
    await expect(graph.getByTestId('edge-label-asset:rvs-mill-02>cdt:rvs-cdt-cells-dmz')).toContainText('opc-ua:4840');
    // a data path highlights its way
    await openPanel(page);
    await page.getByTestId(`flow-path-rvs-mill-02/${PATH}`).hover();
    await expect(graph.getByTestId('flow-node-cdt:rvs-cdt-cells-dmz')).toHaveAttribute('data-hl', 'true');
    await expect(page.getByTestId(`flow-path-rvs-mill-02/${PATH}`)).toContainText('Not watched');

    // the export: SVG and PNG
    for (const kind of ['svg', 'png'] as const) {
      const download = page.waitForEvent('download');
      await page.getByTestId('view-export').click();
      await page.getByTestId(`export-${kind}`).click();
      expect((await download).suggestedFilename()).toBe(`ot-network-of-riverside-works.${kind}`);
    }

    // the table says the same in words
    await page.getByTestId('view-mode').getByText('Table').click();
    const parts = page.getByTestId('flow-parts-table');
    await expect(parts).toContainText('Zone');
    await expect(parts).toContainText('Conduit');
    await expect(parts).toContainText('in Machining cells');
    await expect(parts).toContainText('Level 1 – basic control, cells');
    await expect(page.getByTestId('flow-paths-table')).toContainText('E2E machine state to the edge');
    await expectAccessible(page, 'OT network diagram as a table');
    await picture(page);
  }

  test('fits the frame on open and after zooming; full screen; the side panel folds and stays folded', async ({ page }) => {
    await page.goto('/plant/sites/riverside/network/diagram');
    await picture(page);
    const graph = page.getByTestId('flow-graph');
    await expect(graph.getByTestId('flow-node-asset:rvs-mill-01')).toBeVisible();
    // the whole picture, without scrolling the page, and wider than half the screen
    await expectAllInFrame(page);
    const box = (await graph.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(900);
    expect(box.width).toBeGreaterThan(1440 / 2);
    // zoom in, then "Show everything" fits again
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.getByRole('button', { name: 'Show everything' }).click();
    await expectAllInFrame(page);

    // full screen: the picture takes the window; Escape leaves it
    await page.getByTestId('nd-fullscreen').click();
    await expect(page.getByTestId('network-diagram-view')).toHaveAttribute('data-fullscreen', 'true');
    await expect(page.getByTestId('nd-fullscreen')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await graph.boundingBox())!.height).toBeGreaterThan(box.height + 150);
    await expectAllInFrame(page);
    await expectAccessible(page, 'OT network diagram in full screen');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('network-diagram-view')).not.toHaveAttribute('data-fullscreen', 'true');

    // the side panel: folded at this width, opened with a click – and kept so after a reload
    await expect(page.getByTestId('nd-panel-strip')).toContainText('data path');
    await page.getByTestId('nd-panel-show').click();
    await expect(page.getByTestId('flow-paths')).toBeVisible();
    await expect.poll(async () => (await graph.boundingBox())!.width).toBeLessThan(box.width);
    await expectAllInFrame(page);
    await page.reload();
    await expect(page.getByTestId('nd-panel')).toBeVisible();
    await page.getByTestId('nd-panel-fold').click();
    await expect(page.getByTestId('nd-panel-strip')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('nd-panel-strip')).toBeVisible();
  });

  test('search finds and selects a part, the rest dims; Escape and the button clear the selection', async ({ page }) => {
    await page.goto('/plant/sites/riverside/network/diagram');
    await picture(page);
    const graph = page.getByTestId('flow-graph');
    const search = page.getByTestId('nd-search');
    await search.fill('Milling centre 1');
    await page.getByRole('option', { name: 'Milling centre 1', exact: true }).click();
    const mill = graph.getByTestId('flow-node-asset:rvs-mill-01');
    await expect(mill).toHaveAttribute('data-sel', 'true');
    await expect(graph.getByTestId('flow-node-cdt:rvs-cdt-cells-dmz')).toHaveAttribute('data-dim', 'true');
    await expect(page.getByTestId('nd-clear-selection')).toContainText('Milling centre 1');
    await page.mouse.move(1, 1);
    await expect(page.getByTestId('flow-node-info')).toContainText('rvs-mill-01-ipc');
    await expect(page.getByTestId('nd-open')).toHaveAttribute('href', /\/plant\/assets\/rvs-mill-01$/);
    await page.getByTestId('nd-clear-selection').click();
    await expect(mill).not.toHaveAttribute('data-sel', 'true');
    await expect(graph.getByTestId('flow-node-cdt:rvs-cdt-cells-dmz')).not.toHaveAttribute('data-dim', 'true');
    // a data path, from the same search: its way is highlighted with its labels
    await search.fill('E2E machine state');
    await page.getByRole('option', { name: /E2E machine state to the edge/ }).click();
    await expect(graph.getByTestId('flow-node-cdt:rvs-cdt-cells-dmz')).toHaveAttribute('data-hl', 'true');
    await expect(graph.getByTestId('flow-node-asset:rvs-mill-01')).toHaveAttribute('data-dim', 'true');
    await expect(graph.getByTestId('edge-label-asset:rvs-mill-02>cdt:rvs-cdt-cells-dmz')).toBeVisible();
    await graph.locator('.react-flow__node[data-id="asset:rvs-mill-01"]').focus();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('nd-clear-selection')).toHaveCount(0);
    // a click selects, a click on an empty spot clears. The pointer comes from outside the picture (centring on the
    // data path may have moved a part under the resting pointer); on a loaded machine a click can land while the
    // picture still settles – clicked again only while nothing is selected, so it never toggles back
    await page.mouse.move(1, 1);
    await expect(async () => {
      if ((await mill.getAttribute('data-sel')) !== 'true') await mill.click();
      await expect(mill).toHaveAttribute('data-sel', 'true', { timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    const pane = (await graph.boundingBox())!;
    await graph.locator('.react-flow__pane').click({ position: { x: 20, y: pane.height / 2 } });
    await expect(mill).not.toHaveAttribute('data-sel', 'true');
  });

  test('filters narrow the data paths: zones, protocols, live status, crossing zones, without a conduit', async ({ page }) => {
    // the live status filter finds milling centre 2's paths not watched (see MILL_2_CHECKS)
    test.slow();
    await withLock(MILL_2_CHECKS, () => filterTour(page));
  });

  async function filterTour(page: Page) {
    await page.goto('/plant/sites/riverside/network/diagram');
    await picture(page);
    await openPanel(page);
    const graph = page.getByTestId('flow-graph');
    const list = page.getByTestId('flow-paths');
    await expect(list).toContainText('NC programs');
    await page.getByTestId('nd-filters').click();
    await page.getByRole('switch', { name: 'Only paths that cross zones' }).check();
    await expect(page.getByTestId('nd-shown-count')).toContainText(/of \d+ data paths shown/);
    await expect(list).toContainText('E2E machine state to the edge');
    await expect(list).not.toContainText('NC programs');
    await expect(graph.getByTestId('flow-node-peer:cam file share')).toHaveAttribute('data-dim', 'true');
    await expect(graph.getByTestId('flow-node-asset:rvs-mill-02')).not.toHaveAttribute('data-dim', 'true');
    await expectAccessible(page, 'OT network diagram filters');
    // the paths without a documented conduit: the one of the e2e edge server runs through its conduit
    await page.getByRole('switch', { name: 'Only paths that cross zones' }).uncheck();
    await page.getByRole('switch', { name: 'Only paths without a documented conduit' }).check();
    await expect(list).not.toContainText('E2E machine state to the edge');
    await page.getByRole('switch', { name: 'Only paths without a documented conduit' }).uncheck();
    // a protocol
    await page.getByTestId('nd-filter-protocols').click({ force: true });
    await page.getByRole('option', { name: 'smb' }).click();
    // close the list of protocols (it covers the next field)
    await page.getByTestId('nd-filter-panel').click({ position: { x: 4, y: 4 } });
    await expect(list).toContainText('NC programs');
    await expect(list).not.toContainText('E2E machine state to the edge');
    // the live status: nothing is watched here
    await page.getByTestId('nd-filter-live').click({ force: true });
    await page.getByRole('option', { name: 'Not watched' }).click();
    await page.getByTestId('nd-filter-panel').click({ position: { x: 4, y: 4 } });
    await expect(list).toContainText('NC programs');
    await page.getByTestId('nd-filter-clear').click();
    // the panel keeps the focus (the button disabled itself): Escape closes it
    await expect(page.getByTestId('nd-filter-panel')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('nd-filter-panel')).toBeHidden();
    await expect(page.getByTestId('nd-shown-count')).toHaveCount(0);
    await expect(list).toContainText('E2E machine state to the edge');
    // a zone (the panel opened again, then its list of zones)
    await page.getByTestId('nd-filters').click();
    await expect(page.getByTestId('nd-filter-panel')).toBeVisible();
    await page.getByTestId('nd-filter-zones').click({ force: true });
    await page.getByRole('option', { name: 'OT DMZ' }).click();
    await page.keyboard.press('Escape');
    await expect(list).toContainText('E2E machine state to the edge');
    await expect(list).not.toContainText('NC programs');
    await page.getByTestId('nd-shown-count').getByRole('button', { name: 'Clear filters' }).click();
    await expect(list).toContainText('NC programs');
  }

  test('the legend folds into a button and opens from the keyboard; parts are reached and used by keyboard', async ({ page }) => {
    await page.goto('/plant/sites/riverside/network/diagram');
    await picture(page);
    await expect(page.getByTestId('view-legend')).toHaveCount(0);
    await page.getByTestId('nd-legend-button').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('view-legend')).toContainText('no data');
    await expect(page.getByTestId('view-legend')).toContainText('the levels of the Purdue model');
    await expectAccessible(page, 'OT network diagram legend');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('view-legend')).toHaveCount(0);
    await expect(page.getByTestId('nd-legend-button')).toBeFocused();

    // Tab reaches the parts; Space selects, Escape clears, Enter opens the page
    const graph = page.getByTestId('flow-graph');
    const zone = graph.locator('.react-flow__node[data-id="zone:rvs-zone-dmz"]');
    for (let i = 0; i < 30 && !(await zone.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
    await expect(zone).toBeFocused();
    await page.keyboard.press('Space');
    await expect(graph.getByTestId('flow-area-zone:rvs-zone-dmz')).toHaveAttribute('data-sel', 'true');
    await page.keyboard.press('Escape');
    await expect(graph.getByTestId('flow-area-zone:rvs-zone-dmz')).not.toHaveAttribute('data-sel', 'true');
    await graph.locator('.react-flow__node[data-id="asset:rvs-mill-01"]').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/plant\/assets\/rvs-mill-01$/);
  });

  test('a linked monitor gives an asset its live status; reduced motion keeps everything still', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const monitors = await json<{ id: string; key: string; isTemplate: boolean }[]>(await api.get('/api/monitors'));
    const m = monitors.find((x) => !x.isTemplate)!;
    test.slow();
    await withLock(MILL_2_CHECKS, async () => {
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
        // dark too
        await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
        await expectAccessible(page, 'OT network diagram, dark');
      } finally {
        await api.put('/api/plant/assets/rvs-mill-02/checks', { data: { checks: [] } });
      }
    });
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

  test('the diagram fits the screen – table first, the picture a tap away and fitted @mobile', async ({ page }) => {
    await page.goto('/plant/sites/riverside/network/diagram');
    await expect(page.getByTestId('network-diagram-view')).toBeVisible();
    await settle(page);
    await expect(page.getByTestId('view-mode').locator('input[value="table"]')).toBeChecked();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'OT network diagram on a phone (table)');
    await picture(page);
    await expect(page.getByTestId('flow-graph')).toBeVisible();
    await expectAllInFrame(page);
    await expectNoHorizontalScroll(page);
    // a tap selects a part and shows its details below the picture
    await page.getByTestId('flow-graph').getByTestId('flow-node-asset:rvs-mill-01').tap();
    await expect(page.getByTestId('flow-node-info')).toContainText('rvs-mill-01-ipc');
    await expect(page.getByTestId('nd-panel')).toBeVisible();
    await expectAccessible(page, 'OT network diagram on a phone (picture)');
    await page.getByTestId('view-mode').getByText('Table').click();
  });
});
