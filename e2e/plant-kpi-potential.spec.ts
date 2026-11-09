import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll } from './support/helpers';

/**
 * The plant registry, 0.12.0: two power meters of an invented vendor share a base profile extracted from them; a
 * template profile cannot become the profile of an asset (nor can a profile assets have become a template); the KPI
 * coverage splits "could have it" into collected and not collected. Every test makes its own invented records.
 */

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };

async function plantOn(api: APIRequestContext) {
  const res = await api.put('/api/settings/plant', { data: SETTINGS });
  expect(res.ok(), await res.text()).toBe(true);
}
const ok = async (p: Promise<{ ok(): boolean; text(): Promise<string> }>) => {
  const r = await p;
  expect(r.ok(), await r.text()).toBe(true);
};

/** Meter A100 and Meter A300 (ids unique per test), an asset of each, the A300 asset's energy collected by an ETL job. */
async function meters(api: APIRequestContext, tag: string) {
  const a100 = `e2e-a100-${tag}`;
  const a300 = `e2e-a300-${tag}`;
  const point = (id: string, name: string, unit: string, address: string, aliases: string[] = []) => ({ id, name, unit, dataType: 'Float', address, aliases });
  await ok(
    api.post('/api/plant/profiles', {
      data: {
        id: a100,
        name: `E2E Meter A100 ${tag}`,
        manufacturer: 'Example Meters',
        interfaces: [
          {
            id: 'modbus',
            name: 'Modbus/TCP',
            protocol: 'modbus_tcp',
            groups: [
              {
                name: 'Energy',
                dataPoints: [
                  point('energy_total', 'Active energy', 'kWh', 'holding:100,2', ['EnergyTotal']),
                  point('power', 'Active power', 'kW', 'holding:110,2'),
                ],
              },
            ],
          },
        ],
      },
    }),
  );
  await ok(
    api.post('/api/plant/profiles', {
      data: {
        id: a300,
        name: `E2E Meter A300 ${tag}`,
        manufacturer: 'Example Meters',
        interfaces: [
          {
            id: 'mb',
            name: 'Modbus TCP server',
            protocol: 'modbus_tcp',
            groups: [
              {
                name: 'Energy',
                dataPoints: [
                  point('e_import', 'Active energy', 'Wh', 'holding:4000,2', ['EnergyTotal']),
                  point('power', 'Active power', 'kW', 'holding:4010,2'),
                ],
              },
            ],
          },
        ],
      },
    }),
  );
  const assets = [`e2e-meter-1-${tag}`, `e2e-meter-2-${tag}`, `e2e-meter-3-${tag}`];
  for (const [i, id] of assets.entries()) {
    await ok(api.post('/api/plant/assets', { data: { id, siteId: 'riverside', name: `E2E meter ${i + 1} ${tag}` } }));
    const [profileId, iface] = i === 0 ? [a100, 'modbus'] : [a300, 'mb'];
    await ok(api.put(`/api/plant/assets/${id}/assignment`, { data: { profileId, interfaces: [{ interface: iface, active: true }] } }));
  }
  await ok(
    api.post(`/api/plant/assets/${assets[1]}/collections`, {
      data: {
        id: 'energy-etl',
        name: 'Energy ETL',
        collector: { kind: 'job', ref: `e2e-energy-etl-${tag}` },
        interfaceId: 'mb',
        items: [
          { address: 'holding:4000,2', outputName: 'EnergyTotal', dataPoint: 'e_import' },
          { address: 'holding:4010,2', outputName: 'Power', dataPoint: 'power' },
        ],
      },
    }),
  );
  return { a100, a300, assets };
}

async function cleanup(api: APIRequestContext, f: { a100: string; a300: string; assets: string[] }, more: { kpis?: string[]; profiles?: string[] } = {}) {
  for (const k of more.kpis ?? []) await api.delete(`/api/plant/kpis/${k}`);
  for (const a of f.assets) await api.delete(`/api/plant/assets/${a}`);
  await api.delete(`/api/plant/profiles/${f.a100}`);
  await api.delete(`/api/plant/profiles/${f.a300}`);
  for (const p of more.profiles ?? []) await api.delete(`/api/plant/profiles/${p}`);
}

test.describe('as a designer', () => {
  test.use({ storageState: authFile('dana') });
  test.beforeEach(async ({ apiAs }) => plantOn(await apiAs('admin')));

  test('extract a base profile from two meters: matches, preview, one step; the assets keep their data points', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const tag = `x${Date.now()}`;
    const f = await meters(api, tag);
    const before = await (await api.get(`/api/plant/assets/${f.assets[1]}/assignment`)).json();
    await page.goto(`/plant/profiles?q=${tag}`);
    await page.getByRole('checkbox', { name: `Select E2E Meter A100 ${tag}` }).check();
    await page.getByRole('checkbox', { name: `Select E2E Meter A300 ${tag}` }).check();
    await page.getByTestId('extract-base-open').click();
    const dialog = page.getByRole('dialog', { name: 'Extract a base profile' });
    const points = dialog.getByTestId('extract-points');
    // the A300's energy counter has another id: matched by its known-as name and name
    await expect(points.getByTestId('extract-row-energy_total')).toContainText('known as');
    await expect(points.getByTestId('extract-row-power')).toContainText('same id');
    await dialog.getByTestId('extract-name').fill(`E2E meter base ${tag}`);
    await expectAccessible(page, 'extract a base profile');
    await dialog.getByTestId('extract-preview').click();
    const result = dialog.getByTestId('extract-result');
    await expect(result.getByTestId('extract-ok')).toContainText('The base gets 2 data points on 1 interfaces');
    await expect(result).toContainText('e_import → energy_total');
    await expect(result).toContainText('mb → modbus');
    await dialog.getByTestId('extract-apply').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { name: `E2E meter base ${tag}` })).toBeVisible();
    await expect(page.getByTestId('template-badge').first()).toBeVisible();
    await expect(page.getByTestId('profile-extended-by')).toContainText(`E2E Meter A300 ${tag}`);
    await expectNoHorizontalScroll(page);
    // the asset's model is the one it had, the data point renamed
    const after = await (await api.get(`/api/plant/assets/${f.assets[1]}/assignment`)).json();
    const ids = (m: { groups: { dataPoints: { id: string; unit: string; address: string }[] }[] }[]) =>
      m.flatMap((i) => i.groups.flatMap((g) => g.dataPoints.map((d) => `${d.id} ${d.unit} ${d.address}`))).sort();
    expect(ids(after.model)).toEqual(
      ids(before.model)
        .map((x: string) => x.replace('e_import', 'energy_total'))
        .sort(),
    );
    // the base goes once the profiles that extend it are gone
    await cleanup(api, f, { profiles: [page.url().split('/').pop()!] });
  });

  test('a template: its badge and filter; a profile assets have does not become one', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const tag = `t${Date.now()}`;
    const f = await meters(api, tag);
    const template = `e2e-template-${tag}`;
    await ok(api.post('/api/plant/profiles', { data: { id: template, name: `E2E meter template ${tag}`, template: true } }));
    await page.goto(`/plant/profiles?q=${tag}&kind=template`);
    const list = page.getByTestId('plant-profiles');
    await expect(list.getByRole('link', { name: `E2E meter template ${tag}` })).toBeVisible();
    await expect(list.getByRole('link', { name: `E2E Meter A100 ${tag}` })).toHaveCount(0);
    await expect(list.getByTestId('template-badge')).toHaveCount(1);
    await expectAccessible(page, 'template profiles');
    // an assignment naming the template is refused
    const res = await api.put(`/api/plant/assets/${f.assets[0]}/assignment`, { data: { profileId: template } });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('PLANT_PROFILE_TEMPLATE');
    // the A100 has an asset: it does not become a template
    await page.goto(`/plant/profiles/${f.a100}`);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Template – only for other profiles to extend').check();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(
      page.getByText('1 assets have the device profile – give them another profile (one that extends it) before it becomes a template.'),
    ).toBeVisible();
    await expect(dialog).toBeVisible();
    await cleanup(api, f, { profiles: [template] });
  });

  test('KPI potential: collected – ready, or the device delivers and a collection is missing; a unit that differs', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const tag = `p${Date.now()}`;
    const f = await meters(api, tag);
    const kpi = `e2e-energy-${tag}`;
    await ok(
      api.post('/api/plant/kpis', {
        data: { id: kpi, name: `E2E energy ${tag}`, inputs: [{ profile: f.a300, dataPoints: ['e_import', 'power'], units: { e_import: 'kWh' } }] },
      }),
    );
    await page.goto(`/plant/kpis/${kpi}`);
    const candidates = page.getByTestId('kpi-candidates');
    await expect(candidates.getByTestId(`kpi-candidate-${f.assets[1]}`)).toContainText('Collected – ready');
    await expect(candidates.getByTestId(`kpi-candidate-${f.assets[2]}`)).toContainText('Not collected');
    await expect(candidates.getByTestId(`kpi-candidate-${f.assets[1]}`)).toContainText('1 unit differs');
    await expect(page.getByTestId('kpi-input-unit-e_import')).toContainText('kWh');
    const card = page.getByTestId('kpi-coverage-card');
    await expect(card.getByTestId('coverage-potential')).toContainText('KPI potential: 1 ready, 1 need a data collection');
    await expect(card.getByTestId('coverage-total-ready')).toContainText('1');
    await expectAccessible(page, 'KPI page with its potential');
    // the matrix: the cell says its state and explains it
    await page.goto(`/plant/explore?view=coverage&kpi=${kpi}`);
    await page.getByTestId('view-mode').getByText('Picture').click();
    const matrix = page.getByTestId('coverage-matrix');
    const ready = matrix.getByRole('link', { name: new RegExp(`E2E meter 2 ${tag}, E2E energy ${tag}: Collected – ready`) });
    await expect(ready).toBeVisible();
    await expect(ready).toHaveAttribute('data-potential', 'ready');
    await expect(matrix.getByRole('link', { name: new RegExp(`E2E meter 3 ${tag}, E2E energy ${tag}: Device delivers, not collected`) })).toBeVisible();
    await ready.hover();
    await expect(page.getByTestId('coverage-detail')).toContainText('expects data point e_import in kW.h');
    await expect(page.getByTestId('coverage-legend')).toContainText('Collected – ready');
    await expectAccessible(page, 'KPI coverage with potential');
    await expectNoHorizontalScroll(page);
    await cleanup(api, f, { kpis: [kpi] });
  });
});
