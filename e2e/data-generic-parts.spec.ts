import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { animationsDone, expectAccessible } from './support/axe';
import { expectNoHorizontalScroll, json } from './support/helpers';

/**
 * Generic parts, bridges and connectors (0.25.0, ADR 0037 package A): a designer enters a generic part with its
 * technology, namespace and properties and converts it to a specific kind; the Orders pipeline shows its bridges
 * (Debezium → Kafka → Snowflake sink, a Node-RED flow) with their technology, a step made from a connector and the
 * OpenLineage export; the technology list under Settings → Catalogue → Data products, where an administrator adds an
 * entry. Phones get cards and no sideways scroll; axe (WCAG 2.2) on each page.
 */

let token = '';
let orders = '';

async function productId(admin: APIRequestContext, key: string): Promise<string> {
  const page = await json<{ items: { id: string; key: string }[] }>(await admin.get(`/api/data-products?q=${encodeURIComponent(key)}`));
  return page.items.find((p) => p.key === key)!.id;
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
}

/** An option of a select in the open dialog (the page behind it has selects of the same name). */
async function choose(page: Page, label: RegExp, option: string | RegExp, scope: Locator = page.getByRole('dialog')) {
  await scope.getByRole('combobox', { name: label }).click();
  await animationsDone(page);
  await page.getByRole('option', { name: option }).click();
}

test.describe('generic parts and bridges', () => {
  test.use({ storageState: authFile('dana') });
  test.beforeEach(async ({ apiAs }) => {
    if (orders) return;
    const admin = await apiAs('admin');
    const on = await admin.put('/api/settings/modules/dataProducts', { data: { enabled: true } });
    expect(on.ok(), await on.text()).toBe(true);
    token = `GEN${Date.now().toString(36).toUpperCase()}`;
    orders = await productId(admin, 'orders');
  });

  test('a generic part with technology, namespace and properties, converted to a specific kind', async ({ page }) => {
    await page.goto('/data-elements');
    await page.getByTestId('element-new').click();
    await choose(page, /^Kind/, 'Stream (generic)');
    await page.getByTestId('element-name').fill(`invented/${token.toLowerCase()}/telemetry`);
    await expect(page.getByTestId('element-generic')).toBeVisible();
    // the technology from the list, its namespace pattern as the hint
    await page.getByTestId('element-technology').fill('MQTT');
    await expect(page.getByTestId('element-namespace')).toHaveAttribute('placeholder', 'mqtt://{host}:{port}');
    await page.getByTestId('element-namespace').fill('mqtt://broker.invented.example:1883');
    await page.getByTestId('element-property-add').click();
    await page.getByRole('textbox', { name: 'Key of property 1' }).fill('qos');
    await page.getByRole('textbox', { name: 'Value of property 1' }).fill('1');
    await expectAccessible(page, 'element form: a generic part');
    await page.getByTestId('element-save').click();
    await expect(page).toHaveURL(/\/data-elements\/dpe_/);
    await expect(page.getByTestId('technology-badge').first()).toContainText('MQTT');
    const facts = page.getByTestId('element-generic-facts');
    await expect(facts).toContainText('mqtt://broker.invented.example:1883');
    await expect(facts).toContainText('qos:');
    await expectAccessible(page, 'a generic part');

    // Convert to …: a Kafka topic of Kafka (demo) – the same element, discovery looks after it from then on
    await page.getByTestId('detail-actions').click();
    await page.getByTestId('element-convert').click();
    await choose(page, /^Kind/, 'Kafka topic');
    await choose(page, /^Platform/, 'Kafka (demo)');
    await page.getByTestId('convert-name').fill(`telemetry.${token.toLowerCase()}`);
    await expectAccessible(page, 'convert to');
    await page.getByTestId('convert-save').click();
    await expect(page.getByText('Converted to Kafka topic')).toBeVisible();
    // the same page, now a Kafka topic named as the platform names it (its display name is the last part)
    await expect(page.getByRole('heading', { level: 1 })).toContainText(token.toLowerCase());
    await expect(page.getByText(`telemetry.${token.toLowerCase()} · Kafka (demo)`, { exact: false })).toBeVisible();
    await expect(page.getByTestId('element-generic-section')).toHaveCount(0);
  });

  test('the pipeline: bridges with their technology, a step from a connector, the OpenLineage export', async ({ page }) => {
    await page.goto(`/data-products/${orders}/pipeline?environment=prod`);
    const steps = page.getByTestId('product-steps');
    const capture = steps.getByTestId('step-Capture shop orders');
    await expect(capture).toContainText('Bridge');
    await expect(capture.getByTestId('technology-badge')).toContainText('Debezium');
    await expect(steps.getByTestId('step-Forward returns').getByTestId('technology-badge')).toContainText('Node-RED');
    // the picture names the bridge in its legend
    await expect(page.getByText('A bridge: moves data between technologies', { exact: false })).toBeVisible();
    // the export of the product and of a step are downloads
    await expect(page.getByTestId('steps-openlineage')).toHaveAttribute('href', /\/api\/data-products\/dpr_[^/]+\/openlineage\?environment=prod/);
    const download = page.waitForEvent('download');
    await capture.getByTestId('step-openlineage').click();
    expect((await download).suggestedFilename()).toBe('orders-Capture-shop-orders.openlineage.jsonl');
    await expectAccessible(page, 'pipeline with bridges');

    // Create step from connector: the Snowflake sink of Kafka Connect (demo)
    await page.getByTestId('step-from-connector').click();
    await choose(page, /^Platform/, 'Kafka Connect (demo)');
    await choose(page, /^Connector/, /^orders-snowflake-sink/);
    const draft = page.getByTestId('connector-draft');
    await expect(draft.getByTestId('connector-draft-outputs')).toContainText('SHOP.RAW.ORDERS_RAW');
    await expect(draft.getByTestId('connector-draft-inputs')).toContainText('shop.public.orders');
    await expectAccessible(page, 'create step from connector');
    await page.getByTestId('connector-step-name').fill(`Sink ${token}`);
    await page.getByTestId('connector-step-save').click();
    await expect(steps.getByTestId(`step-Sink ${token}`)).toContainText('Kafka Connect');
  });

  test('the technology list in the settings; an administrator adds an entry', async ({ browser, apiAs }) => {
    // every reader of the module reads the list (the API); the settings page is the administrators'
    const vera = await apiAs('vera');
    const read = await vera.get('/api/data-products/technologies');
    expect(read.ok()).toBe(true);
    expect((await json<{ key: string }[]>(read)).map((x) => x.key)).toContain('debezium');
    const ctx = await browser.newContext({ storageState: authFile('admin') });
    const admin = await ctx.newPage();
    try {
      await admin.goto('/settings/catalogue');
      const list = admin.getByTestId('data-technologies');
      await expect(list.getByTestId('technology-debezium')).toContainText('Debezium');
      await expectAccessible(admin, 'technology list');
      await admin.getByTestId('technology-add').click();
      await admin.getByTestId('technology-name').fill(`Invented Bus ${token}`);
      await admin.getByTestId('technology-key').fill(`invented-bus-${token.toLowerCase()}`);
      await admin.getByTestId('technology-pattern').fill('ibus://{host}');
      await expectAccessible(admin, 'technology form');
      await admin.getByTestId('technology-save').click();
      await expect(admin.getByTestId(`technology-invented-bus-${token.toLowerCase()}`)).toContainText(`Invented Bus ${token}`);
    } finally {
      await ctx.close();
    }
  });

  test('generic parts and bridges on a phone @mobile', async ({ page }) => {
    await page.goto(`/data-products/${orders}/pipeline?environment=prod`);
    await expect(page.getByTestId('product-steps')).toBeVisible();
    await settle(page);
    await expectNoHorizontalScroll(page);
    await page.goto('/data-elements?kind=generic.endpoint');
    await expect(page.getByTestId('element-card').first()).toContainText('returns-desk/returns');
    await expectNoHorizontalScroll(page);
    await page.getByTestId('element-card').first().getByRole('link').click();
    await expect(page.getByTestId('element-generic-facts')).toContainText('https://returns.invented.example');
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'a generic part on a phone');
  });
});
