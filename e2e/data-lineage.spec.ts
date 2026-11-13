import { request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile, origin } from './support/env';
import { withBasePath } from './support/basePath';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll, json } from './support/helpers';

/**
 * Lineage from tools (0.24.0, ADR 0036 phase 2): a designer sets up an OpenLineage source on the Discovery page, makes
 * a push token (shown once), a tool pushes a run event with it, and the job waits as a proposed step – accepted, it is a
 * step; an open proposal is a dotted, named _proposed_ way in an element's lineage. A dbt source takes manifest.json as
 * an upload. Phones get cards and no sideways scroll; axe on each page. The demo's discovered elements (with their
 * OpenLineage datasets) are what the events name.
 */

interface El {
  id: string;
  olNamespace: string;
  olName: string;
}

const SCHEMA = 'https://openlineage.io/spec/2-0-2/OpenLineage.json#/$defs/RunEvent';

async function element(admin: APIRequestContext, qn: string): Promise<El> {
  const page = await json<{ items: { id: string; qualifiedName: string }[] }>(
    await admin.get(`/api/data-elements?prefix=${encodeURIComponent(qn)}&environment=prod`),
  );
  const hit = page.items.find((x) => x.qualifiedName === qn);
  expect(hit, qn).toBeTruthy();
  return json<El>(await admin.get(`/api/data-elements/${hit!.id}`));
}

/** A push as a tool sends it: no session, only the source's push token. */
async function push(sourceId: string, token: string, body: unknown): Promise<string> {
  const ctx = await playwrightRequest.newContext({ baseURL: origin(), storageState: { cookies: [], origins: [] } });
  try {
    const res = await ctx.post(withBasePath(`/api/hooks/data-lineage/${sourceId}`), {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      data: JSON.stringify(body),
    });
    return `${res.status()}${res.ok() ? '' : ` ${await res.text()}`}`;
  } finally {
    await ctx.dispose();
  }
}

const event = (job: string, inputs: El[], outputs: El[]) => ({
  eventType: 'COMPLETE',
  eventTime: new Date().toISOString(),
  run: { runId: `0190c3d4-${Math.random().toString(16).slice(2, 6)}-7000-8000-000000000001` },
  job: { namespace: 'airflow-invented', name: job, facets: { jobType: { integration: 'AIRFLOW', jobType: 'TASK', processingType: 'BATCH' } } },
  inputs: inputs.map((e) => ({ namespace: e.olNamespace, name: e.olName })),
  outputs: outputs.map((e) => ({ namespace: e.olNamespace, name: e.olName })),
  producer: 'https://example.com/invented-airflow',
  schemaURL: SCHEMA,
});

let token = '';
let els: { orders: El; staged: El; customers: El } | null = null;

test.describe('lineage from tools', () => {
  test.use({ storageState: authFile('dana') });
  test.beforeEach(async ({ apiAs }) => {
    if (els) return;
    const admin = await apiAs('admin');
    const on = await admin.put('/api/settings/modules/dataProducts', { data: { enabled: true } });
    expect(on.ok(), await on.text()).toBe(true);
    token = `LIN${Date.now().toString(36).toUpperCase()}`;
    els = {
      orders: await element(admin, 'SHOP.SALES.ORDERS'),
      staged: await element(admin, 'SHOP.STAGED.ORDERS'),
      customers: await element(admin, 'SHOP.CURATED.CUSTOMERS'),
    };
  });

  test('an OpenLineage source, its push token, a pushed job accepted as a step, a proposed way in the lineage', async ({ page }) => {
    const e = els!;
    await page.goto('/data-products/discovery');
    await expect(page.getByTestId('lineage-section')).toBeVisible();
    await expectAccessible(page, 'discovery with lineage sources');
    await page.getByTestId('lineage-source-new').click();
    await page.getByTestId('lineage-source-name').fill(`Airflow ${token}`);
    await page.getByTestId('lineage-source-save').click();
    await expect(page).toHaveURL(/\/data-products\/lineage\/dpl_/);
    const sourceId = /\/data-products\/lineage\/(dpl_[^/?#]+)/.exec(page.url())![1]!;
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`Airflow ${token}`);
    // the source's page belongs to Discovery in the navigation, not to the product list
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Discovery', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );

    // a push token, shown once
    await page.getByTestId('lineage-token-new').click();
    await page.getByTestId('lineage-token-name').fill('Airflow production');
    await page.getByTestId('lineage-token-create').click();
    const secret = page.getByTestId('lineage-token-secret');
    await expect(secret).toBeVisible();
    const pushToken = ((await secret.locator('pre, code').first().textContent()) ?? '').trim();
    expect(pushToken).toMatch(/^sdl_/);
    await expect(secret).toContainText('OPENLINEAGE_API_KEY');
    // a click beside the dialog does not lose the token; each copy button names its block
    await page.mouse.click(5, 5);
    await expect(secret).toBeVisible();
    await expect(secret.getByRole('button', { name: 'Copy Token', exact: true })).toBeVisible();
    await page.getByTestId('lineage-token-done').click();
    await expect(page.getByTestId('lineage-token')).toHaveCount(1);
    await expectAccessible(page, 'lineage source');

    // the tool pushes two jobs: one is accepted, the other stays proposed
    expect(await push(sourceId, pushToken, event(`load_customers_${token}`, [e.orders], [e.customers]))).toBe('200');
    expect(await push(sourceId, pushToken, event(`score_${token}`, [e.staged], [e.customers]))).toBe('200');
    await page.reload();
    const inbox = page.getByTestId('lineage-source-proposals');
    const row = inbox.getByRole('row').filter({ hasText: `load_customers_${token}` });
    await expect(row).toContainText('SHOP.SALES.ORDERS');
    await expect(row).toContainText('Complete');
    await row.getByTestId('proposal-accept').click();
    await expect(page.getByTestId('proposal-accept-form')).toBeVisible();
    await page.getByTestId('proposal-accept-confirm').click();
    await expect(page.getByText('Step saved')).toBeVisible();
    await expect(inbox.getByRole('row').filter({ hasText: `load_customers_${token}` })).toHaveCount(0);
    await inbox.getByTestId('proposal-status').getByText('Accepted').click();
    await expect(inbox.getByRole('row').filter({ hasText: `load_customers_${token}` })).toBeVisible();

    // the open proposal is a proposed way in the lineage of the customer table: dotted, named in words
    await page.goto(`/data-elements/${e.customers.id}/lineage?depth=1`);
    await expect(page.locator('[data-proposed="true"]').first()).toBeAttached();
    await page.getByTestId('view-mode').getByText('Table').click();
    await expect(page.getByTestId('lineage-step-proposed').first()).toBeVisible();
    await expectAccessible(page, 'lineage with a proposed way');
  });

  test('a dbt source takes manifest.json as an upload', async ({ page }) => {
    await page.goto('/data-products/discovery');
    await page.getByTestId('lineage-source-new').click();
    await page.getByTestId('lineage-source-name').fill(`dbt ${token}`);
    await page.getByTestId('lineage-source-kind').getByText('dbt').click();
    await page.getByTestId('lineage-source-platform').click();
    await page.getByRole('option', { name: 'Snowflake (demo)' }).click();
    await page.getByTestId('lineage-source-save').click();
    await expect(page).toHaveURL(/\/data-products\/lineage\/dpl_/);
    const manifest = {
      metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/manifest/v12.json', adapter_type: 'snowflake' },
      nodes: {
        [`model.shop.region_${token.toLowerCase()}`]: {
          resource_type: 'model',
          name: `region_${token.toLowerCase()}`,
          unique_id: `model.shop.region_${token.toLowerCase()}`,
          database: 'SHOP',
          schema: 'MART',
          alias: 'ORDERS_BY_REGION',
          config: { materialized: 'view' },
          depends_on: { nodes: ['source.shop.sales.orders'] },
        },
      },
      sources: {
        'source.shop.sales.orders': {
          resource_type: 'source',
          name: 'orders',
          unique_id: 'source.shop.sales.orders',
          database: 'SHOP',
          schema: 'SALES',
          identifier: 'ORDERS',
        },
      },
    };
    await page
      .getByTestId('lineage-dbt')
      .locator('input[type="file"]')
      .first()
      .setInputFiles({ name: 'manifest.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(manifest)) });
    await expect(page.getByText('manifest.json read')).toBeVisible();
    await expect(page.getByTestId('lineage-last-import')).toContainText('1 proposed');
    await expect(
      page
        .getByTestId('lineage-source-proposals')
        .getByRole('row')
        .filter({ hasText: `region_${token.toLowerCase()}` }),
    ).toContainText('SHOP.MART.ORDERS_BY_REGION');
    await expectAccessible(page, 'dbt lineage source');
  });

  test('lineage sources and proposals on a phone @mobile', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    const e = els!;
    const src = await json<{ id: string }>(
      await admin.post('/api/data-products/lineage-sources', { data: { name: `Phone jobs ${token}`, kind: 'openlineage', teamIds: [] } }),
    );
    const t = await json<{ token: string }>(await admin.post(`/api/data-products/lineage-sources/${src.id}/tokens`, { data: { name: 'CI' } }));
    expect(await push(src.id, t.token, event(`phone_${token}`, [e.staged], [e.orders]))).toBe('200');
    await page.goto('/data-products/discovery');
    await expect(page.getByTestId('lineage-sources')).toBeVisible();
    await expect(page.getByTestId('proposal-card').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    // the four statuses one below the other: the filter stays inside the page, none is cut off at the edge
    const filter = page.getByTestId('lineage-inbox').getByTestId('proposal-status');
    await expect(filter).toHaveAttribute('data-orientation', 'vertical');
    const box = await filter.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await expectAccessible(page, 'discovery with lineage on a phone', { wcag22: true });
    await page.goto(`/data-products/lineage/${src.id}`);
    await expect(page.getByTestId('proposal-card').filter({ hasText: `phone_${token}` })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'lineage source on a phone');
  });
});
