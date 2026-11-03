import type { Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile, type UserKey } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { json, uniq } from './support/helpers';

/** The six areas of the sidebar (v0.4.0) per role, pinned entries and the addresses that moved or stayed. */

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });

/** Opens every folded area and returns its links, area by area. */
async function areas(page: Page): Promise<Record<string, string[]>> {
  const nav = sidebar(page);
  const out: Record<string, string[]> = {};
  out.Home = await nav.getByRole('link', { name: 'Home', exact: true }).allInnerTexts();
  for (const name of ['Operate', 'Automate', 'Catalogue', 'Compliance', 'Admin']) {
    const group = nav.getByRole('group', { name, exact: true });
    if (!(await group.count())) continue;
    const toggle = group.getByRole('button', { name, exact: true });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // the open-task count beside "My tasks" is not part of the name
    out[name] = (await group.getByRole('link').allInnerTexts()).map((x) => x.split('\n')[0]!.trim());
  }
  return out;
}

const OPERATE = ['Runs', 'Monitors', 'Dashboards', 'Status pages', 'Reports', 'My tasks', 'AI requests'];
const CATALOGUE = ['Services', 'Applications', 'Systems', 'Platforms', 'Credentials', 'Documents', 'Ticket references', 'Duties', 'Scorecard', 'Maintenance'];
const COMPLIANCE = ['Controls', 'Access changes', 'Access reconciliation', 'Person reviews', 'Evidence packs'];

const EXPECTED: Partial<Record<UserKey, Record<string, string[]>>> = {
  admin: {
    Home: ['Home'],
    Operate: OPERATE,
    Automate: ['Processes'],
    Catalogue: CATALOGUE,
    Compliance: COMPLIANCE,
    Admin: ['Users & teams', 'Audit log', 'Settings', 'System status'],
  },
  dana: { Home: ['Home'], Operate: OPERATE, Automate: ['Processes'], Catalogue: CATALOGUE, Compliance: COMPLIANCE },
  vera: {
    Home: ['Home'],
    Operate: OPERATE,
    Automate: ['Processes'],
    Catalogue: CATALOGUE.filter((x) => x !== 'Credentials'),
    Compliance: COMPLIANCE.filter((x) => x !== 'Evidence packs'),
  },
  audrey: {
    Home: ['Home'],
    Operate: OPERATE,
    Automate: ['Processes'],
    Catalogue: CATALOGUE,
    Compliance: COMPLIANCE,
    Admin: ['Audit log', 'System status'],
  },
};

for (const [user, expected] of Object.entries(EXPECTED) as [UserKey, Record<string, string[]>][]) {
  test.describe(`areas (${user})`, () => {
    test.use({ storageState: authFile(user) });
    test(`the sidebar of ${user} holds the pages the role can use`, async ({ page }) => {
      await page.goto('/');
      await settle(page);
      expect(await areas(page)).toEqual(expected);
    });
  });
}

test.describe('areas (status viewer)', () => {
  test.use({ storageState: authFile('stella') });
  test('a status viewer has no sidebar at all', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
  });
});

test.describe('pinned entries (designer)', () => {
  test.use({ storageState: authFile('dana') });

  test('entries pinned to the top stay there for the user, and can be unpinned', async ({ page }) => {
    await page.goto('/runs');
    await settle(page);
    const nav = sidebar(page);
    await expect(nav.getByTestId('nav-pinned')).toHaveCount(0);
    // pin Monitors (Operate is open) and Services (in the folded Catalogue)
    await nav.getByRole('button', { name: 'Pin Monitors to the top' }).click();
    await nav.getByRole('button', { name: 'Catalogue', exact: true }).click();
    await nav.getByRole('button', { name: 'Pin Services to the top' }).click();
    const pinned = nav.getByRole('group', { name: 'Pinned' });
    await expect(pinned.getByRole('link')).toHaveText(['Monitors', 'Services']);
    await expectAccessible(page, 'sidebar with pinned entries');

    // they survive a reload, and show while their area is folded
    await page.reload();
    await settle(page);
    await sidebar(page).getByRole('button', { name: 'Catalogue', exact: true }).click();
    await expect(sidebar(page).getByRole('button', { name: 'Catalogue', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebar(page).getByRole('group', { name: 'Pinned' }).getByRole('link')).toHaveText(['Monitors', 'Services']);
    await sidebar(page).getByRole('group', { name: 'Pinned' }).getByRole('link', { name: 'Services' }).click();
    await expect(page).toHaveURL(/\/services$/);

    // the folded icon rail shows them first
    await sidebar(page).getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(sidebar(page).getByTestId('nav-pinned').getByRole('link')).toHaveCount(2);
    await sidebar(page).getByRole('button', { name: 'Expand sidebar' }).click();

    // unpin both
    await sidebar(page).getByRole('group', { name: 'Pinned' }).getByRole('button', { name: 'Unpin Monitors' }).click();
    await sidebar(page).getByRole('group', { name: 'Pinned' }).getByRole('button', { name: 'Unpin Services' }).click();
    await expect(sidebar(page).getByTestId('nav-pinned')).toHaveCount(0);
  });

  test('pins belong to the user: another user in the same browser has their own', async ({ page }) => {
    // pins are stored per user id: another user's pins in this browser do not show
    await page.goto('/');
    await settle(page);
    await page.evaluate(() => localStorage.setItem('sm.nav.pins.someone-else', JSON.stringify(['/runs'])));
    await page.reload();
    await settle(page);
    await expect(sidebar(page).getByTestId('nav-pinned')).toHaveCount(0);
  });
});

test.describe('addresses (admin)', () => {
  test.use({ storageState: authFile('admin') });

  test('every page of v0.3 keeps its address; the areas have addresses of their own', async ({ page }) => {
    const pages: [string, string][] = [
      ['/runs', 'Runs'],
      ['/processes', 'Processes'],
      ['/schedules', 'Schedules'],
      ['/triggers', 'Triggers'],
      ['/git-updates', 'Git sync'],
      ['/monitors', 'Monitors'],
      ['/dashboards', 'Dashboards'],
      ['/status-pages', 'Status pages'],
      ['/tasks', 'My tasks'],
      ['/services', 'Services'],
      ['/applications', 'Applications'],
      ['/systems', 'Systems'],
      ['/platforms', 'Platforms'],
      ['/credentials', 'Credentials'],
      ['/records', 'Documents'],
      ['/tickets', 'Ticket references'],
      ['/duties', 'Duties'],
      ['/scorecard', 'Scorecard'],
      ['/maintenance', 'Maintenance'],
      ['/compliance/person-reviews', 'Person reviews'],
      ['/users', 'Users & teams'],
      ['/settings/status', 'System status'],
    ];
    for (const [path, name] of pages) {
      await page.goto(path);
      await expect(page.getByRole('main').getByRole('heading', { level: 1 }).first(), path).toBeVisible();
      // the sidebar marks the page's entry (Schedules, Triggers and Git sync: Processes)
      const entry = ['/schedules', '/triggers', '/git-updates'].includes(path) ? 'Processes' : name;
      await expect(sidebar(page).getByRole('link', { name: entry, exact: true }), path).toHaveAttribute('aria-current', 'page');
    }
    const redirects: [string, RegExp][] = [
      ['/home', /\/$/],
      ['/operate', /\/runs$/],
      ['/automate', /\/processes$/],
      ['/catalogue', /\/services$/],
      ['/compliance', /\/compliance\/controls$/],
      ['/admin', /\/users$/],
    ];
    for (const [from, to] of redirects) {
      await page.goto(from);
      await expect(page, from).toHaveURL(to);
      await expect(page.getByRole('main').getByRole('heading', { level: 1 }).first(), from).toBeVisible();
    }
  });

  test('lists switch between table and cards, and keep the choice', async ({ page }) => {
    await page.goto('/runs');
    await settle(page);
    const view = page.getByTestId('list-view-runs');
    await expect(page.getByRole('table', { name: 'Runs' })).toBeVisible();
    await view.getByText('Cards').click({ force: true });
    await expect(page.getByRole('list', { name: 'Runs' })).toBeVisible();
    await expect(page.getByRole('table')).toHaveCount(0);
    await expectAccessible(page, 'runs as cards');
    await page.reload();
    await settle(page);
    await expect(page.getByRole('list', { name: 'Runs' })).toBeVisible();
    await page.getByTestId('list-view-runs').getByText('Table').click({ force: true });
    await expect(page.getByRole('table', { name: 'Runs' })).toBeVisible();
  });

  test('an unknown tab of a service leads to its overview', async ({ page, apiAs }) => {
    const api = await apiAs('admin');
    const svc = await json(await api.post('/api/services', { data: { name: uniq('E2E hub redirect') } }));
    try {
      await page.goto(`/services/${svc.id}/no-such-tab`);
      await expect(page).toHaveURL((u) => u.pathname.endsWith(`/services/${svc.id}`));
      await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toContainText(svc.name);
    } finally {
      await api.delete(`/api/services/${svc.id}`);
    }
  });
});
