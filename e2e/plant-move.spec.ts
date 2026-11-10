import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, uniq } from './support/helpers';

/**
 * Moving in the plant registry (0.16, docs/PLANT.md "Moving devices and data collections"): two devices selected on
 * the site's Devices tab go to another asset and their data path follows; Revert moves them back; Duplicate… copies a
 * device without its addresses; Move to… for the assets selected in the asset list. Every test works on a site of its
 * own. Invented names only.
 */

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };

async function ok(p: Promise<{ ok(): boolean; text(): Promise<string> }>) {
  const r = await p;
  expect(r.ok(), await r.text()).toBe(true);
  return r;
}

/** A site with two areas, a VLAN and three assets; the press has two devices and a data path that names both. */
async function seed(api: APIRequestContext, admin: APIRequestContext) {
  await ok(admin.put('/api/settings/plant', { data: SETTINGS }));
  const site = uniq('e2e-move').toLowerCase().replace(' ', '-');
  await ok(api.post('/api/plant/sites', { data: { id: site, name: `Move Works ${site}` } }));
  await ok(api.post(`/api/plant/sites/${site}/nodes`, { data: { id: `${site}-pressing`, level: 'area', name: 'Pressing' } }));
  await ok(api.post(`/api/plant/sites/${site}/nodes`, { data: { id: `${site}-welding`, level: 'area', name: 'Welding' } }));
  await ok(api.post(`/api/plant/sites/${site}/vlans`, { data: { id: `${site}-v110`, name: 'Cells', vid: 110, subnets: [{ cidr: '10.60.110.0/24' }] } }));
  const assets = [`${site}-press`, `${site}-robot`, `${site}-welder`] as [string, string, string];
  await ok(api.post('/api/plant/assets', { data: { id: assets[0], siteId: site, name: 'Press 1', areaId: `${site}-pressing` } }));
  await ok(api.post('/api/plant/assets', { data: { id: assets[1], siteId: site, name: 'Robot 1', areaId: `${site}-pressing` } }));
  await ok(api.post('/api/plant/assets', { data: { id: assets[2], siteId: site, name: 'Welder 1', areaId: `${site}-pressing` } }));
  for (const [i, name] of [
    [1, 'press-ipc'],
    [2, 'press-gw'],
  ] as const)
    await ok(
      api.post(`/api/plant/assets/${assets[0]}/devices`, {
        data: {
          id: `dev-0${i}`,
          hostname: name,
          address: `10.60.110.${i + 10}`,
          mac: `00-00-5E-00-53-6${i}`,
          serial: `SN-60${i}`,
          vlan: `${site}-v110`,
          switch: 'SW-HALL-02',
          switchPort: `Gi1/0/${i}`,
          purpose: 'Machine PC',
        },
      }),
    );
  await ok(
    api.post(`/api/plant/assets/${assets[0]}/paths`, {
      data: {
        id: 'machine-state',
        subject: 'Machine state',
        devices: ['dev-01'],
        transfers: [{ protocol: 'opc-ua', mode: 'pull', peerKind: 'device', peer: 'dev-02', port: 4840 }],
      },
    }),
  );
  return { site, assets };
}

async function cleanup(api: APIRequestContext, site: string, assets: string[]) {
  for (const a of assets) await api.delete(`/api/plant/assets/${a}`);
  await api.delete(`/api/plant/sites/${site}`);
}

const network = async (api: APIRequestContext, asset: string) =>
  (await (await api.get(`/api/plant/assets/${asset}/network`)).json()) as {
    devices: { id: string; hostname: string; address: string; mac: string; serial: string; vlan: string | null }[];
    dataPaths: { id: string; devices: string[] }[];
  };

test.describe('as a designer', () => {
  test.use({ storageState: authFile('dana') });

  test('moves two devices to another asset, their data path follows; Revert moves them back', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const { site, assets } = await seed(api, await apiAs('admin'));
    try {
      await page.goto(`/plant/sites/${site}/network/devices`);
      const devices = page.getByTestId('network-devices');
      await expect(devices.getByTestId('device-count')).toHaveText('2 devices');
      await page.getByTestId(`select-${assets[0]}/dev-01`).check();
      await page.getByTestId(`select-${assets[0]}/dev-02`).check();
      await page.getByTestId('bulk-move-devices').click();
      const dialog = page.getByRole('dialog', { name: 'Move 2 devices' });
      await expect(dialog).toBeVisible();
      await chooseOption(page, 'Target asset', /^Robot 1/);
      // the preview: both devices and the data path that names only them
      const preview = dialog.getByTestId('move-entries-preview');
      await expect(preview.getByTestId('move-entry-data_path-machine-state')).toContainText('Goes along');
      await expect(preview.getByTestId('move-entry-device-dev-01')).toBeVisible();
      await expect(dialog.getByTestId('move-entries-changes')).toContainText('3 entries, field by field');
      await expectAccessible(page, 'move devices dialog');
      await dialog.getByTestId('move-entries-apply').click();
      await expect(dialog).toBeHidden();
      await expect(devices.getByTestId('site-devices')).toContainText('Robot 1');
      const robot = await network(api, assets[1]);
      expect(robot.devices.map((d) => d.id).sort()).toEqual(['dev-01', 'dev-02']);
      expect(robot.dataPaths).toEqual([expect.objectContaining({ id: 'machine-state', devices: ['dev-01'] })]);
      expect((await network(api, assets[0])).dataPaths).toEqual([]);

      // Revert: the applied change set, then its draft that moves them back
      const applied = await (await api.get('/api/plant/change-sets?box=applied&source=move')).json();
      const cs = applied.items.find((x: { title: string }) => x.title.includes(assets[1]));
      await page.goto(`/plant/changes/${cs.id}`);
      await expect(page.getByTestId('cs-group-move')).toContainText('dev-01');
      await page.getByTestId('cs-revert').click();
      await expect(page.getByTestId('cs-group-move')).toContainText(`${assets[1]} / dev-01 → ${assets[0]} / dev-01`);
      await page.getByTestId('cs-apply').click();
      await expect(page.getByTestId('change-set-state').first()).toHaveText('Applied');
      const press = await network(api, assets[0]);
      expect(press.devices.map((d) => d.id).sort()).toEqual(['dev-01', 'dev-02']);
      expect(press.dataPaths.map((p) => p.id)).toEqual(['machine-state']);
    } finally {
      await cleanup(api, site, assets);
    }
  });

  test('duplicates a device without what identifies the original', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const { site, assets } = await seed(api, await apiAs('admin'));
    try {
      await page.goto(`/plant/assets/${assets[0]}`);
      const section = page.getByTestId('asset-network');
      await section.getByTestId('device-dev-01').getByRole('button', { name: 'Actions for device press-ipc' }).click();
      await page.getByTestId('device-duplicate').click();
      const dialog = page.getByRole('dialog', { name: 'Duplicate device press-ipc' });
      await expect(dialog.getByTestId('duplicate-device-id')).toHaveValue('dev-01-2');
      await chooseOption(page, 'Target asset', /^Welder 1/);
      await expectAccessible(page, 'duplicate device dialog');
      await dialog.getByTestId('duplicate-device-save').click();
      await expect(dialog).toBeHidden();
      const welder = await network(api, assets[2]);
      expect(welder.devices).toEqual([expect.objectContaining({ id: 'dev-01-2', hostname: '', address: '', mac: '', serial: '', vlan: `${site}-v110` })]);
    } finally {
      await cleanup(api, site, assets);
    }
  });

  test('moves the assets selected in the asset list to one place', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const { site, assets } = await seed(api, await apiAs('admin'));
    try {
      await page.goto(`/plant/assets?site=${site}`);
      await page.getByTestId(`select-${assets[1]}`).first().check();
      await page.getByTestId(`select-${assets[2]}`).first().check();
      await page.getByTestId('bulk-move').click();
      const dialog = page.getByTestId('bulk-dialog');
      await chooseOption(page, 'New place', 'Welding');
      await dialog.getByTestId('bulk-preview-button').click();
      await expect(dialog.getByTestId('bulk-preview')).toContainText('Changes: 2');
      await dialog.getByTestId('bulk-apply').click();
      await expect(dialog).toBeHidden();
      for (const a of [assets[1], assets[2]]) {
        const x = await (await api.get(`/api/plant/assets/${a}`)).json();
        expect(x.location.area.id).toBe(`${site}-welding`);
      }
      expect((await (await api.get(`/api/plant/assets/${assets[0]}`)).json()).location.area.id).toBe(`${site}-pressing`);
    } finally {
      await cleanup(api, site, assets);
    }
  });
});

test.describe('on a phone', () => {
  test.use({ storageState: authFile('dana') });

  test('the move dialog fits the screen @mobile', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const { site, assets } = await seed(api, await apiAs('admin'));
    try {
      await page.goto(`/plant/assets/${assets[0]}`);
      await page.getByTestId('device-dev-02').getByRole('button', { name: 'Actions for device press-gw' }).click();
      await page.getByTestId('device-move').click();
      const dialog = page.getByRole('dialog', { name: 'Move device press-gw' });
      await chooseOption(page, 'Target asset', /^Robot 1/);
      // the data path names a device that stays: refused, with the reason
      await expect(dialog.getByTestId('move-entries-preview')).toContainText('dev-01');
      await expect(dialog.getByTestId('move-entries-apply')).toBeDisabled();
      await settle(page);
      await expectNoHorizontalScroll(page);
      await expectAccessible(page, 'move dialog on a phone');
    } finally {
      await cleanup(api, site, assets);
    }
  });
});
