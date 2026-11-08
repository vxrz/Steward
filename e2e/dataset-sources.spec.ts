import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll, json, uniq, waitForRun } from './support/helpers';

/** Datasets per source platform on a dashboard (#142): a source filter, a Source column, values per source. */

test.use({ storageState: authFile('admin') });

test('a dashboard shows every source and filters by source', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const tag = uniq('E2E src').replace(/\W+/g, '-').toLowerCase();
  const platform = async (name: string) =>
    (
      await json(
        await api.post('/api/platforms', {
          data: {
            name,
            kind: 'generic',
            baseUrl: 'http://127.0.0.1:9/api',
            config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none' } },
            secrets: {},
          },
        }),
      )
    ).id as string;
  const eu = await platform(`${tag} EU`);
  const us = await platform(`${tag} US`);
  const dataset = `e2e.${tag}`;
  const proc = await json(
    await api.post('/api/processes', {
      data: {
        definition: {
          name: `${tag} inventory`,
          connections: [{ slot: 'hub' }],
          inputs: [{ name: 'users', type: 'list' }],
          steps: [
            {
              id: 'p',
              type: 'publish',
              dataset,
              rows: 'inputs.users',
              key: '$',
              columns: [{ label: 'User', value: '$' }],
              metrics: { total: '$count(inputs.users)' },
            },
          ],
        },
      },
    }),
  );
  for (const [p, users] of [
    [eu, ['ada', 'bob']],
    [us, ['cyd']],
  ] as const) {
    const r = await json(await api.post('/api/runs', { data: { processId: proc.id, bindings: { hub: p }, inputs: { users } } }));
    await waitForRun(api, r.id, ['succeeded']);
  }
  const dash = await json(
    await api.post('/api/dashboards', {
      data: {
        definition: {
          name: `${tag} dashboard`,
          widgets: [
            { id: 'kpi', type: 'kpi', title: 'Users per tenant', dataset, metric: 'total' },
            { id: 'sum', type: 'kpi', title: 'Users of all tenants', dataset, metric: 'total', combine: 'sum' },
            { id: 'rows', type: 'table', title: 'All users', dataset },
          ],
        },
      },
    }),
  );
  try {
    await page.goto(`/dashboards/${dash.id}`);
    await settle(page);
    const filter = page.getByTestId('dashboard-sources');
    await expect(filter).toBeVisible();
    // the table widget (the only table on this dashboard)
    const table = page.getByRole('table');
    await expect(table.getByRole('columnheader', { name: 'Source' })).toBeVisible();
    await expect(table.getByRole('row')).toHaveCount(4); // header + 3
    const perTenant = page.getByTestId('kpi-by-source').first();
    await expect(perTenant).toContainText(`${tag} EU`);
    await expect(perTenant).toContainText(`${tag} US`);
    // the widget set to "sum": one number for both tenants, with the values per tenant below it
    await expect(page.getByTestId('kpi-sum')).toHaveText('3');
    await expect(page.getByText('Sum of 2 sources')).toBeVisible();
    await expect(page.getByTestId('kpi-by-source')).toHaveCount(2);
    await expectAccessible(page, 'dashboard with sources');

    // one source: its rows only, in the URL, remembered after a reload; the sum is then that source's value
    await filter.getByRole('combobox', { name: 'Sources' }).click();
    await page.getByRole('option', { name: `${tag} US` }).click();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(new RegExp(`source=${us}`));
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table).toContainText('cyd');
    await expect(table.getByRole('columnheader', { name: 'Source' })).toHaveCount(0);
    await expect(page.getByTestId('kpi-by-source')).toHaveCount(0);
    await expect(page.getByTestId('kpi-sum')).toHaveCount(0);
    await page.goto(`/dashboards/${dash.id}`);
    await expect(page).toHaveURL(new RegExp(`source=${us}`));
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(2);

    // the widget editor offers the choice for a metric of a dataset with several sources
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const editors = page.getByRole('button', { name: 'Edit', exact: true });
    await editors.nth(1).click(); // the second widget: "Users of all tenants"
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('combobox', { name: 'With several sources' })).toHaveValue('Sum of all sources');
  } finally {
    await api.delete(`/api/dashboards/${dash.id}`);
    await api.delete(`/api/datasets/${dataset}`);
    await api.delete(`/api/processes/${proc.id}`);
  }
});

/**
 * The freshness widget (0.3.1): one line per source with its own schedule – the interval in words, when it counts as
 * stale and why, and the next run of that source's schedule – even when the step sets a shorter limit.
 */
async function scheduledTenants(api: import('@playwright/test').APIRequestContext) {
  const tag = uniq('E2E fresh').replace(/\W+/g, '-').toLowerCase();
  const platform = async (name: string) =>
    (
      await json(
        await api.post('/api/platforms', {
          data: {
            name,
            kind: 'generic',
            baseUrl: 'http://127.0.0.1:9/api',
            config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none' } },
            secrets: {},
          },
        }),
      )
    ).id as string;
  const eu = await platform(`${tag} EU`);
  const us = await platform(`${tag} US`);
  const dataset = `e2e.${tag}`;
  const proc = await json(
    await api.post('/api/processes', {
      data: {
        definition: {
          name: `${tag} inventory`,
          connections: [{ slot: 'hub' }],
          inputs: [{ name: 'users', type: 'list' }],
          steps: [{ id: 'p', type: 'publish', dataset, rows: 'inputs.users', key: '$', columns: [{ label: 'User', value: '$' }], staleAfterMinutes: 180 }],
        },
      },
    }),
  );
  // a daily schedule for one tenant, a weekly one for the other (times that do not come up during the test)
  for (const [p, name, cron] of [
    [eu, `${tag} daily EU`, '17 3 * * *'],
    [us, `${tag} weekly US`, '0 6 * * 1'],
  ] as const) {
    const sch = await json(
      await api.post('/api/schedules', {
        data: { name, processId: proc.id, cron, timezone: 'UTC', inputs: { users: ['ada'] }, bindings: { hub: p }, enabled: true },
      }),
    );
    const r = await json(await api.post(`/api/schedules/${sch.id}/run`, { data: {} }));
    await waitForRun(api, r.id, ['succeeded']);
  }
  const dash = await json(
    await api.post('/api/dashboards', {
      data: {
        definition: {
          name: `${tag} freshness`,
          widgets: [
            { id: 'f', type: 'freshness', title: 'Data freshness', width: 12 },
            { id: 't', type: 'table', title: 'Users', dataset },
          ],
        },
      },
    }),
  );
  const cleanup = async () => {
    await api.delete(`/api/dashboards/${dash.id}`);
    await api.delete(`/api/datasets/${dataset}`);
    await api.delete(`/api/processes/${proc.id}`);
  };
  return { tag, dataset, dash, cleanup };
}

test('the freshness widget shows every source with its own schedule', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const { tag, dash, cleanup } = await scheduledTenants(api);
  try {
    await page.goto(`/dashboards/${dash.id}`);
    const widget = page.getByRole('region', { name: 'Data freshness', exact: true });
    const eu = widget.getByTestId('source-freshness').filter({ hasText: `${tag} EU` });
    const us = widget.getByTestId('source-freshness').filter({ hasText: `${tag} US` });
    await expect(eu).toContainText('Fresh');
    await expect(eu).toContainText('daily');
    await expect(eu).toContainText(`stale after 2 days 12 h (from the schedule “${tag} daily EU”)`);
    await expect(eu.getByTestId('source-next-run')).toHaveText(/^next refresh in /);
    // weekly: not stale after the step's 3 hours, but after 2.5 weeks
    await expect(us).toContainText('weekly');
    await expect(us).toContainText(`stale after 17 days 12 h (from the schedule “${tag} weekly US”)`);
    // a weekly schedule (Mondays 06:00 UTC): in N days, "tomorrow", or in hours/minutes within the last day before it
    await expect(us.getByTestId('source-next-run')).toHaveText(/^next refresh (in \d+ (days?|hours?|minutes?)|tomorrow)$/);
    await expect(widget.getByText('1440 min')).toHaveCount(0);
    await settle(page);
    await expectAccessible(page, 'freshness widget');
  } finally {
    await cleanup();
  }
});

test('the freshness widget wraps on a phone instead of cutting text off @mobile', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const { tag, dash, cleanup } = await scheduledTenants(api);
  try {
    await page.goto(`/dashboards/${dash.id}`);
    const widget = page.getByRole('region', { name: 'Data freshness', exact: true });
    const line = widget.getByTestId('source-freshness').filter({ hasText: `${tag} US` });
    await expect(line).toContainText('stale after 17 days 12 h');
    await expectNoHorizontalScroll(page);
    const box = (await line.boundingBox())!;
    const view = page.viewportSize()!;
    expect(box.x + box.width).toBeLessThanOrEqual(view.width);
    // the rule's text is whole: its element is not narrower than its content
    const rule = line.getByText(/stale after/);
    expect(await rule.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  } finally {
    await cleanup();
  }
});
