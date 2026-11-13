import {
  DATA_DISCOVERY_LIMITS as DL,
  DATA_PRODUCT_ID_PREFIX,
  DATA_PRODUCT_LIMITS,
  DATABASE_KIND,
  KAFKA_KIND,
  SNOWFLAKE_KIND,
  type DataDiscoveryRun,
  type DataDiscoveryRunStatus,
  type DiscoveredElement,
} from '@sm/shared';
import { db } from '../../db.js';
import { audit } from '../../audit.js';
import { logger } from '../../log.js';
import { vault } from '../../vault.js';
import { runAs } from '../../auth/context.js';
import { HttpError, newId, nowIso } from '../../util.js';
import { CheckSetupError, ownerProblem, platformFor } from '../../monitors/platforms.js';
import { discoverySourceRow, markMissing, removeLongMissing, upsertDiscovered } from '../store.js';
import { DiscoveryError, parseSource, type DiscoveryContext, type DiscoveryProblem, type DiscoveryReader } from './common.js';
import { readSnowflake } from './snowflake.js';
import { readKafka } from './kafka.js';
import { readSqlSnapshot } from './dbschema.js';

/**
 * Discovery runs (ADR 0036 part 5, _Performance_): the job `data-products` reads the sources that are due, one at a
 * time, and "Read now" starts one source's run. A run
 *
 * - checks again that the person it runs as may still use the platform (and the identity it names) – a source whose
 *   owner lost the right stops and says why (the rule of _Keep in sync_);
 * - reads with the platform's reader (Snowflake, Kafka, a database platform's snapshot) and writes what it finds in
 *   batches of DATA_DISCOVERY_LIMITS.batch per transaction (store.upsertDiscovered: changes found by a hash per element,
 *   readouts in their own table), yielding to the event loop between batches;
 * - stops at DATA_PRODUCT_LIMITS.elementsPerRun elements, at the instance's limit (elements not added are counted:
 *   `skipped`) or after DATA_DISCOVERY_LIMITS.timeBudgetMs – then it is _truncated_ and marks nothing missing;
 * - after a complete run, marks the source's elements it did not see as missing (store.markMissing) and removes those
 *   missing for DATA_DISCOVERY_LIMITS.missingDays days that are in no product (store.removeLongMissing);
 * - keeps its counts in the run history (the newest DATA_PRODUCT_LIMITS.runsKept per source) and an audit entry when it
 *   changed something, failed or was started by hand (renames listed).
 */

export const DISCOVERY_JOB = 'data-products';

const READERS: Readonly<Record<string, DiscoveryReader>> = {
  [SNOWFLAKE_KIND]: readSnowflake,
  [KAFKA_KIND]: readKafka,
  [DATABASE_KIND]: readSqlSnapshot,
};

/** Platform kinds discovery reads (Confluent Cloud clusters are read as Kafka platforms, docs/KAFKA.md). */
export const DISCOVERABLE_KINDS: readonly string[] = Object.keys(READERS);

/** Source id → run id of the runs going on in this process. */
const running = new Map<string, string>();
export const isRunning = (sourceId: string): boolean => running.has(sourceId);

interface RunRow {
  id: string;
  source_id: string;
  status: DataDiscoveryRunStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number;
  added: number;
  changed: number;
  renamed: number;
  missing: number;
  removed: number;
  unchanged: number;
  truncated: number;
  error: string | null;
  actor: string;
}

/** The run as the API shows it; `error` holds a JSON problem (message, code, params) or, from older rows, a text. */
export function toRun(r: RunRow): DataDiscoveryRun {
  let problem: DiscoveryProblem | null = null;
  if (r.error) {
    try {
      const p = JSON.parse(r.error) as DiscoveryProblem;
      problem = p && typeof p.message === 'string' ? p : { message: r.error, code: 'DATA_DISCOVERY_FAILED' };
    } catch {
      problem = { message: r.error, code: 'DATA_DISCOVERY_FAILED' };
    }
  }
  return {
    id: r.id,
    sourceId: r.source_id,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: Number(r.duration_ms),
    added: Number(r.added),
    changed: Number(r.changed),
    renamed: Number(r.renamed),
    missing: Number(r.missing),
    removed: Number(r.removed),
    unchanged: Number(r.unchanged),
    truncated: !!Number(r.truncated),
    error: problem?.message ?? null,
    errorCode: problem?.code ?? null,
    errorParams: problem?.params ?? null,
    actor: r.actor,
  };
}

/** The newest runs of these sources (one statement), newest first. */
export function runsOf(sourceIds: readonly string[], perSource: number = DATA_PRODUCT_LIMITS.runsKept): Map<string, DataDiscoveryRun[]> {
  const out = new Map<string, DataDiscoveryRun[]>();
  if (!sourceIds.length) return out;
  const rows = db().all<RunRow>(
    `SELECT * FROM dp_discovery_runs WHERE source_id IN (${sourceIds.map(() => '?').join(', ')}) ORDER BY started_at DESC, id DESC`,
    ...sourceIds,
  );
  for (const r of rows) {
    const list = out.get(r.source_id) ?? [];
    if (list.length < perSource) list.push(toRun(r));
    out.set(r.source_id, list);
  }
  return out;
}

/** Runs left 'running' by a stopped server: failed, so the history does not show them going on for ever. */
function closeInterrupted(sourceId?: string): void {
  const rows = db().all<{ id: string; source_id: string }>(
    `SELECT id, source_id FROM dp_discovery_runs WHERE status = 'running'${sourceId ? ' AND source_id = ?' : ''}`,
    ...(sourceId ? [sourceId] : []),
  );
  for (const r of rows) {
    if (running.get(r.source_id) === r.id) continue;
    const problem: DiscoveryProblem = { message: 'The run was interrupted (the server stopped)', code: 'DATA_DISCOVERY_FAILED', params: { context: 'interrupted' } };
    db().run("UPDATE dp_discovery_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?", nowIso(), JSON.stringify(problem), r.id);
  }
}

export interface RunOptions {
  trigger: 'schedule' | 'manual';
  /** Who started it by hand (the run's actor; scheduled runs: system) */
  actor?: string;
  /** Overrides of the limits, for tests */
  limits?: { elementsPerRun?: number; timeBudgetMs?: number };
}

/**
 * Claims the source and starts its run: synchronously refuses a source that is running (409 DATA_DISCOVERY_RUNNING)
 * and writes the run row; `done` settles with the finished run (never rejects).
 */
export function startRun(sourceId: string, opts: RunOptions): { runId: string; done: Promise<DataDiscoveryRun> } {
  const row = discoverySourceRow(sourceId);
  if (!row) throw new HttpError(404, `Discovery source ${sourceId} not found`, 'DATA_DISCOVERY_NOT_FOUND', { id: sourceId });
  if (running.has(sourceId))
    throw new HttpError(409, `Discovery source "${row.name}" is reading already – wait for its run to end`, 'DATA_DISCOVERY_RUNNING', { name: row.name });
  closeInterrupted(sourceId);
  const runId = newId(DATA_PRODUCT_ID_PREFIX.run);
  const actor = opts.trigger === 'manual' ? (opts.actor ?? 'system') : 'system';
  db().run("INSERT INTO dp_discovery_runs (id, source_id, status, started_at, actor) VALUES (?, ?, 'running', ?, ?)", runId, sourceId, nowIso(), actor);
  running.set(sourceId, runId);
  const done = runAs(null, () => execute(sourceId, runId, actor, opts)).finally(() => running.delete(sourceId));
  return { runId, done };
}

/** Runs a source now and waits for the end (the job; tests). */
export async function runSource(sourceId: string, opts: RunOptions): Promise<DataDiscoveryRun> {
  return startRun(sourceId, opts).done;
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

async function execute(sourceId: string, runId: string, actor: string, opts: RunOptions): Promise<DataDiscoveryRun> {
  const t0 = Date.now();
  const startedAt = new Date(t0).toISOString();
  const row = discoverySourceRow(sourceId)!;
  const src = parseSource(row);
  const limit = Math.min(opts.limits?.elementsPerRun ?? DATA_PRODUCT_LIMITS.elementsPerRun, DATA_PRODUCT_LIMITS.elementsPerRun);
  const budget = opts.limits?.timeBudgetMs ?? DL.timeBudgetMs;
  const totals = { added: 0, changed: 0, renamed: 0, unchanged: 0, readouts: 0, skipped: 0 };
  const seen = new Set<string>();
  const renames: { id: string; from: string; to: string }[] = [];
  const warnings: DiscoveryProblem[] = [];
  let failure: DiscoveryProblem | null = null;
  let cut: DiscoveryProblem | null = null;
  let missing: string[] = [];
  let removed = 0;
  let platformName = '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  timer.unref?.();
  const timeUp = (): DiscoveryProblem => ({
    message: `The run stopped after ${Math.round(budget / 60_000)} minutes: what it read so far is kept, nothing is marked missing`,
    code: 'DATA_DISCOVERY_TOO_LARGE',
    params: { context: 'time', minutes: Math.round(budget / 60_000) },
  });
  try {
    // the person the source runs as must still be active and may use the platform and identity: checked before every run
    const problem = ownerProblem(src.runAs, src.platformId, src.identityId);
    if (problem)
      throw new DiscoveryError({
        message: `The source runs as ${src.runAs}: ${problem} – a person who may use the platform saves the source again`,
        code: 'DATA_DISCOVERY_OWNER',
        params: { owner: src.runAs, reason: problem.slice(0, 300) },
      });
    const { platform, secrets } = platformFor(src.runAs, src.platformId, src.identityId);
    platformName = platform.name;
    const read = READERS[platform.kind];
    if (!read)
      throw new DiscoveryError({
        message: `Platforms of the kind ${platform.kind} are not discovered`,
        code: 'DATA_DISCOVERY_PLATFORM',
        params: { context: 'kind', kind: platform.kind },
      });
    const ctx: DiscoveryContext = { source: src, platform, secrets, max: limit + 1, signal: controller.signal, warn: (w) => warnings.push(w) };
    let buffer: DiscoveredElement[] = [];
    let count = 0;
    const flush = async () => {
      if (!buffer.length) return;
      const r = upsertDiscovered(src.id, buffer);
      buffer = [];
      totals.added += r.added;
      totals.changed += r.changed;
      totals.renamed += r.renamed;
      totals.unchanged += r.unchanged;
      totals.readouts += r.readouts;
      totals.skipped += r.skipped;
      for (const id of r.seen) seen.add(id);
      if (renames.length < 100) renames.push(...r.renames.slice(0, 100 - renames.length));
      await yieldToLoop();
    };
    try {
      outer: for await (const part of read(ctx)) {
        for (const e of part) {
          if (count >= limit) {
            cut = {
              message: `The run stopped at ${limit.toLocaleString('en-GB')} elements: narrow the scope or add a second source – nothing is marked missing`,
              code: 'DATA_DISCOVERY_TOO_LARGE',
              params: { context: 'run', max: limit },
            };
            break outer;
          }
          buffer.push(e);
          count++;
          if (buffer.length >= DL.batch) await flush();
        }
        if (controller.signal.aborted) {
          cut = timeUp();
          break;
        }
      }
    } catch (e) {
      // the time budget ended a request: what was read stands, the run is truncated
      if (!controller.signal.aborted) throw e;
      cut = timeUp();
    }
    await flush();
    if (!cut && totals.skipped)
      cut = {
        message: `The catalogue holds ${DATA_PRODUCT_LIMITS.elements.toLocaleString('en-GB')} elements: ${totals.skipped} new one(s) were not added`,
        code: 'DATA_DISCOVERY_TOO_LARGE',
        params: { context: 'instance', max: DATA_PRODUCT_LIMITS.elements, count: totals.skipped },
      };
    if (!cut) cut = warnings.find((w) => w.code === 'DATA_DISCOVERY_TOO_LARGE') ?? null;
    if (!cut) {
      // only a complete read says what is gone
      const at = nowIso();
      missing = markMissing(src.id, seen, at);
      removed = removeLongMissing(new Date(Date.now() - DL.missingDays * 86_400_000).toISOString(), src.id);
    }
  } catch (e) {
    failure =
      e instanceof DiscoveryError
        ? e.problem
        : {
            message: (e instanceof CheckSetupError ? `The platform cannot be used: ${e.message}` : (e as Error).message).slice(0, 500),
            code: 'DATA_DISCOVERY_FAILED',
            params: { message: (e as Error).message.slice(0, 300) },
          };
  } finally {
    clearTimeout(timer);
  }
  const status: DataDiscoveryRunStatus = failure ? 'failed' : cut ? 'truncated' : 'succeeded';
  const problem = failure ?? cut ?? warnings[0] ?? null;
  const finished = nowIso();
  const run = {
    status,
    finished,
    duration: Date.now() - t0,
    missing: missing.length,
  };
  const before = row.failing_since;
  const failingSince = failure ? (before ?? finished) : null;
  db().tx(() => {
    db().run(
      `UPDATE dp_discovery_runs SET status = ?, finished_at = ?, duration_ms = ?, added = ?, changed = ?, renamed = ?, missing = ?, removed = ?, unchanged = ?,
         truncated = ?, error = ? WHERE id = ?`,
      status,
      finished,
      run.duration,
      totals.added,
      totals.changed,
      totals.renamed,
      run.missing,
      removed,
      totals.unchanged,
      cut ? 1 : 0,
      problem ? JSON.stringify(problem) : null,
      runId,
    );
    db().run(
      'UPDATE dp_discovery_sources SET last_run_at = ?, last_status = ?, failing_since = ?, next_run_at = ? WHERE id = ?',
      finished,
      status,
      failingSince,
      new Date(Date.now() + row.interval_minutes * 60_000).toISOString(),
      src.id,
    );
    // the newest runs only
    db().run(
      `DELETE FROM dp_discovery_runs WHERE source_id = ? AND id NOT IN (SELECT id FROM dp_discovery_runs WHERE source_id = ? ORDER BY started_at DESC, id DESC LIMIT ${DATA_PRODUCT_LIMITS.runsKept})`,
      src.id,
      src.id,
    );
    const changedSomething = totals.added + totals.renamed + missing.length + removed > 0;
    if (opts.trigger === 'manual' || failure || changedSomething)
      audit({
        actor,
        action: failure ? 'datadiscovery.run_failed' : 'datadiscovery.run',
        entityType: 'data_discovery_source',
        entityId: src.id,
        summary: (failure
          ? `Discovery source "${src.name}" failed: ${failure.message}`
          : `Discovery source "${src.name}" read ${platformName || 'its platform'}: ${totals.added} added, ${totals.changed} changed, ${totals.renamed} renamed, ${missing.length} missing, ${removed} removed${cut ? ' (truncated)' : ''}`
        ).slice(0, 500),
        details: {
          runId,
          status,
          trigger: opts.trigger,
          ...totals,
          missing: missing.length,
          removed,
          ...(renames.length ? { renames } : {}),
          ...(problem ? { problem: problem.code, message: problem.message } : {}),
        },
      });
  });
  // notices (WP4): the products of newly missing elements are told once; the source's managers when it starts failing
  if (missing.length) noticeElementsMissing(src.id, missing);
  if (failure && !before) noticeDiscoveryFailed(src.id, failure);
  return toRun(db().get<RunRow>('SELECT * FROM dp_discovery_runs WHERE id = ?', runId)!);
}

/**
 * The notices of ADR 0036 part 17 `elements_missing` and `discovery_failed` – sent by the notices of work package 4
 * (dataproducts/notices.ts), which replaces these two calls when it is merged. Until then they only log.
 */
function noticeElementsMissing(sourceId: string, elementIds: readonly string[]): void {
  logger.info({ source: sourceId, missing: elementIds.length }, 'data products: elements no longer found');
}
function noticeDiscoveryFailed(sourceId: string, problem: DiscoveryProblem): void {
  logger.warn({ source: sourceId, code: problem.code }, `data products: discovery failed – ${problem.message}`);
}

/** The job `data-products`: the due sources, one at a time, for at most 20 minutes; null when the vault is locked. */
export async function runDataProductsJob(now = Date.now()): Promise<{ read: number; failed: number } | null> {
  if (!vault().unlocked) return null;
  closeInterrupted();
  const due = db().all<{ id: string }>(
    'SELECT id FROM dp_discovery_sources WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY COALESCE(next_run_at, created_at), id',
    new Date(now).toISOString(),
  );
  const until = Date.now() + 20 * 60_000;
  let read = 0;
  let failed = 0;
  for (const { id } of due) {
    if (Date.now() > until) break;
    if (running.has(id)) continue;
    try {
      const r = await runSource(id, { trigger: 'schedule' });
      read++;
      if (r.status === 'failed') failed++;
    } catch (err) {
      logger.warn({ err, source: id }, 'a data products discovery run did not start');
    }
  }
  return { read, failed };
}
