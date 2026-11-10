import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { PROCESS, authFile } from './support/env';
import { json, startRunApi, waitForRun } from './support/helpers';
import { animationsDone } from './support/axe';

/**
 * axe-core checks for WCAG 2.1 A/AA. A test fails on "serious" or "critical" violations.
 * Known issues that cannot be fixed right now go into KNOWN_ISSUES with a reason (see docs/TESTING.md).
 */
const KNOWN_ISSUES: { rule: string; reason: string }[] = [
  // e.g. { rule: 'color-contrast', reason: 'third-party widget X, tracked in #123' },
];

async function expectAccessible(page: Page, name: string) {
  await animationsDone(page);
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .disableRules(KNOWN_ISSUES.map((k) => k.rule))
    .analyze();
  const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const report = bad.map(
    (v) =>
      `${v.impact} ${v.id}: ${v.help}\n${v.nodes
        .slice(0, 5)
        .map((n) => `   ${n.target.join(' ')}\n     ${n.failureSummary?.split('\n').join(' ')}`)
        .join('\n')}`,
  );
  expect(report, `accessibility violations on ${name}`).toEqual([]);
}

/**
 * Page structure beyond the WCAG 2.1 tags: exactly one level-1 heading (axe "page-has-heading-one") and buttons
 * of at least 24 × 24 px (WCAG 2.2, 2.5.8 "target-size"; links in text are exempt, stacked links are not checked yet).
 */
async function expectStructure(page: Page, name: string) {
  await expect(page.getByRole('heading', { level: 1 }), `one h1 on ${name}`).toHaveCount(1);
  const result = await new AxeBuilder({ page }).withRules(['page-has-heading-one', 'target-size']).analyze();
  const bad = result.violations
    .map((v) => ({ id: v.id, nodes: v.id === 'target-size' ? v.nodes.filter((n) => /^<button/.test(n.html)) : v.nodes }))
    .filter((v) => v.nodes.length)
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(bad, `structure violations on ${name}`).toEqual([]);
}

/** Wait for the page content (lazy routes, queries) before scanning. */
async function settle(page: Page) {
  await expect(page.getByRole('main').getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
}

test.describe('accessibility (axe, WCAG 2.1 AA)', () => {
  test.use({ storageState: authFile('admin') });

  const PAGES: [string, string][] = [
    ['dashboard', '/'],
    ['dashboards list', '/dashboards'],
    ['dashboard view', '/dashboards/platform-operations'],
    ['processes', '/processes'],
    ['process editor', `/processes/${PROCESS.healthCheck}`],
    ['runs', '/runs'],
    ['schedules', '/schedules'],
    ['monitors', '/monitors'],
    ['monitor status wall', '/monitors/wall'],
    ['platforms', '/platforms'],
    ['credentials', '/credentials'],
    ['ticket references', '/tickets'],
    ['reports', '/reports'],
    ['settings', '/settings'],
    ['users & teams', '/users'],
    ['audit log', '/audit'],
    ['profile', '/profile'],
    ['AI requests', '/mcp-requests'],
    ['status pages', '/status-pages'],
    ['exports', '/settings/exports'],
  ];
  for (const [name, path] of PAGES) {
    test(name, async ({ page }) => {
      await page.goto(path);
      await settle(page);
      await expectAccessible(page, name);
      await expectStructure(page, name);
    });
  }

  test('a service cost plan', async ({ page, apiAs }) => {
    const service = (await json<{ id: string }[]>(await (await apiAs('admin')).get('/api/services')))[0]!;
    await page.goto(`/services/${service.id}/costs`);
    await settle(page);
    await expect(page.getByTestId('service-cost-plan')).toBeVisible();
    await expectAccessible(page, 'service cost plan');
    await expectStructure(page, 'service cost plan');
  });

  test('"Skip to content" is the first focusable element and moves focus to the page', async ({ page }) => {
    await page.goto('/runs');
    await settle(page);
    await page.locator('body').focus();
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();
    // the next Tab continues inside the page, not in the header or the sidebar
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('main'))).toBe(true);
  });

  test('run detail and My tasks with an open task', async ({ page, apiAs }) => {
    const api = await apiAs('admin');
    const runId = await startRunApi(api, PROCESS.accessReview1, { dryRun: true });
    await waitForRun(api, runId, ['waiting']);
    await page.goto(`/runs/${runId}`);
    await settle(page);
    await expect(page.getByRole('region', { name: /^Task: / })).toBeVisible();
    await expectAccessible(page, 'run detail (waiting)');

    await page.goto('/tasks');
    await settle(page);
    await expect(page.getByRole('region', { name: /^Task: / }).first()).toBeVisible();
    await expectAccessible(page, 'my tasks');

    // finish the run so it does not linger
    const run = await (await api.get(`/api/runs/${runId}`)).json();
    await api.post(`/api/tasks/${run.tasks[0].id}/complete`, { data: { approved: true, selectedKeys: [] } });
    await waitForRun(api, runId, ['succeeded']);
    await page.goto(`/runs/${runId}`);
    await settle(page);
    await expectAccessible(page, 'run detail (finished, reports)');
  });

  test('dialogs: run dialog and command palette', async ({ page }) => {
    await page.goto('/processes');
    await settle(page);
    await page.getByRole('button', { name: 'Run Insights Hub – Platform health check' }).click();
    const dialog = page.getByRole('dialog', { name: /^Run: / });
    await expect(dialog).toBeVisible();
    await expectAccessible(page, 'run dialog');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.keyboard.press('Control+K');
    await expect(page.getByRole('textbox', { name: 'Search', exact: true })).toBeFocused();
    await expectAccessible(page, 'command palette');
  });

  // Open menus: the dropdown's children (Mantine's focus placeholder, aria-required-children) and red items
  // (Delete platform, Archive) on the dropdown and on the hover background (color-contrast), in both schemes.
  for (const scheme of ['light', 'dark'] as const) {
    test(`open menus (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/platforms');
      await settle(page);
      await page.getByText('Insights Hub (demo)').first().click();
      const more = page.getByRole('button', { name: 'More', exact: true });
      await more.click();
      // opening a menu focuses its first item (WAI-ARIA menu button pattern)
      await expect(page.getByRole('menuitem').first()).toBeFocused();
      await expectAccessible(page, `platform menu (${scheme})`);
      await page.getByRole('menuitem', { name: 'Delete platform' }).hover();
      await expectAccessible(page, `platform menu, red item hovered (${scheme})`);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toBeHidden();
      await expect(more).toBeFocused();

      await page.goto('/processes');
      await settle(page);
      await page
        .getByRole('button', { name: /^More actions for / })
        .first()
        .click();
      await expect(page.getByRole('menuitem', { name: 'Archive' })).toBeVisible();
      await expectAccessible(page, `process card menu (${scheme})`);
    });
  }
});

test.describe('accessibility – signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('sign-in page', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /^Sign in/ })).toBeVisible();
    await expectAccessible(page, 'sign-in page');
  });
});

test.describe('accessibility – dark color scheme', () => {
  test.use({ storageState: authFile('admin'), colorScheme: 'dark' });
  for (const [name, path] of [
    ['dashboard', '/'],
    ['dashboard view', '/dashboards/platform-operations'],
    ['process editor', `/processes/${PROCESS.healthCheck}`],
    ['credentials', '/credentials'],
    ['settings', '/settings'],
    // filled status badges ("Up", "Degraded") on the dark page
    ['monitors', '/monitors'],
  ] as const) {
    test(`${name} (dark)`, async ({ page }) => {
      await page.goto(path);
      await settle(page);
      await expectAccessible(page, `${name} (dark)`);
    });
  }
});
