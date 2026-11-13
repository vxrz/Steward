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

test('a dashboard in edit mode asks before Cancel discards its changes', async ({ page, apiAs }) => {
  const admin = await apiAs('admin');
  const created = await (await admin.post('/api/dashboards', { data: { definition: { name: 'Invented edit guard', widgets: [] } } })).json();
  try {
    await page.goto(`/dashboards/${created.id}?edit=1`);
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Invented edit guard (changed)');
    await page.getByTestId('dashboard-cancel').click();
    const discard = page.getByRole('dialog', { name: 'Discard your changes?' });
    await expect(discard).toContainText('The changes to this dashboard are not saved.');
    await discard.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Invented edit guard (changed)');
    await page.getByTestId('dashboard-cancel').click();
    await discard.getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByRole('heading', { name: 'Invented edit guard', level: 1 })).toBeVisible();
  } finally {
    await admin.delete(`/api/dashboards/${created.id}`);
  }
});
