import type { Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { chooseOption, expectNoHorizontalScroll } from './support/helpers';

test.use({ storageState: authFile('admin') });

/**
 * The freshness check's InfluxDB source (0.18.0, docs/MONITORS.md#freshness-in-influxdb) against the demo's InfluxDB
 * 2.x mock: the fields of the platform's version, Check now with the newest timestamp of every series (press-03 is
 * stale), the YAML of the check – on a desktop and a phone.
 */

async function influxCheck(page: Page) {
  const palette = page.getByLabel('Check palette');
  const form = page.getByTestId('check-form');
  await palette.getByRole('button', { name: 'Data freshness', exact: true }).click();
  await form.getByText('InfluxDB series', { exact: true }).click();
  await chooseOption(page, /^Platform/, /^InfluxDB \(demo\)/);
  // 2.x reads a bucket; the retention policy (1.x) is not offered
  await form.getByRole('textbox', { name: /^Bucket/ }).fill('plant');
  await expect(form.getByRole('textbox', { name: /^Retention policy/ })).toHaveCount(0);
  await form.getByRole('textbox', { name: /^Measurement/ }).fill('machine_data');
  await form.getByRole('textbox', { name: /^One series per tag/ }).fill('device');
  await expect(form.getByRole('combobox', { name: /^Expected series/ })).toBeVisible();
  await form.getByRole('button', { name: 'Check now' }).click();
  const preview = form.getByTestId('check-preview');
  await expect(preview).toContainText('1 of 4 series not fresh: Newest data of press-03 is 3.0 h old');
  const rows = preview.getByTestId('series-preview').getByRole('row');
  await expect(rows).toHaveCount(5);
  // the worst series first
  await expect(rows.nth(1)).toContainText('press-03');
  await expect(rows.nth(1)).toContainText('3 h');
  await expect(rows.nth(1).locator('[data-status="down"]')).toBeVisible();
  await expect(rows.nth(2).locator('[data-status="up"]')).toBeVisible();
  await expectAccessible(page, 'influxdb freshness check with Check now');
}

test('an InfluxDB freshness check in the editor: the fields of 2.x, Check now lists every series', async ({ page }) => {
  await page.goto('/monitors/new');
  await settle(page);
  await influxCheck(page);
  await page.getByRole('tab', { name: 'YAML' }).click();
  await expect(page.getByRole('textbox', { name: 'YAML source' })).toHaveValue(
    /source: influxdb[\s\S]*bucket: plant[\s\S]*measurement: machine_data[\s\S]*groupBy: device/,
  );
});

test('switching the source clears the InfluxDB fields and the platform of another kind', async ({ page }) => {
  await page.goto('/monitors/new');
  await settle(page);
  const form = page.getByTestId('check-form');
  await page.getByLabel('Check palette').getByRole('button', { name: 'Data freshness', exact: true }).click();
  await form.getByText('InfluxDB series', { exact: true }).click();
  await chooseOption(page, /^Platform/, /^InfluxDB \(demo\)/);
  await form.getByRole('textbox', { name: /^Measurement/ }).fill('machine_data');
  await form.getByText('Insights Hub time series', { exact: true }).click();
  await expect(form.getByRole('textbox', { name: /^Measurement/ })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: /^Platform/ })).toHaveValue('');
  await page.getByRole('tab', { name: 'YAML' }).click();
  await expect(page.getByRole('textbox', { name: 'YAML source' })).not.toHaveValue(/measurement:/);
});

test('the InfluxDB check on a phone @mobile', async ({ page }) => {
  await page.goto('/monitors/new');
  await settle(page);
  await influxCheck(page);
  await expectNoHorizontalScroll(page);
});
