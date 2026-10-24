import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll } from './support/helpers';
import { sessionState, startIsolatedServer, type IsolatedServer } from './support/server';
import { BRAND } from '../shared/src/brand';

/**
 * The notice after an update. Simulated on an own server: stopped, its database marked as written by
 * an older version, started again – the start-up records the update like a real one (db.ts), and the
 * notice appears once the vault is unlocked (from SM_MASTER_PASSPHRASE).
 */
test.describe('update notice (own server)', () => {
  test.describe.configure({ mode: 'serial' });
  let srv: IsolatedServer;
  let operator: { cookie: string; sessionKey: string; linkKey: string };
  const contexts: BrowserContext[] = [];

  /** Signs in with fetch; the first sign-in sets the user's own password. */
  async function signIn(username: string, password: string) {
    const res = await fetch(`${srv.baseURL}/api/auth/login`, {
      method: 'POST',
      headers: { 'x-sm-client': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) throw new Error(`login ${username}: HTTP ${res.status}`);
    return {
      cookie: res.headers.get('set-cookie')!.split(';')[0]!,
      sessionKey: res.headers.get('x-sm-session-key') ?? '',
      linkKey: res.headers.get('x-sm-link-key') ?? '',
    };
  }

  test.beforeAll(async () => {
    srv = await startIsolatedServer();
    await srv.api('POST', '/users', { username: 'olga', roles: ['operator'], password: 'Olga-password-123' });
    const first = await signIn('olga', 'Olga-password-123');
    const changed = await fetch(`${srv.baseURL}/api/auth/password`, {
      method: 'POST',
      headers: { 'x-sm-client': '1', 'content-type': 'application/json', cookie: first.cookie, 'x-sm-session': first.sessionKey },
      body: JSON.stringify({ current: 'Olga-password-123', next: 'Olga-password-456' }),
    });
    expect(changed.ok).toBe(true);
    operator = await signIn('olga', 'Olga-password-456');
    // the database was last opened by an older version
    await srv.restart((dataDir) => {
      const d = new DatabaseSync(path.join(dataDir, 'service-manager.db'));
      try {
        d.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run('system.appVersion', '"0.0.9"');
      } finally {
        d.close();
      }
    });
  });
  test.afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => undefined);
    await srv?.stop();
  });

  async function open(browser: Browser, s: { cookie: string; sessionKey: string; linkKey: string }, viewport = { width: 1440, height: 900 }): Promise<Page> {
    const ctx = await browser.newContext({
      baseURL: srv.baseURL,
      serviceWorkers: 'block',
      locale: 'en-GB',
      viewport,
      storageState: sessionState(srv.baseURL, s.cookie, s),
    });
    contexts.push(ctx);
    return ctx.newPage();
  }
  const admin = () => ({ cookie: srv.adminCookie, sessionKey: srv.sessionKey, linkKey: srv.linkKey });

  test('administrators see the update once and dismiss it for every browser', async ({ browser }) => {
    const version = (await srv.api('GET', '/about')).build.version as string;
    const page = await open(browser, admin());
    await page.goto('/');
    await settle(page);
    const notice = page.getByRole('alert', { name: /was updated/ });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(`was updated from 0.0.9 to ${version}`);
    await expect(notice).toContainText('No changes to the database were needed');
    await expect(notice).toContainText('No copy of the database was needed');
    const notes = notice.getByRole('link', { name: `Release notes for ${version}` });
    await expect(notes).toHaveAttribute('href', `${BRAND.repoUrl}/blob/v${version}/CHANGELOG.md`);
    await expect(notes).toHaveAttribute('target', '_blank');
    await expectAccessible(page, 'dashboard with update notice');

    // phone width: the notice fits
    const phone = await open(browser, admin(), { width: 390, height: 844 });
    await phone.goto('/');
    await expect(phone.getByRole('alert', { name: /was updated/ })).toBeVisible();
    await expectNoHorizontalScroll(phone);

    // on every page, until dismissed (keyboard)
    await page.goto('/runs');
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: 'Dismiss the update notice' }).focus();
    await page.keyboard.press('Enter');
    await expect(notice).toBeHidden();
    await page.reload();
    await settle(page);
    await expect(notice).toBeHidden();
    // the other browser does not show it again either
    await phone.reload();
    await expect(phone.getByRole('main').getByRole('heading', { level: 2 }).first()).toBeVisible();
    await expect(phone.getByRole('alert', { name: /was updated/ })).toBeHidden();
  });

  test('others never see it', async ({ browser }) => {
    const page = await open(browser, operator);
    await page.goto('/');
    await settle(page);
    await expect(page.getByRole('alert', { name: /was updated/ })).toHaveCount(0);
    const res = await page.request.get('/api/system/update-notice', { headers: { 'x-sm-client': '1', 'x-sm-session': operator.sessionKey } });
    expect(res.status()).toBe(403);
  });
});
