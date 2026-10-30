import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { json, uniq, waitForRun } from './support/helpers';
import { forecastTo, trendOf } from '../shared/src/trends';

/**
 * Trends and forecasts on dashboards (#145): a KPI shows the change of the trend line, what it is based on and when
 * the limit from the publish step is reached; a trend chart draws dashed trend lines; the editor sets a threshold.
 *
 * A month of history can't be recorded in a UI test, so the metric history is answered here with a steady month
 * (+10 a day up to 900); the trend math itself is tested on the server.
 */

test.use({ storageState: authFile('admin') });

const DAY = 86_400_000;

test('a KPI shows the trend and the forecast to the limit, a chart its trend line', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const tag = uniq('E2E trend').replace(/\W+/g, '-').toLowerCase();
  const dataset = `e2e.${tag}`;
  const proc = await json(
    await api.post('/api/processes', {
      data: {
        definition: {
          name: `${tag} quota`,
          steps: [{ id: 'p', type: 'publish', dataset, title: 'Quota', rows: '[]', metrics: { used: '900' }, limits: { used: '1130' } }],
        },
      },
    }),
  );
  const run = await json(await api.post('/api/runs', { data: { processId: proc.id, bindings: {} } }));
  await waitForRun(api, run.id, ['succeeded']);
  const dash = await json(
    await api.post('/api/dashboards', {
      data: {
        definition: {
          name: `${tag} dashboard`,
          widgets: [
            { id: 'kpi', type: 'kpi', title: 'Quota used', dataset, metric: 'used', days: 30, goodWhen: 'down' },
            { id: 'chart', type: 'trend', title: 'Quota over time', dataset, metrics: ['used'], days: 30, trendLine: true },
          ],
        },
      },
    }),
  );

  // the history: a steady month, as the server would answer it
  const now = Date.now();
  const points = Array.from({ length: 30 }, (_, i) => ({ ts: new Date(now - (29 - i) * DAY - 60_000).toISOString(), value: 900 - 10 * (29 - i) }));
  await page.route(`**/api/datasets/${dataset}/metrics?**`, (route) =>
    route.fulfill({
      json: [
        {
          name: 'used',
          points,
          limit: { value: 1130, lower: false },
          trend: trendOf(points, '30d', now),
          forecast: forecastTo(points, 1130, { window: '30d', now }),
        },
      ],
    }),
  );

  try {
    await page.goto(`/dashboards/${dash.id}`);
    await settle(page);
    const kpi = page.getByRole('region', { name: 'Quota used', exact: true });
    await expect(kpi.locator('.viz-kpi-value')).toHaveText('900');
    // the change of the trend line over 30 days (+300, from 600), not first → last point (+290)
    await expect(kpi).toContainText('+300');
    await expect(kpi).toContainText('(+50 %)');
    await expect(kpi).toContainText('trend over 30 days');
    await expect(kpi.getByTestId('kpi-trend-basis')).toHaveText('Based on 30 points over 30 days · stable');
    // the limit of the publish step: 230 to go at 10 a day
    await expect(kpi.getByTestId('kpi-forecast')).toContainText(/^Limit 1,130 reached in about 23 days \(.+\) at this rate$/);

    const chart = page.getByRole('region', { name: 'Quota over time', exact: true });
    await expect(chart.getByTestId('trend-line')).toHaveCount(1);
    await expectAccessible(page, 'dashboard with trends');

    // a threshold of the widget wins over the metric's limit
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click(); // the KPI, first in the list
    const form = page.getByRole('dialog');
    await form.getByRole('textbox', { name: 'Limit', exact: true }).fill('950');
    await expectAccessible(page, 'KPI form with a limit');
    await form.getByRole('button', { name: 'Apply' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(kpi.getByTestId('kpi-forecast')).toContainText(/^Limit 950 reached in about 5 days/);
  } finally {
    await api.delete(`/api/dashboards/${dash.id}`);
    await api.delete(`/api/datasets/${dataset}`);
    await api.delete(`/api/processes/${proc.id}`);
  }
});
