import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';

test.use({ storageState: authFile('admin') });

/** Settings by area (#136): one area per page with a stable URL, the scope on each, found from the command palette. */
test('settings are split into areas with their own addresses, and each says its scope', async ({ page }) => {
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/settings\/general$/);
  const nav = page.getByRole('navigation', { name: 'Settings areas' });
  for (const area of ['General', 'Security & sign-in', 'Integrations', 'Notifications', 'Appearance & branding', 'Catalogue & compliance', 'Maintenance'])
    await expect(nav.getByRole('link', { name: area })).toBeVisible();
  await expect(page.getByTestId('settings-scope')).toContainText('Instance settings apply to the whole installation');
  await expect(page.getByRole('heading', { name: 'Language' })).toBeVisible();
  await expectAccessible(page, 'settings: general');

  // each area at its own address, with its settings
  await nav.getByRole('link', { name: 'Catalogue & compliance' }).click();
  await expect(page).toHaveURL(/\/settings\/catalogue$/);
  await expect(page.getByRole('heading', { name: 'CIA scale' })).toBeVisible();
  await expect(page.getByTestId('scorecard-rules')).toBeVisible();
  await expect(page.getByTestId('environments-card')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Language' })).toHaveCount(0);
  await expectAccessible(page, 'settings: catalogue');
  await page.goto('/settings/security');
  await expect(page.getByRole('heading', { name: 'Sign-in' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Outbound access' })).toBeVisible();

  // the old anchor in messages leads to the notifications area; an unknown area is not found
  await page.goto('/settings#notifications');
  await expect(page).toHaveURL(/\/settings\/notifications$/);
  await page.goto('/settings/nonsense');
  await expect(page.getByText('Page not found')).toBeVisible();

  // a single setting from the command palette
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 2 })).toBeVisible();
  await page.keyboard.press('Control+K');
  await page.getByRole('textbox', { name: 'Search', exact: true }).fill('data retention');
  await page.getByRole('button', { name: /^Data retention/ }).click();
  await expect(page).toHaveURL(/\/settings\/maintenance$/);
  await expect(page.getByRole('heading', { name: 'Data retention' })).toBeVisible();
});

test('people who are not administrators see where their own settings are', async ({ loginAs }) => {
  const vera = await loginAs('vera');
  await vera.goto('/settings/notifications');
  await expect(vera.getByText('Only administrators can change settings.')).toBeVisible();
  await expect(vera.getByRole('link', { name: 'your profile' })).toHaveAttribute('href', /\/profile$/);
  await expect(vera.getByTestId('settings-scope').locator('xpath=following-sibling::*')).toHaveCount(0);
});
