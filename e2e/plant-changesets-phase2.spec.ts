import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { VERA_DRAFT_LOCK, expectNoHorizontalScroll, uniq, withLock } from './support/helpers';

/**
 * Plant change sets, phase 2 (0.19.0, docs/PLANT.md "Modes" and "Change sets", ADR 0020 "Built in 0.19.0"): the
 * import's preview flags a field changed in Steward since the last import – Steward's value is kept unless the file's is
 * taken, per field (by keyboard) or for all – and a removed device comes back with Restore on the asset's History. Every
 * test works on a site of its own. Invented names only.
 */

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };

async function ok<R extends { ok(): boolean; text(): Promise<string> }>(p: Promise<R>): Promise<R> {
  const r = await p;
  expect(r.ok(), await r.text()).toBe(true);
  return r;
}

const file = (site: string, model: string, description: string) =>
  [
    'version: 1',
    'sites:',
    `  - id: ${site}`,
    `    name: Sync Works ${site}`,
    '    assets:',
    `      - id: ${site}-lathe`,
    '        name: Lathe 1',
    `        model: ${model}`,
    `        description: ${description}`,
  ].join('\n');

/** A site imported from a file, whose asset's model was then corrected in Steward. */
async function seed(admin: APIRequestContext) {
  await ok(admin.put('/api/settings/plant', { data: SETTINGS }));
  const site = uniq('e2e-sync').toLowerCase().replace(' ', '-');
  await ok(admin.post('/api/plant/import', { data: { files: [{ name: 'sync.yaml', content: file(site, 'L1', 'From the ERP') }], mode: 'update' } }));
  const a = await (await ok(admin.get(`/api/plant/assets/${site}-lathe`))).json();
  await ok(
    admin.put(`/api/plant/assets/${site}-lathe`, {
      data: {
        siteId: a.siteId,
        areaId: null,
        workCenterId: null,
        workUnitId: null,
        buildingId: null,
        name: a.name,
        manufacturer: a.manufacturer,
        model: 'L1-corrected',
        status: a.status,
        parentId: null,
        domain: a.domain,
        processArea: a.processArea,
        role: a.role,
        tags: a.tags,
        commissioned: a.commissioned,
        endOfSupport: a.endOfSupport,
        description: a.description,
        capabilities: a.capabilities,
        imageName: a.imageName,
        refs: a.refs,
        fields: a.fields,
      },
    }),
  );
  return { site, asset: `${site}-lathe` };
}

async function previewNextFile(page: Page, site: string) {
  await page.goto('/plant/import');
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: 'sync.yaml', mimeType: 'application/yaml', buffer: Buffer.from(file(site, 'L2', 'From the ERP, again')) });
  await page.getByTestId('mode-update').click();
  await page.getByTestId('import-preview').click();
  return page.getByTestId('import-steward');
}

async function cleanUp(admin: APIRequestContext, site: string, asset: string) {
  await admin.delete(`/api/plant/assets/${asset}?cascade=1`);
  await admin.delete(`/api/plant/sites/${site}`);
}

test.describe('an import after edits in Steward', () => {
  test.use({ storageState: authFile('admin') });

  test('keeps Steward’s value by default; the file’s value is chosen by keyboard', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    const { site, asset } = await seed(admin);
    try {
      const flags = await previewNextFile(page, site);
      await expect(flags).toContainText('1 field changed in Steward since the last import');
      await expect(flags.getByTestId('steward-kept')).toHaveText('1 of 1 keep Steward’s value');
      const field = flags.getByTestId('steward-field');
      await expect(field).toContainText('L1-corrected');
      await expect(field).toContainText('L2');
      // the preview shows only what really changes: the description
      await expect(page.getByTestId('import-preview-result')).toContainText('Change: 1');
      await settle(page);
      await expectAccessible(page, 'import preview with fields changed in Steward');
      // a radio group per field: Tab to the chosen radio, an arrow key moves the choice
      const keep = field.getByRole('radio', { name: 'Keep Steward’s' });
      await expect(keep).toBeChecked();
      await keep.focus();
      await page.keyboard.press('ArrowRight');
      await expect(field.getByRole('radio', { name: 'Take the file’s' })).toBeChecked();
      await expect(page.getByTestId('import-announce')).toContainText('0 of 1 fields keep Steward’s value');
      await expect(flags.getByTestId('steward-kept')).toHaveText('0 of 1 keep Steward’s value');
      // and back for all
      await flags.getByTestId('steward-keep-all').click();
      await expect(flags.getByTestId('steward-kept')).toHaveText('1 of 1 keep Steward’s value');
      await page.getByTestId('import-apply').click();
      await expect(page.getByTestId('import-result')).toBeVisible();
      const now = await (await admin.get(`/api/plant/assets/${asset}`)).json();
      expect([now.model, now.description]).toEqual(['L1-corrected', 'From the ERP, again']);
    } finally {
      await cleanUp(admin, site, asset);
    }
  });

  test('a removed device comes back with Restore on the asset’s History', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    const { site, asset } = await seed(admin);
    try {
      await ok(admin.post(`/api/plant/assets/${asset}/devices`, { data: { id: 'lathe-ipc', hostname: 'lathe-ipc', purpose: 'Machine PC' } }));
      await ok(admin.delete(`/api/plant/assets/${asset}/devices/lathe-ipc`));
      await page.goto(`/plant/assets/${asset}/history`);
      const row = page.getByTestId('history-row').filter({ hasText: 'lathe-ipc' }).first();
      await expect(row).toContainText('Removed');
      await row.getByRole('button', { name: 'Restore' }).click();
      await expect(page.getByTestId('change-set-state')).toHaveText('Draft');
      await expect(page.getByTestId('cs-group-add')).toContainText('lathe-ipc');
      await page.getByTestId('cs-apply').click();
      await expect(page.getByTestId('change-set-state')).toHaveText('Applied');
      const net = await (await admin.get(`/api/plant/assets/${asset}/network`)).json();
      expect(net.devices.map((d: { id: string }) => d.id)).toEqual(['lathe-ipc']);
    } finally {
      await cleanUp(admin, site, asset);
    }
  });

  test('the fields changed in Steward fit a phone @mobile', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    const { site, asset } = await seed(admin);
    try {
      const flags = await previewNextFile(page, site);
      await expect(flags.getByTestId('steward-field')).toBeVisible();
      await settle(page);
      await expectNoHorizontalScroll(page);
      await expectAccessible(page, 'fields changed in Steward on a phone');
      await flags.getByRole('radio', { name: 'Take the file’s' }).check();
      await expect(flags.getByTestId('steward-kept')).toHaveText('0 of 1 keep Steward’s value');
    } finally {
      await cleanUp(admin, site, asset);
    }
  });
});

test.describe('a collection import by who may only propose', () => {
  test.use({ storageState: authFile('vera') });

  test('previews a collector’s files and adds the import to the draft', async ({ page, apiAs }) => {
    test.setTimeout(240_000);
    // vera's one draft is shared with another spec running alongside
    await withLock(VERA_DRAFT_LOCK, async () => {
      const admin = await apiAs('admin');
      const { site, asset } = await seed(admin);
      const vera = await apiAs('vera');
      try {
        await ok(admin.put(`/api/plant/sites/${site}/access`, { data: { acl: [{ subject: 'user:vera', permissions: ['view', 'propose'] }] } }));
        await page.goto(`/plant/assets/${asset}/collections`);
        await page.getByTestId('collections-import').click();
        const dialog = page.getByTestId('collections-import-dialog');
        await dialog.getByTestId('collector-ref').fill('line-gateway-e2e');
        const chooser = page.waitForEvent('filechooser');
        await dialog.getByTestId('collections-files').click();
        await (
          await chooser
        ).setFiles({
          name: 'gateway.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from('collection,source_address,output_name\nstate,/Bag/State/opMode[u1],OpMode\n'),
        });
        await dialog.getByTestId('collections-preview').click();
        const result = dialog.getByTestId('collections-preview-result');
        await expect(result).toContainText('state');
        await expect(result.getByTestId('collections-apply')).toHaveCount(0);
        await result.getByTestId('collections-add-to-draft').click();
        await expect(dialog.getByTestId('collections-import-change-set')).toContainText('Changes by vera');
        await expectAccessible(page, 'collection import added to the draft');
        // nothing is imported yet
        const now = await (await admin.get(`/api/plant/assets/${asset}/collections`)).json();
        expect(now.collections).toEqual([]);
      } finally {
        const cfg = await (await vera.get('/api/plant/config')).json();
        if (cfg.changeSets?.draft) await vera.post(`/api/plant/change-sets/${cfg.changeSets.draft.id}/withdraw`);
        await cleanUp(admin, site, asset);
      }
    });
  });
});
