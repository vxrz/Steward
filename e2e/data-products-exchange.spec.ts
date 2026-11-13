import { request as pwRequest, type APIRequestContext, type Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { animationsDone, expectAccessible } from './support/axe';
import { expectNoHorizontalScroll, json } from './support/helpers';

/**
 * Data products phase 2, package D (ADR 0036 parts 2, 11, 14, 15): estimated against attributed on a product's Costs
 * tab and the estimate's _For a data product_; the split _by measured use_ in the allocation form; the import dialog's
 * mode _Replace an earlier import_ with its origin and a preview of what it removes; a proposal of an assistant under
 * AI requests, applied by a person; the Ossie export of the data objects. Axe on each page, a phone layout without
 * sideways scroll. The data is seeded through the API.
 */

const tag = () => `DPX${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;

async function post<T = { id: string }>(api: APIRequestContext, url: string, data: unknown): Promise<T> {
  return json<T>(await api.post(url, { data }));
}

interface Seed {
  product: string;
  estimate: string;
  key: string;
}

let seeded: Promise<Seed> | null = null;

/** A product in prod with a match shared with a second product, and an estimate of a demo service for it. */
async function seed(admin: APIRequestContext): Promise<Seed> {
  const on = await admin.put('/api/settings/modules/dataProducts', { data: { enabled: true } });
  expect(on.ok(), await on.text()).toBe(true);
  const t = tag();
  const key = t.toLowerCase();
  const platforms = await json<{ id: string; kind: string }[]>(await admin.get('/api/platforms'));
  const snowflake = platforms.find((p) => p.kind === 'snowflake')!.id;
  const product = (await post(admin, '/api/data-products', { key: `${key}-a`, name: `Measured ${t}` })).id;
  const other = (await post(admin, '/api/data-products', { key: `${key}-b`, name: `Other ${t}` })).id;
  for (const p of [product, other]) {
    expect((await admin.put(`/api/data-products/${p}/environments/prod`, { data: { state: 'available' } })).ok()).toBe(true);
    await post(admin, `/api/data-products/${p}/costs/matches`, { environment: 'prod', platformId: snowflake, kind: 'subAccount', value: `${t}-ACCT` });
  }
  const services = await json<{ id: string; name: string }[]>(await admin.get('/api/services'));
  const service = (services.find((s) => s.name === 'Online shop (demo)') ?? services[0]!).id;
  const month = new Date().toISOString().slice(0, 7);
  const estimate = (
    await post(admin, '/api/costs/estimates', {
      title: `Pipeline ${t}`,
      ownerKind: 'service',
      ownerId: service,
      currency: 'USD',
      appliesFrom: month,
      for: { kind: 'dataProduct', id: product },
      lines: [{ key: 'st', provider: 'Snowflake', sku: 'storage', quantity: '2', unit: 'TBy.mo' }],
    })
  ).id;
  return { product, estimate, key };
}

async function mcpCall(token: string, name: string, args: Record<string, unknown>): Promise<any> {
  const client = await pwRequest.newContext({ baseURL: baseURL(), storageState: { cookies: [], origins: [] } });
  try {
    const res = await client.post('/api/mcp', {
      headers: {
        authorization: `Bearer ${token}`,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': name,
        accept: 'application/json, text/event-stream',
      },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } },
      },
    });
    return (await json<{ result: any }>(res)).result;
  } finally {
    await client.dispose();
  }
}

async function choose(page: Page, testId: string, option: string) {
  await page.getByTestId(testId).click();
  await animationsDone(page);
  await page.getByRole('option', { name: option }).click();
}

test.describe('costs: estimates and measured use', () => {
  test.use({ storageState: authFile('admin') });
  let s: Seed;
  test.beforeEach(async ({ apiAs }) => {
    seeded ??= (async () => seed(await apiAs('admin')))();
    s = await seeded;
  });

  test('the Costs tab sets the estimates against what is attributed; the split by measured use', async ({ page }) => {
    await page.goto(`/data-products/${s.product}/costs`);
    const section = page.getByTestId('product-estimates');
    await expect(section).toBeVisible();
    await expect(section.getByRole('link', { name: /^Pipeline / })).toBeVisible();
    await expect(page.getByTestId('estimates-against-attributed')).toBeVisible();
    // months and amounts in the UI language, not as stored ("2026-11", "1.5 USD")
    await expect(page.getByTestId('estimates-against-attributed')).not.toContainText(/\b\d{4}-\d{2}\b/);
    await expect(section.getByTestId('product-estimate').first()).not.toContainText(/\b\d{4}-\d{2}\b| USD\b/);
    await expect(
      page
        .getByTestId('estimates-against-attributed')
        .getByText(/above the estimate|below the estimate|within the range/)
        .first(),
    ).toBeVisible();
    await expectAccessible(page, 'costs with estimates');
    // the split of the shared account line: by measured use
    await page.getByTestId('allocation-edit').first().click();
    await animationsDone(page);
    await page.getByTestId('allocation-rule').getByText('By measured use').click();
    await expect(page.getByTestId('allocation-measure')).toBeVisible();
    await choose(page, 'allocation-measure', 'Snowflake credits per warehouse');
    await expectAccessible(page, 'allocation by measured use');
    const subjects = page.getByRole('dialog').getByRole('combobox', { name: /^Measured / });
    await subjects.fill('TRANSFORM_WH');
    await subjects.press('Enter');
    await page.getByTestId('allocation-save').click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByTestId('cost-allocations').getByText(/By measured use/)).toBeVisible();
    await expect(page.getByTestId('allocation-measured').first()).toBeVisible();
  });

  test('the estimate says which data product it is for', async ({ page }) => {
    await page.goto(`/costs/estimates/${s.estimate}`);
    await expect(page.getByTestId('estimate-for-product')).toBeVisible();
    await expect(page.getByTestId('estimate-for-product')).toHaveValue(/Measured /);
    await expectAccessible(page, 'estimate for a data product');
    // the picker asks the server once typing pauses, not for every key
    const asked: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/data-products?limit=20')) asked.push(r.url());
    });
    const picker = page.getByTestId('estimate-for-product');
    await picker.clear();
    await picker.pressSequentially('Other', { delay: 30 });
    await expect(page.getByRole('option', { name: /^Other / })).toBeVisible();
    expect(asked.length).toBeLessThanOrEqual(2);
  });

  test('estimated against attributed on a phone @mobile', async ({ page }) => {
    await page.goto(`/data-products/${s.product}/costs`);
    await expect(page.getByTestId('product-estimates')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'estimates on a phone', { wcag22: true });
    // the split's three rules one below the other: "By measured use" is not cut off
    await page.getByTestId('allocation-edit').first().click();
    await animationsDone(page);
    const rule = page.getByTestId('allocation-rule');
    await expect(rule).toHaveAttribute('data-orientation', 'vertical');
    const box = (await rule.getByText('By measured use').boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  });
});

test.describe('exchange', () => {
  test.use({ storageState: authFile('dana') });

  test('an assistant proposes a product; a person reviews and applies it', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    const dana = await apiAs('dana');
    expect((await admin.put('/api/settings/modules/dataProducts', { data: { enabled: true } })).ok()).toBe(true);
    await admin.put('/api/mcp-server', { data: { enabled: true } });
    const token = (await json<{ token: string }>(await dana.post('/api/me/tokens', { data: { name: `e2e dp ${tag()}`, scope: 'mcp' } }))).token;
    const t = tag();
    const r = await mcpCall(token, 'propose_data_product_changes', {
      title: `Proposed ${t}`,
      rationale: 'Read from the warehouse schema',
      document: {
        version: 1,
        elements: [{ kind: 'other', qualified_name: `${t}.SOURCE`, environment: 'prod', type_label: 'Extract' }],
        data_products: [
          {
            key: `${t.toLowerCase()}-proposed`,
            name: `Proposed ${t}`,
            members: [{ element: { kind: 'other', qualified_name: `${t}.SOURCE`, environment: 'prod' }, role: 'input' }],
          },
        ],
      },
    });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    await page.goto(`/mcp-requests/${r.structuredContent.requestId}`);
    await expect(page.getByTestId('dp-proposal')).toBeVisible();
    await expect(page.getByTestId('dp-proposal-preview').getByText(`${t.toLowerCase()}-proposed`)).toBeVisible();
    await expectAccessible(page, 'data products proposal');
    await page.getByRole('button', { name: 'Accept 2 entries' }).click();
    await expect(page.getByText('Applied: 2 added, 0 changed').first()).toBeVisible();
  });

  test('the import dialog replaces an earlier import and says what it removes', async ({ page, apiAs }) => {
    const dana = await apiAs('dana');
    const t = tag();
    const k = t.toLowerCase();
    const doc = (products: string[]) =>
      ['version: 1', 'data_products:', ...products.flatMap((p) => [`  - key: ${k}-${p}`, `    name: Replaced ${p} ${t}`])].join('\n') + '\n';
    const first = await dana.post('/api/data-products/import', {
      data: { files: [{ name: 'first.yaml', content: doc(['one', 'two']) }], mode: 'update', origin: `e2e-${k}` },
    });
    expect(first.ok(), await first.text()).toBe(true);
    await page.goto('/data-products');
    await page.getByTestId('products-transfer').click();
    await page.getByTestId('products-import').click();
    await animationsDone(page);
    await page.getByTestId('import-mode').getByText('Replace an earlier import').click();
    await page.locator('input[type="file"]').setInputFiles({ name: 'next.yaml', mimeType: 'application/yaml', buffer: Buffer.from(doc(['one'])) });
    await expect(page.getByText('Replacing needs the origin of the earlier import.')).toBeVisible();
    // the earlier import's origin is suggested with its entries
    await page.getByTestId('import-origin').fill(`e2e-${k}`.slice(0, 8));
    await page.getByRole('option', { name: `e2e-${k} · 2 entries` }).click();
    await expect(page.getByTestId('import-origin')).toHaveValue(`e2e-${k}`);
    await page.getByTestId('import-preview-run').click();
    await expect(page.getByTestId('import-count-remove')).toHaveText('1 to remove');
    await expect(page.getByTestId('import-preview').getByText(`${k}-two`)).toBeVisible();
    await expectAccessible(page, 'import replace preview');
    // Import says what it removes before it runs; cancelled, nothing happens
    await page.getByTestId('import-run').click();
    await expect(page.getByTestId('import-remove-list')).toContainText(`${k}-two`);
    await page.getByRole('button', { name: 'Cancel' }).last().click();
    await expect(page.getByTestId('import-remove-list')).toHaveCount(0);
    await page.getByTestId('import-run').click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page.getByText(/1 removed/).first()).toBeVisible();
  });

  test('the import preview on a phone @mobile', async ({ page }) => {
    const k = tag().toLowerCase();
    await page.goto('/data-products');
    await page.getByTestId('products-transfer').click();
    await page.getByTestId('products-import').click();
    await animationsDone(page);
    const doc = ['version: 1', 'data_products:', `  - key: ${k}-phone`, `    name: Phone ${k}`].join('\n') + '\n';
    await page.locator('input[type="file"]').setInputFiles({ name: 'phone.yaml', mimeType: 'application/yaml', buffer: Buffer.from(doc) });
    await page.getByTestId('import-preview-run').click();
    // a card per change, no table
    await expect(page.getByTestId('import-preview').getByText(`${k}-phone`)).toBeVisible();
    await expect(page.getByTestId('import-preview').locator('table')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'import preview on a phone', { wcag22: true });
  });

  test('the data objects export as an Ossie model', async ({ page }) => {
    await page.goto('/data-objects');
    await page.getByTestId('objects-ossie').click();
    await expect(page.getByTestId('objects-ossie-yaml')).toHaveAttribute('href', /\/api\/data-objects\/semantic-model\?format=yaml/);
    await expectAccessible(page, 'data objects with the Ossie export');
  });
});
