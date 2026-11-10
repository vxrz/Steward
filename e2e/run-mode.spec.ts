import { test, expect } from './support/fixtures';
import { PROCESS, authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { chooseRunMode } from './support/helpers';

/** One choice of run mode (#137): dry run, test run or run, with the description and the start button of the mode. */

test.use({ storageState: authFile('admin') });

test('the run dialog offers one run mode: dry run, test run or run', async ({ page }) => {
  await page.goto(`/processes/${PROCESS.accessReview1}`);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^Run: / });
  const mode = dialog.getByTestId('run-mode');
  const description = dialog.getByTestId('run-mode-description');

  // dry run by default
  await expect(dialog.getByRole('radiogroup', { name: 'Run mode' })).toBeVisible();
  await expect(mode.getByRole('radio', { name: 'Dry run' })).toBeChecked();
  await expect(description).toContainText('write calls (POST/PUT/PATCH/DELETE) are only recorded');
  await expect(dialog.getByRole('button', { name: 'Start dry run' })).toBeVisible();
  await expect(dialog.getByText('This run will change data')).toHaveCount(0);

  // keyboard: the arrow key moves to the test run
  await mode.getByRole('radio', { name: 'Dry run' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(mode.getByRole('radio', { name: 'Test run' })).toBeChecked();
  await expect(description).toContainText('answered by the recorded responses');
  await expect(dialog.getByRole('button', { name: 'Start test run' })).toBeVisible();

  // a run executes writes: the warning and the start button say so
  await chooseRunMode(dialog, 'Run');
  await expect(description).toContainText('including writes');
  await expect(dialog.getByText('This run will change data')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Start run' })).toBeVisible();
  await expectAccessible(page, 'run dialog');

  await chooseRunMode(dialog, 'Dry run');
  await expect(dialog.getByText('This run will change data')).toHaveCount(0);
});

test('schedules choose between dry run and run (no test run)', async ({ page }) => {
  await page.goto('/schedules');
  await page.getByRole('button', { name: 'New schedule' }).click();
  const dialog = page.getByRole('dialog');
  const mode = dialog.getByTestId('run-mode');
  await expect(mode.getByRole('radio')).toHaveCount(2);
  await expect(mode.getByRole('radio', { name: 'Test run' })).toHaveCount(0);
  await chooseRunMode(dialog, 'Dry run');
  await chooseRunMode(dialog, 'Run');
});

test('a CSV table input: the run dialog counts the rows it reads, with or without a header row', async ({ page }) => {
  await page.goto('/processes/ih-onboard-users');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^Run: / });
  const csv = dialog.getByRole('textbox', { name: 'Users (CSV)' });
  const rows = dialog.getByTestId('table-input-rows');
  // the default: a header row and one user
  await expect(rows).toHaveText('1 row read');
  await csv.fill('first.user@example.com,First,User\nsecond.user@example.com,Second,User');
  await expect(rows).toHaveText('2 rows read – no header row, read by the column order');
  await csv.fill('email,givenName,familyName,bundle\n');
  await expect(rows).toHaveText('No rows read – the first line is the header row');
});
