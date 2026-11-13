import fs from 'node:fs';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll, json } from './support/helpers';

/**
 * The pictures of the data products module (ADR 0036 part 13, WP6): a product's pipeline, the product map and an
 * element's lineage – each with its table, keyboard access (focusable named nodes, Space selects, Enter opens), the
 * search, _Fit to screen_, the legend, reduced motion, the export, team scope (a second user sees what they may not
 * see without a name), a large pipeline collapsed for the picture, and phones (table first). Data is seeded here
 * (the demo comes with WP8).
 */

interface Seed {
  token: string;
  orders: string;
  mart: string;
  big: string;
  raw: string;
  staged: string;
  curated: string;
  devRaw: string;
  martTable: string;
  secretEl: string;
}

let seeded: Promise<Seed> | null = null;

async function post<T = { id: string }>(api: APIRequestContext, url: string, data: unknown): Promise<T> {
  return json<T>(await api.post(url, { data }));
}

/** Seeded by the administrator (in no team: nothing is team-owned unless said), the secret part owned by a team of dana's. */
async function seed(admin: APIRequestContext): Promise<Seed> {
  const on = await admin.put('/api/settings/modules/dataProducts', { data: { enabled: true } });
  expect(on.ok(), await on.text()).toBe(true);
  const token = `E2E${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const key = token.toLowerCase();
  const platforms = await json<{ id: string; kind: string }[]>(await admin.get('/api/platforms'));
  const snowflake = platforms.find((p) => p.kind === 'snowflake')!.id;
  const kafka = platforms.find((p) => p.kind === 'kafka')!.id;
  const el = async (name: string, layer: string, environment = 'prod', kind = 'snowflake.table', platformId = snowflake) =>
    (await post(admin, '/api/data-elements', { platformId, kind, qualifiedName: name, environment, layer })).id;
  const domain = (await post(admin, '/api/data-domains', { key: `${key}-sales`, name: `Sales ${token}` })).id;
  const orders = (await post(admin, '/api/data-products', { key: `${key}-orders`, name: `Orders ${token}`, type: 'sourceAligned', domainId: domain })).id;
  const mart = (await post(admin, '/api/data-products', { key: `${key}-mart`, name: `Sales mart ${token}`, type: 'consumerAligned', domainId: domain })).id;
  const topic = await el(`${key}.orders.v1`, 'source', 'prod', 'kafka.topic', kafka);
  const raw = await el(`${token}.RAW.ORDERS`, 'raw');
  const staged = await el(`${token}.STAGED.ORDERS`, 'staged');
  const curated = await el(`${token}.CURATED.ORDERS`, 'curated');
  const devRaw = await el(`${token}_DEV.RAW.ORDERS`, 'raw', 'dev');
  const martTable = await el(`${token}.MART.REVENUE`, 'mart');
  await post(admin, `/api/data-products/${orders}/members`, { elementIds: [topic], role: 'input' });
  await post(admin, `/api/data-products/${orders}/members`, { elementIds: [raw, staged, devRaw], role: 'internal' });
  const out = await post(admin, `/api/data-products/${orders}/ports`, { direction: 'output', name: 'orders', type: 'table', version: 'v2' });
  expect((await admin.put(`/api/data-products/${orders}/ports/${out.id}/bindings/prod`, { data: { elementIds: [curated] } })).ok()).toBe(true);
  await post(admin, `/api/data-products/${orders}/steps`, {
    name: 'ingest',
    kind: 'ingest',
    inputs: [topic],
    outputs: [raw],
    runner: { kind: 'tool', tool: 'Kafka Connect', text: '' },
  });
  await post(admin, `/api/data-products/${orders}/steps`, { name: 'stage', kind: 'stage', inputs: [raw], outputs: [staged] });
  await post(admin, `/api/data-products/${orders}/steps`, { name: 'curate', kind: 'curate', inputs: [staged], outputs: [curated] });
  await post(admin, `/api/data-products/${mart}/members`, { elementIds: [martTable], role: 'output' });
  await post(admin, `/api/data-products/${mart}/ports`, { direction: 'input', name: 'orders', source: { kind: 'port', portId: out.id } });
  await post(admin, `/api/data-products/${mart}/steps`, { name: 'revenue', kind: 'transform', inputs: [curated], outputs: [martTable] });
  // a team's product and element that vera may not see, feeding the staged table
  const team = (await post(admin, '/api/teams', { name: `Secret team ${token}`, members: ['dana'] })).id;
  // the team takes no new items of its members: dana's items in the other specs stay the whole instance's
  expect((await admin.put(`/api/teams/${team}/settings`, { data: { newResources: 'never' } })).ok()).toBe(true);
  const secret = (await post(admin, '/api/data-products', { key: `${key}-secret`, name: `Secret CRM ${token}` })).id;
  const secretEl = await el(`${token}.SECRET.CUSTOMERS`, 'raw');
  for (const [kind, id] of [
    ['data_product', secret],
    ['data_element', secretEl],
  ])
    expect((await admin.put(`/api/owning-teams/${kind}/${id}`, { data: { teamIds: [team] } })).ok()).toBe(true);
  await post(admin, `/api/data-products/${secret}/members`, { elementIds: [secretEl], role: 'output' });
  await post(admin, `/api/data-products/${orders}/steps`, { name: 'enrich', kind: 'transform', inputs: [secretEl, raw], outputs: [staged] });
  // a large product: more elements than the picture draws
  const big = (await post(admin, '/api/data-products', { key: `${key}-big`, name: `Big ${token}` })).id;
  const many: string[] = [];
  for (let i = 0; i < 160; i++) many.push(await el(`${token}.BIG${i % 4}.T${i}`, ['raw', 'staged', 'curated', 'mart'][i % 4]!));
  await post(admin, `/api/data-products/${big}/members`, { elementIds: many, role: 'internal' });
  return { token, orders, mart, big, raw, staged, curated, devRaw, martTable, secretEl };
}

/** The picture of a view (not the table), whatever the last choice was. */
async function picture(page: Page) {
  await page.getByTestId('view-mode').getByText('Picture').click();
  await expect(page.getByTestId('data-graph')).toBeVisible();
}

test.describe('the pictures of data products', () => {
  test.use({ storageState: authFile('dana') });
  let s: Seed;
  test.beforeEach(async ({ apiAs }) => {
    seeded ??= (async () => seed(await apiAs('admin')))();
    s = await seeded;
  });

  test('pipeline: members in columns, steps, health in words, search, keyboard, environments, export and the table', async ({ page }) => {
    await page.goto(`/data-products/${s.orders}/views/pipeline`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`Pipeline of Orders ${s.token}`);
    await picture(page);
    const graph = page.getByTestId('data-graph');
    await expect(graph.getByTestId(`graph-node-${s.raw}`)).toContainText('No data');
    await expect(graph.getByTestId(`graph-node-${s.curated}`)).toContainText('orders v2');
    // the mart table reads the output: a neighbour outside the product, greyed, named with its product
    await expect(graph.getByTestId(`graph-node-${s.martTable}`)).toHaveAttribute('data-outside', 'true');
    await expect(graph.getByTestId(`graph-node-${s.martTable}`)).toContainText(`Sales mart ${s.token}`);
    await expect(graph.getByText('Inputs', { exact: true })).toBeVisible();
    await expect(graph.getByText('Downstream', { exact: true })).toBeVisible();
    await expect(graph).toHaveAttribute('data-animated', 'true');
    await expect(page.getByTestId('graph-legend')).toContainText('never OK');
    await expectAccessible(page, 'pipeline picture');
    // readable at first: never below 85 %; what lies beyond the frame is said, and the keyboard reaches it
    const zoom = () => graph.locator('.react-flow__viewport').evaluate((e) => new DOMMatrix(getComputedStyle(e).transform).a);
    expect(await zoom()).toBeGreaterThanOrEqual(0.85);
    await expect(page.getByTestId('graph-pan-hint')).toBeVisible();
    const last = graph.locator('.react-flow__node[tabindex="0"]').last();
    await last.focus();
    const frame = (await graph.boundingBox())!;
    await expect.poll(async () => (await last.boundingBox())!.x + (await last.boundingBox())!.width).toBeLessThanOrEqual(frame.x + frame.width);
    await page.getByTestId('graph-fit').click();
    await expect(page.getByTestId('graph-pan-hint')).toHaveCount(0);

    // the keyboard goes through the parts as the data flows: column by column, top to bottom
    const order = await graph.locator('.react-flow__node[tabindex="0"]').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
    expect(order.length).toBeGreaterThan(3);
    for (let i = 1; i < order.length; i++) {
      const [a, b] = [order[i - 1]!, order[i]!];
      expect(Math.round(a.x) < Math.round(b.x) || (Math.round(a.x) === Math.round(b.x) && a.y <= b.y), `part ${i} after part ${i - 1}`).toBe(true);
    }
    // a focusable, named node; Space selects it and highlights its way end to end
    const node = graph.locator(`.react-flow__node[data-id="${s.staged}"]`);
    await expect(node).toHaveAttribute('aria-label', /Snowflake table: ORDERS, .*STAGED\.ORDERS\. Role: Internal\. .*Health: No data.*Enter opens its page/);
    await node.focus();
    await page.keyboard.press(' ');
    await expect(page.getByTestId('graph-selection')).toContainText(`${s.token}.STAGED.ORDERS`);
    await expect(graph.getByTestId(`graph-node-${s.curated}`)).toHaveAttribute('data-hl', 'true');
    await expect(graph.getByTestId(`graph-node-${s.devRaw}`)).toHaveCount(0);
    // show only what is connected, then everything again
    await page.getByTestId('graph-only-connected').click();
    await expect(graph.getByTestId(`graph-node-${s.martTable}`)).toBeVisible();
    await page.getByTestId('graph-selection').getByRole('button', { name: 'Clear selection' }).click();
    await expect(page.getByTestId('graph-selection')).toContainText('Select a part');
    // Escape on a node clears the selection, too
    await node.focus();
    await page.keyboard.press(' ');
    await expect(node.getByTestId(`graph-node-${s.staged}`)).toHaveAttribute('data-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('graph-selection')).toContainText('Select a part');

    // the search finds and selects
    await page.getByTestId('graph-search').fill('REVENUE');
    await page.getByRole('option', { name: `${s.token}.MART.REVENUE` }).click();
    await expect(graph.getByTestId(`graph-node-${s.martTable}`)).toHaveAttribute('data-selected', 'true');
    await page.getByTestId('graph-fit').click();

    // the export, as SVG and PNG
    let download = page.waitForEvent('download');
    await page.getByTestId('view-export').click();
    await page.getByTestId('export-svg').click();
    const svg = await download;
    expect(svg.suggestedFilename()).toMatch(/^pipeline-of-orders-.*\.svg$/);
    // the date in the UI's format, as everywhere else in the app
    expect(fs.readFileSync((await svg.path())!, 'utf8')).toMatch(/documented as of \d{1,2} [A-Z][a-z]{2,3} \d{4}/);
    download = page.waitForEvent('download');
    await page.getByTestId('view-export').click();
    await page.getByTestId('export-png').click();
    expect((await download).suggestedFilename()).toMatch(/\.png$/);

    // another environment
    await page.getByTestId('pipeline-environment').click();
    await page.getByRole('option', { name: 'dev', exact: true }).click();
    await expect(page).toHaveURL(/environment=dev/);
    await expect(graph.getByTestId(`graph-node-${s.devRaw}`)).toBeVisible();

    // Enter opens the element's page
    await page.goto(`/data-products/${s.orders}/views/pipeline`);
    await graph.locator(`.react-flow__node[data-id="${s.raw}"]`).focus();
    await page.keyboard.press('Enter');
    await page.waitForURL((u) => u.pathname.endsWith(`/data-elements/${s.raw}`));

    // the table says the same in words
    await page.goto(`/data-products/${s.orders}/views/pipeline`);
    await page.getByTestId('view-mode').getByText('Table').click();
    const table = page.getByTestId('graph-nodes-table');
    await expect(table.getByRole('link', { name: 'ORDERS' }).first()).toBeVisible();
    await expect(table).toContainText('Input · source');
    await expect(page.getByTestId('graph-ways-table')).toContainText('Kafka Connect');
    await expectAccessible(page, 'pipeline table');
    await picture(page);
  });

  test('pipeline of a large product: collapsed in the picture, every element in the table', async ({ page }) => {
    await page.goto(`/data-products/${s.big}/views/pipeline`);
    await picture(page);
    await expect(page.getByTestId('graph-notes')).toContainText('groups elements');
    const graph = page.getByTestId('data-graph');
    await expect(graph.locator('[data-kind="collapsed"]').first()).toContainText('40 elements');
    await page.getByTestId('view-mode').getByText('Table').click();
    await expect(page.getByTestId('graph-tables')).toContainText('160 entries');
    await page.getByTestId('graph-table-more').click();
    await expect(page.getByTestId('graph-nodes-table').locator('tbody tr')).toHaveCount(160);
    await picture(page);
  });

  test('product map: domains, dependencies, filters in the address, neighbours greyed, the table', async ({ page }) => {
    await page.goto('/data-products/map');
    await expect(page.getByRole('heading', { level: 1, name: 'Product map' })).toBeVisible();
    await picture(page);
    const graph = page.getByTestId('data-graph');
    await expect(graph.getByTestId(`graph-node-${s.orders}`)).toContainText(`Orders ${s.token}`);
    await expect(graph.getByTestId(`graph-node-${s.orders}`)).toContainText('No data');
    await expect(graph.locator('[data-testid^="graph-area-domain:"]', { hasText: `Sales ${s.token}` })).toBeVisible();
    await expect(graph.getByTestId(`graph-edge-${s.orders}>${s.mart}`)).toBeAttached();
    await expectAccessible(page, 'product map');
    // the filters say what they are, as on the lists
    for (const name of ['Domain', 'Type', 'Lifecycle', 'Environment'])
      await expect(page.getByTestId('map-filters').getByText(name, { exact: true })).toBeVisible();
    // a filter is part of the address; what matches is drawn, its neighbours greyed
    await page.getByTestId('map-type').click();
    await page.getByRole('option', { name: 'Consumer-aligned' }).click();
    await expect(page).toHaveURL(/type=consumerAligned/);
    await expect(graph.getByTestId(`graph-node-${s.orders}`)).toHaveAttribute('data-outside', 'true');
    await expect(graph.getByTestId(`graph-node-${s.mart}`)).not.toHaveAttribute('data-outside', 'true');
    // select a product: what depends on it, and only that
    await graph.locator(`.react-flow__node[data-id="${s.mart}"]`).click();
    await expect(page.getByTestId('graph-selection')).toContainText('Connected to');
    await page.getByTestId('graph-only-connected').click();
    await expect(graph.getByTestId(`graph-node-${s.orders}`)).toBeVisible();
    await page.getByTestId('view-mode').getByText('Table').click();
    await expect(page.getByTestId('graph-nodes-table')).toContainText('Depends on or feeds a match');
    await expect(page.getByTestId('graph-ways-table')).toContainText('orders v2');
    await expectAccessible(page, 'product map table');
    await picture(page);
  });

  test('lineage of an element: across products, 1 to 4 steps', async ({ page }) => {
    await page.goto(`/data-elements/${s.staged}/views/lineage?depth=1`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Lineage of ORDERS');
    await picture(page);
    const graph = page.getByTestId('data-graph');
    await expect(graph.getByTestId(`graph-node-${s.raw}`)).toBeVisible();
    await expect(graph.getByTestId(`graph-node-${s.martTable}`)).toHaveCount(0);
    await page.getByTestId('lineage-depth').getByText('2 steps').click();
    await expect(page).toHaveURL(/depth=2/);
    await expect(graph.getByTestId(`graph-node-${s.martTable}`)).toBeVisible();
    await expect(graph.getByTestId(`graph-area-product:${s.mart}`)).toContainText(`Sales mart ${s.token}`);
    await expectAccessible(page, 'lineage picture');
    await page.getByTestId('view-mode').getByText('Table').click();
    await expect(page.getByTestId('graph-nodes-table')).toContainText('1 step upstream');
    await expectAccessible(page, 'lineage table');
    await picture(page);
  });

  test('with reduced motion nothing moves; the switch says why', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/data-products/${s.orders}/views/pipeline`);
    await picture(page);
    const graph = page.getByTestId('data-graph');
    await expect(graph.getByTestId(`graph-node-${s.raw}`)).toBeVisible();
    await expect(graph).not.toHaveAttribute('data-animated', 'true');
    await expect(graph.locator('.pv-edge-flow')).toHaveCount(0);
    await expect(page.getByRole('switch', { name: 'Animation off' })).toBeDisabled();
    await expect(page.getByTestId('graph-legend')).toContainText('the arrow shows its direction');
  });

  test('on a phone the table comes first, the picture a tap away', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/data-products/${s.orders}/views/pipeline`);
    await expect(page.getByTestId('data-pipeline-view')).toHaveAttribute('data-mode', 'table');
    await expect(page.getByRole('list', { name: 'Elements' })).toContainText(`${s.token}.STAGED.ORDERS`);
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'pipeline on a phone');
    await picture(page);
    await expectNoHorizontalScroll(page);
    await page.getByTestId('view-mode').getByText('Table').click();
  });
});

test.describe('what a reader may not see', () => {
  test.use({ storageState: authFile('vera') });
  let s: Seed;
  test.beforeEach(async ({ apiAs }) => {
    seeded ??= (async () => seed(await apiAs('admin')))();
    s = await seeded;
  });

  test('is drawn without a name in the pipeline, the map and the lineage', async ({ page }) => {
    await page.goto(`/data-products/${s.orders}/views/pipeline`);
    await picture(page);
    const graph = page.getByTestId('data-graph');
    await expect(graph.getByTestId('graph-node-hidden-1')).toContainText('An element you may not see');
    await expect(page.getByTestId('graph-notes')).toContainText('you may not see');
    await expect(page.locator('body')).not.toContainText('SECRET');
    await expect(page.locator('body')).not.toContainText('Secret CRM');
    await page.goto(`/data-elements/${s.staged}/views/lineage`);
    await picture(page);
    await expect(graph.getByTestId('graph-node-hidden-1')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('SECRET');
    await page.goto('/data-products/map');
    await picture(page);
    await expect(page.locator('body')).not.toContainText('Secret CRM');
    // a product they may not see: not found
    await page.goto(`/data-elements/${s.secretEl}/views/lineage`);
    await expect(page.getByText(/not found/i).first()).toBeVisible();
  });
});
