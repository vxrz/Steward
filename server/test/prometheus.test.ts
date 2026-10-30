import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Prometheus (#110): the monitor check type `prometheus` against the mock Prometheus – the worst series counts,
 * levels above or below, no data, query errors – the platform preset, and availability objectives whose figures come
 * from a PromQL query with $window.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let eng: typeof import('../src/monitors/engine.js');
let mock: typeof import('../src/mock/mockPrometheus.js');
let promId: string;

const FS = '100 * (1 - node_filesystem_avail_bytes{mountpoint="/var"} / node_filesystem_size_bytes{mountpoint="/var"})';
const check = (id: string, query: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  type: 'prometheus',
  platform: 'Prometheus (demo)',
  query,
  crit: 90,
  ...extra,
});

async function states(checks: unknown[]) {
  const { monitor } = await s.api('POST', '/monitors', { definition: { name: `Prometheus ${Math.random()}`, failuresBeforeDown: 1, checks } });
  await eng.evaluateMonitorNow(monitor.id);
  const m = await s.api('GET', `/monitors/${monitor.id}`);
  return Object.fromEntries(m.checks.map((c: any) => [c.checkId, { status: c.status, message: c.last?.message }]));
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  eng = await import('../src/monitors/engine.js');
  mock = await import('../src/mock/mockPrometheus.js');
  promId = (await s.api('GET', '/platforms')).find((p: any) => p.name === 'Prometheus (demo)').id;
});
afterAll(async () => {
  await s?.app.close();
});

describe('Prometheus check', () => {
  it('judges every series; the worst one counts and is named', async () => {
    mock.resetPrometheus();
    const st = await states([
      check('fsWarn', FS, { warn: 80 }),
      check('fsOk', FS, { warn: 85 }),
      check('fsCrit', FS, { warn: 70, crit: 80 }),
      check('up', 'up{job="shop"}', { direction: 'below', crit: 0, unit: '' }),
    ]);
    expect(st.fsWarn).toMatchObject({ status: 'degraded', message: 'Prometheus: {instance="db01:9100"} 82.04 (worst of 2 series) (WARN 80, CRIT 90)' });
    expect(st.fsOk).toMatchObject({
      status: 'up',
      message: 'Prometheus: all 2 series within the levels, worst {instance="db01:9100"} 82.04 (WARN 85, CRIT 90)',
    });
    expect(st.fsCrit.status).toBe('down');
    expect(st.up).toMatchObject({ status: 'up' });
    // one target down: "below" with CRIT 0 turns the check down and names the instance
    mock.setPromResult('up{job="shop"}', [
      { metric: { __name__: 'up', job: 'shop', instance: 'shop-1:9100' }, value: 1 },
      { metric: { __name__: 'up', job: 'shop', instance: 'shop-2:9100' }, value: 0 },
    ]);
    const after = await states([check('up', 'up{job="shop"}', { direction: 'below', crit: 0 })]);
    expect(after.up).toMatchObject({ status: 'down', message: 'Prometheus: up{instance="shop-2:9100"} 0 (worst of 2 series) (CRIT 0)' });
  });

  it('no series: unknown by default, or what the check says; a query error is reported plainly', async () => {
    mock.resetPrometheus();
    const st = await states([
      check('none', 'up{job="gone"}'),
      check('noneUp', 'up{job="gone"}', { noData: 'up' }),
      check('noneDown', 'up{job="gone"}', { noData: 'down' }),
      check('bad', 'syntax_error('),
    ]);
    expect(st.none).toMatchObject({ status: 'unknown', message: 'Prometheus: the query returned no series' });
    expect(st.noneUp.status).toBe('up');
    expect(st.noneDown.status).toBe('down');
    expect(st.bad).toMatchObject({
      status: 'unknown',
      message: expect.stringMatching(/^Prometheus could not be read: Prometheus answered HTTP 400: invalid parameter "query"/),
    });
  });

  it('offers the platform preset with a connection test', async () => {
    const preset = (await s.api('GET', '/platform-presets')).find((p: any) => p.kind === 'prometheus');
    expect(preset).toMatchObject({ config: { testPath: '/api/v1/status/buildinfo' } });
    expect(await s.api('POST', `/platforms/${promId}/test`, {})).toMatchObject({ ok: true });
  });
});

describe('availability objective from a PromQL query', () => {
  it('reads the figures per window with $window and judges them like Gatus figures', async () => {
    const svc = await s.api('POST', '/services', { name: 'Shop (Prometheus)', owners: [] });
    const body = { serviceId: svc.id, name: 'Shop up', platformId: promId, targets: { h24: 99.9, d7: 99.9, d30: 99.5 } };
    await expect(s.api('POST', '/objectives', { ...body, endpointKey: 'avg_over_time(up{job="shop"}[7d])' })).rejects.toThrow(/\$window/);
    const o = await s.api('POST', '/objectives', { ...body, endpointKey: 'avg_over_time(up{job="shop"}[$window])' });
    // before the first read: no data, no source yet
    expect((await s.api('GET', `/objectives/${o.id}`)).noDataReason).toBe('noSource');
    const { readPromObjectives } = await import('../src/scorecard/objectives.js');
    expect(await readPromObjectives(Date.now(), true)).toBe(1);
    expect(await readPromObjectives()).toBe(0); // read within the hour: not again
    const d = await s.api('GET', `/objectives/${o.id}`);
    // 24h 99.93 % ≥ 99.9, 7d 99.78 % < 99.9, 30d 99.91 % ≥ 99.5
    expect(d.windows.map((w: any) => [w.window, w.value, w.status])).toEqual([
      ['h24', 99.93, 'met'],
      ['d7', 99.78, 'below'],
      ['d30', 99.91, 'met'],
    ]);
    expect(d.status).toBe('below');
  });
});
