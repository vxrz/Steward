import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { confirmDialog, json, platformId, uniq, waitForRun } from './support/helpers';

test.use({ storageState: authFile('olivia') });

test('operator creates a schedule, runs it now and deletes it', async ({ page, apiAs }) => {
  const name = uniq('E2E hourly device status');
  await page.goto('/schedules');
  await page.getByRole('button', { name: 'New schedule' }).click();
  const dialog = page.getByRole('dialog', { name: 'New schedule' });

  await dialog.getByRole('combobox', { name: 'Process' }).fill('Device status');
  await page.getByRole('option', { name: 'Industrial Edge – Device status check' }).click();
  // the connection slot appears once the process is loaded
  await dialog.getByRole('combobox', { name: 'Connection "iem"' }).click();
  await page.getByRole('option', { name: 'Industrial Edge Management (demo)' }).click();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await dialog.getByText('Hourly', { exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Cron expression' })).toHaveValue('0 * * * *');
  await expect(dialog.getByRole('combobox', { name: 'Time zone' })).toHaveValue('Europe/Berlin');
  await expect(dialog.getByText(/^Next: /)).toBeVisible();
  // failed checks notify on change by default, with a 4-hour reminder (#127)
  const notify = dialog.getByTestId('notify-policy');
  await expect(notify.getByRole('combobox', { name: 'Failed checks notify' })).toHaveValue('On change (recommended)');
  await notify.getByRole('textbox', { name: 'Reminder while still failing' }).fill('8');
  await notify.getByLabel('Send a message when a check passes again').click();
  // what counts as a change and where the messages go (#139)
  await notify.getByRole('combobox', { name: 'What counts as a change' }).click();
  await page.getByRole('option', { name: 'Only the start and end of failing' }).click();
  await notify.getByText('Only these channels:').click();
  await notify.getByText('E-mail', { exact: true }).click();
  // one catch-up run after a restart when times were missed (off by default)
  const catchUp = dialog.getByRole('switch', { name: 'Catch up after a restart' });
  await expect(catchUp).not.toBeChecked();
  await catchUp.click({ force: true });
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Schedule saved')).toBeVisible();
  const saved = (await (await apiAs('olivia')).get('/api/schedules').then((r) => r.json())) as { name: string; notify: unknown; catchUp: string }[];
  expect(saved.find((x) => x.name === name)?.catchUp).toBe('once');
  expect(saved.find((x) => x.name === name)?.notify).toEqual({
    mode: 'change',
    reminderHours: 8,
    resolved: true,
    change: 'state',
    channels: ['inApp', 'email'],
    pause: null,
    urgent: false,
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
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toContainText(/succeeded|completed with findings/, { timeout: 20_000 });
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

test('the cron preview warns when day of month and day of week are both set, and offers the nth weekday', async ({ page }) => {
  await page.goto('/schedules');
  await page.getByRole('button', { name: 'New schedule' }).click();
  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  const cron = dialog.getByRole('textbox', { name: 'Cron expression' });
  // "the first Monday" written the vixie way runs on days 1–7 and on every Monday
  await cron.fill('0 6 1-7 * 1');
  const warning = dialog.getByTestId('cron-warning');
  await expect(warning).toContainText('either one matches');
  await warning.getByRole('button', { name: /^Use/ }).click();
  await expect(cron).toHaveValue('0 6 * * 1#1');
  await expect(dialog.getByText(/^Next: /)).toBeVisible();
  await expect(warning).toHaveCount(0);
});

test('an unexpected server error shows a reference to quote, not its text', async ({ page, allowConsole }) => {
  allowConsole(/status of 50\d/);
  await page.route('**/api/cron/preview', (route) =>
    route.fulfill({
      status: 500,
      headers: { 'content-type': 'application/json', 'x-request-id': '3f2a9c1e-0000-4000-8000-00000000e2e0' },
      body: JSON.stringify({
        error: 'Internal error (request id 3f2a9c1e-0000-4000-8000-00000000e2e0)',
        code: 'INTERNAL_ERROR',
        params: { requestId: '3f2a9c1e-0000-4000-8000-00000000e2e0' },
      }),
    }),
  );
  await page.goto('/schedules');
  await page.getByRole('button', { name: 'New schedule' }).click();
  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  await dialog.getByRole('textbox', { name: 'Cron expression' }).fill('0 6 * * *');
  await expect(dialog.getByText('Something went wrong (reference 3f2a9c1e-0000-4000-8000-00000000e2e0)', { exact: false })).toBeVisible();

  // a proxy's error page (no JSON) with the request id the proxy passed on
  await page.unroute('**/api/cron/preview');
  await page.route('**/api/cron/preview', (route) =>
    route.fulfill({ status: 502, headers: { 'content-type': 'text/html', 'x-request-id': 'lb-12345' }, body: '<html>Bad gateway</html>' }),
  );
  await dialog.getByRole('textbox', { name: 'Cron expression' }).fill('0 7 * * *');
  await expect(dialog.getByText('Something went wrong (reference lb-12345)', { exact: false })).toBeVisible();
});

test('the time zone is picked from a list, the next runs are shown in it, and a dialog with input asks before closing', async ({ page }) => {
  await page.goto('/schedules');
  await page.getByRole('button', { name: 'New schedule' }).click();
  const dialog = page.getByRole('dialog', { name: 'New schedule' });
  const cron = dialog.getByRole('textbox', { name: 'Cron expression' });
  // the first Tuesday at 06:00 in New York: five runs, each a Tuesday in the first week, 06:00 in that zone's own time
  await cron.fill('0 6 * * 2#1');
  const zone = dialog.getByRole('combobox', { name: 'Time zone' });
  await zone.fill('America/New_Y');
  await page.getByRole('option', { name: 'America/New_York', exact: true }).click();
  const next = dialog.getByTestId('schedule-next-runs');
  await expect(next).toContainText(/06:00|6:00/);
  await expect(next).toContainText(/EST|EDT|GMT-[45]/);
  await expect(next).toHaveText(/^Next: [^·]+( · [^·]+){4}$/);
  await expect(dialog.getByTestId('cron-warning')).toHaveCount(0);
  // the preset for the first Monday
  await dialog.getByText('1st Monday 06:00', { exact: true }).click();
  await expect(cron).toHaveValue('0 6 * * 1#1');
  // something entered: Esc asks first and keeps the input
  await page.keyboard.press('Escape');
  const discard = page.getByRole('dialog', { name: 'Discard your changes?' });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Cancel' }).click();
  await expect(cron).toHaveValue('0 6 * * 1#1');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await discard.getByRole('button', { name: 'Discard' }).click();
  await expect(dialog).toBeHidden();
});

test('the notification policy reads as one sentence, and the messages are paused from the dialog the message links to', async ({ page, apiAs }) => {
  const api = await apiAs('olivia');
  const processes = await json<{ id: string; name: string }[]>(await api.get('/api/processes'));
  const proc = processes.find((p) => p.name === 'Industrial Edge – Device status check')!;
  const iem = await platformId(api, 'industrial-edge-management');
  const name = uniq('E2E policy summary');
  // disabled: it never fires during the other tests
  const s = await json<{ id: string }>(
    await api.post('/api/schedules', { data: { name, processId: proc.id, cron: '0 3 * * *', bindings: { iem }, enabled: false } }),
  );

  // "Message settings for this schedule" in an e-mail or Teams message opens it (?edit=)
  await page.goto(`/schedules?edit=${s.id}`);
  const dialog = page.getByRole('dialog', { name: 'Edit schedule' });
  const notify = dialog.getByTestId('notify-policy');
  const summary = notify.getByTestId('notify-summary');
  await expect(summary).toHaveText('Messages are sent when a check starts failing, when what fails changes and every 4 h while it keeps failing.');
  await expect(summary).toHaveAttribute('aria-live', 'polite');
  await notify.getByLabel('Send a message when a check passes again').click();
  await expect(summary).toContainText('every 4 h while it keeps failing and when the check passes again.');
  await notify.getByRole('textbox', { name: 'Reminder while still failing' }).fill('0');
  await expect(summary).toHaveText('Messages are sent when a check starts failing, when what fails changes and when the check passes again.');
  await notify.getByText('Only these channels:').click();
  await notify.getByText('E-mail', { exact: true }).click();
  await expect(summary).toContainText('Only to: In the app and E-mail.');
  await notify.getByRole('combobox', { name: 'Failed checks notify' }).click();
  await page.getByRole('option', { name: 'Never' }).click();
  await expect(summary).toHaveText('Failed checks send no messages; they are shown in the runs only. Failed runs still notify.');
  await expectAccessible(page, 'schedule dialog with the policy summary');

  // pause right here: stored at once (and audited), not with Save
  const control = notify.getByTestId('pause-control');
  await expect(control).toHaveText('Pause messages');
  await control.click();
  const pause = page.getByRole('dialog', { name: 'Pause messages' });
  // an end in the past is refused at the field
  const end = pause.getByLabel('Ends at');
  await end.fill('2020-01-01T08:00');
  await expect(pause.getByText('Choose a time in the future')).toBeVisible();
  await expect(pause.getByRole('button', { name: 'Pause', exact: true })).toBeDisabled();
  // the usual lengths are one click
  await pause.getByTestId('pause-presets').getByRole('button', { name: '4 hours' }).click();
  await expect(pause.getByText('Choose a time in the future')).toHaveCount(0);
  await expectAccessible(page, 'pause dialog');
  await pause.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(pause).toBeHidden();
  // the focus is back on the control, which now resumes
  await expect(control).toBeFocused();
  await expect(control).toHaveText('Resume messages');
  const stored = await json<{ id: string; notify: { pause: { until: string } | null } }[]>(await api.get('/api/schedules'));
  const until = Date.parse(stored.find((x) => x.id === s.id)!.notify.pause!.until);
  expect(Math.abs(until - (Date.now() + 4 * 3_600_000))).toBeLessThan(5 * 60_000);
  // mode back to "on change": the summary says it is paused
  await notify.getByRole('combobox', { name: 'Failed checks notify' }).click();
  await page.getByRole('option', { name: 'On change (recommended)' }).click();
  await expect(summary).toContainText('Paused until');
  await control.click();
  await expect(control).toHaveText('Pause messages');
  await expect(summary).not.toContainText('Paused');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await confirmDialog(page, 'Discard');

  // in the list: the row's actions are icon buttons named after the schedule
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row.getByRole('button', { name: `Pause messages: ${name}` })).toBeVisible();
  await expect(row.getByRole('button', { name: `Edit ${name}` })).toBeVisible();
  await expect(row.getByRole('button', { name: `Run now: ${name}` })).toBeVisible();
  await api.delete(`/api/schedules/${s.id}`);
});
