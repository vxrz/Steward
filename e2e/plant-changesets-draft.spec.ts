import type { APIRequestContext } from '@playwright/test';
import { test as base, expect } from './support/fixtures';
import { expectAccessible } from './support/axe';
import { uniq } from './support/helpers';
import { ownApi, ownUser, type OwnUser } from './support/ownUser';

/**
 * Plant change sets for who may only propose (0.13.0, docs/PLANT.md "Change sets"): the import's preview and Edit
 * selected add their change to the person's draft instead of applying it, a device profile is edited into the draft,
 * and device profiles have a History tab. Every test has an operator of its own (operators may propose on every site,
 * never apply) – its draft is its own – and a site of its own. Invented names only.
 */

const test = base.extend<{ proposer: OwnUser; proposerApi: APIRequestContext }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures must destructure their first argument
  proposer: async ({}, use) => use(await ownUser('e2e-proposer-', ['operator'], 'Otto Operator (own)')),
  storageState: async ({ proposer }, use) => use(proposer.file),
  proposerApi: async ({ proposer }, use) => {
    const api = await ownApi(proposer);
    await use(api);
    await api.dispose();
  },
});

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };

async function ok<R extends { ok(): boolean; text(): Promise<string> }>(p: Promise<R>): Promise<R> {
  const r = await p;
  expect(r.ok(), await r.text()).toBe(true);
  return r;
}

/** A site of its own with two assets. */
async function seed(admin: APIRequestContext) {
  await ok(admin.put('/api/settings/plant', { data: SETTINGS }));
  const site = uniq('e2e-draft').toLowerCase().replace(' ', '-');
  const assets = [`${site}-press-1`, `${site}-press-2`];
  await ok(admin.post('/api/plant/sites', { data: { id: site, name: `Draft Works ${site}` } }));
  for (const [i, id] of assets.entries())
    await ok(admin.post('/api/plant/assets', { data: { id, siteId: site, name: `Stamping press ${i + 1}`, model: 'SP-100' } }));
  return { site, assets };
}

async function cleanUp(admin: APIRequestContext, api: APIRequestContext, site: string, assets: string[]) {
  const cfg = await (await api.get('/api/plant/config')).json();
  if (cfg.changeSets?.draft) await api.post(`/api/plant/change-sets/${cfg.changeSets.draft.id}/withdraw`);
  for (const a of assets) await admin.delete(`/api/plant/assets/${a}`);
  await admin.delete(`/api/plant/sites/${site}`);
}

test('Add to draft from the import preview: nothing is imported yet', async ({ page, apiAs, proposerApi }) => {
  const admin = await apiAs('admin');
  const { site, assets } = await seed(admin);
  try {
    const yaml = `version: 1\nassets:\n  - id: ${assets[0]}\n    name: Stamping press 1\n    model: SP-200\n    location: { site: ${site} }\n`;
    await page.goto('/plant/import');
    // who may only propose previews the files and adds them to the draft
    await expect(page.getByTestId('import-propose-only')).toBeVisible();
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({ name: 'presses.yaml', mimeType: 'application/yaml', buffer: Buffer.from(yaml) });
    await page.getByTestId('mode-update').click();
    await page.getByTestId('import-preview').click();
    const result = page.getByTestId('import-preview-result');
    await expect(result).toContainText('Change: 1');
    await expect(result).toContainText('model');
    await expect(result.getByTestId('import-apply')).toHaveCount(0);
    await expectAccessible(page, 'import preview of a proposer');
    await result.getByTestId('import-add-to-draft').click();
    await expect(page.getByTestId('import-drafted')).toBeVisible();
    const bar = page.getByRole('region', { name: 'Your draft' });
    await expect(bar.getByTestId('draft-bar-count')).toHaveText('1 change');
    expect((await (await admin.get(`/api/plant/assets/${assets[0]}`)).json()).model).toBe('SP-100');
    // the draft's review shows what the import would change
    await page.getByTestId('import-drafted').getByRole('link', { name: 'Open the draft' }).click();
    await expect(page.getByTestId('cs-group-change')).toContainText('SP-200');
  } finally {
    await cleanUp(admin, proposerApi, site, assets);
  }
});

test('Add to draft from Edit selected', async ({ page, apiAs, proposerApi }) => {
  const admin = await apiAs('admin');
  const { site, assets } = await seed(admin);
  try {
    await page.goto(`/plant/assets?site=${site}`);
    const table = page.getByTestId('plant-asset-table');
    await expect(table.getByRole('link', { name: 'Stamping press 1' })).toBeVisible();
    await table.getByTestId('select-all').check();
    const bar = page.getByTestId('bulk-bar');
    await expect(bar).toContainText('2 selected');
    await bar.getByTestId('bulk-edit').click();
    const dialog = page.getByRole('dialog', { name: 'Edit 2 entries' });
    await dialog.getByTestId('bulk-field-status').click();
    await page.getByRole('option', { name: 'Maintenance' }).click();
    await dialog.getByTestId('bulk-preview-button').click();
    await expect(dialog.getByTestId('bulk-preview')).toContainText('Changes: 2');
    await expect(dialog.getByTestId('bulk-apply')).toHaveCount(0);
    await expectAccessible(page, 'bulk edit of a proposer');
    await dialog.getByTestId('bulk-add-to-draft').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('region', { name: 'Your draft' }).getByTestId('draft-bar-count')).toHaveText('1 change');
    for (const a of assets) expect((await (await admin.get(`/api/plant/assets/${a}`)).json()).status).toBe('operational');
  } finally {
    await cleanUp(admin, proposerApi, site, assets);
  }
});

test('a proposer edits a device profile into the draft', async ({ page, apiAs, proposerApi }) => {
  const admin = await apiAs('admin');
  const { site, assets } = await seed(admin);
  const profile = `${site}-plc`;
  await ok(admin.post('/api/plant/profiles', { data: { id: profile, name: 'Example stamping PLC', manufacturer: 'Example Controls', interfaces: [] } }));
  try {
    await page.goto(`/plant/profiles/${profile}`);
    await page.getByTestId('profile-propose-edit').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Model').fill('PLC-2');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('region', { name: 'Your draft' }).getByTestId('draft-bar-count')).toHaveText('1 change');
    await expect(page.getByTestId('changed-in-draft')).toBeVisible();
    expect((await (await admin.get(`/api/plant/profiles/${profile}`)).json()).model).toBe('');
  } finally {
    await cleanUp(admin, proposerApi, site, assets);
    await admin.delete(`/api/plant/profiles/${profile}`);
  }
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a device profile has a History tab', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    await ok(admin.put('/api/settings/plant', { data: SETTINGS }));
    const profile = uniq('e2e-hist-plc').toLowerCase().replace(' ', '-');
    await ok(admin.post('/api/plant/profiles', { data: { id: profile, name: 'Example history PLC', interfaces: [] } }));
    try {
      const p = await (await admin.get(`/api/plant/profiles/${profile}`)).json();
      const { id: _id, ...own } = p.own;
      await ok(admin.put(`/api/plant/profiles/${profile}`, { data: { ...own, model: 'H-2', revision: p.revision } }));
      await page.goto(`/plant/profiles/${profile}`);
      await page.getByTestId('profile-tab-history').click();
      await expect(page).toHaveURL(new RegExp(`/plant/profiles/${profile}/history$`));
      const row = page.getByTestId('history-row').first();
      await expect(row).toContainText('Changed');
      await expect(row).toContainText('By admin');
      await expectAccessible(page, 'history of a device profile');
    } finally {
      await admin.delete(`/api/plant/profiles/${profile}`);
    }
  });
});
