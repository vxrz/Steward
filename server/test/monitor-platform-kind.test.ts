import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CHECK_TYPES, CHECK_TYPE_DEFS, checkSchema, type CheckDef } from '@sm/shared';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * A check of a type tied to platform kinds (0.11.0, shared/src/checkTypes.ts platform: 'kind') needs a platform of one
 * of them: saving refuses another kind (CHECK_PLATFORM_KIND), and a stored one – from before 0.11.0, or a platform whose
 * kind changed – reports unknown with the reason and sends no request to that platform.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let eng: typeof import('../src/monitors/engine.js');
let db: typeof import('../src/db.js').db;
let hits: string[] = [];
let counter: http.Server;
let gatus: { id: string }, prometheus: { id: string }, generic: { id: string }, ih: { id: string };

const fail = (p: Promise<unknown>) =>
  p.then(
    () => ({ status: 200, code: '', params: {} as Record<string, unknown> }),
    (e: { status: number; body: { code?: string; params?: Record<string, unknown> } }) => ({
      status: e.status,
      code: e.body?.code ?? '',
      params: e.body?.params ?? {},
    }),
  );

/** A valid check of every kind-bound type (the descriptor's defaults, plus the fields they leave empty). */
const FILL: Record<string, Record<string, unknown>> = {
  freshness: { assetId: 'asset1', aspect: 'aspect1', variables: ['v'] },
  gatus: { endpointKey: 'core_shop' },
  checkmk: { host: 'db01' },
  prometheus: { query: 'up' },
  kubernetes: { namespace: 'shop' },
  git: { repository: 'acme/shop' },
  kafka: { topic: 'orders' },
  mqtt: { topic: 'plant/#' },
  snowflake: { object: 'DB.PUBLIC.ORDERS' },
  dynamodb: { table: 'orders' },
  'dependency-track': { project: 'shop' },
};
const KIND_TYPES = CHECK_TYPES.filter((t) => CHECK_TYPE_DEFS[t].platform === 'kind');
const kindCheck = (type: string, platform: string): CheckDef => {
  const c = { id: type, name: type, type, ...CHECK_TYPE_DEFS[type as keyof typeof CHECK_TYPE_DEFS].defaults, ...FILL[type], platform };
  const parsed = checkSchema.safeParse(c);
  if (!parsed.success) throw new Error(`${type}: ${JSON.stringify(parsed.error.issues)}`);
  return parsed.data;
};

const platform = (name: string, kind: string, baseUrl = s.base) =>
  s.api('POST', '/platforms', { name, kind, baseUrl, config: { variables: {}, http: { proxy: 'none' }, auth: { type: 'none' } } }) as Promise<{
    id: string;
  }>;
const monitorOf = (checks: unknown[], name = `Kinds ${Math.random()}`) => ({ definition: { name, failuresBeforeDown: 1, checks } });

beforeAll(async () => {
  counter = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  });
  await new Promise<void>((r) => counter.listen(0, '127.0.0.1', r));
  const countUrl = `http://127.0.0.1:${(counter.address() as AddressInfo).port}`;
  s = await startTestServer();
  await setup(s);
  // the demo allow-lists loopback, so a request to the counting server would get through
  await s.api('POST', '/demo/setup', {});
  eng = await import('../src/monitors/engine.js');
  db = (await import('../src/db.js')).db;
  gatus = await platform('Kinds Gatus', 'gatus', countUrl);
  prometheus = await platform('Kinds Prometheus', 'prometheus', countUrl);
  generic = await platform('Kinds API', 'generic', countUrl);
  ih = await platform('Kinds Insights Hub', 'insights-hub', countUrl);
}, 120_000);
afterAll(async () => {
  await s?.app.close();
  await new Promise((r) => counter?.close(r));
  if (s) fs.rmSync(s.dataDir, { recursive: true, force: true });
});

describe('saving a check of a type tied to platform kinds', () => {
  it('refuses a platform of another kind on create and update, with the check, type, platform and kinds', async () => {
    const r = await fail(s.api('POST', '/monitors', monitorOf([{ ...kindCheck('gatus', prometheus.id) }])));
    expect(r).toMatchObject({ status: 400, code: 'CHECK_PLATFORM_KIND' });
    expect(r.params).toEqual({ check: 'gatus', type: 'gatus', name: 'Kinds Prometheus', kind: 'prometheus', kinds: ['gatus'], kindNames: ['Gatus'] });
    // by name as well as by id; the repository check: one of three kinds (was CHECK_GIT_PLATFORM)
    expect((await fail(s.api('POST', '/monitors', monitorOf([kindCheck('prometheus', 'Kinds Gatus')])))).code).toBe('CHECK_PLATFORM_KIND');
    const git = await fail(s.api('POST', '/monitors', monitorOf([kindCheck('git', gatus.id)])));
    expect(git).toMatchObject({ code: 'CHECK_PLATFORM_KIND', params: { kinds: ['github', 'gitlab', 'forgejo'] } });
    // freshness: the Insights Hub source is tied to its kind, the API source reads any platform
    expect((await fail(s.api('POST', '/monitors', monitorOf([kindCheck('freshness', generic.id)])))).code).toBe('CHECK_PLATFORM_KIND');
    await s.api('POST', '/monitors', monitorOf([kindCheck('freshness', ih.id)]));
    const api = {
      id: 'api',
      name: 'API',
      type: 'freshness',
      source: 'platform',
      platform: gatus.id,
      path: '/x',
      timestamp: 'ts',
      mode: 'maxAge',
      maxAgeSeconds: 60,
    };
    await s.api('POST', '/monitors', monitorOf([api]));
    // the schema check of a database platform (a system instead is fine)
    expect((await fail(s.api('POST', '/monitors', monitorOf([kindCheck('db-schema', generic.id)])))).code).toBe('CHECK_PLATFORM_KIND');

    const { monitor } = await s.api('POST', '/monitors', monitorOf([kindCheck('gatus', gatus.id)]));
    const def = (await s.api('GET', `/monitors/${monitor.id}`)).definition;
    const upd = await fail(s.api('PUT', `/monitors/${monitor.id}`, { definition: { ...def, checks: [{ ...def.checks[0], platform: prometheus.id }] } }));
    expect(upd.code).toBe('CHECK_PLATFORM_KIND');
    expect((await s.api('GET', `/monitors/${monitor.id}`)).definition.checks[0].platform).toBe(gatus.id);
  });

  it('refuses it in a template instance and in a duplicate of a monitor saved before 0.11', async () => {
    const { monitor: tpl } = await s.api('POST', '/monitors', {
      isTemplate: true,
      definition: {
        name: '{{ params.title }}',
        parameters: [{ name: 'title' }, { name: 'gatus' }],
        checks: [{ id: 'ep', name: 'Endpoint', type: 'gatus', platform: '{{ params.gatus }}', endpointKey: 'core_shop' }],
      },
    });
    const bad = await fail(s.api('POST', `/monitors/${tpl.id}/instances`, { rows: [{ params: { title: 'Kinds instance', gatus: prometheus.id } }] }));
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad)).toContain('CHECK_PLATFORM_KIND');
    await s.api('POST', `/monitors/${tpl.id}/instances`, { rows: [{ params: { title: 'Kinds instance', gatus: gatus.id } }] });

    // a stored check on a platform of another kind (an older row): the copy is refused until a platform of the kind is chosen
    const { monitor } = await s.api('POST', '/monitors', monitorOf([kindCheck('gatus', gatus.id)]));
    const def = JSON.parse(db().get<{ definition: string }>('SELECT definition FROM monitors WHERE id = ?', monitor.id)!.definition);
    def.checks[0].platform = prometheus.id;
    db().run('UPDATE monitors SET definition = ? WHERE id = ?', JSON.stringify(def), monitor.id);
    expect((await fail(s.api('POST', `/monitors/${monitor.id}/duplicate`, { name: 'Kinds copy' }))).code).toBe('CHECK_PLATFORM_KIND');
  });
});

describe('running a stored check whose platform is of another kind', () => {
  it('reports unknown with the reason for every kind-bound type and sends no request to the platform', async () => {
    expect(KIND_TYPES.length).toBeGreaterThan(10);
    const { monitor } = await s.api(
      'POST',
      '/monitors',
      monitorOf([{ id: 'ok', name: 'ok', type: 'platform', platform: generic.id, method: 'GET', path: '/' }]),
    );
    // as an older row would have it: every kind-bound type on the generic platform (saving would refuse it)
    const def = JSON.parse(db().get<{ definition: string }>('SELECT definition FROM monitors WHERE id = ?', monitor.id)!.definition);
    def.checks = KIND_TYPES.map((t) => kindCheck(t, generic.id));
    db().run('UPDATE monitors SET definition = ? WHERE id = ?', JSON.stringify(def), monitor.id);
    eng.reloadMonitor(monitor.id);
    hits = [];
    await eng.evaluateMonitorNow(monitor.id);
    const m = await s.api('GET', `/monitors/${monitor.id}`);
    expect(m.checks.map((c: { checkId: string }) => c.checkId).sort()).toEqual([...KIND_TYPES].sort());
    for (const c of m.checks)
      expect({ id: c.checkId, status: c.status, message: c.last?.message }).toEqual({
        id: c.checkId,
        status: 'unknown',
        message: expect.stringMatching(
          /^Check could not run: "Kinds API" is a platform of kind Generic HTTP API, but this check reads .+ – choose a platform of that kind$/,
        ),
      });
    expect(hits).toEqual([]);

    // the control: a check that reads any platform reaches the same server
    const ctl = await s.api('POST', '/monitors', monitorOf([{ id: 'ok', name: 'ok', type: 'platform', platform: generic.id, method: 'GET', path: '/ping' }]));
    await eng.evaluateMonitorNow(ctl.monitor.id);
    expect(hits).toContain('GET /ping');
  });

  it('keeps loading a monitor whose platform changed its kind, shows the reason and names it in a log line at start', async () => {
    const { monitor } = await s.api('POST', '/monitors', monitorOf([kindCheck('gatus', gatus.id)], 'Kinds changed'));
    const other = await platform('Kinds changes kind', 'gatus', s.base);
    const { monitor: m2 } = await s.api('POST', '/monitors', monitorOf([{ ...kindCheck('gatus', other.id), id: 'ep' }], 'Kinds changed 2'));
    db().run("UPDATE platforms SET kind = 'prometheus' WHERE id = ?", other.id);
    hits = [];
    await eng.evaluateMonitorNow(m2.id);
    const m = await s.api('GET', `/monitors/${m2.id}`);
    expect(m.checks[0]).toMatchObject({
      status: 'unknown',
      last: { message: expect.stringContaining('is a platform of kind Prometheus, but this check reads Gatus') },
    });
    expect(hits).toEqual([]);
    expect((await s.api('GET', '/monitors')).some((x: { id: string }) => x.id === monitor.id)).toBe(true);

    const { logger } = await import('../src/log.js');
    const warn = vi.spyOn(logger, 'warn');
    try {
      await eng.stopMonitorEngine();
      eng.startMonitorEngine();
      const call = warn.mock.calls.find((c) => String(c[1]).includes('of a kind they do not read'));
      expect(call).toBeDefined();
      const logged = (call![0] as { checks: { monitor: string; check: string; type: string; platform: string; kind: string }[] }).checks;
      expect(logged).toContainEqual({ monitor: m2.id, key: m.key, check: 'ep', type: 'gatus', platform: other.id, kind: 'prometheus' });
      expect(logged.some((x) => x.monitor === monitor.id)).toBe(false);
      // ids only: no names, no secrets
      expect(JSON.stringify(call![0])).not.toContain('Kinds changes kind');
    } finally {
      warn.mockRestore();
    }
  });
});
