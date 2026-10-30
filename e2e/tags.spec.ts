import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { json, uniq } from './support/helpers';

/** Tags with an optional value (#143): key, Tab to the value, Enter adds; a tag in a list filters it. */

test.use({ storageState: authFile('dana') });

test('a tag with a value is entered with Tab and Enter and filters the list', async ({ page, apiAs }) => {
  const api = await apiAs('dana');
  const name = uniq('E2E Tagged');
  const other = await json<{ id: string }>(await api.post('/api/applications', { data: { name: uniq('E2E Other'), tags: ['env=test'] } }));
  let id = '';
  try {
    await page.goto('/applications');
    await page.getByRole('button', { name: 'New application' }).first().click();
    const form = page.getByRole('dialog', { name: 'New application' });
    await form.getByRole('textbox', { name: 'Name' }).fill(name);
    const key = form.getByRole('textbox', { name: 'Tag key' });
    await key.fill('env');
    await page.keyboard.press('Escape'); // close the suggestions, keep the dialog
    await key.press('Tab');
    await expect(form.getByRole('textbox', { name: 'Value (optional)' })).toBeFocused();
    await page.keyboard.type('prod');
    await page.keyboard.press('Enter');
    await key.fill('pci');
    await key.press('Enter');
    await expect(form.getByRole('list', { name: 'Tags' })).toContainText('env: prod');
    await expect(form.getByRole('list', { name: 'Tags' })).toContainText('pci');
    await expectAccessible(page, 'tag input');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page).toHaveURL(/\/applications\/app_/);
    id = page.url().split('/').pop()!;

    // the tag on the page links to the filtered list
    await page.getByRole('link', { name: 'Show only entries tagged env: prod' }).click();
    await expect(page).toHaveURL(/tag=env%3Dprod/);
    await expect(page.getByTestId('tag-filter')).toContainText('env: prod');
    await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /E2E Other/ })).toHaveCount(0);
    // widen to every value of env
    await page.getByText('any env').click();
    await expect(page.getByRole('link', { name: /E2E Other/ })).toBeVisible();
  } finally {
    for (const x of [id, other.id].filter(Boolean)) await api.post(`/api/applications/${x}/archive`, { data: { archived: true } });
  }
});
