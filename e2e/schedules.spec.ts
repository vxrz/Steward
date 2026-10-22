import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { uniq, waitForRun } from './support/helpers';

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
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Schedule saved')).toBeVisible();

  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('0 * * * *');
  await expect(row).toContainText('Hourly Europe/Berlin');
  await expect(row).toContainText('runs as olivia');
  await expect(row.getByRole('switch', { name: 'Enabled' })).toBeChecked();

  // run now → run page → succeeds
  await row.getByRole('button', { name: 'Run now' }).click();
  await expect(page).toHaveURL(/\/runs\/[^/]+$/);
  const runId = page.url().split('/').pop()!;
  await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toContainText('succeeded', { timeout: 20_000 });
  const run = await waitForRun(await apiAs('olivia'), runId, ['succeeded']);
  expect(run.actor).toBe('olivia');

  // clean up so the schedule never fires during later tests
  await page.goto('/schedules');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('row').filter({ hasText: name }).getByRole('button', { name: 'Delete' }).click();
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
