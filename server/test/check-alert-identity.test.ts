import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareIdentity, identityOf, keyOf, normalise, toldAfter } from '../src/engine/check-identity.js';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * What counts as a change of a failing check (0.27.0): what fails – its severity and the set of affected items (the
 * change key, else the items, else the message with volatile parts masked) – not the words of its message. While
 * it keeps failing, only the reminder repeats it; the end is told when asked for.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

describe('the normaliser and the identity', () => {
  it('masks counts, durations, times and generated ids, and keeps names', () => {
    const a = normalise('shop-prod/web: 1/3 ready – pod web-7d9f8b6c5d-x2k9p CrashLoopBackOff (12 restarts), started 2026-11-19T10:15:00Z');
    const b = normalise('shop-prod/web: 2/3 ready – pod web-5f6b8c9d4-qz7xw CrashLoopBackOff (13 restarts), started 2026-11-19T10:30:00Z');
    expect(a).toBe('shop-prod/web: # ready – pod web-<id> CrashLoopBackOff (# restart), started <time>');
    expect(b).toBe(a);
    expect(normalise('plc-01 / temperature – 5 h old')).toBe(normalise('plc-01 / temperature – 1 h 20 min old'));
    expect(normalise('Tenant storage: 812 of 1000 GB (81 %)')).toBe('Tenant storage: # of # GB (# %)');
    expect(normalise('cpu: CRIT in about 3 days (-2.1 % a week)')).toBe(normalise('cpu: CRIT in about 12 days (+3.5 % a week)'));
    expect(normalise('ends 19.11.2026, id 123e4567-e89b-12d3-a456-426614174000, image deadbeef12')).toBe('ends <time>, id <id>, image <id>');
    // names keep their numbers: another device is another item
    expect(normalise('plc-01 offline')).not.toBe(normalise('plc-02 offline'));
    expect(normalise('host 10.0.0.1 down')).not.toBe(normalise('host 10.0.0.2 down'));
    expect(normalise('node7 and v2')).toBe('node7 and v2');
    // one or more: the same words
    expect(normalise('1 endpoint down')).toBe(normalise('12 endpoints down'));
  });

  it('keeps a number that names an item, and masks quantities', () => {
    const k = (x: string) => keyOf('items', x);
    expect(k('Line 1')).not.toBe(k('Line 2'));
    expect(k('Machine 17 – PowerMeter')).not.toBe(k('Machine 18 – PowerMeter'));
    expect(k('Linie 2 steht')).not.toBe(k('Linie 3 steht'));
    expect(k('Ärmel 2')).not.toBe(k('Ärmel 3'));
    expect(k('3 endpoints down')).toBe(k('4 endpoints down'));
    expect(k('shop-prod/api 1/3 ready')).toBe(k('shop-prod/api 2/3 ready'));
    expect(k('web (14 restarts)')).toBe(k('web (15 restarts)'));
    expect(k('Disk 91%')).toBe(k('Disk 95%'));
    expect(k('Tank 3 bar')).toBe(k('Tank 4 bar'));
    expect(k('Pump 3 kW')).toBe(k('Pump 4 kW'));
    expect(k('usage 91')).toBe(k('usage 92'));
    // a unit after a space, in any case, is still a unit
    expect(k('Disk 91 %')).toBe(k('Disk 95 %'));
    expect(k('Oven 85 °C')).toBe(k('Oven 90 °C'));
    expect(k('Pump 3 kw')).toBe(k('Pump 4 kw'));
    expect(k('Drive 3 kHz')).toBe(k('Drive 4 kHz'));
    expect(k('Tank 3 Bar')).toBe(k('Tank 4 Bar'));
    // single-letter units are not taken as units: these name a line or a shift
    expect(k('Line 2 A')).not.toBe(k('Line 3 A'));
    // a no-break space, a number at the end, a combining mark in the word
    expect(k('Line\u00a01')).not.toBe(k('Line\u00a02'));
    expect(k('A\u0308rmel 2')).not.toBe(k('A\u0308rmel 3'));
    // not a plain integer, or not after a word: masked
    expect(k('Line 2.5')).toBe(k('Line 3.5'));
    expect(k('Line -2')).toBe(k('Line -3'));
    expect(k('2 endpoints')).toBe(k('3 endpoints'));
    // the parts masked before are not words
    expect(k('Stop 2026-11-19 2')).toBe(k('Stop 2026-11-20 3'));
    expect(k('line 1')).toBe(k('line 2'));
    // messages keep masking every number
    expect(keyOf('message', 'Line 1 down')).toBe(keyOf('message', 'Line 2 down'));
  });

  it('takes the change key, else the items, else the message', () => {
    expect(identityOf({ changeKey: ['a'], items: ['a: 1'], message: 'm' })).toEqual({ by: 'key', list: ['a'] });
    expect(identityOf({ items: ['a: 1'], message: 'm' })).toEqual({ by: 'items', list: ['a: 1'] });
    expect(identityOf({ items: [], message: 'm' })).toEqual({ by: 'message', list: ['m'] });
  });

  it('compares with what was told; gone entries stay told unless told as gone', () => {
    const told = { by: 'items' as const, list: ['web: 1/3', 'api: 0/2'] };
    const now = { by: 'items' as const, list: ['web: 2/3', 'db: 0/1'] };
    expect(compareIdentity(told, now)).toEqual({ added: ['db: 0/1'], removed: ['api: 0/2'] });
    expect(toldAfter(told, now, false).list).toEqual(['web: 2/3', 'db: 0/1', 'api: 0/2']);
    expect(toldAfter(told, now, true).list).toEqual(['web: 2/3', 'db: 0/1']);
    // change keys are used as they are
    expect(compareIdentity({ by: 'key', list: ['web 1'] }, { by: 'key', list: ['web 2'] })).toEqual({ added: ['web 2'], removed: ['web 1'] });
  });
});

let s: TestServer;
let receiver: http.Server;
const received: { path: string; body: any }[] = [];
let k8sId: string;
let plainId: string;

const flush = async () => (await import('../src/notifications/service.js')).flushNotifications();
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  await flush();
};
const inbox = async () => ((await s.api('GET', '/notifications?limit=500')) as { items: any[] }).items;
const hooks = (runIds: string[]) => received.filter((r) => r.body?.event === 'check.failed' && runIds.includes(r.body.data.runId));
const forRuns = async (runIds: string[], what?: string) => (await inbox()).filter((n) => runIds.includes(n.link.slice(6)) && (!what || n.title.includes(what)));

/** A deployment as the Kubernetes example reports it: ready replicas, restarts and a pod with a generated name */
interface Dep {
  name: string;
  ready: string;
  restarts: number;
  pod: string;
}
const dep = (name: string, n: number): Dep => ({
  name,
  ready: `${n % 3}/3`,
  restarts: 10 + n,
  pod: `${name.split('/')[1]}-${['7d9f8b6c5d', '5f6b8c9d4', '6c7d8f9b2'][n % 3]}-${['x2k9p', 'qz7xw', 'bm4rt'][n % 3]}`,
});

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
  k8sId = (
    await s.api('POST', '/processes', {
      definition: {
        name: 'Namespace health',
        inputs: [{ name: 'bad', type: 'json' }],
        steps: [
          {
            // as the Kubernetes example did up to 0.26: ready counts, restarts and pod names in the message and the items
            id: 'ready',
            type: 'check',
            name: 'All deployments ready',
            severity: 'warning',
            condition: '$count(inputs.bad) = 0',
            message: "{{ $join(inputs.bad.(name & ' ' & ready & ', pod ' & pod & ' (' & restarts & ' restarts)'), ', ') }}",
            headline: '{{ $count(inputs.bad) }} deployments not fully ready',
            value: '$count(inputs.bad)',
            items: "inputs.bad.(name & ': ' & ready & ' – ' & pod)",
          },
          {
            id: 'keyed',
            type: 'check',
            name: 'Deployments by key',
            severity: 'warning',
            condition: '$count(inputs.bad) = 0',
            message: "{{ $join(inputs.bad.(name & ' ' & ready), ', ') }}",
            items: "inputs.bad.(name & ': ' & ready & ' – ' & pod)",
            changeKey: 'inputs.bad.name',
          },
        ],
      },
    })
  ).id;
  plainId = (
    await s.api('POST', '/processes', {
      definition: {
        name: 'Data freshness',
        inputs: [
          { name: 'minutes', type: 'number' },
          { name: 'what', type: 'string' },
        ],
        steps: [
          {
            id: 'fresh',
            type: 'check',
            name: 'Data is fresh',
            severity: 'warning',
            condition: 'inputs.minutes < 30',
            message: "{{ inputs.what & ' is ' & inputs.minutes & ' minutes old' }}",
            value: 'inputs.minutes',
          },
        ],
      },
    })
  ).id;
});
afterAll(async () => {
  await s?.app.close();
  receiver?.close();
});

async function schedule(processId: string, notify: Record<string, unknown>) {
  return s.api('POST', '/schedules', {
    name: `Every 15 minutes ${Math.random().toString(36).slice(2, 7)}`,
    processId,
    cron: '*/15 * * * *',
    inputs: {},
    bindings: {},
    enabled: false,
    notify,
  });
}
async function fire(sch: any, inputs: Record<string, unknown>, dryRun = false) {
  await s.api('PUT', `/schedules/${sch.id}`, { name: sch.name, processId: sch.processId, cron: sch.cron, inputs, bindings: {}, enabled: false, dryRun });
  const { id } = await s.api('POST', `/schedules/${sch.id}/run`, {});
  await s.waitRun(id, ['succeeded', 'failed']);
  await settle();
  return id as string;
}
/** As if the last message was sent this long ago */
async function age(sch: any, ms: number) {
  const { db } = await import('../src/db.js');
  db().run('UPDATE notify_alerts SET notified_at = ? WHERE source = ?', new Date(Date.now() - ms).toISOString(), `schedule:${sch.id}`);
}
const HOUR = 3_600_000;
const lead = (n: any) => n.body.split('\n')[0] as string;

describe('a 15-minute schedule on change with a 4-hour reminder (the reported case)', () => {
  it('a problem whose numbers change every run is told once, then as a reminder after 4 hours, then as resolved', async () => {
    const sch = await schedule(k8sId, { mode: 'change', reminderHours: 4, resolved: true });
    received.length = 0;
    // the same deployment, not ready all the time: ready count, restarts and pod name change in every run
    const runs: string[] = [];
    for (let n = 0; n < 6; n++) runs.push(await fire(sch, { bad: [dep('shop-prod/web', n)] }));
    const told = await forRuns(runs, 'deployments not fully ready');
    // up to 0.26 every run was "changed" (a different message): six messages in 75 minutes
    expect(told).toHaveLength(1);
    expect(told[0].link).toBe(`/runs/${runs[0]}`);
    expect(lead(told[0])).toMatch(/^Started failing/);

    // four hours after the last message: one reminder with the time it started failing
    await age(sch, 4 * HOUR + 60_000);
    const r7 = await fire(sch, { bad: [dep('shop-prod/web', 7)] });
    const [reminder] = await forRuns([r7], 'deployments not fully ready');
    expect(lead(reminder)).toMatch(/^Still failing \(reminder\) · since /);
    expect(hooks([r7]).map((h) => h.body.data.phase)).toContain('reminder');
    const r8 = await fire(sch, { bad: [dep('shop-prod/web', 8)] });
    expect(await forRuns([r8], 'deployments not fully ready')).toEqual([]);

    // passes again: told as resolved
    const r9 = await fire(sch, { bad: [] });
    expect((await forRuns([r9])).map((n) => n.title).sort()).toEqual([
      'Passes again · All deployments ready – Namespace health',
      'Passes again · Deployments by key – Namespace health',
    ]);
  });

  it('another deployment failing is news and says which; one that recovers is news only with "passes again"', async () => {
    const sch = await schedule(k8sId, { mode: 'change', reminderHours: 4, resolved: false });
    received.length = 0;
    const r1 = await fire(sch, { bad: [dep('shop-prod/web', 1)] });
    const r2 = await fire(sch, { bad: [dep('shop-prod/web', 2), dep('shop-prod/api', 2)] });
    const [added] = await forRuns([r2], 'deployments not fully ready');
    expect(lead(added)).toMatch(/^Now also failing: shop-prod\/api: 2\/3 – api-6c7d8f9b2-bm4rt · failing since /);
    const [hook] = hooks([r2]).filter((h) => h.body.data.check === 'All deployments ready');
    expect(hook.body.data).toMatchObject({ phase: 'changed', added: ['shop-prod/api: 2/3 – api-6c7d8f9b2-bm4rt'] });
    expect(hook.body.data.removed).toBeUndefined();
    // the change key: the same news, named by the key
    const [keyed] = await forRuns([r2], 'Deployments by key');
    expect(lead(keyed)).toMatch(/^Now also failing: shop-prod\/api · failing since /);
    // api recovers (no "passes again"): no message – and failing again in the same period is no news either
    const r3 = await fire(sch, { bad: [dep('shop-prod/web', 3)] });
    const r4 = await fire(sch, { bad: [dep('shop-prod/web', 4), dep('shop-prod/api', 4)] });
    expect(await forRuns([r3, r4])).toEqual([]);
    expect((await forRuns([r1])).length).toBe(2);

    // with "passes again", a recovered deployment is told
    const told = await schedule(k8sId, { mode: 'change', reminderHours: 4, resolved: true });
    await fire(told, { bad: [dep('shop-prod/web', 1), dep('shop-prod/api', 1)] });
    const r6 = await fire(told, { bad: [dep('shop-prod/web', 2)] });
    const [gone] = await forRuns([r6], 'deployments not fully ready');
    expect(lead(gone)).toMatch(/^No longer failing: shop-prod\/api: 1\/3 – api-5f6b8c9d4-qz7xw · the rest has been failing since /);
    expect(hooks([r6]).find((h) => h.body.data.check === 'All deployments ready')!.body.data).toMatchObject({
      phase: 'changed',
      removed: ['shop-prod/api: 1/3 – api-5f6b8c9d4-qz7xw'],
      direction: 'better',
    });
  });

  it('a value that changes is no news on its own; another message beyond its numbers is', async () => {
    const sch = await schedule(plainId, { mode: 'change', reminderHours: 4, resolved: false });
    received.length = 0;
    const runs = [
      await fire(sch, { minutes: 45, what: 'Packaging historian' }),
      await fire(sch, { minutes: 60, what: 'Packaging historian' }),
      await fire(sch, { minutes: 75, what: 'Packaging historian' }),
      await fire(sch, { minutes: 50, what: 'Packaging historian' }),
    ];
    expect((await forRuns(runs)).map((n) => n.link)).toEqual([`/runs/${runs[0]}`]);
    // the message says something else (another source of data): news, in the words of the message
    const r5 = await fire(sch, { minutes: 50, what: 'Filling historian' });
    const [changed] = await forRuns([r5]);
    expect(lead(changed)).toMatch(/^Got better: 75 → 50 · failing since |^Changed · failing since /);
    expect(hooks([r5])[0]!.body.data).toMatchObject({ phase: 'changed', message: 'Filling historian is 50 minutes old' });
  });

  it('another severity is news', async () => {
    const sch = await schedule(plainId, { mode: 'change', reminderHours: 4, resolved: false });
    const r1 = await fire(sch, { minutes: 45, what: 'Packaging historian' });
    // the author raised the severity of the check
    const p = await s.api('GET', `/processes/${plainId}`);
    const def = structuredClone(p.definition);
    def.nodes.find((n: any) => n.id === 'fresh').severity = 'error';
    await s.api('PUT', `/processes/${plainId}`, { definition: def });
    try {
      const r2 = await fire(sch, { minutes: 46, what: 'Packaging historian' });
      const [changed] = await forRuns([r2]);
      expect(changed.title).toBe('Error · Data is fresh – Data freshness');
      expect(lead(changed)).toMatch(/^Severity changed: Warning → Error · failing since /);
      expect(hooks([r2])[0]!.body.data).toMatchObject({ phase: 'changed', previousSeverity: 'warning', severity: 'error' });
      expect(await forRuns([r1])).toHaveLength(1);
    } finally {
      def.nodes.find((n: any) => n.id === 'fresh').severity = 'warning';
      await s.api('PUT', `/processes/${plainId}`, { definition: def });
    }
  });

  it('"only the start and end" and "after every run" keep working as before', async () => {
    const state = await schedule(k8sId, { mode: 'change', reminderHours: 0, resolved: false, change: 'state' });
    const a = [await fire(state, { bad: [dep('shop-prod/web', 1)] }), await fire(state, { bad: [dep('shop-prod/web', 1), dep('shop-prod/api', 1)] })];
    expect((await forRuns(a, 'deployments not fully ready')).map((n) => n.link)).toEqual([`/runs/${a[0]}`]);
    const every = await schedule(k8sId, { mode: 'every', reminderHours: 4, resolved: false });
    const e = [await fire(every, { bad: [dep('shop-prod/web', 1)] }), await fire(every, { bad: [dep('shop-prod/web', 1)] })];
    expect(await forRuns(e, 'deployments not fully ready')).toHaveLength(2);
  });

  it('dry runs keep their own state', async () => {
    const sch = await schedule(k8sId, { mode: 'change', reminderHours: 4, resolved: false });
    const r1 = await fire(sch, { bad: [dep('shop-prod/web', 1)] });
    const d1 = await fire(sch, { bad: [dep('shop-prod/web', 2), dep('shop-prod/api', 2)] }, true);
    const d2 = await fire(sch, { bad: [dep('shop-prod/web', 3), dep('shop-prod/api', 3)] }, true);
    // the dry run starts failing on its own, and its second run is no news
    expect((await forRuns([d1, d2], 'deployments not fully ready')).map((n) => [n.link, n.title, lead(n)])).toEqual([
      [`/runs/${d1}`, 'Dry run – Warning · 2 deployments not fully ready – Namespace health', 'Started failing · 2'],
    ]);
    // the real runs did not learn about api from the dry run: it is news for them
    const r2 = await fire(sch, { bad: [dep('shop-prod/web', 4), dep('shop-prod/api', 4)] });
    expect(lead((await forRuns([r2], 'deployments not fully ready'))[0])).toMatch(/^Now also failing: shop-prod\/api/);
    expect(await forRuns([r1], 'deployments not fully ready')).toHaveLength(1);
  });

  it('after the upgrade, a check that was failing is not told again because of it', async () => {
    const sch = await schedule(k8sId, { mode: 'change', reminderHours: 4, resolved: true });
    await fire(sch, { bad: [dep('shop-prod/web', 1)] });
    // a row as 0.26 left it: no record of what was told
    const { db } = await import('../src/db.js');
    db().run('UPDATE notify_alerts SET told = NULL WHERE source = ?', `schedule:${sch.id}`);
    const r2 = await fire(sch, { bad: [dep('shop-prod/web', 2), dep('shop-prod/api', 2)] });
    expect(await forRuns([r2])).toEqual([]);
    // from now on, it is known
    const r3 = await fire(sch, { bad: [dep('shop-prod/web', 3)] });
    expect(lead((await forRuns([r3], 'deployments not fully ready'))[0])).toMatch(/^No longer failing: shop-prod\/api/);
  });

  it('another line failing is news; a changed ratio is not', async () => {
    const sch = await schedule(k8sId, { mode: 'change', reminderHours: 4, resolved: false });
    // the items of the first check read "<name>: <ready> – <pod>"; use names that differ in a number only
    const r1 = await fire(sch, { bad: [{ name: 'Line 1', ready: '1/3', pod: 'plc' }] });
    const r2 = await fire(sch, {
      bad: [
        { name: 'Line 1', ready: '1/3', pod: 'plc' },
        { name: 'Line 2', ready: '1/3', pod: 'plc' },
      ],
    });
    expect(lead((await forRuns([r2], 'deployments not fully ready'))[0])).toMatch(/^Now also failing: Line 2: /);
    expect(await forRuns([r1], 'deployments not fully ready')).toHaveLength(1);
    // "1/3 ready" becoming "2/3 ready" is no news
    const r3 = await fire(sch, {
      bad: [
        { name: 'Line 1', ready: '2/3', pod: 'plc' },
        { name: 'Line 2', ready: '2/3', pod: 'plc' },
      ],
    });
    expect(await forRuns([r3], 'deployments not fully ready')).toEqual([]);
  });

  it('after the update, items told while they collapsed ("Line 1", "Line 2") are not news by themselves', async () => {
    const sch = await schedule(k8sId, { mode: 'change', reminderHours: 4, resolved: true });
    const bad = [
      { name: 'Line 1', ready: '1/3', pod: 'plc' },
      { name: 'Line 2', ready: '1/3', pod: 'plc' },
    ];
    await fire(sch, { bad });
    // what 0.27.0 stored: the raw items as shown, keys are computed on the fly
    const { db } = await import('../src/db.js');
    const row = db().get('SELECT told FROM notify_alerts WHERE source = ?', `schedule:${sch.id}`) as { told: string } | undefined;
    expect(JSON.stringify(row)).toContain('Line 2: 1/3 – plc');
    const r2 = await fire(sch, { bad });
    expect(await forRuns([r2])).toEqual([]);
  });
});
