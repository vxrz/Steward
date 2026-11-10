import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { appHref, authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll, json, uniq } from './support/helpers';

/**
 * Documentation still current (0.14): a designer confirms a document of an asset and the asset's documentation as a
 * whole as still current ("Last confirmed by …"), sets the site's review interval, and reads the site's Documentation
 * tab – the gaps (an asset without a profile, a device without a VLAN) and the hints, each linked. On a phone the tab
 * fits the screen. Invented names; what the test makes it removes again.
 */

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };

async function scene(admin: APIRequestContext) {
  expect((await admin.put('/api/settings/plant', { data: SETTINGS })).ok()).toBe(true);
  const id = uniq('e2e-docs')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
  const name = `Cooling unit ${id}`;
  // a site of its own: its interval and documentation tab change nothing of the shared demo sites
  const site = `${id}-site`;
  expect((await admin.post('/api/plant/sites', { data: { id: site, name: `Works ${id}` } })).ok()).toBe(true);
  const a = await admin.post('/api/plant/assets', { data: { id, siteId: site, name } });
  expect(a.ok(), await a.text()).toBe(true);
  expect((await admin.post(`/api/plant/assets/${id}/devices`, { data: { id: `${id}-plc`, hostname: `${id}-plc` } })).ok()).toBe(true);
  const rec = await json<{ id: string; title: string }>(
    await admin.post('/api/records', { data: { type: 'DOC', title: `Manual of ${name}`, links: [{ kind: 'asset', id, note: '' }] } }),
  );
  return {
    id,
    name,
    site,
    rec,
    cleanup: async () => {
      await admin.delete(`/api/plant/assets/${id}`);
      await admin.delete(`/api/plant/sites/${site}`);
    },
  };
}

test.describe('as a designer', () => {
  test.use({ storageState: authFile('dana') });

  test('confirms a document and the asset’s documentation as still current; the site’s documentation tab', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    const s = await scene(admin);
    try {
      await page.goto(`/plant/assets/${s.id}`);
      const docs = page.getByTestId('plant-documents');
      const cell = docs.getByTestId(`plant-docs-current-${s.rec.id}`);
      await expect(cell).toContainText('Not confirmed yet');
      await cell.getByRole('button', { name: `Confirm “${s.rec.title}” as still current` }).click();
      await expect(cell).toContainText(/Last confirmed by dana on/);
      const whole = docs.getByTestId('plant-docs-whole');
      await expect(whole).toContainText('Not confirmed yet');
      await whole.getByTestId('plant-docs-confirm-whole').click();
      await expect(whole).toContainText(/Last confirmed by dana on/);
      await expectAccessible(page, 'documents panel with confirmations');

      // the site's review interval (its settings) and its Documentation tab
      await page.goto(`/plant/sites/${s.site}`);
      const setting = page.getByTestId('site-doc-review');
      await setting.getByRole('textbox', { name: 'Documentation review interval' }).fill('36');
      await setting.getByRole('button', { name: 'Save interval' }).click();
      await expect(page.getByText('Review interval saved.')).toBeVisible();
      await page.getByTestId('site-tab-documentation').click();
      await expect(page).toHaveURL((url) => url.pathname.endsWith(`/plant/sites/${s.site}/documentation`));
      const health = page.getByTestId('doc-health');
      await expect(health).toContainText('every 36 months');
      const noProfile = health.getByTestId('doc-gap-assetNoProfile');
      await expect(noProfile.getByRole('link', { name: s.name })).toHaveAttribute('href', appHref(`/plant/assets/${s.id}`));
      const noVlan = health.getByTestId('doc-gap-deviceNoVlan');
      if (!(await noVlan.getByRole('link', { name: `${s.id}-plc` }).isVisible())) await noVlan.getByTestId('doc-gap-deviceNoVlan-toggle').click();
      await expect(noVlan.getByRole('link', { name: `${s.id}-plc` })).toHaveAttribute('href', appHref(`/plant/sites/${s.site}/network/devices`));
      await expectAccessible(page, 'documentation health of a site');
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('on a phone', () => {
  test.use({ storageState: authFile('dana') });

  test('the documentation tab of a site fits the screen @mobile', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    const s = await scene(admin);
    try {
      await page.goto(`/plant/sites/${s.site}/documentation`);
      await expect(page.getByTestId('doc-gap-assetNoProfile')).toBeVisible();
      await settle(page);
      await expectNoHorizontalScroll(page);
      await expectAccessible(page, 'documentation health on a phone');
    } finally {
      await s.cleanup();
    }
  });
});
