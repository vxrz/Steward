import http from 'node:http';
import type { AddressInfo } from 'node:net';
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

  it('sends the query as a form POST, and falls back to GET on 405', async () => {
    mock.resetPrometheus();
    const long = `up{job="shop", instance=~"${'x|'.repeat(1900)}y"}`;
    await states([check('long', long)]);
    expect(mock.promRequests.at(-1)).toMatchObject({ method: 'POST', query: long });
    mock.setPromPostAllowed(false);
    const st = await states([check('get', FS, { warn: 85 })]);
    expect(st.get.status).toBe('up');
    expect(mock.promRequests.slice(-2).map((r) => r.method)).toEqual(['POST', 'GET']);
    mock.resetPrometheus();
  });

  it('+Inf and -Inf are judged against the levels, only NaN is unknown', async () => {
    mock.resetPrometheus();
    mock.setPromResult('ratio_inf', [{ metric: { __name__: 'ratio', job: 'a' }, value: Infinity }]);
    mock.setPromResult('ratio_neginf', [{ metric: { __name__: 'ratio', job: 'b' }, value: -Infinity }]);
    mock.setPromResult('ratio_nan', [{ metric: { __name__: 'ratio', job: 'c' }, value: NaN }]);
    const st = await states([
      check('inf', 'ratio_inf'),
      check('neginfBelow', 'ratio_neginf', { direction: 'below', crit: 0 }),
      check('neginfAbove', 'ratio_neginf'),
      check('nan', 'ratio_nan'),
    ]);
    expect(st.inf).toMatchObject({ status: 'down', message: 'Prometheus: ratio{job="a"} +Inf (CRIT 90)' });
    expect(st.neginfBelow.status).toBe('down');
    expect(st.neginfAbove.status).toBe('up');
    expect(st.nan).toMatchObject({ status: 'unknown', message: expect.stringContaining('not a number') });
  });

  it('a wrong base URL, a missing tenant, credentials not sent and non-JSON answers are explained', async () => {
    const host = http.createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0];
      if (path === '/mimir/api/v1/query') {
        res.writeHead(401, { 'content-type': 'text/plain' });
        return res.end('no org id\n');
      }
      if (path === '/basic/api/v1/query') {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="prometheus"' });
        return res.end();
      }
      if (path === '/html/api/v1/query') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<html><body>Grafana sign in</body></html>');
      }
      if (path === '/text/api/v1/query') {
        res.writeHead(502, { 'content-type': 'text/plain' });
        return res.end('upstream connect error with secret prom-pass-secret-1 inside');
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('404 page not found');
    });
    await new Promise<void>((r) => host.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
    try {
      const { promInstant } = await import('../src/platforms/prometheus.js');
      const { getPlatform } = await import('../src/platforms/service.js');
      const make = async (name: string, path: string, auth = 'none', secrets?: Record<string, string>) => {
        const p = await s.api('POST', '/platforms', {
          name,
          kind: 'prometheus',
          baseUrl: `${origin}${path}`,
          config: { auth: { type: auth }, variables: {}, http: { proxy: 'none', retry: { maxRetries: 0 } } },
          secrets,
        });
        return getPlatform(p.id);
      };
      const fail = async (p: any, secrets: Record<string, string> = {}) => (await promInstant(p, secrets, 'up').catch((e: Error) => e)) as Error;
      expect((await fail(await make('P root', ''))).message).toBe(
        `Prometheus answered HTTP 404: no Prometheus API at ${origin}/api/v1/query – Mimir and Cortex need the prefix …/prometheus in the base URL, VictoriaMetrics cluster …/select/<tenant>/prometheus, Grafana Cloud …/api/prom; Prometheus, Thanos Query and single-node VictoriaMetrics take the server root (docs/PROMETHEUS.md)`,
      );
      expect((await fail(await make('P mimir', '/mimir'))).message).toContain('add the default header X-Scope-OrgID: <tenant>');
      const trap = await fail(await make('P trap', '/basic', 'none', { username: 'reader', password: 'prom-pass-secret-1' }), {
        username: 'reader',
        password: 'prom-pass-secret-1',
      });
      expect(trap.message).toBe(
        'Prometheus answered HTTP 401 (an empty response) – Authentication is set to "none" – the username/password you entered are not sent. Choose "basic" under Settings → Authentication.',
      );
      expect((await fail(await make('P html', '/html'))).message).toBe(
        'Prometheus answered HTTP 200 with an HTML page, not the {"status":"success"} of a Prometheus query API – is the base URL the Prometheus API?',
      );
      const text = await fail(await make('P text', '/text', 'basic', { username: 'u', password: 'prom-pass-secret-1' }), {
        username: 'u',
        password: 'prom-pass-secret-1',
      });
      expect(text.message).toBe('Prometheus answered HTTP 502 with text/plain: "upstream connect error with secret *** inside"');
    } finally {
      host.close();
    }
  });

  it('offers the platform preset with a connection test', async () => {
    const preset = (await s.api('GET', '/platform-presets')).find((p: any) => p.kind === 'prometheus');
    expect(preset).toMatchObject({ config: { testPath: '/api/v1/status/buildinfo' } });
    expect(await s.api('POST', `/platforms/${promId}/test`, {})).toMatchObject({ ok: true });
  });

  it('brings an API specification (PromQL through the MCP gateway), also for platforms made before it had one', async () => {
    const ops = async (id: string) => (await s.api('GET', `/platforms/${id}/operations`)) as { operationId?: string; method: string; path: string }[];
    // a new platform of the preset gets it
    const fresh = await s.api('POST', '/platforms', {
      name: 'Prometheus (new)',
      kind: 'prometheus',
      baseUrl: 'https://prometheus.example.com',
      config: { auth: { type: 'none' }, variables: {}, http: {} },
      secrets: {},
    });
    expect((await ops(fresh.id)).find((o) => o.operationId === 'query')).toMatchObject({ method: 'GET', path: '/api/v1/query' });
    // one made without it (before 0.3.1, like the demo's) adds it with one click – and not twice
    expect(await ops(promId)).toEqual([]);
    expect(await s.api('POST', `/platforms/${promId}/specs/built-in`, {})).toEqual({ added: ['Prometheus HTTP API (read endpoints)'] });
    expect((await ops(promId)).map((o) => o.operationId)).toEqual(expect.arrayContaining(['query', 'queryRange', 'series', 'labelValues', 'alerts']));
    expect(await s.api('POST', `/platforms/${promId}/specs/built-in`, {})).toEqual({ added: [] });
    await s.api('DELETE', `/platforms/${fresh.id}`);
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
