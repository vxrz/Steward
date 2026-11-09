import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { settle } from './support/axe';
import { json, uniq } from './support/helpers';

/**
 * Monitor states (ADR 0021): a machine that is off with every check agreeing is grey and quiet, a contradiction is red
 * with the deviating check, and the editor's decision table answers "Try it". The demo's Lathe 5 is off, Mill 6's
 * PowerMeter does not answer although its data arrives.
 */

test.use({ storageState: authFile('dana') });

async function monitorByKey(api: APIRequestContext, key: string) {
  const list = await json<{ id: string; key: string }[]>(await api.get('/api/monitors'));
  const m = list.find((x) => x.key === key);
  expect(m, key).toBeTruthy();
  return m!.id;
}

test('a machine that is off with every check agreeing: a grey Off banner and "Why this state"', async ({ page, apiAs }) => {
  const id = await monitorByKey(await apiAs('dana'), 'lathe-5-powermeter');
  await page.goto(`/monitors/${id}`);
  const banner = page.getByTestId('monitor-off-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Off – all checks agree');
  await expect(banner).toContainText(/off .* of 8 h/);
  // no red root cause
  await expect(page.getByTestId('monitor-root-cause')).toHaveCount(0);
  const why = page.getByTestId('why-this-state');
  await expect(why.getByRole('heading', { name: 'Why this state' })).toBeVisible();
  await expect(why.getByTestId('state-name')).toHaveText('State: Off');
  await expect(why.getByTestId('state-message')).toContainText('All checks agree');
  for (const c of ['pm-reachable', 'pm-data', 'pm-energy']) await expect(why.getByTestId(`state-cell-${c}`)).toHaveAttribute('data-verdict', 'agrees');
  await expect(why.getByTestId('state-cell-pm-reachable')).toContainText('Selected by');
  await expect(why.getByTestId('state-cell-gateway')).toContainText('Required');
  // the checks that agree with down show off (grey) in the graph
  await expect(page.getByTestId('monitor-node-pm-data')).toHaveAttribute('data-status', 'off');
});

test('a contradiction is red and names the deviating check (the closest state is Running)', async ({ page, apiAs }) => {
  const id = await monitorByKey(await apiAs('dana'), 'mill-6-powermeter');
  await page.goto(`/monitors/${id}`);
  const alert = page.getByTestId('monitor-root-cause');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('PowerMeter reachable');
  await expect(page.getByTestId('monitor-contradiction')).toContainText(/PowerMeter reachable is down, but \d checks say Running/);
  await expect(page.getByTestId('monitor-off-banner')).toHaveCount(0);
  const why = page.getByTestId('why-this-state');
  await expect(why.getByTestId('state-message')).toContainText('Contradiction');
  await expect(why.getByTestId('state-contradiction')).toContainText('Closest state: Running.');
  await expect(why.getByTestId('state-contradiction')).toContainText('PowerMeter reachable: expected Up, is Down');
  await expect(why.getByTestId('state-cell-pm-data')).toHaveAttribute('data-verdict', 'contradicts');
  await expect(why.getByTestId('state-cell-pm-data')).toContainText('contradicts');
});

test('the editor\'s decision table: rows, cells, and "Try it"', async ({ page, apiAs }) => {
  const api = await apiAs('dana');
  const created = await json(
    await api.post('/api/monitors', {
      data: {
        definition: {
          name: uniq('E2E states'),
          checks: [
            { id: 'pm', name: 'PowerMeter reachable', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600, x: 0, y: 0 },
            { id: 'data', name: 'PowerMeter data', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600, x: 0, y: 160 },
          ],
          states: {
            cases: [
              { id: 'running', name: 'Running', when: { pm: 'up' }, expect: { data: 'up' } },
              { id: 'off', name: 'Off', status: 'off', when: { pm: 'down' }, expect: { data: 'down' } },
            ],
          },
        },
      },
    }),
  );
  const id = created.monitor.id;
  await page.goto(`/monitors/${id}/edit`);
  await settle(page);
  await page.getByRole('tab', { name: 'States' }).click();
  const table = page.getByTestId('states-table');
  await expect(table.getByTestId('state-row-running')).toBeVisible();
  await expect(table.getByTestId('state-row-off')).toBeVisible();
  // the cells: a labelled select per state and check
  await expect(page.getByRole('combobox', { name: 'Off – PowerMeter reachable', exact: true })).toHaveValue('Down · selects');
  await expect(page.getByRole('combobox', { name: 'Off – PowerMeter data', exact: true })).toHaveValue('Down');
  // the derived settle time of Off: 600 s + 2 × 60 s
  await expect(table.getByTestId('state-row-off')).toContainText('12 min (derived)');

  // Try it: PowerMeter down, its data still arrives → a contradiction
  const tryIt = async (pm: string, data: string) => {
    await page.getByTestId('try-pm').click();
    await page.getByRole('option', { name: pm, exact: true }).click();
    await page.getByTestId('try-data').click();
    await page.getByRole('option', { name: data, exact: true }).click();
    await page.getByTestId('states-try').click();
  };
  const result = page.getByTestId('states-try-result');
  await tryIt('Down', 'Up');
  await expect(result).toContainText('Off wins');
  await expect(result).toContainText('Contradiction – Off, but PowerMeter data is up');
  await expect(result.locator('[data-status="down"]')).toBeVisible();
  // everything agrees → Off
  await tryIt('Down', 'Down');
  await expect(result).toContainText('All checks agree – Off – all checks agree');
  await expect(result.locator('[data-status="off"]')).toBeVisible();

  // change a cell: the data path is not expected any more in Off; saved with the definition
  await page.getByRole('combobox', { name: 'Off – PowerMeter data', exact: true }).click();
  await page.getByRole('option', { name: 'Any', exact: true }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(new RegExp(`/monitors/${id}$`));
  const saved = await json(await api.get(`/api/monitors/${id}`));
  expect(saved.definition.states.cases[1]).toMatchObject({ id: 'off', status: 'off', when: { pm: 'down' } });
  expect(saved.definition.states.cases[1].expect).toBeUndefined();
  await api.delete(`/api/monitors/${id}`);
});
