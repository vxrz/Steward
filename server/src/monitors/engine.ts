import type { CauseRef, CheckDef, CheckOf, MonitorStatus } from '@sm/shared';
import { db } from '../db.js';
import { vault } from '../vault.js';
import { logger } from '../log.js';
import { config } from '../config.js';
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
import { analyze, applyResult, freshnessStatus, freshnessWindowSeconds, fmtAge, nextDue, phaseOffset } from './logic.js';
import { isActive, planFreshness, planGatus, runActiveCheck, toMillis, type RawResult } from './checks.js';
import { ihKey } from './batch.js';
import { dispatchOutputs, heldMonitors, type Subject } from './outputs.js';
import { markDatasetsDirty, publishDirtyDatasets } from './datasets.js';
import { countEvaluation } from './metrics.js';
import { subMonitorMessage } from './redact.js';

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

const TICK_MS = Number(process.env.SM_MONITOR_TICK_MS ?? 1000);
const CONCURRENCY = Math.max(1, Number(process.env.SM_MONITOR_CONCURRENCY ?? 8));
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
let lastPublish = 0;

const ck = (mid: string, cid: string) => `${mid}\u0000${cid}`;
const iso = (ms: number) => new Date(ms).toISOString();

function track<T>(p: Promise<T>): Promise<T> {
  tracked.add(p);
  void p.finally(() => tracked.delete(p)).catch(() => undefined);
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
  for (const r of db().all<MonitorRow>('SELECT * FROM monitors WHERE is_template = 0')) monitors.set(r.id, loadMonitor(r));
  loaded = true;
}

/** After a create/update: refresh the definition and evaluate the monitor soon. */
export function reloadMonitor(id: string): void {
  const r = db().get<MonitorRow>('SELECT * FROM monitors WHERE id = ?', id);
  for (const k of [...due.keys()]) if (k.startsWith(id + '\u0000')) due.delete(k);
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
  } catch (err) {
    logger.error({ err }, 'monitors could not be loaded');
  }
  if (process.env.SM_MONITOR_AUTOSTART === '0') return;
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
  for (const [m, c] of start) {
    if (c.type === 'freshness') planFreshness(c, m.owner);
    else if (c.type === 'gatus') planGatus(c, m.owner);
  }
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
  for (const c of m.def.checks) if (c.type === 'freshness') planFreshness(c, m.owner);
  for (const c of m.def.checks) if (c.type === 'gatus') planGatus(c, m.owner);
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
            const r = await runActiveCheck(c, { owner: m.owner, signal: abort.signal, timeoutMs: timeoutMs(m, c), now: () => clock() });
            span.setAttribute('sm.monitor.status', r.status);
            if (r.status === 'down') span.setStatus({ code: SpanStatusCode.ERROR, message: r.message.slice(0, 200) });
            return r;
          }),
        );
      } else raw = { status: 'unknown', message: 'Unsupported check type' };
      if (abort.signal.aborted) return;
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
  const status: MonitorStatus = s === 'maintenance' ? 'up' : s === 'blocked' ? 'unknown' : s;
  return { status, message: subMonitorMessage(s) };
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
  const inMaint = !!activeMaintenance(m.id, now);
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

export function activeMaintenance(mid: string, now = clock()): { id: string; ends_at: string; reason: string } | undefined {
  const ts = iso(now);
  return (
    db().get<{ id: string; ends_at: string; reason: string }>(
      'SELECT id, ends_at, reason FROM monitor_maintenance WHERE monitor_id = ? AND starts_at <= ? AND ends_at > ? ORDER BY ends_at DESC LIMIT 1',
      mid,
      ts,
      ts,
    ) ?? catalogueMaintenance?.(mid, now)
  );
}

/** Maintenance windows of the catalogue (#108) on a platform the monitor checks – set by catalogue/maintenance.ts. */
let catalogueMaintenance: ((mid: string, now: number) => { id: string; starts_at: string; ends_at: string; reason: string } | undefined) | null = null;
export function setCatalogueMaintenance(fn: typeof catalogueMaintenance): void {
  catalogueMaintenance = fn;
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
  const a = analyze(m, statuses, { maintenance: maint, subRoots, pendingDown });
  if (!m.enabled) a.status = 'unknown';
  const ts = iso(now);
  const prev = db().get<StateRow>('SELECT * FROM monitor_state WHERE monitor_id = ?', mid);
  const changed = !prev || prev.status !== a.status;
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
      `INSERT INTO monitor_state (monitor_id, status, since, root_causes, last_evaluated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (monitor_id) DO UPDATE SET status = excluded.status, since = excluded.since, root_causes = excluded.root_causes, last_evaluated_at = excluded.last_evaluated_at`,
      mid,
      a.status,
      changed ? ts : (prev?.since ?? ts),
      JSON.stringify(a.rootCauses),
      ts,
    );
    if (changed) {
      // the message ("Root cause: …") is built from caused_by when it is read, for the viewer (redact.ts)
      db().run(
        'INSERT INTO monitor_history (monitor_id, check_id, ts, status, previous, message, caused_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        mid,
        '',
        ts,
        a.status,
        prev?.status ?? null,
        '',
        JSON.stringify(a.rootCauses),
      );
      if (a.status === 'up') db().run('UPDATE monitor_state SET ack_by = NULL, ack_at = NULL, ack_comment = NULL WHERE monitor_id = ?', mid);
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
  const subjects: Subject[] = [
    {
      event: {
        subject: '',
        level: 'monitor',
        status: a.status,
        since: state.since,
        message: rootMessage(a.rootCauses, rows) ?? `${m.name} is ${a.status}`,
        causedBy: a.rootCauses,
        ts,
        monitor: monitorInfo,
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

  // monitors that include this one follow right away
  if (changed) {
    for (const other of monitors.values()) {
      if (other.id === mid || !other.enabled) continue;
      for (const c of other.def.checks) if (c.type === 'monitor' && c.monitor === mid && checkEnabled(c)) void evaluateCheck(other.id, c.id, now);
    }
  }
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
