import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { json, uniq } from './support/helpers';

/** Creating a dashboard (a dialog that lands in edit mode) and empty widgets that say, by role, what fills them. */

test.use({ storageState: authFile('dana') });

test('"New dashboard" asks for a name and a start, then opens the dashboard in edit mode', async ({ page, apiAs }) => {
  const name = uniq('E2E new dashboard');
  await page.goto('/dashboards');
  await page.getByRole('button', { name: 'New dashboard' }).click();
  const dialog = page.getByRole('dialog', { name: 'New dashboard' });
  // nothing is saved before the dialog is filled in
  await dialog.getByRole('button', { name: 'Create and edit' }).click();
  await expect(dialog.getByText('Required')).toBeVisible();
  await expectAccessible(page, 'new dashboard dialog');
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name);
  await dialog.getByRole('button', { name: 'Create and edit' }).click();
  await expect(page).toHaveURL(/\/dashboards\/[^/?]+$/);
  const id = page.url().split('/').pop()!;
  try {
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    // edit mode, and the empty state points at the button above – not at "Edit"
    await expect(page.getByRole('button', { name: 'Add widget' })).toBeVisible();
    await expect(page.getByTestId('dashboard-empty')).toContainText('Add the first one with “Add widget” above.');
    await expect(page.getByTestId('dashboard-empty')).not.toContainText('Click Edit');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('dashboard-empty')).toContainText('Click Edit');
  } finally {
    await (await apiAs('admin')).delete(`/api/dashboards/${id}`);
  }
});

test('an empty widget names the process that fills it: links for designers, plain words for others', async ({ page, apiAs, loginAs }) => {
  const admin = await apiAs('admin');
  const key = `e2e.empty${Date.now().toString(36)}`;
  const processName = uniq('E2E privileged review');
  const proc = await json(
    await admin.post('/api/processes', {
      data: {
        definition: {
          name: processName,
          nodes: [
            { id: 'start', type: 'start', x: 0, y: 0 },
            { id: 'pub', type: 'publish', x: 0, y: 0, dataset: key, rows: '[]' },
          ],
          wires: [{ from: 'start', port: 'out', to: 'pub' }],
        },
      },
    }),
  );
  const dash = await json(
    await admin.post('/api/dashboards', {
      data: { definition: { name: uniq('E2E empty widget'), widgets: [{ id: 'k', type: 'kpi', title: 'Privileged assignments', dataset: key }] } },
    }),
  );
  try {
    await page.goto(`/dashboards/${dash.id}`);
    await settle(page);
    const empty = page.getByRole('region', { name: 'Privileged assignments', exact: true }).getByTestId('widget-no-data');
    await expect(empty).toContainText(`run or schedule ${processName}`);
    await expect(empty.getByRole('link', { name: 'Open the process' })).toHaveAttribute('href', new RegExp(`/processes/${proc.id}$`));
    await expect(empty.getByRole('link', { name: 'Schedule it' })).toHaveAttribute('href', /\/schedules\?new=1&processId=/);
    await expect(empty).toContainText(`Dataset ${key}`);

    // an auditor reads it, but neither runs nor edits it: plain words, no dataset key
    const audrey = await loginAs('audrey');
    await audrey.goto(`/dashboards/${dash.id}`);
    const forAudrey = audrey.getByRole('region', { name: 'Privileged assignments', exact: true }).getByTestId('widget-no-data');
    await expect(forAudrey).toHaveText(`No data yet – ask a designer to schedule ${processName}.`);
    await expectAccessible(audrey, 'empty widget for a reader');
  } finally {
    await admin.delete(`/api/dashboards/${dash.id}`);
    await admin.delete(`/api/processes/${proc.id}`);
  }
});
