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
  // it says which host to allow and that GitHub limits calls without a token, before the first fetch
  await expect(examples).toContainText('allow api.github.com');
  await expect(examples.getByTestId('github-limit-hint')).toContainText('Public repositories (read-only)');
  await page.getByRole('button', { name: 'New source' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New Git sync source' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill(sourceName);
  await dialog.getByRole('textbox', { name: 'Repository URL' }).fill(`${baseURL()}/mock/git/${repo}`);
  await dialog.getByRole('textbox', { name: 'Folder' }).fill('steward');
  // the token goes to the Git host: the browser must not fill in the password saved for Steward
  await expect(dialog.locator('input[type="password"]')).toHaveAttribute('autocomplete', 'new-password');
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
  const heading = page.getByRole('main').getByRole('heading', { level: 1 });
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
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toContainText('change');
  const diff = page.getByTestId('version-diff');
  await expect(diff).toContainText('first version');
  await expect(diff).toContainText('second version');
  await settle(page);
  await expectAccessible(page, 'Update from Git');
  await page.getByRole('textbox', { name: 'Comment (optional)' }).fill('Reviewed in the UI test');
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/processes/${id}$`));
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toContainText('v2');
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
  await expect(page.getByText('Only designers and administrators review Git sync updates.')).toBeVisible();
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
  await dialog.getByLabel('Require signed commits').click();
  await expect(dialog.getByText(/every new commit since the last fetch/)).toBeVisible();
  const signers = dialog.getByRole('combobox', { name: 'Allowed signers (optional)' });
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

test("a GitHub rate limit is shown as such, in the reader's time, and nothing is staged", async ({ page, request, apiAs, allowConsole }) => {
  // the fetch is refused on purpose: Steward answers 502 for the Git host's error
  allowConsole(/the server responded with a status of 502/);
  const tag = uniq('e2e').split(' ')[1]!;
  const repo = `e2e/limited-${tag}`;
  await request.post('/mock/git/_commit', {
    data: { repo, signed: true, files: { [`steward/processes/e2e-limited-${tag}.yaml`]: processYaml(`e2e-limited-${tag}`, `Limited ${tag}`, 'v1') } },
  });
  const api = await apiAs('admin');
  const sourceName = `Limited library ${tag}`;
  const created = await json<{ source: { id: string } }>(
    await api.post('/api/sync-sources', {
      data: { name: sourceName, provider: 'github', repoUrl: `${baseURL()}/mock/github/${repo}`, branch: 'main', folder: 'steward', kinds: ['process'] },
    }),
  );
  // GitHub's answer to a used-up limit: 403, no calls left, the reset time in epoch seconds
  const reset = Math.ceil(Date.now() / 1000) + 1800;
  await request.post('/mock/git/_limit', { data: { repo, after: 0, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } } });
  await page.goto('/settings/git-sync');
  const card = page.getByTestId('sync-source').filter({ hasText: sourceName });
  await card.getByRole('button', { name: `Fetch now: ${sourceName}` }).click();
  const shown = await page.evaluate(
    (ms) => new Intl.DateTimeFormat(navigator.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms)),
    reset * 1000,
  );
  const error = card.getByTestId('sync-source-error');
  await expect(error).toContainText(`The Git host's rate limit was reached. Try again after ${shown}.`);
  await expect(error).toContainText('add a read-only access token');
  await expect(error).toContainText('Nothing from this fetch was staged');
  await expect(card).not.toContainText('access denied');
  await settle(page);
  await expectAccessible(page, 'Git sync sources with a failed fetch');
  await request.post('/mock/git/_limit', { data: { repo, after: null } });
  await api.delete(`/api/sync-sources/${created.source.id}`);
});
