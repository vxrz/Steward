import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { confirmDialog, uniq, waitForRun } from './support/helpers';

test.use({ storageState: authFile('olivia') });

test('operator creates a schedule, runs it now and deletes it', async ({ page, apiAs }) => {
  const name = uniq('E2E hourly device status');
  await page.goto('/schedules');
  await page.getByRole('button', { name: 'New schedule' }).click();
  const dialog = page.getByRole('dialog', { name: 'New schedule' });

  await dialog.getByRole('textbox', { name: 'Process' }).fill('Device status');
  await page.getByRole('option', { name: 'Industrial Edge – Device status check' }).click();
  // the connection slot appears once the process is loaded
  await dialog.getByRole('textbox', { name: 'Connection "iem"' }).click();
  await page.getByRole('option', { name: 'Industrial Edge Management (demo)' }).click();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await dialog.getByText('Hourly', { exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Cron expression' })).toHaveValue('0 * * * *');
  await expect(dialog.getByRole('textbox', { name: 'Time zone' })).toHaveValue('Europe/Berlin');
  await expect(dialog.getByText(/^Next: /)).toBeVisible();
  // failed checks notify on change by default, with a 4-hour reminder (#127)
  const notify = dialog.getByTestId('notify-policy');
  await expect(notify.getByRole('textbox', { name: 'Failed checks notify' })).toHaveValue('On change (recommended)');
  await notify.getByRole('textbox', { name: 'Reminder while still failing' }).fill('8');
  await notify.getByText('Send a message when a check passes again').click();
  // what counts as a change and where the messages go (#139)
  await notify.getByRole('textbox', { name: 'What counts as a change' }).click();
  await page.getByRole('option', { name: 'Only the start and end of failing' }).click();
  await notify.getByText('Only these channels:').click();
  await notify.getByText('E-mail', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Schedule saved')).toBeVisible();
  const saved = (await (await apiAs('olivia')).get('/api/schedules').then((r) => r.json())) as { name: string; notify: unknown }[];
  expect(saved.find((x) => x.name === name)?.notify).toEqual({
    mode: 'change',
    reminderHours: 8,
    resolved: true,
    change: 'state',
    channels: ['inApp', 'email'],
    pause: null,
  });

  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('0 * * * *');
  await expect(row).toContainText('Hourly Europe/Berlin');
  await expect(row).toContainText('runs as olivia');
  await expect(row.getByRole('switch', { name: 'Enabled' })).toBeChecked();

  // pause the messages with a reason; the row shows it until resumed
  await row.getByRole('button', { name: 'Pause messages' }).click();
  const pause = page.getByRole('dialog', { name: 'Pause messages' });
  await pause.getByText('Until resumed').click();
  await pause.getByLabel('Reason (shown on the badge and in the audit log)').fill('Gatus maintenance');
  await pause.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(row.getByTestId('pause-badge')).toHaveText('Messages paused');
  await row.getByRole('button', { name: 'Resume messages' }).click();
  await expect(row.getByTestId('pause-badge')).toHaveCount(0);

  // run now → run page → succeeds
  await row.getByRole('button', { name: 'Run now' }).click();
  await expect(page).toHaveURL(/\/runs\/[^/]+$/);
  const runId = page.url().split('/').pop()!;
  await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toContainText('succeeded', { timeout: 20_000 });
  const run = await waitForRun(await apiAs('olivia'), runId, ['succeeded']);
  expect(run.actor).toBe('olivia');

  // clean up so the schedule never fires during later tests
  await page.goto('/schedules');
  await page.getByRole('row').filter({ hasText: name }).getByRole('button', { name: 'Delete' }).click();
  await confirmDialog(page, 'Delete', { message: name });
  await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(0);
});

test('an invalid cron expression is explained', async ({ page }) => {
  await page.goto('/schedules');
  await page.getByRole('button', { name: 'New schedule' }).click();
  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  await dialog.getByRole('textbox', { name: 'Cron expression' }).fill('61 * * * *');
  await expect(dialog.getByText(/^Next: /)).toBeHidden();
  await expect(dialog.getByRole('textbox', { name: 'Cron expression' })).toHaveAttribute('aria-invalid', 'true');
});
