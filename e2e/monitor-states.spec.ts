import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll, json, uniq } from './support/helpers';

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
  await expect(page.getByRole('combobox', { name: 'Off – PowerMeter data', exact: true })).toHaveValue('Down · expected');
  // the choices of a cell are grouped by what they do; the legend under the table explains them and where Off comes from
  await page.getByRole('combobox', { name: 'Running – PowerMeter data', exact: true }).click();
  const listbox = page.getByRole('listbox');
  for (const group of ['Selects this state', 'Expected in this state', 'Precondition']) await expect(listbox.getByText(group, { exact: true })).toBeVisible();
  for (const option of ['Any', 'Up · selects', 'Down · selects', 'Up · expected', 'Down · expected', 'Required'])
    await expect(listbox.getByRole('option', { name: option, exact: true })).toBeVisible();
  // Off only for sub-monitor columns
  await expect(listbox.getByRole('option', { name: 'Off · expected', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const legend = page.getByTestId('states-legend');
  await expect(legend).toContainText('Off is offered only in sub-monitor columns');
  await expect(legend).toContainText('The Shows column decides whether a state shows as grey Off.');
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
  // On contradiction: Running only degrades the monitor
  const onContradiction = page.getByRole('combobox', { name: 'Running on contradiction', exact: true });
  await expect(onContradiction).toHaveValue('Down (default)');
  await onContradiction.click();
  await page.getByRole('option', { name: 'Degraded', exact: true }).click();
  await expect(page.getByTestId('states-legend')).toContainText('a check without “Critical”');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL((url) => url.pathname.endsWith(`/monitors/${id}`));
  const saved = await json(await api.get(`/api/monitors/${id}`));
  expect(saved.definition.states.cases[1]).toMatchObject({ id: 'off', status: 'off', when: { pm: 'down' } });
  expect(saved.definition.states.cases[1].expect).toBeUndefined();
  expect(saved.definition.states.cases[0]).toMatchObject({ id: 'running', contradiction: 'degraded' });
  expect(saved.definition.states.cases[1].contradiction).toBeUndefined();
  await api.delete(`/api/monitors/${id}`);
});

test('off beyond the maximum: degraded or down, per monitor and per off row, and "Try it" shows it (#288)', async ({ page, apiAs }) => {
  const api = await apiAs('dana');
  const created = await json(
    await api.post('/api/monitors', {
      data: {
        definition: {
          name: uniq('E2E max off'),
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
  const monitorChoice = page.getByRole('combobox', { name: 'Off for longer than the maximum', exact: true });
  await expect(monitorChoice).toHaveValue('Degraded (default)');
  const rowChoice = page.getByRole('combobox', { name: 'Off: off for longer than the maximum', exact: true });
  await expect(rowChoice).toHaveValue('As the monitor (Degraded)');
  // a Running row has no maximum off time
  await expect(page.getByTestId('after-max-off-running')).toHaveCount(0);
  await expect(page.getByTestId('states-legend')).toContainText('Down (an outage, counted as unavailable)');

  // Try it: off for longer than the maximum – degraded by default
  const tryOff = async () => {
    for (const c of ['pm', 'data']) {
      await page.getByTestId(`try-${c}`).click();
      await page.getByRole('option', { name: 'Down', exact: true }).click();
    }
    await page.getByTestId('states-try').click();
  };
  const result = page.getByTestId('states-try-result');
  await tryOff();
  await expect(result.locator('[data-status="off"]')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Off for longer than the maximum' }).check();
  await page.getByTestId('states-try').click();
  await expect(result).toContainText('Off for longer than expected – Off for longer than expected (8 h, maximum 8 h)');
  await expect(result.locator('[data-status="degraded"]')).toBeVisible();

  // the monitor: down – an outage; the row follows it
  await monitorChoice.click();
  await page.getByRole('option', { name: 'Down – an outage', exact: true }).click();
  await expect(rowChoice).toHaveValue('As the monitor (Down – an outage)');
  await page.getByTestId('states-try').click();
  await expect(result.locator('[data-status="down"]')).toBeVisible();
  // the row overrides it back to degraded
  await rowChoice.click();
  await page.getByRole('option', { name: 'Degraded', exact: true }).click();
  await page.getByTestId('states-try').click();
  await expect(result.locator('[data-status="degraded"]')).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL((url) => url.pathname.endsWith(`/monitors/${id}`));
  const saved = await json(await api.get(`/api/monitors/${id}`));
  expect(saved.definition.states.afterMaxOff).toBe('down');
  expect(saved.definition.states.cases[1].afterMaxOff).toBe('degraded');
  expect(saved.definition.states.cases[0].afterMaxOff).toBeUndefined();
  await api.delete(`/api/monitors/${id}`);
});

test('settling: the header says until when and how many checks are not as expected yet; their cards are amber, not red', async ({ page, apiAs }) => {
  const api = await apiAs('dana');
  const created = await json(
    await api.post('/api/monitors', {
      data: {
        definition: {
          name: uniq('E2E settling'),
          failuresBeforeDown: 1,
          successesBeforeUp: 1,
          checks: [
            { id: 'pm', name: 'PowerMeter reachable', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 3600, x: 0, y: 0 },
            { id: 'data', name: 'PowerMeter data', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 3600, x: 0, y: 160 },
          ],
          states: {
            cases: [
              { id: 'running', name: 'Running', when: { pm: 'up' }, expect: { data: 'up' }, settleSeconds: 3600 },
              { id: 'off', name: 'Off', status: 'off', when: { pm: 'down' }, expect: { data: 'down' } },
            ],
          },
        },
      },
    }),
  );
  const id = created.monitor.id as string;
  const secrets = new Map((created.secrets as { checkId: string; secret: string }[]).map((x) => [x.checkId, x.secret]));
  const detail = await json(await api.get(`/api/monitors/${id}`));
  const pathOf = (checkId: string) => detail.checks.find((c: { checkId: string }) => c.checkId === checkId).heartbeat.path as string;
  const report = async (checkId: string, status: string) =>
    expect((await api.post(pathOf(checkId), { data: { status }, headers: { authorization: `Bearer ${secrets.get(checkId)}` } })).ok()).toBe(true);
  const evaluate = async (state: string) => {
    await expect
      .poll(async () => {
        await api.post(`/api/monitors/${id}/run`);
        return (await json(await api.get(`/api/monitors/${id}`))).state?.id;
      })
      .toBe(state);
  };
  // the machine is off (the first state is taken as it is), then switched on: its data has not arrived yet
  await report('pm', 'down');
  await report('data', 'down');
  await evaluate('off');
  await report('pm', 'up');
  await evaluate('running');
  await page.goto(`/monitors/${id}`);
  const note = page.getByTestId('monitor-settling');
  await expect(note).toBeVisible();
  await expect(note).toContainText('settling until');
  await expect(note).toContainText('1 check not as expected yet');
  // the status stays as computed: up
  await expect(page.getByRole('heading', { level: 1 }).locator('[data-status="up"]')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 }).getByTestId('monitor-settling')).toBeVisible();
  // the deviating card is marked settling (amber), the other one is not
  await expect(page.getByTestId('monitor-node-data')).toHaveAttribute('data-settling', 'true');
  await expect(page.getByTestId('monitor-node-data')).toContainText('Settling – not counted yet');
  await expect(page.getByTestId('monitor-node-pm')).not.toHaveAttribute('data-settling', 'true');
  await expect(page.getByTestId('why-this-state').getByTestId('state-cell-data')).toHaveAttribute('data-verdict', 'settling');
  await expect(page.getByRole('table', { name: 'Checks' }).getByTestId('check-settling')).toHaveCount(1);
  await settle(page);
  await expectAccessible(page, 'a monitor that settles');
  await api.delete(`/api/monitors/${id}`);
});

/** A monitor with two states for the editor tests (heartbeats: nothing reports, so the checks are unknown). */
async function statesMonitor(api: APIRequestContext) {
  const created = await json(
    await api.post('/api/monitors', {
      data: {
        definition: {
          name: uniq('E2E states a11y'),
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
  return created.monitor.id as string;
}

test('accessibility: the Off banner, "Why this state" and the States tab pass axe', async ({ page, apiAs }) => {
  const api = await apiAs('dana');
  await page.goto(`/monitors/${await monitorByKey(api, 'lathe-5-powermeter')}`);
  await expect(page.getByTestId('monitor-off-banner')).toBeVisible();
  await expect(page.getByTestId('why-this-state')).toBeVisible();
  await settle(page);
  await expectAccessible(page, 'monitor that is off');
  await page.goto(`/monitors/${await monitorByKey(api, 'mill-6-powermeter')}`);
  await expect(page.getByTestId('monitor-contradiction')).toBeVisible();
  await settle(page);
  await expectAccessible(page, 'monitor with a contradiction');
  const id = await statesMonitor(api);
  await page.goto(`/monitors/${id}/edit`);
  await settle(page);
  await page.getByRole('tab', { name: 'States' }).click();
  await expect(page.getByTestId('states-table')).toBeVisible();
  await page.getByTestId('states-try').click();
  await expect(page.getByTestId('states-try-result')).not.toBeEmpty();
  await expectAccessible(page, 'the States tab');
  await api.delete(`/api/monitors/${id}`);
});

test('keyboard only: add, move and remove states, Try it, and the checks of "Why this state"', async ({ page, apiAs }) => {
  const api = await apiAs('dana');
  const id = await statesMonitor(api);
  await page.goto(`/monitors/${id}/edit`);
  await settle(page);
  await page.getByRole('tab', { name: 'States' }).focus();
  await page.keyboard.press('Enter');
  const table = page.getByTestId('states-table');
  await expect(table).toBeVisible();
  const order = () => table.locator('[data-testid^="state-row-"]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-testid')));
  // move Off up: it becomes the first row
  await page.getByRole('button', { name: 'Move Off up' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(order).toEqual(['state-row-off', 'state-row-running']);
  await page.getByRole('button', { name: 'Move Off down' }).focus();
  await page.keyboard.press('Space');
  await expect.poll(order).toEqual(['state-row-running', 'state-row-off']);
  // add a state, then remove it
  await page.getByRole('button', { name: 'State', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(order).toEqual(['state-row-running', 'state-row-off', 'state-row-state-3']);
  await page.getByRole('button', { name: 'Remove state-3' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(order).toEqual(['state-row-running', 'state-row-off']);
  // a cell by keyboard: open, choose, confirm
  const cell = page.getByRole('combobox', { name: 'Off – PowerMeter data', exact: true });
  await cell.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'Up · expected', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(cell).toHaveValue('Down · expected');
  // Try it by keyboard: the checks are unknown (nothing reports), PowerMeter set to Down
  const pm = page.getByTestId('try-pm');
  await pm.focus();
  await page.keyboard.press('ArrowDown');
  await page.getByRole('option', { name: 'Down', exact: true }).waitFor();
  for (let i = 0; i < 4 && (await page.getByRole('option', { name: 'Down', exact: true }).getAttribute('data-combobox-selected')) === null; i++)
    await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(pm).toHaveValue('Down');
  await page.getByTestId('states-try').focus();
  await page.keyboard.press('Enter');
  // nothing about the data path is known: Off holds, but none of its expected checks could be checked
  await expect(page.getByTestId('states-try-result')).toContainText('Off wins');
  await expect(page.getByTestId('states-try-result')).toContainText('Not known');
  await api.delete(`/api/monitors/${id}`);

  // "Why this state": a check opens its panel from the keyboard
  await page.goto(`/monitors/${await monitorByKey(api, 'lathe-5-powermeter')}`);
  const why = page.getByTestId('why-this-state');
  await why.getByRole('button', { name: 'PowerMeter data reported by the gateway' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/check=pm-data/);
  await expect(page.getByTestId('check-panel')).toBeVisible();
});

test('phones: the decision table becomes one card per state; no horizontal page scroll', async ({ page, apiAs }) => {
  const api = await apiAs('dana');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/monitors/${await monitorByKey(api, 'lathe-5-powermeter')}`);
  await expect(page.getByTestId('monitor-off-banner')).toBeVisible();
  await expect(page.getByTestId('why-this-state')).toBeVisible();
  await expectNoHorizontalScroll(page);
  const id = await statesMonitor(api);
  await page.goto(`/monitors/${id}/edit`);
  await page.getByRole('tab', { name: 'States' }).click();
  const cards = page.getByTestId('states-cards');
  await expect(cards).toBeVisible();
  await expect(page.getByTestId('states-table')).toHaveCount(0);
  await expect(cards.getByTestId('state-card-off')).toBeVisible();
  // the same controls: a labelled select per check, move and remove
  await expect(cards.getByRole('combobox', { name: 'Off – PowerMeter reachable', exact: true })).toHaveValue('Down · selects');
  await cards.getByRole('button', { name: 'Move Off up' }).click();
  await expect(cards.locator('[data-testid^="state-card-"]').first()).toHaveAttribute('data-testid', 'state-card-off');
  await expectNoHorizontalScroll(page);
  await api.delete(`/api/monitors/${id}`);
});
