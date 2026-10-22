import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

// the engine is driven by the tests (tick/evaluate), not by its own timer
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let dana: Client, olivia: Client, vera: Client;
let eng: typeof import('../src/monitors/engine.js');
let P: Record<string, string>;
const PW = 'Demo-password-1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const status = (p: Promise<unknown>) => p.then(() => 200, (e: { status: number }) => e.status);

async function hook(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${s.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}
const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

/** A TCP port nobody listens on (connection refused). */
async function closedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return port;
}

const check = (m: any, id: string) => m.checks.find((c: any) => c.checkId === id);
async function evaluate(id: string) {
  await eng.evaluateMonitorNow(id);
  return s.api('GET', `/monitors/${id}`);
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  P = Object.fromEntries((await s.api('GET', '/platforms')).map((p: any) => [p.name, p.id]));
  [dana, olivia, vera] = await Promise.all(['dana', 'olivia', 'vera'].map((u) => s.as(u, PW)));
  eng = await import('../src/monitors/engine.js');
});
afterAll(async () => {
  eng?.setMonitorClock(null);
  await s?.app.close();
});

// ---------------------------------------------------------------------------

describe('monitor logic', () => {
  it('flapping control: N failures before down, M successes before up', async () => {
    const { applyResult } = await import('../src/monitors/logic.js');
    const t = { failuresBeforeDown: 2, successesBeforeUp: 2 };
    let c = { status: 'up' as any, consecutiveFailures: 0, consecutiveSuccesses: 0 };
    c = applyResult(c, 'down', t);
    expect(c.status).toBe('up');
    c = applyResult(c, 'down', t);
    expect(c.status).toBe('down');
    c = applyResult(c, 'unknown', t);
    expect(c.status).toBe('down'); // a checker error does not end a confirmed outage
    c = applyResult(c, 'up', t);
    expect(c.status).toBe('down');
    c = applyResult(c, 'degraded', t);
    expect(c.status).toBe('degraded');
    c = applyResult(c, 'up', t);
    expect(c.status).toBe('up');
    expect(applyResult(c, 'blocked', t).status).toBe('blocked');
  });

  it('freshness: cadence (missed intervals) and maxAge', async () => {
    const { freshnessStatus } = await import('../src/monitors/logic.js');
    const now = Date.now();
    const cad = { mode: 'cadence' as const, expectedIntervalSeconds: 60, degradedAfterMissed: 2, downAfterMissed: 4 };
    expect(freshnessStatus(now - 30000, now, cad).status).toBe('up');
    expect(freshnessStatus(now - 130000, now, cad).status).toBe('degraded');
    expect(freshnessStatus(now - 250000, now, cad).status).toBe('down');
    expect(freshnessStatus(null, now, cad).status).toBe('down');
    const age = { mode: 'maxAge' as const, maxAgeSeconds: 600, degradedAgeSeconds: 300 };
    expect(freshnessStatus(now - 200000, now, age).status).toBe('up');
    expect(freshnessStatus(now - 400000, now, age).status).toBe('degraded');
    expect(freshnessStatus(now - 700000, now, age).message).toMatch(/Newest data is 12 min old \(maximum 10 min\)/);
  });

  it('root causes: soft links attribute, healthy children stay healthy, sub-monitor roots expand', async () => {
    const { analyze } = await import('../src/monitors/logic.js');
    const { monitorDefinitionSchema } = await import('@sm/shared');
    const def = monitorDefinitionSchema.parse({
      name: 'M',
      checks: [
        { id: 'pm', name: 'PowerMeter', type: 'tcp', host: 'x', port: 1 },
        { id: 'pmData', name: 'PM data', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 60 },
        { id: 'ih', name: 'IH', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 60 },
        { id: 'sub', name: 'Machine', type: 'monitor', monitor: 'mon_x' },
      ],
      links: [
        { from: 'pm', to: 'pmData' },
        { from: 'pmData', to: 'ih' },
        { from: 'pm', to: 'sub' },
      ],
    });
    const m = { id: 'mon_a', key: 'a', name: 'A', def };
    const st = (o: Record<string, string>) => new Map(Object.entries(o)) as any;
    // PowerMeter check broken, everything else works: the children stay healthy, the parent gets a note
    let a = analyze(m, st({ pm: 'down', pmData: 'up', ih: 'up', sub: 'up' }));
    expect(a.checks.get('pmData')!.causedBy).toEqual([]);
    expect(a.checks.get('pm')!.note).toMatch(/all 2 dependent checks are healthy/);
    expect(a.rootCauses.map((r) => r.checkId)).toEqual(['pm']);
    // the chain fails: the deepest checks are attributed to the topmost failing ancestor
    a = analyze(m, st({ pm: 'up', pmData: 'down', ih: 'down', sub: 'up' }));
    expect(a.checks.get('ih')!.causedBy.map((c) => c.checkId)).toEqual(['pmData']);
    expect(a.rootCauses.map((r) => r.checkId)).toEqual(['pmData']);
    expect(a.status).toBe('down');
    // a failing sub-monitor node is expanded to that monitor's own root cause
    const roots = [{ monitorId: 'mon_x', monitorKey: 'x', monitorName: 'X', checkId: 'hb', checkName: 'Heartbeat' }];
    a = analyze(m, st({ pm: 'up', pmData: 'up', ih: 'up', sub: 'down' }), { subRoots: () => roots });
    expect(a.rootCauses).toEqual(roots);
    // a parent whose latest result failed (not confirmed yet) already explains its children
    a = analyze(m, st({ pm: 'up', pmData: 'unknown', ih: 'down', sub: 'up' }), { pendingDown: new Set(['pmData']) });
    expect(a.checks.get('ih')!.causedBy.map((c) => c.checkId)).toEqual(['pmData']);
    expect(a.rootCauses.map((r) => r.checkId)).toEqual(['pmData']);
    // maintenance overrides the aggregated status
    expect(analyze(m, st({ pm: 'down' }), { maintenance: true }).status).toBe('maintenance');
  });

  it('aggregation rules: worst, critical, quorum', async () => {
    const { analyze } = await import('../src/monitors/logic.js');
    const { monitorDefinitionSchema } = await import('@sm/shared');
    const checks = ['a', 'b', 'c'].map((id) => ({ id, name: id, type: 'tcp', host: 'x', port: 1, critical: id !== 'c' }));
    const mk = (aggregate: any) => ({ id: 'm', key: 'm', name: 'm', def: monitorDefinitionSchema.parse({ name: 'm', checks, aggregate }) });
    const st = new Map(Object.entries({ a: 'up', b: 'up', c: 'down' })) as any;
    expect(analyze(mk({ rule: 'worst' }), st).status).toBe('down');
    expect(analyze(mk({ rule: 'critical' }), st).status).toBe('degraded');
    const st2 = new Map(Object.entries({ a: 'up', b: 'down', c: 'up' })) as any;
    expect(analyze(mk({ rule: 'quorum', quorum: 1 }), st2).status).toBe('degraded');
    expect(analyze(mk({ rule: 'quorum', quorum: 2 }), st2).status).toBe('down');
  });

  it('rejects link cycles and invalid definitions', async () => {
    const r = await status(
      dana('POST', '/monitors', {
        definition: {
          name: 'Cycle',
          checks: [
            { id: 'a', name: 'A', type: 'tcp', host: 'x', port: 1 },
            { id: 'b', name: 'B', type: 'tcp', host: 'x', port: 1 },
          ],
          links: [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'a' },
          ],
        },
      }),
    );
    expect(r).toBe(400);
    await expect(dana('POST', '/monitors', { definition: { name: 'Bad host', checks: [{ id: 'a', name: 'A', type: 'ping', host: '-c 5 x' }] } })).rejects.toThrow(/host/);
    await expect(dana('POST', '/monitors', { definition: { name: 'Bad expr', checks: [{ id: 'a', name: 'A', type: 'http', url: 'http://x', condition: 'body.(' }] } })).rejects.toThrow(/invalid expression/);
  });
});

// ---------------------------------------------------------------------------

describe('check types', () => {
  it('tcp, ping (TCP fallback), http and platform checks', async () => {
    const closed = await closedPort();
    const port = new URL(s.base).port;
    const { monitor } = await dana('POST', '/monitors', {
      definition: {
        name: 'Check types',
        failuresBeforeDown: 1,
        checks: [
          { id: 'tcpUp', name: 'TCP up', type: 'tcp', host: '127.0.0.1', port: Number(port) },
          { id: 'tcpDown', name: 'TCP down', type: 'tcp', host: '127.0.0.1', port: closed, timeoutSeconds: 2 },
          // no ping binary or no ICMP in the sandbox: a refused TCP connection still proves the host answers
          { id: 'ping', name: 'Ping', type: 'ping', host: '127.0.0.1', fallbackPort: closed },
          { id: 'http', name: 'HTTP', type: 'http', url: `${s.base}/api/health`, expectStatus: '200', condition: 'body.ok = true' },
          { id: 'httpSlow', name: 'HTTP slow', type: 'http', url: `${s.base}/mock/test/delay?ms=300`, degradedResponseMs: 100 },
          { id: 'httpCond', name: 'HTTP condition', type: 'http', url: `${s.base}/api/health`, condition: 'body.ok = false' },
          { id: 'http404', name: 'HTTP 404', type: 'http', url: `${s.base}/api/nope`, expectStatus: '200-299' },
          { id: 'platform', name: 'IH users', type: 'platform', platform: 'Insights Hub (demo)', path: '/api/identitymanagement/v3/Users', query: { count: '1' }, condition: 'body.totalResults > 0' },
          { id: 'platformBad', name: 'IH missing', type: 'platform', platform: P['Insights Hub (demo)'], path: '/api/nothing-here' },
        ],
      },
    });
    const m = await evaluate(monitor.id);
    const st = (id: string) => check(m, id).status;
    expect(st('tcpUp')).toBe('up');
    expect(st('tcpDown')).toBe('down');
    expect(check(m, 'tcpDown').last.message).toMatch(/connection refused/);
    expect(st('ping')).toBe('up');
    expect(check(m, 'ping').last.message).toMatch(/127\.0\.0\.1 (answers ping|answers \(TCP fallback)/);
    expect(st('http')).toBe('up');
    expect(st('httpSlow')).toBe('degraded');
    expect(st('httpCond')).toBe('down');
    expect(st('http404')).toBe('down');
    expect(st('platform')).toBe('up');
    expect(st('platformBad')).toBe('down');
    expect(m.status).toBe('down');
    // platforms are stored by id
    expect(m.definition.checks.find((c: any) => c.id === 'platform').platform).toBe(P['Insights Hub (demo)']);
  });

  it('Insights Hub freshness (cadence and maxAge) shares one API call per asset/aspect', async () => {
    const { DEMO_IOT_ASSETS } = await import('../src/mock/mockIot.js');
    const { clearBatchCaches } = await import('../src/monitors/batch.js');
    await fetch(`${s.base}/mock/ih/test/timeseries/reset`, { method: 'POST' });
    clearBatchCaches();
    const m17 = DEMO_IOT_ASSETS.machine17;
    const fresh = (id: string, vars: string[], extra: Record<string, unknown>) => ({
      id,
      name: id,
      type: 'freshness',
      platform: 'Insights Hub (demo)',
      assetId: m17.assetId,
      aspect: m17.aspect,
      variables: vars,
      ...extra,
    });
    const { monitor } = await dana('POST', '/monitors', {
      definition: {
        name: 'IH freshness',
        failuresBeforeDown: 1,
        checks: [
          fresh('speed', ['spindleSpeed'], { mode: 'maxAge', maxAgeSeconds: 900 }),
          fresh('state', ['state'], { mode: 'cadence', expectedIntervalSeconds: 600, degradedAfterMissed: 1, downAfterMissed: 3 }),
          // toolWear stopped 3 hours ago
          fresh('wear', ['toolWear'], { mode: 'maxAge', maxAgeSeconds: 3600 }),
          fresh('both', ['spindleSpeed', 'toolWear'], { mode: 'maxAge', maxAgeSeconds: 3600 }),
        ],
      },
    });
    const before = (await (await fetch(`${s.base}/mock/ih/test/timeseries/calls`)).json()).calls[`${m17.assetId}/${m17.aspect}`] ?? 0;
    const m = await evaluate(monitor.id);
    expect(check(m, 'speed').status).toBe('up');
    expect(check(m, 'state').status).toBe('up');
    expect(check(m, 'wear').status).toBe('down');
    expect(check(m, 'wear').last.message).toMatch(/No value of toolWear within|toolWear is 3\.0 h old/);
    expect(check(m, 'both').status).toBe('down');
    expect(check(m, 'both').last.message).toMatch(/toolWear/);
    const after = (await (await fetch(`${s.base}/mock/ih/test/timeseries/calls`)).json()).calls[`${m17.assetId}/${m17.aspect}`];
    // 4 checks, one shared read: latestRecord + one look-back for the variables not in the newest record
    expect(after - before).toBeLessThanOrEqual(2);
    expect(after - before).toBeGreaterThanOrEqual(1);
  });

  it('Gatus endpoint status', async () => {
    const { monitor } = await dana('POST', '/monitors', {
      definition: {
        name: 'Gatus checks',
        failuresBeforeDown: 1,
        checks: [
          { id: 'mes', name: 'MES', type: 'gatus', platform: 'Gatus (demo)', endpointKey: 'plant_mes-frontend', degradedOnRecentFailures: 30 },
          { id: 'hist', name: 'Historian', type: 'gatus', platform: 'Gatus (demo)', endpointKey: 'plant_historian-api' },
          { id: 'opc', name: 'OPC UA', type: 'gatus', platform: 'Gatus (demo)', endpointKey: 'edge_opc-ua-gateway' },
          { id: 'none', name: 'Unknown', type: 'gatus', platform: 'Gatus (demo)', endpointKey: 'nope_nope' },
        ],
      },
    });
    const m = await evaluate(monitor.id);
    expect(check(m, 'mes').status).toBe('degraded');
    expect(check(m, 'hist').status).toBe('down');
    expect(check(m, 'hist').last.message).toMatch(/STATUS/);
    expect(check(m, 'opc').status).toBe('up');
    expect(check(m, 'none').status).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------

describe('permissions', () => {
  it('designers and administrators have the createMonitors capability', async () => {
    const caps = async (c: Client) => ((await c('GET', '/auth/status')) as { me: { capabilities: Record<string, boolean> } }).me.capabilities.createMonitors;
    expect(await caps(dana)).toBe(true);
    expect(await caps(olivia)).toBe(false);
    expect(((await s.api('GET', '/auth/status')) as { me: { capabilities: Record<string, boolean> } }).me.capabilities.createMonitors).toBe(true);
    expect(((await olivia('GET', '/monitors/meta')) as { canCreate: boolean }).canCreate).toBe(false);
  });
});

describe('heartbeats', () => {
  let mon: any;
  let secret: string;
  let path: string;
  let hmacSecret: string;
  let hmacPath: string;

  it('creates heartbeat endpoints and shows each secret once', async () => {
    const r = await dana('POST', '/monitors', {
      definition: {
        name: 'Gateway pushes',
        failuresBeforeDown: 1,
        checks: [
          { id: 'pm', name: 'PowerMeter data', type: 'heartbeat', key: 'test.pm', mode: 'cadence', expectedIntervalSeconds: 60, condition: 'value > 0' },
          { id: 'machine', name: 'Machine data', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600, authMode: 'hmac', rateLimitPerMinute: 3 },
        ],
      },
    });
    mon = r.monitor;
    expect(r.secrets).toHaveLength(2);
    ({ secret, path } = r.secrets.find((x: any) => x.checkId === 'pm'));
    ({ secret: hmacSecret, path: hmacPath } = r.secrets.find((x: any) => x.checkId === 'machine'));
    expect(path).toMatch(/^\/api\/hooks\/monitor\/hb_/);
    expect(secret).toMatch(/^mhs_/);
    const detail = await dana('GET', `/monitors/${mon.id}`);
    expect(JSON.stringify(detail)).not.toContain(secret);
    expect(check(detail, 'pm').heartbeat.secretPrefix).toBe(secret.slice(0, 8));
    expect(check(detail, 'machine').key).toBe(`${mon.key}.machine`);
    // waiting for the first report
    const m = await evaluate(mon.id);
    expect(check(m, 'pm').status).toBe('unknown');
  });

  it('accepts a report with the token and turns the check up; the condition is applied', async () => {
    const ok = await hook(path, { value: 42.5, ts: new Date().toISOString(), data: { unit: 'kW' } }, bearer(secret));
    expect(ok.status).toBe(202);
    expect(ok.body).toMatchObject({ accepted: true, status: 'up' });
    const bad = await hook(path, { value: 0 }, { 'x-steward-token': secret });
    expect(bad.status).toBe(202);
    expect(bad.body.status).toBe('down');
    const m = await s.api('GET', `/monitors/${mon.id}`);
    expect(check(m, 'pm').last.message).toMatch(/condition is false/);
    expect(check(m, 'pm').heartbeat.lastPush).toMatchObject({ value: 0 });
    await hook(path, { value: 10, status: 'ok' }, bearer(secret));
  });

  it('rejects wrong secrets, bad content, oversized bodies and floods; unknown hooks are 404', async () => {
    expect((await hook(path, { value: 1 }, bearer('mhs_wrong'))).status).toBe(401);
    expect((await hook(path, { value: 1 })).status).toBe(401);
    expect((await hook('/api/hooks/monitor/hb_doesnotexist', { value: 1 }, bearer(secret))).status).toBe(404);
    expect((await hook(path, 'value=1', { ...bearer(secret), 'content-type': 'text/plain' })).status).toBe(415);
    expect((await hook(path, '{"value":', bearer(secret))).status).toBe(400);
    expect((await hook(path, { ts: 'yesterday-ish' }, bearer(secret))).status).toBe(400);
    expect((await hook(path, { value: 'x'.repeat(70 * 1024) }, bearer(secret))).status).toBe(413);
    // HMAC mode: the token alone is not accepted
    const raw = JSON.stringify({ status: 'up', value: 1450 });
    expect((await hook(hmacPath, raw, bearer(hmacSecret))).status).toBe(401);
    const sig = 'sha256=' + crypto.createHmac('sha256', hmacSecret).update(raw).digest('hex');
    expect((await hook(hmacPath, raw, { 'x-steward-signature': sig })).status).toBe(202);
    // rate limit 3/min (one accepted above)
    expect((await hook(hmacPath, raw, { 'x-steward-signature': sig })).status).toBe(202);
    expect((await hook(hmacPath, raw, { 'x-steward-signature': sig })).status).toBe(202);
    const limited = await hook(hmacPath, raw, { 'x-steward-signature': sig });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // rejections are audited (at most once per reason and 10 minutes)
    const audit = await s.api('GET', `/audit?action=monitor.report_rejected&limit=50`);
    expect(audit.some((a: any) => a.entityId === mon.id && /wrong secret/.test(a.summary))).toBe(true);
  });

  it('a missing report turns the check down by the timer alone (no request needed)', async () => {
    const start = Date.now();
    try {
      eng.setMonitorClock(() => start + 5 * 60000); // 5 missed intervals
      eng.resetEngineSchedule();
      expect(eng.tick()).toBeGreaterThan(0);
      await eng.settle();
      const m = await s.api('GET', `/monitors/${mon.id}`);
      expect(check(m, 'pm').status).toBe('down');
      expect(check(m, 'pm').last.message).toMatch(/intervals missed/);
      expect(check(m, 'machine').status).toBe('up'); // maxAge 10 min
    } finally {
      eng.setMonitorClock(null);
      eng.resetEngineSchedule();
    }
    expect((await hook(path, { value: 3 }, bearer(secret))).body.status).toBe('up');
  });

  it('rotating the secret invalidates the old one (audited)', async () => {
    const r = await dana('POST', `/monitors/${mon.id}/checks/pm/rotate`);
    expect(r.secret).not.toBe(secret);
    expect((await hook(path, { value: 1 }, bearer(secret))).status).toBe(401);
    expect((await hook(path, { value: 1 }, bearer(r.secret))).status).toBe(202);
    secret = r.secret;
    const audit = await s.api('GET', `/audit?action=monitor.secret_rotated`);
    expect(audit[0].summary).toMatch(/rotated/);
    expect(JSON.stringify(audit[0])).not.toContain(r.secret);
  });

  it('gateway batch: one call reports many checks by key', async () => {
    const g = await dana('POST', '/monitor-gateways', { name: 'Test gateway', allowedKeys: ['test.*', `${mon.key}.*`] });
    expect(g.secret).toMatch(/^mgw_/);
    const r = await hook(
      '/api/hooks/monitors',
      {
        reports: [
          { key: 'test.pm', value: 50, ts: new Date().toISOString() },
          { key: `${mon.key}.machine`, value: 1400, status: 'warning' },
          { key: 'test.unknown', value: 1 },
          { key: 'other.key', value: 1 },
          { value: 1 },
        ],
      },
      bearer(g.secret),
    );
    expect(r.status).toBe(202);
    expect(r.body.accepted).toBe(2);
    expect(r.body.rejected.map((x: any) => x.reason).sort()).toEqual(['"key" is required', 'key not allowed for this gateway', 'unknown key']);
    const m = await s.api('GET', `/monitors/${mon.id}`);
    expect(check(m, 'machine').status).toBe('degraded'); // status from the report
    expect((await hook('/api/hooks/monitors', { reports: [] }, bearer('mgw_wrong'))).status).toBe(401);
    // a bare array works too
    expect((await hook('/api/hooks/monitors', [{ key: 'test.pm', value: 9 }], bearer(g.secret))).body.accepted).toBe(1);
    const list = await dana('GET', '/monitor-gateways');
    expect(list.find((x: any) => x.id === g.gateway.id).secretPrefix).toBe(g.secret.slice(0, 8));
    expect(JSON.stringify(list)).not.toContain(g.secret);
    // CIDR allow-list: 404 from other addresses
    await dana('PUT', `/monitor-gateways/${g.gateway.id}`, { name: 'Test gateway', allowedKeys: ['test.*'], allowedCidrs: ['10.0.0.0/8'] });
    expect((await hook('/api/hooks/monitors', [{ key: 'test.pm', value: 9 }], bearer(g.secret))).status).toBe(404);
  });

  it('heartbeat keys are unique across monitors', async () => {
    await expect(
      dana('POST', '/monitors', { definition: { name: 'Dup', checks: [{ id: 'x', name: 'X', type: 'heartbeat', key: 'test.pm', mode: 'maxAge', maxAgeSeconds: 60 }] } }),
    ).rejects.toThrow(/already used/);
  });
});

// ---------------------------------------------------------------------------

describe('dependencies', () => {
  let mon: any;
  let secret: string;
  let path: string;
  let pmPort: number;
  let pmServer: net.Server;

  beforeAll(async () => {
    pmServer = net.createServer((sock) => sock.end());
    await new Promise<void>((r) => pmServer.listen(0, '127.0.0.1', r));
    pmPort = (pmServer.address() as net.AddressInfo).port;
  });
  afterAll(() => pmServer.close());

  it('soft link: the machine stays up while the PowerMeter check fails', async () => {
    const r = await dana('POST', '/monitors', {
      definition: {
        name: 'Machine 99 – PowerMeter',
        failuresBeforeDown: 1,
        checks: [
          { id: 'pm', name: 'PowerMeter reachable', type: 'tcp', host: '127.0.0.1', port: pmPort },
          { id: 'data', name: 'Machine data', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600 },
          { id: 'ih', name: 'Data in IH', type: 'heartbeat', key: 'test.m99.ih', mode: 'maxAge', maxAgeSeconds: 600 },
        ],
        links: [
          { from: 'pm', to: 'data' },
          { from: 'data', to: 'ih', mode: 'hard' },
        ],
        outputs: [{ id: 'notify', type: 'notification', subscribers: ['user:olivia'] }],
      },
    });
    mon = r.monitor;
    ({ secret, path } = r.secrets.find((x: any) => x.checkId === 'data'));
    const ih = r.secrets.find((x: any) => x.checkId === 'ih');
    await hook(path, { value: 1 }, bearer(secret));
    await hook(ih.path, { value: 1 }, bearer(ih.secret));
    let m = await evaluate(mon.id);
    expect(m.status).toBe('up');
    // the PowerMeter "goes away" (or its check breaks) – machine data still arrives
    await new Promise((res) => pmServer.close(res));
    m = await evaluate(mon.id);
    expect(check(m, 'pm').status).toBe('down');
    expect(check(m, 'data').status).toBe('up');
    expect(check(m, 'data').causedBy).toEqual([]);
    expect(check(m, 'pm').note).toMatch(/dependent check is healthy/);
    expect(m.rootCauses.map((c: any) => c.checkId)).toEqual(['pm']);
  });

  it('both fail: the child is attributed to the parent, hard links block, one alert for the root', async () => {
    const t0 = Date.now();
    try {
      eng.setMonitorClock(() => t0 + 20 * 60000);
      await eng.evaluateMonitorNow(mon.id);
      await eng.evaluateMonitorNow(mon.id); // the blocked check follows its parent
    } finally {
      eng.setMonitorClock(null);
    }
    const m = await s.api('GET', `/monitors/${mon.id}`);
    expect(check(m, 'data').status).toBe('down');
    expect(check(m, 'data').causedBy.map((c: any) => c.checkId)).toEqual(['pm']);
    expect(check(m, 'ih').status).toBe('blocked');
    expect(check(m, 'ih').last.message).toMatch(/hard dependency "Machine data" is down/);
    expect(check(m, 'ih').causedBy.map((c: any) => c.checkId)).toEqual(['pm']);
    expect(m.rootCauses.map((c: any) => c.checkId)).toEqual(['pm']);
    const hist = await s.api('GET', `/monitors/${mon.id}/history?check=data`);
    expect(hist[0].causedBy.map((c: any) => c.checkId)).toEqual(['pm']);
    // notifications: the monitor went down once (root cause named), recipients are owner + subscribers
    const n = (await olivia('GET', '/notifications?limit=100')).items.filter((x: any) => x.event === 'monitor.status' && x.link.startsWith(`/monitors/${mon.id}`));
    expect(n.map((x: any) => `${x.title} | ${x.body}`)).toHaveLength(1);
    expect(n[0].title).toBe('Down: Machine 99 – PowerMeter');
    expect(n[0].body).toMatch(/^Root cause: PowerMeter reachable\. /);
    expect((await dana('GET', '/notifications?limit=100')).items.filter((x: any) => x.event === 'monitor.status' && x.link.startsWith(`/monitors/${mon.id}`))).toHaveLength(1);
    // evaluating again does not notify again
    await eng.evaluateMonitorNow(mon.id);
    expect((await olivia('GET', '/notifications?limit=100')).items.filter((x: any) => x.event === 'monitor.status' && x.link.startsWith(`/monitors/${mon.id}`))).toHaveLength(1);
  });

  it('maintenance silences alerts; acknowledging needs the acknowledge right', async () => {
    expect(await status(vera('POST', `/monitors/${mon.id}/acknowledge`, { comment: 'seen' }))).toBe(403);
    const ack = await olivia('POST', `/monitors/${mon.id}/acknowledge`, { comment: 'Electrician on site' });
    expect(ack.acknowledged).toMatchObject({ by: 'olivia', comment: 'Electrician on site' });
    const w = await olivia('POST', `/monitors/${mon.id}/maintenance`, { endsAt: new Date(Date.now() + 3600000).toISOString(), reason: 'PowerMeter replacement' });
    expect(w.active).toBe(true);
    // recovery during maintenance: no "recovered" alert
    pmServer = net.createServer((sock) => sock.end());
    await new Promise<void>((r) => pmServer.listen(pmPort, '127.0.0.1', r));
    await hook(path, { value: 1 }, bearer(secret));
    const m = await evaluate(mon.id);
    expect(m.status).toBe('maintenance');
    expect(m.maintenance.reason).toBe('PowerMeter replacement');
    const n = (await olivia('GET', '/notifications?limit=100')).items.filter((x: any) => x.event === 'monitor.status' && x.link.startsWith(`/monitors/${mon.id}`));
    expect(n).toHaveLength(1);
    await olivia('DELETE', `/monitors/${mon.id}/maintenance/${w.id}`);
    const after = await evaluate(mon.id);
    expect(after.maintenance).toBeNull();
    const audit = await s.api('GET', `/audit?entityType=monitor&entityId=${mon.id}`);
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['monitor.created', 'monitor.acknowledged', 'monitor.maintenance_added', 'monitor.maintenance_ended']));
  });

  it('sub-monitors: referenced by key, evaluated on their own, cycles rejected', async () => {
    const machine = (await dana('POST', '/monitors', { key: 'test-machine-flow', definition: { name: 'Machine flow', failuresBeforeDown: 1, checks: [{ id: 'hb', name: 'Machine heartbeat', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 60 }] } }));
    const parent = (await dana('POST', '/monitors', { definition: { name: 'Machine with sub-monitor', checks: [{ id: 'flow', name: 'Machine flow', type: 'monitor', monitor: 'test-machine-flow' }] } })).monitor;
    expect(parent.definition.checks[0].monitor).toBe(machine.monitor.id);
    // no heartbeat for 2 minutes → the sub-monitor goes down and the parent follows with the sub-monitor's root cause
    const t0 = Date.now();
    try {
      eng.setMonitorClock(() => t0 + 2 * 60000);
      await eng.evaluateMonitorNow(machine.monitor.id);
      await eng.settle();
    } finally {
      eng.setMonitorClock(null);
    }
    const p = await s.api('GET', `/monitors/${parent.id}`);
    expect(check(p, 'flow').status).toBe('down');
    expect(p.rootCauses).toEqual([expect.objectContaining({ monitorId: machine.monitor.id, checkId: 'hb' })]);
    expect((await s.api('GET', `/monitors/${machine.monitor.id}`)).usedBy.map((u: any) => u.id)).toEqual([parent.id]);
    // a cycle is refused, and so is deleting a monitor that is in use
    const def = { ...machine.monitor.definition, checks: [...machine.monitor.definition.checks, { id: 'back', name: 'Back', type: 'monitor', monitor: parent.id }] };
    await expect(dana('PUT', `/monitors/${machine.monitor.id}`, { definition: def })).rejects.toThrow(/cycle/);
    expect(await status(olivia('DELETE', `/monitors/${machine.monitor.id}`))).toBe(403); // operators may not delete
    expect(await status(s.api('DELETE', `/monitors/${machine.monitor.id}`))).toBe(409);
  });
});

// ---------------------------------------------------------------------------

describe('outputs', () => {
  const received: { path: string; body: any }[] = [];
  let web: http.Server;
  let webUrl: string;
  let trapper: net.Server;
  let trapperPort: number;
  const trapped: any[] = [];
  let zbxRespond: (data: any[]) => any = (data) => ({ response: 'success', info: `processed: ${data.length}; failed: 0; total: ${data.length}; seconds spent: 0.000042` });

  beforeAll(async () => {
    web = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        received.push({ path: req.url ?? '', body: JSON.parse(b || 'null') });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
    webUrl = `http://127.0.0.1:${(web.address() as net.AddressInfo).port}/hook`;
    // a tiny Zabbix trapper: ZBXD\x01 + uint32le length + uint32le reserved + JSON, answered the same way
    const { decodePacket, encodePacket } = await import('../src/monitors/zabbix.js');
    trapper = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        const p = decodePacket(buf);
        if (!p) return;
        const req = p.json as { request: string; data: any[] };
        expect(req.request).toBe('sender data');
        trapped.push(...req.data);
        sock.end(encodePacket(zbxRespond(req.data)));
      });
    });
    await new Promise<void>((r) => trapper.listen(0, '127.0.0.1', r));
    trapperPort = (trapper.address() as net.AddressInfo).port;
  });
  afterAll(() => {
    web.close();
    trapper.close();
  });

  it('Zabbix sender protocol: header, little-endian length, processed/failed parsing', async () => {
    const { decodePacket, encodePacket, parseInfo, zabbixSend } = await import('../src/monitors/zabbix.js');
    const pkt = encodePacket({ request: 'sender data', data: [] });
    expect(pkt.subarray(0, 5)).toEqual(Buffer.from([0x5a, 0x42, 0x58, 0x44, 0x01])); // "ZBXD" 0x01
    expect(pkt.readUInt32LE(5)).toBe(pkt.length - 13);
    expect(decodePacket(pkt)!.json).toEqual({ request: 'sender data', data: [] });
    expect(decodePacket(pkt.subarray(0, 10))).toBeNull();
    expect(parseInfo('processed: 2; failed: 1; total: 3; seconds spent: 0.000055')).toEqual({ processed: 2, failed: 1, total: 3, secondsSpent: 0.000055 });
    const r = await zabbixSend('127.0.0.1', trapperPort, [{ host: 'h', key: 'k', value: '0', clock: 1700000000, ns: 5 }]);
    expect(r).toMatchObject({ response: 'success', processed: 1, failed: 0 });
    expect(trapped.at(-1)).toEqual({ host: 'h', key: 'k', value: '0', clock: 1700000000, ns: 5 });
  });

  it('sends status changes to a webhook, Gatus external endpoints and Zabbix (trapper and history.push)', async () => {
    const zbx = await s.api('POST', '/platforms', {
      name: 'Zabbix trapper (test)',
      kind: 'zabbix',
      baseUrl: 'http://127.0.0.1:1',
      config: { auth: { type: 'none' }, variables: { host: 'steward-test', trapperHost: '127.0.0.1', trapperPort: String(trapperPort) }, http: {} },
    });
    const r = await dana('POST', '/monitors', {
      key: 'outputs-test',
      definition: {
        name: 'Outputs test',
        failuresBeforeDown: 1,
        checks: [{ id: 'hb', name: 'Report', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600 }],
        outputs: [
          { id: 'web', type: 'webhook', url: webUrl },
          { id: 'gatus', type: 'gatus', platform: 'Gatus (demo)', endpointKey: 'steward_machine-monitors', include: 'monitor' },
          { id: 'trap', type: 'zabbix', platform: zbx.id, via: 'sender' },
          { id: 'api', type: 'zabbix', platform: 'Zabbix (demo)', via: 'api', value: 'text', include: 'checks' },
        ],
      },
    });
    const hb = r.secrets[0];
    expect((await hook(hb.path, { value: 1, status: 'down' }, bearer(hb.secret))).body.status).toBe('down');
    await eng.settle();
    // webhook: one POST per evaluation with the changed subjects
    const evs = received.flatMap((x) => x.body.events);
    expect(evs.find((e: any) => e.level === 'monitor' && e.status === 'down')).toMatchObject({ status: 'down', statusCode: 2, monitor: { key: 'outputs-test' } });
    expect(evs.find((e: any) => e.level === 'check' && e.status === 'down')).toMatchObject({ status: 'down', check: { id: 'hb', key: 'outputs-test.hb' } });
    // Zabbix trapper got monitor and check items with the default keys and numeric codes
    expect(trapped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ host: 'steward-test', key: 'steward.monitor.status[outputs-test]', value: '2' }),
        expect.objectContaining({ host: 'steward-test', key: 'steward.check.status[outputs-test,hb]', value: '2' }),
      ]),
    );
    // Zabbix API history.push (mock): only checks, as text
    const pushed = (await (await fetch(`${s.base}/mock/zabbix/received`)).json()).received;
    expect(pushed).toEqual(expect.arrayContaining([expect.objectContaining({ host: 'steward-demo', key: 'steward.check.status[outputs-test,hb]', value: 'down' })]));
    expect(pushed.some((p: any) => p.key === 'steward.monitor.status[outputs-test]')).toBe(false);
    // Gatus external endpoint got success=false
    const g = await s.api('POST', `/platforms/${P['Gatus (demo)']}/request`, { method: 'GET', path: '/api/v1/endpoints/steward_machine-monitors/statuses' });
    expect(g.body.results.at(-1)).toMatchObject({ success: false });
    // no change → nothing new is sent
    const n = received.length;
    const t = trapped.length;
    await eng.evaluateMonitorNow(r.monitor.id);
    expect(received.length).toBe(n);
    expect(trapped.length).toBe(t);
    // recovery is sent
    await hook(hb.path, { value: 1, status: 'up' }, bearer(hb.secret));
    await eng.settle();
    expect(received.at(-1)!.body.events.map((e: any) => e.status)).toContain('up');
    expect(trapped.at(-1).value).toBe('0');
  });

  it('a failing output is retried on a later evaluation; Zabbix "failed" counts are errors', async () => {
    zbxRespond = (data) => ({ response: 'success', info: `processed: 0; failed: ${data.length}; total: ${data.length}; seconds spent: 0.00001` });
    const m = await s.api('GET', '/monitors/outputs-test');
    const hb = m.checks[0];
    const secret = (await dana('POST', `/monitors/${m.id}/checks/hb/rotate`)).secret;
    await hook(hb.heartbeat.path, { status: 'down' }, bearer(secret));
    await eng.settle();
    const { db } = await import('../src/db.js');
    const st = db().get<{ last_error: string; last_status: string }>("SELECT last_error, last_status FROM monitor_output_state WHERE monitor_id = ? AND output_id = 'trap' AND subject = ''", m.id)!;
    expect(st.last_error).toMatch(/processed 0 of 2 values \(failed: 2\)/);
    expect(st.last_status).toBe('up'); // still the last delivered status → retried
    zbxRespond = (data) => ({ response: 'success', info: `processed: ${data.length}; failed: 0; total: ${data.length}; seconds spent: 0.00001` });
    const { resetOutputState } = await import('../src/monitors/outputs.js');
    resetOutputState();
    await eng.evaluateMonitorNow(m.id);
    expect(db().get<{ last_status: string }>("SELECT last_status FROM monitor_output_state WHERE monitor_id = ? AND output_id = 'trap' AND subject = ''", m.id)!.last_status).toBe('down');
    await hook(hb.heartbeat.path, { status: 'up' }, bearer(secret));
    await eng.settle();
  });

  it('starts a runbook with the monitor context as inputs (as the owner)', async () => {
    await s.api('POST', '/processes', {
      definition: { name: 'Monitor runbook', inputs: [{ name: 'monitor', type: 'string' }, { name: 'cause', type: 'string' }], steps: [{ id: 'log', type: 'log', message: 'down: {{ inputs.monitor }}' }] },
    });
    const r = await dana('POST', '/monitors', {
      definition: {
        name: 'Runbook test',
        failuresBeforeDown: 1,
        checks: [{ id: 'hb', name: 'Report', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600 }],
        outputs: [{ id: 'run', type: 'process', processId: 'monitor-runbook', inputs: { monitor: 'monitor.name', cause: 'event.rootCauses[0].checkName' } }],
      },
    });
    const hb = r.secrets[0];
    await hook(hb.path, { status: 'down' }, bearer(hb.secret));
    await eng.settle();
    const runs = await s.api('GET', '/runs?processId=monitor-runbook');
    expect(runs).toHaveLength(1);
    const run = await s.waitRun(runs[0].id);
    expect(run.inputs).toEqual({ monitor: 'Runbook test', cause: 'Report' });
    expect(run.actor).toBe('dana');
    expect(run).toMatchObject({ trigger: 'monitor', triggerName: 'Runbook test' });
    expect(run.triggerId).toMatch(/^mon_/);
    // recovering does not start another run (default statuses: down)
    await hook(hb.path, { status: 'up' }, bearer(hb.secret));
    await eng.settle();
    expect(await s.api('GET', '/runs?processId=monitor-runbook')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('pull integrations', () => {
  let token: string;
  const v1 = async (path: string, t = token) => {
    const res = await fetch(`${s.base}/api/v1${path}`, { headers: { authorization: `Bearer ${t}` } });
    return { status: res.status, body: await res.json() };
  };
  beforeAll(async () => {
    token = (await vera('POST', '/me/tokens', { name: 'zabbix', scope: 'read' })).token;
  });

  it('lists monitors and reports the status of a monitor with its checks', async () => {
    const list = await v1('/monitors?limit=200');
    expect(list.status).toBe(200);
    const m = list.body.items.find((x: any) => x.key === 'outputs-test');
    expect(m).toMatchObject({ status: 'up', statusCode: 0, enabled: true });
    const st = await v1('/monitors/outputs-test/status');
    expect(st.body.checks[0]).toMatchObject({ checkId: 'hb', key: 'outputs-test.hb', type: 'heartbeat', statusCode: 0 });
    expect(JSON.stringify(st.body)).not.toMatch(/mhs_|secret/);
    expect((await v1('/monitors/nope/status')).status).toBe(404);
    expect((await v1('/monitors', 'smt_invalid')).status).toBe(401);
    const hist = await v1(`/monitors/${m.id}/history?limit=2`);
    expect(hist.body.items).toHaveLength(2);
    expect(hist.body.nextCursor).toBeTruthy();
    const next = await v1(`/monitors/${m.id}/history?limit=2&cursor=${hist.body.nextCursor}`);
    expect(Number(next.body.items[0].id)).toBeLessThan(Number(hist.body.items[1].id));
  });

  it('Zabbix low-level discovery format', async () => {
    const d = await v1('/monitors/discovery');
    expect(Array.isArray(d.body.data)).toBe(true);
    expect(d.body.data).toEqual(expect.arrayContaining([{ '{#MONITOR}': 'outputs-test', '{#MONITORNAME}': 'Outputs test', '{#MONITORID}': expect.any(String), '{#CHECK}': 'hb', '{#CHECKNAME}': 'Report', '{#CHECKTYPE}': 'heartbeat', '{#CHECKKEY}': 'outputs-test.hb' }]));
    const ml = await v1('/monitors/discovery?level=monitors');
    expect(ml.body.data.find((x: any) => x['{#MONITOR}'] === 'outputs-test')).toEqual({ '{#MONITOR}': 'outputs-test', '{#MONITORNAME}': 'Outputs test', '{#MONITORID}': expect.any(String) });
  });

  it('the OpenAPI document describes the monitor endpoints', async () => {
    const doc = (await v1('/openapi.json')).body;
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/monitors', '/monitors/discovery', '/monitors/{monitorId}', '/monitors/{monitorId}/status', '/monitors/{monitorId}/history']));
    expect(doc.components.schemas.MonitorStatusReport).toBeTruthy();
  });

  it('Prometheus gauges', async () => {
    const text = await s.api('GET', '/metrics');
    expect(text).toMatch(/steward_monitor_status\{monitor="outputs-test",check=""\} 0/);
    expect(text).toMatch(/steward_monitor_status\{monitor="outputs-test",check="hb"\} 0/);
    expect(text).toMatch(/steward_monitor_last_ok_timestamp\{monitor="outputs-test",check="hb"\} \d{10}/);
    expect(text).toMatch(/steward_monitor_evaluations_total\{type="heartbeat",result="up"\} \d+/);
  });

  it('publishes datasets for dashboards', async () => {
    const { publishDirtyDatasets } = await import('../src/monitors/datasets.js');
    publishDirtyDatasets();
    const all = await s.api('GET', '/datasets');
    expect(all.map((d: any) => d.key)).toEqual(expect.arrayContaining(['monitors.status', 'monitor.outputs-test']));
    const ds = await s.api('GET', '/datasets/monitor.outputs-test');
    expect(ds.rows[0]).toMatchObject({ Check: 'Report', Status: 'up', _status: 'good' });
  });
});

// ---------------------------------------------------------------------------

describe('permissions, templates and lifecycle', () => {
  it('designers create and edit, operators view and acknowledge, viewers only view; access lists narrow it', async () => {
    expect(await status(olivia('POST', '/monitors', { definition: { name: 'Nope', checks: [] } }))).toBe(403);
    expect(await status(vera('POST', '/monitors', { definition: { name: 'Nope', checks: [] } }))).toBe(403);
    const { monitor } = await dana('POST', '/monitors', { definition: { name: 'Restricted', checks: [{ id: 't', name: 'T', type: 'tcp', host: '127.0.0.1', port: 1 }] } });
    expect(monitor.owner).toBe('dana');
    expect((await vera('GET', `/monitors/${monitor.id}`)).permissions).toEqual(['view']);
    expect((await olivia('GET', `/monitors/${monitor.id}`)).permissions).toEqual(['view', 'acknowledge']);
    expect(await status(vera('PUT', `/monitors/${monitor.id}`, { definition: monitor.definition }))).toBe(403);
    expect(await status(olivia('PUT', `/monitors/${monitor.id}`, { definition: monitor.definition }))).toBe(403);
    // optimistic locking
    expect(await status(dana('PUT', `/monitors/${monitor.id}`, { definition: monitor.definition, version: 99 }))).toBe(409);
    await dana('PUT', `/monitors/${monitor.id}/access`, { acl: [{ subject: 'team:service desk', permissions: ['view'] }] });
    expect(await status(vera('GET', `/monitors/${monitor.id}`))).toBe(404);
    expect((await olivia('GET', `/monitors/${monitor.id}`)).permissions).toEqual(['view']);
    expect((await vera('GET', '/monitors')).some((m: any) => m.id === monitor.id)).toBe(false);
    // the overview dataset is only visible to users who may see every monitor
    const { publishDirtyDatasets } = await import('../src/monitors/datasets.js');
    const { markDatasetsDirty } = await import('../src/monitors/datasets.js');
    markDatasetsDirty(monitor.id);
    publishDirtyDatasets();
    expect((await vera('GET', '/datasets')).some((d: any) => d.key === 'monitors.status')).toBe(false);
    expect((await s.api('GET', '/datasets')).some((d: any) => d.key === 'monitors.status')).toBe(true);
    await dana('DELETE', `/monitors/${monitor.id}`);
    expect(await status(dana('GET', `/monitors/${monitor.id}`))).toBe(404);
    const audit = await s.api('GET', `/audit?entityType=monitor&entityId=${monitor.id}`);
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['monitor.created', 'monitor.access_changed', 'monitor.deleted']));
  });

  it('templates: instances from a form row and from CSV, outdated after a template change, re-sync', async () => {
    const tpl = (await s.api('GET', '/monitors?templates=1')).find((m: any) => m.key === 'powermeter-machine');
    expect(tpl).toBeTruthy();
    const csv = [
      'name,machine,pmHost,pmPort,pmAssetId,machineAssetId,title',
      'Machine 21 – PowerMeter,m21,10.20.21.5,502,asset21pm,asset21m,M21',
      '"Machine 22 – PowerMeter",m22,10.20.22.5,,asset22pm,asset22m,M22',
    ].join('\n');
    const made = await dana('POST', `/monitors/${tpl.id}/instances`, { csv });
    expect(made.map((r: any) => r.monitor.name)).toEqual(['Machine 21 – PowerMeter', 'Machine 22 – PowerMeter']);
    const m22 = made[1].monitor;
    expect(m22.templateId).toBe(tpl.id);
    expect(m22.templateParams).toMatchObject({ machine: 'm22', pmPort: 502, pmCadence: 60 });
    const ping = m22.definition.checks.find((c: any) => c.id === 'pm-reachable');
    expect(ping).toMatchObject({ host: '10.20.22.5', fallbackPort: 502 });
    expect(m22.definition.checks.find((c: any) => c.id === 'machine-ih').maxAgeSeconds).toBe(900);
    expect(check(await s.api('GET', `/monitors/${m22.id}`), 'pm-reports').key).toBe('m22.powermeter');
    expect(made[1].secrets).toHaveLength(2); // two heartbeat endpoints
    // a bad row creates nothing
    await expect(dana('POST', `/monitors/${tpl.id}/instances`, { rows: [{ params: { title: 'X', machine: 'm23', pmHost: '10.0.0.1', pmAssetId: 'a', machineAssetId: 'b' } }, { params: { title: 'Y' } }] })).rejects.toThrow(/Row 2: Parameter \W+Machine code\W+ is required/);
    expect((await s.api('GET', '/monitors')).some((m: any) => m.name === 'X')).toBe(false);
    // change the template → instances are outdated → re-sync applies it
    const t = await s.api('GET', `/monitors/${tpl.id}`);
    await s.api('PUT', `/monitors/${tpl.id}`, { definition: { ...t.definition, intervalSeconds: 120 } });
    expect((await s.api('GET', `/monitors/${m22.id}`)).templateOutdated).toBe(true);
    const re = await dana('POST', `/monitors/${m22.id}/resync`);
    expect(re.monitor.definition.intervalSeconds).toBe(120);
    expect(re.monitor.templateOutdated).toBe(false);
    expect(re.secrets).toHaveLength(0); // heartbeat endpoints and secrets are kept
  });

  it('exports YAML with portable references and imports it again', async () => {
    const yaml = await s.api('GET', '/monitors/machine-17-powermeter/export');
    expect(yaml).toMatch(/kind: monitor/);
    expect(yaml).toMatch(/platform: Insights Hub \(demo\)/);
    expect(yaml).toMatch(/monitor: machine-17-machine-data/);
    const r = await dana('POST', '/monitors/import', { yaml: yaml.replace(/key: m17\./g, 'key: copy17.'), key: 'machine-17-copy' });
    expect(r.monitor.key).toBe('machine-17-copy');
    expect(r.monitor.definition.checks.find((c: any) => c.type === 'monitor').monitor).toMatch(/^mon_/);
  });

  it('demo: machine 18 shows the gateway as root cause of the stale Insights Hub data', async () => {
    const list = await s.api('GET', '/monitors');
    expect(list.map((m: any) => m.key)).toEqual(expect.arrayContaining(['machine-17-machine-data', 'machine-17-powermeter', 'plant-services', 'machine-18-powermeter']));
    const m18 = list.find((m: any) => m.key === 'machine-18-powermeter');
    const { setMonitorClock } = eng;
    // the simulator's last PowerMeter report of machine 18 is 25 minutes old (it ran once at demo setup)
    await eng.evaluateMonitorNow(m18.id);
    try {
      setMonitorClock(() => Date.now() + 1000);
      await eng.evaluateMonitorNow(m18.id);
    } finally {
      setMonitorClock(null);
    }
    const m = await s.api('GET', `/monitors/${m18.id}`);
    expect(check(m, 'pm-reports').status).toBe('down');
    expect(check(m, 'pm-ih').status).toBe('down');
    expect(check(m, 'pm-ih').causedBy.map((c: any) => c.checkId)).toEqual(['pm-reports']);
    expect(check(m, 'machine-reports').status).toBe('up');
    expect(m.rootCauses.map((c: any) => c.checkId)).toEqual(['pm-reports']);
  });

  it('keeps state across an engine restart and applies retention', async () => {
    const before = await s.api('GET', '/monitors/outputs-test');
    await eng.stopMonitorEngine();
    eng.startMonitorEngine();
    const after = await s.api('GET', '/monitors/outputs-test');
    expect(after.status).toBe(before.status);
    expect(check(after, 'hb').since).toBe(check(before, 'hb').since);
    expect(check(after, 'hb').lastOkAt).toBe(check(before, 'hb').lastOkAt);
    // retention: old history goes, the newest change per check stays
    const { deleteMonitorDataBefore } = await import('../src/monitors/retention.js');
    const removed = deleteMonitorDataBefore(new Date(Date.now() + 86400000).toISOString());
    expect(removed.results).toBeGreaterThan(0);
    const hist = await s.api('GET', `/monitors/${after.id}/history?check=hb`);
    expect(hist).toHaveLength(1);
    const st = await s.api('GET', '/settings');
    expect(st.retentionMonitorDays).toBe(30);
  });
});
