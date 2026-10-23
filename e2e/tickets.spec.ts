import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { json, uniq } from './support/helpers';
import { expectAccessible, settle } from './support/axe';

test.use({ storageState: authFile('olivia') });

test('an operator documents a vendor ticket from the service page and keeps its status up to date', async ({ page, apiAs }) => {
  const admin = await apiAs('admin');
  const service = await json(await admin.post('/api/services', { data: { name: uniq('E2E Plant data upload'), owners: [] } }));
  const number = uniq('CS');

  // the service page has an empty "Open tickets" panel with an action to add one
  await page.goto(`/services/${service.id}`);
  const panel = page.getByTestId('tickets-panel');
  await expect(panel.getByText('No open tickets.')).toBeVisible();
  await panel.getByRole('button', { name: 'Add ticket reference' }).click();
  const dialog = page.getByRole('dialog', { name: 'New ticket reference' });
  // the service is already named as affected
  await expect(dialog.getByText(`Service: ${service.name}`)).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Number' }).fill(number);
  await dialog.getByRole('textbox', { name: 'Title' }).fill('Agent uploads stall on the plant tenant');
  // only http(s) links
  await dialog.getByRole('textbox', { name: 'Link' }).fill('javascript:alert(1)');
  // Save stays enabled; submitting keeps the dialog open with the link field marked and focused
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Link' })).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.getByRole('textbox', { name: 'Link' })).toBeFocused();
  await dialog.getByRole('textbox', { name: 'Link' }).fill('https://support.vendor.example/cases/4711');
  await dialog.getByRole('textbox', { name: 'Vendor' }).fill('Vendor A');
  await dialog.getByRole('textbox', { name: 'Note' }).fill('**Case opened** with vendor support.\n\n<img src=x onerror=alert(1)>');
  await dialog.getByRole('button', { name: 'Save' }).click();

  // the detail page: status, Markdown note rendered safely, affected service, history
  await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toContainText(number);
  await expect(page.getByRole('main').getByText('Case opened', { exact: true })).toBeVisible();
  await expect(page.getByRole('main').getByText('<img src=x onerror=alert(1)>')).toBeVisible();
  await expect(page.locator('main img[src="x"]')).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('link', { name: service.name })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open ticket' })).toHaveAttribute('href', 'https://support.vendor.example/cases/4711');

  await page.getByRole('button', { name: `Change the status of ${number}` }).click();
  await page.getByRole('menuitem', { name: 'Waiting for vendor' }).click();
  const status = page.getByRole('dialog', { name: 'Change status: Waiting for vendor' });
  await status.getByRole('textbox', { name: 'Comment' }).fill('Logs sent to the vendor');
  await status.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Status changed')).toBeVisible();
  await expect(page.getByText('Status: Open → Waiting for vendor')).toBeVisible();
  await expect(page.getByText('Logs sent to the vendor')).toBeVisible();

  await page.getByRole('button', { name: 'Mark checked' }).click();
  await page.getByRole('dialog', { name: 'Mark checked' }).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Marked as checked')).toBeVisible();
  await expect(page.getByText('Checked', { exact: true })).toBeVisible();

  // the service catalogue counts it as an open vendor ticket
  await page.goto('/services');
  await expect(page.getByRole('row').filter({ hasText: service.name }).getByText('1 open vendor ticket')).toBeVisible();

  // the list finds it by search and filter; the page is accessible
  await page.goto('/tickets');
  await settle(page);
  await page.getByRole('textbox', { name: 'Search' }).fill(number);
  const row = page.getByRole('row').filter({ hasText: number });
  await expect(row).toHaveCount(1);
  await expect(row.getByText('Waiting for vendor')).toBeVisible();
  await expect(row.getByRole('link', { name: service.name })).toBeVisible();
  await expectAccessible(page, 'ticket references');

  // the service page shows it under "Open tickets"
  await page.goto(`/services/${service.id}`);
  await expect(page.getByTestId('tickets-panel').getByRole('link', { name: number, exact: true })).toBeVisible();
});

test.describe('read-only accounts', () => {
  test.use({ storageState: authFile('vera') });
  test('a viewer reads ticket references but cannot add them', async ({ page }) => {
    await page.goto('/tickets');
    await settle(page);
    await expect(page.getByRole('heading', { name: 'Ticket references', level: 2 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New ticket reference' })).toHaveCount(0);
  });
});
