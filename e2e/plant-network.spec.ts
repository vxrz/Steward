import fs from 'node:fs';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { ROOT, authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll } from './support/helpers';

/**
 * The plant registry, part 3 (#220): the OT network of a site on its tabs – the live status of its assets, the
 * IEEE 802.1Q VLANs (with "Create segment from this VLAN"), the IEC 62443-3-2 zones and conduits, the devices and data
 * paths – and the OT network of an asset, on a desktop and on a phone, with axe. The invented example
 * (examples/plant/brightwater-ot-network.plant.yaml) is imported once.
 */

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };
const EXAMPLE = 'brightwater-ot-network.plant.yaml';

async function networkOn(api: APIRequestContext) {
  const res = await api.put('/api/settings/plant', { data: SETTINGS });
  expect(res.ok(), await res.text()).toBe(true);
  const n = await (await api.get('/api/plant/sites/riverside/network')).json();
  if (n.vlans?.some((v: { id: string }) => v.id === 'rvs-vlan-110')) return;
  const content = fs.readFileSync(path.join(ROOT, 'examples/plant', EXAMPLE), 'utf8');
  const imp = await api.post('/api/plant/import', { data: { files: [{ name: EXAMPLE, content }], mode: 'add' } });
  expect(imp.ok(), await imp.text()).toBe(true);
}

// a tab by (part of) its name – a count may follow it; no RegExp built from a string
const tab = (page: Page, name: string) => page.getByTestId('link-tabs').getByRole('link', { name });

test.describe('as a designer', () => {
  test.use({ storageState: authFile('dana') });
  test.beforeEach(async ({ apiAs }) => networkOn(await apiAs('admin')));

  test('the site: its live status, VLANs (a new one, a segment from it), zones and conduits, devices and data paths', async ({ page, apiAs }) => {
    await page.goto('/plant/sites/riverside');
    const card = page.getByTestId('site-network-card');
    await expect(card.getByTestId('live-count-unknown')).toBeVisible();
    await card.getByTestId('open-network').click();
    await expect(page).toHaveURL(/\/plant\/sites\/riverside\/network$/);
    await expect(page.getByRole('heading', { name: /OT network/, level: 1 })).toBeVisible();
    // nothing is linked: unknown, never online
    await expect(page.getByTestId('live-rvs-mill-01').getByTestId('live-badge')).toHaveAttribute('data-state', 'unknown');
    await expectAccessible(page, 'OT network status');

    await tab(page, 'VLANs').click();
    await expect(page).toHaveURL(/\/network\/vlans$/);
    const vlan = page.getByTestId('vlan-rvs-vlan-110');
    await expect(vlan).toContainText('VID 110');
    await expect(vlan).toContainText('10.20.110.0/24');
    await expect(vlan).toContainText('Blocked: 10.20.110.1 – 10.20.110.9');
    await expectAccessible(page, 'OT network VLANs');

    const id = `e2e-vlan-${Date.now()}`;
    await page.getByTestId('add-vlan').click();
    const dialog = page.getByRole('dialog', { name: 'New VLAN' });
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('E2E test bench');
    await dialog.getByRole('textbox', { name: 'Id', exact: true }).fill(id);
    await dialog.getByRole('textbox', { name: 'VLAN ID (VID)' }).fill('140');
    await dialog.getByTestId('add-subnet').click();
    await dialog.getByRole('textbox', { name: 'Subnet (CIDR)' }).fill('10.20.140.0/33');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByText('Use CIDR notation: 10.20.110.0/24 or 2001:db8::/48.')).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Subnet (CIDR)' }).fill('10.20.140.0/24');
    await expectAccessible(page, 'new VLAN dialog');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    const created = page.getByTestId(`vlan-${id}`);
    await expect(created).toContainText('VID 140');
    // "Create segment from this VLAN"
    await created.getByRole('button', { name: 'Actions for VLAN E2E test bench' }).click();
    await page.getByTestId('create-segment').click();
    const seg = page.getByRole('dialog', { name: /Network segment from VLAN/ });
    await seg.getByRole('textbox', { name: 'Name of the segment' }).fill(`E2E segment ${id}`);
    await seg.getByRole('button', { name: 'Save' }).click();
    await expect(seg).toBeHidden();
    await expect(created.getByRole('link', { name: `E2E segment ${id}` })).toBeVisible();

    await tab(page, 'Zones and conduits').click();
    const cells = page.getByTestId('zone-rvs-zone-cells');
    await expect(cells.getByTestId('sl-badge')).toHaveText('SL-T 2');
    await expect(page.getByTestId('zone-rvs-zone-dmz').getByTestId('sl-badge')).toHaveText('SL-T open');
    const conduit = page.getByTestId('conduit-rvs-cdt-cells-dmz');
    await expect(conduit).toContainText('opc-ua tcp/4840');
    await expect(conduit).toContainText('None links to it yet.');
    await expectAccessible(page, 'OT network zones and conduits');

    await tab(page, 'Devices').click();
    const devices = page.getByTestId('network-devices');
    await expect(devices.getByTestId('site-device-rvs-mill-01-ipc')).toContainText('10.20.110.21');
    await devices.getByRole('textbox', { name: 'Search host, address, MAC, port' }).fill('53-21');
    await expect(devices.getByTestId('site-device-rvs-mill-02-ipc')).toBeVisible();
    await expect(devices.getByTestId('site-device-rvs-mill-01-ipc')).toBeHidden();
    await expectAccessible(page, 'OT network devices');

    await tab(page, 'Data paths').click();
    await expect(page.getByTestId('site-path-nc-programs')).toContainText('smb/445');
    await expectAccessible(page, 'OT network data paths');

    // clean up: the VLAN (its segment stays in the catalogue, as any system)
    const api = await apiAs('dana');
    expect((await api.delete(`/api/plant/sites/riverside/vlans/${id}`)).ok()).toBe(true);
  });

  test('an asset: its live status, a new device (MAC as EUI-48) and its data paths', async ({ page, apiAs }) => {
    await page.goto('/plant/assets/rvs-mill-01');
    const section = page.getByTestId('asset-network');
    await expect(section.getByTestId('device-rvs-mill-01-ipc')).toContainText('rvs-mill-01-ipc.ot.example.com');
    await expect(section.getByTestId('path-machine-state')).toContainText('Machine state and spindle values');
    const id = `e2e-dev-${Date.now()}`;
    await section.getByTestId('add-device').click();
    const dialog = page.getByRole('dialog', { name: 'New device' });
    await dialog.getByRole('textbox', { name: 'Host name' }).fill('e2e-panel');
    await dialog.getByRole('textbox', { name: 'Id', exact: true }).fill(id);
    await dialog.getByRole('textbox', { name: 'MAC (EUI-48)' }).fill('not a mac');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByText(/Use a MAC address/)).toBeVisible();
    await dialog.getByRole('textbox', { name: 'MAC (EUI-48)' }).fill('00:00:5e:00:53:99');
    await dialog.getByRole('textbox', { name: 'Address', exact: true }).fill('10.20.110.77');
    await expectAccessible(page, 'new device dialog');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(section.getByTestId(`device-${id}`)).toContainText('00-00-5E-00-53-99');
    await expectAccessible(page, 'asset OT network');
    const api = await apiAs('dana');
    expect((await api.delete(`/api/plant/assets/rvs-mill-01/devices/${id}`)).ok()).toBe(true);
  });
});

test.describe('a check someone may not see', () => {
  test.use({ storageState: authFile('dana') });
  test.beforeEach(async ({ apiAs }) => networkOn(await apiAs('admin')));

  test('counts with its state only, under a neutral label; the editor keeps it as it is', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    const key = `e2e-hidden-${Date.now()}`;
    const m = await admin.post('/api/monitors', {
      data: {
        key,
        definition: { name: 'Hidden monitor', checks: [{ id: 'hb', name: 'HB', type: 'heartbeat', key: `${key}.hb`, mode: 'maxAge', maxAgeSeconds: 600 }] },
      },
    });
    expect(m.ok(), await m.text()).toBe(true);
    const id = (await m.json()).monitor?.id ?? (await m.json()).id;
    expect((await admin.put(`/api/monitors/${id}/access`, { data: { acl: [{ subject: 'role:admin', permissions: ['view', 'edit', 'manage'] }] } })).ok()).toBe(
      true,
    );
    expect((await admin.put('/api/plant/assets/rvs-mill-03/checks', { data: { checks: [{ kind: 'monitor', ref: key }] } })).ok()).toBe(true);
    try {
      await page.goto('/plant/assets/rvs-mill-03');
      const live = page.getByTestId('asset-live');
      await expect(live.getByTestId('live-checks')).toContainText('A check you may not see');
      await expect(live.getByTestId('live-checks')).toContainText('what it checks is not shown to you');
      await expect(live).not.toContainText(key);
      await expect(live).not.toContainText('Hidden monitor');
      await live.getByTestId('edit-asset-checks').click();
      const dialog = page.getByRole('dialog', { name: 'Live-status checks of the asset' });
      await expect(dialog.getByTestId('hidden-check')).toContainText('A check you may not see');
      await expectAccessible(page, 'checks dialog with a hidden check');
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toBeHidden();
      const after = await (await admin.get('/api/plant/assets/rvs-mill-03/network')).json();
      expect(after.checks.map((c: { ref: string }) => c.ref)).toEqual([key]);
      await expectAccessible(page, 'asset with a hidden check');
    } finally {
      await admin.put('/api/plant/assets/rvs-mill-03/checks', { data: { checks: [] } });
      await admin.delete(`/api/monitors/${id}`);
    }
  });
});

test.describe('as a viewer', () => {
  test.use({ storageState: authFile('vera') });
  test.beforeEach(async ({ apiAs }) => networkOn(await apiAs('admin')));

  test('the OT network is read-only; an asset without one says who documents it', async ({ page }) => {
    await page.goto('/plant/sites/riverside/network/vlans');
    await expect(page.getByTestId('vlan-rvs-vlan-110')).toBeVisible();
    await expect(page.getByTestId('add-vlan')).toBeHidden();
    await expect(page.getByRole('button', { name: /Actions for VLAN/ })).toHaveCount(0);
    await page.goto('/plant/assets/rvs-compressor-01');
    await expect(page.getByTestId('asset-network')).toContainText('Whoever manages the site documents its OT network.');
    await expectAccessible(page, 'asset OT network (viewer)');
  });
});

test.describe('on a phone', () => {
  test.use({ storageState: authFile('dana') });
  test.beforeEach(async ({ apiAs }) => networkOn(await apiAs('admin')));

  test('the OT network pages and an asset fit the screen @mobile', async ({ page }) => {
    const pages: [string, string, (p: Page) => Promise<void>][] = [
      ['/plant/sites/riverside/network', 'OT network status', (p) => expect(p.getByTestId('live-rvs-mill-01')).toBeVisible()],
      ['/plant/sites/riverside/network/vlans', 'VLANs', (p) => expect(p.getByTestId('vlan-rvs-vlan-110')).toBeVisible()],
      ['/plant/sites/riverside/network/zones', 'zones and conduits', (p) => expect(p.getByTestId('conduit-rvs-cdt-cells-dmz')).toBeVisible()],
      ['/plant/sites/riverside/network/devices', 'devices', (p) => expect(p.getByTestId('site-device-rvs-mill-01-ipc')).toBeVisible()],
      ['/plant/sites/riverside/network/paths', 'data paths', (p) => expect(p.getByTestId('site-path-machine-state')).toBeVisible()],
      ['/plant/assets/rvs-mill-01', 'asset OT network', (p) => expect(p.getByTestId('device-rvs-mill-01-ipc')).toBeVisible()],
    ];
    for (const [url, name, ready] of pages) {
      await page.goto(url);
      await ready(page);
      await settle(page);
      await expectNoHorizontalScroll(page);
      await expectAccessible(page, `${name} on a phone`);
    }
  });
});
