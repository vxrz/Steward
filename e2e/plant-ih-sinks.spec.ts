import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll } from './support/helpers';

/**
 * Insights Hub as a mapped sink (0.14, docs/PLANT.md "Insights Hub mapping"): a collection's items are mapped to the
 * demo tenant with the bulk tool (one asset and aspect, the same names), the mapping is checked against the simulated
 * tenant, an existing monitor shows as watching a variable, and a disabled draft monitor is created for the rest – its
 * page says what it covers. On a desktop and on a phone, with axe. Invented records only.
 */

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };
/** The simulated machine of the monitor demo (mockIot.ts: md5 of "iot-asset:Machine 17"). */
const MACHINE_17 = '1ae6b74eebc51efc3d04f73c3ca5e5d3';

const ok = async <T = unknown>(p: Promise<{ ok(): boolean; text(): Promise<string>; json(): Promise<unknown> }>): Promise<T> => {
  const r = await p;
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()) as T;
};

/**
 * An invented mill whose second item is `second` – a variable of the demo machine no demo monitor watches, one per
 * project, so the desktop and phone runs never watch each other's drafts.
 */
async function fixture(api: APIRequestContext, tag: string, second: 'state' | 'toolWear') {
  const profile = `e2e-ih-mill-${tag}`.toLowerCase();
  const site = `e2e-ih-site-${tag}`.toLowerCase();
  const asset = `e2e-ih-asset-${tag}`.toLowerCase();
  const platforms = await ok<{ id: string; name: string }[]>(api.get('/api/platforms'));
  const ih = platforms.find((p) => p.name === 'Insights Hub (demo)')!.id;
  await ok(
    api.post('/api/plant/profiles', {
      data: {
        id: profile,
        name: `E2E mill ${tag}`,
        interfaces: [
          {
            id: 'opc',
            name: 'OPC UA',
            protocol: 'opc_ua',
            groups: [
              {
                name: '',
                dataPoints: [
                  { id: 'spindle_speed', name: 'Spindle speed', address: 'ns=2;s=Spindle', dataType: 'float', unit: 'rpm' },
                  { id: 'machine_state', name: 'Machine state', address: 'ns=2;s=State', dataType: 'int' },
                ],
              },
            ],
          },
        ],
      },
    }),
  );
  await ok(api.post('/api/plant/sites', { data: { id: site, name: `E2E IH works ${tag}` } }));
  await ok(api.post('/api/plant/assets', { data: { id: asset, siteId: site, name: `E2E IH mill ${tag}` } }));
  await ok(api.put(`/api/plant/assets/${asset}/assignment`, { data: { profileId: profile, interfaces: [{ interface: 'opc', active: true }] } }));
  await ok(
    api.post(`/api/plant/assets/${asset}/collections`, {
      data: {
        id: 'mill-data',
        name: 'Mill data',
        collector: { kind: 'job', ref: 'edge-gateway-e2e' },
        interfaceId: 'opc',
        mode: 'interval',
        intervalMs: 60000,
        items: [
          { address: 'ns=2;s=Spindle', outputName: 'spindleSpeed', dataPoint: 'spindle_speed' },
          { address: 'ns=2;s=State', outputName: second, dataPoint: 'machine_state' },
        ],
        sinks: [{ id: 'to-ih', name: 'Insights Hub', kind: 'platform', ref: ih }],
      },
    }),
  );
  return { profile, site, asset, name: `E2E IH mill ${tag}` };
}

async function cleanup(api: APIRequestContext, f: { profile: string; site: string; asset: string }, monitorId?: string) {
  if (monitorId) await api.delete(`/api/monitors/${monitorId}`);
  await api.delete(`/api/plant/assets/${f.asset}`);
  await api.delete(`/api/plant/sites/${f.site}`);
  await api.delete(`/api/plant/profiles/${f.profile}`);
}

for (const tag of ['', ' @mobile'])
  test.describe(`Insights Hub mapping${tag}`, () => {
    test.use({ storageState: authFile('dana') });
    test.beforeEach(async ({ apiAs }) => {
      const res = await (await apiAs('admin')).put('/api/settings/plant', { data: SETTINGS });
      expect(res.ok(), await res.text()).toBe(true);
    });

    test('map the items to the demo tenant, check the mapping, see the monitor that watches, create a draft for the rest', async ({ page, apiAs }, info) => {
      const api = await apiAs('dana');
      const second = info.project.name === 'mobile' ? 'toolWear' : 'state';
      const f = await fixture(api, `${info.project.name}-${Date.now()}`, second);
      let monitorId: string | undefined;
      try {
        await page.goto(`/plant/assets/${f.asset}/collections?collection=mill-data`);
        const detail = page.getByTestId('collection-detail');
        await detail.getByTestId('collection-tab-flow').click();
        const panel = detail.getByTestId('ih-to-ih');
        await expect(panel.getByTestId('ih-counts')).toContainText('0 of 2 items mapped');
        await expect(panel.getByTestId('ih-last-run')).toContainText('Not checked against the tenant yet');
        // one asset and aspect for the items with a data point, the same names
        await panel.getByTestId('ih-edit').click();
        const modal = page.getByTestId('ih-modal');
        await modal.getByTestId('ih-asset-id').fill(MACHINE_17);
        await modal.getByRole('textbox', { name: 'Asset name' }).fill('Machine 17');
        await modal.getByTestId('ih-aspect').fill('MachineData');
        await expectAccessible(page, 'Insights Hub mapping dialog');
        await modal.getByTestId('ih-bulk-apply').click();
        await expect(modal).toBeHidden();
        await expect(panel.getByTestId('ih-counts')).toContainText('2 of 2 items mapped');
        await expect(panel.getByTestId('ih-item-spindleSpeed')).toContainText('Machine 17 / MachineData / spindleSpeed');
        // against the simulated tenant: read-only, with the platform's identity
        await panel.getByTestId('ih-check').click();
        await expect(panel.getByTestId('ih-last-run')).toContainText('Checked on');
        await expect(panel.getByTestId('ih-item-spindleSpeed')).toContainText('OK');
        await expect(panel.getByTestId('ih-counts')).toContainText('2 verified');
        // monitors first: the demo's machine monitor watches the spindle speed already
        const monitors = panel.getByTestId('ih-monitors');
        await expect(panel.getByTestId('ih-item-spindleSpeed')).toContainText('Machine 17 – machine data · Machine data in Insights Hub');
        await expect(monitors).toContainText(`Not watched: ${second}`);
        await expectAccessible(page, 'Insights Hub mapping');
        await expectNoHorizontalScroll(page);
        // a draft for the rest – disabled, for review
        await monitors.getByTestId('ih-create-monitor').click();
        await expect(page.getByText(/created – disabled, for review/)).toBeVisible();
        await expect(panel.getByTestId(`ih-item-${second}`)).toContainText('Disabled');
        await expect(monitors).toContainText('Every variable is watched');
        const list = await ok<{ id: string; name: string; enabled: boolean }[]>(api.get('/api/monitors'));
        const draft = list.find((m) => m.name.startsWith(`${f.name} –`));
        expect(draft?.enabled).toBe(false);
        monitorId = draft!.id;
        // the monitor's page says what it covers
        await page.goto(`/monitors/${monitorId}`);
        await expect(page.getByTestId('monitor-ih-coverage')).toContainText('Covers 1 mapped item of');
        // the site's Insights Hub tab
        await page.goto(`/plant/sites/${f.site}/insights-hub`);
        await expect(page.getByTestId('site-ih-coverage')).toContainText('Mill data');
        await expectAccessible(page, 'site Insights Hub coverage');
        await expectNoHorizontalScroll(page);
      } finally {
        await cleanup(api, f, monitorId);
      }
    });
  });
