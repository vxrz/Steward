import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll, json } from './support/helpers';

/**
 * Consumers, access and governance of data products (0.24.0, ADR 0036 phase 2): who really reads a port (read now),
 * a request for access by an operator decided by the product owner, a port access review, promotion from dev to prod
 * with its preview and evidence, the endorsement by the domain's owner, the access requests page and the GDPR Art. 30
 * view with its exports – axe on each, cards and no sideways scroll on phones. Seeded through the API.
 */

interface Seed {
  token: string;
  product: string;
  object: string;
}

let seeded: Promise<Seed> | null = null;

async function post<T = { id: string }>(api: APIRequestContext, url: string, data: unknown): Promise<T> {
  return json<T>(await api.post(url, { data }));
}

async function seed(admin: APIRequestContext): Promise<Seed> {
  expect((await admin.put('/api/settings/modules/dataProducts', { data: { enabled: true } })).ok()).toBe(true);
  const token = `GOV${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const key = token.toLowerCase();
  const platforms = await json<{ id: string; kind: string }[]>(await admin.get('/api/platforms'));
  const snowflake = platforms.find((p) => p.kind === 'snowflake')!.id;
  // the name rules of the promotion: suffix _DEV is dev, the token's prefix is prod
  await post(admin, '/api/data-products/discovery-sources', {
    name: `Governance ${token}`,
    platformId: snowflake,
    scope: [token, `${token}_DEV`],
    environmentRules: [
      { match: 'suffix', value: '_DEV', environment: 'dev' },
      { match: 'prefix', value: token, environment: 'prod' },
    ],
    enabled: false,
  });
  const el = async (name: string, environment: string) =>
    (await post(admin, '/api/data-elements', { platformId: snowflake, kind: 'snowflake.table', qualifiedName: name, environment })).id;
  const prod = await el(`${token}.SALES.ORDERS`, 'prod');
  const dev = await el(`${token}_DEV.SALES.ORDERS`, 'dev');
  await el(`${token}.RAW.ORDERS`, 'prod');
  const devRaw = await el(`${token}_DEV.RAW.ORDERS`, 'dev');
  const domain = (await post(admin, '/api/data-domains', { key: `${key}-sales`, name: `Sales ${token}`, owners: ['user:adam'] })).id;
  const product = (await post(admin, '/api/data-products', { key: `${key}-orders`, name: `Governed orders ${token}`, owners: ['user:dana'], domainId: domain }))
    .id;
  const port = (await post(admin, `/api/data-products/${product}/ports`, { direction: 'output', name: 'orders', type: 'table', version: 'v1' })).id;
  expect((await admin.put(`/api/data-products/${product}/ports/${port}/bindings/prod`, { data: { elementIds: [prod] } })).ok()).toBe(true);
  expect((await admin.put(`/api/data-products/${product}/ports/${port}/bindings/dev`, { data: { elementIds: [dev] } })).ok()).toBe(true);
  await post(admin, `/api/data-products/${product}/members`, { elementIds: [devRaw], role: 'internal' });
  const object = (
    await post(admin, '/api/data-objects', {
      key: `${key}-customer`,
      name: `Customer ${token}`,
      personalData: 'personal',
      categories: ['contact'],
      subjects: ['customers'],
      legalBasis: 'contract',
      retention: 'P10Y',
    })
  ).id;
  expect((await admin.post(`/api/data-objects/${object}/elements`, { data: { elementId: prod } })).ok()).toBe(true);
  return { token, product, object };
}

test.describe('governance of data products', () => {
  test.use({ storageState: authFile('dana') });
  let s: Seed;
  test.beforeEach(async ({ apiAs }) => {
    seeded ??= (async () => seed(await apiAs('admin')))();
    s = await seeded;
  });

  test('who reads, a request for access, a port review, promotion and endorsement', async ({ page, loginAs }) => {
    test.setTimeout(240_000);
    // who really reads: read now (the demo account's ACCESS_HISTORY)
    await page.goto(`/data-products/${s.product}/ports`);
    const port = page.getByTestId('port-orders');
    await port.getByTestId('port-actual-toggle').click();
    await port.getByTestId('actual-read-now').click();
    await expect(port.getByTestId('actual-read-ok')).toBeVisible();
    await settle(page);
    // with WCAG 2.2: the toggle of a port's readers is a target of at least 24 px
    await expectAccessible(page, 'actual consumers', { wcag22: true });

    // an operator asks for access
    const olivia = await loginAs('olivia');
    await olivia.goto(`/data-products/${s.product}/ports`);
    await olivia.getByTestId('port-orders').getByTestId('port-request-access').click();
    await olivia.getByTestId('request-purpose').fill('Monthly close');
    await olivia.getByTestId('request-until').fill('2027-12-31');
    await expectAccessible(olivia, 'request access form');
    await olivia.getByTestId('request-save').click();
    // the dialog closes with a word on where to follow the request
    await expect(olivia.getByText('Request sent – you can follow it under Data → Access requests')).toBeVisible();
    await olivia.goto('/data-products/access-requests');
    await olivia.getByTestId('requests-scope').getByText('Mine').click();
    await expect(olivia.getByTestId('requests-table')).toContainText(`Governed orders ${s.token}`);
    await expect(olivia.getByTestId('requests-table').getByTestId('request-status-pending')).toBeVisible();
    await expectAccessible(olivia, 'access requests page');

    // the owner decides on the Access tab
    await page.goto(`/data-products/${s.product}/access`);
    const requests = page.getByTestId('product-access-requests');
    // the decision buttons name whose request they decide
    await expect(requests.getByTestId('request-approve')).toHaveAccessibleName(/^Approve the request of /);
    await requests.getByTestId('request-approve').click();
    await page.getByTestId('decide-comment').fill('For the close');
    await page.getByTestId('decide-save').click();
    await expect(requests.getByTestId('request-status-approved')).toBeVisible();
    await expect(page.getByText('Request approved')).toBeVisible();
    await settle(page);
    await expectAccessible(page, 'access tab');

    // a port access review of prod: the new registration, kept; submitted for a second person
    await page.getByTestId('review-start').click();
    await page.getByTestId('review-start-save').click();
    const review = page.getByTestId('review-modal');
    await expect(review.getByTestId('review-entry')).toHaveCount(1);
    // the registration of a person is named as everywhere else, not by its subject key
    await expect(review.getByTestId('review-entry')).not.toContainText('user:');
    await review.getByTestId('review-decision').click();
    await page.getByRole('option', { name: 'Keep' }).click();
    await expect(review.getByTestId('review-decision')).toHaveValue('Keep');
    await review.getByTestId('review-submit').click();
    await expect(review).toContainText('Submitted');
    await expectAccessible(page, 'port access review');
    await page.keyboard.press('Escape');

    // promotion from dev to prod by the name rules, with its evidence
    await page.goto(`/data-products/${s.product}`);
    await page.getByTestId('detail-actions').click();
    await page.getByTestId('product-promote').click();
    const preview = page.getByTestId('promotion-preview');
    await expect(preview.getByTestId('promotion-counts')).toContainText('1 found');
    await expect(preview).toContainText(`${s.token}.RAW.ORDERS`);
    await expectAccessible(page, 'promotion preview');
    await page.getByTestId('promotion-evidence-kind').click();
    await page.getByRole('option', { name: 'Change record' }).click();
    await page.getByTestId('promotion-evidence-ref').fill('CR-4711');
    await page.getByTestId('promotion-save').click();
    await expect(page.getByTestId('promotion-done')).toBeVisible();
    await expect(page.getByTestId('promotion-history')).toContainText('CR-4711');
    // promoted: the dialog closes without asking to discard what was entered
    await page.getByTestId('promotion-close').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // opened from the menu: the focus is back on the menu's button
    await expect(page.getByTestId('detail-actions')).toBeFocused();

    // the product owner does not endorse; the domain's owner does
    await page.goto(`/data-products/${s.product}`);
    await expect(page.getByTestId('product-endorsement')).toContainText('Nobody endorses a product they own');
    await expect(page.getByTestId('endorse')).toHaveCount(0);
    const adam = await loginAs('adam');
    await adam.goto(`/data-products/${s.product}`);
    await adam.getByTestId('endorse').click();
    await adam.getByTestId('endorse-note').fill('Reliable');
    await adam.getByTestId('endorse-save').click();
    await expect(adam.getByTestId('product-endorsement').getByTestId('product-endorsed-badge')).toContainText('Endorsed');
    await expect(adam.getByTestId('endorsement-line')).toContainText('Endorsed by adam');
    await expectAccessible(adam, 'endorsed product');
  });

  test('the records of processing with their exports', async ({ page }) => {
    await page.goto(`/data-products/records-of-processing?q=${s.token}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Records of processing' })).toBeVisible();
    const table = page.getByTestId('ropa-table');
    await expect(table.getByRole('link', { name: `Customer ${s.token}` })).toBeVisible();
    await expect(table).toContainText(`Governed orders ${s.token}`);
    await expect(table).toContainText('Contract – Art. 6(1)(b)');
    const csv = page.getByTestId('ropa-csv');
    await expect(csv).toHaveAttribute('href', /records-of-processing\.csv\?q=/);
    const res = await page.request.get((await csv.getAttribute('href'))!);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain(`Customer ${s.token}`);
    await expect(page.getByTestId('ropa-pdf')).toHaveAttribute('href', /records-of-processing\.pdf\?q=/);
    await expectAccessible(page, 'records of processing');
    // in the sidebar's Data group
    const data = page.locator('[data-group="data"]');
    await expect(data.getByRole('link', { name: 'Records of processing' })).toBeVisible();
    await expect(data.getByRole('link', { name: 'Access requests' })).toBeVisible();
  });

  test('governance on a phone @mobile', async ({ page, apiAs }) => {
    await page.goto(`/data-products/records-of-processing?q=${s.token}`);
    await expect(page.getByTestId('ropa-card').first()).toBeVisible();
    // the card says what the table says: the data subjects too
    await expect(page.getByTestId('ropa-card').first()).toContainText('Data subjects: customers');
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'records of processing on a phone');
    await page.goto('/data-products/access-requests');
    await expect(page.getByRole('heading', { level: 1, name: 'Access requests' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.goto(`/data-products/${s.product}/access`);
    await expect(page.getByTestId('product-port-reviews')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'access tab on a phone');
    await page.goto(`/data-products/${s.product}/ports`);
    await page.getByTestId('port-orders').getByTestId('port-actual-toggle').click();
    await expect(page.getByTestId('port-actual')).toBeVisible();
    // who reads: cards, no table
    await expect(page.getByTestId('port-actual').locator('table')).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // a port access review on a product of its own (the desktop test counts the entries of its own): the whole
    // screen, a card per entry
    const admin = await apiAs('admin');
    const own = (await post(admin, '/api/data-products', { key: `${s.token.toLowerCase()}-phone`, name: `Phone review ${s.token}`, owners: ['user:dana'] })).id;
    const ownPort = (await post(admin, `/api/data-products/${own}/ports`, { direction: 'output', name: 'orders', type: 'table' })).id;
    const el = await json<{ items: { id: string }[] }>(await admin.get(`/api/data-elements?prefix=${s.token}.SALES.ORDERS&environment=prod`));
    expect((await admin.put(`/api/data-products/${own}/ports/${ownPort}/bindings/prod`, { data: { elementIds: [el.items[0]!.id] } })).ok()).toBe(true);
    await post(admin, `/api/data-products/${own}/ports/${ownPort}/consumers`, { kind: 'text', text: 'Invented phone reader' });
    await post(admin, `/api/data-products/${own}/ports/${ownPort}/reviews`, { environment: 'prod', fourEyes: false });
    await page.goto(`/data-products/${own}/access`);
    await page.getByTestId('review-row').first().getByTestId('review-open').click();
    const review = page.getByTestId('review-modal');
    await expect(review).toBeVisible();
    await expect(review.locator('table')).toHaveCount(0);
    await expect(review.getByTestId('review-entry').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'port access review on a phone', { wcag22: true });
    await page.keyboard.press('Escape');

    // the promotion's preview: cards
    await page.goto(`/data-products/${s.product}`);
    await page.getByTestId('detail-actions').click();
    await page.getByTestId('product-promote').click();
    await expect(page.getByTestId('promotion-preview')).toBeVisible();
    await expect(page.getByTestId('promotion-preview').locator('table')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });
});
