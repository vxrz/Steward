import type { Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';

test.use({ storageState: authFile('admin') });

/**
 * The form dialogs of monitors, triggers, dashboards and processes (0.20 review): what was entered is not lost
 * without asking – Esc and Cancel ask "Discard your changes?" first (web/src/components/FormModal.tsx).
 */
async function asksBeforeDiscarding(page: Page, dialogName: string, fieldName: string, value: string) {
  const dialog = page.getByRole('dialog', { name: dialogName });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: fieldName, exact: true }).fill(value);
  await page.keyboard.press('Escape');
  const discard = page.getByRole('dialog', { name: 'Discard your changes?' });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog.getByRole('textbox', { name: fieldName, exact: true })).toHaveValue(value);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await discard.getByRole('button', { name: 'Discard' }).click();
  await expect(dialog).toBeHidden();
}

test('the gateway, webhook trigger and new dashboard dialogs ask before discarding input', async ({ page }) => {
  await page.goto('/monitors?tab=gateways');
  await page.getByRole('button', { name: 'New gateway' }).click();
  await asksBeforeDiscarding(page, 'New gateway', 'Name', 'Gateway Hall 9 (invented)');

  await page.goto('/triggers');
  await page.getByRole('main').getByRole('button', { name: 'New webhook trigger' }).first().click();
  await asksBeforeDiscarding(page, 'New webhook trigger', 'Name', 'Invented trigger');

  await page.goto('/dashboards');
  await page.getByRole('button', { name: 'New dashboard' }).click();
  await asksBeforeDiscarding(page, 'New dashboard', 'Name', 'Invented dashboard');
});
