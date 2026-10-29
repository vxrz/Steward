import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { json, uniq, waitForRun } from './support/helpers';

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
    await expect(page.getByTestId('kpi-by-source')).toContainText(`${tag} EU`);
    await expect(page.getByTestId('kpi-by-source')).toContainText(`${tag} US`);
    await expectAccessible(page, 'dashboard with sources');

    // one source: its rows only, in the URL, remembered after a reload
    await filter.getByRole('textbox', { name: 'Sources' }).click();
    await page.getByRole('option', { name: `${tag} US` }).click();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(new RegExp(`source=${us}`));
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table).toContainText('cyd');
    await expect(table.getByRole('columnheader', { name: 'Source' })).toHaveCount(0);
    await page.goto(`/dashboards/${dash.id}`);
    await expect(page).toHaveURL(new RegExp(`source=${us}`));
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(2);
  } finally {
    await api.delete(`/api/dashboards/${dash.id}`);
    await api.delete(`/api/datasets/${dataset}`);
    await api.delete(`/api/processes/${proc.id}`);
  }
});
