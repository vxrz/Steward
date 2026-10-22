import { test, expect } from './support/fixtures';
import { PROCESS, authFile } from './support/env';
import { expectNoHorizontalScroll, startRunApi, taskRegion, waitForRun } from './support/helpers';

/** Runs in the "mobile" project only (390×844, touch). */
test.describe('phone @mobile', () => {
  test.use({ storageState: authFile('olivia') });

  test('navigation drawer', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('main').getByRole('heading', { name: 'Dashboard', level: 2 })).toBeVisible();
    const link = page.getByRole('navigation').getByRole('link', { name: 'My tasks' });
    // the collapsed navbar is moved off-screen
    await expect(link).not.toBeInViewport();
    await page.getByRole('button', { name: 'Toggle navigation' }).tap();
    await expect(link).toBeInViewport();
    await link.tap();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(page.getByRole('main').getByRole('heading', { name: 'My tasks', level: 2 })).toBeVisible();
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
    await expect(page.getByRole('heading', { name: 'Platform operations', level: 2 })).toBeVisible();
    const kpi = page.getByRole('region', { name: 'Insights Hub users', exact: true });
    await expect(kpi.locator('.viz-kpi-value')).toHaveText(/^\d+$/);
    const box = (await kpi.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(390);
    await expectNoHorizontalScroll(page);
  });

  for (const path of ['/', '/tasks', '/runs', '/processes', '/schedules', '/dashboards', '/platforms', '/settings', '/profile', '/monitors', '/monitors/wall']) {
    test(`no horizontal scroll on ${path}`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('main').getByRole('heading', { level: 2 }).first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expectNoHorizontalScroll(page);
    });
  }

  test('no horizontal scroll on a run page', async ({ page, apiAs }) => {
    const runId = await startRunApi(await apiAs('olivia'), PROCESS.healthCheck, { dryRun: true });
    await waitForRun(await apiAs('olivia'), runId, ['succeeded']);
    await page.goto(`/runs/${runId}`);
    await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toContainText('succeeded');
    await expectNoHorizontalScroll(page);
  });
});
