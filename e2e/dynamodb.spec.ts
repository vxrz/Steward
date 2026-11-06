import type { Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json } from './support/helpers';

test.use({ storageState: authFile('admin') });

/**
 * The monitor check "DynamoDB table" (#233, docs/MONITORS.md) against the demo account's table crm-contacts: the
 * editor form in its three modes with "Check now", the link from the AWS inventory of the CRM (demo) application, and
 * the method, headers and body of a platform freshness check – on a desktop and a phone.
 */

async function newestItem(page: Page) {
  const palette = page.getByLabel('Check palette');
  const form = page.getByTestId('check-form');
  await palette.getByRole('button', { name: 'DynamoDB table', exact: true }).click();
  await chooseOption(page, /^Platform/, /^AWS \(demo\)/);
  await form.getByRole('textbox', { name: /^Table/ }).fill('crm-contacts');
  await form.getByRole('textbox', { name: /^Region/ }).fill('eu-central-1');
  await expect(form.getByRole('combobox', { name: /^Partition key values/ })).toHaveAttribute('required', '');
  await form.getByRole('textbox', { name: /^Index/ }).fill('by-segment-updated');
  await form.getByRole('textbox', { name: /^Partition key\s*\*?$/ }).fill('segment');
  const values = form.getByRole('combobox', { name: /^Partition key values/ });
  await values.fill('customer');
  await values.press('Enter');
  await values.fill('lead');
  await values.press('Enter');
  await form.getByRole('textbox', { name: /^Time attribute/ }).fill('updatedAt');
  await form.getByRole('button', { name: 'Check now' }).click();
  await expect(form.getByTestId('check-preview')).toContainText('DynamoDB crm-contacts: All 2 partition keys are fresh');
  await expectAccessible(page, 'dynamodb check: newest item');
}

async function otherModes(page: Page) {
  const form = page.getByTestId('check-form');
  await chooseOption(page, 'What is checked', 'Table hygiene');
  await expect(form.getByRole('combobox', { name: /^Partition key values/ })).toHaveCount(0);
  await chooseOption(page, 'Time to live on', 'Required');
  await form.getByRole('button', { name: 'Check now' }).click();
  await expect(form.getByTestId('check-preview')).toContainText('time to live disabled, ACTIVE, 48,210 items');
  await expectAccessible(page, 'dynamodb check: hygiene');
  await chooseOption(page, 'What is checked', 'Write activity (CloudWatch)');
  await form.getByText('On change (maximum age)', { exact: true }).click();
  await form.getByRole('textbox', { name: /^Down when older than/ }).fill('900');
  await form.getByRole('button', { name: 'Check now' }).click();
  await expect(form.getByTestId('check-preview')).toContainText('write capacity units in the last');
  await expectAccessible(page, 'dynamodb check: write activity');
}

test('the DynamoDB check in the editor: newest item, hygiene and write activity, each tried with Check now', async ({ page }) => {
  await page.goto('/monitors/new');
  await settle(page);
  await newestItem(page);
  await otherModes(page);
});

test('the AWS inventory links a DynamoDB table to a new monitor with the check', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const app = (await json<{ id: string; name: string }[]>(await api.get('/api/applications'))).find((a) => a.name === 'CRM (demo)')!;
  await page.goto(`/applications/${app.id}`);
  const tables = page.getByTestId('aws-dynamodb-tables');
  await expect(tables).toContainText('DynamoDB tables');
  await expectAccessible(page, 'aws inventory with dynamodb tables');
  await tables.getByRole('link', { name: 'Watch the freshness of crm-contacts in a new monitor' }).click();
  await expect(page).toHaveURL(/\/monitors\/new\?dynamodb=/);
  const form = page.getByTestId('check-form');
  await expect(form.getByRole('textbox', { name: /^Table/ })).toHaveValue('crm-contacts');
  await expect(form.getByRole('textbox', { name: /^Region/ })).toHaveValue('eu-central-1');
  await expect(page.getByRole('combobox', { name: /^Platform/ })).toHaveValue(/^AWS \(demo\)/);
  await expect(page.getByTestId('monitor-node-newest-item')).toBeVisible();
});

test('platform freshness with POST: method, headers and body', async ({ page }) => {
  await page.goto('/monitors/new');
  await settle(page);
  const form = page.getByTestId('check-form');
  await page.getByLabel('Check palette').getByRole('button', { name: 'Data freshness' }).click();
  await form.getByText('Any platform API').click();
  await expect(form.getByRole('textbox', { name: /^Body/ })).toHaveCount(0);
  await chooseOption(page, /^Method/, 'POST');
  await form.getByRole('textbox', { name: /^Path/ }).fill('/orders/_search');
  await form.getByRole('textbox', { name: /^Body/ }).fill('{ "size": 1 }');
  await expectAccessible(page, 'freshness check with POST');
  await page.getByRole('tab', { name: 'YAML' }).click();
  await expect(page.getByRole('textbox', { name: 'YAML source' })).toHaveValue(/method: POST[\s\S]*body:\s+size: 1/);
});

test('the DynamoDB check on a phone @mobile', async ({ page }) => {
  await page.goto('/monitors/new');
  await settle(page);
  await newestItem(page);
  await expectNoHorizontalScroll(page);
  await otherModes(page);
  await expectNoHorizontalScroll(page);
});
