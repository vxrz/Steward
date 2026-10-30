import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Trends of dataset metrics (#145) through Steward: limits and floors from the publish step, trends and forecasts in
 * the API (internal and v1), and $trend / $daysUntil in a process check.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const DAY = 86_400_000;

const publisher = {
  name: 'Publish asset attributes',
  nodes: [
    { id: 'start', type: 'start', x: 0, y: 0 },
    {
      id: 'pub',
      type: 'publish',
      dataset: 'test.assets',
      title: 'Assets',
      rows: '[]',
      metrics: { attributes: '900', free: '100' },
      limits: { attributes: '1130', broken: "'not a number'" },
      floors: { free: '40' },
      x: 1,
      y: 0,
    },
  ],
  wires: [{ from: 'start', port: 'out', to: 'pub' }],
};

const checker = {
  name: 'Asset limit check',
  nodes: [
    { id: 'start', type: 'start', x: 0, y: 0 },
    {
      id: 'chk',
      type: 'check',
      name: 'Limit not within 30 days',
      condition: "$daysUntil('test.assets/attributes') = null or $daysUntil('test.assets/attributes') > 30",
      message: "{{ $round($daysUntil('test.assets/attributes')) }} days · {{ $round($trend('test.assets/attributes', '30d').perDay) }} a day",
      severity: 'warning',
      x: 1,
      y: 0,
    },
  ],
  wires: [{ from: 'start', port: 'out', to: 'chk' }],
};

let pubId: string;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  pubId = (await s.api('POST', '/processes', { definition: publisher })).id;
  const { id } = await s.api('POST', '/runs', { processId: pubId, bindings: {} });
  expect((await s.waitRun(id, ['succeeded', 'failed'])).status).toBe('succeeded');
  // a month of history: +10 attributes a day up to 900 today, free storage −2 a day down to 100
  const { db } = await import('../src/db.js');
  db().run("DELETE FROM dataset_metrics WHERE dataset_key = 'test.assets'");
  const now = Date.now();
  for (let back = 29; back >= 0; back--) {
    const ts = new Date(now - back * DAY - 60_000).toISOString();
    db().run(
      "INSERT INTO dataset_metrics (dataset_key, name, ts, value, run_id, source) VALUES ('test.assets', 'attributes', ?, ?, ?, 'instance')",
      ts,
      900 - 10 * back,
      id,
    );
    db().run(
      "INSERT INTO dataset_metrics (dataset_key, name, ts, value, run_id, source) VALUES ('test.assets', 'free', ?, ?, ?, 'instance')",
      ts,
      100 + 2 * back,
      id,
    );
  }
});
afterAll(async () => {
  await s?.app.close();
});

describe('metric trends', () => {
  it('stores the limits and floors of the publish step per source (a limit that is not a number is left out)', async () => {
    const d = await s.api('GET', '/datasets/test.assets');
    expect(d.limits).toEqual({ attributes: { value: 1130, lower: false }, free: { value: 40, lower: true } });
    expect(d.sources[0].limits).toEqual(d.limits);
  });

  it('adds the trend and the forecast to the metric series', async () => {
    const series = await s.api('GET', '/datasets/test.assets/metrics?days=30&trend=30d');
    const att = series.find((x: any) => x.name === 'attributes');
    expect(att.limit).toEqual({ value: 1130, lower: false });
    expect(att.trend).toMatchObject({ window: '30d', points: 30, confidence: 'stable' });
    expect(att.trend.perDay).toBeCloseTo(10, 3);
    expect(att.forecast).toMatchObject({ state: 'approaching', lower: false });
    expect(att.forecast.days).toBeCloseTo(23, 0);
    const free = series.find((x: any) => x.name === 'free');
    expect(free.forecast).toMatchObject({ state: 'approaching', lower: true, days: 30 });
    // without trend=…, the series stay as they were
    expect((await s.api('GET', '/datasets/test.assets/metrics?days=30'))[0].trend).toBeUndefined();
    expect(await s.api('GET', '/datasets/test.assets/metrics?days=30&trend=1y').catch((e: any) => e.status)).toBe(400);
  });

  it('is in the public API', async () => {
    const token = (await s.api('POST', '/me/tokens', { name: 'trends', scope: 'read' })).token;
    const r = await (
      await fetch(`${s.base}/api/v1/datasets/test.assets/metrics?names=attributes&trend=7d`, { headers: { authorization: `Bearer ${token}` } })
    ).json();
    expect(r.series[0].trend).toMatchObject({ window: '7d', points: 7 });
    expect(r.series[0].trend.perDay).toBeCloseTo(10, 3);
  });

  it('lets a check warn before the limit is reached ($daysUntil, $trend)', async () => {
    const proc = (await s.api('POST', '/processes', { definition: checker })).id;
    const { id } = await s.api('POST', '/runs', { processId: proc, bindings: {} });
    const run = await s.waitRun(id, ['succeeded', 'failed']);
    const chk = (await s.api('GET', `/runs/${id}`)).steps.find((x: any) => x.stepId === 'chk');
    expect(run.status).toBe('succeeded');
    expect(chk.status).toBe('failed');
    expect(chk.output).toMatchObject({ passed: false, severity: 'warning', message: '23 days · 10 a day' });
  });

  it('lists limits reached soon and strong changes in the daily summary; people who had every section get it', async () => {
    const sum = await import('../src/notifications/summary.js');
    const { listUsers } = await import('../src/auth/users.js');
    const { db } = await import('../src/db.js');
    const admin = listUsers().find((u) => u.username === 'admin')!;
    const prefs = { ...sum.getPrefs(admin.id), sections: ['trends'] } as any;
    const c = sum.buildSummary(admin, prefs, Date.now() - 86_400_000, Date.now() + 1000);
    const sec = c.sections.find((x: any) => x.id === 'trends')!;
    const titles = sec.items.map((i: any) => i.title);
    // attributes reach 1130 in about 23 days, free storage 40 in about 30 (both within 30 days), soonest first
    expect(titles.slice(0, 2)).toEqual(['Assets · attributes', 'Assets · free']);
    expect(sec.items[0].detail).toMatch(/^Limit of 1,130 reached in about 23 days/);
    expect(sec.items[0].tone).toBe('attention');
    // free storage fell by 12 % in 7 days (114 → 100); attributes rose by 8 %: not a strong trend
    expect(sec.items.slice(2).map((i: any) => [i.title, i.detail.slice(0, 7)])).toEqual([['Assets · free', '-12.3 %']]);
    // stored preferences with every section of before: the new section is added; a chosen subset stays as it was
    const old = ['runs', 'tasks', 'monitors', 'credentials', 'tickets', 'records', 'reviews', 'duties', 'reports'];
    db().run(
      "INSERT INTO daily_summary_prefs (user_id, enabled, prefs, updated_at) VALUES (?, 1, ?, '2026-10-01T00:00:00Z') ON CONFLICT(user_id) DO UPDATE SET prefs = excluded.prefs",
      admin.id,
      JSON.stringify({ ...prefs, sections: old }),
    );
    expect(sum.getPrefs(admin.id).sections).toContain('trends');
    db().run('UPDATE daily_summary_prefs SET prefs = ? WHERE user_id = ?', JSON.stringify({ ...prefs, sections: ['runs'] }), admin.id);
    expect(sum.getPrefs(admin.id).sections).toEqual(['runs']);
  });

  it('gives no trend for a dataset the run may not read, or a wrong reference', async () => {
    const m = await import('../src/dashboards/datasets.js');
    const deny = { runId: '', processId: 'prc_other', mayRead: () => false };
    expect(m.metricForRun('test.assets/attributes', '7d', deny)).toBeNull();
    expect(m.metricForRun('test.assets/attributes', '7d', { ...deny, processId: pubId })?.trend?.points).toBe(7);
    expect(() => m.metricForRun('attributes', '7d', deny)).toThrow(/dataset\/metric/);
    expect(() => m.metricForRun('test.assets/attributes', 'month', deny)).toThrow(/24h, 7d or 30d/);
    expect(m.metricForRun('no.such/x', '7d', { ...deny, mayRead: () => true })).toBeNull();
  });
});
