import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { uniq } from './support/helpers';

/**
 * Plant change sets (0.13.0, docs/PLANT.md "Change sets", ADR 0020): a viewer with the propose right drafts a change
 * on an asset and proposes it; a designer reviews it – with the three columns of a field changed in Steward since –
 * and applies it; the asset's History shows it; Revert writes a new draft that is applied; a stale edit gets the choice
 * per field. Every test works on a site of its own (other specs use the demo enterprise). Invented names only.
 */

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };

async function ok<R extends { ok(): boolean; text(): Promise<string> }>(p: Promise<R>): Promise<R> {
  const r = await p;
  expect(r.ok(), await r.text()).toBe(true);
  return r;
}

/** A site of its own with one asset; Vera (a viewer) may propose there, Dana manages it as a designer. */
async function seed(admin: APIRequestContext) {
  await ok(admin.put('/api/settings/plant', { data: SETTINGS }));
  const site = uniq('e2e-cs').toLowerCase().replace(' ', '-');
  const asset = `${site}-press`;
  await ok(admin.post('/api/plant/sites', { data: { id: site, name: `Change Works ${site}` } }));
  await ok(admin.post('/api/plant/assets', { data: { id: asset, siteId: site, name: 'Stamping press 1', manufacturer: 'Example Presses', model: 'SP-100' } }));
  await ok(
    admin.put(`/api/plant/sites/${site}/access`, {
      data: {
        acl: [
          { subject: 'user:vera', permissions: ['view', 'propose'] },
          { subject: 'user:dana', permissions: ['view', 'manage'] },
        ],
      },
    }),
  );
  return { site, asset };
}

async function assetBody(api: APIRequestContext, asset: string, patch: Record<string, unknown>) {
  const a = await (await ok(api.get(`/api/plant/assets/${asset}`))).json();
  return {
    siteId: a.siteId,
    areaId: a.location.area?.id ?? null,
    workCenterId: a.location.workCenter?.id ?? null,
    workUnitId: a.location.workUnit?.id ?? null,
    buildingId: a.location.buildingId,
    name: a.name,
    manufacturer: a.manufacturer,
    model: a.model,
    status: a.status,
    parentId: a.parentId,
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
    ...patch,
  };
}

test.describe('a proposer drafts, a second person applies', () => {
  test.use({ storageState: authFile('vera') });

  test('draft → propose → review three ways → apply → history → revert', async ({ page, apiAs, loginAs }) => {
    const admin = await apiAs('admin');
    const { site, asset } = await seed(admin);
    try {
      // Vera may only propose: the form saves into her draft
      await page.goto(`/plant/assets/${asset}`);
      await page.getByTestId('asset-propose-edit').click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Model').fill('SP-200');
      await dialog.getByLabel('Manufacturer').fill('Example Presses Ltd');
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toBeHidden();
      const bar = page.getByRole('region', { name: 'Your draft' });
      await expect(bar.getByTestId('draft-bar-count')).toHaveText('1 change');
      await expect(page.getByTestId('changed-in-draft')).toBeVisible();
      // nothing is in Steward yet
      expect((await (await admin.get(`/api/plant/assets/${asset}`)).json()).model).toBe('SP-100');

      await bar.getByTestId('draft-bar-review').click();
      await expect(page.getByTestId('cs-group-change')).toContainText('model');
      await expectAccessible(page, 'change set draft review');
      await page.getByTestId('cs-propose').click();
      await expect(page.getByTestId('change-set-state')).toHaveText('Proposed');
      const id = page.url().split('/').pop()!;

      // meanwhile someone changes the model in Steward: a conflict for the reviewer
      await ok(admin.put(`/api/plant/assets/${asset}`, { data: await assetBody(admin, asset, { model: 'SP-150', role: 'press' }) }));

      const dana = await loginAs('dana');
      await dana.goto('/plant/changes?box=review');
      await dana.getByRole('link', { name: `Changes by vera` }).first().click();
      await expect(dana).toHaveURL(new RegExp(`/plant/changes/${id}$`));
      const conflicts = dana.getByTestId('cs-conflicts');
      await expect(conflicts).toContainText('When drafted');
      await expect(conflicts).toContainText('Now in Steward');
      await expect(conflicts).toContainText('This change');
      await expect(conflicts).toContainText('SP-150');
      await expect(dana.getByTestId('cs-apply')).toBeDisabled();
      // the conflict is a radio group with its field as legend; keyboard: the choice by arrow keys
      await dana.getByRole('radio', { name: 'This change' }).check();
      await expect(dana.getByTestId('cs-announce')).toContainText('0 conflicts');
      await settle(dana);
      await expectAccessible(dana, 'change set with a resolved conflict');
      await dana.getByTestId('cs-apply').click();
      await expect(dana.getByTestId('change-set-state')).toHaveText('Applied');
      const now = await (await admin.get(`/api/plant/assets/${asset}`)).json();
      expect([now.model, now.manufacturer, now.role]).toEqual(['SP-200', 'Example Presses Ltd', 'press']);

      // the asset's history: by Vera, applied by Dana; Revert writes a new draft
      await dana.goto(`/plant/assets/${asset}/history`);
      const row = dana.getByTestId('history-row').first();
      await expect(row).toContainText('By vera, applied by dana');
      await row.getByRole('button', { name: /show/i }).click();
      await expect(row.getByTestId('field-diffs')).toContainText('SP-200');
      await row.getByTestId('history-revert').click();
      await expect(dana.getByTestId('change-set-state')).toHaveText('Draft');
      await expect(dana.getByTestId('cs-group-change')).toContainText('Example Presses');
      // Dana manages the site and it needs no second person: she applies her own draft
      await dana.getByTestId('cs-apply').click();
      await expect(dana.getByTestId('change-set-state')).toHaveText('Applied');
      const back = await (await admin.get(`/api/plant/assets/${asset}`)).json();
      expect([back.model, back.manufacturer, back.role]).toEqual(['SP-150', 'Example Presses', 'press']);
    } finally {
      await admin.delete(`/api/plant/assets/${asset}`);
      await admin.delete(`/api/plant/sites/${site}`);
    }
  });
});

test.describe('a stale edit', () => {
  test.use({ storageState: authFile('dana') });

  test('someone changed the asset since the form opened: a choice per field, then saved', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    const { site, asset } = await seed(admin);
    try {
      await page.goto(`/plant/assets/${asset}`);
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      const form = page.getByRole('dialog');
      await form.getByLabel('Model').fill('SP-300');
      // someone else saves first: the model and the manufacturer
      await ok(admin.put(`/api/plant/assets/${asset}`, { data: await assetBody(admin, asset, { model: 'SP-250', manufacturer: 'Other Presses' }) }));
      await form.getByRole('button', { name: 'Save' }).click();
      const choice = page.getByTestId('entry-conflict-dialog');
      await expect(choice).toBeVisible();
      await expect(choice).toContainText('Kept from the other change: manufacturer');
      const model = choice.getByTestId('entry-conflict-model');
      await expect(model).toContainText('SP-250');
      await expect(model).toContainText('SP-300');
      await expectAccessible(page, 'entry changed dialog');
      await model.getByRole('radio', { name: 'Take theirs' }).check();
      await choice.getByTestId('entry-conflict-save').click();
      await expect(choice).toBeHidden();
      const now = await (await admin.get(`/api/plant/assets/${asset}`)).json();
      expect([now.model, now.manufacturer]).toEqual(['SP-250', 'Other Presses']);
    } finally {
      await admin.delete(`/api/plant/assets/${asset}`);
      await admin.delete(`/api/plant/sites/${site}`);
    }
  });
});
