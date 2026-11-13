import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { animationsDone, expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll, json } from './support/helpers';

/**
 * The pages of the data products module (ADR 0036 part 13, WP5): a designer creates a product, adds elements from the
 * catalogue with the server-side search, binds an output port to a data contract and deprecates the product (which
 * needs a sunset date); a viewer sees what the team scope allows – a team's product is neither listed nor opened,
 * and an element's other product is counted, not named; phones get cards and no sideways scroll; axe on each page.
 * The data is seeded through the API (the demo comes with WP8).
 */

interface Seed {
  token: string;
  raw: string;
  curated: string;
  shared: string;
  contract: string;
  publicProduct: string;
  secretProduct: string;
}

let seeded: Promise<Seed> | null = null;

async function post<T = { id: string }>(api: APIRequestContext, url: string, data: unknown): Promise<T> {
  return json<T>(await api.post(url, { data }));
}

async function seed(admin: APIRequestContext): Promise<Seed> {
  const on = await admin.put('/api/settings/modules/dataProducts', { data: { enabled: true } });
  expect(on.ok(), await on.text()).toBe(true);
  const token = `WPF${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const key = token.toLowerCase();
  const platforms = await json<{ id: string; kind: string }[]>(await admin.get('/api/platforms'));
  const snowflake = platforms.find((p) => p.kind === 'snowflake')!.id;
  const el = async (name: string, layer: string) =>
    (await post(admin, '/api/data-elements', { platformId: snowflake, kind: 'snowflake.table', qualifiedName: name, environment: 'prod', layer })).id;
  const raw = await el(`${token}.RAW.ORDERS`, 'raw');
  const curated = await el(`${token}.CURATED.ORDERS`, 'curated');
  const shared = await el(`${token}.CRM.CUSTOMERS`, 'source');
  const yaml = [
    'apiVersion: v3.0.2',
    'kind: DataContract',
    `id: ${key}-orders`,
    `name: Orders contract ${token}`,
    'version: 1.0.0',
    'status: active',
    'schema:',
    '  - name: orders',
    '    physicalType: table',
    '    properties:',
    '      - name: id',
    '        logicalType: integer',
    '        required: true',
    '',
  ].join('\n');
  const contract = (await post<{ id: string }>(admin, '/api/data-contracts', { yaml, links: [] })).id;
  // a product everyone sees and a team's product a viewer outside the team may not see, both reading CRM.CUSTOMERS
  const publicProduct = (await post(admin, '/api/data-products', { key: `${key}-customer`, name: `Customer 360 ${token}` })).id;
  const secretProduct = (await post(admin, '/api/data-products', { key: `${key}-secret`, name: `Secret CRM ${token}` })).id;
  await post(admin, `/api/data-products/${publicProduct}/members`, { elementIds: [shared], role: 'input' });
  await post(admin, `/api/data-products/${secretProduct}/members`, { elementIds: [shared], role: 'input' });
  const team = (await post(admin, '/api/teams', { name: `Data team ${token}`, members: ['dana'] })).id;
  expect((await admin.put(`/api/owning-teams/data_product/${secretProduct}`, { data: { teamIds: [team] } })).ok()).toBe(true);
  return { token, raw, curated, shared, contract, publicProduct, secretProduct };
}

/** Picks an option of a Mantine Select by its test id (the list page behind a dialog has selects with the same labels). */
async function choose(page: Page, testId: string, option: string) {
  await page.getByTestId(testId).click();
  await animationsDone(page);
  await page.getByRole('option', { name: option }).click();
}

/** A Mantine MultiSelect that searches on the server: type, wait for the option, pick it. */
async function pickElement(page: Page, testId: string, search: string, option: string) {
  const input = page.getByTestId(testId);
  await input.click();
  await input.fill(search);
  const found = page.getByRole('option', { name: option });
  await expect(found).toBeVisible({ timeout: 30_000 });
  await found.click();
  // a MultiSelect stays open for the next pick: Tab leaves it (and closes it)
  await input.press('Tab');
}

test.describe('the data products pages', () => {
  test.use({ storageState: authFile('dana') });
  let s: Seed;
  test.beforeEach(async ({ apiAs }) => {
    seeded ??= (async () => seed(await apiAs('admin')))();
    s = await seeded;
  });

  test('a designer creates a product, adds elements, binds a port to a contract and deprecates it', async ({ page }) => {
    await page.goto('/data-products');
    await expect(page.getByRole('heading', { level: 1, name: 'Data products' })).toBeVisible();
    // Data in the sidebar, with the data contracts beside the module's pages
    const data = page.locator('[data-group="data"]');
    await expect(data.getByRole('link', { name: 'Data products' })).toBeVisible();
    await expect(data.getByRole('link', { name: 'Data contracts' })).toBeVisible();
    await expect(page.locator('[data-group="catalogue"]').getByRole('link', { name: 'Data contracts' })).toHaveCount(0);
    await expectAccessible(page, 'data products list');

    // create
    await page.getByTestId('product-new').click();
    await page.getByTestId('product-name').fill(`Orders ${s.token}`);
    await expect(page.getByTestId('product-key')).toHaveValue(`orders-${s.token.toLowerCase()}`);
    await choose(page, 'product-type', 'Source-aligned');
    await page.getByTestId('product-save').click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`Orders ${s.token}`);
    await expect(page.getByTestId('product-objects')).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'data product overview');

    // add elements: the picker searches the catalogue on the server
    await page.getByTestId('product-tab-elements').click();
    await page.getByTestId('member-add').click();
    await pickElement(page, 'member-picker', `${s.token}.RAW`, `${s.token}.RAW.ORDERS`);
    await pickElement(page, 'member-picker', `${s.token}.CURATED`, `${s.token}.CURATED.ORDERS`);
    await page.getByTestId('member-save').click();
    const members = page.getByTestId('member-table');
    await expect(members.getByRole('link', { name: `${s.token}.RAW.ORDERS` })).toBeVisible();
    await expect(members.getByRole('link', { name: `${s.token}.CURATED.ORDERS` })).toBeVisible();
    await expect(members).toContainText('No data');
    await expectAccessible(page, 'data product elements');

    // an output port, bound in prod to the curated table under the contract
    await page.getByTestId('product-tab-ports').click();
    await page.getByTestId('port-add-output').click();
    await page.getByTestId('port-name').fill('orders');
    await page.getByTestId('port-version').fill('v1');
    await page.getByTestId('port-save').click();
    const port = page.getByTestId('port-orders');
    await expect(port).toContainText('Not bound in prod');
    await port.getByTestId('port-bind').click();
    await pickElement(page, 'binding-elements', `${s.token}.CURATED`, `${s.token}.CURATED.ORDERS`);
    await choose(page, 'binding-contract', `Orders contract ${s.token} (${s.token.toLowerCase()}-orders)`);
    await page.getByTestId('binding-save').click();
    await expect(port.getByTestId('binding-contract-line')).toContainText(`Orders contract ${s.token}`);
    await expect(port.getByTestId('port-binding')).toContainText(`${s.token}.CURATED.ORDERS`);
    await settle(page);
    await expectAccessible(page, 'data product ports');

    // deprecating needs a sunset date: asked before the server is
    await page.getByTestId('product-lifecycle').click();
    await choose(page, 'lifecycle-to', 'Deprecated');
    await page.getByTestId('lifecycle-save').click();
    await expect(page.getByText('Deprecating needs a sunset date')).toBeVisible();
    await page.getByTestId('lifecycle-sunset').fill('2027-03-31');
    await page.getByTestId('lifecycle-save').click();
    await expect(page.getByRole('heading', { level: 1 }).locator('[data-lifecycle="deprecated"]')).toBeVisible();

    // the health tab proposes a monitor before anything is made
    await page.getByTestId('product-tab-health').click();
    await page.getByTestId('monitor-propose').click();
    await expect(page.getByTestId('monitor-proposal')).toBeVisible();
    await expect(page.getByTestId('monitor-apply')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();

    // the list finds it by its lifecycle; the costs and the scorecard tabs answer
    await page.getByTestId('product-tab-costs').click();
    await expect(page.getByTestId('cost-matches')).toBeVisible();
    await page.goto('/data-products?lifecycle=deprecated');
    await expect(page.getByTestId('product-table').getByRole('link', { name: `Orders ${s.token}` })).toBeVisible();
  });

  test('the catalogue, an element, data objects, domains and discovery', async ({ page }) => {
    await page.goto(`/data-elements?prefix=${s.token}.`);
    const table = page.getByTestId('element-table');
    await expect(table.getByRole('link', { name: `${s.token}.CRM.CUSTOMERS` })).toBeVisible();
    await expectAccessible(page, 'element catalogue');
    await table.getByRole('link', { name: `${s.token}.CRM.CUSTOMERS` }).click();
    // dana sees both products of the shared table
    await expect(page.getByTestId('element-products')).toContainText(`Customer 360 ${s.token}`);
    await expect(page.getByTestId('element-products')).toContainText(`Secret CRM ${s.token}`);
    await expectAccessible(page, 'element page');
    await page.getByTestId('element-tab-checks').click();
    await expect(page.getByTestId('element-checks')).toContainText('No data');
    await page.goto('/data-objects');
    await expect(page.getByRole('heading', { level: 1, name: 'Data objects' })).toBeVisible();
    await expectAccessible(page, 'data objects');
    await page.goto('/data-domains');
    await expect(page.getByRole('heading', { level: 1, name: 'Domains' })).toBeVisible();
    await expectAccessible(page, 'domains');
    await page.goto('/data-products/discovery');
    await expect(page.getByRole('heading', { level: 1, name: 'Discovery' })).toBeVisible();
    await expectAccessible(page, 'discovery');
  });

  test('team scope: a viewer neither sees a team’s product nor its name on a shared element', async ({ loginAs }) => {
    const vera = await loginAs('vera');
    await vera.goto(`/data-products?q=${s.token}`);
    const list = vera.getByTestId('product-table');
    await expect(list.getByRole('link', { name: `Customer 360 ${s.token}` })).toBeVisible();
    await expect(vera.getByText(`Secret CRM ${s.token}`)).toHaveCount(0);
    // no button a viewer could not use
    await expect(vera.getByTestId('product-new')).toHaveCount(0);
    await vera.goto(`/data-products/${s.secretProduct}`);
    await expect(vera.getByTestId('detail-not-found')).toBeVisible();
    await expect(vera.getByText(`Secret CRM ${s.token}`)).toHaveCount(0);
    // the shared table counts the other product without naming it
    await vera.goto(`/data-elements/${s.shared}`);
    const products = vera.getByTestId('element-products');
    await expect(products).toContainText(`Customer 360 ${s.token}`);
    await expect(products).toContainText('1 you may not see');
    await expect(products).not.toContainText('Secret CRM');
    await expectAccessible(vera, 'element page as a viewer');
  });

  test('data products on a phone @mobile', async ({ page }) => {
    await page.goto(`/data-products?q=${s.token}`);
    await expect(page.getByTestId('product-card').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'data products on a phone');
    await page.goto(`/data-products/${s.publicProduct}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`Customer 360 ${s.token}`);
    await expectNoHorizontalScroll(page);
    await page.getByTestId('product-tab-elements').click();
    await expect(page.getByTestId('member-card').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'product elements on a phone');
    await page.goto(`/data-elements?prefix=${s.token}.`);
    await expect(page.getByTestId('element-card').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.goto(`/data-elements/${s.shared}`);
    await expect(page.getByTestId('element-products')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
