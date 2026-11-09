/**
 * Numbers and screenshots of the OT network diagram (#230), on the demo's Riverside Works and on a larger invented site
 * (support/plantLargeSite.ts: 40 assets, 6 zones, 60 data paths): the time until the parts are drawn, how much of the
 * picture shows without scrolling, and the frame rate while panning – at 1440 × 900 and 1920 × 1080, light and dark,
 * and on a phone. Not part of the normal run (it adds a site to the shared demo server, and its numbers depend on the
 * machine): `SM_E2E_MEASURE=1 SM_E2E_WORKERS=1 npx playwright test e2e/plant-network-diagram-measure.spec.ts`. The
 * numbers go to `<out>/<tag>-numbers.jsonl` (NETDIAG_OUT, default test-results/network-diagram; NETDIAG_TAG).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { ROOT, authFile } from './support/env';
import { json } from './support/helpers';
import { setupLargeSite } from './support/plantLargeSite';

const OUT = process.env.NETDIAG_OUT ?? path.join(ROOT, 'test-results', 'network-diagram');
const TAG = process.env.NETDIAG_TAG ?? 'now';
test.skip(!process.env.SM_E2E_MEASURE, 'measurements only with SM_E2E_MEASURE=1');
const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };
const EXAMPLE = 'brightwater-ot-network.plant.yaml';

async function setupRiverside(api: APIRequestContext) {
  expect((await api.put('/api/settings/plant', { data: SETTINGS })).ok()).toBe(true);
  const n = await json(await api.get('/api/plant/sites/riverside/network'));
  if (!n.vlans.some((v: { id: string }) => v.id === 'rvs-vlan-110')) {
    const content = fs.readFileSync(path.join(ROOT, 'examples/plant', EXAMPLE), 'utf8');
    await json(await api.post('/api/plant/import', { data: { files: [{ name: EXAMPLE, content }], mode: 'add' } }));
  }
  let m = await json(await api.get('/api/plant/sites/riverside/network'));
  let segmentId = m.vlans.find((v: { id: string }) => v.id === 'rvs-vlan-900').segmentId as string | null;
  if (!segmentId) {
    m = await json(await api.post('/api/plant/sites/riverside/vlans/rvs-vlan-900/segment', { data: { name: 'E2E OT DMZ' } }));
    segmentId = m.vlans.find((v: { id: string }) => v.id === 'rvs-vlan-900').segmentId;
  }
  const systems = await json<{ id: string; name: string }[]>(await api.get('/api/systems'));
  let edge = systems.find((x) => x.name === 'Edge server');
  if (!edge) edge = await json(await api.post('/api/systems', { data: { name: 'Edge server', kind: 'server' } }));
  await api.post(`/api/systems/${edge!.id}/segments`, { data: { segmentId, address: '192.0.2.10' } });
  const own = await json(await api.get('/api/plant/assets/rvs-mill-02/network'));
  if (!own.dataPaths.some((p: { id: string }) => p.id === 'to-edge'))
    await api.post('/api/plant/assets/rvs-mill-02/paths', {
      data: {
        id: 'to-edge',
        subject: 'Machine state to the edge',
        devices: ['rvs-mill-02-ipc'],
        collector: { kind: 'job', ref: 'edge-collector', host: edge!.id },
        transfers: [{ protocol: 'opc-ua', mode: 'pull', peerKind: 'device', peer: 'rvs-mill-02-ipc', port: 4840 }],
        destinations: [{ kind: 'dataset', ref: 'plant.machine-state' }],
      },
    });
}

async function measure(page: Page, url: string, first: boolean, shot?: () => Promise<void>) {
  if (first)
    await page.addInitScript(() => {
      const w = window as unknown as { __firstNode?: number };
      const obs = new MutationObserver(() => {
        if (w.__firstNode === undefined && document.querySelector('.react-flow__node')) {
          // the first frame in which the nodes are drawn
          requestAnimationFrame(() => {
            w.__firstNode ??= performance.now();
          });
        }
      });
      obs.observe(document, { childList: true, subtree: true });
    });
  await page.goto(url);
  await page.getByTestId('view-mode').getByText('Picture').click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('.react-flow__node').first().waitFor();
  await page.waitForTimeout(800);
  const ttfp = await page.evaluate(() => (window as unknown as { __firstNode?: number }).__firstNode ?? -1);
  const vis = await page.evaluate(() => {
    const frame = document.querySelector('.react-flow')!.getBoundingClientRect();
    const leaves = [...document.querySelectorAll('.react-flow__node')].filter((n) => !n.classList.contains('react-flow__node-area'));
    const inView = (r: DOMRect) => r.left >= frame.left - 1 && r.right <= frame.right + 1 && r.top >= frame.top - 1 && r.bottom <= frame.bottom + 1;
    const all = [...document.querySelectorAll('.react-flow__node')];
    const vp = { w: window.innerWidth, h: window.innerHeight };
    const docScroll = document.documentElement.scrollHeight - window.innerHeight;
    const zoom = (document.querySelector('.react-flow__viewport') as HTMLElement).style.transform;
    return {
      canvas: `${Math.round(frame.width)}×${Math.round(frame.height)}`,
      canvasShareOfWidth: Math.round((frame.width / vp.w) * 100),
      canvasBottomBelowFold: Math.max(0, Math.round(frame.bottom - vp.h)),
      leaves: leaves.length,
      leavesFullyVisible: leaves.filter((n) => inView(n.getBoundingClientRect())).length,
      allFullyVisible: all.filter((n) => inView(n.getBoundingClientRect())).length,
      all: all.length,
      docScroll,
      zoom,
    };
  });
  if (shot) await shot();
  // frame rate while panning: drag the empty pane for about 1.5 s
  const box = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __run: boolean };
    w.__frames = [];
    w.__run = true;
    const tick = (t: number) => {
      w.__frames.push(t);
      if (w.__run) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const sx = box.x + box.width * 0.5;
  const sy = box.y + box.height * 0.5;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 0; i < 90; i++) {
    const a = (i / 90) * Math.PI * 2;
    await page.mouse.move(sx + Math.cos(a) * 200, sy + Math.sin(a) * 120);
  }
  await page.mouse.up();
  const fps = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __run: boolean };
    w.__run = false;
    const f = w.__frames;
    const dur = f[f.length - 1]! - f[0]!;
    const gaps = f.slice(1).map((t, i) => t - f[i]!);
    return { fps: Math.round(((f.length - 1) / dur) * 1000), worstFrameMs: Math.round(Math.max(...gaps)), durationMs: Math.round(dur) };
  });
  return { ttfpMs: Math.round(ttfp), ...vis, ...fps };
}

test.describe('measure', () => {
  test.use({ storageState: authFile('dana') });
  test.setTimeout(240_000);

  for (const vp of [
    { w: 1440, h: 900 },
    { w: 1920, h: 1080 },
  ])
    for (const site of ['riverside', 'lks'])
      test(`${site} at ${vp.w}`, async ({ page, apiAs }) => {
        const admin = await apiAs('admin');
        await setupRiverside(admin);
        await setupLargeSite(admin);
        await page.setViewportSize({ width: vp.w, height: vp.h });
        const runs = [];
        for (let i = 0; i < Number(process.env.NETDIAG_RUNS ?? 3); i++) {
          runs.push(
            await measure(
              page,
              `/plant/sites/${site}/network/diagram`,
              i === 0,
              i === 0
                ? async () => {
                    await page.mouse.move(2, 2);
                    await page.screenshot({ path: `${OUT}/${TAG}-${site}-${vp.w}-light.png` });
                    await page.emulateMedia({ colorScheme: 'dark' });
                    await page.waitForTimeout(400);
                    await page.screenshot({ path: `${OUT}/${TAG}-${site}-${vp.w}-dark.png` });
                    await page.emulateMedia({ colorScheme: 'light' });
                    await page.waitForTimeout(200);
                  }
                : undefined,
            ),
          );
        }
        fs.mkdirSync(OUT, { recursive: true });
        fs.appendFileSync(`${OUT}/${TAG}-numbers.jsonl`, JSON.stringify({ site, vp: `${vp.w}×${vp.h}`, runs }) + '\n');
      });
});

test.describe('on a phone', () => {
  test.use({ storageState: authFile('dana') });
  test('screenshots @mobile', async ({ page, apiAs }) => {
    test.setTimeout(240_000);
    const admin = await apiAs('admin');
    await setupRiverside(admin);
    await setupLargeSite(admin);
    for (const site of ['riverside', 'lks']) {
      await page.goto(`/plant/sites/${site}/network/diagram`);
      await page.getByTestId('view-mode').getByText('Picture').click();
      await page.locator('.react-flow__node').first().waitFor();
      await page.waitForTimeout(800);
      await page.getByTestId('flow-graph').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${OUT}/${TAG}-${site}-390-light.png` });
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/${TAG}-${site}-390-dark.png` });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.screenshot({ path: `${OUT}/${TAG}-${site}-390-full.png`, fullPage: true });
    }
  });
});

test.describe('interactions', () => {
  test.use({ storageState: authFile('dana') });
  test('screenshots of search, selection, filters, full screen and the legend', async ({ page, apiAs }) => {
    test.setTimeout(240_000);
    const admin = await apiAs('admin');
    await setupRiverside(admin);
    await setupLargeSite(admin);
    await page.goto('/plant/sites/lks/network/diagram');
    await page.getByTestId('view-mode').getByText('Picture').click();
    await page.locator('.react-flow__node').first().waitFor();
    await page.waitForTimeout(600);
    await page.getByTestId('flow-node-asset:lks-a05').hover();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${TAG}-lks-hover.png` });
    await page.getByTestId('flow-node-asset:lks-a05').click();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${TAG}-lks-selected.png` });
    await page.keyboard.press('Escape');
    await page.getByTestId('nd-filters').click();
    await page.getByTestId('nd-filter-no-conduit').click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${TAG}-lks-filter.png` });
    await page.getByTestId('nd-filters').click();
    await page.getByTestId('nd-filter-clear').click();
    await page.keyboard.press('Escape');
    await page.getByTestId('nd-search').click();
    await page.keyboard.type('scada-poll');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/${TAG}-lks-search.png` });
    await page.getByTestId('nd-fullscreen').click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/${TAG}-lks-fullscreen.png` });
    await page.getByTestId('nd-legend-button').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/${TAG}-lks-legend.png` });
  });
});
