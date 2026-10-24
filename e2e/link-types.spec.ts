import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

/** Link types: an administrator adds one; typed external links on a service are grouped by type with icons. */
test('an administrator adds a link type; typed links on a service are grouped by type', async ({ page, loginAs, apiAs }) => {
  const typeName = uniq('E2E wiki');
  await page.goto('/records/types');
  await page.getByRole('link', { name: 'Link types' }).click();
  await expect(page).toHaveURL(/\/records\/link-types$/);
  const table = page.getByRole('table', { name: 'Link types' });
  await expect(table.getByRole('row').filter({ hasText: 'Runbook' })).toContainText('Built-in');
  await page.getByRole('button', { name: 'New link type' }).click();
  const dialog = page.getByRole('dialog', { name: 'New link type' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill(typeName);
  await chooseOption(page, 'Icon', 'Globe');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(table.getByRole('row').filter({ hasText: typeName })).toContainText('Your own');
  await settle(page);
  await expectAccessible(page, 'link types');

  // Dana adds typed links to a service
  const api = await apiAs('dana');
  const name = uniq('E2E typed links service');
  const svc = await json<{ id: string }>(await api.post('/api/services', { data: { name, owners: [] } }));
  const dana = await loginAs('dana');
  await dana.goto(`/services/${svc.id}`);
  const add = async (url: string, label: string, type: string | RegExp) => {
    await dana.getByRole('button', { name: 'Add link' }).click();
    const d = dana.getByRole('dialog', { name: 'Add link' });
    await chooseOption(dana, 'Kind', 'External link');
    await d.getByRole('textbox', { name: 'URL' }).fill(url);
    await d.getByRole('textbox', { name: 'Label' }).fill(label);
    await chooseOption(dana, 'Type', type);
    await d.getByRole('button', { name: 'Add link' }).click();
    await expect(d).toBeHidden();
  };
  await add('https://wiki.example.com/restart', 'Restart runbook', 'Runbook');
  await add('https://git.example.com/plant/gateway', 'Gateway repository', 'Repository');
  await add('https://wiki.example.com/team', 'Team page', typeName);

  const external = dana.getByTestId('external-links');
  await expect(dana.getByRole('list', { name: 'Runbook links' }).getByRole('link', { name: /Restart runbook/ })).toHaveAttribute(
    'href',
    'https://wiki.example.com/restart',
  );
  await expect(dana.getByRole('list', { name: 'Repository links' })).toContainText('Gateway repository');
  await expect(dana.getByRole('list', { name: `${typeName} links` })).toContainText('Team page');
  // built-in types first, in their order
  await expect(external.locator('[data-link-type]').first()).toHaveAttribute('data-link-type', 'runbook');
  await settle(dana);
  await expectAccessible(dana, 'typed links');

  // phone width
  await dana.setViewportSize({ width: 390, height: 844 });
  await dana.goto(`/services/${svc.id}`);
  await expect(dana.getByRole('list', { name: 'Runbook links' })).toBeVisible();
  await expectNoHorizontalScroll(dana);
});
