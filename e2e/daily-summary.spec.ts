import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { settle } from './support/axe';

test.use({ storageState: authFile('audrey') });

test('a user turns on the daily summary, previews it, and administrators see the subscription', async ({ page, loginAs }) => {
  await page.goto('/profile');
  await settle(page);
  const card = page.getByRole('heading', { name: 'Daily summary', level: 2 }).locator('xpath=ancestor::div[contains(@class, "mantine-Card-root")]');
  await card.getByLabel('Send me a daily summary').click();
  await expect(card.getByRole('switch', { name: 'Send me a daily summary' })).toBeChecked();
  await card.getByLabel('Time', { exact: true }).fill('06:45');
  await card.getByRole('combobox', { name: 'Days' }).click();
  await page.getByRole('option', { name: 'Every day' }).click();
  await card.getByRole('checkbox', { name: 'Reports for me' }).uncheck();
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Daily summary settings saved')).toBeVisible();

  await card.getByRole('button', { name: 'Preview' }).click();
  const preview = page.getByRole('dialog', { name: /^Preview: Daily summary for / });
  await expect(preview).toBeVisible();
  await page.keyboard.press('Escape');

  // the settings survive a reload
  await page.reload();
  await settle(page);
  await expect(card.getByLabel('Time', { exact: true })).toHaveValue('06:45');
  await expect(card.getByRole('checkbox', { name: 'Reports for me' })).not.toBeChecked();

  // administrators see who subscribed (not the content)
  const admin = await loginAs('admin');
  await admin.goto('/settings/notifications');
  await settle(admin);
  const row = admin.getByRole('table', { name: 'Daily summaries' }).getByRole('row').filter({ hasText: 'audrey' });
  await expect(row).toContainText('06:45');
  await expect(row).toContainText('Every day');

  // turn it off again
  await card.getByLabel('Send me a daily summary').click();
  await expect(card.getByRole('switch', { name: 'Send me a daily summary' })).not.toBeChecked();
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Daily summary settings saved')).toBeVisible();
});

test('the switch that allows daily summaries is saved with the save bar, not at once', async ({ loginAs, apiAs }) => {
  const admin = await loginAs('admin');
  await admin.goto('/settings/notifications');
  await settle(admin);
  const toggle = admin.getByRole('switch', { name: 'Allow daily summaries' });
  await expect(toggle).toBeChecked();
  await admin.getByLabel('Allow daily summaries').click();
  await expect(toggle).not.toBeChecked();
  const bar = admin.getByTestId('settings-save-bar');
  await expect(bar).toContainText('Unsaved changes');
  // nothing was saved yet: the server still allows them
  expect((await (await (await apiAs('admin')).get('/api/settings/daily-summary')).json()).allowed).toBe(true);
  await bar.getByRole('button', { name: 'Reset' }).click();
  await expect(toggle).toBeChecked();
  await expect(bar).toContainText('No unsaved changes');
});
