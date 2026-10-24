import zlib from 'node:zlib';
import { appHref } from './support/env';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect, USERS } from './support/fixtures';
import { expectAccessible, settle } from './support/axe';
import { sessionState, startIsolatedServer, type IsolatedServer } from './support/server';
import { BRAND } from '../shared/src/brand';
import { confirmDialog } from './support/helpers';

/**
 * Theming (Settings → Appearance). The theme applies to everyone, so these tests run against
 * their own empty server instead of the shared demo server (other tests run in parallel there).
 */

const YELLOW = 'rgb(255, 212, 0)';
const BLACK = 'rgb(0, 0, 0)';

/** Small PNG logo: a dark circle and bars on a transparent background. */
function logoPng(): Buffer {
  const crc32 = (b: Buffer) => {
    let c = ~0;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return ~c >>> 0;
  };
  const chunk = (t: string, d: Buffer) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t, 'latin1'), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc32(td));
    return Buffer.concat([l, td, c]);
  };
  const w = 120;
  const h = 32;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const r = Buffer.alloc(1 + w * 4);
    for (let x = 0; x < w; x++) {
      const on = (x - 16) ** 2 + (y - 16) ** 2 < 196 || (x > 40 && y > 10 && y < 22 && (x - 40) % 16 < 10);
      r.set(on ? [227, 6, 19, 255] : [0, 0, 0, 0], 1 + x * 4);
    }
    rows.push(r);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test.describe('custom theme (own server)', () => {
  test.describe.configure({ mode: 'serial' });
  let srv: IsolatedServer;
  const contexts: BrowserContext[] = [];

  test.beforeAll(async () => {
    srv = await startIsolatedServer();
  });
  test.afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => undefined);
    await srv?.stop();
  });

  async function open(browser: Browser, opts: { signedIn?: boolean; colorScheme?: 'light' | 'dark' } = {}): Promise<Page> {
    const ctx = await browser.newContext({
      baseURL: srv.baseURL,
      serviceWorkers: 'block',
      locale: 'en-GB',
      colorScheme: opts.colorScheme ?? 'light',
      ...(opts.signedIn === false ? {} : { storageState: sessionState(srv.baseURL, srv.adminCookie, srv) }),
    });
    contexts.push(ctx);
    return ctx.newPage();
  }

  test('changing the primary colour in Settings themes buttons, preview and the sign-in page', async ({ browser }) => {
    const page = await open(browser);
    await page.goto('/settings');
    const card = page.locator('.mantine-Card-root', { has: page.getByRole('heading', { name: 'Appearance' }) });
    await expect(card).toBeVisible();
    await card.getByRole('textbox', { name: 'Primary color' }).fill('#ffd400');

    // live preview before saving: bright yellow with dark text (auto contrast), darker link colour
    const preview = card.getByRole('group', { name: 'Preview in the Light color scheme' });
    const sample = preview.getByRole('button', { name: 'Primary', exact: true });
    await expect(sample).toHaveCSS('background-color', YELLOW);
    await expect(sample).toHaveCSS('color', BLACK);
    await expect(card.getByText(/too light for text on a white page, so links and text use the darker/)).toBeVisible();
    // the rest of the page keeps the saved theme until saving
    await expect(card.getByRole('button', { name: 'Save appearance' })).not.toHaveCSS('background-color', YELLOW);

    await card.getByRole('textbox', { name: 'Display name' }).fill('ACME Steward');
    await card.getByRole('button', { name: 'Save appearance' }).click();
    await expect(page.getByText(/Appearance saved/)).toBeVisible();
    await expect(page.getByRole('banner').getByText('ACME Steward')).toBeVisible();
    await expect(page).toHaveTitle('ACME Steward');

    // signed out: the sign-in page uses the theme before anyone signs in
    const login = await open(browser, { signedIn: false });
    await login.goto('/');
    await expect(login.getByRole('heading', { name: 'Sign in to ACME Steward' })).toBeVisible();
    await expect(login).toHaveTitle('ACME Steward');
    await login.getByLabel('User name').fill(USERS.admin.username);
    await login.getByLabel('Password').fill(USERS.admin.password);
    const signIn = login.getByRole('button', { name: 'Sign in', exact: true });
    await expect(signIn).toHaveCSS('background-color', YELLOW);
    await expect(signIn).toHaveCSS('color', BLACK);
    // footer and the product identity stay "Steward"
    await expect(login.getByRole('contentinfo')).toContainText(`${BRAND.name} 0.`);

    // web app manifest with the name and colour
    const manifest = await (await login.request.get('/manifest.webmanifest')).json();
    expect(manifest).toMatchObject({ name: 'ACME Steward', theme_color: '#ffd400' });
    await expect(login.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#ffd400');
  });

  test('the logo appears in the header and on the sign-in page', async ({ browser }) => {
    await srv.api('POST', '/settings/theme/logo', { contentBase64: logoPng().toString('base64') });
    const page = await open(browser);
    await page.goto('/');
    const img = page.getByRole('banner').locator(`img[src^="${appHref('/api/theme/logo')}"]`);
    await expect(img).toBeVisible();
    expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(120);
    const login = await open(browser, { signedIn: false });
    await login.goto('/');
    await expect(login.getByRole('img', { name: 'ACME Steward' })).toBeVisible();
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`accessibility with a bright yellow primary colour (${colorScheme})`, async ({ browser }) => {
      await srv.api('PUT', '/settings/theme', { primaryColor: '#ffd400', accentColor: '#ffeb3b', radius: 'lg' });
      const login = await open(browser, { signedIn: false, colorScheme });
      await login.goto('/');
      await expect(login.getByRole('heading', { name: /^Sign in/ })).toBeVisible();
      // enables the (filled) sign-in button
      await login.getByLabel('User name').fill('someone');
      await login.getByLabel('Password').fill('something');
      await expectAccessible(login, `sign-in page (yellow, ${colorScheme})`);

      const page = await open(browser, { colorScheme });
      for (const path of ['/', '/settings', '/about', '/settings/status', '/processes']) {
        await page.goto(path);
        await settle(page);
        await expectAccessible(page, `${path} (yellow, ${colorScheme})`);
      }
    });
  }

  test('the default colour scheme applies until users choose their own', async ({ browser }) => {
    await srv.api('PUT', '/settings/theme', { colorScheme: 'dark' });
    const page = await open(browser, { colorScheme: 'light' });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark');
    await page.getByRole('button', { name: 'Toggle color scheme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'light');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'light');
  });

  test('reset to the Steward defaults', async ({ browser }) => {
    const page = await open(browser);
    await page.goto('/settings');
    const card = page.locator('.mantine-Card-root', { has: page.getByRole('heading', { name: 'Appearance' }) });
    await card.getByRole('button', { name: `Reset to ${BRAND.name} defaults` }).click();
    await confirmDialog(page, 'Reset', { title: 'Confirm reset' });
    await expect(page.getByText(`Appearance reset to the ${BRAND.name} defaults`)).toBeVisible();
    await expect(card.getByRole('textbox', { name: 'Primary color' })).toHaveValue('#1c7ed6');
    await expect(page.getByRole('banner').getByText(BRAND.name, { exact: true })).toBeVisible();
    await expect(page.getByRole('banner').locator(`img[src^="${appHref('/api/theme/logo')}"]`)).toHaveCount(0);
    expect((await (await page.request.get('/api/theme')).json()).custom).toBe(false);
  });
});
