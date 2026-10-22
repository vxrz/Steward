import { test, expect, sessionHeaders } from './support/fixtures';
import { authFile } from './support/env';

test.use({ storageState: authFile('admin') });

test('settings: notification routing, retention, maintenance status', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible();

  // notification routing table
  const routing = page.getByRole('table').filter({ hasText: 'task.assigned' });
  await expect(routing.getByText('Event', { exact: true })).toBeVisible();
  for (const ev of ['task.assigned', 'run.failed', 'check.failed', 'dataset.stale', 'schedule.skipped']) {
    await expect(routing.getByText(ev, { exact: true })).toBeVisible();
  }
  await expect(routing.getByRole('checkbox', { name: /^task\.assigned: / }).first()).toBeVisible();

  // maintenance status
  for (const label of ['Database', 'Evidence files', 'Runs', 'Audit entries', 'Last cleanup']) {
    await expect(page.getByRole('main').getByText(label, { exact: true })).toBeVisible();
  }
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Clean up now' }).click();
  await expect(page.getByText('Cleanup finished')).toBeVisible();

  // retention: save, reload, restore
  const keepRuns = page.getByRole('textbox', { name: 'Keep runs (days)' });
  await keepRuns.fill('400');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  await page.reload();
  await expect(keepRuns).toHaveValue('400');
  await keepRuns.fill('0');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Settings saved').first()).toBeVisible();
});

test('settings: allowed e-mail domains for addresses outside Steward', async ({ page }) => {
  await page.goto('/settings');
  const domains = page.getByRole('textbox', { name: 'Allowed e-mail domains for addresses outside Steward' });
  await expect(domains).toBeVisible();
  await domains.fill('Example.com');
  await domains.press('Enter');
  await domains.fill('*.partner.example');
  await domains.press('Enter');
  await page.getByRole('button', { name: 'Save notification settings' }).click();
  await expect(page.getByText('Notification settings saved')).toBeVisible();
  await page.reload();
  const card = page.getByRole('main');
  await expect(card.getByText('*.partner.example', { exact: true })).toBeVisible();
  await expect(card.getByText('example.com', { exact: true })).toBeVisible();
  // back to the default (the domains of the users' own addresses)
  await page.getByRole('textbox', { name: 'Allowed e-mail domains for addresses outside Steward' }).focus();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.getByRole('button', { name: 'Save notification settings' }).click();
  await expect(page.getByText('Notification settings saved').first()).toBeVisible();
});

test('readiness and metrics endpoints', async ({ request }) => {
  const ready = await request.get('/api/ready');
  expect(ready.status()).toBe(200);
  const metrics = await request.get('/api/metrics', { headers: sessionHeaders('admin') });
  expect(metrics.status()).toBe(200);
  expect(await metrics.text()).toContain('# HELP');
});
