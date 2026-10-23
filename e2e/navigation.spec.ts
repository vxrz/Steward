import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { PROCESS, authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { startRunApi, waitForRun } from './support/helpers';
import { sessionState, startIsolatedServer, type IsolatedServer } from './support/server';

/** Sidebar sections, the icon-only sidebar, breadcrumbs and the command palette's pages and actions. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });

test.describe('navigation (admin)', () => {
  test.use({ storageState: authFile('admin') });

  test('the sidebar is grouped into sections that fold and stay folded', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    const nav = sidebar(page);
    for (const name of ['Operate', 'Automate', 'Service management', 'Administration']) {
      await expect(nav.getByRole('group', { name })).toBeVisible();
    }
    const automate = nav.getByRole('group', { name: 'Automate' });
    await expect(automate.getByRole('link')).toHaveText(['Processes', 'Schedules', 'Triggers', 'Updates from Git']);
    await expect(nav.getByRole('group', { name: 'Service management' }).getByRole('link')).toHaveText([
      'Services',
      'Platforms',
      'Credentials',
      'Tickets',
      'Records',
      'Reports',
    ]);

    // fold "Automate": its links disappear, the choice survives a reload
    const toggle = automate.getByRole('button', { name: 'Automate' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(nav.getByRole('link', { name: 'Schedules' })).toBeHidden();
    await page.reload();
    await expect(sidebar(page).getByRole('button', { name: 'Automate' })).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebar(page).getByRole('link', { name: 'Schedules' })).toBeHidden();

    // a folded section still opens on one of its pages
    await page.goto('/schedules');
    await settle(page);
    await expect(sidebar(page).getByRole('link', { name: 'Schedules' })).toBeVisible();
    await sidebar(page).getByRole('button', { name: 'Automate' }).click();
    await expect(sidebar(page).getByRole('button', { name: 'Automate' })).toHaveAttribute('aria-expanded', 'true');
  });

  test('the sidebar folds to icons and back', async ({ page }) => {
    await page.goto('/runs');
    await settle(page);
    const nav = sidebar(page);
    await nav.getByRole('button', { name: 'Collapse sidebar' }).click();
    const runs = nav.getByRole('link', { name: 'Runs', exact: true });
    await expect(runs).toBeVisible();
    await expect(runs).not.toContainText('Runs');
    const box = (await nav.boundingBox())!;
    expect(box.width).toBeLessThan(100);
    await nav.getByRole('link', { name: 'Monitors', exact: true }).click();
    await expect(page).toHaveURL(/\/monitors$/);
    await expectAccessible(page, 'icon-only sidebar');
    await page.reload();
    await sidebar(page).getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(sidebar(page).getByRole('link', { name: 'Monitors', exact: true })).toContainText('Monitors');
  });

  test('detail pages lead back to their list', async ({ page, apiAs }) => {
    const api = await apiAs('admin');
    const runId = await startRunApi(api, PROCESS.healthCheck, { dryRun: true });
    await waitForRun(api, runId, ['succeeded']);
    await page.goto(`/runs/${runId}`);
    await settle(page);
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
    await crumbs.getByRole('link', { name: 'Runs' }).click();
    await expect(page).toHaveURL(/\/runs$/);

    await page.goto(`/processes/${PROCESS.healthCheck}`);
    await settle(page);
    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Processes' }).click();
    await expect(page).toHaveURL(/\/processes$/);

    await page.goto('/records/types');
    await settle(page);
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Records' })).toHaveAttribute('href', '/records');

    // unknown addresses explain themselves and lead home
    await page.goto('/no-such-page');
    await expect(page.getByTestId('empty-state')).toContainText('Page not found');
    await page.getByRole('link', { name: 'Go to the dashboard' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('the command palette opens newer pages, finds monitors and starts "create" dialogs', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    const search = page.getByRole('textbox', { name: 'Search', exact: true });

    await page.keyboard.press('Control+K');
    await search.fill('record types');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/records\/types$/);
    // let the palette finish closing before it is opened again
    await settle(page);
    await expect(search).toBeHidden();

    await page.keyboard.press('Control+K');
    await search.fill('monitor machine 17 powermeter');
    await page.getByRole('button', { name: /^Machine 17 – PowerMeter/ }).click();
    await expect(page).toHaveURL(/\/monitors\/[^/]+$/);
    await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toContainText('Machine 17 – PowerMeter');
    await settle(page);
    // Ctrl+K toggles: pressed while the palette is still closing, it would close it instead of opening it
    await expect(search).toBeHidden();

    await page.keyboard.press('Control+K');
    await search.fill('new record');
    await page.getByRole('button', { name: 'New record', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'New record' })).toBeVisible();
    // the ?new=1 parameter is consumed: reloading does not open the dialog again
    await expect(page).toHaveURL(/\/records$/);
  });
});

test.describe('navigation (viewer)', () => {
  test.use({ storageState: authFile('vera') });

  test('sections only list the pages the user may open', async ({ page }) => {
    await page.goto('/');
    await settle(page);
    const admin = sidebar(page).getByRole('group', { name: 'Administration' });
    await expect(admin.getByRole('link')).toHaveText(['Settings']);
    await expect(sidebar(page).getByRole('link', { name: 'Updates from Git' })).toHaveCount(0);
    await page.keyboard.press('Control+K');
    await page.getByRole('textbox', { name: 'Search', exact: true }).fill('new monitor');
    await expect(page.getByRole('button', { name: 'New monitor', exact: true })).toHaveCount(0);
  });
});

test.describe('first steps on an empty installation (own server)', () => {
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
  async function open(browser: Browser): Promise<Page> {
    const ctx = await browser.newContext({
      baseURL: srv.baseURL,
      serviceWorkers: 'block',
      locale: 'en-GB',
      storageState: sessionState(srv.baseURL, srv.adminCookie, srv),
    });
    contexts.push(ctx);
    return ctx.newPage();
  }

  test('the getting-started checklist tracks progress and can be hidden', async ({ browser }) => {
    const page = await open(browser);
    await page.goto('/');
    const checklist = page.getByRole('region', { name: 'Get started' });
    await expect(checklist).toBeVisible();
    await expect(checklist).toContainText('0 of 8 done');
    await expectAccessible(page, 'dashboard with checklist');

    await srv.api('POST', '/credentials', { name: 'Gateway certificate', type: 'certificate' });
    await page.reload();
    await expect(checklist).toContainText('1 of 8 done');
    await expect(checklist.getByRole('listitem').filter({ hasText: 'Document your credentials' })).toHaveAttribute('data-done', 'true');

    // a step opens the page with its create dialog
    await checklist.getByRole('link', { name: 'Schedule a process' }).click();
    await expect(page).toHaveURL(/\/schedules$/);
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.goto('/');
    await checklist.getByRole('button', { name: 'Hide the getting-started checklist' }).click();
    await expect(checklist).toBeHidden();
    await page.reload();
    await expect(page.getByRole('main').getByRole('heading', { name: 'Dashboard', level: 2 })).toBeVisible();
    await expect(checklist).toBeHidden();
  });

  test('empty lists explain the page and offer the first action', async ({ browser }) => {
    const page = await open(browser);
    const cases: [string, string, string][] = [
      ['/runs', 'No runs yet', 'Open processes'],
      ['/schedules', 'No schedules yet', 'Create your first schedule'],
      ['/triggers', 'No webhook triggers yet', 'Create your first webhook trigger'],
      ['/monitors', 'No monitors yet', 'Create your first monitor'],
      ['/services', 'No services yet', 'Add your first service'],
      ['/records', 'No records yet', 'Write your first record'],
      ['/reports', 'No report schedules yet', 'Create your first report schedule'],
      ['/processes', 'No processes yet', 'Browse templates'],
      ['/platforms', 'No platforms yet', 'Add your first platform'],
    ];
    for (const [path, title, action] of cases) {
      await page.goto(path);
      const empty = page.getByTestId('empty-state');
      await expect(empty, path).toContainText(title);
      await expect(empty.getByRole(action === 'Open processes' ? 'link' : 'button', { name: action }), path).toBeVisible();
    }
    await expectAccessible(page, 'empty platforms page');
  });
});
