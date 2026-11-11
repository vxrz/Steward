import { test, expect } from './support/fixtures';
import { PROCESS, authFile } from './support/env';
import { expectNoHorizontalScroll, json, startRunApi, taskRegion, waitForRun } from './support/helpers';

/** Runs in the "mobile" project only (390×844, touch). */
test.describe('phone @mobile', () => {
  test.use({ storageState: authFile('olivia') });

  test('navigation drawer', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('main').getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
    const link = page.getByRole('navigation').getByRole('link', { name: 'My tasks' });
    // the collapsed navbar is moved off-screen
    await expect(link).not.toBeInViewport();
    await page.getByRole('button', { name: 'Toggle navigation' }).tap();
    // the drawer has the same areas as the sidebar: My tasks is in Operate, folded on the start page
    const operate = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Operate', exact: true });
    await expect(operate).toBeInViewport();
    await expect(operate).toHaveAttribute('aria-expanded', 'false');
    await operate.tap();
    await expect(link).toBeInViewport();
    await link.tap();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(page.getByRole('main').getByRole('heading', { name: 'My tasks', level: 1 })).toBeVisible();
    await expect(link).not.toBeInViewport();
  });

  test('approver decides a task on the phone', async ({ loginAs, apiAs }) => {
    const runId = await startRunApi(await apiAs('olivia'), PROCESS.accessReview1, { dryRun: true });
    await waitForRun(await apiAs('olivia'), runId, ['waiting']);

    const adam = await loginAs('adam');
    await adam.goto('/tasks');
    const task = taskRegion(adam, { runId });
    await expect(task).toBeVisible();
    await expectNoHorizontalScroll(adam);
    const submit = task.getByRole('button', { name: /^Submit selection/ });
    await submit.scrollIntoViewIfNeeded();
    await submit.tap();
    await expect(task).toBeHidden();
    const run = await waitForRun(await apiAs('olivia'), runId, ['succeeded', 'failed']);
    expect(run.status, run.error).toBe('succeeded');
  });

  test('dashboard is readable', async ({ page }) => {
    await page.goto('/dashboards/platform-operations');
    await expect(page.getByRole('heading', { name: 'Platform operations', level: 1 })).toBeVisible();
    const kpi = page.getByRole('region', { name: 'Insights Hub users', exact: true });
    await expect(kpi.locator('.viz-kpi-value')).toHaveText(/^\d+$/);
    const box = (await kpi.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(390);
    await expectNoHorizontalScroll(page);
  });

  test('users and dashboard tables are cards: nothing is cut off', async ({ loginAs }) => {
    const admin = await loginAs('admin');
    await admin.goto('/users');
    const users = admin.getByRole('list', { name: 'Users & teams' });
    const adam = users.getByRole('listitem').filter({ hasText: 'Adam Approver' });
    // the role in full (the table cut it to "AP…") and the last sign-in on the card
    await adam.scrollIntoViewIfNeeded();
    await expect(adam.getByText(/^approver$/i)).toBeInViewport({ ratio: 1 });
    await expect(adam).toContainText('Last sign-in:');
    await expectNoHorizontalScroll(admin);

    // a table widget: the identifying column first, then status and the other columns
    await admin.goto('/dashboards/access-governance');
    const cards = admin.getByTestId('table-cards').first();
    await cards.scrollIntoViewIfNeeded();
    const first = cards.getByRole('listitem').first();
    await expect(first.locator('p').first()).toHaveText(/@example\.com$/);
    await expectNoHorizontalScroll(admin);
  });

  for (const path of [
    '/',
    '/tasks',
    '/runs',
    '/processes',
    '/schedules',
    '/dashboards',
    '/platforms',
    '/settings',
    '/profile',
    '/monitors',
    '/monitors/wall',
    '/credentials',
    '/tickets',
    '/reports',
    '/records',
    '/services',
    '/triggers',
  ]) {
    test(`no horizontal scroll on ${path}`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('main').getByRole('heading', { level: 1 }).first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expectNoHorizontalScroll(page);
    });
  }

  // pages with section actions, cost tables and badges (review of 0.19: the start page, plant pages and the
  // statement of applicability overflowed without the check noticing)
  test('no horizontal scroll on plant, cost and compliance pages', async ({ loginAs, apiAs }) => {
    const api = await apiAs('admin');
    const plant = await api.put('/api/settings/plant', { data: { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} } });
    expect(plant.ok(), await plant.text()).toBe(true);
    const services = await json<{ id: string; name: string }[]>(await api.get('/api/services'));
    const shop = services.find((s) => s.name === 'Online shop (demo)') ?? services[0]!;
    const admin = await loginAs('admin');
    for (const path of [
      '/plant/assets/rvs-mill-01',
      '/plant/sites/riverside',
      `/services/${shop.id}/costs`,
      '/costs/commitments',
      '/compliance/soa/ISO27001',
    ]) {
      await admin.goto(path);
      await expect(admin.getByRole('main').getByRole('heading', { level: 1 }).first()).toBeVisible();
      await admin.waitForLoadState('networkidle');
      await expectNoHorizontalScroll(admin);
    }
  });

  test('list filters fold behind a button', async ({ page }) => {
    await page.goto('/credentials');
    await expect(page.getByRole('main').getByRole('heading', { name: 'Credentials', level: 1 })).toBeVisible();
    const filters = page.getByRole('button', { name: 'Filters', exact: true });
    const search = page.getByRole('textbox', { name: 'Search', exact: true });
    await expect(search).toBeHidden();
    await filters.tap();
    await expect(filters).toHaveAttribute('aria-expanded', 'true');
    await search.fill('zzz-no-such-entry');
    await expect(page.getByText('No entries match the filters.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Filters (1 active)' })).toBeVisible();
  });

  test('no horizontal scroll on a run page', async ({ page, apiAs }) => {
    const runId = await startRunApi(await apiAs('olivia'), PROCESS.healthCheck, { dryRun: true });
    await waitForRun(await apiAs('olivia'), runId, ['succeeded']);
    await page.goto(`/runs/${runId}`);
    await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toContainText('succeeded');
    await expectNoHorizontalScroll(page);
  });
});
