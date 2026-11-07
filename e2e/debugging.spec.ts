import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll, json, uniq, waitForRun } from './support/helpers';
import type { APIRequestContext } from '@playwright/test';

/**
 * Debugging procedures (ADR 0010): run one node in the editor, step through a run in the debug panel, compare two
 * runs. Debug runs are never live and stay out of run lists unless the Debug filter is on.
 */

test.use({ storageState: authFile('admin') });

const n = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, x: 0, y: id === 'start' ? 0 : 0, ...extra });
const w = (from: string, to: string, port = 'out') => ({ from, port, to });

async function createProcess(api: APIRequestContext, name: string) {
  return json<{ id: string }>(
    await api.post('/api/processes', {
      data: {
        definition: {
          name,
          connections: [],
          inputs: [{ name: 'mode', type: 'string', default: 'ok' }],
          nodes: [
            n('start', 'start', { x: 0, y: 0 }),
            n('calc', 'set', { name: 'Double it', x: 0, y: 120, values: { double: '{{ vars.n * 2 }}', mode: '{{ inputs.mode }}' } }),
            n('ask', 'userTask', { name: 'Go on?', x: 0, y: 240, mode: 'approve', title: 'Go on?' }),
            n('branch', 'if', { name: 'Mode ok', x: 0, y: 360, condition: 'inputs.mode = "ok"' }),
            n('fine', 'log', { name: 'Fine', x: -150, y: 480, message: 'fine' }),
            n('boom', 'fail', { name: 'Boom', x: 150, y: 480, message: 'boom' }),
          ],
          wires: [w('start', 'calc'), w('calc', 'branch'), w('branch', 'fine', 'true'), w('branch', 'boom', 'false')],
        },
      },
    }),
  );
}

test('run one node in the editor, then step through a run with a simulated decision', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const name = uniq('E2E debug');
  const proc = await createProcess(api, name);
  // the step-through part needs the decision on the path
  await api.put(`/api/processes/${proc.id}`, {
    data: {
      definition: {
        ...(await json<{ definition: Record<string, unknown> }>(await api.get(`/api/processes/${proc.id}`))).definition,
        wires: [w('start', 'calc'), w('calc', 'ask'), w('ask', 'branch', 'approved'), w('branch', 'fine', 'true'), w('branch', 'boom', 'false')],
      },
    },
  });
  try {
    await page.goto(`/processes/${proc.id}`);
    const nodes = page.locator('.react-flow__node');
    await nodes.filter({ hasText: 'Double it' }).first().click();
    await page.getByTestId('tab-run-node').click();
    const panel = page.getByTestId('node-debug');
    await expect(panel.getByRole('radio', { name: 'Offline' })).toBeChecked();
    await panel.getByRole('textbox', { name: 'Variables (JSON)' }).fill('{ "n": 21 }');
    await panel.getByRole('button', { name: 'Run this node' }).click();
    const result = page.getByTestId('debug-node-result');
    await expect(result).toContainText(/succeeded/i);
    await expect(result).toContainText('"double": 42');
    // a value that looks like a password is refused
    await panel.getByRole('textbox', { name: 'Variables (JSON)' }).fill('{ "password": "Summer2024!x" }');
    await panel.getByRole('button', { name: 'Run this node' }).click();
    await expect(page.getByText(/looks like a credential/)).toBeVisible();
    await expectAccessible(page, 'run this node');

    // step through
    await page.getByTestId('open-debug').click();
    const drawer = page.getByRole('dialog', { name: 'Step through' });
    await expect(drawer.getByRole('switch', { name: 'Pause before each node' })).toBeChecked();
    await expectAccessible(page, 'debug panel start');
    await drawer.getByTestId('debug-start').click();
    const pause = drawer.getByTestId('debug-pause');
    await expect(pause).toContainText('Paused before Double it');
    await expect(pause).toContainText('left');
    await expectAccessible(page, 'debug panel paused');
    await drawer.getByTestId('debug-step').click();
    await expect(pause).toContainText('Waits for your answer: Go on?');
    await drawer.getByTestId('debug-answer').click();
    await expect(drawer.getByTestId('debug-recorded-from')).toContainText('ask');
    await expect(pause).toContainText('Paused before Mode ok');
    await drawer.getByTestId('debug-continue').click();
    await expect(drawer.getByText('Debug run succeeded')).toBeVisible();
    await expect(drawer.getByText('Simulated').first()).toBeVisible();
    await drawer.getByRole('link', { name: 'Open the run' }).click();
    await expect(page.getByTestId('debug-badge')).toHaveText('Debug run');
    await expect(page.getByTestId('debug-run-note')).toContainText('published nothing');
    await expect(page.getByTestId('step-simulated')).toBeVisible();
    await expectAccessible(page, 'debug run page');

    // run lists leave debug runs out unless the Debug filter is on
    await page.goto(`/runs?debug=1`);
    await expect(page.getByTestId('run-list')).toContainText(name);
  } finally {
    await api.delete(`/api/processes/${proc.id}`);
  }
});

test('compare a failed run with the last good run', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const proc = await createProcess(api, uniq('E2E compare'));
  try {
    const start = async (mode: string) => {
      const r = await json<{ id: string }>(await api.post('/api/runs', { data: { processId: proc.id, inputs: { mode }, dryRun: true } }));
      return (await waitForRun(api, r.id, ['succeeded', 'failed'])).id as string;
    };
    await start('ok');
    const bad = await start('bad');
    await page.goto(`/runs/${bad}`);
    await page.getByTestId('compare-last-good').click();
    await expect(page.getByRole('heading', { name: 'Compare runs' })).toBeVisible();
    await expect(page.getByTestId('compare-summary')).toContainText('only in A');
    const table = page.getByTestId('compare-table');
    await expect(table).toContainText('Fine');
    await expect(table).toContainText('Boom');
    await expect(table).toContainText('Path');
    await expect(table).toContainText('Decision');
    await expectAccessible(page, 'compare runs');
    // all steps, also the equal ones
    await page.getByRole('switch', { name: 'Only differences' }).click();
    await expect(table).toContainText('Double it');
    await page.getByRole('button', { name: 'Swap A and B' }).click();
    await expect(page).toHaveURL(new RegExp(`a=${bad}`));
  } finally {
    await api.delete(`/api/processes/${proc.id}`);
  }
});

test('compare and the debug panel on a phone @mobile', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const proc = await createProcess(api, uniq('E2E compare phone'));
  try {
    const ids: string[] = [];
    for (const mode of ['ok', 'bad']) {
      const r = await json<{ id: string }>(await api.post('/api/runs', { data: { processId: proc.id, inputs: { mode }, dryRun: true } }));
      ids.push((await waitForRun(api, r.id, ['succeeded', 'failed'])).id);
    }
    await page.goto(`/runs/compare?a=${ids[0]}&b=${ids[1]}`);
    const cards = page.getByTestId('compare-cards');
    await expect(cards).toContainText('Boom');
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'compare runs (phone)');

    await page.goto(`/processes/${proc.id}`);
    await page.getByTestId('open-debug').click();
    const drawer = page.getByRole('dialog', { name: 'Step through' });
    await drawer.getByTestId('debug-start').click();
    await expect(drawer.getByTestId('debug-pause')).toContainText('Paused before Double it');
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'debug panel (phone)');
    await drawer.getByTestId('debug-stop').click();
    await expect(drawer.getByText('Debug run stopped')).toBeVisible();
  } finally {
    await api.delete(`/api/processes/${proc.id}`);
  }
});
