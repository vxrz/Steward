import { devices, type APIRequestContext, type Page, type Request } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile, baseURL, origin } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll, json, uniq } from './support/helpers';

/**
 * The map of sites (#234, ADR 0015): off until an administrator turns it on (OpenStreetMap preselected), tiles only
 * through Steward (in the demo the built-in sources are the mock tile source – no test fetches real tiles), MapLibre's
 * worker under the unchanged content security policy, pins and clusters as buttons with a list twin, the card, Show on
 * map, the position picker, the dashboard widget, light and dark, on a desktop and on a phone, with axe.
 */

const PLANT = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };

async function plantOn(api: APIRequestContext) {
  const res = await api.put('/api/settings/plant', { data: PLANT });
  expect(res.ok(), await res.text()).toBe(true);
}
async function mapSource(api: APIRequestContext, body: Record<string, unknown>) {
  const res = await api.put('/api/settings/plant/map', { data: body });
  expect(res.ok(), await res.text()).toBe(true);
}

/** Every request of the page: nothing may leave Steward's origin (the map's tiles included). */
function watchRequests(page: Page): Request[] {
  const seen: Request[] = [];
  page.on('request', (r) => seen.push(r));
  return seen;
}
const foreign = (seen: Request[]) => seen.map((r) => r.url()).filter((u) => !u.startsWith(origin()) && !u.startsWith('data:') && !u.startsWith('blob:'));

/** Waits until MapLibre has drawn the style and its first tiles. */
async function mapReady(page: Page, testId = 'sites-map') {
  await expect(page.getByTestId(testId)).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
}

test.describe.configure({ mode: 'serial' });

test.describe('the map of sites', () => {
  test.use({ storageState: authFile('admin') });
  test.beforeAll(async ({ apiAs }) => {
    const admin = await apiAs('admin');
    await plantOn(admin);
    await mapSource(admin, { source: 'off' });
  });
  test.afterAll(async ({ apiAs }) => mapSource(await apiAs('admin'), { source: 'off' }));

  test('off until an administrator turns it on: the list only, nothing is fetched', async ({ page }) => {
    const seen = watchRequests(page);
    await page.goto('/plant/map');
    await expect(page.getByTestId('map-notice-off')).toContainText('The map is off');
    await expect(page.getByTestId('map-site-list').getByRole('link', { name: 'Riverside Works', exact: true })).toBeVisible();
    await settle(page);
    expect(seen.filter((r) => r.url().includes('/api/plant/map/tiles') || r.url().includes('/api/plant/map/style'))).toEqual([]);
    await expectAccessible(page, 'map page, map off');

    // Settings → Modules: OpenStreetMap is preselected, one click turns it on
    await page.goto('/settings/modules');
    const card = page.getByTestId('plant-map-settings');
    await expect(card.getByTestId('map-settings-state')).toHaveText('Off');
    await expect(card.getByLabel('OpenStreetMap')).toBeChecked();
    await expect(card).toContainText('nothing is sent anywhere');
    await expectAccessible(page, 'map settings, off');
    await card.getByTestId('map-save').click();
    await expect(card.getByTestId('map-settings-state')).toHaveText('On – OpenStreetMap');
    // the demo's OpenStreetMap is the mock tile source of this server (its own port, also behind the test's proxy)
    await expect(card.getByTestId('map-origins')).toContainText(/http:\/\/127\.0\.0\.1:\d+/);
    await expect(card.getByTestId('map-origins')).not.toContainText('openstreetmap.org');
    await card.screenshot({ path: test.info().outputPath('map-settings.png') });
    await expect(page.getByTestId('outbound-map-origins')).toHaveCount(0); // on the Network area, not here
    await page.goto('/settings/security');
    await expect(page.getByTestId('outbound-map-origins')).toContainText('for the map only, not for processes');
  });

  test('tiles through Steward, the worker under the CSP, pins in list order with their card', async ({ page }) => {
    const seen = watchRequests(page);
    const workers: string[] = [];
    page.on('worker', (w) => workers.push(w.url()));
    await page.goto('/plant/map');
    await mapReady(page);
    // MapLibre's own worker module, from Steward's origin (no blob: worker, no eval: the CSP stays as it is)
    expect(workers.some((w) => w.startsWith(baseURL()) && w.includes('maplibre-gl-worker'))).toBe(true);
    const csp = (await page.request.get('/plant/map')).headers()['content-security-policy']!;
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toContain('unsafe-eval');
    await expect.poll(() => seen.filter((r) => r.url().includes('/api/plant/map/tiles/base/')).length).toBeGreaterThan(0);
    expect(foreign(seen)).toEqual([]);
    await expect(page.getByTestId('map-attribution')).toContainText('© OpenStreetMap contributors');
    await expect(page.getByTestId('map-legend')).toContainText('Not watched');

    // the pins are buttons, in list order, with a name that says the state
    const pins = page.getByTestId('map-pins').getByRole('button');
    await expect(pins).toHaveCount(2);
    await expect(pins.first()).toHaveAccessibleName(/^Hillcrest Plant, HLC/);
    await expect(pins.nth(1)).toHaveAccessibleName(/^Riverside Works, RVS/);
    await expectAccessible(page, 'map page');
    await pins.nth(1).focus();
    await page.keyboard.press('Enter');
    const card = page.getByTestId('map-card');
    await expect(card).toBeVisible();
    await expect(card.getByRole('link', { name: 'Open site' })).toBeVisible();
    await expectAccessible(page, 'map card');
    await page.screenshot({ path: test.info().outputPath('map-card.png') });
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await expect(pins.nth(1)).toBeFocused();

    // the search applies to both: list and pins
    await page.getByPlaceholder('Search by name or code').fill('hill');
    await expect(page.getByTestId('map-site-list').getByRole('row')).toHaveCount(2);
    await expect(pins).toHaveCount(1);
    await page.getByPlaceholder('Search by name or code').fill('');

    // Show on map: the site with its own zoom, its card open
    await page.getByTestId('show-on-map-riverside').click();
    await expect(card).toBeVisible();
    await expect(card.getByRole('link', { name: 'Riverside Works' })).toBeVisible();
  });

  test('clusters are buttons too; zoomed out, both sites are one', async ({ page }) => {
    await page.goto('/plant/map');
    await mapReady(page);
    await page.getByTestId('sites-map').getByRole('button', { name: 'Zoom out' }).click();
    for (let i = 0; i < 5; i++) await page.getByTestId('sites-map').getByRole('button', { name: 'Zoom out' }).click();
    const cluster = page.getByTestId('map-cluster');
    await expect(cluster).toHaveAccessibleName(/^2 sites, worst: .+ – zoom in$/);
    await cluster.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('map-pins').getByRole('button')).toHaveCount(2);
  });

  test('the pins move with the map in the same frame, and React does not render per move', async ({ page, apiAs }) => {
    const all = (await json(await (await apiAs('admin')).get('/api/plant/map/sites'))) as { sites: { id: string; geo: { lat: number; lon: number } | null }[] };
    const geo = Object.fromEntries(all.sites.filter((s) => s.geo).map((s) => [s.id, s.geo!]));
    await page.addInitScript(() => Object.assign(window, { __stewardTestHooks: true }));
    await page.goto('/plant/map');
    await mapReady(page);
    await expect(page.getByTestId('map-pins').getByRole('button')).toHaveCount(2);
    const r = await page.evaluate(async (geo) => {
      type M = import('maplibre-gl').Map;
      const wrap = document.querySelector('[data-testid="sites-map"]') as HTMLElement & { __steward: { map: M; commits: () => number } };
      const m = wrap.__steward.map;
      const box = wrap.querySelector('.pm-map')!.getBoundingClientRect();
      /** The largest distance between a pin in view (its tip: bottom centre) and where the map puts its site – now */
      const offset = () => {
        let max = 0;
        for (const [id, g] of Object.entries(geo)) {
          const el = wrap.querySelector(`[data-testid="map-pin-${id}"]`);
          const p = m.project([g.lon, g.lat]);
          if (!el || p.x < 0 || p.y < 0 || p.x > box.width || p.y > box.height) continue;
          const b = el.getBoundingClientRect();
          max = Math.max(max, Math.hypot(b.left + b.width / 2 - box.left - p.x, b.bottom - box.top - p.y));
        }
        return max;
      };
      // without animation: read in the same task as the move, before any frame or React render could catch up
      const jumps: number[] = [];
      m.panBy([40, -30], { animate: false });
      jumps.push(offset());
      m.jumpTo({ center: [m.getCenter().lng - 0.02, m.getCenter().lat + 0.01] });
      jumps.push(offset());
      m.jumpTo({ zoom: m.getZoom() + 0.4 });
      jumps.push(offset());
      m.jumpTo({ zoom: m.getZoom() - 0.4 });
      jumps.push(offset());
      // an animated pan, sampled every frame; React commits during it: none per move
      const before = wrap.__steward.commits();
      const frames: number[] = [];
      await new Promise<void>((done) => {
        let ended = false;
        m.once('moveend', () => (ended = true));
        const tick = () => {
          frames.push(offset());
          if (ended) return done();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        m.panBy([-60, 20], { duration: 800 });
      });
      // a pin whose site leaves the view is hidden at once (not focusable, not announced)
      const [id, g] = Object.entries(geo)[0]!;
      m.panBy([m.project([g.lon, g.lat]).x + 40, 0], { animate: false });
      const off = wrap.querySelector(`[data-testid="map-pin-${id}"]`)?.hasAttribute('data-off');
      return { jumps, frames: frames.length, panned: Math.max(...frames), commits: wrap.__steward.commits() - before, off, id };
    }, geo);
    for (const d of r.jumps) expect(d).toBeLessThanOrEqual(1.5);
    expect(r.frames).toBeGreaterThan(3);
    expect(r.panned).toBeLessThanOrEqual(1.5);
    expect(r.commits).toBeLessThanOrEqual(2);
    expect(r.off).toBe(true);
    await expect(page.getByTestId(`map-pin-${r.id}`)).toBeHidden();
  });

  test('light and dark vector styles: vector tiles through the worker, the dark style follows the theme', async ({ page, apiAs }) => {
    await mapSource(await apiAs('admin'), { source: 'openfreemap' });
    const seen = watchRequests(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    const tileAnswer = page.waitForResponse((r) => r.url().includes('/api/plant/map/tiles/base/') && r.status() === 200);
    await page.goto('/plant/map');
    await mapReady(page);
    await expect.poll(() => seen.filter((r) => r.url().includes('/api/plant/map/style.json?theme=dark')).length).toBeGreaterThan(0);
    const tile = await tileAnswer;
    expect(tile.headers()['content-type']).toBe('application/x-protobuf');
    expect(foreign(seen)).toEqual([]);
    await expect(page.getByTestId('map-attribution')).toContainText('OpenFreeMap © OpenMapTiles');
    await expectAccessible(page, 'map page, dark');
    await mapSource(await apiAs('admin'), { source: 'osm' });
  });

  test('without WebGL 2 the list stays, with the reason', async ({ page }) => {
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      // a browser (or virtual desktop) without WebGL 2
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, id: string, ...rest: unknown[]) {
        if (id === 'webgl2') return null;
        return (orig as (...a: unknown[]) => unknown).call(this, id, ...rest);
      } as typeof orig;
    });
    await page.goto('/plant/map');
    await expect(page.getByTestId('map-notice-webgl')).toContainText('WebGL 2');
    await expect(page.getByTestId('map-site-list').getByRole('link', { name: 'Hillcrest Plant', exact: true })).toBeVisible();
  });

  test('the site page: Show on the map, and the position picker of the form', async ({ page }) => {
    await page.goto('/plant/sites/hillcrest');
    await page.getByTestId('show-on-map').click();
    await expect(page).toHaveURL(/\/plant\/map/);
    await expect(page.getByTestId('map-card').getByRole('link', { name: 'Hillcrest Plant' })).toBeVisible();

    await page.goto('/plant/sites/hillcrest');
    await page.getByRole('button', { name: 'Edit' }).first().click();
    const dialog = page.getByRole('dialog');
    const picker = dialog.getByTestId('position-picker');
    await expect(picker).toBeVisible();
    const lat = dialog.getByLabel('Latitude');
    const before = await lat.inputValue();
    const box = (await picker.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.3);
    await expect(lat).not.toHaveValue(before);
    await dialog.screenshot({ path: test.info().outputPath('map-picker.png') });
    await expectAccessible(page, 'site form with the position picker');
    // not saved: the demo site keeps its position
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('the dashboard widget shows the map of the sites the reader may see', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    const name = uniq('Sites map');
    const d = await json(
      await admin.post('/api/dashboards', { data: { definition: { name, widgets: [{ id: 'w1', type: 'sitesMap', title: 'Our sites', width: 6 }] } } }),
    );
    try {
      await page.goto(`/dashboards/${d.id}`);
      await mapReady(page, 'widget-map');
      // small: the two demo sites may be one cluster
      await expect(
        page
          .getByTestId('widget-map')
          .getByTestId('map-pins')
          .getByRole('button', { name: /Riverside Works|2 sites/ }),
      ).toBeVisible();
      await expectAccessible(page, 'dashboard with the sites map');
      await page.screenshot({ path: test.info().outputPath('map-widget.png') });
    } finally {
      await admin.delete(`/api/dashboards/${d.id}`);
    }
  });

  test('screenshots in light and dark at 1280 px', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/plant/map');
      await mapReady(page);
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: test.info().outputPath(`map-${scheme}-1280.png`) });
    }
  });

  test('on a phone: the list first, the map one tap away, nothing wider than the screen', async ({ browser }) => {
    // the same serial run (the map's source is one setting of the server): a phone context of its own
    const ctx = await browser.newContext({ ...devices['Pixel 5'], viewport: { width: 390, height: 844 }, storageState: authFile('dana'), baseURL: baseURL() });
    const page = await ctx.newPage();
    try {
      await page.goto('/plant/map');
      await expect(page.getByTestId('map-site-list').getByRole('link', { name: 'Riverside Works', exact: true })).toBeVisible();
      await expect(page.getByTestId('sites-map')).toHaveCount(0);
      await expectNoHorizontalScroll(page);
      await expectAccessible(page, 'map page on a phone (list)');
      await page.getByTestId('view-mode').getByText('Picture').click();
      await mapReady(page);
      await expect(page.getByTestId('map-pins').getByRole('button').first()).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectAccessible(page, 'map page on a phone (map)');
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.reload();
        await page.getByTestId('view-mode').getByText('Picture').click();
        await mapReady(page);
        await page.waitForLoadState('networkidle');
        await page.screenshot({ path: test.info().outputPath(`map-${scheme}-390.png`) });
      }
      // Show from the list switches to the map with the card
      await page.getByTestId('view-mode').getByText('Table').click();
      await page.getByTestId('show-on-map-hillcrest').click();
      await expect(page.getByTestId('map-card')).toBeVisible();
    } finally {
      await ctx.close();
    }
  });
});

/**
 * The phone project: whatever the map's source is right now (the serial run above changes it), the page starts with
 * the list and fits the screen; the map or the reason why there is none is one tap away.
 */
test.describe('on a phone', () => {
  test.use({ storageState: authFile('dana') });
  test.beforeAll(async ({ apiAs }) => plantOn(await apiAs('admin')));

  test('the map page fits the screen, the list first @mobile', async ({ page }) => {
    await page.goto('/plant/map');
    await expect(page.getByTestId('map-site-list').getByRole('link', { name: 'Riverside Works', exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'map page on a phone');
    const toggle = page.getByTestId('view-mode');
    if (await toggle.count()) {
      await toggle.getByText('Picture').click();
      await expect(page.getByTestId('sites-map').or(page.getByTestId('map-notice-load'))).toBeVisible();
      await expectNoHorizontalScroll(page);
    } else await expect(page.getByTestId('map-notice-off').or(page.getByTestId('map-notice-webgl'))).toBeVisible();
  });
});
