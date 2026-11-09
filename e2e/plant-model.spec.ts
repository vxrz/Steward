import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll } from './support/helpers';

/**
 * The plant registry, 0.11.0: a derived device profile shows where each item comes from and can mark an inherited
 * data point as not present; an asset adds a data point of its own; the Collections tab imports a gateway's
 * configuration with its preview – on a desktop and on a phone, with axe. Every test makes its own invented records.
 */

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };
const EXAMPLE = path.resolve(import.meta.dirname, '../examples/plant/collections/example-gateway-datasets.json');

async function plantOn(api: APIRequestContext) {
  const res = await api.put('/api/settings/plant', { data: SETTINGS });
  expect(res.ok(), await res.text()).toBe(true);
}
const ok = async (p: Promise<{ ok(): boolean; text(): Promise<string> }>) => {
  const r = await p;
  expect(r.ok(), await r.text()).toBe(true);
};

/** A base profile, a profile that extends it and an asset of the derived one (ids unique per test). */
async function fixture(api: APIRequestContext, tag: string) {
  const base = `e2e-base-${tag}`;
  const child = `e2e-child-${tag}`;
  const asset = `e2e-asset-${tag}`;
  await ok(
    api.post('/api/plant/profiles', {
      data: {
        id: base,
        name: `E2E base ${tag}`,
        manufacturer: 'Example Controls',
        interfaces: [
          {
            id: 'cnc',
            name: 'CNC variables',
            protocol: 'other',
            groups: [
              {
                name: 'State',
                dataPoints: [
                  { id: 'program_status', name: 'Program status', address: '/Channel/State/progStatus[u1]', aliases: ['ProgStatus'] },
                  { id: 'operating_mode', name: 'Operating mode', address: '/Bag/State/opMode[u1]' },
                  { id: 'legacy_flag', name: 'Legacy flag', address: '/Legacy/Flag' },
                ],
              },
            ],
          },
        ],
      },
    }),
  );
  await ok(
    api.post('/api/plant/profiles', {
      data: {
        id: child,
        name: `E2E derived ${tag}`,
        extends: base,
        pointOverrides: [{ dataPoint: 'operating_mode', address: '/Bag/State/opMode[u2]' }],
        interfaceOverrides: [{ interface: 'cnc', groups: [{ name: 'State', dataPoints: [{ id: 'spindle_load', name: 'Spindle load', unit: '%' }] }] }],
      },
    }),
  );
  await ok(api.post('/api/plant/assets', { data: { id: asset, siteId: 'riverside', name: `E2E mill ${tag}` } }));
  await ok(api.put(`/api/plant/assets/${asset}/assignment`, { data: { profileId: child, interfaces: [{ interface: 'cnc', active: true }] } }));
  return { base, child, asset };
}

async function cleanup(api: APIRequestContext, f: { base: string; child: string; asset: string }) {
  await api.delete(`/api/plant/assets/${f.asset}`);
  await api.delete(`/api/plant/profiles/${f.child}`);
  await api.delete(`/api/plant/profiles/${f.base}`);
}

// the same tests on a desktop and on a phone (the mobile project runs the titles tagged @mobile)
for (const tag of ['', ' @mobile'])
  test.describe(`as a designer${tag}`, () => {
    test.use({ storageState: authFile('dana') });
    test.beforeEach(async ({ apiAs }) => plantOn(await apiAs('admin')));

    test('a derived profile: its bases, where each item comes from, not present and restore', async ({ page, apiAs }, info) => {
      const api = await apiAs('dana');
      const f = await fixture(api, `${info.project.name}-${Date.now()}`);
      await page.goto(`/plant/profiles/${f.child}`);
      const bases = page.getByTestId('profile-bases');
      await expect(bases.getByRole('link', { name: new RegExp(`E2E base`) })).toBeVisible();
      const iface = page.getByTestId('interface-cnc');
      await expect(iface).toContainText('Program status');
      await expect(iface).toContainText('Spindle load');
      await expect(iface.getByTestId('origin-overridden').first()).toBeVisible();
      await expect(iface.getByTestId('origin-own').first()).toBeVisible();
      await expectAccessible(page, 'derived profile');
      await expectNoHorizontalScroll(page);
      // an inherited data point that this device does not have
      await page.getByRole('button', { name: 'Actions for data point Legacy flag' }).click();
      await page.getByRole('menuitem', { name: 'Not present on this device' }).click();
      const gone = page.getByTestId('profile-not-present');
      await expect(gone).toContainText('Data point Legacy flag (legacy_flag)');
      await expect(iface).not.toContainText('Legacy flag');
      await gone.getByRole('button', { name: 'Restore' }).click();
      await expect(iface).toContainText('Legacy flag');
      // the base lists the profile that extends it, and cannot be deleted
      await page.goto(`/plant/profiles/${f.base}`);
      await expect(page.getByTestId('profile-extended-by').getByRole('link', { name: new RegExp('E2E derived') })).toBeVisible();
      await cleanup(api, f);
    });

    test('an asset adds a data point of its own; it counts as delivered', async ({ page, apiAs }, info) => {
      const api = await apiAs('dana');
      const f = await fixture(api, `${info.project.name}-${Date.now()}`);
      await page.goto(`/plant/assets/${f.asset}`);
      const ifaces = page.getByTestId('assignment-interfaces');
      await ifaces.getByRole('button', { name: 'Actions for interface CNC variables' }).click();
      await page.getByTestId('add-asset-point-cnc').click();
      const dialog = page.getByRole('dialog', { name: 'New data point' });
      await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Air pressure');
      await dialog.getByRole('textbox', { name: 'Address' }).fill('/Plc/Air');
      await expectAccessible(page, 'asset data point dialog');
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId('assignment-additions').getByTestId('added-point-air_pressure')).toContainText('Air pressure');
      await expectAccessible(page, 'asset with an addition');
      await expectNoHorizontalScroll(page);
      const a = await (await api.get(`/api/plant/assets/${f.asset}/assignment`)).json();
      expect(a.added.points).toEqual(['air_pressure']);
      await cleanup(api, f);
    });

    test('the Collections tab: import a gateway configuration, confirm the matches, see what it reads and writes', async ({ page, apiAs }, info) => {
      const api = await apiAs('dana');
      const f = await fixture(api, `${info.project.name}-${Date.now()}`);
      await page.goto(`/plant/assets/${f.asset}/collections`);
      await expect(page.getByTestId('asset-tab-collections')).toBeVisible();
      await expect(page.getByTestId('asset-collections')).toContainText('No data collections yet');
      await expectAccessible(page, 'collections, empty');
      await page.getByTestId('collections-import').click();
      const dialog = page.getByTestId('collections-import-dialog');
      await dialog.getByTestId('collector-ref').fill('edge-gateway-e2e');
      const chooser = page.waitForEvent('filechooser');
      await dialog.getByTestId('collections-files').click();
      await (await chooser).setFiles(EXAMPLE);
      await expect(dialog).toContainText('example-gateway-datasets.json');
      await expectAccessible(page, 'collections import dialog');
      await dialog.getByTestId('collections-preview').click();
      const result = dialog.getByTestId('collections-preview-result');
      await expect(result).toContainText('machine-state');
      await expect(result).toContainText('Same address');
      await result.getByTestId('accept-exact').click();
      await expect(result.getByTestId('collections-summary')).toContainText('items mapped');
      await expectAccessible(page, 'collections import preview');
      await result.getByTestId('collections-apply').click();
      await expect(dialog.getByTestId('collections-import-done')).toContainText('4 collections added');
      await dialog.getByTestId('collections-import-done').getByRole('button', { name: 'Close' }).click();
      const list = page.getByTestId('asset-collections');
      const state = list.locator('[data-testid^="collection-machine-state"]');
      await expect(state).toContainText('Writes to the machine');
      await state.getByRole('button', { name: 'machine-state' }).click();
      const detail = page.getByTestId('collection-detail');
      await expect(detail.getByTestId('collection-writes')).toContainText('/NC/_N_CH_GD2_ACX/');
      // the data point's name first, the gateway's name after it
      await expect(detail.getByTestId('collection-items')).toContainText('Program status · as ProgStatus');
      await expectAccessible(page, 'collection detail');
      await expectNoHorizontalScroll(page);
      await cleanup(api, f);
    });
  });
