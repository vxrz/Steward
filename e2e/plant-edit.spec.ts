import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, uniq } from './support/helpers';

/**
 * Editing the plant registry in place (0.12): the site's Devices tab with its count in the tab (two digits, not cut
 * off), sorting, filters, data quality hints and Add / Edit / Remove with the asset's own forms; "Not watched" when no
 * check is linked (and no Live column then); "Move to…" for a work center and an asset. Every test works on a site
 * of its own (other specs use the demo enterprise).
 */

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };

async function ok(p: Promise<{ ok(): boolean; text(): Promise<string> }>) {
  const r = await p;
  expect(r.ok(), await r.text()).toBe(true);
  return r;
}

/**
 * A site of its own: two areas (A with a work center), a VLAN, two assets and 12 devices – two share an address,
 * one has no VLAN, one is inactive. Invented names only.
 */
async function seed(api: APIRequestContext, admin: APIRequestContext) {
  await ok(admin.put('/api/settings/plant', { data: SETTINGS }));
  const site = uniq('e2e-edit').toLowerCase().replace(' ', '-');
  await ok(api.post('/api/plant/sites', { data: { id: site, name: `Edit Works ${site}` } }));
  await ok(api.post(`/api/plant/sites/${site}/nodes`, { data: { id: `${site}-pressing`, level: 'area', name: 'Pressing' } }));
  await ok(api.post(`/api/plant/sites/${site}/nodes`, { data: { id: `${site}-welding`, level: 'area', name: 'Welding' } }));
  await ok(
    api.post(`/api/plant/sites/${site}/nodes`, { data: { id: `${site}-line`, level: 'work_center', parentId: `${site}-pressing`, name: 'Press line' } }),
  );
  await ok(api.post(`/api/plant/sites/${site}/vlans`, { data: { id: `${site}-v110`, name: 'Cells', vid: 110, subnets: [{ cidr: '10.50.110.0/24' }] } }));
  const assets = [`${site}-press`, `${site}-robot`];
  await ok(api.post('/api/plant/assets', { data: { id: assets[0], siteId: site, name: 'Press 1', workCenterId: `${site}-line` } }));
  await ok(api.post('/api/plant/assets', { data: { id: assets[1], siteId: site, name: 'Robot 1' } }));
  for (let i = 1; i <= 12; i++) {
    const data: Record<string, unknown> = {
      id: `dev-${String(i).padStart(2, '0')}`,
      hostname: `cell-ctrl-${String(i).padStart(2, '0')}`,
      address: `10.50.110.${i === 2 ? 1 : i}`,
      mac: `00-00-5E-00-53-${String(i).padStart(2, '0')}`,
      vlan: i === 12 ? null : `${site}-v110`,
      switch: 'SW-HALL-01',
      switchPort: `Gi1/0/${i}`,
      state: i === 11 ? 'inactive' : 'active',
    };
    await ok(api.post(`/api/plant/assets/${assets[i % 2]}/devices`, { data }));
  }
  return { site, assets };
}

async function cleanup(api: APIRequestContext, site: string, assets: string[]) {
  for (const a of assets) await api.delete(`/api/plant/assets/${a}`);
  await api.delete(`/api/plant/sites/${site}`);
}

const tab = (page: Page, id: string) => page.getByTestId(`network-tab-${id}`);

test.describe('as a designer', () => {
  test.use({ storageState: authFile('dana') });

  test('the site Devices tab: a two-digit count, data quality, Not watched, filters, add, edit and remove', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const { site, assets } = await seed(api, await apiAs('admin'));
    try {
      await page.goto(`/plant/sites/${site}/network`);
      // nothing is watched: no Live column, a hint where checks are linked
      await expect(page.getByTestId('live-not-watched-hint')).toBeVisible();
      await expect(page.getByTestId('network-assets').getByTestId('live-badge')).toHaveCount(0);
      await expect(page.getByTestId('quality-summary')).toContainText('2 hints about the devices');

      // the count in the tab: 12, in full
      const count = tab(page, 'devices').getByTestId('link-tab-count');
      await expect(count).toHaveText('12');
      const cut = await count.evaluate((el) => {
        const label = (el.querySelector('.mantine-Badge-label') as HTMLElement | null) ?? (el as HTMLElement);
        return label.scrollWidth > label.clientWidth;
      });
      expect(cut).toBe(false);
      // no vertical scrollbar on the tab bar
      const bar = await page.getByTestId('link-tabs').evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, oy: getComputedStyle(el).overflowY }));
      expect(bar.oy).toBe('hidden');

      await tab(page, 'devices').click();
      const devices = page.getByTestId('network-devices');
      await expect(devices.getByTestId('device-count')).toHaveText('12 devices');
      // data quality: open, with the shared address and the device without VLAN
      const quality = page.getByTestId('section-data-quality');
      await expect(quality.getByTestId('quality-duplicate_address')).toContainText('Address 10.50.110.1 is used by 2 devices');
      await expect(quality.getByTestId('quality-no_vlan')).toContainText('1 device has no VLAN');
      // a hint's device leads to its row
      await quality.getByTestId('quality-no_vlan').getByTestId('quality-device').click();
      await expect(page.locator(`#device-${assets[0]}-dev-12`)).toHaveClass(/row-target/);
      // an inactive device is quieter; identifiers do not wrap
      await expect(page.locator(`#device-${assets[1]}-dev-11`)).toHaveClass(/row-quiet/);
      const macCell = page.locator(`#device-${assets[1]}-dev-01 td.nowrap`).filter({ hasText: '00-00-5E-00-53-01' });
      await expect(macCell).toHaveCount(1);
      // no Live column when nothing is watched
      await expect(devices.getByTestId('live-badge')).toHaveCount(0);
      // filters
      await chooseOption(page, 'VLAN', 'No VLAN');
      await expect(devices.getByTestId('device-count')).toHaveText('1 of 12 devices');
      await chooseOption(page, 'VLAN', 'All VLANs');
      await expectAccessible(page, 'site devices with data quality');

      // add: choose the asset, then the asset's own device form
      await page.getByTestId('add-site-device').click();
      const pick = page.getByTestId('pick-asset');
      await pick.getByRole('combobox', { name: 'Asset' }).click();
      await page.getByRole('option', { name: 'Robot 1' }).click();
      await pick.getByRole('button', { name: 'Save' }).click();
      await expect(pick).toBeHidden();
      const form = page.getByRole('dialog', { name: 'New device' });
      await form.getByRole('textbox', { name: 'Host name' }).fill('cell-hmi-99');
      await form.getByRole('textbox', { name: 'ID', exact: true }).fill('hmi-99');
      await form.getByRole('textbox', { name: 'Address', exact: true }).fill('10.50.110.99');
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(form).toBeHidden();
      await expect(devices.getByTestId('device-count')).toHaveText('13 devices');
      const row = page.locator(`#device-${assets[1]}-hmi-99`);
      await expect(row).toContainText('10.50.110.99');

      // edit
      await row.getByRole('button', { name: 'Actions for device cell-hmi-99' }).click();
      await page.getByRole('menuitem', { name: 'Edit' }).click();
      const edit = page.getByRole('dialog', { name: 'Device cell-hmi-99' });
      await edit.getByRole('textbox', { name: 'Host name' }).fill('cell-hmi-98');
      await edit.getByRole('button', { name: 'Save' }).click();
      await expect(edit).toBeHidden();
      await expect(row).toContainText('cell-hmi-98');

      // remove
      await row.getByRole('button', { name: 'Actions for device cell-hmi-98' }).click();
      await page.getByRole('menuitem', { name: 'Remove' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
      await expect(row).toBeHidden();
      await expect(devices.getByTestId('device-count')).toHaveText('12 devices');

      // the asset page: Not watched, and a device without an address shows its address type alone
      await ok(
        api.put(`/api/plant/assets/${assets[1]}/devices/dev-01`, {
          data: { hostname: 'cell-ctrl-01', address: '', addressType: 'dynamic', vlan: `${site}-v110` },
        }),
      );
      await page.goto(`/plant/assets/${assets[1]}`);
      const section = page.getByTestId('asset-network');
      await expect(section.getByTestId('live-badge').first()).toHaveAttribute('data-state', 'not_watched');
      await expect(section.getByTestId('live-badge').first()).toHaveText('Not watched');
      await expect(section.getByTestId('device-dev-01')).toContainText('Dynamic (DHCP)');
      await expect(section.getByTestId('device-dev-01')).not.toContainText('– · Dynamic');
      await expectAccessible(page, 'asset OT network, not watched');
    } finally {
      await cleanup(api, site, assets);
    }
  });

  test('Move to… a work center to another area and an asset to another place', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const { site, assets } = await seed(api, await apiAs('admin'));
    try {
      await page.goto(`/plant/sites/${site}`);
      const tree = page.getByTestId('plant-hierarchy');
      await tree.getByRole('button', { name: 'Actions for Press line' }).click();
      await page.getByTestId(`move-${site}-line`).click();
      const dialog = page.getByRole('dialog', { name: /Move .*Press line/ });
      await expect(dialog).toBeVisible();
      await expectAccessible(page, 'move dialog');
      await chooseOption(page, /New/, 'Welding');
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId(`node-${site}-welding`).getByTestId(`node-${site}-line`)).toHaveCount(1);
      // the asset in it followed
      const moved = await (await api.get(`/api/plant/assets/${assets[0]}`)).json();
      expect(moved.location.area.id).toBe(`${site}-welding`);

      // an asset: to the other area
      await page.goto(`/plant/assets/${assets[1]}`);
      await page.getByTestId('detail-actions').click();
      await page.getByTestId('move-to').click();
      const move = page.getByRole('dialog', { name: 'Move Robot 1' });
      await chooseOption(page, 'New place', /^Pressing \(/);
      await move.getByRole('button', { name: 'Save' }).click();
      await expect(move).toBeHidden();
      const robot = await (await api.get(`/api/plant/assets/${assets[1]}`)).json();
      expect(robot.location.area.id).toBe(`${site}-pressing`);
    } finally {
      await cleanup(api, site, assets);
    }
  });
});

test.describe('on a phone', () => {
  test.use({ storageState: authFile('dana') });

  test('the Devices tab is cards that fit the screen @mobile', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const { site, assets } = await seed(api, await apiAs('admin'));
    try {
      await page.goto(`/plant/sites/${site}/network/devices`);
      await expect(page.getByTestId('site-device-dev-01')).toBeVisible();
      await expect(page.getByTestId('section-data-quality')).toBeVisible();
      await settle(page);
      await expectNoHorizontalScroll(page);
      await expectAccessible(page, 'site devices on a phone');
    } finally {
      await cleanup(api, site, assets);
    }
  });
});
