import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * One notification policy for every source that repeats runs (#139) and what the messages say (#144): schedules,
 * webhook triggers and the sub-processes of their runs; where (channels), "only start and end", pauses and their end;
 * headline, value with better/worse, items and runbook in the message and the webhook data.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let receiver: http.Server;
const received: { body: any }[] = [];
let processId: string;
let parentId: string;

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  await (await import('../src/notifications/service.js')).flushNotifications();
};
const inbox = async () => ((await s.api('GET', '/notifications?limit=500')) as { items: any[] }).items;
const hooks = () => received.filter((r) => r.body?.event === 'check.failed' || r.body?.event === 'check.resolved');
const forRuns = async (ids: string[]) => (await inbox()).filter((n) => ids.includes(n.link.slice(6)));

beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      received.push({ body: JSON.parse(data || 'null') });
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
  processId = (
    await s.api('POST', '/processes', {
      definition: {
        name: 'Gatus overview',
        runbook: 'https://wiki.example.com/runbooks/gatus',
        inputs: [{ name: 'down', type: 'list' }],
        steps: [
          {
            id: 'healthy',
            type: 'check',
            name: 'All endpoints healthy',
            severity: 'warning',
            condition: '$count(inputs.down) = 0',
            message: "{{ 'Down: ' & $join(inputs.down, ', ') }}",
            headline: '{{ $count(inputs.down) }} of 5 endpoints down',
            value: '$count(inputs.down)',
            items: 'inputs.down',
          },
        ],
      },
    })
  ).id;
  parentId = (
    await s.api('POST', '/processes', {
      definition: {
        name: 'Nightly checks',
        inputs: [{ name: 'down', type: 'list' }],
        steps: [{ id: 'child', type: 'subprocess', name: 'Gatus', process: processId, inputs: { down: '{{ inputs.down }}' } }],
      },
    })
  ).id;
});
afterAll(async () => {
  await s?.app.close();
  receiver?.close();
});

async function schedule(notify?: Record<string, unknown>, proc = processId) {
  return s.api('POST', '/schedules', {
    name: `Gatus ${Math.random().toString(36).slice(2, 7)}`,
    processId: proc,
    cron: '0 3 1 1 *',
    inputs: { down: [] },
    bindings: {},
    enabled: false,
    ...(notify ? { notify } : {}),
  });
}
async function fire(sch: any, down: string[]) {
  await s.api('PUT', `/schedules/${sch.id}`, { name: sch.name, processId: sch.processId, cron: sch.cron, inputs: { down }, bindings: {}, enabled: false });
  const { id } = await s.api('POST', `/schedules/${sch.id}/run`, {});
  await s.waitRun(id, ['succeeded', 'failed']);
  await settle();
  return id as string;
}

describe('notification policy and content', () => {
  it('says what is wrong and which way it changed; the webhook carries the same as data', async () => {
    const sch = await schedule({ mode: 'change', reminderHours: 4, resolved: true });
    received.length = 0;
    const r1 = await fire(sch, ['historian', 'mes']);
    const r2 = await fire(sch, ['historian']);
    const r3 = await fire(sch, []);
    const [first, second] = hooks();
    expect(first!.body.title).toBe('Warning · 2 of 5 endpoints down – Gatus overview');
    expect(first!.body.data).toMatchObject({
      phase: 'new',
      headline: '2 of 5 endpoints down',
      value: 2,
      items: ['historian', 'mes'],
      runbook: 'https://wiki.example.com/runbooks/gatus',
      source: { kind: 'schedule', id: sch.id, name: sch.name },
    });
    expect(second!.body.data).toMatchObject({ phase: 'changed', value: 1, previousValue: 2, direction: 'better' });
    const [better] = await forRuns([r2]);
    expect(better.body).toMatch(/^Got better: 2 → 1 · failing since /);
    expect(better.body).toContain('• historian');
    const [resolved] = await forRuns([r3]);
    expect(resolved.title).toBe('Passes again · All endpoints healthy – Gatus overview');
    expect((await forRuns([r1])).length).toBe(1);
  });

  it('"only start and end": a different result is no news', async () => {
    const sch = await schedule({ mode: 'change', reminderHours: 0, resolved: true, change: 'state' });
    expect(sch.notify.change).toBe('state');
    const ids = [await fire(sch, ['a']), await fire(sch, ['a', 'b']), await fire(sch, ['a', 'b', 'c']), await fire(sch, [])];
    expect((await forRuns(ids)).map((n) => n.title.split(' · ')[0]).sort()).toEqual(['Passes again', 'Warning']);
  });

  it('where: the chosen channels replace the routes', async () => {
    const appOnly = await schedule({ mode: 'every', reminderHours: 4, resolved: false, channels: ['inApp'] });
    received.length = 0;
    const r1 = await fire(appOnly, ['a']);
    expect(await forRuns([r1])).toHaveLength(1);
    expect(hooks()).toHaveLength(0);
    const hookOnly = await schedule({ mode: 'every', reminderHours: 4, resolved: false, channels: ['webhook'] });
    const r2 = await fire(hookOnly, ['a']);
    expect(await forRuns([r2])).toHaveLength(0);
    expect(hooks()).toHaveLength(1);
  });

  it('a pause keeps the messages back (optionally in the app) and its end sends one "still failing"', async () => {
    const sch = await schedule({ mode: 'change', reminderHours: 4, resolved: false });
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const paused = await s.api('POST', `/schedules/${sch.id}/pause`, { until, reason: 'Gatus maintenance', inApp: false });
    expect(paused.notify.pause).toMatchObject({ until, reason: 'Gatus maintenance', inApp: false });
    received.length = 0;
    const r1 = await fire(sch, ['a']);
    expect(await forRuns([r1])).toHaveLength(0);
    expect(hooks()).toHaveLength(0);
    // the run and its check are recorded as always
    const run = await s.api('GET', `/runs/${r1}`);
    expect(run.steps.find((x: any) => x.stepId === 'healthy').status).toBe('failed');
    // saving the schedule (fire) kept the pause; the pause is audited
    const audit = await s.api('GET', `/audit?entityType=schedule&entityId=${sch.id}&limit=10`);
    expect(audit.find((a: any) => a.action === 'schedule.paused').summary).toContain('Gatus maintenance');

    // the pause ends while the check still fails: one message, the schedule resumes on its own
    const { db } = await import('../src/db.js');
    db().run('UPDATE schedules SET notify_pause = ? WHERE id = ?', JSON.stringify({ until: '2000-01-01T00:00:00.000Z', reason: 'x', inApp: false }), sch.id);
    const { checkPauseEnds } = await import('../src/notifications/pause.js');
    expect(checkPauseEnds()).toBe(1);
    await settle();
    expect(hooks().map((h) => h.body.data.phase)).toEqual(['pauseEnded']);
    expect(checkPauseEnds()).toBe(0);
    expect((await s.api('GET', '/schedules')).find((x: any) => x.id === sch.id).notify.pause).toBeNull();
    expect((await s.api('GET', `/audit?entityType=schedule&entityId=${sch.id}&limit=1`))[0]).toMatchObject({ action: 'schedule.resumed', actor: 'system' });

    // in the app only, until resumed
    await s.api('POST', `/schedules/${sch.id}/pause`, { until: null, reason: '', inApp: true });
    received.length = 0;
    const r2 = await fire(sch, ['a', 'b']);
    expect(await forRuns([r2])).toHaveLength(1);
    expect(hooks()).toHaveLength(0);
    await s.api('POST', `/schedules/${sch.id}/resume`, {});
    expect((await s.api('GET', '/schedules')).find((x: any) => x.id === sch.id).notify.pause).toBeNull();
  });

  it('a sub-process follows the source of its parent', async () => {
    const sch = await schedule({ mode: 'change', reminderHours: 0, resolved: false }, parentId);
    const ids = [await fire(sch, ['a']), await fire(sch, ['a'])];
    // the failed check is in the child run; the second run of the schedule is no news
    const childRuns = (await s.api('GET', `/runs?processId=${processId}&limit=50`)).filter((r: any) => ids.includes(r.parentRunId)).map((r: any) => r.id);
    expect(childRuns).toHaveLength(2);
    expect(await forRuns(childRuns)).toHaveLength(1);
  });

  it('webhook triggers notify after every run by default, and take the same policy', async () => {
    const t = await s.api('POST', '/triggers', { name: 'Gatus alert', processId, inputMapping: { down: 'body.down' }, dedupeSeconds: 0, skipIfRunning: false });
    expect(t.trigger.notify).toMatchObject({ mode: 'every' });
    const hook = async (down: string[]) => {
      const res = await fetch(`${s.base}/api/hooks/${t.trigger.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${t.secret}` },
        body: JSON.stringify({ down }),
      });
      const { runId } = (await res.json()) as { runId: string };
      await s.waitRun(runId, ['succeeded', 'failed']);
      await settle();
      return runId;
    };
    const every = [await hook(['a']), await hook(['a'])];
    expect(await forRuns(every)).toHaveLength(2);
    await s.api('PUT', `/triggers/${t.trigger.id}`, {
      name: 'Gatus alert',
      processId,
      inputMapping: { down: 'body.down' },
      dedupeSeconds: 0,
      skipIfRunning: false,
      notify: { mode: 'change', reminderHours: 0, resolved: false },
    });
    const change = [await hook(['a']), await hook(['a'])];
    expect(await forRuns(change)).toHaveLength(1);
    const p = await s.api('POST', `/triggers/${t.trigger.id}/pause`, { until: null, reason: 'noisy', inApp: false });
    expect(p.notify.pause).toMatchObject({ reason: 'noisy' });
    expect((await s.api('GET', `/audit?entityType=trigger&entityId=${t.trigger.id}&limit=1`))[0].action).toBe('trigger.paused');
    // saving what was read (with the pause in it) works and keeps the pause
    const read = await s.api('GET', `/triggers/${t.trigger.id}`);
    const {
      id: _id,
      owner: _o,
      processName: _p,
      path: _path,
      secretPrefix: _sp,
      secretRotatedAt: _sr,
      createdAt: _c,
      updatedAt: _u,
      lastFiredAt: _lf,
      lastRunId: _lr,
      lastRunStatus: _ls,
      lastResult: _lres,
      fireCount: _fc,
      rejectedCount: _rc,
      lastRejectedAt: _la,
      lastRejectedReason: _lrr,
      canEdit: _ce,
      ...settings
    } = read;
    const saved = await s.api('PUT', `/triggers/${t.trigger.id}`, { ...settings, notify: { ...read.notify, pause: null } });
    expect(saved.notify.pause).toMatchObject({ reason: 'noisy' });
  });

  it('a monitor output keeps its policy (and its pause) in the definition', async () => {
    const { monitor } = await s.api('POST', '/monitors', {
      definition: {
        name: 'Gatus host',
        checks: [{ id: 'hb', name: 'Report', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600 }],
        outputs: [
          {
            id: 'diagnose',
            type: 'process',
            processId,
            notify: { mode: 'change', reminderHours: 24, resolved: true, change: 'state', pause: { until: null, reason: 'migration', inApp: true } },
          },
          { id: 'other', type: 'process', processId },
        ],
      },
    });
    const { sourceByKey } = await import('../src/engine/notify-source.js');
    const src = sourceByKey(`monitor:${monitor.id}:diagnose`)!;
    expect(src).toMatchObject({ kind: 'monitor', name: 'Gatus host → diagnose', owner: 'admin' });
    expect(src.policy).toMatchObject({ mode: 'change', reminderHours: 24, change: 'state', channels: null, pause: { reason: 'migration' } });
    // without a policy: after every run, as before
    expect(sourceByKey(`monitor:${monitor.id}:other`)!.policy).toMatchObject({ mode: 'every', pause: null });
    expect(sourceByKey('monitor:mon_missing:diagnose')).toBeNull();
  });

  it('e-mail and Teams show the facts, the items, the runbook and why the reader got it', async () => {
    const { emailContent, teamsCard } = await import('../src/notifications/channels.js');
    const msg = {
      event: 'check.failed',
      title: 'Warning · 11 of 58 endpoints down – Status',
      body: 'Warning: Down: a, b',
      locale: 'en' as const,
      link: 'https://steward.example.com/runs/run_1',
      ts: new Date().toISOString(),
      data: {},
      parts: {
        lead: 'Got better: 12 → 11 · failing since Oct 27',
        facts: [{ label: 'Process', value: 'Status <IntRAnet>' }],
        items: { list: ['historian', 'mes'], more: 9 },
        actions: [{ label: 'Open runbook', href: 'https://wiki.example.com/rb' }],
        reason: 'You get this because you own the schedule “Gatus overview”.',
        settings: { label: 'Message settings of the schedule', href: 'https://steward.example.com/schedules?edit=sch_1' },
      },
    };
    const mail = emailContent(msg);
    expect(mail.subject).toContain('Warning · 11 of 58 endpoints down – Status');
    expect(mail.html).toContain('Got better: 12 → 11');
    expect(mail.html).toContain('Status &lt;IntRAnet&gt;');
    expect(mail.html).toContain('<li style="margin:0 0 2px">historian</li>');
    expect(mail.html).toContain('+ 9 more');
    expect(mail.html).toContain('href="https://wiki.example.com/rb"');
    expect(mail.html).toContain('you own the schedule');
    expect(mail.text).toContain('• mes');
    const card = JSON.stringify(teamsCard(msg));
    expect(card).toContain('"type":"FactSet"');
    expect(card).toContain('Open runbook');
    expect(card).toContain('Message settings of the schedule');
  });
});
