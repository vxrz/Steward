import type { APIRequestContext, Page } from '@playwright/test';
import { expect } from './support/fixtures';
import { designerTest as test } from './support/ownUser';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll } from './support/helpers';

/**
 * Security advisories of the plant registry (0.14, docs/ADVISORIES.md): a designer uploads an invented CSAF advisory,
 * sees the affected asset with the reason and the fixed firmware, confirms a possible match, sets a remediation status
 * and finds the advisory on the asset's page. Every test makes its own invented vendor, site and assets.
 */

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };
const ok = async (p: Promise<{ ok(): boolean; text(): Promise<string> }>) => {
  const r = await p;
  expect(r.ok(), await r.text()).toBe(true);
};

/** An invented vendor with a controller ZX 100: one asset on firmware 2.3.1 (exact), one "ZX 100 Pro" without firmware (possible). */
async function plant(api: APIRequestContext, tag: string) {
  const vendor = `Zelt Automation ${tag}`;
  const site = `e2e-adv-${tag}`;
  const profile = `e2e-zx100-${tag}`;
  const exact = `e2e-adv-exact-${tag}`;
  const possible = `e2e-adv-possible-${tag}`;
  await ok(api.post('/api/plant/sites', { data: { id: site, name: `E2E advisory works ${tag}` } }));
  await ok(api.post('/api/plant/profiles', { data: { id: profile, name: `E2E ZX 100 ${tag}`, manufacturer: vendor, model: 'ZX 100', version: '2.x' } }));
  await ok(api.post('/api/plant/assets', { data: { id: exact, siteId: site, name: `E2E press ${tag}`, manufacturer: 'E2E Presses', model: 'P1' } }));
  await ok(api.put(`/api/plant/assets/${exact}/assignment`, { data: { profileId: profile, firmware: '2.3.1' } }));
  await ok(api.post('/api/plant/assets', { data: { id: possible, siteId: site, name: `E2E cell ${tag}`, manufacturer: vendor, model: 'ZX 100 Pro' } }));
  return { vendor, site, profile, exact, possible };
}

function advisory(vendor: string, tag: string): string {
  return JSON.stringify({
    document: {
      category: 'csaf_security_advisory',
      csaf_version: '2.0',
      distribution: { tlp: { label: 'WHITE' } },
      notes: [{ category: 'summary', text: `Invented advisory for the end-to-end test ${tag}.` }],
      publisher: { category: 'vendor', name: `${vendor} GmbH`, namespace: `https://psirt.zelt-${tag}.example` },
      title: `ZX-100: invented weakness ${tag}`,
      tracking: {
        id: `ZELT-SA-${tag}`,
        version: '1',
        status: 'final',
        initial_release_date: '2026-11-01T00:00:00Z',
        current_release_date: '2026-11-01T00:00:00Z',
        revision_history: [{ date: '2026-11-01T00:00:00Z', number: '1', summary: 'Initial' }],
      },
    },
    product_tree: {
      branches: [
        {
          category: 'vendor',
          name: `${vendor} GmbH`,
          branches: [
            {
              category: 'product_name',
              name: 'ZX-100',
              branches: [
                { category: 'product_version_range', name: 'vers:generic/<2.4', product: { name: 'ZX-100 <2.4', product_id: 'P1' } },
                { category: 'product_version', name: '2.4', product: { name: 'ZX-100 2.4', product_id: 'P2' } },
              ],
            },
          ],
        },
      ],
    },
    vulnerabilities: [
      {
        cve: 'CVE-2099-20001',
        product_status: { known_affected: ['P1'], fixed: ['P2'] },
        remediations: [{ category: 'vendor_fix', details: 'Update the firmware to 2.4.', product_ids: ['P1'] }],
        scores: [{ products: ['P1'], cvss_v3: { baseScore: 7.1, baseSeverity: 'HIGH', vectorString: 'CVSS:3.1/AV:A/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:H' } }],
      },
    ],
  });
}

async function cleanup(api: APIRequestContext, f: Awaited<ReturnType<typeof plant>>, advisoryId?: string) {
  if (advisoryId) await api.delete(`/api/plant/advisories/${advisoryId}`);
  for (const a of [f.exact, f.possible]) await api.delete(`/api/plant/assets/${a}`);
  await api.delete(`/api/plant/profiles/${f.profile}`);
  await api.delete(`/api/plant/sites/${f.site}`);
}

async function upload(page: Page, tag: string, vendor: string) {
  await page.goto('/plant/advisories');
  await expect(page.getByRole('heading', { name: 'Advisories' })).toBeVisible();
  await page
    .getByTestId('plant-advisories')
    .locator('input[type="file"]')
    .setInputFiles({ name: `zelt-sa-${tag}.json`, mimeType: 'application/json', buffer: Buffer.from(advisory(vendor, tag)) });
  await expect(page.getByRole('heading', { name: `ZX-100: invented weakness ${tag}` })).toBeVisible();
  return page.url().split('/').pop()!.split('?')[0]!;
}

test.describe('security advisories', () => {
  test.beforeEach(async ({ apiAs }) => ok((await apiAs('admin')).put('/api/settings/plant', { data: SETTINGS })));

  test('upload an advisory, see the affected asset, confirm a possible match, set a remediation status', async ({ page, designerApi: api }) => {
    const tag = Date.now().toString(36);
    const f = await plant(api, tag);
    let id: string | undefined;
    try {
      id = await upload(page, tag, f.vendor);
      // the exact match: the reason (via the device profile) and the fixed firmware
      const affected = page.getByTestId('advisory-affected');
      const exact = affected.getByTestId(`advisory-match-${f.exact}`);
      await expect(exact).toContainText(`E2E press ${tag}`);
      await expect(exact.getByTestId('match-reason')).toContainText('firmware 2.3.1 in vers:generic/<2.4');
      await expect(exact.getByTestId('match-reason')).toContainText(`via device profile ${f.profile}`);
      await expect(exact.getByTestId('match-fix')).toContainText('2.4');
      await expect(exact.getByTestId('remediation-status')).toHaveText('Open');
      // the possible match is shown apart, not counted
      const possible = page.getByTestId('advisory-possible').getByTestId(`advisory-match-${f.possible}`);
      await expect(possible).toContainText('model similar');
      await expectAccessible(page, 'advisory page');
      await possible.getByTestId('match-confirm').click();
      const confirm = page.getByRole('dialog', { name: `Confirm the match on E2E cell ${tag}` });
      await confirm.getByTestId('decision-reason').fill('The Pro has the same controller');
      await confirm.getByTestId('decision-save').click();
      await expect(confirm).toBeHidden();
      await expect(affected.getByTestId(`advisory-match-${f.possible}`)).toContainText('Confirmed by');
      await expect(page.getByTestId('advisory-possible')).toHaveCount(0);
      // remediation: mitigated, with a note
      await exact.getByTestId('remediation-open').click();
      const fix = page.getByRole('dialog', { name: `Remediation of E2E press ${tag}` });
      await expect(fix.getByTestId('suggested-fix')).toContainText('2.4');
      await fix.getByTestId('remediation-select').click();
      await page.getByRole('option', { name: 'Mitigated' }).click();
      await fix.getByLabel('Note').fill('Firmware 2.4 installed');
      await fix.getByTestId('remediation-save').click();
      await expect(fix).toBeHidden();
      await expect(exact.getByTestId('remediation-status')).toHaveText('Mitigated');
      // the list: two affected assets, one still open
      await page.goto(`/plant/advisories?site=${f.site}`);
      const row = page.getByTestId('advisories-table').getByRole('row', { name: `ZELT-SA-${tag}` });
      await expect(row).toContainText('2 assets');
      await expect(row).toContainText('1 open');
      await expect(row).toContainText('Open');
      await expectAccessible(page, 'advisory list');
      // the asset's page: its advisories, open while one is open
      await page.goto(`/plant/assets/${f.possible}`);
      const section = page.getByTestId('section-advisories');
      await expect(section).toBeVisible();
      await expect(section.getByTestId('asset-advisory')).toContainText(`ZX-100: invented weakness ${tag}`);
      await expect(section.getByTestId('remediation-status')).toHaveText('Open');
    } finally {
      await cleanup(api, f, id);
    }
  });

  test('advisories on a phone @mobile', async ({ page, designerApi: api }) => {
    const tag = `m${Date.now().toString(36)}`;
    const f = await plant(api, tag);
    let id: string | undefined;
    try {
      id = await upload(page, tag, f.vendor);
      await expect(page.getByTestId(`advisory-match-${f.exact}`)).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.goto(`/plant/advisories?site=${f.site}`);
      await expect(page.getByText(`ZX-100: invented weakness ${tag}`)).toBeVisible();
      await expectNoHorizontalScroll(page);
    } finally {
      await cleanup(api, f, id);
    }
  });
});
