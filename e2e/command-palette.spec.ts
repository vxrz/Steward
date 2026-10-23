import { test, expect } from './support/fixtures';
import { authFile } from './support/env';

test.use({ storageState: authFile('olivia') });

test('Ctrl+K finds and opens a process; "start run" opens the run dialog', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 2 })).toBeVisible();

  await page.keyboard.press('Control+K');
  const search = page.getByRole('textbox', { name: 'Search', exact: true });
  await expect(search).toBeFocused();
  // "process" narrows the results to the Processes group (recent runs carry the same name)
  await search.fill('process health check');
  await page.getByRole('button', { name: /^Insights Hub – Platform health check/ }).click();
  await expect(page).toHaveURL(/\/processes\/ih-health-check$/);
  await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toContainText('Insights Hub – Platform health check');

  // the header button opens it, too
  await page.getByRole('button', { name: /^Search \(/ }).click();
  await search.fill('start run health');
  await page.getByRole('button', { name: 'Start run of Insights Hub – Platform health check' }).click();
  const dialog = page.getByRole('dialog', { name: 'Run: Insights Hub – Platform health check' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Start dry run' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  // pages are searchable as well (Ctrl+K toggles, so the palette must have finished closing)
  await expect(search).toBeHidden();
  await page.keyboard.press('Control+K');
  await search.fill('my tasks');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/tasks$/);
});
