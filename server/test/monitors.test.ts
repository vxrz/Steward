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
