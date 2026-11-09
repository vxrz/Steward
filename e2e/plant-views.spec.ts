import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll, json } from './support/helpers';

/**
 * The plant registry's visualizations (#230): the structure of a site (treemap with drill-down, the buildings as the
 * other grouping), the data flow of an asset, the lineage of a data point, the KPI coverage matrix and the site
 * overview tiles – each with its table alternative, keyboard access, the legend (live vs documentation), reduced
 * motion and "Animation off", the export, on a desktop and on a phone, with axe.
 */

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };

async function plantOn(api: APIRequestContext) {
  const res = await api.put('/api/settings/plant', { data: SETTINGS });
  expect(res.ok(), await res.text()).toBe(true);
}

/** The picture of a view (not the table), whatever the last choice was. */
async function picture(page: Page) {
  await page.getByTestId('view-mode').getByText('Picture').click();
}

test.describe('as a designer', () => {
  test.use({ storageState: authFile('dana') });
  test.beforeEach(async ({ apiAs }) => plantOn(await apiAs('admin')));

  test('site structure: a treemap to drill into, the way back, the buildings, the table and the export', async ({ page }) => {
    await page.goto('/plant/sites/riverside');
    await page.getByTestId('site-tab-structure').click();
    await expect(page).toHaveURL(/\/plant\/sites\/riverside\/structure$/);
    await picture(page);
    const map = page.getByTestId('structure-map');
    await expect(map.getByTestId('tile-rvs-machining')).toBeVisible();
    await expect(page.getByTestId('structure-legend')).toContainText('documented status');
    await expectAccessible(page, 'site structure');

    // drill down with the keyboard, back with Escape and with the trail
    await map.getByTestId('tile-rvs-machining').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/node=rvs-machining/);
    await expect(page.getByTestId('structure-trail')).toContainText('Machining');
    await expect(map.getByTestId('tile-rvs-mill-line-1')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('structure-trail')).toContainText('Milling line 1');
    // a click on a part inside a tile opens that part directly
    await page.getByTestId('structure-trail').getByRole('button', { name: 'Machining' }).click();
    await map.getByTestId('inner-rvs-mill-line-1-cell-1').click();
    await expect(page.getByTestId('structure-trail')).toContainText('Milling line 1');
    // the innermost level lists its assets
    await expect(page.getByTestId('structure-assets').getByRole('link', { name: 'Milling centre 1', exact: true })).toBeVisible();
    await page.getByTestId('structure-trail').getByRole('button', { name: 'Riverside Works' }).click();
    await expect(page).not.toHaveURL(/node=/);
    await map.getByTestId('tile-rvs-machining').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/node=rvs-machining/);
    await page.keyboard.press('Escape');
    await expect(page).not.toHaveURL(/node=/);

    // location instead of function
    await page.getByTestId('structure-by').getByText('Location (Buildings)').click();
    await expect(page).toHaveURL(/by=location/);
    await expect(map.getByTestId('tile-rvs-hall-1')).toBeVisible();
    await expectAccessible(page, 'site structure by building');

    // the export
    const download = page.waitForEvent('download');
    await page.getByTestId('view-export').click();
    await page.getByTestId('export-svg').click();
    expect((await download).suggestedFilename()).toMatch(/^structure-of-riverside-works.*\.svg$/);

    // the table says the same in rows
    await page.getByTestId('structure-by').getByText('Function (ISA-95)').click();
    await page.getByTestId('view-mode').getByText('Table').click();
    const table = page.getByTestId('structure-table');
    await expect(table.getByRole('link', { name: 'Machining' })).toBeVisible();
    await expect(table).toContainText('Operational 3, Maintenance 1');
    await expect(table).toContainText('Documentation only');
    await expectAccessible(page, 'site structure as a table');
    await picture(page);
  });

  test('data flow of an asset: interfaces to KPI jobs and datasets, a path highlighted, problems marked, the table', async ({ page }) => {
    await page.goto('/plant/assets/rvs-mill-01');
    await page.getByTestId('asset-tab-flow').click();
    await expect(page).toHaveURL(/\/plant\/assets\/rvs-mill-01\/flow$/);
    await picture(page);
    const graph = page.getByTestId('flow-graph');
    await expect(graph.getByTestId('flow-node-if:opc-ua')).toContainText('OPC UA server');
    await expect(graph.getByTestId('flow-node-col:opc ua gateway')).toBeVisible();
    await expect(graph.getByTestId('flow-node-ds:plant.machine-state')).toContainText('No data');
    // the web UI is documented, not active: dashed, in words
    await expect(graph.getByTestId('flow-node-if:web-ui')).toHaveAttribute('data-inactive', 'true');
    await expect(graph.getByTestId('flow-node-if:web-ui')).toContainText('Not active');
    // the edges move in the direction of the flow (no reduced motion here)
    await expect(graph).toHaveAttribute('data-animated', 'true');
    await expect(graph.locator('.pv-edge-flow').first()).toBeAttached();
    await expect(page.getByTestId('view-legend')).toContainText('Documentation only');
    await expectAccessible(page, 'asset data flow');

    // hovering a data point highlights its way, the rest steps back
    await page.getByTestId('flow-path-program_status').hover();
    await expect(graph.getByTestId('flow-node-kpi:rvs-mill-01-machine-state')).toHaveAttribute('data-hl', 'true');
    await expect(graph.getByTestId('flow-node-if:web-ui')).toHaveAttribute('data-dim', 'true');
    // a click keeps it
    await page.getByTestId('flow-path-program_status').click();
    await expect(page.getByTestId('flow-path-program_status')).toHaveAttribute('aria-pressed', 'true');

    // every node is a focusable, labelled stop; Enter opens its page
    const kpi = graph.locator('.react-flow__node[data-id="kpi:rvs-mill-01-machine-state"]');
    await expect(kpi).toHaveAttribute('aria-label', /KPI job: Time in machine state.*Enter opens its page/);
    await kpi.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/plant\/kpis\/machine-state-time$/);
    await page.goBack();

    // "Animation off": static arrows
    await page.getByRole('switch', { name: 'Animation off' }).check();
    await expect(graph).not.toHaveAttribute('data-animated', 'true');
    await expect(graph.locator('.pv-edge-flow')).toHaveCount(0);
    await page.getByRole('switch', { name: 'Animation off' }).uncheck();

    // PNG export
    const download = page.waitForEvent('download');
    await page.getByTestId('view-export').click();
    await page.getByTestId('export-png').click();
    expect((await download).suggestedFilename()).toBe('data-flow-of-milling-centre-1.png');

    // the table alternative
    await page.getByTestId('view-mode').getByText('Table').click();
    const parts = page.getByTestId('flow-parts-table');
    await expect(parts).toContainText('Collector');
    await expect(parts).toContainText('Dataset: No data');
    await expect(page.getByTestId('flow-paths-table')).toContainText(
      'OPC UA server → OPC UA gateway → iot-platform → Time in machine state → plant.machine-state',
    );
    await expectAccessible(page, 'asset data flow as a table');
    await picture(page);
  });

  test('an inactive interface and a failing check are drawn dashed and said in words; a linked monitor is live', async ({ page, apiAs }) => {
    await page.goto('/plant/assets/rvs-mill-02/flow');
    await picture(page);
    const graph = page.getByTestId('flow-graph');
    await expect(graph.getByTestId('flow-node-kpi:rvs-mill-02-machine-state')).toContainText('1 problem');
    const edge = graph.getByTestId('flow-edge-if:opc-ua>kpi:rvs-mill-02-machine-state');
    await expect(edge).toHaveAttribute('data-problem', 'true');
    await expect(graph).toContainText('Check fails');
    await expect(page.getByTestId('flow-path-program_status')).toContainText('Interface not active');

    // a monitor linked to the asset gives it a live status – with its own word
    const api = await apiAs('dana');
    const monitors = await json<{ id: string; name: string; isTemplate: boolean }[]>(await api.get('/api/monitors'));
    const m = monitors.find((x) => !x.isTemplate)!;
    const link = await json<{ id: string }>(await api.post('/api/plant/assets/rvs-mill-02/links', { data: { kind: 'monitor', id: m.id } }));
    try {
      await page.reload();
      await expect(graph.getByTestId('flow-node-asset').locator('[data-live]')).toBeVisible();
      await expectAccessible(page, 'asset data flow with a problem and live status');
    } finally {
      await api.delete(`/api/plant/assets/rvs-mill-02/links/${link.id}`);
    }
  });

  test('an asset without an assignment says what to add', async ({ page }) => {
    await page.goto('/plant/assets/rvs-compressor-01/flow');
    await expect(page.getByTestId('flow-empty')).toContainText('Assign a device profile to see the data flow');
    await expectAccessible(page, 'asset data flow, empty');
  });

  test('with reduced motion nothing moves; the switch says why', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/plant/assets/rvs-mill-01/flow');
    await picture(page);
    const graph = page.getByTestId('flow-graph');
    await expect(graph.getByTestId('flow-node-if:opc-ua')).toBeVisible();
    await expect(graph).not.toHaveAttribute('data-animated', 'true');
    await expect(graph.locator('.pv-edge-flow')).toHaveCount(0);
    await expect(page.getByRole('switch', { name: 'Animation off' })).toBeDisabled();
    await expect(page.getByRole('switch', { name: 'Animation off' })).toBeChecked();
    await expect(page.getByTestId('view-legend')).toContainText('the arrow shows its direction');
  });

  test('data point lineage: the assets that deliver it, where they publish it, the KPIs that read it', async ({ page }) => {
    await page.goto('/plant/profiles/example-controls-c80/points/program_status');
    const view = page.getByTestId('point-lineage-view');
    await expect(view).toBeVisible();
    await picture(page);
    const graph = view.getByTestId('flow-graph');
    await expect(graph.getByTestId('flow-node-asset:rvs-mill-01')).toBeVisible();
    await expect(graph.getByTestId('flow-node-asset:rvs-mill-02')).toHaveAttribute('data-inactive', 'true');
    await expect(graph.getByTestId('flow-node-kpi:machine-state-time')).toContainText('2 jobs');
    await view.getByTestId('flow-path-rvs-mill-01').hover();
    await expect(graph.getByTestId('flow-node-tgt:iot-platform')).toHaveAttribute('data-hl', 'true');
    await expectAccessible(page, 'data point lineage');
  });

  test('KPI coverage: the matrix with its states, filters, a cell that opens the asset; the KPI page; the site tiles', async ({ page }) => {
    await page.goto('/plant/explore');
    await page.getByTestId('explore-mode').getByText('KPI coverage').click();
    await expect(page).toHaveURL(/view=coverage/);
    await picture(page);
    const matrix = page.getByTestId('coverage-matrix');
    await expect(matrix.getByRole('link', { name: /Milling centre 2, Time in machine state: Problem/ })).toBeVisible();
    await expect(matrix.getByRole('link', { name: /Milling centre 1, Time in machine state: Has it/ })).toBeVisible();
    await expect(
      matrix.getByRole('link', { name: /Milling centre 1, Energy consumption: Cannot.*reads data points of profile example-meters-pm200/ }),
    ).toBeVisible();
    // the demo site's figures (other specs add sites of their own while this one runs)
    await page.goto('/plant/explore?view=coverage&site=riverside');
    await picture(page);
    await expect(page.getByTestId('coverage-summary')).toContainText('KPI coverage 100 %');
    await expect(page.getByTestId('coverage-legend')).toContainText('Device delivers, not collected');
    await expectAccessible(page, 'KPI coverage matrix');
    // a hovered cell says what is missing
    await matrix.getByRole('link', { name: /Milling centre 2, Time in machine state/ }).hover();
    await expect(page.getByTestId('coverage-detail')).toContainText('is not set up as active on this asset');
    // the filters are part of the address
    await page.getByTestId('coverage-site').click();
    await page.getByRole('option', { name: 'Hillcrest Plant' }).click();
    await expect(page).toHaveURL(/site=hillcrest/);
    await expect(matrix.getByRole('link', { name: /Milling centre/ })).toHaveCount(0);
    await expect(matrix.getByRole('link', { name: /Moulding machine 1, Energy consumption: Cannot/ })).toBeVisible();
    await page.goto('/plant/explore?view=coverage&profile=example-controls-c80');
    await matrix.getByRole('link', { name: /Milling centre 1, Time in machine state/ }).click();
    await expect(page).toHaveURL(/\/plant\/assets\/rvs-mill-01\/flow$/);
    // the list alternative
    await page.goto('/plant/explore?view=coverage');
    await page.getByTestId('view-mode').getByText('Table').click();
    await expect(page.getByTestId('coverage-list')).toContainText('Time in machine state: Problem');
    await expectAccessible(page, 'KPI coverage list');
    await picture(page);

    await page.goto('/plant/kpis/machine-state-time');
    const card = page.getByTestId('kpi-coverage-card');
    await expect(card.getByTestId('coverage-total-has')).toContainText('1');
    await expect(card.getByTestId('coverage-total-problem')).toContainText('1');
    await card.getByTestId('kpi-coverage-link').click();
    await expect(page).toHaveURL(/view=coverage&kpi=machine-state-time/);
    await expect(page.getByTestId('coverage-matrix').locator('thead th')).toHaveCount(2);

    await page.goto('/plant/sites');
    const tile = page.getByTestId('site-tile-riverside');
    await expect(tile.getByTestId('tile-coverage')).toContainText('100 %');
    await expect(tile.getByTestId('tile-checks')).toContainText('1 open check');
    await tile.getByRole('link', { name: 'Structure' }).click();
    await expect(page).toHaveURL(/\/plant\/sites\/riverside\/structure$/);
  });
});

test.describe('as a viewer', () => {
  test.use({ storageState: authFile('vera') });
  test.beforeEach(async ({ apiAs }) => plantOn(await apiAs('admin')));

  test('the empty data flow says who assigns profiles', async ({ page }) => {
    await page.goto('/plant/assets/rvs-press-01/flow');
    await expect(page.getByTestId('flow-empty')).toContainText('Whoever manages the site assigns device profiles.');
    await expect(page.getByTestId('flow-empty').getByRole('link')).toHaveCount(0);
  });
});

test.describe('on a phone', () => {
  test.use({ storageState: authFile('dana') });
  test.beforeEach(async ({ apiAs }) => plantOn(await apiAs('admin')));

  test('structure, data flow, lineage, coverage and the site tiles fit the screen – table and picture @mobile', async ({ page }) => {
    const pages: [string, string, (p: Page) => Promise<void>][] = [
      ['/plant/sites/riverside/structure', 'site structure', (p) => expect(p.getByTestId('site-structure')).toBeVisible()],
      ['/plant/assets/rvs-mill-01/flow', 'asset data flow', (p) => expect(p.getByTestId('asset-flow-view')).toBeVisible()],
      ['/plant/profiles/example-controls-c80/points/program_status', 'data point lineage', (p) => expect(p.getByTestId('point-lineage-view')).toBeVisible()],
      ['/plant/explore?view=coverage', 'KPI coverage', (p) => expect(p.getByTestId('coverage-summary')).toBeVisible()],
      ['/plant/kpis/machine-state-time', 'KPI coverage card', (p) => expect(p.getByTestId('kpi-coverage-card')).toBeVisible()],
      ['/plant/sites', 'site tiles', (p) => expect(p.getByTestId('site-tile-riverside')).toBeVisible()],
    ];
    for (const [url, name, ready] of pages) {
      await page.goto(url);
      await ready(page);
      await settle(page);
      // phones start with the table (the picture is one tap away)
      const mode = page.getByTestId('view-mode');
      if (await mode.count()) await expect(mode.locator('input[value="table"]')).toBeChecked();
      await expectNoHorizontalScroll(page);
      await expectAccessible(page, `${name} on a phone (table)`);
      if (await mode.count()) {
        await mode.getByText('Picture').click();
        await expectNoHorizontalScroll(page);
        await expectAccessible(page, `${name} on a phone (picture)`);
        await mode.getByText('Table').click();
      }
    }
  });
});
