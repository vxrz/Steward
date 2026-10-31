import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { MASTER_PASSPHRASE, ROOT } from './support/env';
import { expectAccessible } from './support/axe';
import { startIsolatedServer, type IsolatedServer } from './support/server';

/**
 * Password sign-in switched off (single sign-on only) and emergency access from the command line, on an own
 * server (it changes the sign-in setting for everyone). The identity provider is the demo's mock (SM_DEMO=1).
 */
test.describe('single sign-on only and emergency access (own server)', () => {
  test.describe.configure({ mode: 'serial' });
  let srv: IsolatedServer;
  const contexts: BrowserContext[] = [];

  test.beforeAll(async () => {
    srv = await startIsolatedServer({ demo: true });
    await srv.api('POST', '/demo/setup', {}); // adds "Microsoft Entra ID (simulated)"
  });
  test.afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => undefined);
    await srv?.stop();
  });

  async function open(browser: Browser, colorScheme: 'light' | 'dark' = 'light'): Promise<Page> {
    const ctx = await browser.newContext({ baseURL: srv.baseURL, serviceWorkers: 'block', locale: 'en-GB', colorScheme });
    contexts.push(ctx);
    return ctx.newPage();
  }

  /** The emergency access command, run on the server's data folder while Steward runs. */
  function emergencyAccess(username: string): Promise<{ link: string; minutes: number }> {
    return new Promise((resolve, reject) => {
      const tsx = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
      const env: Record<string, string | undefined> = { ...process.env, SM_DATA_DIR: srv.dataDir, NO_COLOR: '1' };
      delete env.SM_MASTER_PASSPHRASE;
      delete env.SM_PUBLIC_URL;
      const p = spawn(tsx, [path.join(ROOT, 'server/src/cli/admin.ts'), 'emergency-access', username, '--minutes', '15', '--json', '--passphrase-stdin'], {
        cwd: ROOT,
        env,
      });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}: ${err}`))));
      p.stdin.end(MASTER_PASSPHRASE);
    });
  }

  test('an administrator signed in with single sign-on turns password sign-in off; the sign-in page shows only single sign-on', async ({ browser }) => {
    const page = await open(browser);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /^Sign in/ })).toBeVisible();
    await expect(page.getByLabel('User name')).toBeVisible();
    await page.getByRole('link', { name: /Microsoft Entra ID \(simulated\)/ }).click();
    await page.getByRole('link', { name: /Max Admin/ }).click();
    await expect(page.getByRole('button', { name: 'User menu' })).toContainText('Max Admin');

    await page.goto('/settings/security');
    const card = page.locator('.mantine-Card-root', { has: page.getByRole('heading', { name: 'Sign-in' }) });
    const none = card.getByRole('radio', { name: 'Single sign-on only' });
    await expect(none).toBeEnabled();
    await none.check();
    await expect(card.getByText('Emergency access needs the server')).toBeVisible();
    await expect(card.getByText('steward admin emergency-access', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByTestId('confirm-dialog-message')).toContainText('Nobody will be able to sign in with a password');
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page.getByText('Settings saved')).toBeVisible();

    await page.goto('/settings/status');
    await expect(page.getByTestId('status-password-login')).toHaveText('off (single sign-on only)');

    // signed out: only the single sign-on button, no password form
    const login = await open(browser, 'dark');
    await login.goto('/');
    await expect(login.getByRole('heading', { name: /^Sign in/ })).toBeVisible();
    await expect(login.getByRole('link', { name: /Microsoft Entra ID \(simulated\)/ })).toBeVisible();
    await expect(login.getByText('Sign in with your company account.')).toBeVisible();
    await expect(login.getByLabel('User name')).toHaveCount(0);
    await expect(login.getByLabel(/^Password/)).toHaveCount(0);
    await expectAccessible(login, 'sign-in page (single sign-on only, dark)');
    // and the server refuses password sign-in, also with the right password
    const res = await login.request.post('/api/auth/login', {
      headers: { 'x-sm-client': '1' },
      data: { username: 'admin', password: 'Admin-password-1' },
    });
    expect(res.status()).toBe(401);
  });

  test('emergency access from the command line opens a marked session with the one-time link', async ({ browser }) => {
    const { link, minutes } = await emergencyAccess('admin');
    expect(minutes).toBe(15);
    const url = new URL(link);
    expect(url.pathname.endsWith('/emergency-access')).toBe(true);
    const code = url.hash.replace(/^#code=/, '');
    // the link is opened through the address colleagues use (under E2E_BASE_PATH: the reverse proxy)
    const page = await open(browser);
    await page.goto(`/emergency-access#code=${code}`);
    await expect(page.getByRole('heading', { name: 'Emergency access' })).toBeVisible();
    await expectAccessible(page, 'emergency access page');
    await page.getByRole('button', { name: 'Sign in with emergency access' }).click();
    const banner = page.getByTestId('emergency-banner');
    await expect(banner).toContainText('Emergency access – fix the sign-in, then sign out');
    await expect(page.getByRole('button', { name: 'User menu' })).toContainText('admin');
    expect(new URL(page.url()).hash).toBe('');

    // the link works only once
    const again = await open(browser);
    await again.goto(`/emergency-access#code=${code}`);
    await again.getByRole('button', { name: 'Sign in with emergency access' }).click();
    await expect(again.getByRole('alert')).toContainText('invalid, used or expired');

    await banner.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: /^Sign in/ })).toBeVisible();
  });
});
