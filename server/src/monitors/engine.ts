import {
  hasStates,
  monitorSettleSeconds,
  type CauseRef,
  type CheckDef,
  type CheckOf,
  type MonitorStateInfo,
  type MonitorStatus,
  type StateMemory,
} from '@sm/shared';
import { db } from '../db.js';
import { vault } from '../vault.js';
import { logger } from '../log.js';
import { config, env } from '../config.js';
import { parseJson } from '../util.js';
import { evalExpr } from '../engine/expr.js';
import { SpanStatusCode, withSpan } from '../telemetry.js';
import {
  checkEnabled,
  checkKey,
  intervalMs,
  loadMonitor,
  parseCauses,
  thresholds,
  timeoutMs,
  type CheckRow,
  type LoadedMonitor,
  type MonitorRow,
  type StateRow,
} from './model.js';
import { delayIdentity, encodeDelayState, newestSeen, parseDelayState, stepDelay, type DelayObservation, type DelayState } from './delay.js';
import { analyze, applyResult, freshnessStatus, freshnessWindowSeconds, fmtAge, nextDue, phaseOffset } from './logic.js';
import { isActive, planCheck, runActiveCheck, toMillis, type RawResult } from './checks.js';
import { storedKindMismatch } from './kinds.js';
import { ihKey } from './batch.js';
import { dispatchOutputs, heldMonitors, notifyStateChange, type Subject } from './outputs.js';
import { markDatasetsDirty, publishDirtyDatasets } from './datasets.js';
import { countEvaluation } from './metrics.js';
import { subMonitorMessage } from './redact.js';
import { catalogueMaintenance, plannedDowntime, type ActiveMaintenance } from './maintenance-hook.js';

/**
 * The monitor engine: a light scheduler, separate from process runs.
 *
 * - Every enabled check of every enabled monitor runs on its own interval, on a
 *   fixed grid (phase derived from a key) – checks that share an Insights Hub
 *   asset/aspect or a Gatus instance land in the same cycle and share one call.
 * - Active checks run with a global concurrency limit (SM_MONITOR_CONCURRENCY,
 *   default 8) and a timeout each; platform calls also obey the per-platform limit.
 * - Heartbeat checks are evaluated on their interval too, so a missing report
 *   turns them down without any incoming request; a report evaluates at once.
 * - After a check changed, the monitor's dependency graph is evaluated: root
 *   causes, aggregated status, outputs, and monitors that include it.
 * - All state is in the database, so a restart continues where it stopped.
 */

const TICK_MS = env.SM_MONITOR_TICK_MS;
const CONCURRENCY = env.SM_MONITOR_CONCURRENCY;
const KEEP_RESULTS = 50;

let clock: () => number = () => Date.now();
/** For tests: replace the engine's clock. */
export function setMonitorClock(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}
export const monitorNow = (): number => clock();

const monitors = new Map<string, LoadedMonitor>();
const due = new Map<string, number>();
const inflight = new Map<string, Promise<void>>();
const tracked = new Set<Promise<unknown>>();
const recomputeQueue = new Set<string>();
let recomputeScheduled = false;
let timer: NodeJS.Timeout | undefined;
let running = false;
let abort = new AbortController();
let loaded = false;
const maintenanceSeen = new Map<string, boolean>();
const resultCounter = new Map<string, number>();
/** Observed delay of freshness checks (delay.ts) by check, with the times last seen that are not stored on every read */
const delayStates = new Map<string, DelayState>();
/** Monitors with states (ADR 0021): the checks that agree with an expected down and show off (their samples count as other) */
const offChecks = new Map<string, Set<string>>();

/** What the engine stores per monitor with states (monitor_state.state_detail). */
interface StateDetail {
  changes: number[];
  /** A state was selected before */
  known?: boolean;
  offChecks: string[];
  info: MonitorStateInfo;
}
const parseDetail = (s: string | null | undefined): StateDetail | null => parseJson<StateDetail | null>(s, null);

function offChecksOf(mid: string): Set<string> {
  let set = offChecks.get(mid);
  if (!set) {
    const d = parseDetail(db().get<{ state_detail: string | null }>('SELECT state_detail FROM monitor_state WHERE monitor_id = ?', mid)?.state_detail);
    set = new Set(d?.offChecks ?? []);
    offChecks.set(mid, set);
  }
  return set;
}
let lastPublish = 0;

const ck = (mid: string, cid: string) => `${mid}\u0000${cid}`;
const iso = (ms: number) => new Date(ms).toISOString();

function track<T>(p: Promise<T>): Promise<T> {
  tracked.add(p);
  void p.finally(() => tracked.delete(p)).catch(() => undefined); // only the bookkeeping: the caller handles the promise's failure
  return p;
}

// ---------- concurrency ----------

let active = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
  else active++;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

// ---------- loading ----------

export function loadAll(): void {
  monitors.clear();
  delayStates.clear();
  for (const r of db().all<MonitorRow>('SELECT * FROM monitors WHERE is_template = 0')) monitors.set(r.id, loadMonitor(r));
  loaded = true;
}

/**
 * Once at start (0.11.0): checks and outputs whose stored platform is of a kind they do not use (kinds.ts) – saved
 * before the kind was checked, or the platform's kind changed. Checks report unknown, outputs record a failure, neither
 * sends anything; one log line names them by monitor, check or output and platform id (no names, no secrets) so an
 * administrator can find them.
 */
function warnPlatformKindMismatches(): void {
  const checks: { monitor: string; key: string; check: string; type: string; platform: string; kind: string }[] = [];
  const outputs: { monitor: string; key: string; output: string; type: string; platform: string; kind: string }[] = [];
  for (const m of monitors.values()) {
    for (const c of m.def.checks) {
      const x = storedKindMismatch({ ...c, platform: 'platform' in c ? c.platform : undefined }, false);
      if (x) checks.push({ monitor: m.id, key: m.key, check: c.id, type: c.type, platform: x.platform, kind: x.kind });
    }
    for (const o of m.def.outputs) {
      const x = storedKindMismatch({ type: o.type, platform: 'platform' in o ? o.platform : undefined }, true);
      if (x) outputs.push({ monitor: m.id, key: m.key, output: o.id, type: o.type, platform: x.platform, kind: x.kind });
    }
  }
  if (checks.length || outputs.length)
    logger.warn(
      { checks: checks.slice(0, 100), outputs: outputs.slice(0, 100), count: checks.length + outputs.length },
      'monitor checks and outputs whose platform is of a kind they do not read or write to: they do not run until another platform is chosen',
    );
}

/** After a create/update: refresh the definition and evaluate the monitor soon. */
export function reloadMonitor(id: string): void {
  const r = db().get<MonitorRow>('SELECT * FROM monitors WHERE id = ?', id);
  for (const k of [...due.keys()]) if (k.startsWith(id + '\u0000')) due.delete(k);
  for (const k of [...delayStates.keys()]) if (k.startsWith(id + '\u0000')) delayStates.delete(k);
  if (!r || r.is_template) {
    monitors.delete(id);
    return;
  }
  const m = loadMonitor(r);
  monitors.set(id, m);
  scheduleRecompute(id);
}

export function forgetMonitor(id: string): void {
  monitors.delete(id);
  offChecks.delete(id);
  for (const k of [...delayStates.keys()]) if (k.startsWith(id + '\u0000')) delayStates.delete(k);
  for (const k of [...due.keys()]) if (k.startsWith(id + '\u0000')) due.delete(k);
  maintenanceSeen.delete(id);
}

export const loadedMonitor = (id: string): LoadedMonitor | undefined => monitors.get(id);

// ---------- start / stop ----------

export function startMonitorEngine(): void {
  if (running) return;
  running = true;
  abort = new AbortController();
  try {
    loadAll();
    warnPlatformKindMismatches();
  } catch (err) {
    logger.error({ err }, 'monitors could not be loaded');
  }
  if (!env.SM_MONITOR_AUTOSTART) return;
  if (config.demo) void import('./demo.js').then((d) => d.startGatewaySimulator());
  timer = setInterval(() => {
    try {
      tick();
    } catch (err) {
      logger.warn({ err }, 'monitor tick failed');
    }
  }, TICK_MS);
  timer.unref();
  logger.info({ monitors: monitors.size, concurrency: CONCURRENCY }, 'monitor engine started');
}

/** Stops scheduling, cancels running checks and waits (up to 5 s) for them. */
export async function stopMonitorEngine(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = undefined;
  if (config.demo) void import('./demo.js').then((d) => d.stopGatewaySimulator());
  if (!running) return;
  running = false;
  abort.abort();
  await Promise.race([Promise.allSettled([...tracked]), new Promise((r) => setTimeout(r, 5000))]);
}

export const engineRunning = (): boolean => running;

/** For tests: wait until running evaluations, graph updates and outputs are done. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setImmediate(r));
    if (!tracked.size && !recomputeQueue.size) return;
    await Promise.allSettled([...tracked]);
  }
}

// ---------- scheduling ----------

function phaseKey(m: LoadedMonitor, c: CheckDef): string {
  if (c.type === 'freshness' && c.source === 'insightsHub' && c.assetId && c.aspect) return ihKey(c.platform, c.assetId, c.aspect);
  if (c.type === 'gatus') return `gatus|${c.platform}`;
  if (c.type === 'checkmk') return `checkmk|${c.platform}`;
  return `${m.id}/${c.id}`;
}

function checkRow(mid: string, cid: string): CheckRow | undefined {
  return db().get<CheckRow>('SELECT * FROM monitor_checks WHERE monitor_id = ? AND check_id = ?', mid, cid);
}

function ensureRow(m: LoadedMonitor, c: CheckDef, now: number): CheckRow {
  const r = checkRow(m.id, c.id);
  if (r) return r;
  db().run(
    'INSERT INTO monitor_checks (monitor_id, check_id, status, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (monitor_id, check_id) DO NOTHING',
    m.id,
    c.id,
    'unknown',
    iso(now),
  );
  return checkRow(m.id, c.id)!;
}

function firstDue(m: LoadedMonitor, c: CheckDef, now: number): number {
  const interval = intervalMs(m, c);
  const r = checkRow(m.id, c.id);
  if (!r?.last_checked_at) return now;
  const next = nextDue(Date.parse(r.last_checked_at), interval, phaseOffset(phaseKey(m, c), interval));
  return Math.max(next, now);
}

/** One scheduler cycle: starts the due checks (shared reads first), handles maintenance changes and held alerts. */
export function tick(now = clock()): number {
  if (!vault().unlocked) return 0;
  if (!loaded) loadAll();
  const start: [LoadedMonitor, CheckDef][] = [];
  for (const m of monitors.values()) {
    if (!m.enabled) continue;
    const inMaint = !!activeMaintenance(m.id, now);
    if (maintenanceSeen.get(m.id) !== inMaint) {
      if (maintenanceSeen.has(m.id)) scheduleRecompute(m.id);
      maintenanceSeen.set(m.id, inMaint);
    }
    for (const c of m.def.checks) {
      if (!checkEnabled(c)) continue;
      const k = ck(m.id, c.id);
      let d = due.get(k);
      if (d === undefined) due.set(k, (d = firstDue(m, c, now)));
      if (now < d || inflight.has(k)) continue;
      const interval = intervalMs(m, c);
      due.set(k, nextDue(now, interval, phaseOffset(phaseKey(m, c), interval)));
      start.push([m, c]);
    }
  }
  // register the shared reads before any check starts, so one call serves them all
  for (const [m, c] of start) planCheck(c, m.owner);
  for (const [m, c] of start) void evaluateCheck(m.id, c.id, now);
  for (const mid of heldMonitors()) scheduleRecompute(mid);
  if (now - lastPublish >= 60000) {
    lastPublish = now;
    try {
      publishDirtyDatasets();
    } catch (err) {
      logger.warn({ err }, 'monitor datasets could not be published');
    }
  }
  return start.length;
}

/** For tests and the "check now" button: run every enabled check of a monitor now. */
export async function evaluateMonitorNow(mid: string): Promise<void> {
  const m = monitors.get(mid);
  if (!m) return;
  const now = clock();
  for (const c of m.def.checks) planCheck(c, m.owner);
  await Promise.all(m.def.checks.filter(checkEnabled).map((c) => evaluateCheck(m.id, c.id, now)));
  await settle();
}

// ---------- evaluation ----------

/** Evaluates one check now (no-op while the same check is still running). */
export function evaluateCheck(mid: string, cid: string, now = clock()): Promise<void> {
  const k = ck(mid, cid);
  const current = inflight.get(k);
  if (current) return current;
  const p = track(
    (async () => {
      const m = monitors.get(mid);
      const c = m?.def.checks.find((x) => x.id === cid);
      if (!m || !c) return;
      const row = ensureRow(m, c, now);
      let raw: RawResult;
      const hard = blockedBy(m, c);
      if (hard) raw = { status: 'blocked', message: `Not evaluated: the hard dependency "${hard}" is down` };
      else if (c.type === 'heartbeat') raw = await evaluateHeartbeat(c, row, now);
      else if (c.type === 'monitor') raw = evaluateSubMonitor(c);
      else if (isActive(c)) {
        raw = await withSlot(() =>
          withSpan(`monitor check ${c.type}`, { 'sm.monitor.key': m.key, 'sm.monitor.check': c.id, 'sm.monitor.check_type': c.type }, async (span) => {
            const r = await runActiveCheck(c, {
              owner: m.owner,
              signal: abort.signal,
              timeoutMs: timeoutMs(m, c),
              now: () => clock(),
              newestSeen: newestSeenOf(m, c, row),
            });
            span.setAttribute('sm.monitor.status', r.status);
            if (r.status === 'down') span.setStatus({ code: SpanStatusCode.ERROR, message: r.message.slice(0, 200) });
            return r;
          }),
        );
      } else raw = { status: 'unknown', message: 'Unsupported check type' };
      if (abort.signal.aborted) return;
      if (raw.observation) recordObservation(m, c, row, raw.observation);
      persistResult(m, c, row, raw, clock() > now ? clock() : now);
      countEvaluation(c.type, raw.status);
      scheduleRecompute(m.id);
    })().catch((err) => logger.warn({ err, monitor: mid, check: cid }, 'monitor check evaluation failed')),
  );
  inflight.set(k, p);
  void p.finally(() => inflight.delete(k));
  return p;
}

function statusOf(mid: string, cid: string): MonitorStatus | undefined {
  return db().get<{ status: MonitorStatus }>('SELECT status FROM monitor_checks WHERE monitor_id = ? AND check_id = ?', mid, cid)?.status;
}

function blockedBy(m: LoadedMonitor, c: CheckDef): string | null {
  for (const l of m.def.links) {
    if (l.to !== c.id || l.mode !== 'hard') continue;
    const s = statusOf(m.id, l.from);
    if (s === 'down' || s === 'blocked') return m.def.checks.find((x) => x.id === l.from)?.name ?? l.from;
  }
  return null;
}

const STATUS_WORDS: Record<string, MonitorStatus> = {
  up: 'up',
  ok: 'up',
  true: 'up',
  healthy: 'up',
  good: 'up',
  online: 'up',
  running: 'up',
  success: 'up',
  degraded: 'degraded',
  warning: 'degraded',
  warn: 'degraded',
  down: 'down',
  error: 'down',
  fail: 'down',
  failed: 'down',
  failure: 'down',
  critical: 'down',
  false: 'down',
  offline: 'down',
  stopped: 'down',
  unknown: 'unknown',
};
export const statusWord = (v: unknown): MonitorStatus | undefined =>
  STATUS_WORDS[
    String(v ?? '')
      .trim()
      .toLowerCase()
  ];

async function evaluateHeartbeat(c: CheckOf<'heartbeat'>, row: CheckRow, now: number): Promise<RawResult> {
  const report = parseJson<{ status?: unknown; value?: unknown; ts?: unknown; data?: unknown } | null>(row.last_push, null);
  if (!row.last_push_at || !report) {
    const waited = (now - Date.parse(row.created_at)) / 1000;
    if (waited > freshnessWindowSeconds(c)) return { status: 'down', message: `No report received since the check was set up ${fmtAge(waited)} ago` };
    return { status: 'unknown', message: 'Waiting for the first report' };
  }
  const received = Date.parse(row.last_push_at);
  // the reporter's own timestamp counts, but never later than the moment it arrived
  const reported = toMillis(report.ts);
  const latest = reported !== undefined ? Math.min(reported, received) : received;
  const f = freshnessStatus(latest, now, c, 'report');
  if (f.status === 'down') return { status: 'down', message: f.message, value: report.value };
  let status: MonitorStatus = f.status;
  let message = f.message;
  try {
    if (c.statusExpression?.trim()) {
      const v = await evalExpr(c.statusExpression, report, {}, { timeoutMs: 1000, maxDepth: 200 });
      const s = typeof v === 'boolean' ? (v ? 'up' : 'down') : statusWord(v);
      if (!s)
        return { status: 'unknown', message: `The status expression returned "${String(v)}" (expected up, degraded, down or true/false)`, value: report.value };
      if (s !== 'up') {
        status = s;
        message = `Reported status: ${String(v)} – ${f.message}`;
      }
    } else if (report.status !== undefined && report.status !== null) {
      const s = statusWord(report.status);
      if (s && s !== 'up') {
        status = s;
        message = `Reported status: ${String(report.status)} – ${f.message}`;
      }
    }
    if (c.condition?.trim()) {
      const v = await evalExpr(c.condition, report, {}, { timeoutMs: 1000, maxDepth: 200 });
      if (!(Array.isArray(v) ? v.length : v))
        return {
          status: 'down',
          message: `The condition is false for the last report (value ${JSON.stringify(report.value ?? null)}) – ${f.message}`,
          value: report.value,
        };
    }
  } catch (e) {
    return { status: 'unknown', message: `Report could not be evaluated: ${(e as Error).message}`, value: report.value };
  }
  return { status, message, value: report.value };
}

/**
 * The message names neither the sub-monitor nor its checks: viewers of this monitor may not be allowed to
 * view the sub-monitor. Its root causes are part of this monitor's (structured, redacted per viewer).
 */
function evaluateSubMonitor(c: CheckOf<'monitor'>): RawResult {
  const sub = db().get<{ id: string; enabled: number } & Partial<StateRow>>(
    'SELECT m.id, m.enabled, s.status FROM monitors m LEFT JOIN monitor_state s ON s.monitor_id = m.id WHERE m.id = ?',
    c.monitor,
  );
  if (!sub) return { status: 'unknown', message: subMonitorMessage('missing') };
  if (!sub.enabled) return { status: 'unknown', message: subMonitorMessage('disabled') };
  const s = (sub.status ?? 'unknown') as MonitorStatus;
  // off (ADR 0021) passes through: a parent with states can expect it, one without counts it below up
  const status: MonitorStatus = s === 'maintenance' ? 'up' : s === 'blocked' ? 'unknown' : s;
  return { status, message: subMonitorMessage(s) };
}

/** The observed delay (delay.ts): one read of a freshness check's source, with the monitor's maintenance windows. */
function recordObservation(m: LoadedMonitor, c: CheckDef, row: CheckRow, obs: DelayObservation): void {
  const identity = delayIdentity(c);
  if (!identity) return;
  const k = ck(m.id, c.id);
  try {
    const prev = delayStateOf(k, row);
    const { state, changed } = stepDelay(prev, identity, obs, (t) => !!activeMaintenance(m.id, t));
    delayStates.set(k, state);
    // stored only when something worth keeping changed, not for every read of the same newest value
    if (changed) db().run('UPDATE monitor_checks SET observed_delay = ? WHERE monitor_id = ? AND check_id = ?', encodeDelayState(state), m.id, c.id);
  } catch (err) {
    logger.warn({ err, monitor: m.id, check: c.id }, 'observed delay not recorded');
  }
}

/** The observed delay state of a check: in memory (with the latest "last seen" times), else as stored. */
function delayStateOf(k: string, row: CheckRow): DelayState | null {
  let st = delayStates.get(k);
  if (st === undefined) {
    st = parseDelayState(row.observed_delay) ?? undefined;
    if (st) delayStates.set(k, st);
  }
  return st ?? null;
}

/** For the status of a freshness check: the newest timestamp per variable seen so far from the same source. */
function newestSeenOf(m: LoadedMonitor, c: CheckDef, row: CheckRow): ((name: string) => number | null) | undefined {
  const identity = delayIdentity(c);
  if (!identity) return undefined;
  const st = delayStateOf(ck(m.id, c.id), row);
  return (name) => newestSeen(st, identity, name);
}

function bucketOf(ms: number): string {
  return new Date(Math.floor(ms / 3600000) * 3600000).toISOString();
}

function persistResult(m: LoadedMonitor, c: CheckDef, row: CheckRow, raw: RawResult, now: number): void {
  const next = applyResult(
    { status: row.status, consecutiveFailures: row.consecutive_failures, consecutiveSuccesses: row.consecutive_successes },
    raw.status,
    thresholds(m, c),
  );
  const changed = next.status !== row.status;
  const ts = iso(now);
  const ok = raw.status === 'up' || raw.status === 'degraded';
  const inMaint = !!activeMaintenance(m.id, now) || offChecksOf(m.id).has(c.id);
  const sample = inMaint ? 'other' : next.status === 'up' || next.status === 'degraded' ? 'ok' : next.status === 'down' ? 'down' : 'other';
  const last = { ts, status: raw.status, message: raw.message.slice(0, 1000), durationMs: raw.durationMs ?? null, value: raw.value ?? null };
  db().tx(() => {
    db().run(
      `UPDATE monitor_checks SET status = ?, since = ?, consecutive_failures = ?, consecutive_successes = ?, last_checked_at = ?, last_ok_at = ?, last_result = ?
       WHERE monitor_id = ? AND check_id = ?`,
      next.status,
      changed || !row.since ? ts : row.since,
      next.consecutiveFailures,
      next.consecutiveSuccesses,
      ts,
      ok ? ts : row.last_ok_at,
      JSON.stringify(last),
      m.id,
      c.id,
    );
    db().run(
      'INSERT INTO monitor_results (monitor_id, check_id, ts, status, message, duration_ms, value) VALUES (?, ?, ?, ?, ?, ?, ?)',
      m.id,
      c.id,
      ts,
      raw.status,
      last.message,
      raw.durationMs ?? null,
      raw.value === undefined ? null : JSON.stringify(raw.value).slice(0, 2000),
    );
    db().run(
      `INSERT INTO monitor_samples (monitor_id, check_id, bucket, ok, down, other) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (monitor_id, check_id, bucket) DO UPDATE SET ok = monitor_samples.ok + excluded.ok, down = monitor_samples.down + excluded.down, other = monitor_samples.other + excluded.other`,
      m.id,
      c.id,
      bucketOf(now),
      sample === 'ok' ? 1 : 0,
      sample === 'down' ? 1 : 0,
      sample === 'other' ? 1 : 0,
    );
    if (changed) {
      db().run(
        'INSERT INTO monitor_history (monitor_id, check_id, ts, status, previous, message, caused_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        m.id,
        c.id,
        ts,
        next.status,
        row.status,
        last.message,
        '[]',
      );
    }
  });
  const n = (resultCounter.get(ck(m.id, c.id)) ?? 0) + 1;
  resultCounter.set(ck(m.id, c.id), n);
  if (n % 25 === 0) pruneResults(m.id, c.id);
}

function pruneResults(mid: string, cid: string): void {
  db().run(
    `DELETE FROM monitor_results WHERE monitor_id = ? AND check_id = ? AND id < (
       SELECT MIN(id) FROM (SELECT id FROM monitor_results WHERE monitor_id = ? AND check_id = ? ORDER BY id DESC LIMIT ?) newest)`,
    mid,
    cid,
    mid,
    cid,
    KEEP_RESULTS,
  );
}

// ---------- maintenance ----------

/**
 * The maintenance window a monitor is in now: a catalogue window (#108) that lists the monitor or reaches a platform
 * it checks (0.11, ADR 0018: the one maintenance-window concept). A monitor's own window from before 0.11 that was not
 * copied yet (the copy is made once the vault is open) still counts until it is.
 */
export function activeMaintenance(mid: string, now = clock()): ActiveMaintenance | undefined {
  const ts = iso(now);
  return (
    catalogueMaintenance(mid, now) ??
    db().get<ActiveMaintenance>(
      `SELECT id, starts_at, ends_at, reason, created_by, created_at FROM monitor_maintenance
       WHERE monitor_id = ? AND migrated_at IS NULL AND starts_at <= ? AND ends_at > ? ORDER BY ends_at DESC LIMIT 1`,
      mid,
      ts,
      ts,
    )
  );
}

/**
 * activeMaintenance of many monitors (the list, security review 0.19.0 H2): the monitors' own windows of earlier
 * versions read in one statement, the catalogue's as before (cached there).
 */
export function activeMaintenanceOf(now = clock()): (mid: string) => ActiveMaintenance | undefined {
  const ts = iso(now);
  const own = new Map<string, ActiveMaintenance>();
  for (const w of db().all<ActiveMaintenance & { monitor_id: string }>(
    `SELECT monitor_id, id, starts_at, ends_at, reason, created_by, created_at FROM monitor_maintenance
     WHERE migrated_at IS NULL AND starts_at <= ? AND ends_at > ? ORDER BY ends_at DESC`,
    ts,
    ts,
  )) {
    if (own.has(w.monitor_id)) continue;
    const { monitor_id: _m, ...rest } = w;
    own.set(w.monitor_id, rest);
  }
  return (mid) => catalogueMaintenance(mid, now) ?? own.get(mid);
}

// ---------- graph evaluation ----------

export function scheduleRecompute(mid: string): void {
  recomputeQueue.add(mid);
  if (recomputeScheduled) return;
  recomputeScheduled = true;
  const p = new Promise<void>((resolve) =>
    setImmediate(async () => {
      recomputeScheduled = false;
      const ids = [...recomputeQueue];
      recomputeQueue.clear();
      for (const id of ids) {
        try {
          await recompute(id);
        } catch (err) {
          logger.warn({ err, monitor: id }, 'monitor evaluation failed');
        }
      }
      resolve();
    }),
  );
  track(p);
}

/** Root causes, aggregated status, history, outputs and dependent monitors of one monitor. */
export async function recompute(mid: string, now = clock()): Promise<void> {
  const m = monitors.get(mid);
  if (!m) return;
  const rows = new Map(
    db()
      .all<CheckRow>('SELECT * FROM monitor_checks WHERE monitor_id = ?', mid)
      .map((r) => [r.check_id, r]),
  );
  const enabledChecks = m.def.checks.filter(checkEnabled);
  const statuses = new Map<string, MonitorStatus>(enabledChecks.map((c) => [c.id, rows.get(c.id)?.status ?? 'unknown']));
  const maint = !!activeMaintenance(mid, now);
  const subRoots = (c: CheckDef): CauseRef[] =>
    c.type === 'monitor'
      ? parseCauses(db().get<{ root_causes: string }>('SELECT root_causes FROM monitor_state WHERE monitor_id = ?', c.monitor)?.root_causes)
      : [];
  const pendingDown = new Set(
    enabledChecks
      .filter((c) => statuses.get(c.id) !== 'down' && parseJson<{ status?: string } | null>(rows.get(c.id)?.last_result, null)?.status === 'down')
      .map((c) => c.id),
  );
  const prev = db().get<StateRow>('SELECT * FROM monitor_state WHERE monitor_id = ?', mid);
  // states (ADR 0021): the memory of the last evaluation, the leader's state, planned downtime, sub-monitor settle times
  const withStates = hasStates(m.def);
  const detail = withStates ? parseDetail(prev?.state_detail) : null;
  const memory: StateMemory | null =
    withStates && detail
      ? {
          id: prev?.state_id ?? null,
          since: prev?.state_since ? Date.parse(prev.state_since) : null,
          settleUntil: prev?.settle_until ? Date.parse(prev.settle_until) : null,
          changes: detail.changes ?? [],
          known: !!detail.known,
        }
      : null;
  const leader = leaderOf(m);
  const states = withStates
    ? {
        memory,
        now,
        leaderState: leader
          ? (db().get<{ state_id: string | null }>('SELECT state_id FROM monitor_state WHERE monitor_id = ?', leader)?.state_id ?? null)
          : null,
        downtime: { active: plannedDowntime(mid, now, now + 1).active, msSince: (from: number) => plannedDowntime(mid, from, now).ms },
        subSettle: (c: CheckOf<'monitor'>, cell: 'up' | 'down' | 'off') => {
          const sub = monitors.get(c.monitor);
          return sub ? monitorSettleSeconds(sub.def, cell) : 0;
        },
      }
    : undefined;
  const a = analyze(m, statuses, { maintenance: maint, subRoots, pendingDown, states });
  if (!m.enabled) a.status = 'unknown';
  const ts = iso(now);
  const changed = !prev || prev.status !== a.status;
  const st = a.state;
  const stateChanged = !!st && st.changed && !!memory;
  if (withStates) offChecks.set(mid, new Set(st?.offChecks ?? []));
  else offChecks.delete(mid);
  const nextDetail: StateDetail | null = st ? { changes: st.memory.changes, known: !!st.memory.known, offChecks: [...st.offChecks], info: st.info } : null;
  db().tx(() => {
    for (const c of enabledChecks) {
      const v = a.checks.get(c.id)!;
      const r = rows.get(c.id);
      if (!r) continue;
      const causes = JSON.stringify(v.causedBy);
      if (causes !== r.caused_by || (v.note ?? null) !== (r.note ?? null)) {
        db().run('UPDATE monitor_checks SET caused_by = ?, note = ? WHERE monitor_id = ? AND check_id = ?', causes, v.note, mid, c.id);
        // the latest state change of this check gets the root causes known now
        if (v.causedBy.length) {
          db().run(
            `UPDATE monitor_history SET caused_by = ? WHERE id = (SELECT MAX(id) FROM monitor_history WHERE monitor_id = ? AND check_id = ?) AND caused_by = '[]'`,
            causes,
            mid,
            c.id,
          );
        }
      }
    }
    db().run(
      `INSERT INTO monitor_state (monitor_id, status, since, root_causes, last_evaluated_at, state_id, state_since, settle_until, state_detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (monitor_id) DO UPDATE SET status = excluded.status, since = excluded.since, root_causes = excluded.root_causes, last_evaluated_at = excluded.last_evaluated_at,
         state_id = excluded.state_id, state_since = excluded.state_since, settle_until = excluded.settle_until, state_detail = excluded.state_detail`,
      mid,
      a.status,
      changed ? ts : (prev?.since ?? ts),
      JSON.stringify(a.rootCauses),
      ts,
      st?.memory.id ?? null,
      st?.memory.since ? iso(st.memory.since) : null,
      st?.memory.settleUntil ? iso(st.memory.settleUntil) : null,
      nextDetail ? JSON.stringify(nextDetail) : null,
    );
    // a state change writes a history row even when the status stays (Running and Standby are both up)
    if (changed || stateChanged) {
      // the message ("Root cause: …") is built from caused_by when it is read, for the viewer (redact.ts)
      db().run(
        'INSERT INTO monitor_history (monitor_id, check_id, ts, status, previous, message, caused_by, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        mid,
        '',
        ts,
        a.status,
        prev?.status ?? null,
        st && st.status !== null && !st.causes.length ? st.info.message.slice(0, 1000) : '',
        JSON.stringify(a.rootCauses),
        st?.memory.id ?? null,
      );
    }
    if (changed) {
      // an acknowledgement ends when the monitor is up again – or off, as its state expects
      if (a.status === 'up' || a.status === 'off')
        db().run('UPDATE monitor_state SET ack_by = NULL, ack_at = NULL, ack_comment = NULL WHERE monitor_id = ?', mid);
      db().run(
        `INSERT INTO monitor_samples (monitor_id, check_id, bucket, ok, down, other) VALUES (?, '', ?, 0, 0, 0) ON CONFLICT (monitor_id, check_id, bucket) DO NOTHING`,
        mid,
        bucketOf(now),
      );
    }
  });
  markDatasetsDirty(mid);

  // outputs
  const state = db().get<StateRow>('SELECT * FROM monitor_state WHERE monitor_id = ?', mid)!;
  const monitorInfo = { id: m.id, key: m.key, name: m.name, status: a.status };
  // the state decides the status: its message ("Off – all checks agree", the contradiction …) unless a root cause's own one fits
  const stateMessage = st && (st.status !== null || st.flapping) ? st.info.message : null;
  const subjects: Subject[] = [
    {
      event: {
        subject: '',
        level: 'monitor',
        status: a.status,
        since: state.since,
        message:
          (st?.info.reason === 'contradiction' || st?.info.reason === 'required' ? stateMessage : null) ??
          rootMessage(a.rootCauses, rows) ??
          stateMessage ??
          `${m.name} is ${a.status}`,
        causedBy: a.rootCauses,
        ts,
        monitor: monitorInfo,
        ...(st ? { state: stateOf(st.info), stateReason: st.info.reason } : {}),
        ...(st?.info.contradiction ? { contradiction: contradictionOf(m.def, st.info) } : {}),
      },
      dependent: false,
    },
    ...enabledChecks
      .filter((c) => rows.has(c.id))
      .map((c) => {
        const r = rows.get(c.id)!;
        const v = a.checks.get(c.id)!;
        const last = parseJson<{ message?: string; durationMs?: number; value?: unknown; ts?: string } | null>(r.last_result, null);
        return {
          event: {
            subject: c.id,
            level: 'check' as const,
            status: maint ? ('maintenance' as const) : v.status,
            since: r.since,
            message: last?.message ?? '',
            causedBy: v.causedBy,
            ts: last?.ts ?? ts,
            monitor: monitorInfo,
            check: { id: c.id, key: checkKey(m, c), name: c.name, type: c.type },
            durationMs: last?.durationMs ?? null,
            value: last?.value,
          },
          dependent: v.causedBy.length > 0,
        };
      }),
  ];
  if (m.enabled && m.def.outputs.length) {
    await track(dispatchOutputs({ monitor: m, subjects, maintenance: maint, acknowledged: !!state.ack_by, now }));
  }

  // state changes as information (opt-in per notification output, event monitor.state)
  if (stateChanged && m.enabled && st && st.previous !== null && !maint) notifyStateChange(m, st.previous, st.info, now);

  // followers follow their leader's state change right away
  if (stateChanged) for (const other of monitors.values()) if (other.id !== mid && other.enabled && leaderOf(other) === mid) scheduleRecompute(other.id);

  // monitors that include this one follow right away
  if (changed) {
    for (const other of monitors.values()) {
      if (other.id === mid || !other.enabled) continue;
      for (const c of other.def.checks) if (c.type === 'monitor' && c.monitor === mid && checkEnabled(c)) void evaluateCheck(other.id, c.id, now);
    }
  }
}

/** The id of the monitor whose state this one follows (stored as an id, or as the key of one imported later). */
function leaderOf(m: LoadedMonitor): string | undefined {
  const ref = m.def.states?.from;
  if (!ref) return undefined;
  if (monitors.has(ref)) return ref;
  for (const x of monitors.values()) if (x.key === ref.toLowerCase()) return x.id;
  return ref;
}

/** The state as outputs carry it (webhook `state`). */
function stateOf(info: MonitorStateInfo) {
  return { id: info.id, name: info.name, since: info.since, settlingUntil: info.settlingUntil };
}

/** A contradiction as outputs carry it: what was expected of which check, and what it is. */
function contradictionOf(def: LoadedMonitor['def'], info: MonitorStateInfo) {
  const c = info.contradiction!;
  return {
    closest: c.closest,
    checks: c.checks.map((x) => ({
      id: x.checkId,
      name: def.checks.find((d) => d.id === x.checkId)?.name ?? x.checkId,
      expected: x.expected,
      actual: x.actual,
    })),
  };
}

/** When the scheduler runs the check next (null before its first cycle). */
export function nextCheckAt(mid: string, cid: string): string | null {
  const d = due.get(ck(mid, cid));
  return d === undefined ? null : iso(d);
}

/** The latest result message of the first root cause in this monitor (e.g. "No report for 6 min"). */
function rootMessage(roots: CauseRef[], rows: Map<string, CheckRow>): string | null {
  for (const r of roots) {
    const row = rows.get(r.checkId);
    const last = row && parseJson<{ message?: string } | null>(row.last_result, null);
    if (last?.message && row!.monitor_id === r.monitorId) return last.message;
  }
  return null;
}

/** Resets the in-memory schedule (tests). */
export function resetEngineSchedule(): void {
  due.clear();
  maintenanceSeen.clear();
}
