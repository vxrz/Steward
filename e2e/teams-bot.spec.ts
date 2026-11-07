import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';

/**
 * The Teams bot (0.10.0, ADR 0013 stage 2): a preview, off by default. Administrators see its settings under
 * Settings → Notifications, and the assurance policy says per control point whether it may be decided in Teams.
 */

test.use({ storageState: authFile('admin') });

test('the Teams bot settings: preview, off, and nothing installed yet', async ({ page }) => {
  await page.goto('/settings/notifications');
  await settle(page);
  const card = page.getByTestId('teams-bot-card');
  await expect(card.getByTestId('teams-bot-preview')).toHaveText('Preview');
  await expect(card.getByRole('switch', { name: 'Decide in Teams cards' })).not.toBeChecked();
  await expect(card).toContainText('No bot listener: set SM_TEAMS_BOT_PORT');
  await expect(card).toContainText('Nowhere yet.');
  await expect(card).toContainText('Save the app id to download the Teams app package.');
  // the credential: a certificate is preferred
  await expect(card.getByLabel('Certificate (PEM)')).toBeVisible();
  await card.getByText('Secret', { exact: true }).click();
  await expect(card.getByLabel('Client secret')).toBeVisible();
  await expectAccessible(page, 'settings: Teams bot');
  // unsaved: the save bar offers to reset
  await page.getByTestId('settings-save-bar').getByRole('button', { name: 'Reset' }).click();
});

test('the assurance policy: "May be decided in Microsoft Teams" on for decisions and AI requests', async ({ page }) => {
  await page.goto('/settings/assurance');
  await settle(page);
  await expect(page.getByTestId('assurance-teams-run.decide')).toBeChecked();
  await expect(page.getByTestId('assurance-teams-mcp.write')).toBeChecked();
  await expect(page.getByTestId('assurance-teams-manualStep.verify')).toHaveCount(0);
  await expectAccessible(page, 'assurance policy with the Teams switch');
});

test('the Teams bot settings on a phone @mobile', async ({ page }) => {
  await page.goto('/settings/notifications');
  await settle(page);
  await expect(page.getByTestId('teams-bot-card')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expectAccessible(page, 'settings: Teams bot (phone)');
});
