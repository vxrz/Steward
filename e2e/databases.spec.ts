import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json, uniq, waitForRun } from './support/helpers';

test.use({ storageState: authFile('admin') });

/**
 * Database platforms (#203, docs/DATABASES.md) on the demo database (a fake PostgreSQL with canned catalog rows): a
 * platform set up with the wizard (its connection, the connection test), the Database tab, the step "Query a
 * database" in the editor with the statement check and the result preview of the last run, and the monitor check –
 * on a desktop and a phone.
 */

const DEMO = { host: 'postgres.demo.invalid', database: 'shop', username: 'steward_reader', password: 'demo-reader-password' };

async function wizard(page: Page, api: APIRequestContext, mobile: boolean) {
  const name = uniq('Orders DB');
  await page.goto('/platforms');
  await page.getByRole('button', { name: 'Add platform' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a platform' });
  await expect(dialog.getByRole('region', { name: 'Databases' })).toBeVisible();
  await expect(dialog.getByRole('region', { name: 'Databases' }).getByTestId('wizard-connector')).toHaveCount(4);
  await dialog.getByRole('region', { name: 'Databases' }).getByTestId('wizard-connector').filter({ hasText: 'PostgreSQL (read-only)' }).click();
  await dialog.getByRole('textbox', { name: 'Name' }).first().fill(name);
  const conn = dialog.getByTestId('wizard-database');
  await expect(conn).toContainText('PostgreSQL connection');
  // host and database are needed before it can be created
  await expect(dialog.getByTestId('wizard-create')).toBeDisabled();
  await conn.getByTestId('wizard-db-host').fill(DEMO.host);
  await conn.getByTestId('wizard-db-name').fill(DEMO.database);
  await dialog.getByLabel('User name', { exact: true }).fill(DEMO.username);
  await dialog.getByLabel('Password', { exact: true }).fill(DEMO.password);
  await expectAccessible(page, 'database wizard: settings');
  if (mobile) await expectNoHorizontalScroll(page);
  await dialog.getByTestId('wizard-create').click();
  const result = dialog.getByTestId('wizard-test-result');
  await expect(result).toContainText('Connection works');
  await expect(result).toContainText('Connected to PostgreSQL 16.4 (demo)');
  await expect(result).toContainText('Read-only: The session is read-only');
  await expect(result).not.toContainText('HTTP');
  await expectAccessible(page, 'database wizard: test');
  await dialog.getByTestId('wizard-continue').click();
  await expect(dialog.getByTestId('platform-get-started')).toContainText('Database – Account hygiene');
  await page.keyboard.press('Escape');
  const p = (await json<{ id: string; name: string; config: { database: Record<string, unknown> } }[]>(await api.get('/api/platforms'))).find(
    (x) => x.name === name,
  )!;
  expect(p.config.database).toMatchObject({ dialect: 'postgresql', host: DEMO.host, database: 'shop', tls: { mode: 'verify' } });
  await api.delete(`/api/platforms/${p.id}`);
}

async function databaseTab(page: Page, api: APIRequestContext, mobile: boolean) {
  const db = (await json<{ id: string; name: string; kind: string }[]>(await api.get('/api/platforms'))).find((x) => x.kind === 'database')!;
  await page.goto(`/platforms/${db.id}`);
  const tab = page.getByTestId('database-tab');
  // a database platform opens on its connection; it has no API specification or explorer
  await expect(tab.getByTestId('database-host')).toHaveValue(DEMO.host);
  await expect(page.getByRole('tab', { name: 'API specifications' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Explorer' })).toHaveCount(0);
  await expect(tab.getByText('BEGIN TRANSACTION READ ONLY', { exact: false })).toBeVisible();
  await expectAccessible(page, 'database tab');
  if (mobile) await expectNoHorizontalScroll(page);
  // a weaker TLS mode says what it costs
  await chooseOption(page, 'TLS mode', 'Encrypt without verification');
  await expect(tab.getByText('a server that pretends to be the database can read the password', { exact: false })).toBeVisible();
  await chooseOption(page, 'TLS mode', 'Verify certificate (recommended)');
  await tab.getByRole('textbox', { name: 'Most rows' }).fill('2000');
  await tab.getByTestId('database-save').click();
  await expect(page.getByText('Connection saved')).toBeVisible();
  expect(
    (await json<{ config: { database: { limits: { maxRows?: number } } } }>(await api.get(`/api/platforms/${db.id}`))).config.database.limits.maxRows,
  ).toBe(2000);
  await api.put(`/api/platforms/${db.id}/database`, {
    data: { dialect: 'postgresql', host: DEMO.host, port: 5432, database: 'shop', tls: { mode: 'verify' }, limits: {} },
  });
  return db.id;
}

async function stepEditor(page: Page, api: APIRequestContext, dbId: string, mobile: boolean) {
  // a dry run first: its result is the preview under "Last run"
  const { id } = await json<{ id: string }>(await api.post('/api/runs', { data: { processId: 'database-table-sizes', dryRun: true, bindings: { db: dbId } } }));
  await waitForRun(api, id, ['succeeded']);
  await page.goto('/processes/database-table-sizes');
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toContainText('Database – Table sizes');
  await page.locator('.react-flow__node[data-id="tables"]').click();
  await expect(page.getByText('Query a database').first()).toBeVisible();
  await expect(page.getByTestId('query-mode').getByRole('radio', { name: 'Catalog query' })).toBeChecked();
  await expect(page.getByRole('textbox', { name: /^Catalog query/ }).or(page.getByRole('combobox', { name: /^Catalog query/ }))).toHaveValue('tables');
  await expectAccessible(page, 'query step: catalog');
  if (mobile) {
    await expectNoHorizontalScroll(page);
    return;
  }
  await page.getByRole('tab', { name: 'Last run' }).click();
  const preview = page.getByTestId('query-result-preview');
  await expect(preview).toContainText('5 of 5 rows');
  await expect(preview.getByRole('columnheader', { name: 'bytes' })).toBeVisible();
  await expect(preview.getByRole('cell', { name: 'order_lines' })).toBeVisible();
  await expectAccessible(page, 'query step: result preview');
  await page.getByRole('tab', { name: 'Properties' }).click();
  // own SQL: the statement check of the server, at once
  await page.getByTestId('query-mode').getByText('Own SQL').click();
  const sql = page.getByTestId('query-sql');
  await sql.fill('DELETE FROM orders');
  await expect(page.getByText('Only a query is allowed: one SELECT, or WITH … SELECT').filter({ visible: true }).first()).toBeVisible();
  await sql.fill('SELECT name FROM customers WHERE id = $1');
  await expect(
    page
      .getByText(/Refused for .*placeholder/)
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  await page.getByTestId('query-add-param').click();
  await page.getByRole('textbox', { name: 'Parameter 1' }).fill('{{ 42 }}');
  await expect(page.getByTestId('expr-preview').first()).toContainText('= 42');
  await expect(page.getByText(/Refused for MariaDB \/ MySQL, Microsoft SQL Server/)).toBeVisible();
  await expectAccessible(page, 'query step: own SQL');
}

async function monitorCheck(page: Page, mobile: boolean) {
  await page.goto('/monitors/new');
  await settle(page);
  if (mobile) return;
  const palette = page.getByLabel('Check palette');
  const form = page.getByTestId('check-form');
  await palette.getByRole('button', { name: 'Database', exact: true }).click();
  await chooseOption(page, /^Platform/, /^Shop database \(demo\)/);
  await chooseOption(page, 'What is checked', 'Replication lag');
  await form.getByRole('textbox', { name: /^CRIT \(seconds of lag\)/ }).fill('300');
  await form.getByRole('textbox', { name: /^WARN/ }).fill('1');
  await form.getByRole('button', { name: 'Check now' }).click();
  await expect(form.getByTestId('check-preview')).toContainText('replication lag');
  await expectAccessible(page, 'database monitor check');
}

test('sets up a database platform with the wizard and tests the connection', async ({ page, apiAs }) => {
  await wizard(page, await apiAs('admin'), false);
});

test('the Database tab, the query step with its preview, and the monitor check', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const dbId = await databaseTab(page, api, false);
  await stepEditor(page, api, dbId, false);
  await monitorCheck(page, false);
});

test('database platforms on a phone @mobile', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  await wizard(page, api, true);
  const dbId = await databaseTab(page, api, true);
  await stepEditor(page, api, dbId, true);
});
