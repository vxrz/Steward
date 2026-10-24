import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './support/fixtures';
import { ROOT, authFile, appHref } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { BRAND } from '../shared/src/brand';

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version as string;

test.describe('About page', () => {
  test.use({ storageState: authFile('vera') });

  test('shows product, versions of web UI and server, links and third-party licenses', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'User menu' }).click();
    await page.getByRole('menuitem', { name: `About ${BRAND.name}` }).click();
    await expect(page).toHaveURL(/\/about$/);
    await expect(page.getByRole('heading', { name: `About ${BRAND.name}`, level: 2 })).toBeVisible();
    await expect(page.getByTestId('version-web')).toHaveText(VERSION);
    await expect(page.getByTestId('version-server')).toHaveText(VERSION);
    await expect(page.getByText('A newer version is running')).toHaveCount(0);
    for (const name of ['Changelog', 'Report a vulnerability (SECURITY.md)', 'Source code', 'License (Apache-2.0)']) {
      await expect(page.getByRole('link', { name })).toHaveAttribute('href', /github\.com/);
    }
    // footer: version and link back here
    const footer = page.locator('footer');
    await expect(footer).toContainText(`${BRAND.name} ${VERSION}`);
    await expect(footer.getByRole('link', { name: `About ${BRAND.name}` })).toHaveAttribute('href', appHref('/about'));

    await page.getByRole('button', { name: 'Show the list' }).click();
    const table = page.getByRole('table').filter({ hasText: 'Package' });
    await expect(table.getByRole('link', { name: 'react', exact: true })).toBeVisible();
    expect(await table.getByRole('row').count()).toBeGreaterThan(50);
    await page.getByRole('textbox', { name: 'Filter by package or license' }).fill('fastify');
    await expect(table.getByRole('link', { name: 'fastify', exact: true })).toBeVisible();
    await expect(table.getByRole('link', { name: 'react', exact: true })).toHaveCount(0);
  });

  test('is accessible', async ({ page }) => {
    await page.goto('/about');
    await settle(page);
    await page.getByRole('button', { name: 'Show the list' }).click();
    await expect(page.getByRole('table').filter({ hasText: 'Package' })).toBeVisible();
    await expectAccessible(page, 'about');
  });
});

test.describe('System status', () => {
  test('administrators: readiness, health check URLs and runtime details', async ({ loginAs }) => {
    const page = await loginAs('admin');
    await page.goto('/settings');
    await page.getByRole('link', { name: 'System status' }).click();
    await expect(page).toHaveURL(/\/settings\/status$/);
    await expect(page.getByRole('heading', { name: 'System status', level: 2 })).toBeVisible();
    await expect(page.getByTestId('readiness')).toHaveText('ready');
    await expect(page.getByText(/\/api\/health$/)).toBeVisible();
    await expect(page.getByRole('button', { name: new RegExp(`^Copy http://127\\.0\\.0\\.1:\\d+${appHref('/api/ready')}$`) })).toBeVisible();
    await expect(page.getByRole('rowheader', { name: 'Data folder' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'SQLite', exact: true }).or(page.getByRole('cell', { name: 'PostgreSQL', exact: true }))).toBeVisible();
    await expectAccessible(page, 'system status');
  });

  test('auditors see a limited view; other users neither the page nor the data', async ({ loginAs, apiAs }) => {
    const auditor = await loginAs('audrey');
    await auditor.goto('/');
    await auditor.getByRole('button', { name: 'User menu' }).click();
    await auditor.getByRole('menuitem', { name: 'System status' }).click();
    await expect(auditor.getByText(/Limited view for auditors/)).toBeVisible();
    await expect(auditor.getByRole('rowheader', { name: 'Data folder' })).toHaveCount(0);

    const viewer = await loginAs('vera');
    await viewer.goto('/');
    await viewer.getByRole('button', { name: 'User menu' }).click();
    await expect(viewer.getByRole('menuitem', { name: `About ${BRAND.name}` })).toBeVisible();
    await expect(viewer.getByRole('menuitem', { name: 'System status' })).toHaveCount(0);
    await viewer.goto('/settings/status');
    await expect(viewer.getByText('Page not found')).toBeVisible();
    expect((await (await apiAs('vera')).get('/api/system/status')).status()).toBe(403);
  });
});
