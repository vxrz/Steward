import fs from 'node:fs';
import path from 'node:path';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { ROOT, authFile } from './support/env';

/**
 * Searchable pickers that ask the server as one types (0.20.0): an item whose label has a detail
 * ("Gateway (server · Invented AG)") stays as it is while nothing is typed – the field does not flicker between its
 * label with and without the detail, and nothing keeps asking /api/link-targets. Seen in the data path dialog: the
 * collector's host and a destination's target.
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

/** The values a field shows over a while (every 100 ms). */
async function valuesOver(field: Locator, ms: number): Promise<string[]> {
  const out: string[] = [];
  for (let t = 0; t < ms; t += 100) {
    out.push(await field.inputValue());
    await field.page().waitForTimeout(100);
  }
  return out;
}

function countTargets(page: Page) {
  const urls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/link-targets')) urls.push(r.url());
  });
  return urls;
}

test.describe('searchable pickers', () => {
  test.use({ storageState: authFile('dana') });

  test('an item with a detail stays as it is and asks the server nothing more while idle', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    await networkOn(admin);
    const dana = await apiAs('dana');
    const tag = `${Date.now()}`;
    const mk = async (name: string) => {
      const r = await dana.post('/api/systems', { data: { name, kind: 'server', vendor: 'Invented Gateways AG' } });
      expect(r.ok(), await r.text()).toBe(true);
      return (await r.json()) as { id: string; name: string };
    };
    const gw = await mk(`E2E gateway ${tag}`);
    const store = await mk(`E2E store ${tag}`);
    const pathId = `e2e-picker-${tag}`;
    const created = await dana.post('/api/plant/assets/rvs-mill-02/paths', {
      data: {
        id: pathId,
        subject: `E2E picker ${tag}`,
        collector: { kind: 'job', ref: 'e2e-job', host: gw.id },
        destinations: [{ kind: 'system', ref: store.id, path: '' }],
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    try {
      await page.goto(`/plant/assets/rvs-mill-02`);
      await page
        .getByTestId(`path-${pathId}`)
        .getByRole('button', { name: `Actions for data path E2E picker ${tag}` })
        .click();
      await page.getByRole('menuitem', { name: 'Edit' }).click();
      const dialog = page.getByRole('dialog', { name: `Data path E2E picker ${tag}` });
      const host = dialog.getByRole('combobox', { name: 'Runs on' });
      const target = dialog.getByTestId('path-destinations').getByRole('combobox', { name: 'Target' });
      const withDetail = (name: string) => `${name} (server · Invented Gateways AG)`;
      await expect(host).not.toHaveValue('');
      // settled: from now on, nothing changes and nothing is asked
      await page.waitForTimeout(1200);
      const requests = countTargets(page);
      const hostValues = await valuesOver(host, 1500);
      const targetValues = await valuesOver(target, 600);
      expect(new Set(hostValues).size, hostValues.join(' | ')).toBe(1);
      expect(new Set(targetValues).size, targetValues.join(' | ')).toBe(1);
      expect([gw.name, withDetail(gw.name)]).toContain(hostValues[0]);
      expect([store.name, withDetail(store.name)]).toContain(targetValues[0]);
      expect(requests, requests.join('\n')).toEqual([]);

      // searching finds it; choosing it leaves one label that stays
      await host.click();
      await host.fill(`E2E store ${tag}`);
      await page.getByRole('option', { name: withDetail(store.name) }).click();
      await expect(host).toHaveValue(withDetail(store.name));
      await page.waitForTimeout(800);
      const after = countTargets(page);
      const chosen = await valuesOver(host, 1200);
      expect(new Set(chosen).size, chosen.join(' | ')).toBe(1);
      expect(chosen[0]).toBe(withDetail(store.name));
      expect(after, after.join('\n')).toEqual([]);
      await dialog.getByRole('button', { name: 'Cancel' }).click();
    } finally {
      await dana.delete(`/api/plant/assets/rvs-mill-02/paths/${pathId}`);
      await dana.delete(`/api/systems/${gw.id}`);
      await dana.delete(`/api/systems/${store.id}`);
    }
  });
});
