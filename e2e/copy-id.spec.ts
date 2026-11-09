import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll, platformId } from './support/helpers';

/** 0.13: the id of a platform (and of the other entries the API and YAML refer to) in the header, with a copy button. */
test.use({ storageState: authFile('admin'), permissions: ['clipboard-read', 'clipboard-write'] });

test('platform page: the id is shown and copied', async ({ page, apiAs }) => {
  const id = await platformId(await apiAs('admin'), 'insights-hub');
  await page.goto(`/platforms/${id}`);
  await settle(page);
  const copyId = page.getByTestId('copy-id');
  await expect(copyId).toContainText(id);
  await copyId.getByRole('button', { name: 'Copy id' }).click();
  await expect(copyId.getByRole('status')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(id);
  await expectAccessible(page, 'platform header with its id');
});

test.describe('phone @mobile', () => {
  test('platform page: the id and its copy button fit', async ({ page, apiAs }) => {
    const id = await platformId(await apiAs('admin'), 'insights-hub');
    await page.goto(`/platforms/${id}`);
    await settle(page);
    await expect(page.getByTestId('copy-id').getByRole('button', { name: 'Copy id' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
