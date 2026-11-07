import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { confirmDialog, expectNoHorizontalScroll, json, uniq } from './support/helpers';
import { signedZip, testKey } from './support/library';

/**
 * Shared procedure libraries (#238, ADR 0014): an administrator trusts a publisher's key, uploads a signed release,
 * reviews the whole of it (items, what each process can do), installs it, sees "From library" on the process, puts
 * the library on hold and lifts it, and manages the trusted publishers. Everything it creates is removed again.
 */

test.use({ storageState: authFile('admin') });

const child = (id: string) => `id: ${id}
name: "E2E library follow-up ${id}"
steps:
  - id: note
    type: log
    message: done
`;
const parent = (id: string, childId: string) => `id: ${id}
name: "E2E library review ${id}"
steps:
  - id: note
    type: log
    message: start
  - id: follow
    type: subprocess
    name: Follow up
    process: ${childId}
`;

interface Fixture {
  tag: string;
  library: string;
  publisher: string;
  parentId: string;
  childId: string;
  zip: Buffer;
}

async function prepare(api: APIRequestContext): Promise<Fixture> {
  const tag = uniq('e2e').split(' ')[1]!.toLowerCase();
  const key = testKey();
  const f = { tag, library: `e2e-lib-${tag}`, publisher: `e2e-pub-${tag}`, parentId: `e2e-lib-review-${tag}`, childId: `e2e-lib-follow-${tag}` };
  expect((await api.post('/api/library-publishers', { data: { id: f.publisher, name: `E2E publisher ${tag}`, contact: 'ops@example.com' } })).ok()).toBe(true);
  expect((await api.post(`/api/library-publishers/${f.publisher}/keys`, { data: { key: key.line } })).ok()).toBe(true);
  const zip = await signedZip(key, {
    library: f.library,
    publisher: f.publisher,
    release: '1.0.0',
    name: `E2E reviews ${tag}`,
    items: { 'processes/review.yaml': parent(f.parentId, f.childId), 'processes/follow-up.yaml': child(f.childId) },
  });
  return { ...f, zip };
}

async function cleanUp(api: APIRequestContext, f: Fixture) {
  await api.post(`/api/libraries/${f.library}/uninstall`, { data: {} });
  for (const id of [f.parentId, f.childId]) await api.delete(`/api/processes/${id}`);
  const list = await json<{ staged: { id: string; library: string }[] }>(await api.get('/api/libraries'));
  for (const r of list.staged.filter((x) => x.library === f.library)) await api.delete(`/api/library-releases/${r.id}`);
  await api.delete(`/api/library-publishers/${f.publisher}`);
}

async function upload(page: Page, f: Fixture) {
  await page.goto('/libraries');
  await expect(page.getByRole('heading', { name: 'Libraries', level: 1 })).toBeVisible();
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: `${f.library}.zip`, mimeType: 'application/zip', buffer: f.zip });
  await expect(page.getByRole('heading', { name: `E2E reviews ${f.tag} 1.0.0`, level: 1 })).toBeVisible();
}

test('an administrator trusts a publisher, reviews and installs a signed release, holds and lifts it', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const f = await prepare(api);
  try {
    // the list before: the release is not there yet
    await page.goto('/libraries');
    await settle(page);
    await expectAccessible(page, 'libraries list');
    await upload(page, f);
    // the review: publisher, key, the whole release, what each process can do
    await expect(page.getByText(`E2E publisher ${f.tag}`).first()).toBeVisible();
    const items = page.getByTestId('library-item');
    await expect(items).toHaveCount(2);
    await expect(page.getByRole('article', { name: `E2E library review ${f.parentId}` })).toContainText('New');
    await expect(page.getByRole('article', { name: `E2E library review ${f.parentId}` })).toContainText(`Runs ${f.childId}`);
    await expect(page.getByRole('article', { name: `E2E library follow-up ${f.childId}` })).toContainText('Reads nothing and changes nothing.');
    await page
      .getByRole('article', { name: `E2E library follow-up ${f.childId}` })
      .getByRole('button', { name: 'Show file' })
      .click();
    await expect(page.getByTestId('version-diff')).toBeVisible();
    await page.keyboard.press('Escape');
    await settle(page);
    await expectAccessible(page, 'library release review');
    await page.getByTestId('library-install').first().click();
    // installed: the library page
    await expect(page).toHaveURL((url) => url.pathname.endsWith(`/libraries/${f.library}`));
    await expect(page.getByRole('heading', { name: `E2E reviews ${f.tag}`, level: 1 })).toBeVisible();
    await expect(page.getByTestId('library-releases')).toContainText('Installed');
    await settle(page);
    await expectAccessible(page, 'installed library');
    // Hold: pauses schedules, triggers and monitors and refuses runs; lift it again
    await page.getByTestId('library-hold').click();
    await confirmDialog(page, 'Hold', { message: /refused until you lift the hold/ });
    await expect(page.getByText('On hold').first()).toBeVisible();
    const run = await api.post('/api/runs', { data: { processId: f.childId, dryRun: true } });
    expect(run.status()).toBe(409);
    await page.getByTestId('library-hold').click();
    await confirmDialog(page, 'Lift hold');
    await expect(page.getByText('On hold')).toHaveCount(0);
    // the process says where it came from; the sub-process is pinned to the version the install created
    await page.goto(`/processes/${f.parentId}`);
    await expect(page.getByTestId('library-origin').first()).toBeVisible();
    // the trusted publishers
    await page.goto('/settings/libraries');
    const card = page.getByTestId('library-publisher').filter({ hasText: f.publisher });
    await expect(card).toBeVisible();
    await expect(card.getByTestId('library-key')).toContainText('Key active');
    await settle(page);
    await expectAccessible(page, 'trusted publishers');
  } finally {
    await cleanUp(api, f);
  }
});

test('a designer reviews but may not manage publishers or hold a library', async ({ apiAs, loginAs }) => {
  const api = await apiAs('admin');
  const f = await prepare(api);
  try {
    const designer = await loginAs('dana');
    await upload(designer, f);
    await expect(designer.getByTestId('library-install').first()).toBeEnabled();
    await designer.getByTestId('library-install').first().click();
    await expect(designer).toHaveURL((url) => url.pathname.endsWith(`/libraries/${f.library}`));
    await expect(designer.getByTestId('library-hold')).toHaveCount(0);
    await designer.goto('/settings/libraries');
    await expect(designer.getByText('Administrators manage the trusted publishers.')).toBeVisible();
    // viewers do not see the Libraries tab
    const viewer = await loginAs('vera');
    await viewer.goto('/libraries');
    await expect(viewer.getByText('Designers and administrators review and install libraries.')).toBeVisible();
  } finally {
    await cleanUp(api, f);
  }
});

test('libraries on a phone @mobile', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const f = await prepare(api);
  try {
    await upload(page, f);
    await expect(page.getByTestId('library-item')).toHaveCount(2);
    await expectNoHorizontalScroll(page);
    await settle(page);
    await expectAccessible(page, 'library review (phone)');
    await page.getByTestId('library-install').last().click();
    await expect(page).toHaveURL((url) => url.pathname.endsWith(`/libraries/${f.library}`));
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'installed library (phone)');
    await page.goto('/libraries');
    await expect(page.getByTestId('library-cards')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'libraries list (phone)');
    await page.goto('/settings/libraries');
    await expect(page.getByTestId('library-publisher').filter({ hasText: f.publisher })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'trusted publishers (phone)');
  } finally {
    await cleanUp(api, f);
  }
});
