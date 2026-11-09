import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll } from './support/helpers';

/**
 * The plant registry, 0.13: KPI potential across profiles and parts – a base profile extracted from two power meters
 * of different protocols, a KPI input of two unrelated profiles with a data point mapping, KPI coverage rolled up from a
 * machine's meter to the machine, and the KPI potential on the site tiles. Every test makes its own invented site and
 * records.
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

/**
 * A site of its own; Meter A100 (Modbus/TCP) and Meter B700 (OPC UA) of two vendors – the same quantities under other
 * ids and units – with an asset of each.
 */
async function meters(api: APIRequestContext, tag: string) {
  const site = `e2e-site-${tag}`;
  await ok(api.post('/api/plant/sites', { data: { id: site, name: `E2E works ${tag}` } }));
  const a100 = `e2e-a100-${tag}`;
  const b700 = `e2e-b700-${tag}`;
  const point = (id: string, name: string, unit: string, address: string) => ({ id, name, unit, dataType: 'Float', address });
  await ok(
    api.post('/api/plant/profiles', {
      data: {
        id: a100,
        name: `E2E Meter A100 ${tag}`,
        interfaces: [
          {
            id: 'modbus',
            name: 'Modbus/TCP',
            protocol: 'modbus_tcp',
            defaultPort: 502,
            groups: [
              {
                name: 'Energy',
                dataPoints: [point('energy_total', 'Active energy', 'kWh', 'holding:100,2'), point('power', 'Active power', 'kW', 'holding:110,2')],
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
        id: b700,
        name: `E2E Meter B700 ${tag}`,
        interfaces: [
          {
            id: 'opc-ua',
            name: 'OPC UA server',
            protocol: 'opc_ua',
            defaultPort: 4840,
            groups: [
              {
                name: 'Energy',
                dataPoints: [
                  point('ActiveEnergy', 'Active energy', 'Wh', 'ns=2;s=Meter.ActiveEnergy'),
                  point('ActivePower', 'Active power', 'kW', 'ns=2;s=Meter.ActivePower'),
                ],
              },
            ],
          },
        ],
      },
    }),
  );
  const assets = [`e2e-meter-a-${tag}`, `e2e-meter-b-${tag}`];
  await ok(api.post('/api/plant/assets', { data: { id: assets[0], siteId: site, name: `E2E meter A ${tag}` } }));
  await ok(api.post('/api/plant/assets', { data: { id: assets[1], siteId: site, name: `E2E meter B ${tag}` } }));
  await ok(api.put(`/api/plant/assets/${assets[0]}/assignment`, { data: { profileId: a100, interfaces: [{ interface: 'modbus', active: true }] } }));
  await ok(api.put(`/api/plant/assets/${assets[1]}/assignment`, { data: { profileId: b700, interfaces: [{ interface: 'opc-ua', active: true }] } }));
  return { site, a100, b700, assets };
}

async function cleanup(
  api: APIRequestContext,
  f: { site: string; a100: string; b700: string; assets: string[] },
  more: { kpis?: string[]; assets?: string[]; profiles?: string[] } = {},
) {
  for (const k of more.kpis ?? []) await api.delete(`/api/plant/kpis/${k}`);
  for (const a of [...(more.assets ?? []), ...f.assets]) await api.delete(`/api/plant/assets/${a}`);
  await api.delete(`/api/plant/profiles/${f.a100}`);
  await api.delete(`/api/plant/profiles/${f.b700}`);
  for (const p of more.profiles ?? []) await api.delete(`/api/plant/profiles/${p}`);
  await api.delete(`/api/plant/sites/${f.site}`);
}

test.describe('as a designer', () => {
  test.use({ storageState: authFile('dana') });
  test.beforeEach(async ({ apiAs }) => plantOn(await apiAs('admin')));

  test('extract a base across protocols: an interface of protocol other, each profile keeps its protocol', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const tag = `x${Date.now()}`;
    const f = await meters(api, tag);
    const models = async () =>
      Promise.all(
        f.assets.map(async (a) => {
          const v = await (await api.get(`/api/plant/assets/${a}/assignment`)).json();
          return (v.model as { protocol: string; groups: { dataPoints: { unit: string; address: string }[] }[] }[])
            .flatMap((i) => i.groups.flatMap((g) => g.dataPoints.map((d) => `${i.protocol} ${d.unit} ${d.address}`)))
            .sort();
        }),
      );
    const before = await models();
    await page.goto(`/plant/profiles?q=${tag}`);
    await page.getByRole('checkbox', { name: `Select E2E Meter A100 ${tag}` }).check();
    await page.getByRole('checkbox', { name: `Select E2E Meter B700 ${tag}` }).check();
    await page.getByTestId('extract-base-open').click();
    const dialog = page.getByRole('dialog', { name: 'Extract a base profile' });
    // the B700's ids differ: matched by name (and unit)
    await expect(dialog.getByTestId('extract-row-energy_total')).toContainText('same name');
    await expect(dialog.getByTestId('extract-row-power')).toContainText('same unit');
    // the interfaces have different protocols: the base gets one of protocol "other", with an id of its own
    const ifaces = dialog.getByTestId('extract-interfaces');
    await expect(ifaces.getByTestId('extract-mixed-modbus')).toContainText('Protocols differ (Modbus/TCP, OPC UA)');
    await ifaces.getByTestId('extract-interface-modbus').fill('meter');
    await dialog.getByTestId('extract-name').fill(`E2E meter base ${tag}`);
    await expectAccessible(page, 'extract a base across protocols');
    await dialog.getByTestId('extract-preview').click();
    const result = dialog.getByTestId('extract-result');
    await expect(result.getByTestId('extract-ok')).toContainText('The base gets 2 data points on 1 interfaces');
    await expect(result).toContainText('opc-ua → meter');
    await expect(result).toContainText('ActiveEnergy → energy_total');
    await dialog.getByTestId('extract-apply').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { name: `E2E meter base ${tag}` })).toBeVisible();
    const base = page.url().split('/').pop()!;
    expect((await (await api.get(`/api/plant/profiles/${base}`)).json()).interfaces[0]).toMatchObject({ id: 'meter', protocol: 'other' });
    // the B700 keeps OPC UA – its protocol is the one choosable field of the inherited interface
    await page.goto(`/plant/profiles/${f.b700}`);
    await expect(page.getByTestId('interface-meter')).toContainText('OPC UA');
    await page.getByRole('button', { name: 'Actions for interface OPC UA server' }).click();
    await page.getByRole('menuitem', { name: /^Edit/ }).click();
    const edit = page.getByRole('dialog');
    await expect(edit.getByTestId('interface-protocol')).toBeEnabled();
    await expect(edit.getByTestId('interface-protocol')).toHaveValue('OPC UA');
    await edit.getByRole('button', { name: 'Cancel' }).click();
    await expectNoHorizontalScroll(page);
    // every asset's data points: the same protocol, unit and address
    expect(await models()).toEqual(before);
    await cleanup(api, f, { profiles: [base] });
  });

  test('a KPI input of two unrelated profiles with a data point mapping, suggested by name', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const tag = `m${Date.now()}`;
    const f = await meters(api, tag);
    const kpi = `e2e-energy-any-${tag}`;
    await ok(api.post('/api/plant/kpis', { data: { id: kpi, name: `E2E energy (any meter) ${tag}` } }));
    await page.goto(`/plant/kpis/${kpi}`);
    await page.getByTestId('kpi-inputs').getByRole('button', { name: 'Add input' }).click();
    const dialog = page.getByRole('dialog', { name: 'New input' });
    const profiles = dialog.getByTestId('kpi-input-profiles');
    await profiles.click();
    await page.getByRole('option', { name: `E2E Meter A100 ${tag}` }).click();
    await profiles.click();
    await page.getByRole('option', { name: `E2E Meter B700 ${tag}` }).click();
    // close the list of profiles
    await dialog.getByRole('heading', { name: 'New input' }).click();
    await dialog.getByTestId('kpi-input-points').click();
    await page.getByRole('option', { name: 'Active energy (energy_total)' }).click();
    await dialog.getByRole('heading', { name: 'New input' }).click();
    // the mapping: the B700's data point, suggested by its name
    const mapping = dialog.getByTestId('kpi-input-mapping');
    await expect(mapping.getByTestId(`kpi-map-energy_total-${f.b700}`)).toHaveValue('Active energy (ActiveEnergy, Wh)');
    await expect(mapping).toContainText('same name');
    await expectAccessible(page, 'KPI input with a mapping');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    const inputs = page.getByTestId('kpi-inputs');
    await expect(inputs.getByTestId('kpi-input-profiles')).toContainText(`E2E Meter B700 ${tag}`);
    await expect(inputs.getByTestId(`kpi-input-mapping-${f.b700}`)).toContainText('energy_total → ActiveEnergy');
    // both meters could have it; the B700 delivers Wh where the A100 (the first profile) has kWh
    const candidates = page.getByTestId('kpi-candidates');
    await expect(candidates.getByTestId(`kpi-candidate-${f.assets[0]}`)).toBeVisible();
    await expect(candidates.getByTestId(`kpi-candidate-${f.assets[1]}`)).toContainText('1 unit differs');
    await expectNoHorizontalScroll(page);
    const stored = await (await api.get(`/api/plant/kpis/${kpi}`)).json();
    expect(stored.inputs[0]).toMatchObject({ profile: f.a100, profiles: [f.a100, f.b700], mapping: { [f.b700]: { energy_total: 'ActiveEnergy' } } });
    await cleanup(api, f, { kpis: [kpi] });
  });

  test('editing an input keeps its mapping – the first profile’s, too – when nothing is changed', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const tag = `k${Date.now()}`;
    const f = await meters(api, tag);
    const kpi = `e2e-energy-keep-${tag}`;
    // set through the API: the input's own id, mapped in both profiles (the first one included)
    const input = {
      kind: 'data_point',
      profile: f.a100,
      profiles: [f.a100, f.b700],
      dataPoints: ['energy'],
      units: { energy: 'W.h' },
      mapping: { [f.a100]: { energy: 'energy_total' }, [f.b700]: { energy: 'ActiveEnergy' } },
      notes: 'Set by an import',
    };
    await ok(api.post('/api/plant/kpis', { data: { id: kpi, name: `E2E energy (kept) ${tag}`, inputs: [input] } }));
    const before = (await (await api.get(`/api/plant/kpis/${kpi}`)).json()).inputs;
    await page.goto(`/plant/kpis/${kpi}`);
    await expect(page.getByTestId(`kpi-input-mapping-${f.a100}`)).toContainText('energy → energy_total');
    await page.getByRole('button', { name: 'Actions for input 1' }).click();
    await page.getByRole('menuitem', { name: /^Edit/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit input' });
    const mapping = dialog.getByTestId('kpi-input-mapping');
    // the first profile's mapping is shown and kept
    await expect(mapping.getByTestId(`kpi-map-energy-${f.a100}`)).toHaveValue('Active energy (energy_total, kWh)');
    await expect(mapping.getByTestId(`kpi-map-energy-${f.b700}`)).toHaveValue('Active energy (ActiveEnergy, Wh)');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    expect((await (await api.get(`/api/plant/kpis/${kpi}`)).json()).inputs).toEqual(before);
    expect(before[0]).toMatchObject({ mapping: input.mapping, units: input.units, notes: input.notes });
    await cleanup(api, f, { kpis: [kpi] });
  });

  test('coverage rolled up from a meter to its machine; the asset page and the site tile', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const tag = `r${Date.now()}`;
    const f = await meters(api, tag);
    const machine = `e2e-press-${tag}`;
    await ok(api.post('/api/plant/assets', { data: { id: machine, siteId: f.site, name: `E2E press ${tag}` } }));
    // the A meter is part of the press, and its energy is collected
    await ok(api.put(`/api/plant/assets/${f.assets[0]}`, { data: { siteId: f.site, name: `E2E meter A ${tag}`, parentId: machine } }));
    await ok(
      api.post(`/api/plant/assets/${f.assets[0]}/collections`, {
        data: {
          id: 'gw',
          name: 'Gateway',
          collector: { kind: 'job', ref: `e2e-gw-${tag}` },
          interfaceId: 'modbus',
          items: [{ address: 'holding:100,2', outputName: 'Energy', dataPoint: 'energy_total' }],
        },
      }),
    );
    const kpi = `e2e-machine-energy-${tag}`;
    await ok(
      api.post('/api/plant/kpis', {
        data: { id: kpi, name: `E2E machine energy ${tag}`, rollUp: 'parts', inputs: [{ profile: f.a100, dataPoints: ['energy_total'] }] },
      }),
    );
    await page.goto(`/plant/explore?view=coverage&site=${f.site}&kpi=${kpi}`);
    await page.getByTestId('view-mode').getByText('Picture').click();
    const matrix = page.getByTestId('coverage-matrix');
    const press = matrix.getByTestId(`cell-${machine}-0`);
    await expect(press).toHaveAttribute('data-via', 'true');
    await expect(press).toHaveAttribute('data-potential', 'ready');
    await expect(press).toHaveAttribute('aria-label', new RegExp(`via part E2E meter A ${tag}`));
    await expect(matrix.getByTestId(`cell-${f.assets[0]}-0`)).toHaveAttribute('data-rolled-up', 'true');
    await press.hover();
    await expect(page.getByTestId('coverage-detail')).toContainText(`via part E2E meter A ${tag}`);
    // counted once: the press, not its meter again
    await expect(page.getByTestId('coverage-potential')).toContainText('KPI potential: 1 ready, 0 need a data collection');
    await expectAccessible(page, 'KPI coverage rolled up from parts');
    // the press's page lists the KPI with the part
    await page.goto(`/plant/assets/${machine}`);
    const possible = page.getByTestId('assignment-possible');
    await expect(possible.getByTestId(`possible-kpi-${kpi}`)).toContainText(`via part E2E meter A ${tag}`);
    await expect(possible.getByTestId(`possible-kpi-${kpi}`)).toContainText('Collected – ready');
    // the site's tile: its KPI potential
    await page.goto('/plant/sites');
    await expect(page.getByTestId(`site-tile-${f.site}`).getByTestId('tile-potential')).toContainText('1 ready · 0 need a collection');
    await expectNoHorizontalScroll(page);
    await cleanup(api, f, { kpis: [kpi], assets: [machine] });
  });
});
