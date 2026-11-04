import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { expectAccessible } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json, startRunFromDialog, taskRegion, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

/** The simulated Entra ID tenant (server/src/mock/mockGraph.ts). */
const GRAPH = { tenantId: '7d3c1a52-0b6e-4f39-9a1e-2c4f5e6d7a8b', clientId: '5f1e2d3c-4b5a-4968-8776-655443322110', secret: 'demo-graph-client-secret' };

/**
 * Microsoft Graph / Entra ID (v0.5.0): adding the platform through the setup wizard – a wrong secret explained, then
 * the test with every permission readable and what's next (the Entra ID templates, the bundle, access reviews) – and a
 * dry run of the guest review on the demo tenant.
 */
// once on the desktop, once at phone width (the mobile project runs the tests tagged @mobile)
for (const tag of ['', ' @mobile']) {
  test(`the setup wizard adds a Microsoft Graph platform: a wrong secret explained, then the Entra ID templates and bundle${tag}`, async ({ page, apiAs }) => {
    const name = uniq('Entra wizard');
    await page.goto('/platforms');
    await page.getByRole('button', { name: 'Add platform' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a platform' });
    await dialog.getByRole('textbox', { name: 'Search connectors' }).fill('microsoft graph');
    await expect(dialog.getByTestId('wizard-connector')).toHaveCount(1);
    await dialog.getByTestId('wizard-connector').filter({ hasText: 'Microsoft Graph (Entra ID, read-only)' }).click();

    await dialog.getByRole('textbox', { name: 'Name' }).first().fill(name);
    await dialog.getByRole('textbox', { name: 'Base URL' }).fill(`${baseURL()}/mock/graph`);
    // the variables tenantId and loginUrl, in this order
    const values = dialog.getByRole('textbox', { name: 'Value' });
    await values.nth(0).fill(GRAPH.tenantId);
    await values.nth(1).fill(`${baseURL()}/mock/graph/login`);
    await dialog.getByLabel('Application (client) ID', { exact: true }).fill(GRAPH.clientId);
    await dialog.getByLabel('Client secret (or use a certificate)', { exact: true }).fill('wrong-secret');
    await expectAccessible(page, 'setup wizard: Microsoft Graph settings');
    await dialog.getByTestId('wizard-create').click();
    const result = dialog.getByTestId('wizard-test-result');
    await expect(result).toContainText('Connection failed');
    await expect(result).toContainText('the client secret is wrong');
    await expect(result).not.toContainText('wrong-secret');

    await dialog.getByRole('button', { name: 'Change the settings' }).click();
    await dialog.getByLabel('Client secret (or use a certificate)', { exact: true }).fill(GRAPH.secret);
    await dialog.getByTestId('wizard-create').click();
    await expect(result).toContainText('Connection works');
    await expect(result).toContainText('signed in to Contoso (demo)');
    await expect(result).toContainText('✓ Eligible roles, PIM (RoleManagement.Read.Directory, Entra ID P2): readable');
    await expectAccessible(page, 'setup wizard: Microsoft Graph test');
    await dialog.getByTestId('wizard-continue').click();

    const next = dialog.getByTestId('platform-get-started');
    await expect(next.getByText('Entra ID access governance')).toBeVisible();
    await expect(next.getByText('Entra ID – Guest user review')).toBeVisible();
    await expect(next.getByText('Access reviews')).toBeVisible();
    await expect(next.getByText('Entra ID (Microsoft Graph)')).toBeVisible();
    await expectAccessible(page, 'setup wizard: Entra ID what next');
    await expectNoHorizontalScroll(page);
    await next.getByRole('link', { name: 'Create an access check' }).click();
    const check = page.getByRole('dialog', { name: 'New check' });
    await expect(check.getByRole('combobox', { name: 'Source' })).toHaveValue('Entra ID users, groups, roles and app roles');
    await expect(check.getByRole('combobox', { name: 'What to read' })).toHaveValue('Everything');
    await page.keyboard.press('Escape');

    const api = await apiAs('admin');
    const p = (await json<{ id: string; name: string }[]>(await api.get('/api/platforms'))).find((x) => x.name === name)!;
    await api.delete(`/api/platforms/${p.id}`);
  });

  test(`a dry run of the Entra ID guest review: every guest kept, nothing removed${tag}`, async ({ page, apiAs }) => {
    await page.goto('/processes/entra-guest-review');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const runId = await startRunFromDialog(page, { dryRun: true, platform: /Microsoft Graph \(demo\)/ });
    await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toContainText('dry run');
    const task = taskRegion(page, { title: /^Task: Guest review: tick the 3 guest\(s\) who keep access/ });
    await expect(task).toBeVisible();
    await expect(task.getByText('Paula Partner <paula@fabrikam.example>')).toBeVisible();
    await expect(task.getByText('PendingAcceptance')).toBeVisible();
    await expectAccessible(page, 'guest review task');
    await expectNoHorizontalScroll(page);
    // keep everyone: no removal, no four-eyes step
    const all = task.getByRole('checkbox', { name: 'Select all' });
    if (!(await all.isChecked())) await all.check();
    await task.getByRole('button', { name: 'Submit selection (3)' }).click();
    await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toContainText('completed with findings', { timeout: 30_000 });
    await page.getByRole('tab', { name: 'Reports (1)' }).click();
    await expect(page.getByText('Guest user review', { exact: true })).toBeVisible();
    await expect(page.getByText(/Kept: 3/)).toBeVisible();

    const api = await apiAs('admin');
    const run = await json(await api.get(`/api/runs/${runId}`));
    expect(run).toMatchObject({ status: 'succeeded', dryRun: true });
    expect(run.stats.writes).toBe(0);
  });
}

test('Credentials → Import from Entra ID: a preview, then entries with the end date as the expiry', async ({ page, apiAs }) => {
  await page.goto('/credentials');
  await page.getByTestId('entra-import').click();
  const dialog = page.getByRole('dialog', { name: 'Import app credentials from Entra ID' });
  // the demo platform (the wizard test may add another one meanwhile)
  const select = dialog.getByRole('combobox', { name: 'Microsoft Graph platform' });
  if ((await select.inputValue()) !== 'Microsoft Graph (demo)') await chooseOption(page, 'Microsoft Graph platform', 'Microsoft Graph (demo)');
  await dialog.getByRole('textbox', { name: 'Only those that end within (days)' }).fill('5');
  await dialog.getByTestId('entra-import-preview-button').click();
  const preview = dialog.getByTestId('entra-import-preview');
  await expect(preview.getByRole('row').filter({ hasText: 'Legacy Reports' })).toBeVisible();
  await expectAccessible(page, 'Entra ID import preview');
  const api = await apiAs('admin');
  const before = await json<{ items: { name: string }[] }>(await api.get('/api/credentials?q=Legacy%20Reports'));
  if (!before.items.length) {
    await expect(preview.getByRole('row').filter({ hasText: 'Legacy Reports' })).toContainText('new entry');
    await dialog.getByTestId('entra-import-submit').click();
    await expect(dialog).toBeHidden();
  } else await page.keyboard.press('Escape');
  await expect(page.getByRole('row').filter({ hasText: 'Legacy Reports – certificate' })).toBeVisible();
  const after = await json<{ items: { name: string; expiresAt: string | null; tags: string[] }[] }>(await api.get('/api/credentials?q=Legacy%20Reports'));
  expect(after.items[0]).toMatchObject({ name: 'Legacy Reports – certificate “CN=legacy-reports”', tags: ['entra-id'] });
  expect(after.items[0]!.expiresAt).not.toBeNull();
});
