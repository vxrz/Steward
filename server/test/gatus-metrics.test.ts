import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

// the scraper and the monitor engine are driven by the tests
process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let gatusId: string;
let dana: Client, olivia: Client, vera: Client;
let gm: typeof import('../src/gatus/metrics.js');
const PW = 'Demo-password-1';
const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status: number }) => e.status);
const mock = (path: string, body: unknown = {}) =>
  fetch(`${s.base}/mock/gatus${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

/** Realistic /metrics output of Gatus v5 (prometheus/client_golang), trimmed. */
const FIXTURE = `# HELP gatus_results_certificate_expiration_seconds Number of seconds until the certificate expires
# TYPE gatus_results_certificate_expiration_seconds gauge
gatus_results_certificate_expiration_seconds{group="core",key="core_blog-external",name="blog-external",type="HTTP"} 4.636365e+06
# HELP gatus_results_code_total Total number of results by code
# TYPE gatus_results_code_total counter
gatus_results_code_total{code="200",group="core",key="core_blog-external",name="blog-external",type="HTTP"} 12
# HELP gatus_results_connected_total Total number of results in which a connection was successfully established
# TYPE gatus_results_connected_total counter
gatus_results_connected_total{group="core",key="core_blog-external",name="blog-external",type="HTTP"} 12
gatus_results_connected_total{group="",key="_example-dns-query",name="example-dns-query",type="DNS"} 12
# HELP gatus_results_duration_seconds Duration of the request in seconds
# TYPE gatus_results_duration_seconds gauge
gatus_results_duration_seconds{group="core",key="core_blog-external",name="blog-external",type="HTTP"} 0.258722542
gatus_results_duration_seconds{group="",key="_example-dns-query",name="example-dns-query",type="DNS"} 0.0123
# HELP gatus_results_endpoint_success Displays whether or not the endpoint was a success
# TYPE gatus_results_endpoint_success gauge
gatus_results_endpoint_success{group="core",key="core_blog-external",name="blog-external",type="HTTP"} 1
gatus_results_endpoint_success{group="",key="_example-dns-query",name="example-dns-query",type="DNS"} 0
# HELP gatus_results_total Number of results per endpoint
# TYPE gatus_results_total counter
gatus_results_total{group="core",key="core_blog-external",name="blog-external",success="true",type="HTTP"} 12
gatus_results_total{group="",key="_example-dns-query",name="example-dns-query",success="false",type="DNS"} 9
gatus_results_total{group="",key="_example-dns-query",name="example-dns-query",success="true",type="DNS"} 3
# HELP process_start_time_seconds Start time of the process since unix epoch in seconds.
# TYPE process_start_time_seconds gauge
process_start_time_seconds 1.76111229517e+09
# HELP promhttp_metric_handler_requests_total Total number of scrapes by HTTP status code.
# TYPE promhttp_metric_handler_requests_total counter
promhttp_metric_handler_requests_total{code="200"} 4
`;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  gatusId = (await s.api('GET', '/platforms')).find((p: any) => p.name === 'Gatus (demo)').id;
  [dana, olivia, vera] = await Promise.all([s.as('dana', PW), s.as('olivia', PW), s.as('vera', PW)]);
  gm = await import('../src/gatus/metrics.js');
});
afterAll(async () => {
  await s?.app.close();
});

describe('Prometheus text parser', () => {
  it('parses the Gatus metrics: names, labels, values in exponent notation, HELP/TYPE', async () => {
    const { parsePrometheus } = await import('../src/gatus/prometheus.js');
    const r = parsePrometheus(FIXTURE);
    expect(r.malformed).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.types.get('gatus_results_total')).toBe('counter');
    const cert = r.samples.find((x) => x.name === 'gatus_results_certificate_expiration_seconds')!;
    expect(cert.labels).toEqual({ group: 'core', key: 'core_blog-external', name: 'blog-external', type: 'HTTP' });
    expect(cert.value).toBe(4636365);
    expect(r.samples.find((x) => x.name === 'process_start_time_seconds')!.value).toBe(1761112295.17);
    const { endpoints, startedAt } = gm.endpointsFromSamples(r.samples);
    expect(startedAt).toBe(1761112295170);
    expect(endpoints.get('_example-dns-query')).toMatchObject({ group: '', ok: 3, fail: 9, success: 0, type: 'DNS' });
    expect(endpoints.get('core_blog-external')).toMatchObject({ ok: 12, fail: 0, success: 1, durationS: 0.258722542 });
  });

  it('skips malformed lines without failing, handles escapes, timestamps and special values', async () => {
    const { parsePrometheus } = await import('../src/gatus/prometheus.js');
    const text = [
      'good{key="a\\"b\\\\c\\nd",x="1"} 1 1700000000000',
      'no_value{key="a"}',
      'bad{key="unterminated} 1',
      'bad2{key=noquotes} 1',
      'bad3{key="a",key="b"} 1',
      '{key="nameless"} 1',
      'bad4 notanumber',
      'bad5{key="x"} 1 2 3',
      'inf_value +Inf',
      'nan_value NaN',
      'spaces   {  key = "y" ,  } 2',
      '',
      '   # a comment',
      'crlf_line 7\r',
    ].join('\n');
    const r = parsePrometheus(text);
    expect(r.samples.map((x) => x.name)).toEqual(['good', 'inf_value', 'nan_value', 'spaces', 'crlf_line']);
    expect(r.samples[0]).toMatchObject({ labels: { key: 'a"b\\c\nd', x: '1' }, value: 1, timestamp: 1700000000000 });
    expect(r.samples[1]!.value).toBe(Infinity);
    expect(Number.isNaN(r.samples[2]!.value)).toBe(true);
    expect(r.samples[3]).toMatchObject({ labels: { key: 'y' }, value: 2 });
    expect(r.samples[4]!.value).toBe(7);
    expect(r.malformed).toBe(7);
  });

  it('limits bytes, lines, samples and label sizes', async () => {
    const { parsePrometheus } = await import('../src/gatus/prometheus.js');
    const many = Array.from({ length: 1000 }, (_, i) => `m{key="k${i}"} ${i}`).join('\n');
    expect(parsePrometheus(many, { maxSamples: 10 })).toMatchObject({ truncated: true });
    expect(parsePrometheus(many, { maxSamples: 10 }).samples).toHaveLength(10);
    expect(parsePrometheus(many, { maxLines: 5 }).samples).toHaveLength(5);
    const cut = parsePrometheus(many, { maxBytes: 100 });
    expect(cut.truncated).toBe(true);
    expect(cut.samples.length).toBeLessThan(10);
    expect(cut.malformed).toBe(0); // the partial last line is dropped, not counted
    const long = parsePrometheus(`m{key="${'x'.repeat(5000)}"} 1`);
    expect(long.samples).toHaveLength(0);
    expect(long.malformed).toBe(1);
    const labels = parsePrometheus(`m{${Array.from({ length: 50 }, (_, i) => `l${i}="v"`).join(',')}} 1`);
    expect(labels.malformed).toBe(1);
    // keep(): only the wanted metric names are kept
    expect(parsePrometheus(FIXTURE, { keep: (n) => n === 'gatus_results_total' }).samples).toHaveLength(3);
  });

  it('reads the uptime figures of the text and JSON variants of the uptime API', () => {
    expect(gm.parseUptime('0.958333')).toBe(95.83);
    expect(gm.parseUptime(1)).toBe(100);
    expect(gm.parseUptime({ uptime: 0.5 })).toBe(50);
    expect(gm.parseUptime('<svg>')).toBeNull();
    expect(gm.parseUptime('7')).toBeNull();
  });
});

describe('counter deltas and resets', () => {
  const PID = 'plt_counter_test';
  const text = (ok: number, fail: number, success: number, started = 1.7e9) =>
    `gatus_results_total{key="k",group="g",name="n",success="true",type="HTTP"} ${ok}\ngatus_results_total{key="k",group="g",name="n",success="false",type="HTTP"} ${fail}\n` +
    `gatus_results_endpoint_success{key="k",group="g",name="n",type="HTTP"} ${success}\ngatus_results_duration_seconds{key="k",group="g",name="n",type="HTTP"} 0.1\nprocess_start_time_seconds ${started}\n`;

  it('computes uptime from deltas, survives a counter reset and a Gatus restart', async () => {
    const { db } = await import('../src/db.js');
    db().run(
      "INSERT INTO gatus_sources (platform_id, owner, created_at, updated_at, updated_by) VALUES (?, 'admin', ?, ?, 'admin')",
      PID,
      new Date().toISOString(),
      new Date().toISOString(),
    );
    const t0 = Date.parse('2026-01-05T10:00:00Z');
    gm.storeScrape(PID, text(100, 0, 1), t0); // baseline: not counted
    gm.storeScrape(PID, text(110, 0, 1), t0 + 60000); // +10 ok
    gm.storeScrape(PID, text(110, 5, 0), t0 + 120000); // +5 failed → outage starts
    // counter went down without a new start time: a reset (e.g. counters re-registered) → the new values count
    const r1 = gm.storeScrape(PID, text(3, 1, 1), t0 + 180000);
    expect(r1.resets).toBe(1);
    // Gatus restarted (new process start time): counters start from zero even though they grew
    const r2 = gm.storeScrape(PID, text(20, 1, 1, 1.8e9), t0 + 240000);
    expect(r2.resets).toBe(1);
    const up = gm.uptimeBetween(PID, t0, t0 + 3600000).get('k')!;
    // 10 + 3 + 20 ok, 5 + 1 + 1 failed
    expect([up.ok, up.fail]).toEqual([33, 7]);
    expect(up.uptime).toBe(82.5);
    const av = gm.availability(PID, null, t0, t0 + 3600000)[0]!;
    expect(av.outages).toEqual([{ from: new Date(t0 + 120000).toISOString(), to: new Date(t0 + 180000).toISOString(), durationMs: 60000 }]);
    expect(av.avgMs).toBe(100);
    expect(av.p95Ms).toBe(100);
    gm.deleteSource(PID);
  });
});

describe('scraping the (mock) Gatus metrics endpoint', () => {
  it('only Gatus platform managers configure metrics mode; others get 403/404', async () => {
    const body = { enabled: true, intervalSeconds: 60, metricsPath: '/metrics' };
    expect(await status(vera('PUT', `/gatus/sources/${gatusId}`, body))).toBe(404); // no right on the platform at all
    expect(await status(olivia('PUT', `/gatus/sources/${gatusId}`, body))).toBe(403); // may use, not manage
    expect(await status(dana('PUT', `/gatus/sources/${gatusId}`, body))).toBe(403);
    expect(await status(s.api('PUT', `/gatus/sources/${gatusId}`, { ...body, metricsPath: 'https://evil.example/metrics' }))).toBe(400);
    expect(await status(s.api('PUT', `/gatus/sources/${gatusId}`, { ...body, metricsPath: '//evil.example/metrics' }))).toBe(400);
    expect(await status(s.api('PUT', `/gatus/sources/${gatusId}`, { ...body, metricsPath: '/../api/metrics' }))).toBe(400);
    const hub = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'insights-hub').id;
    expect(await status(s.api('PUT', `/gatus/sources/${hub}`, body))).toBe(400);
  });

  it('scrapes, stores endpoint states, uptime and certificate expiry; audited', async () => {
    await mock('/metrics/reset');
    const saved = await s.api('PUT', `/gatus/sources/${gatusId}`, { enabled: true, intervalSeconds: 60, retentionDays: 90, rawRetentionDays: 14, metricsPath: '/metrics', fetchUptimes: true });
    expect(saved.source).toMatchObject({ platformId: gatusId, enabled: true, owner: 'admin', metricsPath: '/metrics' });
    const audit = await s.api('GET', '/audit?action=gatus.metrics_enabled');
    expect(audit.some((a: any) => a.entityId === gatusId)).toBe(true);
    const r1 = await s.api('POST', `/gatus/sources/${gatusId}/scrape`);
    expect(r1).toMatchObject({ ok: true, endpoints: 4 });
    const r2 = await olivia('POST', `/gatus/sources/${gatusId}/scrape`); // users of the platform may scrape now
    expect(r2.ok).toBe(true);
    const eps = await s.api('GET', `/gatus/sources/${gatusId}/endpoints`);
    const mes = eps.find((e: any) => e.key === 'plant_mes-frontend');
    expect(mes).toMatchObject({ group: 'plant', name: 'MES frontend', type: 'HTTP', success: true, durationMs: 310 });
    expect(Date.parse(mes.certificateExpiresAt) - Date.now()).toBeGreaterThan(19 * 86400000);
    expect(mes.uptime.h1).toBe(100); // one new successful result between the two scrapes
    const hist = eps.find((e: any) => e.key === 'plant_historian-api');
    expect(hist).toMatchObject({ success: false });
    expect(hist.uptime.h1).toBe(0);
    // the uptime API of Gatus (text/plain fractions) was read as well
    expect(mes.gatusUptime).toMatchObject({ h24: 95.83, d30: 98.02 });
    expect(await status(vera('GET', `/gatus/sources/${gatusId}/endpoints`))).toBe(404);
  });

  it('a monitor Gatus check reads the scraped state in metrics mode', async () => {
    const eng = await import('../src/monitors/engine.js');
    const created = await s.api('POST', '/monitors', {
      definition: {
        name: 'Gatus via metrics',
        failuresBeforeDown: 1,
        checks: [
          { id: 'mes', name: 'MES', type: 'gatus', platform: gatusId, endpointKey: 'plant_mes-frontend', source: 'metrics' },
          { id: 'hist', name: 'Historian', type: 'gatus', platform: gatusId, endpointKey: 'plant_historian-api' },
          { id: 'none', name: 'Unknown key', type: 'gatus', platform: gatusId, endpointKey: 'nope_nope', source: 'metrics' },
        ],
      },
    });
    const id = created.monitor.id;
    await eng.evaluateMonitorNow(id);
    const m = await s.api('GET', `/monitors/${id}`);
    const by = Object.fromEntries(m.checks.map((c: any) => [c.checkId, c]));
    expect(by.mes.status).toBe('up');
    expect(by.mes.last.message).toContain('(metrics)');
    expect(by.hist.status).toBe('down'); // auto: metrics mode is on for the platform
    expect(by.hist.last.message).toContain('failing (metrics)');
    expect(by.none.status).toBe('unknown');
    await s.api('DELETE', `/monitors/${id}`);
  });

  it('counts a Gatus restart as a counter reset', async () => {
    await mock('/metrics/restart');
    const r = await s.api('POST', `/gatus/sources/${gatusId}/scrape`);
    expect(r.resets).toBe(4);
    const { db } = await import('../src/db.js');
    const sample = db().get<{ ok: number; reset: number }>("SELECT ok, reset FROM gatus_samples WHERE platform_id = ? AND key = 'plant_mes-frontend' ORDER BY id DESC LIMIT 1", gatusId)!;
    expect([sample.ok, sample.reset]).toEqual([1, 1]);
  });

  it('bounded downloads: a body larger than the limit fails instead of filling memory', async () => {
    const { platformRequest } = await import('../src/platforms/http.js');
    const { getPlatform, getSecrets } = await import('../src/platforms/service.js');
    const { runAs } = await import('../src/auth/context.js');
    const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
    const admin = toAuthUser(findUserByName('admin')!);
    const p = runAs(admin, () => getPlatform(gatusId));
    await expect(platformRequest(p, getSecrets(gatusId), { method: 'GET', url: '/metrics', maxResponseBytes: 200, rawText: true })).rejects.toThrow(/larger than 200 bytes/);
  });

  it('reports errors of the scrape on the source (wrong path), and the outbound policy applies', async () => {
    await s.api('PUT', `/gatus/sources/${gatusId}`, { enabled: true, metricsPath: '/not-metrics' });
    const r = await s.api('POST', `/gatus/sources/${gatusId}/scrape`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/HTTP 404/);
    expect((await s.api('GET', `/gatus/sources/${gatusId}`)).source.lastError).toMatch(/HTTP 404/);
    // allow-list policy without an entry for the platform: blocked before anything is sent
    const before = await s.api('GET', '/settings');
    await s.api('PUT', '/settings', { outboundPolicy: 'allowList', outboundAllowList: [] });
    await s.api('PUT', `/gatus/sources/${gatusId}`, { enabled: true, metricsPath: '/metrics' });
    const blocked = await s.api('POST', `/gatus/sources/${gatusId}/scrape`);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/outbound policy/);
    await s.api('PUT', '/settings', { outboundPolicy: before.outboundPolicy, outboundAllowList: before.outboundAllowList });
    expect((await s.api('POST', `/gatus/sources/${gatusId}/scrape`)).ok).toBe(true);
  });

  it('the scraper tick only picks due, enabled sources while the vault is unlocked', () => {
    const due = gm.tickScraper(Date.now() + 10 * 60000);
    expect(due).toContain(gatusId);
  });

  it('retention: raw samples after rawRetentionDays, hourly data and status changes after retentionDays', async () => {
    const { db } = await import('../src/db.js');
    const old = new Date(Date.now() - 20 * 86400000).toISOString();
    const older = new Date(Date.now() - 100 * 86400000).toISOString();
    db().run("INSERT INTO gatus_samples (platform_id, key, ts, ok, fail) VALUES (?, 'plant_mes-frontend', ?, 1, 0)", gatusId, old);
    db().run("INSERT INTO gatus_hourly (platform_id, key, bucket, ok, fail) VALUES (?, 'plant_mes-frontend', ?, 1, 0)", gatusId, old);
    db().run("INSERT INTO gatus_hourly (platform_id, key, bucket, ok, fail) VALUES (?, 'plant_mes-frontend', ?, 1, 0)", gatusId, older);
    db().run("INSERT INTO gatus_transitions (platform_id, key, ts, success) VALUES (?, 'plant_mes-frontend', ?, 0)", gatusId, older);
    db().run("INSERT INTO gatus_transitions (platform_id, key, ts, success) VALUES (?, 'plant_mes-frontend', ?, 1)", gatusId, new Date().toISOString());
    db().run("INSERT INTO gatus_transitions (platform_id, key, ts, success) VALUES (?, 'zz_only-old', ?, 1)", gatusId, older);
    const r = gm.pruneGatusData();
    expect(r.samples).toBeGreaterThanOrEqual(1);
    expect(r.hourly).toBeGreaterThanOrEqual(1);
    expect(db().get('SELECT 1 FROM gatus_samples WHERE platform_id = ? AND ts = ?', gatusId, old)).toBeUndefined();
    expect(db().get('SELECT 1 FROM gatus_hourly WHERE platform_id = ? AND bucket = ?', gatusId, old)).toBeTruthy(); // within 90 days
    expect(db().get('SELECT 1 FROM gatus_hourly WHERE platform_id = ? AND bucket = ?', gatusId, older)).toBeUndefined();
    expect(db().get("SELECT 1 FROM gatus_transitions WHERE platform_id = ? AND key = 'plant_mes-frontend' AND ts = ?", gatusId, older)).toBeUndefined();
    // the newest status change of an endpoint is kept, however old
    expect(db().get("SELECT 1 FROM gatus_transitions WHERE platform_id = ? AND key = 'zz_only-old'", gatusId)).toBeTruthy();
  });
});
