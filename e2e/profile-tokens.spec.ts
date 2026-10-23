import { request as pwRequest } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { confirmDialog, uniq } from './support/helpers';

test.use({ storageState: authFile('olivia'), permissions: ['clipboard-read', 'clipboard-write'] });

test('API token: create (read-only), copy once, use, revoke', async ({ page }) => {
  const name = uniq('E2E script');
  await page.goto('/profile');
  await page.getByRole('button', { name: 'New token' }).click();
  const create = page.getByRole('dialog', { name: 'New API token' });
  await create.getByRole('textbox', { name: 'Name' }).fill(name);
  await expect(create.getByRole('radio', { name: 'Read only' })).toBeChecked();
  await create.getByRole('button', { name: 'Create token' }).click();

  const shown = page.getByRole('dialog', { name: 'Token created' });
  await expect(shown.getByText('It is shown only once')).toBeVisible();
  const token = (await shown.getByText(/^smt_/).first().innerText()).trim();
  expect(token).toMatch(/^smt_\S{20,}$/);
  await shown.getByRole('button', { name: 'Copy' }).click();
  await expect(shown.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);
  await shown.getByRole('button', { name: 'Done' }).click();

  // afterwards only the prefix is visible
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('read only');
  await expect(row).toContainText('active');
  expect(await page.content()).not.toContain(token);

  // use it like a script would: no cookie, bearer header only
  const script = await pwRequest.newContext({
    baseURL: baseURL(),
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  });
  try {
    expect((await script.get('/api/runs')).status()).toBe(200);
    expect((await script.post('/api/runs', { data: { processId: 'ih-health-check' } })).status()).toBe(403);

    await row.getByRole('button', { name: `Revoke token ${name}` }).click();
    await confirmDialog(page, 'Revoke', { title: 'Revoke access', message: name });
    await expect(page.getByText('Token revoked')).toBeVisible();
    await expect(row).toContainText('revoked');
    expect((await script.get('/api/runs')).status()).toBe(401);
  } finally {
    await script.dispose();
  }
});
