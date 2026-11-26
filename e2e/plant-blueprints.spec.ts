import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, uniq } from './support/helpers';

/**
 * Machine blueprints (0.30.0, ADR 0041): a plant designer adds a blueprint with signals, assigns it to a device profile,
 * maps a signal to a data point (or accepts a suggestion), marks another signal not applicable with a reason and reads
 * the coverage numbers. Invented names only.
 */
test.describe('machine blueprints', () => {
  test.use({ storageState: authFile('admin') });

  test('create a blueprint, add signals, assign it to a profile, map, mark not applicable, read the coverage', async ({ page, apiAs }, info) => {
    const api = await apiAs('admin');
    const tag = `${info.project.name}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const profile = `e2e-bp-profile-${tag}`;
    const blueprint = `e2e-bp-${tag}`;
    const name = uniq('E2E welding blueprint');
    expect((await api.put('/api/settings/plant', { data: { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} } })).ok()).toBe(true);
    const made = await api.post('/api/plant/profiles', {
      data: {
        id: profile,
        name: `E2E welding controller ${tag}`,
        manufacturer: 'Invented Controls AG',
        interfaces: [
          {
            id: 'opc',
            name: 'OPC UA server',
            protocol: 'opc_ua',
            groups: [
              {
                name: 'Process',
                dataPoints: [
                  { id: 'weld_current', name: 'Weld current', address: 'ns=2;s=Weld.Current' },
                  { id: 'wire_feed', name: 'Wire feed', address: 'ns=2;s=Wire.Feed' },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(made.ok(), await made.text()).toBe(true);
    try {
      // the blueprint
      await page.goto('/plant/blueprints');
      await expect(page.getByRole('heading', { name: 'Machine blueprints', level: 1 })).toBeVisible();
      await page.getByTestId('blueprint-new').first().click();
      const form = page.getByRole('dialog');
      await form.getByTestId('blueprint-name').fill(name);
      await form.getByLabel('ID', { exact: false }).fill(blueprint);
      await form.getByLabel('Reference').fill('Own experience');
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(page).toHaveURL((url) => url.pathname.endsWith(`/plant/blueprints/${blueprint}`));
      await expect(page.getByRole('heading', { name: name, level: 1 })).toBeVisible();

      // its signals: one the profile has under another name's keyword, one it does not
      const addSignal = async (signal: string, id: string, importance: string, aliases: string[] = []) => {
        await page.getByTestId('signal-add').click();
        const d = page.getByRole('dialog');
        await d.getByTestId('signal-name').fill(signal);
        await d.getByLabel('ID', { exact: false }).fill(id);
        await d.getByTestId('signal-meaning').fill(`What ${signal.toLowerCase()} tells`);
        await chooseOption(page, 'Importance', importance);
        for (const a of aliases) {
          await d.getByLabel('Known as').fill(a);
          await d.getByLabel('Known as').press('Enter');
        }
        await d.getByRole('button', { name: 'Save' }).click();
        await expect(page.getByTestId(`signal-row-${id}`)).toBeVisible();
      };
      await addSignal('Welding current', 'current', 'Must', ['weld current']);
      await addSignal('Wire feed speed', 'wire', 'Should');
      await addSignal('Gas flow', 'gas', 'Should');
      await expect(page.getByTestId('blueprint-signal-table')).toContainText('Gas flow');
      await expectAccessible(page, 'machine blueprint');

      // the profile: assign, suggestion, map, mark
      await page.goto(`/plant/profiles/${profile}`);
      await page.getByTestId('section-blueprints-toggle').click();
      await page.getByTestId('blueprint-assign').click();
      await chooseOption(page, 'Machine blueprint', name);
      await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
      const cov = page.getByTestId(`coverage-${blueprint}`);
      await expect(cov).toBeVisible();
      // nothing is mapped: suggestions never count
      await expect(page.getByTestId(`totals-${blueprint}-must`)).toContainText('0 of 1 covered');
      const current = page.getByTestId(`coverage-signal-${blueprint}-current`);
      await expect(current.getByTestId('suggestions')).toContainText('Weld current');
      await expect(current.getByTestId('state-missing')).toBeVisible();

      // accept the suggestion: one click maps it
      await current.getByTestId('suggestion-accept-weld_current').click();
      await expect(current.getByTestId('state-covered')).toBeVisible();
      await expect(page.getByTestId(`totals-${blueprint}-must`)).toContainText('1 of 1 covered');

      // map by the picker
      await page.getByTestId(`signal-menu-wire`).click();
      await page.getByTestId('signal-map').click();
      await page.getByTestId('map-point-wire_feed').check();
      await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
      await expect(page.getByTestId(`coverage-signal-${blueprint}-wire`).getByTestId('state-covered')).toBeVisible();

      // not applicable needs a reason
      await page.getByTestId('signal-menu-gas').click();
      await page.getByTestId('signal-mark').click();
      await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
      await expect(page.getByRole('dialog').getByText('Required', { exact: true })).toBeVisible();
      await page.getByTestId('mark-reason').fill('Laser welding needs no shielding gas');
      await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
      const gas = page.getByTestId(`coverage-signal-${blueprint}-gas`);
      await expect(gas.getByTestId('state-notApplicable')).toBeVisible();
      await expect(gas.getByTestId('not-applicable-note')).toContainText('Laser welding needs no shielding gas');
      await expect(gas.getByTestId('not-applicable-note')).toContainText('admin');
      // the numbers: should: 1 of 1 applicable covered, 1 not applicable
      const should = page.getByTestId(`totals-${blueprint}-should`);
      await expect(should).toContainText('1 of 1 covered');
      await expect(should).toContainText('1 not applicable');
      await expect(page.getByTestId('blueprints-summary')).toContainText('2 of 2 covered');
      await expectAccessible(page, 'coverage of a profile');
      await expectNoHorizontalScroll(page);

      // clear the mark again
      await page.getByTestId('signal-menu-gas').click();
      await page.getByTestId('signal-clear-mark').click();
      await expect(gas.getByTestId('state-missing')).toBeVisible();

      // the blueprint's page says where it is assigned
      await page.goto(`/plant/blueprints/${blueprint}`);
      await expect(page.getByTestId('blueprint-usage')).toContainText(`E2E welding controller ${tag}`);
    } finally {
      await api.delete(`/api/plant/profiles/${profile}/blueprints/${blueprint}`);
      await api.delete(`/api/plant/blueprints/${blueprint}`);
      await api.post('/api/plant/bulk', { data: { kind: 'profile', action: 'remove', items: [{ id: profile }], cascade: true } });
    }
  });
  test('the site matrix shows each asset with how its blueprint signals stand', async ({ page, apiAs }, info) => {
    const api = await apiAs('admin');
    const tag = `${info.project.name}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const profile = `e2e-mx-profile-${tag}`;
    const blueprint = `e2e-mx-${tag}`;
    const site = `e2e-mx-site-${tag}`;
    const asset = `e2e-mx-asset-${tag}`;
    const ok = async (r: { ok(): boolean; text(): Promise<string> }) => expect(r.ok(), await r.text()).toBe(true);
    await ok(await api.put('/api/settings/plant', { data: { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} } }));
    await ok(
      await api.post('/api/plant/profiles', {
        data: {
          id: profile,
          name: `E2E matrix controller ${tag}`,
          interfaces: [
            {
              id: 'opc',
              name: 'OPC UA server',
              protocol: 'opc_ua',
              groups: [{ name: 'Process', dataPoints: [{ id: 'weld_current', name: 'Weld current', address: 'ns=2;s=Weld.Current' }] }],
            },
          ],
        },
      }),
    );
    try {
      await ok(
        await api.post('/api/plant/blueprints', {
          data: {
            id: blueprint,
            name: `E2E matrix blueprint ${tag}`,
            signals: [
              { id: 'current', name: 'Welding current', importance: 'must' },
              { id: 'gas', name: 'Gas flow', importance: 'should' },
            ],
          },
        }),
      );
      await ok(await api.put(`/api/plant/profiles/${profile}/blueprints/${blueprint}`));
      await ok(await api.put(`/api/plant/profiles/${profile}/blueprints/${blueprint}/signals/current/mapping`, { data: { dataPoints: ['weld_current'] } }));
      await ok(await api.post('/api/plant/sites', { data: { id: site, name: `Invented matrix site ${tag}` } }));
      await ok(await api.post('/api/plant/assets', { data: { id: asset, siteId: site, name: `Matrix welder ${tag}` } }));
      await ok(
        await api.put(`/api/plant/assets/${asset}/assignment`, {
          data: { profileId: profile, interfaces: [{ interface: 'opc', active: true, endpoint: 'opc.tcp://welder.example:4840' }] },
        }),
      );

      await page.goto(`/plant/explore?view=blueprints&site=${site}`);
      const matrix = page.getByTestId('blueprint-matrix');
      await expect(matrix.getByRole('heading', { name: 'Machine blueprint matrix' })).toBeVisible();
      const row = page.getByTestId(`matrix-row-${asset}`);
      await expect(row).toBeVisible();
      // the profile maps the must signal, but no data collection of the asset reads it: not covered yet; the should signal is missing
      const cell = page.getByTestId(`matrix-cell-${asset}-${blueprint}`);
      await expect(cell).toContainText('0 of 1 covered');
      await expect(page.getByTestId('matrix-total-must')).toContainText('1 not collected');
      await expect(page.getByTestId('matrix-total-should')).toContainText('1 missing');
      await expectAccessible(page, 'machine blueprint matrix');
      await expectNoHorizontalScroll(page);
      // the filter narrows by blueprint; the site tile links here
      await page.goto(`/plant/explore?view=blueprints&blueprint=${blueprint}`);
      await expect(page.getByTestId(`matrix-row-${asset}`)).toBeVisible();
    } finally {
      await api.delete(`/api/plant/assets/${asset}`);
      await api.delete(`/api/plant/sites/${site}`);
      await api.delete(`/api/plant/profiles/${profile}/blueprints/${blueprint}`);
      await api.delete(`/api/plant/blueprints/${blueprint}`);
      await api.post('/api/plant/bulk', { data: { kind: 'profile', action: 'remove', items: [{ id: profile }], cascade: true } });
    }
  });
});
