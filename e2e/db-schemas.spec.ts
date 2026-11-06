import { request, type APIRequestContext, type Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

/**
 * Database schemas (#222, docs/DATABASES.md#database-schemas): the Schema tab of the demo database platform (read,
 * tables with search and the table detail, a tbls import with its preview, the changes marked breaking, the history,
 * the lint findings, the exports, the settings), the schema page of a system, and the monitor check – on a desktop and
 * a phone, with axe.
 */

const TBLS = (cols: { name: string; type: string; nullable: boolean }[]) =>
  JSON.stringify({
    name: 'shop',
    tables: [
      {
        name: 'public.customers',
        type: 'BASE TABLE',
        comment: 'People and companies that order',
        columns: cols,
        constraints: [{ name: 'customers_pkey', type: 'PRIMARY KEY', def: 'PRIMARY KEY (id)', table: 'public.customers', columns: ['id'] }],
      },
    ],
    driver: { name: 'postgres', database_version: 'PostgreSQL 16.4' },
  });
const LINT = 'public.customers: table comment required.\npublic.customers.name: column comment required.\n\n2 detected\n';

/** A database platform of its own on the demo database, so the desktop and phone tests do not share snapshots. */
async function newDb(api: APIRequestContext) {
  return json<{ id: string; name: string }>(
    await api.post('/api/platforms', {
      data: {
        name: uniq('Shop schema'),
        kind: 'database',
        config: { auth: { type: 'none' }, variables: {}, http: {}, database: { dialect: 'postgresql', host: 'postgres.demo.invalid', database: 'shop' } },
        secrets: { username: 'steward_reader', password: 'demo-reader-password' },
      },
    }),
  );
}

async function upload(page: Page, button: ReturnType<Page['getByTestId']>, file: { name: string; mimeType: string; buffer: Buffer }) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]);
  await chooser.setFiles(file);
}

async function schemaTab(page: Page, api: APIRequestContext, mobile: boolean) {
  const db = await newDb(api);
  await page.goto(`/platforms/${db.id}?tab=schema`);
  const view = page.getByTestId('schema-view');
  await expect(view.getByRole('heading', { name: 'Database schema' })).toBeVisible();
  // read the demo database: six tables of a shop
  await view.getByTestId('schema-read').click();
  await expect(view.getByTestId('schema-summary')).toContainText('6 tables, 28 columns');
  await expect(view.getByRole('tab', { name: /Tables \(6\)/ })).toBeVisible();
  await expectAccessible(page, 'schema tab: tables');
  if (mobile) await expectNoHorizontalScroll(page);
  // search by a column, open the table
  await view.getByTestId('schema-search').fill('sku');
  await expect(view.getByTestId('schema-table-open')).toHaveCount(1);
  await view.getByTestId('schema-table-open').click();
  const detail = page.getByTestId('schema-table-detail');
  await expect(detail).toContainText('Stock keeping unit');
  await expect(detail.getByRole('cell', { name: 'numeric(10,2)' })).toBeVisible();
  await expect(detail).toContainText('Referenced by');
  await expectAccessible(page, 'schema tab: table detail');
  if (mobile) await expectNoHorizontalScroll(page);
  // a referencing table opens from the detail
  await detail.getByRole('button', { name: /public\.order_lines/ }).click();
  await expect(page.getByTestId('schema-table-detail')).toContainText('order_id, line');
  await page.keyboard.press('Escape');
  await view.getByTestId('schema-search').fill('');
  return db;
}

async function importAndChanges(page: Page, mobile: boolean) {
  const view = page.getByTestId('schema-view');
  // the message of the read is gone (a dimmed toast behind the dialog would fail the contrast check)
  await expect(page.locator('.mantine-Notification-root')).toHaveCount(0, { timeout: 15_000 });
  await view.getByTestId('schema-import').click();
  const modal = page.getByTestId('schema-import-modal');
  await expect(modal).toContainText('curl -sS -f -X POST');
  await upload(page, modal.getByTestId('schema-choose-file'), {
    name: 'schema.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      TBLS([
        { name: 'id', type: 'integer', nullable: false },
        { name: 'name', type: 'character varying(60)', nullable: false },
      ]),
    ),
  });
  await upload(page, modal.getByTestId('schema-choose-lint'), { name: 'lint.txt', mimeType: 'text/plain', buffer: Buffer.from(LINT) });
  await modal.getByTestId('schema-preview').click();
  const preview = modal.getByTestId('schema-import-preview');
  await expect(preview).toContainText('1 table, 2 columns, 2 lint findings');
  await expect(preview).toContainText(/breaking/);
  await expectAccessible(page, 'schema import: preview');
  if (mobile) await expectNoHorizontalScroll(page);
  await modal.getByTestId('schema-apply').click();
  await expect(page.getByText('Schema imported.')).toBeVisible();
  await expect(view.getByTestId('schema-summary')).toContainText('tbls import');
  // the changes against the read: five tables removed, columns removed and narrowed – breaking
  await view.getByTestId('schema-tab-changes').click();
  const changes = view.getByTestId('schema-changes');
  await expect(changes.getByTestId('schema-change-summary')).toBeVisible();
  await expect(changes).toContainText('Table removed');
  await expect(changes).toContainText('narrower type');
  await expect(changes).toContainText('Default changed');
  await changes.getByRole('radiogroup', { name: 'Which changes' }).getByText('Breaking').click();
  await expect(changes).not.toContainText('Default changed');
  await expectAccessible(page, 'schema tab: changes');
  if (mobile) await expectNoHorizontalScroll(page);
  // the lint findings with their rule names
  await view.getByTestId('schema-tab-checks').click();
  await expect(view.getByTestId('schema-checks')).toContainText('requireColumnComment');
  // the history: the read and the import; an older snapshot can be shown
  await view.getByTestId('schema-tab-history').click();
  await expect(view.getByTestId('schema-history')).toContainText('Read');
  await view
    .getByRole('button', { name: /^Show the snapshot of/ })
    .first()
    .click();
  await expect(view.getByTestId('schema-older')).toBeVisible();
  await expectAccessible(page, 'schema tab: older snapshot');
  await view.getByRole('button', { name: 'Show the newest' }).click();
  await expect(view.getByTestId('schema-older')).toHaveCount(0);
}

/** A push token: created (shown once), it pushes from "CI", is listed with its last use, rotated and revoked. */
async function pushTokens(page: Page, mobile: boolean, target: { kind: string; id: string }, api: APIRequestContext, olivia: APIRequestContext) {
  const panel = page.getByTestId('push-tokens');
  await expect(panel).toContainText('No push token yet');
  await panel.getByTestId('push-token-new').click();
  const form = page.getByTestId('push-token-form');
  await form.getByRole('textbox', { name: 'Name' }).fill('GitHub Actions');
  await expectAccessible(page, 'push token: new');
  if (mobile) await expectNoHorizontalScroll(page);
  await form.getByTestId('push-token-create').click();
  const secret = page.getByTestId('push-token-secret');
  await expect(secret).toContainText('only this once');
  const token = (await secret.locator('pre').first().textContent())!.trim();
  expect(token).toMatch(/^sdbp_/);
  await expect(secret).toContainText(`/api/hooks/db-schema/${target.kind}/${target.id}`);
  await expectAccessible(page, 'push token: secret');
  if (mobile) await expectNoHorizontalScroll(page);
  await secret.getByTestId('push-token-done').click();
  // the push from CI
  // the push from CI: a client of its own, without the browser's session
  const ci = await request.newContext({ storageState: { cookies: [], origins: [] } });
  const res = await ci.post(`${baseURL()}/api/hooks/db-schema/${target.kind}/${target.id}`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    data: TBLS([{ name: 'id', type: 'bigint', nullable: false }]),
  });
  expect(res.status(), await res.text()).toBe(200);
  await ci.dispose();
  await page.reload();
  await expect(page.getByTestId('push-tokens')).toContainText('GitHub Actions');
  await expect(page.getByTestId('push-tokens')).not.toContainText('never used');
  await expect(page.getByTestId('push-tokens')).not.toContainText(token);
  await expectAccessible(page, 'push tokens: list');
  if (mobile) await expectNoHorizontalScroll(page);
  await page.getByTestId('push-token-rotate').click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Rotate/ })
    .click();
  await expect(page.getByTestId('push-token-secret')).toBeVisible();
  await page.getByTestId('push-token-done').click();
  await page.getByTestId('push-token-revoke').click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Revoke/ })
    .click();
  await expect(page.getByTestId('push-tokens')).toContainText('No push token yet');
  // a token stops with its creator: Olivia may no longer manage the database, and the list says so
  await api.put(`/api/platforms/${target.id}/access`, {
    data: {
      acl: [
        { subject: 'user:olivia', permissions: ['manage'] },
        { subject: 'user:admin', permissions: ['manage'] },
      ],
    },
  });
  const theirs = await json<{ id: string }>(
    await olivia.post(`/api/db-schemas/${target.kind}/${target.id}/push-tokens`, { data: { name: 'Olivia’s pipeline' } }),
  );
  await api.put(`/api/platforms/${target.id}/access`, { data: { acl: [] } });
  await page.reload();
  await expect(page.getByTestId('push-token-creator-inactive')).toContainText('Creator inactive – create a new token');
  await expectAccessible(page, 'push tokens: creator inactive');
  if (mobile) await expectNoHorizontalScroll(page);
  await api.delete(`/api/db-schemas/${target.kind}/${target.id}/push-tokens/${theirs.id}`);
}

async function exportsAndSettings(page: Page, api: APIRequestContext, dbId: string) {
  const view = page.getByTestId('schema-view');
  await view.getByTestId('schema-export').click();
  const href = await page.getByTestId('schema-export-dbml').getAttribute('href');
  expect(href).toContain('/export?format=dbml');
  const res = await api.get(href!.replace(/^.*\/api\//, '/api/'));
  expect(res.ok()).toBe(true);
  expect(await res.text()).toContain('Table "public"."customers"');
  await page.keyboard.press('Escape');
  await view.getByTestId('schema-settings').click();
  const modal = page.getByTestId('schema-settings-modal');
  await modal.getByRole('textbox', { name: 'Snapshots to keep' }).fill('10');
  await modal.getByRole('textbox', { name: 'Read every (hours)' }).fill('6');
  await expectAccessible(page, 'schema settings');
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(view).toContainText('Read every 6 h');
  await api.put(`/api/db-schemas/platform/${dbId}/settings`, { data: { retention: 30, readIntervalHours: 0 } });
}

async function systemSchema(page: Page, api: APIRequestContext, mobile: boolean) {
  const sys = await json<{ id: string }>(await api.post('/api/systems', { data: { name: uniq('Bakery database'), kind: 'server' } }));
  await page.goto(`/systems/${sys.id}`);
  await page.getByTestId('system-schema-link').click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Database schema of');
  await expect(page.getByTestId('schema-empty')).toBeVisible();
  await expect(page.getByTestId('schema-read')).toHaveCount(0);
  await expectAccessible(page, 'system schema: empty');
  if (mobile) await expectNoHorizontalScroll(page);
  await api.post(`/api/db-schemas/system/${sys.id}/import`, { data: { schema: TBLS([{ name: 'id', type: 'integer', nullable: false }]) } });
  await page.reload();
  await expect(page.getByTestId('schema-summary')).toContainText('1 table, 1 column');
  await expectAccessible(page, 'system schema');
  if (mobile) await expectNoHorizontalScroll(page);
  await api.delete(`/api/systems/${sys.id}`);
}

async function monitorCheck(page: Page, db: { name: string }) {
  await page.goto('/monitors/new');
  await settle(page);
  const palette = page.getByLabel('Check palette');
  const form = page.getByTestId('check-form');
  await palette.getByRole('button', { name: 'Database schema changes', exact: true }).click();
  await chooseOption(page, /^Platform/, db.name);
  await form.getByRole('button', { name: 'Check now' }).click();
  await expect(form.getByTestId('check-preview')).toContainText(/breaking schema change/);
  await expectAccessible(page, 'schema monitor check');
}

test('the Schema tab: read, tables, import, changes, history, exports, settings and the monitor check', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const db = await schemaTab(page, api, false);
  await importAndChanges(page, false);
  await exportsAndSettings(page, api, db.id);
  await pushTokens(page, false, { kind: 'platform', id: db.id }, api, await apiAs('olivia'));
  await systemSchema(page, api, false);
  await monitorCheck(page, db);
  await api.delete(`/api/platforms/${db.id}`);
});

test('database schemas on a phone @mobile', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const db = await schemaTab(page, api, true);
  await importAndChanges(page, true);
  await systemSchema(page, api, true);
  await page.goto(`/platforms/${db.id}?tab=schema`);
  await pushTokens(page, true, { kind: 'platform', id: db.id }, api, await apiAs('olivia'));
  await api.delete(`/api/platforms/${db.id}`);
});
