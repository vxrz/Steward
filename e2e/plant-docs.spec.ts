import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll } from './support/helpers';

/**
 * The plant registry, 0.12: the Documents panel on a device profile and an asset with what they inherit (marked, read
 * only); an import of a gateway configuration keeps versions without secrets – listed, downloaded, compared – and the
 * collection's flow shows where its data goes. On a desktop and on a phone, with axe. Invented records only.
 */

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };

async function plantOn(api: APIRequestContext) {
  const res = await api.put('/api/settings/plant', { data: SETTINGS });
  expect(res.ok(), await res.text()).toBe(true);
}
const ok = async <T = unknown>(p: Promise<{ ok(): boolean; text(): Promise<string>; json(): Promise<unknown> }>): Promise<T> => {
  const r = await p;
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()) as T;
};

/** An invented gateway configuration: one dataset, a sink section, a password that must never show. */
const gateway = (opMode: string) =>
  JSON.stringify(
    {
      password: 'e2e-never-shown',
      outputs: [{ name: 'historian', broker: 'mqtt.example.com:8883', topic: 'plant/e2e/state', format: 'json' }],
      datasets: [
        {
          name: 'state',
          mode: 'interval',
          interval: 1000,
          datapoints: [
            { address: '/Channel/State/progStatus[u1]', name: 'ProgStatus', type: 'int', target: 'prog_status' },
            { address: opMode, name: 'OpMode', type: 'int' },
          ],
        },
      ],
    },
    null,
    2,
  );

async function fixture(api: APIRequestContext, tag: string) {
  const base = `e2e-docs-base-${tag}`;
  const child = `e2e-docs-child-${tag}`;
  const asset = `e2e-docs-asset-${tag}`;
  await ok(
    api.post('/api/plant/profiles', {
      data: {
        id: base,
        name: `E2E docs base ${tag}`,
        interfaces: [
          {
            id: 'cnc',
            name: 'CNC',
            protocol: 'other',
            groups: [{ name: '', dataPoints: [{ id: 'program_status', name: 'Program status', address: '/Channel/State/progStatus[u1]' }] }],
          },
        ],
      },
    }),
  );
  await ok(api.post('/api/plant/profiles', { data: { id: child, name: `E2E docs derived ${tag}`, extends: base } }));
  await ok(api.post('/api/plant/assets', { data: { id: asset, siteId: 'riverside', name: `E2E docs mill ${tag}` } }));
  await ok(api.put(`/api/plant/assets/${asset}/assignment`, { data: { profileId: child, interfaces: [{ interface: 'cnc', active: true }] } }));
  await ok(api.post('/api/records', { data: { type: 'DOC', title: `Base manual ${tag}`, links: [{ kind: 'device-profile', id: base, note: '' }] } }));
  await ok(api.post('/api/records', { data: { type: 'DOC', title: `Derived addendum ${tag}`, links: [{ kind: 'device-profile', id: child, note: '' }] } }));
  return { base, child, asset };
}

async function cleanup(api: APIRequestContext, f: { base: string; child: string; asset: string }) {
  await api.delete(`/api/plant/assets/${f.asset}`);
  for (const p of [f.child, f.base]) await api.post('/api/plant/bulk', { data: { kind: 'profile', action: 'remove', items: [{ id: p }], cascade: true } });
}

for (const tag of ['', ' @mobile'])
  test.describe(`plant documents${tag}`, () => {
    test.use({ storageState: authFile('dana') });
    test.beforeEach(async ({ apiAs }) => plantOn(await apiAs('admin')));

    test('the Documents panel of a derived profile and of an asset: own, inherited (marked), new document', async ({ page, apiAs }, info) => {
      const api = await apiAs('dana');
      const id = `${info.project.name}-${Date.now()}`;
      const f = await fixture(api, id);
      await page.goto(`/plant/profiles/${f.child}`);
      const panel = page.getByTestId('plant-documents');
      await expect(panel.getByTestId('plant-docs-own')).toContainText(`Derived addendum ${id}`);
      const inherited = panel.getByTestId('plant-docs-from-device-profile');
      await expect(inherited).toContainText('From base profile');
      await expect(inherited).toContainText(`Base manual ${id}`);
      await expect(inherited).toContainText('Inherited');
      await expectAccessible(page, 'profile documents');
      await expectNoHorizontalScroll(page);
      // the asset inherits from its profile chain
      await page.goto(`/plant/assets/${f.asset}`);
      const assetPanel = page.getByTestId('plant-documents');
      await expect(assetPanel).toContainText('No documents are linked yet.');
      await expect(assetPanel.getByTestId('plant-docs-inherited')).toContainText('From profile');
      await expect(assetPanel.getByTestId('plant-docs-inherited')).toContainText(`Base manual ${id}`);
      await expect(assetPanel.getByTestId('plant-docs-inherited')).toContainText(`Derived addendum ${id}`);
      await expectAccessible(page, 'asset documents');
      await expectNoHorizontalScroll(page);
      // a new document starts with the link to the asset
      await assetPanel.getByTestId('plant-docs-new').click();
      const dialog = page.getByRole('dialog', { name: /New document for/ });
      await dialog.getByRole('textbox', { name: 'Title' }).fill(`Handover ${id}`);
      await expectAccessible(page, 'new document dialog');
      await dialog.getByRole('button', { name: 'Create draft' }).click();
      await expect(page).toHaveURL(/\/records\/rec_[^/]+\/edit$/);
      await page.goto(`/plant/assets/${f.asset}`);
      await expect(page.getByTestId('plant-documents').getByTestId('plant-docs-own')).toContainText(`Handover ${id}`);
      await cleanup(api, f);
    });

    test('an import keeps versions without secrets: listed, downloaded, compared; the flow shows the sink', async ({ page, apiAs }, info) => {
      const api = await apiAs('dana');
      const id = `${info.project.name}-${Date.now()}`;
      const f = await fixture(api, id);
      const collector = { kind: 'job', ref: `edge-e2e-${id}`, host: null };
      for (const mode of ['/Bag/State/opMode[u1]', '/Bag/State/opMode[u2]'])
        await ok(
          api.post(`/api/plant/assets/${f.asset}/collections/import`, { data: { collector, files: [{ name: 'gateway.json', content: gateway(mode) }] } }),
        );
      await page.goto(`/plant/assets/${f.asset}/collections?collection=state`);
      const detail = page.getByTestId('collection-detail');
      await detail.getByTestId('collection-tab-sources').click();
      const sources = detail.getByTestId('collection-sources');
      await expect(sources.getByTestId('source-v2')).toContainText('gateway.json');
      await expect(sources.getByTestId('source-v1')).toContainText('1 value');
      await expect(detail.getByTestId('source-diff-changes')).toContainText('datasets[0].datapoints[1].address');
      await expect(detail.getByTestId('source-diff-lines')).toContainText('opMode[u2]');
      await expect(detail).not.toContainText('e2e-never-shown');
      await expectAccessible(page, 'collection sources');
      await expectNoHorizontalScroll(page);
      const download = page.waitForEvent('download');
      await sources.getByTestId('source-download-2').click();
      const file = await download;
      expect(file.suggestedFilename()).toBe('gateway.v2.redacted.json');
      // where the data goes: the sink of the file, its item mapping
      await detail.getByTestId('collection-tab-flow').click();
      const sink = detail.getByTestId('sink-historian');
      await expect(sink).toContainText('mqtt.example.com:8883');
      await expect(sink).toContainText('plant/e2e/state');
      await expect(sink).toContainText('prog_status');
      await expectAccessible(page, 'collection flow');
      await expectNoHorizontalScroll(page);
      // the collection's documents: its gateway configuration document, generated
      await detail.getByTestId('collection-tab-documents').click();
      await expect(detail.getByTestId('plant-documents')).toContainText('Generated');
      await expectAccessible(page, 'collection documents');
      await cleanup(api, f);
    });
  });
