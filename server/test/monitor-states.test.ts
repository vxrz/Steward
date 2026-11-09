import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closestRow,
  evaluateStates,
  monitorDefinitionSchema,
  selectState,
  stateIssues,
  tryStates,
  type MonitorDefinition,
  type MonitorStatus,
  type StateMemory,
} from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

// the engine is driven by the tests (clock, evaluations), not by its own timer
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

/**
 * Monitor states (0.13, ADR 0021): the decision table as pure logic, and the engine with realistic lag – data paths that
 * go stale minutes after a power-off and come back minutes after a power-on.
 */

const MIN = 60000;
const def = (d: unknown): MonitorDefinition => monitorDefinitionSchema.parse(d);
const st = (o: Record<string, MonitorStatus>) => new Map(Object.entries(o));

/** The machine of ADR 0021 in small: the selector (ping), two data paths, the machine data and the gateway. */
const MACHINE = def({
  name: 'Press 4 – PowerMeter',
  checks: [
    { id: 'pm', name: 'PowerMeter reachable', type: 'tcp', host: 'x', port: 1 },
    { id: 'data', name: 'PowerMeter data', type: 'heartbeat', mode: 'cadence', expectedIntervalSeconds: 60, downAfterMissed: 4 },
    { id: 'ih', name: 'PowerMeter data in Insights Hub', type: 'heartbeat', mode: 'cadence', expectedIntervalSeconds: 60, downAfterMissed: 6 },
    { id: 'machine', name: 'Machine data flow', type: 'monitor', monitor: 'm' },
    { id: 'gw', name: 'Gateway alive', type: 'monitor', monitor: 'g' },
  ],
  links: [
    { from: 'gw', to: 'data' },
    { from: 'data', to: 'ih' },
  ],
  states: {
    cases: [
      { id: 'running', name: 'Running', when: { pm: 'up' }, expect: { gw: 'up', data: 'up', ih: 'up', machine: 'up' } },
      { id: 'off', name: 'Off', status: 'off', when: { pm: 'down' }, requires: ['gw'], expect: { data: 'down', ih: 'down', machine: 'off' } },
    ],
  },
});
const settled = (id: string | null): StateMemory => ({ id, since: 0, settleUntil: null, changes: [] });

describe('decision table (pure)', () => {
  it('the first row whose condition matches wins; a row without a match is Otherwise', () => {
    expect(selectState(MACHINE, st({ pm: 'up', data: 'up', ih: 'up', machine: 'up', gw: 'up' }), null).row?.id).toBe('running');
    expect(selectState(MACHINE, st({ pm: 'down', data: 'down', ih: 'down', machine: 'off', gw: 'up' }), null).row?.id).toBe('off');
    // two rows whose conditions both match: the first one
    const two = def({
      ...MACHINE,
      states: {
        cases: [
          { id: 'a', when: { pm: 'any', data: 'up' } },
          { id: 'b', when: { data: 'up' } },
        ],
      },
    });
    expect(selectState(two, st({ pm: 'down', data: 'up' }), null).row?.id).toBe('a');
    // nothing matches: Otherwise (today's evaluation)
    expect(selectState(two, st({ pm: 'up', data: 'down' }), null).row).toBeNull();
    // "any" never selects
    expect(selectState(def({ ...MACHINE, states: { cases: [{ id: 'a', when: { pm: 'any' } }] } }), st({ pm: 'up' }), null).row).toBeNull();
  });

  it('unknown confirms nothing: it keeps the current state and never selects another; blocked counts as down', () => {
    const s = st({ pm: 'unknown', data: 'down', ih: 'down', machine: 'off', gw: 'up' });
    expect(selectState(MACHINE, s, 'off').row?.id).toBe('off');
    expect(selectState(MACHINE, s, null).row).toBeNull();
    expect(selectState(MACHINE, s, 'running').row?.id).toBe('running');
    // a blocked check (its hard parent is down) agrees with down
    const r = evaluateStates({
      def: MACHINE,
      statuses: st({ pm: 'down', data: 'blocked', ih: 'down', machine: 'off', gw: 'up' }),
      memory: settled('off'),
      now: 1,
    });
    expect(r.status).toBe('off');
    expect(r.info.cells.find((c) => c.checkId === 'data')!.verdict).toBe('agrees');
    // an unknown expectation is "not checked": the state holds, with the note; all unknown: unknown
    const u = evaluateStates({
      def: MACHINE,
      statuses: st({ pm: 'down', data: 'unknown', ih: 'down', machine: 'off', gw: 'up' }),
      memory: settled('off'),
      now: 1,
    });
    expect(u.status).toBe('off');
    expect(u.info.unknownChecks).toBe(1);
    expect(u.info.message).toMatch(/1 check could not be checked/);
    const all = evaluateStates({
      def: MACHINE,
      statuses: st({ pm: 'down', data: 'unknown', ih: 'unknown', machine: 'unknown', gw: 'up' }),
      memory: settled('off'),
      now: 1,
    });
    expect(all.status).toBe('unknown');
  });

  it('agreement is off (checks that agree with down show off); up rows aggregate the checks expected up', () => {
    const off = evaluateStates({
      def: MACHINE,
      statuses: st({ pm: 'down', data: 'down', ih: 'down', machine: 'off', gw: 'up' }),
      memory: settled('off'),
      now: 1,
    });
    expect(off.status).toBe('off');
    expect([...off.offChecks].sort()).toEqual(['data', 'ih', 'machine', 'pm']);
    expect(off.causes).toEqual([]);
    expect(off.info.reason).toBe('agree');
    const run = evaluateStates({
      def: MACHINE,
      statuses: st({ pm: 'up', data: 'degraded', ih: 'up', machine: 'up', gw: 'up' }),
      memory: settled('running'),
      now: 1,
    });
    expect(run.status).toBe('degraded'); // a degraded check still degrades
  });

  it('a required check that is not up: down at once, no settle time, the required check is the root cause', () => {
    const r = evaluateStates({
      def: MACHINE,
      statuses: st({ pm: 'down', data: 'down', ih: 'down', machine: 'off', gw: 'down' }),
      memory: { id: 'off', since: 0, settleUntil: 10 * MIN, changes: [] },
      now: MIN,
    });
    expect(r.status).toBe('down');
    expect(r.causes).toEqual(['gw']);
    expect(r.info.reason).toBe('required');
    expect(r.info.message).toBe('Gateway alive is silent – Off cannot be told from an outage');
  });

  it('the root cause of a contradiction is the deviating cells of the closest row (the selected row wins a tie)', () => {
    // PowerMeter unreachable, but its data still arrives: Off is selected, Running is closest → the ping is to blame
    const a = st({ pm: 'down', data: 'up', ih: 'up', machine: 'up', gw: 'up' });
    expect(closestRow(MACHINE, a, MACHINE.states!.cases[1]!)?.id).toBe('running');
    const r = evaluateStates({ def: MACHINE, statuses: a, memory: settled('off'), now: 1 });
    expect(r.status).toBe('down');
    expect(r.causes).toEqual(['pm']);
    expect(r.info.message).toBe('PowerMeter reachable is down, but 4 checks say Running');
    // PowerMeter reachable, machine data missing: Running is selected and closest → the machine data
    const b = evaluateStates({ def: MACHINE, statuses: st({ pm: 'up', data: 'up', ih: 'up', machine: 'down', gw: 'up' }), memory: settled('running'), now: 1 });
    expect(b.causes).toEqual(['machine']);
    expect(b.info.message).toBe('Running, but Machine data flow is down');
    expect(b.info.contradiction).toMatchObject({ closest: 'running', checks: [{ checkId: 'machine', expected: 'up', actual: 'down' }] });
    // a tie: one deviation each – the selected row (Off) wins
    const c = evaluateStates({ def: MACHINE, statuses: st({ pm: 'down', data: 'down', ih: 'up', machine: 'off', gw: 'up' }), memory: settled('off'), now: 1 });
    expect(c.info.contradiction?.closest).toBe('off');
    expect(c.causes).toEqual(['ih']);
    // degraded instead of down: the row says so, or the deviating check is not critical
    const soft = def({ ...MACHINE, states: { cases: MACHINE.states!.cases.map((x) => ({ ...x, contradiction: 'degraded' as const })) } });
    expect(
      evaluateStates({ def: soft, statuses: st({ pm: 'up', data: 'up', ih: 'up', machine: 'down', gw: 'up' }), memory: settled('running'), now: 1 }).status,
    ).toBe('degraded');
  });

  it('settle time: derived from the expected checks, deviations do not count until it ends, a change restarts it', () => {
    const sub = () => 720; // the machine data's own checks (sub-monitor column)
    const r = evaluateStates({
      def: MACHINE,
      statuses: st({ pm: 'down', data: 'up', ih: 'up', machine: 'up', gw: 'up' }),
      memory: settled('running'),
      now: 100 * MIN,
      subSettle: sub,
    });
    // data: 4 × 60 + 2 × 60 = 360; ih: 6 × 60 + 120 = 480; machine 720 → 12 minutes
    expect(r.changed).toBe(true);
    expect(r.memory.settleUntil).toBe(100 * MIN + 720000);
    expect(r.status).toBe('off');
    expect(r.info.reason).toBe('settling');
    expect(r.info.cells.filter((c) => c.verdict === 'settling').map((c) => c.checkId)).toEqual(['data', 'ih', 'machine']);
    const later = evaluateStates({
      def: MACHINE,
      statuses: st({ pm: 'down', data: 'up', ih: 'up', machine: 'up', gw: 'up' }),
      memory: r.memory,
      now: 112 * MIN,
    });
    expect(later.status).toBe('down');
    // an override per row
    const fixed = def({ ...MACHINE, states: { cases: [MACHINE.states!.cases[0]!, { ...MACHINE.states!.cases[1]!, settleSeconds: 120 }] } });
    expect(evaluateStates({ def: fixed, statuses: st({ pm: 'down' }), memory: settled('running'), now: 0 }).memory.settleUntil).toBe(120000);
  });

  it('more than 4 state changes within an hour make the monitor degraded', () => {
    let memory: StateMemory = settled('running');
    let last;
    for (let i = 1; i <= 6; i++) {
      last = evaluateStates({
        def: MACHINE,
        statuses: st(i % 2 ? { pm: 'down', data: 'down', ih: 'down', machine: 'off', gw: 'up' } : { pm: 'up', data: 'up', ih: 'up', machine: 'up', gw: 'up' }),
        memory,
        now: i * 2 * MIN,
      });
      memory = last.memory;
    }
    expect(last!.info.changesLastHour).toBe(6);
    expect(last!.status).toBe('degraded');
    expect(last!.info.message).toBe('Changes state too often: 6 times in the last hour');
    // an hour later with fewer changes: no longer
    expect(evaluateStates({ def: MACHINE, statuses: st({ pm: 'up', data: 'up', ih: 'up', machine: 'up', gw: 'up' }), memory, now: 80 * MIN }).status).toBe(
      'up',
    );
  });

  it('maximum off time: from when the state became off, planned downtime not counted; 0 = no maximum', () => {
    const s = st({ pm: 'down', data: 'down', ih: 'down', machine: 'off', gw: 'up' });
    const mem: StateMemory = { id: 'off', since: 0, settleUntil: 12 * MIN, changes: [] };
    expect(evaluateStates({ def: MACHINE, statuses: s, memory: mem, now: 8 * 60 * MIN - MIN }).status).toBe('off');
    const over = evaluateStates({ def: MACHINE, statuses: s, memory: mem, now: 9 * 60 * MIN });
    expect(over.status).toBe('degraded');
    expect(over.info.message).toBe('Off for longer than expected (9 h, maximum 8 h)');
    // a weekend window of 3 hours within: 6 hours off
    expect(evaluateStates({ def: MACHINE, statuses: s, memory: mem, now: 9 * 60 * MIN, downtime: { active: false, msSince: () => 3 * 60 * MIN } }).status).toBe(
      'off',
    );
    // while planned downtime lasts: never degraded for the maximum
    expect(evaluateStates({ def: MACHINE, statuses: s, memory: mem, now: 30 * 60 * MIN, downtime: { active: true, msSince: () => 0 } }).status).toBe('off');
    const none = def({ ...MACHINE, states: { ...MACHINE.states!, maxOffHours: 0 } });
    expect(evaluateStates({ def: none, statuses: s, memory: mem, now: 300 * 60 * MIN }).status).toBe('off');
  });

  it('followers take the leader state; Try it gives the settled answer', () => {
    const f = def({
      name: 'Machine data',
      checks: [{ id: 'reports', name: 'Reports', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600 }],
      states: {
        from: 'leader',
        cases: [
          { id: 'running', expect: { reports: 'up' } },
          { id: 'off', status: 'off', expect: { reports: 'down' } },
        ],
      },
    });
    expect(evaluateStates({ def: f, statuses: st({ reports: 'down' }), memory: settled('running'), now: 1, leaderState: 'off' }).status).toBe('off');
    expect(evaluateStates({ def: f, statuses: st({ reports: 'down' }), memory: settled(null), now: 1, leaderState: null }).status).toBeNull();
    expect(tryStates(MACHINE, { pm: 'down', data: 'up', ih: 'up', machine: 'up', gw: 'up' }).status).toBe('down');
    expect(tryStates(MACHINE, { pm: 'down', data: 'down', ih: 'down', machine: 'off', gw: 'up' }).status).toBe('off');
  });

  it('rules when saving: unique ids, known checks, a condition per row, off only on sub-monitors, rows that never match', () => {
    const bad = def({
      ...MACHINE,
      states: {
        cases: [
          { id: 'a', when: { pm: 'up' } },
          { id: 'a', when: { nope: 'up' } },
          { id: 'c', expect: { data: 'off' } },
          { id: 'd', when: { pm: 'up', data: 'down' } },
          { id: 'e', when: { data: 'up' }, requires: ['data'] },
        ],
      },
    });
    const msgs = stateIssues(bad).map((i) => `${i.path}${i.warning ? ' (warning)' : ''}: ${i.message}`);
    expect(msgs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/states\.cases\.4\.requires: a required check is no other cell/),
        expect.stringMatching(/states\.cases\.1\.id: duplicate state id "a"/),
        expect.stringMatching(/states\.cases\.1\.when\.nope: unknown check "nope"/),
        expect.stringMatching(/states\.cases\.2\.expect\.data: off is only for sub-monitor checks/),
        expect.stringMatching(/states\.cases\.2\.when: a state needs at least one condition cell/),
        expect.stringMatching(/states\.cases\.3\.when \(warning\): this state can never match/),
      ]),
    );
  });

  it('a definition without states gives exactly the analysis it gave before (random graphs and statuses)', async () => {
    const { analyze } = await import('../src/monitors/logic.js');
    const STATUSES: MonitorStatus[] = ['up', 'degraded', 'down', 'unknown', 'blocked'];
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
    for (let round = 0; round < 300; round++) {
      const n = 2 + rnd(6);
      const ids = Array.from({ length: n }, (_, i) => `c${i}`);
      const links = ids.flatMap((to, j) => (j > 0 && rnd(2) ? [{ from: ids[rnd(j)]!, to, mode: rnd(3) ? 'soft' : 'hard' }] : []));
      const rule = (['worst', 'critical', 'quorum'] as const)[rnd(3)]!;
      const d = def({
        name: 'random',
        aggregate: { rule, quorum: rule === 'quorum' ? 1 + rnd(n) : undefined },
        checks: ids.map((id) => ({ id, name: id, type: 'tcp', host: 'x', port: 1, critical: rnd(4) !== 0 })),
        links,
      });
      const statuses = new Map(ids.map((id) => [id, STATUSES[rnd(STATUSES.length)]!]));
      const m = { id: 'm', key: 'm', name: 'M', def: d };
      const before = analyze(m, statuses, { maintenance: rnd(5) === 0 });
      // the engine passes the states context to every monitor: without states (or with an empty table) nothing changes
      const ctx = { memory: null, now: 1 };
      expect(analyze(m, statuses, { maintenance: before.status === 'maintenance', states: ctx })).toEqual(before);
      expect(analyze({ ...m, def: { ...d, states: { cases: [] } } }, statuses, { maintenance: before.status === 'maintenance', states: ctx })).toEqual(before);
    }
  });
});

// ---------------------------------------------------------------------------
// engine simulations

let s: TestServer;
let olivia: Client;
let eng: typeof import('../src/monitors/engine.js');
let D: typeof import('../src/db.js');
const PW = 'Demo-password-1';

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  olivia = await s.as('olivia', PW);
  eng = await import('../src/monitors/engine.js');
  D = await import('../src/db.js');
});
afterAll(async () => {
  eng?.setMonitorClock(null);
  await s?.app.close();
});

const iso = (t: number) => new Date(t).toISOString();
/** A heartbeat report as the gateway would send it, stored at the simulated time T. */
function push(mid: string, cid: string, T: number, report: Record<string, unknown> = { value: 1 }) {
  D.db().run('UPDATE monitor_checks SET last_push_at = ?, last_push = ? WHERE monitor_id = ? AND check_id = ?', iso(T), JSON.stringify(report), mid, cid);
}
async function get(id: string) {
  return s.api('GET', `/monitors/${id}`);
}
async function notes(id: string, event = 'monitor.status') {
  return (await olivia('GET', '/notifications?limit=200')).items.filter((x: any) => x.event === event && x.link.startsWith(`/monitors/${id}`));
}

describe('engine: a machine switched off and on, with realistic lag', () => {
  // gateway (sub-monitor, required), the machine data (follows the PowerMeter monitor), the PowerMeter monitor
  let gw: any, data: any, press: any;
  let T0 = 0;
  /** What arrives each minute (true: the data path reports). */
  const live = { gw: true, pm: true, data: true, ih: true, reports: true };
  const received: any[] = [];
  let web: http.Server;

  /** One minute of the plant at T: reports arrive, every check is evaluated (gateway, machine data, PowerMeter). */
  async function minute(T: number) {
    eng.setMonitorClock(() => T);
    if (live.gw) push(gw.id, 'alive', T);
    push(press.id, 'pm', T, { status: live.pm ? 'up' : 'down' });
    if (live.data) push(press.id, 'data', T);
    if (live.ih) push(press.id, 'ih', T);
    if (live.reports) push(data.id, 'reports', T);
    for (const id of [gw.id, data.id, press.id]) await eng.evaluateMonitorNow(id);
    await eng.settle();
    return get(press.id);
  }
  async function run(from: number, to: number, each?: (t: number, m: any) => void | Promise<void>) {
    let m: any;
    for (let t = from; t <= to; t++) {
      m = await minute(T0 + t * MIN);
      await each?.(t, m);
    }
    return m;
  }

  beforeAll(async () => {
    web = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        received.push(JSON.parse(b || 'null'));
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
    const hook = `http://127.0.0.1:${(web.address() as net.AddressInfo).port}/hook`;
    gw = (
      await s.api('POST', '/monitors', {
        key: 'test-gw-hall9',
        definition: { name: 'Gateway Hall 9', checks: [{ id: 'alive', name: 'Gateway alive', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 180 }] },
      })
    ).monitor;
    data = (
      await s.api('POST', '/monitors', {
        key: 'test-press4-data',
        definition: {
          name: 'Press 4 – machine data',
          checks: [{ id: 'reports', name: 'Machine data reported', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600 }],
        },
      })
    ).monitor;
    press = (
      await s.api('POST', '/monitors', {
        key: 'test-press4',
        definition: {
          name: 'Press 4 – PowerMeter',
          checks: [
            { id: 'pm', name: 'PowerMeter reachable', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 3600 },
            { id: 'data', name: 'PowerMeter data', type: 'heartbeat', mode: 'cadence', expectedIntervalSeconds: 60, downAfterMissed: 4 },
            { id: 'ih', name: 'PowerMeter data in Insights Hub', type: 'heartbeat', mode: 'cadence', expectedIntervalSeconds: 60, downAfterMissed: 6 },
            { id: 'machine', name: 'Machine data flow', type: 'monitor', monitor: 'test-press4-data' },
            { id: 'gw', name: 'Gateway Hall 9 alive', type: 'monitor', monitor: 'test-gw-hall9' },
          ],
          links: [
            { from: 'gw', to: 'data' },
            { from: 'gw', to: 'machine' },
          ],
          outputs: [
            { id: 'notify', type: 'notification', subscribers: ['user:olivia'], stateChanges: true },
            { id: 'web', type: 'webhook', url: hook, include: 'monitor' },
          ],
          states: {
            cases: [
              { id: 'running', name: 'Running', when: { pm: 'up' }, expect: { gw: 'up', data: 'up', ih: 'up', machine: 'up' } },
              { id: 'off', name: 'Off', status: 'off', when: { pm: 'down' }, requires: ['gw'], expect: { data: 'down', ih: 'down', machine: 'off' } },
            ],
          },
        },
      })
    ).monitor;
    // the machine data follows the PowerMeter monitor's state
    const dd = (await get(data.id)).definition;
    await s.api('PUT', `/monitors/${data.id}`, {
      definition: {
        ...dd,
        states: {
          from: 'test-press4',
          cases: [
            { id: 'running', expect: { reports: 'up' } },
            { id: 'off', status: 'off', expect: { reports: 'down' } },
          ],
        },
      },
    });
    T0 = Math.ceil(Date.now() / MIN) * MIN + 5 * MIN;
  });
  afterAll(() => web?.close());

  it('runs: up, state Running', async () => {
    const m = await run(0, 3);
    expect(m.status).toBe('up');
    expect(m.state).toMatchObject({ id: 'running', name: 'Running' });
    expect((await get(data.id)).state.id).toBe('running');
  });

  it('power-off: the ping fails at once, data paths go stale minutes later – no down and no alert during the settle time', async () => {
    live.pm = false;
    live.data = false;
    const seen: string[] = [];
    // the Insights Hub path lags 3 minutes, the machine data stops with the machine
    const m = await run(4, 20, (t, x) => {
      if (t === 7) live.ih = false;
      if (t === 4) live.reports = false;
      seen.push(x.status);
    });
    expect(seen).not.toContain('down');
    expect(seen).not.toContain('degraded');
    // one failure is not confirmed: the state changes with the second (failuresBeforeDown 2)
    expect(seen[0]).toBe('up');
    expect(seen.slice(1).every((x) => x === 'off')).toBe(true);
    expect(m.state).toMatchObject({ id: 'off', reason: 'agree' });
    expect(m.checks.map((c: any) => `${c.checkId}:${c.status}`)).toEqual(['pm:off', 'data:off', 'ih:off', 'machine:off', 'gw:up']);
    expect(m.rootCauses).toEqual([]);
    // the follower is off too
    expect((await get(data.id)).status).toBe('off');
    // off is never an alert; the state change is information (opt-in)
    expect(await notes(press.id)).toEqual([]);
    const info = await notes(press.id, 'monitor.state');
    expect(info.map((n: any) => n.title)).toEqual(['Press 4 – PowerMeter: Running → Off']);
    // history: the state change is recorded with the state
    const hist = await s.api('GET', `/monitors/${press.id}/history?check=`);
    expect(hist[0]).toMatchObject({ status: 'off', state: 'off' });
    // webhook: code 6 and the state
    const ev = received.flatMap((b) => b.events).find((e: any) => e.status === 'off');
    expect(ev).toMatchObject({ statusCode: 6, state: { id: 'off', name: 'Off' } });
  });

  it('power-on: the ping first, data 3 and 8 minutes later – no alert', async () => {
    live.pm = true;
    const seen: string[] = [];
    const m = await run(21, 35, (t, x) => {
      if (t === 24) live.data = true;
      if (t === 29) live.ih = true;
      if (t === 30) live.reports = true;
      seen.push(x.status);
    });
    expect(seen.every((x) => x === 'up')).toBe(true);
    expect(m.state).toMatchObject({ id: 'running', reason: 'agree' });
    expect(await notes(press.id)).toEqual([]);
  });

  it('power-off where the Insights Hub data keeps arriving: off while settling, a contradiction exactly when the settle time ends', async () => {
    live.pm = false;
    live.data = false;
    live.reports = false;
    const at: Record<number, any> = {};
    await run(36, 50, (t, x) => {
      at[t] = x;
    });
    // the state became Off at minute 37 (second failure); settle 12 minutes (the machine data: 600 s + 2 × 60 s)
    expect(at[37].state).toMatchObject({ id: 'off' });
    expect(Date.parse(at[37].state.settlingUntil) - (T0 + 37 * MIN)).toBe(12 * MIN);
    expect(at[48].status).toBe('off');
    expect(at[48].state.reason).toBe('settling');
    expect(at[49].status).toBe('down');
    expect(at[49].state.reason).toBe('contradiction');
    expect(at[49].rootCauses.map((c: any) => c.checkId)).toEqual(['ih']);
    expect(at[49].state.message).toBe('Off, but PowerMeter data in Insights Hub is up');
    const n = await notes(press.id);
    expect(n).toHaveLength(1);
    expect(n[0].title).toBe('Down: Press 4 – PowerMeter');
    expect(n[0].body).toMatch(/Root cause: PowerMeter data in Insights Hub\. Off, but PowerMeter data in Insights Hub is up/);
    // the Insights Hub data stops too: everything agrees, sent as a recovery
    live.ih = false;
    const m = await run(51, 60);
    expect(m.status).toBe('off');
    const after = await notes(press.id);
    expect(after.map((x: any) => x.title)).toEqual(['Off: Press 4 – PowerMeter', 'Down: Press 4 – PowerMeter']);
  });

  it('the gateway goes silent while off: down at once, the gateway is the root cause', async () => {
    live.gw = false;
    const seen: Record<number, any> = {};
    await run(61, 66, (t, x) => {
      seen[t] = x;
    });
    // maximum age 180 s: the gateway check fails after 3 minutes (+2 confirmations); the machine follows at once
    const down = Object.entries(seen).find(([, x]) => x.status === 'down');
    expect(down).toBeTruthy();
    const x = down![1];
    expect(x.state.reason).toBe('required');
    expect(x.state.message).toBe('Gateway Hall 9 alive is silent – Off cannot be told from an outage');
    expect(x.rootCauses).toEqual([expect.objectContaining({ monitorId: gw.id, checkId: 'alive' })]);
    live.gw = true;
    const back = await run(67, 69);
    expect(back.status).toBe('off');
  });

  it('off for longer than the maximum: degraded and one notification; planned downtime suspends it', async () => {
    // 8 hours after the state became off – the state survives restarts (stored), so the clock jumps
    const before = (await notes(press.id)).length;
    const offAt = Math.round((Date.parse((await get(press.id)).state.since) - T0) / MIN);
    let m = await run(offAt + 8 * 60 + 1, offAt + 8 * 60 + 3);
    expect(m.status).toBe('degraded');
    expect(m.state.reason).toBe('maxOff');
    expect(m.state.message).toMatch(/^Off for longer than expected \(8 h, maximum 8 h\)$/);
    const n = await notes(press.id);
    expect(n.length).toBe(before + 1);
    expect(n[0].title).toBe('Warning: Press 4 – PowerMeter');
    // planned downtime over the last 10 hours: the maximum does not count, nothing new is sent but the recovery to off
    const w = await s.api('POST', '/maintenance-windows', {
      kind: 'downtime',
      title: 'Weekend (test)',
      startsAt: iso(T0 + offAt * MIN + 30 * MIN),
      endsAt: iso(T0 + offAt * MIN + 14 * 60 * MIN),
      targets: [{ kind: 'monitor', id: press.id }],
    });
    expect(w).toMatchObject({ kind: 'downtime', reminderHours: 0 });
    m = await run(offAt + 8 * 60 + 4, offAt + 8 * 60 + 5);
    expect(m.status).toBe('off');
    expect(m.maintenance).toBeNull();
    expect(m.state.plannedDowntime).toBe(true);
    // a contradiction during planned downtime still alerts
    live.data = true;
    m = await run(offAt + 8 * 60 + 6, offAt + 8 * 60 + 8);
    expect(m.status).toBe('down');
    expect((await notes(press.id))[0].title).toBe('Down: Press 4 – PowerMeter');
    live.data = false;
    await run(offAt + 8 * 60 + 9, offAt + 8 * 60 + 15);
    await s.api('POST', `/maintenance-windows/${w.id}/cancel`, { reason: 'test' }).catch(() => undefined);
  });

  it('a state that changes more than 4 times within an hour: degraded "Changes state too often"', async () => {
    const base = 80 + 9 * 60;
    let m: any;
    for (let i = 0; i < 6; i++) {
      // up for one minute, down for two (confirmed by the second failure)
      live.pm = true;
      await minute(T0 + (base + i * 3) * MIN);
      live.pm = false;
      await minute(T0 + (base + i * 3 + 1) * MIN);
      m = await minute(T0 + (base + i * 3 + 2) * MIN);
    }
    expect(m.state.changesLastHour).toBeGreaterThan(4);
    expect(['degraded', 'down']).toContain(m.status);
    if (m.status === 'degraded') expect(m.state.message).toMatch(/^Changes state too often: \d+ times in the last hour$/);
  });

  it('one lost ping does not change the state (flapping control of the selector)', async () => {
    // back to a steady Running
    live.pm = true;
    live.data = true;
    live.ih = true;
    live.reports = true;
    const base = 80 + 11 * 60;
    await run(base, base + 15);
    const was = await get(press.id);
    expect(was.state.id).toBe('running');
    live.pm = false;
    let m = await minute(T0 + (base + 16) * MIN);
    expect(m.state.id).toBe('running');
    live.pm = true;
    m = await minute(T0 + (base + 17) * MIN);
    expect(m.state.id).toBe('running');
    expect(m.state.since).toBe(was.state.since);
  });

  it('a leader whose condition uses a monitor that follows it is refused (STATES_CYCLE)', async () => {
    const p = (await get(press.id)).definition;
    const cases = p.states.cases.map((c: any) =>
      c.id === 'running' ? { ...c, when: { pm: 'up', machine: 'up' }, expect: { gw: 'up', data: 'up', ih: 'up' } } : c,
    );
    await expect(s.api('PUT', `/monitors/${press.id}`, { definition: { ...p, states: { ...p.states, cases } } })).rejects.toThrow(/depend on each other/);
    // following itself
    const d = (await get(data.id)).definition;
    await expect(s.api('PUT', `/monitors/${data.id}`, { definition: { ...d, states: { ...d.states, from: 'test-press4-data' } } })).rejects.toThrow(
      /cannot follow itself/,
    );
  });

  it('YAML export and import keep the states (the leader by key)', async () => {
    const yaml = await s.api('GET', `/monitors/${data.id}/export`);
    expect(String(yaml)).toMatch(/states:\n {2}from: test-press4\n/);
    const copy = await s.api('POST', '/monitors/import', { yaml: String(yaml).replace('key: test-press4-data', 'key: test-press4-data-copy') });
    expect(copy.monitor.definition.states).toMatchObject({ from: press.id, cases: [{ id: 'running' }, { id: 'off', status: 'off' }] });
  });
});

describe('outputs while off', () => {
  /** A monitor whose PowerMeter and data are both down: off, every check agreeing. */
  async function offMonitor(key: string, outputs: unknown[], T: number, beforeEval?: () => Promise<void>) {
    const r = await s.api('POST', '/monitors', {
      key,
      definition: {
        name: `Lathe 7 – PowerMeter (${key})`,
        failuresBeforeDown: 1,
        checks: [
          { id: 'pm', name: 'PowerMeter reachable', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 3600 },
          { id: 'data', name: 'PowerMeter data', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 3600 },
        ],
        outputs,
        states: {
          cases: [
            { id: 'running', name: 'Running', when: { pm: 'up' }, expect: { data: 'up' } },
            { id: 'off', name: 'Off', status: 'off', when: { pm: 'down' }, expect: { data: 'down' }, settleSeconds: 60 },
          ],
        },
      },
    });
    const id = r.monitor.id;
    await eng.settle();
    await beforeEval?.();
    eng.setMonitorClock(() => T);
    push(id, 'pm', T, { status: 'down' });
    push(id, 'data', T, { status: 'down' });
    await eng.evaluateMonitorNow(id);
    expect((await get(id)).status).toBe('off');
    return id;
  }

  it('Gatus while off: success (default), failure or nothing; a contradiction is a failure whatever it says', async () => {
    const P = Object.fromEntries((await s.api('GET', '/platforms')).map((p: any) => [p.name, p.id]));
    const results = async () =>
      (await s.api('POST', `/platforms/${P['Gatus (demo)']}/request`, { method: 'GET', path: '/api/v1/endpoints/steward_machine-monitors/statuses' })).body
        .results;
    const gatus = (whileOff?: string) => [
      { id: 'g', type: 'gatus', platform: 'Gatus (demo)', endpointKey: 'steward_machine-monitors', include: 'monitor', ...(whileOff ? { whileOff } : {}) },
    ];
    const T = Date.now() + 60 * MIN;
    const first = await offMonitor('test-lathe-success', gatus(), T);
    expect((await results()).at(-1)).toMatchObject({ success: true });
    await offMonitor('test-lathe-failure', gatus('failure'), T);
    expect((await results()).at(-1)).toMatchObject({ success: false });
    // skip: nothing is sent for off (what was sent before it, e.g. unknown after saving, stays)
    let n = 0;
    await offMonitor('test-lathe-skip', gatus('skip'), T, async () => {
      n = (await results()).length;
    });
    expect((await results()).length).toBe(n);
    // the first monitor: a contradiction (data arrives while off) – a failure although it sends success while off
    eng.setMonitorClock(() => T + 2 * MIN);
    push(first, 'pm', T + 2 * MIN, { status: 'down' });
    push(first, 'data', T + 2 * MIN, { status: 'up' });
    await eng.evaluateMonitorNow(first);
    expect((await get(first)).status).toBe('down');
    expect((await results()).at(-1)).toMatchObject({ success: false });
    eng.setMonitorClock(null);
  });

  it('Zabbix gets code 6, Prometheus status 6 and sm_monitor_state, the public API code 6 and the state', async () => {
    const id = await offMonitor(
      'test-lathe-off',
      [{ id: 'zbx', type: 'zabbix', platform: 'Zabbix (demo)', via: 'api', include: 'monitor' }],
      Date.now() + 90 * MIN,
    );
    const pushed = (await (await fetch(`${s.base}/mock/zabbix/received`)).json()).received;
    expect(pushed).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'steward.monitor.status[test-lathe-off]', value: '6' })]));
    const text = await s.api('GET', '/metrics');
    expect(text).toMatch(/sm_monitor_status\{monitor="test-lathe-off",check=""\} 6/);
    expect(text).toMatch(/sm_monitor_status\{monitor="test-lathe-off",check="pm"\} 6/);
    expect(text).toMatch(/sm_monitor_state\{monitor="test-lathe-off",state="off"\} 1/);
    const { token } = await s.api('POST', '/me/tokens', { name: 'states read', scope: 'read' });
    const v1 = await (await fetch(`${s.base}/api/v1/monitors/${id}/status`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(v1).toMatchObject({ status: 'off', statusCode: 6, state: { id: 'off', reason: 'agree' } });
    expect(v1.checks.map((c: any) => c.statusCode)).toEqual([6, 6]);
    eng.setMonitorClock(null);
  });
});

describe('uptime with off', () => {
  it('off is excluded from the uptime and returned apart', async () => {
    const { upAndDown, uptimeHundredths } = await import('../src/monitors/stats.js');
    const H = 3600000;
    const points = [
      { t: 0, status: 'up' as const },
      { t: 10 * H, status: 'down' as const },
      { t: 11 * H, status: 'off' as const },
      { t: 20 * H, status: 'up' as const },
    ];
    const r = upAndDown(points, 0, 24 * H);
    expect(r).toEqual({ ok: 14 * H, down: H, off: 9 * H });
    // 14 of 15 hours: 93.33 % – the 9 hours off count neither way
    expect(uptimeHundredths(r)).toBe(9333);
  });
});
