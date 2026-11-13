import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll, uniq } from './support/helpers';
import { ownApi, ownUser } from './support/ownUser';

/**
 * Device profiles of a team (0.21.0, #293; ADR 0033 decision 10): a reader outside the team sees the asset's interfaces
 * and data points as "Model of this asset" without the profile's name, and a derived profile marks its base "Base
 * hidden"; the profile's and the KPI definition's Access tab – owning teams and _Shared with_: a designer of the team
 * shares the profile with a reader (preview, step-up), who then sees it. On a desktop and on a phone, with axe.
 * Invented names only.
 */

/** The password of users made with ownUser() after their first sign-in. */
const OWN_PASSWORD = 'Own-e2e-password-2';

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };

const ok = async <T = unknown>(p: Promise<{ ok(): boolean; text(): Promise<string>; json(): Promise<unknown> }>): Promise<T> => {
  const r = await p;
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()) as T;
};

async function fixture(api: APIRequestContext, tag: string, designers: string[] = []) {
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
  // a team without members keeps the base to administrators (and auditors); its designers manage it (decision 13)
  const team = await ok<{ id: string }>(
    api.post('/api/teams', {
      data: {
        name: uniq('Invented controls team').replace(/[^\w .@-]/g, ''),
        members: designers,
        memberRoles: Object.fromEntries(designers.map((d) => [d, ['designer']])),
      },
    }),
  );
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

test.describe('the Access tab of a profile and a KPI definition', () => {
  test.use({ storageState: authFile('admin') });

  test('the profile and the KPI definition have their Access tab with owning teams and shares', async ({ page, apiAs }, info) => {
    const admin = await apiAs('admin');
    const f = await fixture(admin, `${info.project.name}-o-${Date.now()}`);
    const kpi = `e2e-team-kpi-${info.project.name}-${Date.now()}`.toLowerCase();
    await ok(admin.post('/api/plant/kpis', { data: { id: kpi, name: `E2E team KPI ${kpi}`, inputs: [{ profile: f.base, dataPoints: ['program_status'] }] } }));
    await ok(admin.put(`/api/owning-teams/kpi_definition/${kpi}`, { data: { teamIds: [f.team] } }));
    try {
      await page.goto(`/plant/profiles/${f.base}`);
      // a copy stays with the original's owning teams: the dialog says so
      await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
      await expect(page.getByTestId('duplicate-plant-scope')).toContainText('The copy belongs to the same owning teams as the original');
      await expectAccessible(page, 'duplicating a profile of a team');
      await page.getByTestId('duplicate-dialog').getByRole('button', { name: 'Cancel' }).click();
      await page.getByTestId('profile-tab-access').click();
      await expect(page).toHaveURL(/\/access$/);
      await expect(page.getByText('Owning teams', { exact: true })).toBeVisible();
      await expect(page.getByText(/Only members of these teams see this device profile/)).toBeVisible();
      await expect(page.getByTestId('shares-panel').getByTestId('shares-empty')).toBeVisible();
      await expectAccessible(page, 'access tab of a profile');

      await page.goto(`/plant/kpis/${kpi}/access`);
      await expect(page.getByTestId('shares-panel').getByRole('heading', { name: 'Shared with' })).toBeVisible();
      await expect(page.getByText('Owning teams', { exact: true })).toBeVisible();
      await expectAccessible(page, 'access tab of a KPI definition');
    } finally {
      await admin.delete(`/api/plant/kpis/${kpi}`);
      await cleanup(admin, f);
    }
  });
});

for (const tag of ['', ' @mobile'])
  test.describe(`sharing a profile of a team${tag}`, () => {
    test('a designer of the team shares the profile with a reader, who then sees it', async ({ browser, apiAs }, info) => {
      const admin = await apiAs('admin');
      // an operator who designs in the team (decision 13: designers among the members manage it) and a reader
      const designer = await ownUser('e2e-plantsharer-', ['operator'], 'Pat Plant Sharer (own)');
      const reader = await ownUser('e2e-plantreader-', ['viewer'], 'Rita Plant Reader (own)');
      const f = await fixture(admin, `${info.project.name}-s-${Date.now()}`, [designer.username]);
      // the designer's session is not confirmed: giving access asks for the step-up
      const dApi = await ownApi(designer);
      expect((await dApi.delete('/api/auth/step-up')).ok()).toBe(true);
      const ctx = await browser.newContext({
        baseURL: baseURL(),
        serviceWorkers: 'block',
        storageState: designer.file,
        viewport: info.project.use.viewport ?? undefined,
      });
      const rCtx = await browser.newContext({
        baseURL: baseURL(),
        serviceWorkers: 'block',
        storageState: reader.file,
        viewport: info.project.use.viewport ?? undefined,
      });
      const page = await ctx.newPage();
      const rPage = await rCtx.newPage();
      try {
        // the reader does not see the profile yet
        await rPage.goto(`/plant/profiles/${f.base}`);
        await expect(rPage.getByText(f.baseName)).toHaveCount(0);

        await page.goto(`/plant/profiles/${f.base}/access`);
        const panel = page.getByTestId('shares-panel');
        await expect(panel.getByTestId('shares-empty')).toHaveText('Not shared with anyone.');
        await panel.getByRole('combobox', { name: 'Share with' }).click();
        await page.keyboard.type(reader.username);
        await page.getByRole('option', { name: `(${reader.username})` }).click();
        await panel.getByRole('button', { name: 'Add', exact: true }).click();
        const row = panel.getByTestId('share-row');
        await expect(row).toHaveCount(1);
        // the kind's action right beside the level
        await row.getByRole('checkbox', { name: 'propose' }).check();
        await panel.getByRole('button', { name: 'Save shares' }).click();
        const preview = page.getByRole('dialog', { name: 'Before you save' });
        await expect(preview).toContainText('Rita Plant Reader (own) gains: View, propose');
        await expectAccessible(page, 'preview of a profile share');
        await preview.getByRole('button', { name: 'Save', exact: true }).click();
        const stepUp = page.getByRole('dialog', { name: 'Confirm it is you' });
        await stepUp.getByLabel('Your password').fill(OWN_PASSWORD);
        await stepUp.getByRole('button', { name: 'Confirm' }).click();
        await expect(page.getByText('Shares saved')).toBeVisible();
        await expect(row).toContainText('Rita Plant Reader (own)');
        await expectAccessible(page, 'access tab of a shared profile');
        await expectNoHorizontalScroll(page);

        // the reader sees it now, and why
        await rPage.goto(`/plant/profiles/${f.base}`);
        await expect(rPage.getByRole('heading', { name: f.baseName })).toBeVisible();
        await rPage.goto(`/plant/profiles/${f.base}/access`);
        await expect(rPage.getByText('Owning teams', { exact: true })).toBeVisible();
        await rPage.getByRole('button', { name: 'Why do I have access?' }).click();
        await expect(rPage.getByRole('dialog', { name: 'Who may do what, and why' })).toContainText('Shared with');
        await expectAccessible(rPage, 'why a shared profile is seen');
        await expectNoHorizontalScroll(rPage);
      } finally {
        await ctx.close();
        await rCtx.close();
        await dApi.dispose();
        await cleanup(admin, f);
      }
    });
  });
