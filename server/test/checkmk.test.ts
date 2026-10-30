import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * CheckMk (#130): the monitor check type `checkmk` against the mock CheckMk site – host and service states, the
 * plugin output, pending and stale states, one shared read per cycle – and the platform preset.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let eng: typeof import('../src/monitors/engine.js');
let mock: typeof import('../src/mock/mockCheckmk.js');
let batch: typeof import('../src/monitors/batch.js');

const check = (id: string, host: string, service?: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  type: 'checkmk',
  platform: 'CheckMk (demo)',
  host,
  ...(service ? { service } : {}),
  ...extra,
});

async function monitorWith(name: string, checks: unknown[]) {
  const { monitor } = await s.api('POST', '/monitors', { definition: { name, failuresBeforeDown: 1, checks } });
  return monitor.id as string;
}
async function states(id: string) {
  await eng.evaluateMonitorNow(id);
  const m = await s.api('GET', `/monitors/${id}`);
  return Object.fromEntries(m.checks.map((c: any) => [c.checkId, { status: c.status, message: c.last?.message }]));
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  eng = await import('../src/monitors/engine.js');
  mock = await import('../src/mock/mockCheckmk.js');
  batch = await import('../src/monitors/batch.js');
});
afterAll(async () => {
  await s?.app.close();
});

describe('CheckMk check', () => {
  it('maps OK / WARN / CRIT and host states, with the plugin output, in one read per kind', async () => {
    mock.resetCheckmk();
    batch.clearBatchCaches();
    const id = await monitorWith('CheckMk states', [
      check('db', 'db01'),
      check('backup', 'backup01'),
      check('var', 'db01', 'Filesystem /var'),
      check('cpu', 'db01', 'CPU load'),
      check('shop', 'web01', 'HTTPS shop'),
      check('gone', 'web01', 'No such service'),
    ]);
    const st = await states(id);
    expect(st.db).toMatchObject({ status: 'up', message: 'CheckMk: db01 UP – Packet received via smart PING' });
    expect(st.backup.status).toBe('down');
    expect(st.var).toMatchObject({ status: 'degraded', message: expect.stringMatching(/^CheckMk: db01 \/ Filesystem \/var WARN – WARN - Used: 82\.0%/) });
    expect(st.cpu.status).toBe('up');
    expect(st.shop).toMatchObject({ status: 'down', message: 'CheckMk: web01 / HTTPS shop CRIT – CRIT - HTTP 503 Service Unavailable' });
    expect(st.gone).toMatchObject({ status: 'unknown', message: 'CheckMk has no service "web01 / No such service"' });
    // the six checks shared one host read and one service read
    expect(batch.checkmkFetch.calls).toBe(1);
  });

  it('says when a state is pending, stale, in a downtime or acknowledged; UNKNOWN stays unknown', async () => {
    mock.resetCheckmk();
    batch.clearBatchCaches();
    mock.setCheckmkState('db01', 'CPU load', { has_been_checked: 0 });
    mock.setCheckmkState('web01', 'Memory', { last_check: Math.floor(Date.now() / 1000) - 3600 });
    mock.setCheckmkState('web01', 'HTTPS shop', { scheduled_downtime_depth: 1, acknowledged: 1 });
    mock.setCheckmkState('db01', 'Filesystem /var', { state: 3, output: 'UNKNOWN - mount point not found' });
    const id = await monitorWith('CheckMk notes', [
      check('cpu', 'db01', 'CPU load'),
      check('mem', 'web01', 'Memory', { maxAgeSeconds: 600 }),
      check('shop', 'web01', 'HTTPS shop'),
      check('var', 'db01', 'Filesystem /var'),
    ]);
    const st = await states(id);
    expect(st.cpu).toMatchObject({ status: 'unknown', message: 'CheckMk has not checked db01 / CPU load yet (pending)' });
    expect(st.mem).toMatchObject({ status: 'unknown', message: expect.stringMatching(/^CheckMk last checked web01 \/ Memory 60 min ago \(maximum 10 min\)$/) });
    expect(st.shop.message).toMatch(/\(in a CheckMk downtime, acknowledged in CheckMk\)$/);
    expect(st.var.status).toBe('unknown');
  });

  it('reports a wrong automation secret plainly', async () => {
    batch.clearBatchCaches();
    const p = await s.api('POST', '/platforms', {
      name: 'CheckMk wrong secret',
      kind: 'checkmk',
      baseUrl: `${s.base}/mock/checkmk/demo/check_mk/api/1.0`,
      config: { auth: { type: 'bearer' }, variables: {}, http: { proxy: 'none' } },
      secrets: { token: 'steward-reader wrong' },
    });
    const id = await monitorWith('CheckMk denied', [{ ...check('db', 'db01'), platform: p.id }]);
    expect((await states(id)).db).toMatchObject({
      status: 'unknown',
      message: 'CheckMk could not be read: CheckMk answered HTTP 401 (check the automation user and its secret)',
    });
  });

  it('offers the platform preset with a connection test', async () => {
    const presets = await s.api('GET', '/platform-presets');
    const cmk = presets.find((p: any) => p.kind === 'checkmk');
    expect(cmk).toMatchObject({ config: { auth: { type: 'bearer' }, testPath: '/version' } });
    const demo = (await s.api('GET', '/platforms')).find((p: any) => p.name === 'CheckMk (demo)');
    const t = await s.api('POST', `/platforms/${demo.id}/test`, {});
    expect(t, JSON.stringify(t)).toMatchObject({ ok: true });
  });

  it('posts a Teams card per status change to a Teams channel platform, whose URL stays a credential', async () => {
    mock.resetCheckmk();
    batch.clearBatchCaches();
    const got: any[] = [];
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        got.push({ url: req.url, body: JSON.parse(b) });
        res.writeHead(202).end();
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as any).port}/workflows/abc/triggers/manual/paths/invoke?sig=secret-sig`;
    try {
      const ch = await s.api('POST', '/platforms', {
        name: 'Teams – Ops channel',
        kind: 'teams',
        baseUrl: 'https://prod-00.westeurope.logic.azure.com',
        config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none' } },
        secrets: { webhookUrl: url },
      });
      expect(JSON.stringify(await s.api('GET', `/platforms/${ch.id}`))).not.toContain('secret-sig');
      const { monitor } = await s.api('POST', '/monitors', {
        definition: {
          name: 'Shop in CheckMk',
          failuresBeforeDown: 1,
          checks: [check('shop', 'web01', 'HTTPS shop')],
          outputs: [{ id: 'teams', type: 'webhook', format: 'teams', platform: ch.id, include: 'monitor' }],
        },
      });
      expect(JSON.stringify(monitor)).not.toContain('secret-sig');
      // a Teams card only goes to a Teams channel platform: never to a URL in the definition, nor to another platform
      for (const bad of [
        { id: 'teams', type: 'webhook', format: 'teams', url: url },
        { id: 'teams', type: 'webhook', format: 'teams', platform: 'CheckMk (demo)', path: '/x' },
        { id: 'teams', type: 'webhook', format: 'teams', platform: 'Gatus (demo)' },
      ])
        await expect(
          s.api('PUT', `/monitors/${monitor.id}`, { definition: { name: 'Shop in CheckMk', checks: [check('shop', 'web01', 'HTTPS shop')], outputs: [bad] } }),
        ).rejects.toThrow(/Microsoft Teams channel/);
      await eng.evaluateMonitorNow(monitor.id);
      await eng.settle();
      // a card per status change of the monitor (a new monitor first becomes unknown, then down)
      const last = got.at(-1)!;
      expect(last.url).toContain('sig=secret-sig');
      const card = last.body.attachments[0];
      expect(card.contentType).toBe('application/vnd.microsoft.card.adaptive');
      const text = JSON.stringify(card.content);
      expect(text).toContain('Shop in CheckMk');
      expect(text).toContain('HTTP 503 Service Unavailable');
    } finally {
      srv.close();
    }
  });

  it('the notification webhook can send the Teams card too', async () => {
    const got: any[] = [];
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        got.push(JSON.parse(b));
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(srv.address() as any).port}/hook`;
      const base = { email: { enabled: false, host: '', port: 587, secure: false, from: '' }, teams: { enabled: false }, routes: {} };
      await s.api('PUT', '/settings/notifications', { ...base, webhook: { enabled: true, url, format: 'teams' } });
      expect((await s.api('GET', '/settings/notifications')).webhook).toMatchObject({ enabled: true, hasUrl: true, format: 'teams' });
      expect(await s.api('POST', '/settings/notifications/test', { channel: 'webhook' })).toMatchObject({ ok: true });
      expect(got.at(-1).attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
      // back to the JSON event
      await s.api('PUT', '/settings/notifications', { ...base, webhook: { enabled: true, format: 'json' } });
      expect((await s.api('GET', '/settings/notifications')).webhook).toEqual({ enabled: true, hasUrl: true });
      await s.api('POST', '/settings/notifications/test', { channel: 'webhook' });
      expect(got.at(-1)).toMatchObject({ event: expect.any(String), title: expect.any(String) });
      expect(got.at(-1).attachments).toBeUndefined();
    } finally {
      srv.close();
    }
  });
});
