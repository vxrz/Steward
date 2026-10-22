import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { settle } from './support/axe';

test.use({ storageState: authFile('audrey') });

test('a user turns on the daily summary, previews it, and administrators see the subscription', async ({ page, loginAs }) => {
  await page.goto('/profile');
  await settle(page);
  const card = page.getByRole('heading', { name: 'Daily summary', level: 5 }).locator('xpath=ancestor::div[contains(@class, "mantine-Card-root")]');
  await card.getByText('Send me a daily summary').click();
  await expect(card.getByRole('switch', { name: 'Send me a daily summary' })).toBeChecked();
  await card.getByLabel('Time', { exact: true }).fill('06:45');
  await card.getByRole('textbox', { name: 'Days' }).click();
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
  await admin.goto('/settings');
  await settle(admin);
  const row = admin.getByRole('table', { name: 'Daily summaries' }).getByRole('row').filter({ hasText: 'audrey' });
  await expect(row).toContainText('06:45');
  await expect(row).toContainText('Every day');

  // turn it off again
  await card.getByText('Send me a daily summary').click();
  await expect(card.getByRole('switch', { name: 'Send me a daily summary' })).not.toBeChecked();
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Daily summary settings saved')).toBeVisible();
});
