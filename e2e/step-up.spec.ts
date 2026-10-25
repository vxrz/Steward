import { request as pwRequest, type BrowserContext, type Page } from '@playwright/test';
import { test, expect, USERS, pageSessionHeaders } from './support/fixtures';
import { baseURL } from './support/env';
import { expectAccessible } from './support/axe';
import { uniq } from './support/helpers';
import { sessionState, startIsolatedServer, type IsolatedServer } from './support/server';

/**
 * Step-up re-authentication (#14): a sensitive action – here creating an API token – asks the person to confirm it is
 * them, and goes on by itself once confirmed. Each test uses a session of its own whose confirmation is ended first
 * (a fresh sign-in counts as one; the shared stored sessions are confirmed by the fixtures).
 */

async function createToken(page: Page, name: string) {
  await page.goto('/profile');
  await page.getByRole('button', { name: 'New token' }).click();
  const create = page.getByRole('dialog', { name: 'New API token' });
  await create.getByRole('textbox', { name: 'Name' }).fill(name);
  await create.getByRole('button', { name: 'Create token' }).click();
}

test('a password session confirms with its password, then the token is created', async ({ browser }) => {
  // a session of its own for Dana, not confirmed
  const api = await pwRequest.newContext({ baseURL: baseURL(), extraHTTPHeaders: { 'x-sm-client': '1' } });
  let ctx: BrowserContext | undefined;
  try {
    const login = await api.post('/api/auth/login', { data: { username: USERS.dana.username, password: USERS.dana.password } });
    expect(login.ok()).toBeTruthy();
    const cookie = login.headers()['set-cookie']!.split(';')[0]!;
    const keys = { sessionKey: login.headers()['x-sm-session-key']!, linkKey: login.headers()['x-sm-link-key']! };
    expect((await api.delete('/api/auth/step-up', { headers: { 'x-sm-session': keys.sessionKey } })).ok()).toBeTruthy();
    ctx = await browser.newContext({ baseURL: baseURL(), serviceWorkers: 'block', storageState: sessionState(baseURL(), cookie, keys) });
    const page = await ctx.newPage();
    const name = uniq('Step-up token');
    await createToken(page, name);

    const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('sensitive action');
    await expectAccessible(page, 'step-up dialog (password)');
    const password = dialog.getByLabel('Your password');
    await expect(password).toBeFocused();
    await password.fill('not the password');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog.getByText('The password is wrong.')).toBeVisible();
    await password.fill(USERS.dana.password);
    await password.press('Enter');
    await expect(dialog).toBeHidden();
    // the request was sent again by itself
    await expect(page.getByRole('dialog', { name: 'Token created' })).toBeVisible();
    await page.getByRole('dialog', { name: 'Token created' }).getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('row').filter({ hasText: name })).toContainText('active');

    // cancelled: nothing happens, and it says why
    await api.delete('/api/auth/step-up', { headers: { 'x-sm-session': keys.sessionKey } });
    await createToken(page, uniq('Cancelled token'));
    await page.getByRole('dialog', { name: 'Confirm it is you' }).getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Not done: the action needs a confirmation that it is you.')).toBeVisible();
  } finally {
    await ctx?.close();
    await api.dispose();
  }
});

test.describe('single sign-on step-up (own server)', () => {
  let srv: IsolatedServer;
  test.beforeAll(async () => {
    srv = await startIsolatedServer({ demo: true });
    await srv.api('POST', '/demo/setup', {}); // adds "Microsoft Entra ID (simulated)"
  });
  test.afterAll(async () => {
    await srv?.stop();
  });

  test('a single sign-on session confirms with a fresh sign-in at its provider in a popup', async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: srv.baseURL, serviceWorkers: 'block', locale: 'en-GB' });
    try {
      const page = await ctx.newPage();
      await page.goto('/');
      await page.getByRole('link', { name: /Microsoft Entra ID \(simulated\)/ }).click();
      await page.getByRole('link', { name: /Erik Engineer/ }).click();
      await expect(page.getByRole('button', { name: 'User menu' })).toContainText('Erik Engineer');
      // the fresh sign-in confirmed the session: end it, so the token asks
      const ended = await page.request.delete('/api/auth/step-up', { headers: { 'x-sm-client': '1', ...(await pageSessionHeaders(page)) } });
      expect(ended.ok()).toBeTruthy();

      const name = uniq('SSO step-up token');
      await createToken(page, name);
      const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
      await expect(dialog).toContainText('Sign in again with Microsoft Entra ID (simulated)');
      await expectAccessible(page, 'step-up dialog (single sign-on)');
      const [popup] = await Promise.all([
        ctx.waitForEvent('page'),
        dialog.getByRole('button', { name: 'Confirm with Microsoft Entra ID (simulated)' }).click(),
      ]);
      // the provider asks for a fresh sign-in (prompt=login, max_age=0)
      await expect(popup.getByRole('heading', { name: 'Sign in again' })).toBeVisible();
      expect(new URL(popup.url()).searchParams.get('prompt')).toBe('login');
      await expect(dialog.getByText('Waiting for the sign-in at Microsoft Entra ID (simulated)')).toBeVisible();
      await popup.getByRole('link', { name: /Erik Engineer/ }).click();
      // the popup redeems the confirmation for this session; the dialog closes and the token is created
      await expect(dialog).toBeHidden({ timeout: 15_000 });
      await expect(page.getByRole('dialog', { name: 'Token created' })).toBeVisible();
      const status = await page.request.get('/api/auth/step-up', { headers: await pageSessionHeaders(page) });
      expect(await status.json()).toMatchObject({ method: 'sso', confirmedWith: 'sso' });
    } finally {
      await ctx.close();
    }
  });
});
