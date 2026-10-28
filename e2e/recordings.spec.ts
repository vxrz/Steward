import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { json, platformId, uniq, waitForRun } from './support/helpers';

test.use({ storageState: authFile('admin') });

const PATH = '/api/identitymanagement/v3/Groups';

/**
 * Recorded responses (#105): record an answer in the API explorer, see it under Recorded responses, and run a
 * process as a test run that uses it.
 */
test('a response recorded in the explorer answers a test run', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const hub = await platformId(api, 'insights-hub');
  const name = uniq('E2E test run');
  const proc = await json<{ id: string }>(
    await api.post('/api/processes', {
      data: {
        definition: {
          name,
          connections: [{ slot: 'ih' }],
          inputs: [],
          nodes: [
            { id: 'start', type: 'start', x: 0, y: 0 },
            { id: 'groups', type: 'http', x: 0, y: 0, connection: 'ih', method: 'GET', path: PATH, query: { count: '1' }, saveAs: 'groups' },
          ],
          wires: [{ from: 'start', port: 'out', to: 'groups' }],
        },
      },
    }),
  );
  try {
    await page.goto(`/platforms/${hub}`);
    await page.getByRole('tab', { name: 'Explorer' }).click();
    await page.getByRole('textbox', { name: 'Path (relative to base URL)' }).fill(`${PATH}?count=1`);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('HTTP 200', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save as recorded response' }).click();
    const dialog = page.getByRole('dialog', { name: 'Record a response of Insights Hub (demo)' });
    await expect(dialog.getByRole('textbox', { name: 'Path' })).toHaveValue(PATH);
    await expect(dialog.getByRole('textbox', { name: 'Query parameters to match' })).toHaveValue('count=1');
    await expectAccessible(page, 'recording dialog');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Recorded response saved')).toBeVisible();

    await page.getByRole('tab', { name: 'Recorded responses' }).click();
    const list = page.getByTestId('platform-recordings');
    await expect(list.getByRole('row', { name: new RegExp(`GET\\s*${PATH.replace(/\//g, '\\/')}\\?count=1`) })).toContainText('HTTP 200');
    await expectAccessible(page, 'recorded responses');

    // a test run of the process answers the call from the recording
    await page.goto(`/processes/${proc.id}`);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const run = page.getByRole('dialog', { name: /^Run: / });
    const slot = run.getByRole('textbox', { name: /^Connection "/ }).first();
    if (!(await slot.inputValue())) {
      await slot.click();
      await page.getByRole('option', { name: /Insights Hub \(demo\)/ }).click();
    }
    await expect(run.getByRole('switch', { name: /Dry run/ })).toBeChecked();
    await run.getByText('Use recorded responses (test run)').click();
    await run.getByRole('button', { name: 'Start test run' }).click();
    await expect(page).toHaveURL(/\/runs\/[^/]+$/);
    const runId = page.url().split('/').pop()!;
    const r = await waitForRun(api, runId, ['succeeded']);
    expect(r).toMatchObject({ dryRun: true, recorded: true });
    await expect(page.getByText('Test run (recorded responses)')).toBeVisible();
  } finally {
    const recs = await json<{ id: string; path: string }[]>(await api.get(`/api/platforms/${hub}/recordings`));
    for (const x of recs.filter((x) => x.path === PATH)) await api.delete(`/api/platforms/${hub}/recordings/${x.id}`);
    await api.delete(`/api/processes/${proc.id}`);
  }
});
