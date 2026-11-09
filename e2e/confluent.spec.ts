import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

/**
 * Confluent Cloud (#123, docs/CONFLUENT.md) against the simulated Cloud API (server/src/mock/mockConfluent.ts): a
 * platform added with the setup wizard and read, the demo organisation's tabs – clusters linked to "Kafka (demo)",
 * Schema Registry subjects, managed connectors with a failed task (its token removed), API keys with hints and a
 * credentials register draft –, the monitor check "Confluent Cloud" on the failing connector and the platform's costs –
 * on a desktop and a phone.
 */

const CLOUD = { key: 'CLOUDKEY', secret: 'demo-confluent-cloud-secret' };
const SECRETS = [CLOUD.secret, 'demo-registry-secret', 'demo-http-source-token'];

async function demoPlatform(api: APIRequestContext) {
  return (await json<{ id: string; name: string }[]>(await api.get('/api/platforms'))).find((x) => x.name === 'Confluent Cloud (demo)')!;
}

async function noSecrets(page: Page) {
  for (const s of SECRETS) await expect(page.locator('body')).not.toContainText(s);
}

async function tabs(page: Page, api: APIRequestContext, mobile: boolean) {
  const p = await demoPlatform(api);
  await page.goto(`/platforms/${p.id}`);
  // a Confluent Cloud platform opens on its clusters
  await expect(page.getByRole('tab', { name: 'Clusters' })).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('confluent-read').click();
  await expect(page.getByTestId('confluent-summary')).toContainText('3 environments, 2 clusters, 3 managed connectors');
  const orders = page.locator('[data-testid="confluent-cluster"][data-id="lkc-demo1"]');
  await expect(orders).toContainText('orders-cluster');
  await expect(orders).toContainText('production');
  await expect(orders).toContainText('Standard');
  await expect(orders).toContainText('PROVISIONED');
  await expect(orders.getByRole('link', { name: 'Kafka (demo)' })).toBeVisible();
  await expect(page.locator('[data-testid="confluent-cluster"][data-id="lkc-demo2"]')).toContainText('None – set confluentClusterId on a Kafka platform');
  await expectAccessible(page, 'confluent: clusters');
  if (mobile) await expectNoHorizontalScroll(page);

  // the Schema Registry and its subjects
  await page.getByRole('tab', { name: 'Schemas' }).click();
  await expect(page.getByTestId('confluent-registries')).toContainText('lsrc-demo1');
  await expect(page.locator('[data-testid="confluent-subject"][data-name="orders-value"]')).toContainText('2 versions (latest 2)');
  await expect(page.locator('[data-testid="confluent-subject"][data-name="payments-value"]')).toContainText('FULL (own)');
  await expectAccessible(page, 'confluent: schemas');
  if (mobile) await expectNoHorizontalScroll(page);

  // the managed connectors: the failed task with its error, the token in it removed
  await page.getByRole('tab', { name: 'Connectors' }).click();
  await expect(page.getByTestId('confluent-connector-summary')).toContainText('3 connectors, 2 running');
  await expect(page.getByTestId('confluent-connector-summary')).toContainText('1 task failed');
  const sink = page.locator('[data-testid="confluent-connector"][data-name="orders-s3-sink"]');
  await expect(sink).toContainText('S3_SINK');
  await expect(sink.getByRole('link', { name: 'Webshop (demo)' })).toBeVisible();
  const source = page.locator('[data-testid="confluent-connector"][data-name="shop-events-http-source"]');
  await expect(source.getByTestId('confluent-tasks')).toContainText('Task 0 FAILED');
  await source.getByTestId('confluent-trace-toggle').click();
  await expect(source.getByTestId('confluent-trace')).toContainText('answered 401 Unauthorized');
  await expect(page.locator('[data-testid="confluent-connector"][data-name="clickstream-datagen"]')).toContainText('PAUSED');
  await expectAccessible(page, 'confluent: connectors');
  if (mobile) await expectNoHorizontalScroll(page);

  // API keys: metadata and hints, a draft for the credentials register
  await page.getByRole('tab', { name: 'API keys' }).click();
  await expect(page.getByTestId('confluent-keys-summary')).toContainText('5 API keys, 4 service accounts');
  await expect(page.locator('[data-testid="confluent-key"][data-id="DEMOKEY"]').getByTestId('confluent-key-hint')).toHaveText('Older than a year – rotate');
  await expect(page.locator('[data-testid="confluent-key"][data-id="SRKEY"]').getByTestId('confluent-key-hint')).toHaveText('Expires soon');
  await expect(page.locator('[data-testid="confluent-key"][data-id="BOBSANDBOX"]')).toContainText('Bob Builder');
  await expectAccessible(page, 'confluent: api keys');
  if (mobile) await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'Add the API key CONNECTKEY to the credentials register' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('textbox', { name: 'Name' }).first()).toHaveValue('Confluent Cloud (demo): API key CONNECTKEY');
  await expectAccessible(page, 'confluent: register draft');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await noSecrets(page);
}

async function monitorCheck(page: Page) {
  await page.goto('/monitors/new');
  await settle(page);
  const palette = page.getByLabel('Check palette');
  const form = page.getByTestId('check-form');
  await palette.getByRole('button', { name: 'Confluent Cloud', exact: true }).click();
  await chooseOption(page, /^Platform/, /^Confluent Cloud \(demo\)/);
  await form.getByRole('textbox', { name: /^Connector/ }).fill('shop-events-http-source');
  await form.getByRole('button', { name: 'Check now' }).click();
  const preview = form.getByTestId('check-preview');
  await expect(preview).toContainText('Confluent Cloud: shop-events-http-source RUNNING (0/1 tasks)');
  await expect(preview).toContainText('task 0 FAILED');
  await expectAccessible(page, 'confluent monitor check');
  await noSecrets(page);
}

async function costs(page: Page, api: APIRequestContext, mobile: boolean) {
  const p = await demoPlatform(api);
  await page.goto(`/costs/platform/${p.id}`);
  await expect(page.getByRole('heading', { name: p.name, level: 1 })).toBeVisible();
  await expect(page.getByTestId('cost-by-service')).toContainText('CONNECT');
  await expect(page.getByTestId('cost-by-service')).toContainText('STREAM_GOVERNANCE');
  await expectAccessible(page, 'confluent: costs');
  if (mobile) await expectNoHorizontalScroll(page);
  await page.getByTestId('tab-source').click();
  const card = page.getByTestId('cost-connector');
  await expect(card).toContainText('Confluent Cloud Costs API');
  await card.getByTestId('cost-read-now').click();
  await expect(card.getByTestId('cost-read-error')).toHaveCount(0);
  await expectAccessible(page, 'confluent: cost source');
  if (mobile) await expectNoHorizontalScroll(page);
}

test('the setup wizard adds a Confluent Cloud platform that reads the organisation', async ({ page, apiAs }) => {
  const name = uniq('Confluent org');
  await page.goto('/platforms');
  await page.getByRole('button', { name: 'Add platform' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a platform' });
  await dialog.getByRole('textbox', { name: 'Search connectors' }).fill('confluent');
  await dialog.getByTestId('wizard-connector').filter({ hasText: 'Confluent Cloud API (read-only)' }).click();
  await dialog.getByRole('textbox', { name: 'Name' }).first().fill(name);
  await dialog.getByRole('textbox', { name: 'Base URL' }).fill(`${baseURL()}/mock/confluent`);
  await dialog.getByLabel('Cloud API key', { exact: true }).fill(CLOUD.key);
  await dialog.getByLabel('Cloud API secret', { exact: true }).fill(CLOUD.secret);
  await dialog.getByTestId('wizard-create').click();
  await expect(dialog.getByTestId('wizard-test-result')).toContainText('Connection works');
  await dialog.getByTestId('wizard-continue').click();
  await expect(dialog.getByTestId('platform-get-started').getByText('Monitor checks')).toBeVisible();
  await page.keyboard.press('Escape');

  const api = await apiAs('admin');
  const p = (await json<{ id: string; name: string }[]>(await api.get('/api/platforms'))).find((x) => x.name === name)!;
  await page.goto(`/platforms/${p.id}`);
  await expect(page.getByTestId('confluent-clusters-empty')).toContainText('Not read yet');
  await page.getByTestId('confluent-read').click();
  await expect(page.getByTestId('confluent-clusters')).toContainText('orders-cluster');
  await expect(page.getByTestId('confluent-clusters')).toContainText('sandbox');
  // without a Schema Registry key: no subjects, a hint how to add them
  await page.getByRole('tab', { name: 'Schemas' }).click();
  await expect(page.getByTestId('confluent-subjects-empty')).toContainText('No subjects read');
  await page.getByRole('tab', { name: 'Connectors' }).click();
  await expect(page.locator('[data-testid="confluent-connector"][data-name="shop-events-http-source"]')).toContainText('Task 0 FAILED');
  await noSecrets(page);
  await api.delete(`/api/platforms/${p.id}`);
});

test('the demo organisation: tabs, the monitor check and its costs', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  await tabs(page, api, false);
  await monitorCheck(page);
  await costs(page, api, false);
});

test('Confluent Cloud on a phone @mobile', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  await tabs(page, api, true);
  await costs(page, api, true);
});
