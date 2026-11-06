import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json } from './support/helpers';

test.use({ storageState: authFile('admin') });

/**
 * Kafka Connect (#223, docs/KAFKA.md#kafka-connect-and-debezium) on the demo cluster: the platform's Connectors tab
 * (the Debezium source shop-cdc and the sink orders-archive with a failed task, the plugins, a configuration with its
 * secrets removed), the connectors on the Webshop's topic component and the monitor check "Kafka Connect connectors" –
 * on a desktop and a phone.
 */

const SECRETS = ['demo-cdc-password', 'demo-archive-password', 'demo-registry-password'];

async function connectorsTab(page: Page, api: APIRequestContext, mobile: boolean) {
  const p = (await json<{ id: string; kind: string }[]>(await api.get('/api/platforms'))).find((x) => x.kind === 'kafka-connect')!;
  await page.goto(`/platforms/${p.id}`);
  // a Kafka Connect platform opens on its connectors
  const tab = page.getByTestId('connect-tab');
  await expect(page.getByRole('tab', { name: 'Connectors' })).toHaveAttribute('aria-selected', 'true');
  await expect(tab.getByTestId('connect-kafka')).toContainText('Kafka (demo)');
  await expect(tab.getByTestId('connect-summary')).toContainText('2 connectors, 2 running');
  await expect(tab.getByTestId('connect-summary')).toContainText('1 task failed');
  const cdc = tab.locator('[data-testid="connect-connector"][data-name="shop-cdc"]');
  await expect(cdc).toContainText('io.debezium.connector.postgresql.PostgresConnector 2.7.3.Final');
  await expect(cdc.getByTestId('connect-database')).toContainText('Captures postgresql on postgres.demo.invalid:5432 · shop');
  await expect(cdc.getByRole('link', { name: 'Shop database (demo)' })).toBeVisible();
  await expect(cdc.getByTestId('connect-topics')).toContainText('shop.public.orders');
  const archive = tab.locator('[data-testid="connect-connector"][data-name="orders-archive"]');
  await expect(archive.getByTestId('connect-tasks')).toContainText('Task 1 FAILED');
  await expect(archive.getByRole('link', { name: 'Webshop (demo)' })).toBeVisible();
  await expectAccessible(page, 'kafka connect: connectors');
  if (mobile) await expectNoHorizontalScroll(page);
  // the error of the failed task: shortened, the password in the connection URL removed
  await archive.getByTestId('connect-trace-toggle').click();
  const trace = archive.getByTestId('connect-trace');
  await expect(trace).toContainText('JDBCConnectionException');
  await expect(trace).toContainText('jdbc:postgresql://***@warehouse.demo.invalid');
  await expect(trace).not.toContainText('demo-archive-password');
  await expectAccessible(page, 'kafka connect: task error');
  if (mobile) await expectNoHorizontalScroll(page);
  // the plugins
  await tab.getByTestId('connect-plugins-toggle').click();
  await expect(tab.getByTestId('connect-plugins')).toContainText('io.debezium.connector.jdbc.JdbcSinkConnector');
  if (mobile) await expectNoHorizontalScroll(page);
  // a configuration: read now, secret-looking values removed
  await cdc.getByRole('button', { name: 'Configuration of shop-cdc' }).click();
  const dialog = page.getByRole('dialog', { name: 'Configuration of shop-cdc' });
  await expect(dialog.getByRole('row', { name: /database\.hostname postgres\.demo\.invalid/ })).toBeVisible();
  await expect(dialog.getByRole('row', { name: /database\.password removed/ })).toBeVisible();
  for (const s of SECRETS) await expect(dialog).not.toContainText(s);
  await expectAccessible(page, 'kafka connect: configuration');
  if (mobile) await expectNoHorizontalScroll(page);
  await dialog.getByRole('button', { name: 'Close' }).last().click();
  // read now
  await tab.getByTestId('connect-read').click();
  await expect(tab.getByTestId('connect-summary')).toContainText('2 connectors');
  for (const s of SECRETS) await expect(page.locator('body')).not.toContainText(s);
}

async function topicComponent(page: Page, api: APIRequestContext, mobile: boolean) {
  const app = (await json<{ id: string; name: string }[]>(await api.get('/api/applications'))).find((a) => a.name === 'Webshop (demo)')!;
  await page.goto(`/applications/${app.id}`);
  const line = page.getByTestId('topic-connectors');
  await expect(line).toContainText('Connectors: orders-archive (sink, RUNNING)');
  await expect(line.getByRole('link', { name: 'orders-archive' })).toHaveAttribute('href', /\/platforms\/.+\?tab=connectors$/);
  if (mobile) await expectNoHorizontalScroll(page);
}

async function monitorCheck(page: Page) {
  await page.goto('/monitors/new');
  await settle(page);
  const palette = page.getByLabel('Check palette');
  const form = page.getByTestId('check-form');
  await palette.getByRole('button', { name: 'Kafka Connect connectors', exact: true }).click();
  await chooseOption(page, /^Platform/, /^Kafka Connect \(demo\)/);
  await form.getByRole('textbox', { name: /^Connector/ }).fill('shop-cdc');
  await form.getByRole('textbox', { name: /^Debezium topics quiet after/ }).fill('30');
  await form.getByRole('button', { name: 'Check now' }).click();
  await expect(form.getByTestId('check-preview')).toContainText('Kafka Connect: shop-cdc RUNNING (1/1 tasks)');
  await expectAccessible(page, 'kafka connect monitor check');
}

test('the Connectors tab, the topic component and the monitor check', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  await connectorsTab(page, api, false);
  await topicComponent(page, api, false);
  await monitorCheck(page);
});

test('Kafka Connect on a phone @mobile', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  await connectorsTab(page, api, true);
  await topicComponent(page, api, true);
});
