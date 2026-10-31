import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { animationsDone, expectAccessible } from './support/axe';
import { json, uniq } from './support/helpers';

/**
 * Systems (#129): a designer adds a system with its stack, an application runs on it in an environment ("Runs on",
 * grouped by environment), components carry an environment and can be filtered by it, and an administrator orders
 * the environments in the settings.
 */

test.describe('as a designer', () => {
  test.use({ storageState: authFile('dana') });

  test('a system with its stack; an application runs on it per environment', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const appName = uniq('E2E Shop');
    const sysName = uniq('e2e-db');
    const app = await json<{ id: string }>(await api.post('/api/applications', { data: { name: appName, owners: [] } }));
    let systemId = '';
    try {
      // create the system on the Systems page
      await page.goto('/systems');
      await page.getByRole('button', { name: 'New system' }).first().click();
      const form = page.getByRole('dialog', { name: 'New system' });
      await form.getByRole('textbox', { name: 'Name' }).fill(sysName);
      await form.getByRole('textbox', { name: 'Kind' }).click();
      await animationsDone(page);
      await page.getByRole('option', { name: 'Virtual machine' }).click();
      await form.getByRole('textbox', { name: 'Vendor / provider' }).fill('On-premises');
      await form.getByRole('button', { name: 'Add product' }).click();
      await page.getByRole('textbox', { name: 'Product' }).fill('Ubuntu');
      await page.getByRole('option', { name: 'Ubuntu', exact: true }).click();
      await form.getByRole('textbox', { name: 'Version' }).fill('24.04');
      await expectAccessible(page, 'system dialog');
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(page).toHaveURL(/\/systems\/sys_/);
      systemId = page.url().split('/').pop()!;
      await expect(page.getByRole('heading', { name: sysName })).toBeVisible();
      await expect(page.getByTestId('system-stack')).toContainText('Ubuntu 24.04');
      await expect(page.getByTestId('system-applications')).toContainText('No application runs on this system yet.');
      await expectAccessible(page, 'system page');

      // the application runs on it in prod
      await page.goto(`/applications/${app.id}`);
      const runsOn = page.getByTestId('application-runs-on');
      await runsOn.getByRole('button', { name: 'Add system' }).click();
      const link = page.getByRole('dialog', { name: `Add a system to ${appName}` });
      await link.getByRole('textbox', { name: 'System' }).fill(sysName);
      await page.getByRole('option', { name: new RegExp(sysName) }).click();
      await link.getByRole('textbox', { name: 'Environment' }).fill('prod');
      await link.getByRole('button', { name: 'Save' }).click();
      await expect(link).toBeHidden();
      const prod = runsOn.getByTestId('runs-on-prod');
      await expect(prod.getByRole('link', { name: sysName })).toBeVisible();
      await expect(prod).toContainText('Ubuntu 24.04');
      // the system's stack is part of the application's stack
      await expect(page.getByTestId('application-stack')).toContainText('Ubuntu 24.04');

      // components with an environment, filtered
      for (const [n, env] of [
        ['SHOP_DEV', 'dev'],
        ['SHOP_PROD', 'prod'],
      ])
        await api.post(`/api/applications/${app.id}/components`, { data: { type: 'snowflake-database', name: n, environment: env } });
      await api.post(`/api/applications/${app.id}/components`, { data: { type: 'repository', name: 'acme/shop' } });
      await page.reload();
      const components = page.getByTestId('application-components');
      await expect(components.getByRole('row')).toHaveCount(4);
      await page.getByTestId('components-environment-filter').getByText('prod', { exact: true }).click();
      // prod and the components of all environments
      await expect(components.getByRole('row')).toHaveCount(3);
      await expect(components).toContainText('SHOP_PROD');
      await expect(components).toContainText('acme/shop');
      await expect(components).not.toContainText('SHOP_DEV');
      await expectAccessible(page, 'application with systems');

      // the system lists the application with its environment
      await page.goto(`/systems/${systemId}`);
      const apps = page.getByTestId('system-applications');
      await expect(apps.getByRole('row', { name: new RegExp(appName) })).toContainText('prod');
    } finally {
      const a = await json<{ systems: { id: string }[] }>(await api.get(`/api/applications/${app.id}`));
      for (const l of a.systems) await api.delete(`/api/applications/${app.id}/systems/${l.id}`);
      if (systemId) await api.delete(`/api/systems/${systemId}`);
      await api.post(`/api/applications/${app.id}/archive`, { data: { archived: true } });
    }
  });
});

test.describe('as an administrator', () => {
  test.use({ storageState: authFile('admin') });

  test('orders the environments in the settings', async ({ page, apiAs }) => {
    const api = await apiAs('admin');
    const before = await json<{ environments: unknown[] }>(await api.get('/api/catalogue/environments'));
    try {
      await page.goto('/settings/catalogue');
      const card = page.getByTestId('environments-card');
      await expect(card.getByRole('textbox', { name: 'Name' })).toHaveCount(before.environments.length);
      await card.getByRole('button', { name: 'Add environment' }).click();
      await card.getByRole('textbox', { name: 'Name' }).last().fill('staging');
      await card.getByRole('button', { name: 'Move staging up' }).click();
      await expectAccessible(page, 'environments settings');
      await card.getByRole('button', { name: 'Save environments' }).click();
      await expect(page.getByText('Environments saved.')).toBeVisible();
      const after = await json<{ environments: { name: string }[] }>(await api.get('/api/catalogue/environments'));
      expect(after.environments.map((e) => e.name)).toEqual(['dev', 'test', 'staging', 'prod']);
    } finally {
      await api.put('/api/catalogue/environments', { data: { environments: before.environments } });
    }
  });
});
