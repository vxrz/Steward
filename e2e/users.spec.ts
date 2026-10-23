import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { confirmDialog, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

test('admin creates a user, assigns roles and a team, then deactivates the account', async ({ page, browser }) => {
  const username = uniq('e2e-user').replace(/\s/g, '-').toLowerCase();
  const team = uniq('E2E Team');
  await page.goto('/users');

  // create
  await page.getByRole('button', { name: 'Add user' }).click();
  const add = page.getByRole('dialog', { name: 'Add user' });
  await add.getByRole('textbox', { name: 'User name' }).fill(username);
  await add.getByRole('textbox', { name: 'Display name' }).fill('E2E Person');
  await add.getByRole('textbox', { name: 'Roles' }).click({ force: true });
  await page.getByRole('option', { name: /^approver – / }).click();
  await add.getByRole('heading', { name: 'Add user' }).click(); // closes the dropdown
  await add.getByLabel('Initial password (optional)').fill('Initial-password-1');
  await add.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(`${username} created`)).toBeVisible();

  const row = page.getByRole('row').filter({ hasText: username });
  await expect(row).toContainText('operator');
  await expect(row).toContainText('approver');
  await expect(row).toContainText('must change password');

  // change roles: operator → viewer only
  await row.getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: `Edit ${username}` });
  await edit.getByRole('textbox', { name: 'Roles' }).click({ force: true });
  await page.getByRole('option', { name: /^operator – / }).click();
  await page.getByRole('option', { name: /^approver – / }).click();
  await page.getByRole('option', { name: /^viewer – / }).click();
  await edit.getByRole('heading', { name: `Edit ${username}` }).click();
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(row).toContainText('viewer');
  await expect(row).not.toContainText('operator');

  // team
  await page.getByRole('button', { name: 'New team' }).click();
  const teamDialog = page.getByRole('dialog', { name: 'New team' });
  await teamDialog.getByRole('textbox', { name: 'Name' }).fill(team);
  await teamDialog.getByRole('textbox', { name: 'Members' }).fill(username, { force: true });
  await page.getByRole('option', { name: `E2E Person (${username})` }).click();
  await teamDialog.getByRole('heading', { name: 'New team' }).click();
  await teamDialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(`Team "${team}" saved`)).toBeVisible();
  await expect(row).toContainText(team);

  // deactivate → sign-in is refused
  await row.getByRole('switch', { name: 'Active' }).dispatchEvent('click'); // Mantine hides the native input
  await expect(row.getByRole('switch', { name: 'Active' })).not.toBeChecked();
  const ctx = await browser.newContext({ baseURL: baseURL() });
  try {
    const res = await ctx.request.post('/api/auth/login', { headers: { 'x-sm-client': '1' }, data: { username, password: 'Initial-password-1' } });
    expect(res.status()).toBe(401);
  } finally {
    await ctx.close();
  }

  // clean up the team
  await page.getByRole('button', { name: `Delete team ${team}` }).click();
  await confirmDialog(page, 'Delete', { title: 'Confirm deletion', message: team });
  await expect(page.getByText(team, { exact: true })).toHaveCount(0);
});
