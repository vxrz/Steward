import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { json, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

const processYaml = (id: string, name: string, message: string) => `id: ${id}
name: "${name}"
description: A process that lives in Git (UI test).
steps:
  - id: hello
    type: log
    message: "${message}"
`;

test('admin configures a Git source, reviews the diff and accepts a new process version', async ({ page, request, apiAs }) => {
  const tag = uniq('e2e').split(' ')[1]!;
  const repo = `e2e/lib-${tag}`;
  const id = `e2e-git-${tag}`;
  const name = `E2E Git process ${tag}`;
  const file = `steward/processes/${id}.yaml`;
  const commit = async (message: string) =>
    json(await request.post('/mock/git/_commit', { data: { repo, signed: true, files: { [file]: processYaml(id, name, message), 'README.md': '# e2e' } } }));
  await commit('first version');
  const sourceName = `Git library ${tag}`;

  // ---- configure the source (Settings → Git sync) ----
  await page.goto('/settings/integrations');
  await page.getByRole('link', { name: 'Manage Git sync' }).click();
  await expect(page).toHaveURL(/\/settings\/git-sync$/);
  // Steward's own example library is there, disabled, following the tag of this version
  const examples = page.getByTestId('sync-source').filter({ hasText: 'Steward example library' });
  await expect(examples).toContainText('Steward examples');
  await expect(examples).toContainText('disabled');
  await expect(examples).toContainText(/tag v\d+\.\d+\.\d+/);
  await page.getByRole('button', { name: 'New source' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New Git sync source' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill(sourceName);
  await dialog.getByRole('textbox', { name: 'Repository URL' }).fill(`${baseURL()}/mock/git/${repo}`);
  await dialog.getByRole('textbox', { name: 'Folder' }).fill('steward');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Source saved')).toBeVisible();
  const card = page.getByTestId('sync-source').filter({ hasText: sourceName });
  await expect(card).toContainText('never fetched');

  // ---- fetch: the file is staged, nothing applied ----
  await card.getByRole('button', { name: 'Fetch now' }).click();
  await expect(page.getByText(/1 staged for review/)).toBeVisible();
  await expect(card.getByRole('link', { name: '1 open update' })).toBeVisible();
  await card.getByRole('link', { name: '1 open update' }).click();
  await expect(page).toHaveURL(/\/git-updates\?source=/);
  const row = page.getByTestId('sync-update').filter({ hasText: name });
  await expect(row).toContainText('new');
  await expect(row).toContainText(file);
  await settle(page);
  await expectAccessible(page, 'Updates from Git');

  // ---- review and accept the new process ----
  await row.getByRole('link', { name }).click();
  await expect(page.getByText('This item does not exist in Steward yet. Accepting creates it.')).toBeVisible();
  await expect(page.getByTestId('version-diff')).toContainText('first version');
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/processes/${id}$`));
  const heading = page.getByRole('main').getByRole('heading', { level: 2 });
  await expect(heading).toContainText('v1');
  await expect(page.getByTestId('git-origin')).toBeVisible();

  // ---- a change in Git → a reviewed diff → a new version ----
  await commit('second version');
  const api = await apiAs('admin');
  const sources = await json<{ id: string; name: string }[]>(await api.get('/api/sync-sources'));
  const src = sources.find((s) => s.name === sourceName)!;
  const fetched = await json<{ staged: number }>(await api.post(`/api/sync-sources/${src.id}/fetch`));
  expect(fetched.staged).toBe(1);

  await page.goto('/git-updates');
  await page.getByTestId('sync-update').filter({ hasText: name }).getByRole('link', { name }).click();
  await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toContainText('change');
  const diff = page.getByTestId('version-diff');
  await expect(diff).toContainText('first version');
  await expect(diff).toContainText('second version');
  await settle(page);
  await expectAccessible(page, 'Update from Git');
  await page.getByRole('textbox', { name: 'Comment (optional)' }).fill('Reviewed in the UI test');
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/processes/${id}$`));
  await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toContainText('v2');
  const versions = await json<{ version: number; comment: string }[]>(await api.get(`/api/processes/${id}/versions`));
  expect(versions[0]).toMatchObject({ version: 2, comment: expect.stringContaining('Reviewed in the UI test') });
  expect(versions[0]!.comment).toContain(`From Git: ${sourceName} ${file}`);

  // clean up: the source goes, the process keeps its versions
  await api.delete(`/api/sync-sources/${src.id}`);
});

test('viewers neither see nor open the Updates from Git inbox', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: authFile('vera'), baseURL: baseURL() });
  const page = await ctx.newPage();
  await page.goto('/git-updates');
  await expect(page.getByText('Only designers and administrators review updates from Git.')).toBeVisible();
  await ctx.close();
});

test('admin requires signed commits from named signers and sees why a fetch is refused', async ({ page, request, apiAs }) => {
  const tag = uniq('e2e').split(' ')[1]!;
  const repo = `e2e/signed-${tag}`;
  const file = `steward/processes/e2e-signed-${tag}.yaml`;
  const commit = async (message: string, o: { signed: boolean; signer: string }) =>
    json<{ sha: string }>(
      await request.post('/mock/git/_commit', { data: { repo, ...o, files: { [file]: processYaml(`e2e-signed-${tag}`, `Signed ${tag}`, message) } } }),
    );
  await commit('first version', { signed: true, signer: 'alice' });
  const sourceName = `Signed library ${tag}`;

  await page.goto('/settings/git-sync');
  await page.getByRole('button', { name: 'New source' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New Git sync source' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill(sourceName);
  await dialog.getByRole('textbox', { name: 'Repository URL' }).fill(`${baseURL()}/mock/git/${repo}`);
  await dialog.getByRole('textbox', { name: 'Folder' }).fill('steward');
  await dialog.getByText('Require signed commits').click();
  await expect(dialog.getByText(/every new commit since the last fetch/)).toBeVisible();
  const signers = dialog.getByRole('textbox', { name: 'Allowed signers (optional)' });
  await signers.fill('alice');
  await signers.press('Enter');
  await settle(page);
  await expectAccessible(page, 'Git sync source dialog');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Source saved')).toBeVisible();
  const card = page.getByTestId('sync-source').filter({ hasText: sourceName });
  await card.getByRole('button', { name: 'Fetch now' }).click();
  await expect(page.getByText(/1 staged for review/)).toBeVisible();

  // an unsigned commit below a signed head: refused, nothing staged
  const { sha } = await commit('unsigned change', { signed: false, signer: 'mallory' });
  await commit('signed on top', { signed: true, signer: 'alice' });
  await card.getByRole('button', { name: 'Fetch now' }).click();
  await expect(page.getByText(`Commit ${sha.slice(0, 10)} on main (new since the last fetched commit`).first()).toBeVisible();
  await expect(card.getByRole('link', { name: '1 open update' })).toBeVisible();

  const api = await apiAs('admin');
  const src = (await json<{ id: string; name: string; allowedSigners: string[] }[]>(await api.get('/api/sync-sources'))).find((s) => s.name === sourceName)!;
  expect(src.allowedSigners).toEqual(['alice']);
  await api.delete(`/api/sync-sources/${src.id}`);
});
