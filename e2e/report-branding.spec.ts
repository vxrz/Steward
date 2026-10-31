import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { BRAND } from '../shared/src/brand';

/**
 * Settings → Report branding: a readability note for a too light accent colour, and "Reset to default".
 * Nothing is saved here – the branding applies to everyone on the shared demo server.
 */
test.describe('report branding', () => {
  test.use({ storageState: authFile('admin') });

  test('warns about a too light accent colour and resets the form to the defaults', async ({ page }) => {
    await page.goto('/settings/appearance');
    const card = page.locator('.mantine-Card-root').filter({ has: page.getByRole('heading', { name: 'Report branding' }) });
    await expect(card).toBeVisible();
    const accent = card.getByRole('textbox', { name: 'Accent colour' });
    const reset = card.getByRole('button', { name: 'Reset to default' });

    await accent.fill('#ffe066');
    await accent.blur();
    await expect(card.getByTestId('branding-contrast')).toContainText('barely stand out');
    await expect(reset).toBeEnabled();

    await reset.click();
    await expect(accent).toHaveValue(BRAND.color);
    await expect(card.getByTestId('branding-contrast')).toHaveCount(0);
    await expect(reset).toBeDisabled();
  });
});
