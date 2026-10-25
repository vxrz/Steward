import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { MASTER_PASSPHRASE } from './support/env';
import { expectAccessible } from './support/axe';
import { sessionState, startIsolatedServer, type IsolatedServer } from './support/server';

/**
 * Moving an instance (Settings → Migration): export on one server, then import on another with the review of
 * the identity mapping. Both servers are own instances (the import needs an empty target).
 */
test.describe('migration: export and import with the identity mapping (own servers)', () => {
  test.describe.configure({ mode: 'serial' });
  let source: IsolatedServer;
  let target: IsolatedServer;
  const contexts: BrowserContext[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-e2e-move-'));
  const pkg = path.join(dir, 'move.smig');
  const TRANSFER = 'e2e transfer passphrase';
  let fingerprint = '';

  test.beforeAll(async () => {
    [source, target] = await Promise.all([startIsolatedServer(), startIsolatedServer()]);
    await source.api('POST', '/users', {
      username: 'erika',
      displayName: 'Erika Example',
      email: 'erika@corp.example',
      roles: ['operator'],
      password: 'Erika-password-1',
    });
    await source.api('POST', '/teams', { name: 'Plant team', members: ['erika'] });
  });
  test.afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => undefined);
    await Promise.all([source?.stop(), target?.stop()]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function open(browser: Browser, srv: IsolatedServer, viewport?: { width: number; height: number }): Promise<Page> {
    const ctx = await browser.newContext({
      baseURL: srv.baseURL,
      serviceWorkers: 'block',
      locale: 'en-GB',
      acceptDownloads: true,
      ...(viewport ? { viewport } : {}),
      storageState: sessionState(srv.baseURL, srv.adminCookie, srv),
    });
    contexts.push(ctx);
    return ctx.newPage();
  }

  test('exports a package from Settings with the master passphrase', async ({ browser }) => {
    const page = await open(browser, source);
    await page.goto('/settings');
    await page.getByRole('link', { name: 'Open migration' }).click();
    await expect(page.getByRole('heading', { name: 'Migration', level: 2 })).toBeVisible();
    const card = page.locator('.mantine-Card-root', { has: page.getByRole('heading', { name: 'Export this instance' }) });
    await card.getByLabel(/^Master passphrase of this instance/).fill(MASTER_PASSPHRASE);
    await card.getByLabel(/^Transfer passphrase/).fill(TRANSFER);
    await card.getByLabel(/^Repeat the transfer passphrase/).fill(TRANSFER);
    await card.getByRole('button', { name: 'Export package' }).click();
    const result = page.getByTestId('export-result');
    await expect(result).toContainText('Package ready');
    fingerprint = (await result.locator('code').first().textContent()) ?? '';
    expect(fingerprint).toMatch(/^[0-9a-f]{4}(:[0-9a-f]{4}){7}$/);
    const [download] = await Promise.all([page.waitForEvent('download'), result.getByRole('link', { name: /^Download steward-/ }).click()]);
    await download.saveAs(pkg);
    expect(fs.readFileSync(pkg).subarray(0, 20).toString()).toBe('STEWARD-MIGRATION 1\n');
  });

  test('imports it after a dry run and a review of the identity mapping', async ({ browser }) => {
    const page = await open(browser, target);
    await page.goto('/settings/migration');
    const card = page.locator('.mantine-Card-root', { has: page.getByRole('heading', { name: 'Import a package' }) });
    await card.locator('input[type="file"]').setInputFiles(pkg);
    await card.getByLabel(/^Transfer passphrase/).fill(TRANSFER);
    await card.getByRole('button', { name: 'Check package' }).click();
    const plan = page.getByTestId('migration-plan');
    await expect(plan).toContainText('Audit log verified');
    await expect(page.getByTestId('source-fingerprint')).toHaveText(fingerprint);

    // the source's administrator: suggested for the administrator here (same name) – needs a confirmation
    const admin = page.getByTestId('map-user-admin');
    await expect(admin.getByTestId('map-preview-admin')).toHaveText('local: admin → admin (existing account)');
    await admin.getByRole('checkbox', { name: 'I confirm the decision for this administrator of the source' }).check();
    // erika becomes a single sign-on account
    const erika = page.getByTestId('map-user-erika');
    await expect(erika.getByLabel('Becomes')).toHaveValue('A new single sign-on account');
    await erika.getByLabel('User name here').fill('erika.example@corp.example');
    await expect(erika.getByTestId('map-preview-erika')).toHaveText('local: erika → erika.example@corp.example (new single sign-on account)');
    await expect(page.getByTestId('map-team-Plant team').getByLabel('Becomes')).toHaveValue('A new team');
    await expectAccessible(page, 'migration: mapping review');

    const importButton = page.getByRole('button', { name: 'Import', exact: true });
    await expect(importButton).toBeDisabled();
    await page.getByRole('checkbox', { name: 'The fingerprint matches the source' }).check();
    await importButton.click();
    await expect(page.getByTestId('import-result')).toContainText('Imported');

    // the import, its verification and the mapping table
    const item = page.locator('[data-testid^="import-imp_"]');
    await expect(item.getByTestId('import-verification')).toHaveText('Verified');
    await expect(item.getByRole('table', { name: 'Identity mapping' })).toContainText('local: erika');
    await expect(item.getByRole('table', { name: 'Identity mapping' })).toContainText('erika.example@corp.example (new single sign-on account)');
    await item.getByRole('button', { name: /^Show the imported audit history/ }).click();
    await expect(item.getByTestId('imported-history')).toContainText('instance.exported');
  });

  test('the migration page fits a phone', async ({ browser }) => {
    const page = await open(browser, target, { width: 390, height: 844 });
    await page.goto('/settings/migration');
    await expect(page.getByRole('heading', { name: 'Imports into this instance' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
