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
  test('Vega-Lite widgets draw from the dataset only, with a table twin (#120)', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    await page.goto('/dashboards/edge-fleet');
    const chart = widget(page, 'Devices per firmware version');
    // drawn as SVG by the on-demand chart chunk; the fixtures fail the test on any console error, CSP violations included
    const svg = chart.locator('.vega-chart svg');
    await expect(svg).toBeVisible();
    await expect(svg.locator('path').first()).toBeAttached();
    // named by the spec's description for screen readers
    await expect(chart.locator('.vega-chart[role="graphics-document"]')).toHaveAttribute('aria-label', /^Number of devices per firmware version/);
    await chart.getByText('Table', { exact: true }).click();
    await expect(chart.getByRole('columnheader', { name: 'Firmware' })).toBeVisible();
    await expect(chart.getByRole('table').getByRole('row').nth(1)).toBeVisible();
    await chart.getByText('Chart', { exact: true }).click();
    await expect(svg).toBeVisible();
    // nothing but the app's own origin was asked for anything
    const origin = new URL(page.url()).origin;
    expect(requests.filter((u) => !u.startsWith(origin) && !u.startsWith('data:'))).toEqual([]);

    await page.goto('/dashboards/tenant-usage');
    await expect(widget(page, 'Used share of each limit').locator('.vega-chart svg')).toBeVisible();
  });
});
