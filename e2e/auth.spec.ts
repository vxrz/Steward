import { test, expect, USERS } from './support/fixtures';
import { authFile } from './support/env';
import { expectShell, json, uniq } from './support/helpers';

/** Sign in through the login form (fresh browser context, no stored session). */
async function signIn(page: import('@playwright/test').Page, username: string, password: string) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^Sign in/ })).toBeVisible();
  await page.getByLabel('User name').fill(username);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('sign-in', () => {
  // these tests sign in themselves – no stored session
  test.use({ storageState: { cookies: [], origins: [] } });

  test('sign in and sign out', async ({ page }) => {
    await signIn(page, USERS.dana.username, USERS.dana.password);
    await expectShell(page);
    await expect(page.getByRole('button', { name: 'User menu' })).toContainText(USERS.dana.displayName);
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 2 })).toBeVisible();

    await page.getByRole('button', { name: 'User menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: /^Sign in/ })).toBeVisible();
    // the session is gone on the server, too
    expect((await page.request.get('/api/auth/me')).status()).toBe(401);
  });

  test('wrong password shows a message', async ({ page }) => {
    await signIn(page, USERS.vera.username, 'not-the-password-1');
    await expect(page.getByRole('alert')).toContainText('Wrong user name or password');
    await expect(page.getByRole('heading', { name: /^Sign in/ })).toBeVisible();
  });

  test('new account must change its temporary password first', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    const username = uniq('newbie').replace(/\s/g, '').toLowerCase();
    await json(await admin.post('/api/users', { data: { username, displayName: 'New Person', roles: ['viewer'], password: 'Temp-password-1' } }));

    await signIn(page, username, 'Temp-password-1');
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    // the API refuses everything else until the password is changed
    expect((await page.request.get('/api/processes')).status()).toBe(403);

    await page.getByLabel('Temporary password').fill('Temp-password-1');
    await page.getByLabel(/^New password/).fill('Own-password-2');
    await page.getByLabel('Repeat new password').fill('Own-password-2');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expectShell(page);
    expect((await page.request.get('/api/processes')).status()).toBe(200);
  });
});

test.describe('viewer (vera)', () => {
  test.use({ storageState: authFile('vera') });

  test('sees no admin pages or editing buttons', async ({ page, request }) => {
    await page.goto('/processes');
    await expect(page.getByRole('heading', { name: 'Processes', level: 2 })).toBeVisible();
    const nav = page.getByRole('navigation');
    await expect(nav.getByRole('link', { name: 'Processes' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Audit log' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Users & teams' })).toHaveCount(0);
    for (const name of ['New process', 'Import YAML', 'From template']) {
      await expect(page.getByRole('button', { name })).toHaveCount(0);
    }
    await expect(page.getByText('Insights Hub – Platform health check', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Run / })).toHaveCount(0);

    // process editor is read-only
    await page.getByText('Insights Hub – Platform health check', { exact: true }).click();
    await expect(page).toHaveURL(/\/processes\/ih-health-check$/);
    await expect(page.getByRole('tab', { name: 'Flow' })).toBeVisible();
    await expect(page.getByRole('main').getByText('read-only', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toHaveCount(0);

    // admin routes do not exist for her
    await page.goto('/users');
    await expect(page.getByText('Page not found')).toBeVisible();
    await page.goto('/settings');
    await expect(page.getByText('Only administrators can change settings.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);

    // and the server enforces it
    expect((await request.get('/api/users')).status()).toBe(403);
    expect((await request.get('/api/audit')).status()).toBe(403);
    expect((await request.post('/api/processes', { headers: { 'x-sm-client': '1' }, data: { templateId: '40-ih-health-check' } })).status()).toBe(403);
  });
});
