import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll, json, uniq, waitForRun } from './support/helpers';

test.use({ storageState: authFile('admin') });

/** The simulated IBM Verify Privilege Vault (server/src/mock/mockPrivilegeVault.ts). */
const VAULT = { user: 'steward-reader', password: 'demo-vault-password' };

/**
 * IBM Verify Privilege Vault (#205): adding the platform with the setup wizard (a failing sign-in, fixed, what's
 * next), and a dry run of the hygiene template against the demo vault – on a desktop and a phone.
 */
async function addWithWizard(page: Page, api: APIRequestContext, mobile: boolean) {
  const name = uniq('Vault wizard');
  await page.goto('/platforms');
  await page.getByRole('button', { name: 'Add platform' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a platform' });
  await dialog.getByRole('textbox', { name: 'Search connectors' }).fill('privilege vault');
  const connector = dialog.getByTestId('wizard-connector').filter({ hasText: 'IBM Verify Privilege Vault (privileged access, read-only)' });
  await expect(connector).toHaveCount(1);
  await connector.click();
  await dialog.getByRole('textbox', { name: 'Name' }).first().fill(name);
  await dialog.getByRole('textbox', { name: 'Base URL' }).fill(`${baseURL()}/mock/pvault/SecretServer`);
  await dialog.getByLabel('Service account (user name)', { exact: true }).fill(VAULT.user);
  await dialog.getByLabel('Password', { exact: true }).fill('wrong-password');
  await dialog.getByTestId('wizard-create').click();
  const result = dialog.getByTestId('wizard-test-result');
  await expect(result).toContainText('Connection failed');
  await expect(result).toContainText('/oauth2/token failed with HTTP 400');
  await expectAccessible(page, 'vault wizard: failed sign-in');
  if (mobile) await expectNoHorizontalScroll(page);

  await dialog.getByRole('button', { name: 'Change the settings' }).click();
  await dialog.getByLabel('Password', { exact: true }).fill(VAULT.password);
  await dialog.getByTestId('wizard-create').click();
  await expect(result).toContainText('Connection works');
  await expect(result).toContainText('every read Steward makes works');
  await dialog.getByTestId('wizard-continue').click();
  const next = dialog.getByTestId('platform-get-started');
  await expect(next.getByText('Access reviews')).toBeVisible();
  await expect(next.getByText('Privileged access governance')).toBeVisible();
  await expectAccessible(page, 'vault wizard: what next');
  await page.keyboard.press('Escape');

  const p = (await json<{ id: string; name: string; config: { auth: { type: string; refresh?: unknown } } }[]>(await api.get('/api/platforms'))).find(
    (x) => x.name === name,
  )!;
  // the preset's sign-in: a token request that renews with the refresh token
  expect(p.config.auth).toMatchObject({ type: 'token_request', refresh: { tokenPath: 'refresh_token' } });
  await api.delete(`/api/platforms/${p.id}`);
}

async function hygieneDryRun(page: Page, api: APIRequestContext, mobile: boolean) {
  await page.goto('/processes/privilege-vault-hygiene');
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toContainText('IBM Verify Privilege Vault – Secret hygiene');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  const run = page.getByRole('dialog', { name: /^Run: / });
  const slot = run.getByRole('combobox', { name: /^Connection "vault"/ });
  if (!(await slot.inputValue())) {
    await slot.click();
    await page.getByRole('option', { name: 'IBM Verify Privilege Vault (demo)' }).click();
  }
  await expect(run.getByTestId('run-mode').getByRole('radio', { name: 'Dry run' })).toBeChecked();
  await expectAccessible(page, 'vault hygiene: run dialog');
  if (mobile) await expectNoHorizontalScroll(page);
  await run.getByRole('button', { name: 'Start dry run' }).click();
  await expect(page).toHaveURL(/\/runs\/[^/]+$/);
  const runId = page.url().split('/').pop()!;
  const r = await waitForRun(api, runId, ['succeeded'], 60_000);
  expect(r).toMatchObject({ dryRun: true });
  // the check on privileged secrets: sa@sql1 in \Privileged has findings
  await expect(page.getByText('Completed with findings', { exact: true })).toBeVisible();
  await expect(page.getByText(/^sa@sql1 – heartbeat Failed, not rotated for 200 days/).first()).toBeVisible();
  await expectAccessible(page, 'vault hygiene: dry run');
  if (mobile) await expectNoHorizontalScroll(page);
}

test('adds the vault with the setup wizard: a failing sign-in, fixed, what next', async ({ page, apiAs }) => {
  await addWithWizard(page, await apiAs('admin'), false);
});

test('a dry run of the vault hygiene template', async ({ page, apiAs }) => {
  await hygieneDryRun(page, await apiAs('admin'), false);
});

test('the vault on a phone: the wizard and a hygiene dry run @mobile', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  await addWithWizard(page, api, true);
  await hygieneDryRun(page, api, true);
});
