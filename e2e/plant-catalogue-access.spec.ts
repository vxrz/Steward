import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll, uniq } from './support/helpers';

/**
 * Device profiles of a team (0.21.0, #293; ADR 0033 decision 10): a reader outside the team sees the asset's interfaces
 * and data points as "Model of this asset" without the profile's name, and a derived profile marks its base "Base
 * hidden"; the profile page has its Owning teams panel. On a desktop and on a phone, with axe. Invented names only.
 */

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };

const ok = async <T = unknown>(p: Promise<{ ok(): boolean; text(): Promise<string>; json(): Promise<unknown> }>): Promise<T> => {
  const r = await p;
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()) as T;
};

async function fixture(api: APIRequestContext, tag: string) {
  const base = `e2e-team-base-${tag}`.toLowerCase();
  const child = `e2e-team-child-${tag}`.toLowerCase();
  const asset = `e2e-team-asset-${tag}`.toLowerCase();
  const site = `e2e-team-site-${tag}`.toLowerCase();
  const baseName = `E2E secret controller ${tag}`;
  await ok(api.put('/api/settings/plant', { data: SETTINGS }));
  await ok(
    api.post('/api/plant/profiles', {
      data: {
        id: base,
        name: baseName,
        manufacturer: 'Invented Controls AG',
        interfaces: [
          {
            id: 'opc',
            name: 'OPC UA server',
            protocol: 'opc_ua',
            groups: [{ name: 'State', dataPoints: [{ id: 'program_status', name: 'Program status', address: 'ns=2;s=Program.Status' }] }],
          },
        ],
      },
    }),
  );
  await ok(api.post('/api/plant/profiles', { data: { id: child, name: `E2E open variant ${tag}`, extends: base } }));
  // a site of its own: the demo sites' figures stay as other specs expect them
  await ok(api.post('/api/plant/sites', { data: { id: site, name: `E2E team works ${tag}` } }));
  await ok(api.post('/api/plant/assets', { data: { id: asset, siteId: site, name: `E2E team mill ${tag}` } }));
  await ok(api.put(`/api/plant/assets/${asset}/assignment`, { data: { profileId: base, interfaces: [{ interface: 'opc', active: true }] } }));
  // a team without members keeps the base to administrators (and auditors)
  const team = await ok<{ id: string }>(api.post('/api/teams', { data: { name: uniq('Invented controls team').replace(/[^\w .@-]/g, '') } }));
  await ok(api.put(`/api/owning-teams/device_profile/${base}`, { data: { teamIds: [team.id] } }));
  return { base, baseName, child, asset, site, team: team.id };
}

async function cleanup(api: APIRequestContext, f: Awaited<ReturnType<typeof fixture>>) {
  await api.delete(`/api/plant/assets/${f.asset}`);
  await api.delete(`/api/plant/sites/${f.site}`);
  for (const p of [f.child, f.base]) await api.post('/api/plant/bulk', { data: { kind: 'profile', action: 'remove', items: [{ id: p }], cascade: true } });
  await api.delete(`/api/teams/${f.team}`);
}

for (const tag of ['', ' @mobile'])
  test.describe(`plant profiles of a team${tag}`, () => {
    test.use({ storageState: authFile('vera') });

    test('a hidden profile is the model of the asset; a derived profile marks its base hidden', async ({ page, apiAs }, info) => {
      const admin = await apiAs('admin');
      const f = await fixture(admin, `${info.project.name}-${Date.now()}`);
      try {
        await page.goto(`/plant/assets/${f.asset}`);
        const data = page.getByTestId('asset-data');
        await expect(data.getByTestId('asset-model-hidden')).toContainText('This asset has a device profile you may not see');
        await expect(data.getByText('Model of this asset')).toBeVisible();
        const points = data.getByTestId('asset-model-points');
        await points.getByRole('button', { name: /Data points of this asset’s model/ }).click();
        await expect(points).toContainText('Program status');
        await expect(page.locator('body')).not.toContainText(f.baseName);
        await expect(page.locator('body')).not.toContainText(f.base);
        await expectAccessible(page, 'asset with a hidden profile');
        await expectNoHorizontalScroll(page);

        await page.goto(`/plant/profiles/${f.child}`);
        await expect(page.getByTestId('base-hidden')).toHaveText('Base hidden');
        await expect(page.getByTestId('base-hidden-hint')).toContainText('extends a base profile you may not see');
        await expect(page.getByTestId('origin-inherited').first()).toContainText('a base profile you may not see');
        await expect(page.locator('body')).not.toContainText(f.baseName);
        await expectAccessible(page, 'derived profile with a hidden base');
        await expectNoHorizontalScroll(page);

        // the list counts what it leaves out
        await page.goto('/plant/profiles');
        await expect(page.getByTestId('hidden-profiles')).toContainText('you may not see');
        await page.goto(`/plant/profiles/${f.base}`);
        await expect(page.getByText(f.baseName)).toHaveCount(0);
      } finally {
        await cleanup(admin, f);
      }
    });
  });

test.describe('the owning teams of a profile', () => {
  test.use({ storageState: authFile('admin') });

  test('the profile page has its Owning teams panel', async ({ page, apiAs }, info) => {
    const admin = await apiAs('admin');
    const f = await fixture(admin, `${info.project.name}-o-${Date.now()}`);
    try {
      await page.goto(`/plant/profiles/${f.base}`);
      await expect(page.getByText('Owning teams', { exact: true })).toBeVisible();
      await expect(page.getByText(/Only members of these teams see this device profile/)).toBeVisible();
      await expectAccessible(page, 'profile with owning teams');
    } finally {
      await cleanup(admin, f);
    }
  });
});
