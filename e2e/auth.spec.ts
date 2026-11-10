import { test, expect, USERS, pageSessionHeaders, sessionHeaders } from './support/fixtures';
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
    await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();

    const headers = await pageSessionHeaders(page);
    expect((await page.request.get('/api/auth/me', { headers })).status()).toBe(200);
    await page.getByRole('button', { name: 'User menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: /^Sign in/ })).toBeVisible();
    // the session is gone on the server, too, and the web app forgot its session key
    expect((await page.request.get('/api/auth/me', { headers })).status()).toBe(401);
    expect(await pageSessionHeaders(page)).toEqual({});
  });

  test('wrong password shows a message', async ({ page }) => {
    await signIn(page, USERS.vera.username, 'not-the-password-1');
    await expect(page.getByRole('alert')).toContainText('Wrong user name or password');
    await expect(page.getByRole('heading', { name: /^Sign in/ })).toBeVisible();
  });

  test('a failed single sign-on shows a fixed text, never text from the address', async ({ page }) => {
    // a link that tries to put its own words on the sign-in page (security review 0.10.0 S8)
    await page.goto('/?sso_error=' + encodeURIComponent('Your account is locked. Call +1 555 0100 and give your password.'));
    await expect(page.getByTestId('sso-error')).toContainText('The sign-in with your company account did not work.');
    await expect(page.getByText('+1 555 0100')).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
    // a refused sign-in names its reference; a known code its own text
    await page.goto('/?sso_error=SSO_SIGN_IN_REFUSED&sso_ref=0a1b2c3d');
    await expect(page.getByTestId('sso-error')).toContainText('give them the reference 0a1b2c3d');
    await page.goto('/?sso_error=SSO_STATE_UNKNOWN&sso_ref=' + encodeURIComponent('<b>x</b>'));
    await expect(page.getByTestId('sso-error')).toContainText('The sign-in attempt expired');
    await expect(page.getByTestId('sso-error')).not.toContainText('<b>');
  });

  test('too many requests shows how long to wait', async ({ page, allowConsole }) => {
    allowConsole(/status of 429/);
    // the server's 429 answer (server/test/rate-limit.test.ts), simulated: the shared demo server is not run out of its budget on purpose
    await page.route('**/api/auth/login', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        headers: { 'retry-after': '42' },
        body: JSON.stringify({ error: 'Too many requests – try again in 42 s', code: 'RATE_LIMITED', params: { context: 'wait', seconds: 42 } }),
      }),
    );
    await signIn(page, USERS.vera.username, USERS.vera.password);
    // the translated text (with a full stop), not the server's English message
    await expect(page.getByRole('alert')).toContainText('Too many requests – try again in 42 s.');
  });

  test('new account must change its temporary password first', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    const username = uniq('newbie').replace(/\s/g, '').toLowerCase();
    await json(await admin.post('/api/users', { data: { username, displayName: 'New Person', roles: ['viewer'], password: 'Temp-password-1' } }));

    await signIn(page, username, 'Temp-password-1');
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    // the API refuses everything else until the password is changed
    expect((await page.request.get('/api/processes', { headers: await pageSessionHeaders(page) })).status()).toBe(403);

    await page.getByLabel('Temporary password').fill('Temp-password-1');
    // the rule under the field counts down while the password is too short (12 characters, any characters)
    await page.getByLabel(/^New password/).fill('Own-pass');
    await expect(page.getByText('At least 12 characters – 4 more to go.')).toBeVisible();
    // a common password: the server says so (bundled list, no outbound call)
    await page.getByLabel(/^New password/).fill('Password1234');
    await page.getByLabel('Repeat new password').fill('Password1234');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page.getByRole('alert')).toContainText('This password is too common');
    await page.getByLabel(/^New password/).fill('Own-password-2');
    await page.getByLabel('Repeat new password').fill('Own-password-2');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expectShell(page);
    expect((await page.request.get('/api/processes', { headers: await pageSessionHeaders(page) })).status()).toBe(200);
  });

  test.describe('browser locale that is not a BCP 47 tag', () => {
    // Chromium on Linux reports "en-US@posix" with LANG unset or C/POSIX (kiosks, wall boards); Intl throws on it
    test.use({ locale: 'en-US@posix' });

    test('sign-in and pages work (en-US@posix)', async ({ page }) => {
      expect(await page.evaluate(() => navigator.language)).toBe('en-US@posix');
      await signIn(page, USERS.vera.username, USERS.vera.password);
      await expectShell(page);
      await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
      // a page with dates and numbers, formatted in the UI language
      await page.goto('/runs');
      await expect(page.getByRole('heading', { name: 'Runs', level: 1 })).toBeVisible();
      await expect(page.getByRole('table').first().getByRole('row').nth(1)).toBeVisible();
      await expect(page.getByText('Something went wrong')).toHaveCount(0);
    });
  });
});

test.describe('viewer (vera)', () => {
  test.use({ storageState: authFile('vera') });

  test('sees no admin pages or editing buttons', async ({ page, request }) => {
    await page.goto('/processes');
    await expect(page.getByRole('heading', { name: 'Processes', level: 1 })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
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
    const headers = sessionHeaders('vera');
    expect((await request.get('/api/users', { headers })).status()).toBe(403);
    expect((await request.get('/api/audit', { headers })).status()).toBe(403);
    expect((await request.post('/api/processes', { headers: { 'x-sm-client': '1', ...headers }, data: { templateId: '40-ih-health-check' } })).status()).toBe(
      403,
    );
    // the cookie alone is not enough (session binding): another local program that received it gets nothing
    expect((await request.get('/api/processes')).status()).toBe(401);
  });
});
