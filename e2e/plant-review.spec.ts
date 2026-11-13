import fs from 'node:fs';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { ROOT, authFile } from './support/env';
import { expectAccessible } from './support/axe';

/**
 * The plant registry after the review of 0.20.0: its dialogs ask before discarding what was entered (as every form
 * dialog does), a data path's transfers explain pull, push and receive, a zone lists Steward systems, and the site's
 * data paths are found by their peers and destinations.
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

test.describe('plant dialogs and the OT network', () => {
  test.use({ storageState: authFile('dana') });
  test.beforeEach(async ({ apiAs }) => networkOn(await apiAs('admin')));

  test('the data path dialog explains the modes and asks before discarding', async ({ page }) => {
    await page.goto('/plant/assets/rvs-mill-02');
    const opener = page.getByTestId('asset-network').getByTestId('add-path');
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'New data path' });
    const discard = page.getByRole('dialog', { name: 'Discard your changes?' });
    await dialog.getByRole('textbox', { name: 'Subject' }).fill('Alarms over MQTT');
    await dialog.getByRole('button', { name: 'Add transfer' }).click();
    const transfer = dialog.getByTestId('path-transfers');
    await expect(transfer).toContainText('Seen from the collector');
    const mode = transfer.getByRole('combobox', { name: 'Pull, push or receive' });
    await mode.click();
    await expect(page.getByRole('option', { name: /Receive/ })).toContainText('The peer sends the data to the collector');
    await page.getByRole('option', { name: /Receive/ }).click();
    await expect(mode).toHaveValue('Receive');
    await expect(transfer.getByRole('combobox', { name: 'Kind of peer' })).toBeVisible();
    await expectAccessible(page, 'data path dialog with a transfer');

    // Esc asks; keeping on editing keeps the text
    await page.keyboard.press('Escape');
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog.getByRole('textbox', { name: 'Subject' })).toHaveValue('Alarms over MQTT');
    // Cancel asks as well; Discard closes and gives the focus back
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Discard' }).click();
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('a zone lists Steward systems; the site’s data paths are found by their peers', async ({ page, apiAs }) => {
    const dana = await apiAs('dana');
    const tag = `${Date.now()}`;
    const sys = await (await dana.post('/api/systems', { data: { name: `E2E cloud historian ${tag}`, kind: 'server', vendor: 'Invented Cloud AG' } })).json();
    const zoneId = `e2e-ext-${tag}`;
    try {
      await page.goto('/plant/sites/riverside/network/zones');
      await page.getByTestId('add-zone').click();
      const dialog = page.getByRole('dialog', { name: 'New zone' });
      await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(`E2E external ${tag}`);
      await dialog.getByRole('textbox', { name: 'ID', exact: true }).fill(zoneId);
      await expectAccessible(page, 'zone dialog');
      const systems = dialog.getByLabel('Steward systems');
      await systems.click();
      await systems.fill(`E2E cloud historian ${tag}`);
      await page.getByRole('option', { name: `E2E cloud historian ${tag} (server · Invented Cloud AG)` }).click();
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toBeHidden();
      const card = page.getByTestId(`zone-${zoneId}`);
      await expect(card.getByTestId('zone-items')).toContainText(`E2E cloud historian ${tag}`);
      await expectAccessible(page, 'zone with a system');

      // a data path that pushes to it is found by the system's name on the site's data paths
      expect(
        (
          await dana.post('/api/plant/assets/rvs-mill-02/paths', {
            data: {
              id: `e2e-push-${tag}`,
              subject: `E2E push ${tag}`,
              collector: { kind: 'job', ref: 'e2e' },
              transfers: [{ protocol: 'https', mode: 'push', peerKind: 'system', peer: sys.id }],
            },
          })
        ).ok(),
      ).toBe(true);
      await page.goto('/plant/sites/riverside/network/paths');
      await page.getByRole('searchbox', { name: 'Search subject, collector, protocol, peer, destination' }).fill(`historian ${tag}`);
      await expect(page.getByTestId(`site-path-e2e-push-${tag}`)).toBeVisible();
      await expect(page.getByTestId('site-path-machine-state')).toHaveCount(0);
    } finally {
      await dana.delete(`/api/plant/assets/rvs-mill-02/paths/e2e-push-${tag}`);
      await dana.delete(`/api/plant/sites/riverside/zones/${zoneId}`);
      await dana.delete(`/api/systems/${sys.id}`);
    }
  });
});
