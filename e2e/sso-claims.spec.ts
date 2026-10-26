import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';

test.use({ storageState: authFile('admin') });

/**
 * The test sign-in of a single sign-on provider (#77): the administrator signs in once through the provider in a new
 * window and sees the claims and a preview of the account – with the unsaved settings of the editor – while nothing
 * signs in or changes. The identity provider is the demo's mock ("Microsoft Entra ID (simulated)").
 */
test('an administrator test-signs-in through a provider and previews the account without signing in', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const usersBefore = (await (await api.get('/api/users')).json()).map((u: { username: string }) => u.username);

  await page.goto('/users');
  const card = page.locator('.mantine-Card-root', { hasText: 'Microsoft Entra ID (simulated)' });
  await card.getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Microsoft Entra ID (simulated)' });
  await expect(dialog.getByText('Steps at Microsoft Entra ID')).toBeVisible();

  const test = dialog.getByTestId('sso-test');
  const [popup] = await Promise.all([page.context().waitForEvent('page'), test.getByRole('button', { name: 'Test sign-in' }).click()]);
  await popup.getByRole('link', { name: /Max Admin/ }).click(); // the window says the test finished (and may close itself)

  // the preview: the account a sign-in would create or use, its names, roles and the claims received
  const preview = test.getByTestId('sso-test-preview');
  await expect(preview).toContainText('max@contoso.example');
  await expect(preview).toContainText('Max');
  await expect(preview).toContainText('Admin');
  await expect(preview).toContainText('SM.Admins');
  await test.getByRole('tab', { name: /ID token/ }).click();
  const claims = test.getByTestId('sso-test-claims');
  await expect(claims.getByRole('row', { name: /preferred_username/ })).toContainText('"max@contoso.example"');
  await expect(claims.getByRole('row', { name: /^tid/ })).toBeVisible();
  await test.getByRole('tab', { name: /Userinfo/ }).click();
  await expect(test.getByTestId('sso-test-claims')).toContainText('given_name');

  // an unsaved change of the user name rule: the preview follows
  await dialog.getByRole('button', { name: 'Scopes and claims' }).click();
  await dialog.getByRole('textbox', { name: 'User name rule' }).click();
  await page.getByRole('option', { name: 'Lower case without @domain (max)' }).click();
  // only listed domains are stripped (any other domain is refused)
  await expect(dialog.getByText('Enter at least one domain')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Domains to strip' }).fill('contoso.example');
  await dialog.getByRole('textbox', { name: 'Domains to strip' }).press('Enter');
  await expect(dialog.getByTestId('sso-warnings')).toContainText('Only the listed domains are stripped');
  await test.getByRole('tab', { name: 'Preview' }).click();
  await expect(preview).toContainText('User name rule: max@contoso.example → max');
  // a policy that refuses: the reason is shown
  await dialog.getByRole('button', { name: /^Accounts: linking/ }).click();
  await dialog.getByRole('button', { name: 'Add required claim' }).click();
  await dialog.getByRole('textbox', { name: 'Claim', exact: true }).fill('hd');
  await dialog.getByRole('textbox', { name: 'Accepted values' }).fill('example.com');
  await dialog.getByRole('textbox', { name: 'Accepted values' }).press('Enter');
  await expect(test.getByTestId('sso-test-refusal')).toContainText('does not belong to the organisation');
  await expect(preview).toContainText('Refused');
  await expectAccessible(page, 'provider editor with a test sign-in');

  // nothing was saved, nobody signed in, no account created
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  const usersAfter = (await (await api.get('/api/users')).json()).map((u: { username: string }) => u.username);
  expect(usersAfter).toEqual(usersBefore);
  const [provider] = await (await api.get('/api/sso/providers')).json();
  expect(provider.usernameTransform).toBe('lowercase');
  expect(provider.requiredClaims).toEqual([]);
  const audit = await (await api.get('/api/audit?action=sso.test_sign_in&limit=1')).json();
  expect(audit[0].summary).toContain('no account or session was changed');
  await popup.close().catch(() => undefined);
});
