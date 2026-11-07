import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json } from './support/helpers';

test.use({ storageState: authFile('admin') });

/**
 * Data contracts (#221, docs/DATA-CONTRACTS.md): the list with the demo's two contracts and its filters, a new
 * contract drafted from database tables, its overview with Steward's findings, a test through the demo data
 * contract service with the run's checks, a new version with a breaking change and the version comparison, and a
 * link – on a desktop and a phone, with axe.
 */

async function readDemoSchema(api: APIRequestContext): Promise<void> {
  const platforms = await json<{ id: string; name: string }[]>(await api.get('/api/platforms'));
  const shop = platforms.find((p) => p.name === 'Shop database (demo)')!;
  await api.post(`/api/db-schemas/platform/${shop.id}/read`, { data: {} });
}

async function list(page: Page, mobile: boolean) {
  await page.goto('/data-contracts');
  await expect(page.getByRole('heading', { name: 'Data contracts', level: 1 })).toBeVisible();
  const scope = page.getByTestId('data-contracts');
  await expect(scope.getByRole('link', { name: 'Shop orders' }).first()).toBeVisible();
  await expect(scope.getByRole('link', { name: 'Shop customers' }).first()).toBeVisible();
  await settle(page);
  await expectAccessible(page, 'data contracts: list');
  if (mobile) await expectNoHorizontalScroll(page);
  if (!mobile) {
    // only the failing ones
    await chooseOption(page, 'Last test', 'Failed');
    await expect(scope.getByRole('link', { name: 'Shop customers' }).first()).toBeVisible();
    await expect(scope.getByRole('link', { name: 'Shop orders' })).toHaveCount(0);
  }
}

async function draftFromTables(page: Page, mobile: boolean): Promise<string> {
  await page.goto('/data-contracts/new');
  await expect(page.getByRole('heading', { name: 'New data contract', level: 1 })).toBeVisible();
  await page.getByTestId('draft-source').getByText('Database tables', { exact: true }).click();
  await chooseOption(page, 'Database', 'Shop database (demo)');
  await chooseOption(page, 'Tables', 'public.products');
  await page.keyboard.press('Escape');
  await page.getByTestId('draft-make').click();
  await expect(page.getByTestId('contract-yaml')).toHaveValue(/name: products/);
  await expect(page.getByTestId('draft-links')).toContainText('Database table');
  await expect(page.getByTestId('contract-lint-ok')).toBeVisible();
  await settle(page);
  await expectAccessible(page, 'data contracts: new from tables');
  if (mobile) await expectNoHorizontalScroll(page);
  await page.getByTestId('contract-create').click();
  await expect(page).toHaveURL(/\/data-contracts\/dct_/);
  return new URL(page.url()).pathname.split('/').pop()!;
}

async function overviewAndTest(page: Page, mobile: boolean) {
  await expect(page.getByTestId('contract-findings')).toContainText('Never tested');
  // the draft linked the server to the demo database: choose the demo service and test
  await chooseOption(page, 'Data contract service', 'Data contract service (demo)');
  await page.getByTestId('contract-settings').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('contract-test')).toBeEnabled();
  await settle(page);
  await expectAccessible(page, 'data contract: overview');
  if (mobile) await expectNoHorizontalScroll(page);
  await page.getByTestId('contract-test').click();
  const run = page.getByRole('dialog', { name: 'Test run' });
  await expect(run.getByTestId('contract-result').first()).toHaveText('Passed');
  await expect(run.getByTestId('contract-run-checks')).toContainText('Check that field sku is present');
  await settle(page);
  await expectAccessible(page, 'data contract: test run');
  await run.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('contract-runs')).toBeVisible();
  if (mobile) await expectNoHorizontalScroll(page);
}

async function newVersion(page: Page, mobile: boolean) {
  await page.getByTestId('contract-tab-contract').click();
  const editor = page.getByTestId('contract-yaml');
  const yaml = await editor.inputValue();
  // the draft says sku is character varying(40): promising only 20 characters narrows it
  await editor.fill(yaml.replace('physicalType: character varying(40)', 'physicalType: character varying(20)'));
  await expect(page.getByTestId('contract-changes')).toContainText('type narrowed');
  await expect(page.getByTestId('contract-changes')).toContainText('Breaking');
  await settle(page);
  await expectAccessible(page, 'data contract: editor with changes');
  if (mobile) await expectNoHorizontalScroll(page);
  await page.getByTestId('contract-save').click();
  await page.getByTestId('contract-tab-versions').click();
  await expect(page.getByTestId('contract-versions')).toContainText('1 breaking');
  await expect(page.getByTestId('contract-compare').getByTestId('contract-changes')).toContainText('products.sku');
  await expect(page.getByTestId('version-diff')).toBeVisible();
  await settle(page);
  await expectAccessible(page, 'data contract: versions');
  if (mobile) await expectNoHorizontalScroll(page);
}

async function links(page: Page, mobile: boolean) {
  await page.getByTestId('contract-tab-links').click();
  await expect(page.getByTestId('contract-links')).toContainText('public.products');
  await page.getByTestId('contract-link-add').click();
  await chooseOption(page, 'Kind', 'Application');
  await chooseOption(page, 'Application', 'Webshop (demo)');
  await page.getByTestId('link-save').click();
  await expect(page.getByTestId('contract-links').getByRole('link', { name: 'Webshop (demo)' })).toBeVisible();
  await settle(page);
  await expectAccessible(page, 'data contract: links');
  if (mobile) await expectNoHorizontalScroll(page);
}

test('data contracts: list, a draft from tables, a test, a breaking version and links', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  await readDemoSchema(api);
  await list(page, false);
  const id = await draftFromTables(page, false);
  await overviewAndTest(page, false);
  await newVersion(page, false);
  await links(page, false);
  await api.delete(`/api/data-contracts/${id}`);
});

test('data contracts on a phone @mobile', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  await readDemoSchema(api);
  await list(page, true);
  const id = await draftFromTables(page, true);
  await overviewAndTest(page, true);
  await newVersion(page, true);
  await links(page, true);
  await api.delete(`/api/data-contracts/${id}`);
});

test('a viewer sees contracts but cannot create, test or change them', async ({ loginAs }) => {
  const page = await loginAs('vera');
  await page.goto('/data-contracts');
  await expect(page.getByRole('link', { name: 'Shop orders' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'New contract' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Shop orders' }).first().click();
  await expect(page.getByRole('heading', { name: /Shop orders/, level: 1 })).toBeVisible();
  await expect(page.getByTestId('contract-test')).toHaveCount(0);
  await page.getByTestId('contract-tab-contract').click();
  await expect(page.getByText('You may read this contract')).toBeVisible();
  await settle(page);
  await expectAccessible(page, 'data contract: read only');
});

test('who approves changes may switch off the change record rule, editors may not', async ({ loginAs }) => {
  // the demo's orders contract requires a change record for breaking changes
  const approver = await loginAs('adam');
  await approver.goto('/data-contracts');
  await approver.getByRole('link', { name: 'Shop orders' }).first().click();
  const rule = approver.getByTestId('contract-require-change-record');
  await expect(rule).toBeChecked();
  await expect(rule).toBeEnabled();
  await expect(approver.getByTestId('contract-service')).toBeDisabled();
  await settle(approver);
  await expectAccessible(approver, 'data contract: settings of an approver');
  const editor = await loginAs('dana');
  await editor.goto('/data-contracts');
  await editor.getByRole('link', { name: 'Shop orders' }).first().click();
  await expect(editor.getByTestId('contract-require-change-record')).toBeDisabled();
  await expect(editor.getByTestId('contract-settings')).toContainText('Only approvers and administrators can switch it off');
});
