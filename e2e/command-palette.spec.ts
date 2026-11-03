import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { json, uniq } from './support/helpers';

test.use({ storageState: authFile('olivia') });

test('Ctrl+K finds and opens a process; "start run" opens the run dialog', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();

  await page.keyboard.press('Control+K');
  const search = page.getByRole('textbox', { name: 'Search', exact: true });
  await expect(search).toBeFocused();
  // "process" narrows the results to the Processes group (recent runs carry the same name)
  await search.fill('process health check');
  await page.getByRole('button', { name: /^Insights Hub – Platform health check/ }).click();
  await expect(page).toHaveURL(/\/processes\/ih-health-check$/);
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toContainText('Insights Hub – Platform health check');

  // the header button opens it, too
  await page.getByRole('button', { name: /^Search… / }).click();
  await search.fill('start run health');
  await page.getByRole('button', { name: 'Start run of Insights Hub – Platform health check' }).click();
  const dialog = page.getByRole('dialog', { name: 'Run: Insights Hub – Platform health check' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Start dry run' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  // pages are searchable as well (Ctrl+K toggles, so the palette must have finished closing)
  await expect(search).toBeHidden();
  await page.keyboard.press('Control+K');
  await search.fill('my tasks');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/tasks$/);
});

test.describe('palette actions (v0.4.0)', () => {
  test.use({ storageState: authFile('admin') });
  const open = async (page: import('@playwright/test').Page, query: string) => {
    const search = page.getByRole('textbox', { name: 'Search', exact: true });
    // Ctrl+K toggles: wait until a closing palette is gone
    await expect(search).toBeHidden();
    await page.keyboard.press('Control+K');
    await expect(search).toBeFocused();
    await search.fill(query);
    return search;
  };

  test('tests a connection, opens failing checks, the shortcut sheet and a new person review for a user', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();

    await open(page, 'test connection gatus');
    await page
      .getByRole('button', { name: /^Test connection to Gatus/ })
      .first()
      .click();
    await expect(page.getByRole('alert').filter({ hasText: /Connection to Gatus.* (works|failed)/ })).toBeVisible();

    await open(page, 'failing checks');
    await page.getByRole('button', { name: /^Open failing checks/ }).click();
    await expect(page).toHaveURL(/\/runs\?checks=failed&within=7d$/);
    await expect(page.getByRole('combobox', { name: 'Checks' })).toHaveValue('With findings (failed checks)');

    await open(page, 'keyboard shortcuts');
    await page.getByRole('button', { name: /^Keyboard shortcuts/ }).click();
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' }).getByTestId('shortcut-list')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden();

    await open(page, 'person review dana');
    await page.getByRole('button', { name: 'New person review for Dana Designer (dana)' }).click();
    await expect(page).toHaveURL(/\/compliance\/person-reviews/);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: /^Steward user/ })).toHaveValue('dana');
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/compliance\/person-reviews$/);
  });

  test('finds catalogue items and lists the entries opened last', async ({ page, apiAs }) => {
    const api = await apiAs('admin');
    const app = await json<{ id: string; name: string }>(await api.post('/api/applications', { data: { name: uniq('E2E palette app'), owners: [] } }));
    const svc = await json<{ id: string; name: string }>(await api.post('/api/services', { data: { name: uniq('E2E palette service') } }));
    try {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
      // an application by name
      await open(page, app.name);
      await page.getByRole('button', { name: app.name, exact: true }).click();
      await expect(page).toHaveURL((u) => u.pathname.endsWith(`/applications/${app.id}`));
      // a service page opened directly counts as well
      await page.goto(`/services/${svc.id}`);
      await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toContainText(svc.name);

      // empty query: "Recently opened" lists both, newest first
      await open(page, '');
      // the group comes first; Mantine draws group labels with CSS, so the entries are checked by position
      const actions = page.locator('.mantine-Spotlight-action');
      await expect(actions.nth(0)).toContainText(svc.name);
      await expect(actions.nth(0)).toContainText('Service');
      await expect(actions.nth(1)).toContainText(app.name);
      await expect(actions.nth(1)).toContainText('Application');
      await page.keyboard.press('Escape');
    } finally {
      await api.delete(`/api/services/${svc.id}`);
    }
  });
});

test.describe('palette actions follow the rights (viewer)', () => {
  test.use({ storageState: authFile('vera') });
  test('a viewer gets no connection tests and no new person reviews', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
    await page.keyboard.press('Control+K');
    const search = page.getByRole('textbox', { name: 'Search', exact: true });
    await search.fill('test connection');
    await expect(page.getByRole('button', { name: /^Test connection to/ })).toHaveCount(0);
    await search.fill('new person review');
    await expect(page.getByRole('button', { name: /^New person review for/ })).toHaveCount(0);
    // but failing checks and the shortcut sheet are there for everyone
    await search.fill('failing checks');
    await expect(page.getByRole('button', { name: /^Open failing checks/ })).toBeVisible();
  });
});
