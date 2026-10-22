import { test, expect } from './support/fixtures';
import { authFile } from './support/env';

test.use({ storageState: authFile('audrey') });

/** A dashboard widget card, found by its title. */
const widget = (page: import('@playwright/test').Page, title: string) => page.getByRole('region', { name: title, exact: true });

test.describe('dashboards', () => {
  test('the demo dashboards are listed and open without errors', async ({ page }) => {
    await page.goto('/dashboards');
    for (const name of ['Platform operations', 'Access governance', 'Edge fleet']) {
      await page.goto('/dashboards');
      await page.getByText(name, { exact: true }).click();
      await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
      await expect(page.getByText(/data from .+ ago/)).toBeVisible();
      await expect(page.locator('.viz-root').first()).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
    }
  });

  test('KPI, trend, status and table widgets render data', async ({ page }) => {
    await page.goto('/dashboards/platform-operations');

    // KPI tiles: a number and the freshness line
    const users = widget(page, 'Insights Hub users');
    await expect(users.locator('.viz-kpi-value')).toHaveText(/^\d+$/);
    expect(Number(await users.locator('.viz-kpi-value').innerText())).toBeGreaterThan(0);
    await expect(users.getByText(/^updated /)).toBeVisible();
    await expect(widget(page, 'Edge devices offline').locator('.viz-kpi-value')).toHaveText(/^\d+$/);

    // trend chart, with a table twin
    const trend = widget(page, 'Users over time');
    await expect(trend.getByRole('img', { name: /^Trend of total, inactive90/ })).toBeVisible();
    await trend.getByText('Table', { exact: true }).click();
    await expect(trend.getByRole('table')).toBeVisible();
    await expect(trend.getByRole('img', { name: /^Trend of/ })).toHaveCount(0);
    await trend.getByText('Chart', { exact: true }).click();
    await expect(trend.getByRole('img', { name: /^Trend of/ })).toBeVisible();

    // status distribution
    const status = widget(page, 'Edge device status');
    await expect(status.getByRole('list', { name: 'Status distribution' }).getByRole('listitem')).not.toHaveCount(0);

    // table with problems-only filter and search
    const table = widget(page, 'Devices needing attention');
    const rows = table.getByRole('table').getByRole('row');
    await expect(rows.nth(1)).toBeVisible();
    const problems = await rows.count();
    await table.getByText('Problems only').click();
    await expect.poll(() => rows.count()).toBeGreaterThan(problems);
    await table.getByRole('textbox', { name: 'Search' }).fill('edge-lab');
    await expect(rows).toHaveCount(2); // header + edge-lab
    await expect(table.getByRole('cell', { name: 'edge-lab' })).toBeVisible();

    // every widget has data (ih.privileged is only filled once a privileged access review ran)
    await expect(page.getByText(/^No data in (?!ih\.privileged)/)).toHaveCount(0);
  });
});
