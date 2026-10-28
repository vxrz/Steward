import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Failed checks of scheduled runs (#127): on change by default (a message when a check starts failing or its result
 * changes, a reminder while it keeps failing, optionally one when it passes again), after every run, or never; per
 * check `notify: false`; runs without a schedule notify as before. In-app and the webhook behave alike.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let receiver: http.Server;
const received: { path: string; body: any }[] = [];
let processId: string;

const flush = async () => (await import('../src/notifications/service.js')).flushNotifications();
/** The deferred notification handlers run on setImmediate: wait for them, then for the sends. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  await flush();
};
const inbox = async () => ((await s.api('GET', '/notifications?limit=500')) as { items: any[] }).items;
const hooks = (event: string) => received.filter((r) => r.path === '/hook' && r.body?.event === event);

beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', body: JSON.parse(data || 'null') });
      res.end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  s = await startTestServer();
  await setup(s);
  await s.api('PUT', '/settings/notifications', {
    email: { enabled: false, host: '', port: 587, secure: false, from: '' },
    teams: { enabled: false },
    webhook: { enabled: true, url: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook` },
    routes: { 'check.failed': ['inApp', 'webhook'], 'check.resolved': ['inApp', 'webhook'] },
  });
  const p = await s.api('POST', '/processes', {
    definition: {
      name: 'Endpoints overview',
      connections: [],
      inputs: [
        { name: 'down', type: 'list' },
        { name: 'quiet', type: 'boolean' },
      ],
      steps: [
        {
          id: 'healthy',
          type: 'check',
          name: 'All endpoints healthy',
          severity: 'warning',
          condition: '$count(inputs.down) = 0',
          message: "{{ $count(inputs.down) = 0 ? 'All healthy' : 'Down: ' & $join(inputs.down, ', ') }}",
        },
        { id: 'info', type: 'check', name: 'Informational', condition: 'false', message: 'never notified', notify: false },
      ],
    },
  });
  processId = p.id;
});
afterAll(async () => {
  await s?.app.close();
  receiver?.close();
});

async function schedule(notify?: { mode: string; reminderHours: number; resolved: boolean }) {
  return s.api('POST', '/schedules', {
    name: `Endpoints ${Math.random().toString(36).slice(2, 7)}`,
    processId,
    cron: '0 3 1 1 *',
    inputs: { down: [] },
    bindings: {},
    enabled: false,
    ...(notify ? { notify } : {}),
  });
}

/** Sets the endpoints that are down, fires the schedule and waits for the run and its messages. */
async function fire(sch: any, down: string[]) {
  await s.api('PUT', `/schedules/${sch.id}`, { name: sch.name, processId, cron: sch.cron, inputs: { down }, bindings: {}, enabled: false });
  const { id } = await s.api('POST', `/schedules/${sch.id}/run`, {});
  await s.waitRun(id, ['succeeded', 'failed']);
  await settle();
  return id as string;
}

const titlesFor = async (runIds: string[]) =>
  (await inbox())
    .filter((n) => runIds.includes(n.link.slice(6)))
    .map((n) => n.title)
    .sort();

describe('failed checks of scheduled runs', () => {
  it('new schedules notify on change: start, change, nothing while unchanged, a reminder after the interval', async () => {
    const sch = await schedule();
    expect(sch.notify).toEqual({ mode: 'change', reminderHours: 4, resolved: false });
    received.length = 0;
    const r1 = await fire(sch, ['a']);
    const r2 = await fire(sch, ['a']);
    const r3 = await fire(sch, ['a', 'b']);
    const r4 = await fire(sch, ['a', 'b']);
    expect(await titlesFor([r1, r2, r3, r4])).toEqual([
      'Check failed: All endpoints healthy in Endpoints overview',
      'Check result changed: All endpoints healthy in Endpoints overview',
    ]);
    // the webhook gets the same two, although they came within the hour (each is news)
    expect(hooks('check.failed').map((h) => [h.body.data.phase, h.body.data.message])).toEqual([
      ['new', 'Down: a'],
      ['changed', 'Down: a, b'],
    ]);
    // the informational check never notifies
    expect((await inbox()).some((n) => n.title.includes('Informational'))).toBe(false);

    // still failing four hours later: a reminder with the time it started failing
    const { db } = await import('../src/db.js');
    db().run("UPDATE check_alerts SET notified_at = '2000-01-01T00:00:00.000Z' WHERE schedule_id = ?", sch.id);
    const r5 = await fire(sch, ['a', 'b']);
    const reminder = (await inbox()).find((n) => n.link === `/runs/${r5}`);
    expect(reminder.title).toBe('Still failing: All endpoints healthy in Endpoints overview');
    expect(reminder.body).toMatch(/Failing since /);
    const r6 = await fire(sch, ['a', 'b']);
    expect(await titlesFor([r6])).toEqual([]);

    // passing again: no message unless asked for, and a new failure starts over
    const r7 = await fire(sch, []);
    expect(await titlesFor([r7])).toEqual([]);
    expect(db().get('SELECT 1 FROM check_alerts WHERE schedule_id = ?', sch.id)).toBeUndefined();
    const r8 = await fire(sch, ['c']);
    expect(await titlesFor([r8])).toEqual(['Check failed: All endpoints healthy in Endpoints overview']);
  });

  it('sends "passes again" when the schedule asks for it; no reminder with 0 hours', async () => {
    const sch = await schedule({ mode: 'change', reminderHours: 0, resolved: true });
    received.length = 0;
    const r1 = await fire(sch, ['a']);
    const { db } = await import('../src/db.js');
    db().run("UPDATE check_alerts SET notified_at = '2000-01-01T00:00:00.000Z' WHERE schedule_id = ?", sch.id);
    const r2 = await fire(sch, ['a']);
    const r3 = await fire(sch, []);
    const r4 = await fire(sch, []);
    expect(await titlesFor([r1, r2, r3, r4])).toEqual([
      'Check failed: All endpoints healthy in Endpoints overview',
      'Check passes again: All endpoints healthy in Endpoints overview',
    ]);
    const resolved = (await inbox()).find((n) => n.link === `/runs/${r3}`);
    expect(resolved.body).toMatch(/It had been failing since /);
    expect(hooks('check.resolved')).toHaveLength(1);
  });

  it('"after every run" notifies every failing run in the app; "never" not at all', async () => {
    const every = await schedule({ mode: 'every', reminderHours: 4, resolved: false });
    const e = [await fire(every, ['a']), await fire(every, ['a'])];
    expect(await titlesFor(e)).toHaveLength(2);
    const off = await schedule({ mode: 'off', reminderHours: 4, resolved: true });
    const o = [await fire(off, ['a']), await fire(off, [])];
    expect(await titlesFor(o)).toEqual([]);
  });

  it('keeps the setting when a schedule is saved without it, and audits a change', async () => {
    const sch = await schedule({ mode: 'every', reminderHours: 2, resolved: true });
    await s.api('PUT', `/schedules/${sch.id}`, { name: sch.name, processId, cron: sch.cron, inputs: {}, bindings: {}, enabled: false });
    expect((await s.api('GET', '/schedules')).find((x: any) => x.id === sch.id).notify).toEqual({ mode: 'every', reminderHours: 2, resolved: true });
    const changed = await s.api('PUT', `/schedules/${sch.id}`, {
      name: sch.name,
      processId,
      cron: sch.cron,
      inputs: {},
      bindings: {},
      enabled: false,
      notify: { mode: 'off', reminderHours: 0, resolved: false },
    });
    expect(changed.notify.mode).toBe('off');
    const audit = await s.api('GET', `/audit?entityType=schedule&entityId=${sch.id}&limit=5`);
    expect(audit[0].details.notify).toEqual({ mode: 'off', reminderHours: 0, resolved: false });
    const bad = (notify: unknown) =>
      s.api('PUT', `/schedules/${sch.id}`, { name: sch.name, processId, cron: sch.cron, inputs: {}, bindings: {}, enabled: false, notify }).then(
        () => 200,
        (e: { status: number }) => e.status,
      );
    expect(await bad({ mode: 'sometimes', reminderHours: 4, resolved: false })).toBe(400);
    expect(await bad({ mode: 'change', reminderHours: -1, resolved: false })).toBe(400);
    expect(await bad({ mode: 'change', reminderHours: 10_000, resolved: false })).toBe(400);
  });

  it('runs without a schedule notify on every failed check, as before', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { id } = await s.api('POST', '/runs', { processId, inputs: { down: ['x'] }, bindings: {} });
      await s.waitRun(id, ['succeeded', 'failed']);
      ids.push(id);
    }
    await settle();
    expect(await titlesFor(ids)).toEqual([
      'Check failed: All endpoints healthy in Endpoints overview',
      'Check failed: All endpoints healthy in Endpoints overview',
    ]);
  });
});
