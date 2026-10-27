import { test, expect, sessionHeaders } from './support/fixtures';
import { authFile } from './support/env';
import { confirmDialog } from './support/helpers';

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
  await page.getByRole('button', { name: 'Clean up now' }).click();
  await confirmDialog(page, 'Delete now', { title: 'Delete old data' });
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

test('settings: look of e-mails and Teams messages, with a preview', async ({ page }) => {
  await page.goto('/settings');
  const card = page.locator('.mantine-Card-root').filter({ has: page.getByRole('heading', { name: 'Look of e-mails and Teams messages' }) });
  await expect(card).toBeVisible();
  const name = card.getByRole('textbox', { name: 'Name' });
  await name.fill('E2E Service desk');
  await card.getByRole('textbox', { name: 'Footer text' }).fill('Internal – E2E');
  // the preview (on demand) follows the unsaved draft: subject, the e-mail in a sandboxed frame and the Teams card
  await card.getByRole('button', { name: 'Show preview' }).click();
  await expect(card.getByText('Subject: [E2E Service desk] ')).toBeVisible();
  const mail = card.frameLocator('iframe[title="E-mail"]');
  await expect(mail.getByText('E2E Service desk', { exact: true })).toBeVisible();
  await expect(mail.getByText('Internal – E2E')).toBeVisible();
  await expect(card.getByText('Open in E2E Service desk')).toBeVisible();
  await card.getByRole('button', { name: 'Save look' }).click();
  await expect(page.getByText('Look of e-mails and Teams messages saved')).toBeVisible();
  await page.reload();
  await expect(card.getByRole('textbox', { name: 'Name' })).toHaveValue('E2E Service desk');
  // back to the Appearance settings
  await card.getByRole('button', { name: 'Back to the Appearance settings' }).click();
  await card.getByRole('button', { name: 'Save look' }).click();
  await expect(page.getByText('Look of e-mails and Teams messages saved').first()).toBeVisible();
  await page.reload();
  await expect(card.getByRole('textbox', { name: 'Name' })).toHaveValue('');
});
