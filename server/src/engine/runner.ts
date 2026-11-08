import { AsyncLocalStorage } from 'node:async_hooks';
import {
  isMutating,
  nodePorts,
  outgoing,
  type FlowNode,
  type NodeOf,
  type Platform,
  type ProcessDefinition,
  type RunStats,
  type StartRunRequest,
  type StepStatus,
  type TaskDecision,
  type DebugPause,
  type DebugSignal,
  type DebugSpec,
  type RunMode,
  validateProcess,
} from '@sm/shared';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { db } from '../db.js';
import { getSettings } from '../settings.js';
import { currentActor, runAs } from '../auth/context.js';
import { findUserByName, toAuthUser } from '../auth/users.js';
import { tracePseudonym } from '../auth/login-audit.js';
import { HttpError, newId, nowIso, parseJson, sleep } from '../util.js';
import { heldLibraryOf } from '../libraries/lookup.js';
import { getConnection } from '../platforms/service.js';
import { openInputs, sealInputs, secretValuesOf } from './secret-inputs.js';
import { resolveBaseUrl } from '../platforms/http.js';
import { definitionHash, getProcess, permissionsFor } from '../processes/service.js';
import { evalBool, evalExpr, evalList, render, renderString, type Bindings, type EvalOptions } from './expr.js';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { BrowserSession } from './browser.js';
import * as store from './store.js';
import { completeManual, manualSpec, verifyManual, type ManualCompletionInput, type Settled } from './manual.js';
import { metricForRun } from '../dashboards/datasets.js';
import { builtinDatasetVisible } from '../dashboards/builtin.js';
import { ANY, INPUT, inputSources, runSources } from '../ai/provenance.js';
import { logger } from '../log.js';
import { withSpan } from '../telemetry.js';
import { forecastTo } from '@sm/shared';
import { emit } from '../events.js';
import { isInternalError, isUnexpected, reportError } from '../errorReporting.js';
import { systemsForProcess } from '../catalogue/systems.js';
import { modeOf, modeOfRow, type DebugNodeSeed, type RunEngine, type RunSignal, type RunState, type SignalResult, type StartCommand } from './engine.js';
import { DebugGate, type GateAction } from './debug-gate.js';
import { Redactor } from './redact.js';
import { coerceInputs } from './inputs.js';
import { Cancelled, type Binding, type LeafResult, type StepContext, type StepType, type TaskResult } from './steps/context.js';
import { stepOf } from './steps/index.js';
import { taskView } from './steps/user-task.js';

// ---------------------------------------------------------------------------
// Run context
// ---------------------------------------------------------------------------

/**
 * Per-item variable scope of parallel for-each loops: the body of each item sees
 * a copy of the outer vars, so its writes stay local to the item.
 */
const varScope = new AsyncLocalStorage<{ ctx: RunContext; vars: Record<string, unknown> }>();

class RunContext implements StepContext {
  /** Test run (#105): platform calls are answered by recorded responses (always also a dry run). */
  recorded = false;
  /** A debug run (ADR 0010): one node or a step-through run; never a live run */
  debug?: DebugSpec;
  /** Single-node debug run: the pasted answer, the simulated decision */
  debugNode?: DebugNodeSeed;
  /** Step-through debug run: the pause gate */
  gate?: DebugGate;
  /** Written to the audit log: false for an offline single-node run, which touches nothing (like the expression assistant) */
  audited = true;
  /** Why the run was cancelled, and by whom (the run.cancelled entry says so) */
  cancelReason?: string;
  cancelledBy?: string;
  /** Run-level variables (outside parallel loop bodies). */
  rootVars: Record<string, unknown> = {};
  journal: Map<string, store.StepRow>;
  processId: string;
  /** Who resumed the run (undefined for a fresh start). */
  resumedBy?: string;
  /** Open waits (user tasks, sub-process runs); the run shows "waiting" while > 0. */
  private waits = 0;
  /** Marked interrupted at shutdown (interruptBusyRuns): what is left of it must not change the run's status. */
  interrupted = false;
  redactor = new Redactor();
  abort = new AbortController();
  browser?: BrowserSession;
  /** Page navigations the outbound policy blocked (the browser only sees an aborted request), in order */
  browserBlocked: string[] = [];
  /** Redirect hops (followed by Chromium itself) the policy refuses, not yet reported */
  browserRedirects: string[] = [];
  stats: RunStats;
  nodes: Map<string, FlowNode>;
  activations = new Map<string, number>();
  totalActivations = 0;
  /** Answers of "Ask an AI model" steps (text → model): reports and check messages that carry one are marked */
  private aiTexts = new Map<string, string>();
  /** Where each variable's value may come from (ai/provenance.ts): every source ever written to the name in this run */
  private provenance = new Map<string, Set<string>>();
  private anySources?: Set<string>;
  private inputSourceSet?: Set<string>;

  constructor(
    public runId: string,
    public def: ProcessDefinition,
    public inputs: Record<string, unknown>,
    public bindings: Record<string, Binding>,
    public dryRun: boolean,
    public actor: string,
    public startedAt: string,
    stats: RunStats,
  ) {
    this.journal = store.loadJournal(runId);
    this.processId = store.runRow(runId).process_id;
    this.nodes = new Map(def.nodes.map((n) => [n.id, n]));
    this.stats = stats;
    for (const b of Object.values(bindings)) this.redactor.add(...Object.values(b.secrets));
  }

  /** Remembers an AI answer (strings of 12 characters or more: shorter ones are too common to mean anything). */
  rememberAiText(text: unknown, model: string): void {
    if (typeof text !== 'string') return;
    const t = text.trim();
    if (t.length >= 12 && this.aiTexts.size < 5000) this.aiTexts.set(t, model);
  }

  /** The models whose answers appear in these values, or undefined: they carry AI-generated text. */
  aiModelsIn(...values: unknown[]): string[] | undefined {
    if (!this.aiTexts.size) return undefined;
    const models = new Set<string>();
    const visit = (v: unknown, depth: number): void => {
      if (depth > 20) return;
      if (typeof v === 'string') {
        for (const [t, m] of this.aiTexts) if (v.includes(t)) models.add(m);
      } else if (Array.isArray(v)) v.forEach((x) => visit(x, depth + 1));
      else if (v && typeof v === 'object') Object.values(v).forEach((x) => visit(x, depth + 1));
    };
    values.forEach((v) => visit(v, 0));
    return models.size ? [...models].sort() : undefined;
  }

  /** Records where a value written to a variable comes from (also when a resumed run replays the step). */
  taint(name: string, sources: Iterable<string>): void {
    let set = this.provenance.get(name);
    if (!set) this.provenance.set(name, (set = new Set()));
    for (const x of sources) set.add(x);
  }

  /** The recorded sources of variables (ANY for one without a record). */
  sourcesOf(names: readonly string[]): Set<string> {
    const out = new Set<string>();
    for (const n of names) for (const x of this.provenance.get(n) ?? [ANY]) out.add(x);
    return out;
  }

  /**
   * A single-node debug run with variables and inputs copied from another run (ADR 0010): they may carry everything
   * that run read, so its sources count here too – the AI allowed-data rule holds for copied data.
   */
  copiedFrom?: string;
  private withCopied(own: Set<string>, of: (runId: string) => Set<string>): Set<string> {
    if (this.copiedFrom) for (const x of of(this.copiedFrom)) own.add(x);
    return own;
  }

  /** Sources with ANY and INPUT expanded to what they stand for in this run: platform ids, INPUT, dataset:<key>. */
  expandSources(sources: Iterable<string>): Set<string> {
    const out = new Set<string>();
    for (const x of sources) {
      if (x === ANY) for (const y of (this.anySources ??= this.withCopied(runSources(this.runId), runSources))) out.add(y);
      else if (x === INPUT) for (const y of (this.inputSourceSet ??= this.withCopied(inputSources(this.runId), inputSources))) out.add(y);
      else out.add(x);
    }
    return out;
  }

  /** Status of a step as recorded in the run journal (for traces). */
  journalStatus(key: string): string | undefined {
    return db().get<{ status: string }>('SELECT status FROM run_steps WHERE run_id = ? AND key = ?', this.runId, key)?.status;
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  /** Variables of the current scope (the item's own copy inside a parallel loop body). */
  get vars(): Record<string, unknown> {
    const s = varScope.getStore();
    return s && s.ctx === this ? s.vars : this.rootVars;
  }

  /** Waiting for a person, a sub-process run or a timer: the run does not take a slot (SM_MAX_CONCURRENT_RUNS). */
  get waiting(): boolean {
    return this.waits > 0;
  }

  beginWait(): void {
    if (this.waits++ === 0) {
      store.setRunStatus(this.runId, 'waiting');
      // its slot is free while it waits
      queueMicrotask(pumpQueue);
    }
  }
  endWait(): void {
    if (--this.waits <= 0) {
      this.waits = 0;
      if (!this.signal.aborted && !this.interrupted) store.setRunStatus(this.runId, 'running');
    }
  }

  scope(): Record<string, unknown> {
    const conn: Record<string, unknown> = {};
    for (const [slot, b] of Object.entries(this.bindings)) {
      conn[slot] = { name: b.platform.name, kind: b.platform.kind, baseUrl: b.baseUrl, vars: b.platform.config.variables ?? {} };
    }
    return {
      inputs: this.inputs,
      vars: this.vars,
      const: this.def.constants ?? {},
      run: { id: this.runId, dryRun: this.dryRun, actor: this.actor, startedAt: this.startedAt },
      conn,
    };
  }

  bindingsFn(extra: Bindings = {}): Bindings {
    return {
      // usable inside filters, where plain `inputs` would refer to the current item
      inputs: this.inputs,
      vars: this.vars,
      const: this.def.constants ?? {},
      secret: (slot: string, key: string) => {
        const b = this.bindings[slot];
        if (!b) throw new Error(`Unknown connection "${slot}"`);
        const v = b.secrets[key];
        if (v === undefined) throw new Error(`Secret "${key}" is not set on ${b.platform.name}`);
        this.redactor.add(v);
        return v;
      },
      pvar: (slot: string, name: string, fallback?: unknown) => {
        const v = this.bindings[slot]?.platform.config.variables?.[name];
        return v === undefined || v === '' ? fallback : v;
      },
      // every system with its tech stack and end of life (#129), also systems no application runs on
      systems: () => systemsForProcess(),
      // trends of dataset metrics (#145): $trend('ih.assets/attributes', '7d'), $daysUntil('ih.assets/attributes', 1000)
      trend: (ref: string, window: string = '7d') => {
        const t = this.metric(ref, window)?.trend;
        return t
          ? { change: t.change, changePct: t.changePct, perDay: t.perDay, end: t.end, points: t.points, confidence: t.confidence, window: t.window }
          : null;
      },
      daysUntil: (ref: string, limit?: number, window: string = '30d') => {
        const s = this.metric(ref, window);
        if (!s) return null;
        const l = typeof limit === 'number' ? { value: limit, lower: false } : s.limit;
        if (!l) return null;
        const f = forecastTo(s.points, l.value, { window, lower: l.lower });
        return f && (f.state === 'approaching' || f.state === 'reached') ? f.days : null;
      },
      ...extra,
    };
  }

  /** A dataset metric with its trend, for $trend/$daysUntil: datasets of this process, or of processes the actor may view. */
  metric(ref: string, window: string) {
    return metricForRun(String(ref), String(window), {
      runId: this.runId,
      processId: this.processId,
      mayRead: (pid) => {
        if (pid.startsWith('monitor:') || pid.startsWith('ai:')) {
          const u = findUserByName(this.actor);
          return !!u && u.active && runAs(toAuthUser(u), () => builtinDatasetVisible(pid) === true);
        }
        return actorPermissions(this.actor, pid).includes('view');
      },
    });
  }

  /** Guard rails of every expression of this run (default limits, cancelled with the run). */
  get evalOptions(): EvalOptions {
    return { signal: this.signal };
  }
  eval(expr: string, extra?: Bindings) {
    return evalExpr(expr, this.scope(), this.bindingsFn(extra), this.evalOptions);
  }
  bool(expr: string, extra?: Bindings) {
    return evalBool(expr, this.scope(), this.bindingsFn(extra), this.evalOptions);
  }
  list(expr: string, extra?: Bindings) {
    return evalList(expr, this.scope(), this.bindingsFn(extra), this.evalOptions);
  }
  render(v: unknown, extra?: Bindings) {
    return render(v, this.scope(), this.bindingsFn(extra), this.evalOptions);
  }
  str(v: string | undefined, extra?: Bindings) {
    return renderString(v, this.scope(), this.bindingsFn(extra), this.evalOptions);
  }
  /** Evaluate an expression against a single item ($item, and item fields at root). */
  item(expr: string, item: unknown) {
    return evalExpr(expr, item, this.bindingsFn({ item, vars: this.vars, inputs: this.inputs }), this.evalOptions);
  }
  /** Evaluate an expression against response data (pagination paths). */
  data(expr: string, root: unknown) {
    return evalExpr(expr, root, {}, this.evalOptions);
  }

  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, stepKey?: string | null, data?: unknown) {
    store.addLog(this.runId, level, this.redactor.apply(message), stepKey, data === undefined ? undefined : this.redactor.apply(data));
  }

  /** Waits for the decision on a task: settleTask (a signal) calls the waiter, cancelRun or the run's abort ends it. */
  async awaitTask(taskId: string): Promise<TaskResult | null> {
    try {
      return await new Promise<TaskResult | null>((resolve) => {
        taskWaiters.set(taskId, resolve);
        this.signal.addEventListener('abort', () => resolve(null), { once: true });
      });
    } finally {
      taskWaiters.delete(taskId);
    }
  }

  /** A sub-process run inherits the run's mode and actor (ADR 0011, invariant 6); the child of a debug run is a debug run without pauses. */
  startChild(stepKey: string, req: StartRunRequest): Promise<string> {
    return startRun(
      { ...req, dryRun: this.dryRun, recorded: this.recorded },
      {
        trigger: 'subprocess',
        actor: this.actor,
        parent: { runId: this.runId, stepKey },
        // the child of a debug run is a debug run in the same mode, without pauses (ADR 0010)
        ...(this.debug ? { debug: { spec: { kind: 'step' as const, ...(this.debug.recordedFrom ? { recordedFrom: this.debug.recordedFrom } : {}) } } } : {}),
      },
    );
  }

  waitForChild(childId: string, stepKey: string): Promise<store.RunRow> {
    return waitForChildRun(childId, this, stepKey);
  }
}

class StepFailure extends Error {
  constructor(
    message: string,
    public stepKey: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

interface Active {
  ctx: RunContext;
  done: Promise<void>;
}

const active = new Map<string, Active>();
const taskWaiters = new Map<string, (d: TaskResult | null) => void>();

export function isActive(runId: string): boolean {
  return active.has(runId);
}

export function activeRunIds(): string[] {
  return [...active.keys()];
}

// ---------------------------------------------------------------------------
// Concurrency limit (SM_MAX_CONCURRENT_RUNS) and shutdown
// ---------------------------------------------------------------------------

/** Queued runs in order of arrival (status 'queued' in the database; recovery reloads them by started_at). */
const runQueue: string[] = [];
/** Queued runs being started (their bindings are resolved): they hold a slot already. */
let starting = 0;
let accepting = true;

/** Runs that take a slot: active and not waiting (for a person, a sub-process run or a timer). */
export function busyRunIds(): string[] {
  return [...active.entries()].filter(([, a]) => !a.ctx.waiting).map(([id]) => id);
}

export function queuedRunIds(): string[] {
  return [...runQueue];
}

function slotFree(): boolean {
  const max = config.maxConcurrentRuns;
  return !max || busyRunIds().length + starting < max;
}

/** Starts queued runs while slots are free (first come, first served). */
function pumpQueue(): void {
  while (accepting && runQueue.length && slotFree()) {
    const id = runQueue.shift()!;
    starting++;
    void startQueued(id).finally(() => {
      starting--;
      pumpQueue();
    });
  }
}

async function startQueued(runId: string): Promise<void> {
  const r = db().get<store.RunRow & { sealed_inputs?: string | null }>('SELECT * FROM runs WHERE id = ?', runId);
  if (!r || r.status !== 'queued' || active.has(runId)) return;
  try {
    const proc = getProcess(r.process_id, r.process_version);
    const bindingInfo = parseJson<Record<string, { platformId: string }>>(r.bindings, {});
    // outside any request: the run is not attributed to whoever happened to free the slot
    const bindings = await runAs(null, () =>
      resolveBindings(proc.definition, Object.fromEntries(Object.entries(bindingInfo).map(([k, v]) => [k, v.platformId]))),
    );
    const startedAt = nowIso();
    // cancelled while its bindings were resolved?
    if (!db().run("UPDATE runs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'", startedAt, runId).changes) return;
    const waited = Math.max(0, Math.round((Date.parse(startedAt) - Date.parse(r.started_at)) / 1000));
    store.addLog(runId, 'info', `Started after waiting ${waited} s for a free slot (at most ${config.maxConcurrentRuns} runs at the same time)`);
    runAs(null, () =>
      launch(
        runId,
        proc.definition,
        openInputs(parseJson(r.inputs, {}), r.sealed_inputs),
        bindings,
        !!r.dry_run,
        r.actor,
        startedAt,
        store.emptyStats(),
        undefined,
        !!r.recorded,
        r.debug ? { debug: { spec: parseJson<DebugSpec>(r.debug, { kind: 'step' }) } } : {},
      ),
    );
  } catch (e) {
    const error = (e as Error).message || String(e);
    logger.warn({ err: e, runId }, 'queued run could not start');
    store.setRunStatus(runId, 'failed', { error: `Could not start: ${error}`, finished: true });
    audit({ actor: r.actor, action: 'run.failed', entityType: 'run', entityId: runId, runId, summary: `Queued run could not start: ${error.slice(0, 200)}` });
    emit('run.finished', {
      runId,
      processId: r.process_id,
      processName: r.process_name,
      actor: r.actor,
      trigger: r.trigger,
      scheduleId: r.schedule_id ?? null,
      dryRun: !!r.dry_run,
      status: 'failed',
      error,
      durationMs: 0,
    });
  }
}

/** Shutdown, step 1: no new runs start (requests get 503 SHUTTING_DOWN; sub-process runs are queued and start after the restart). */
export function stopAcceptingRuns(): void {
  accepting = false;
}
export const acceptingRuns = (): boolean => accepting;

/**
 * Shutdown, step 2: waits up to `graceMs` until no run takes a slot – runs waiting for a person (or a timer, or a
 * sub-process run) are persisted and resume after the restart, so they are not waited for. Returns the runs still busy.
 */
export async function drainRuns(graceMs: number, pollMs = 100): Promise<string[]> {
  const until = Date.now() + graceMs;
  while (busyRunIds().length && Date.now() < until) await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(1, until - Date.now()))));
  return busyRunIds();
}

/** Shutdown, step 3: what recovery would do at the next start, done now – the runs still busy are marked interrupted. */
export function interruptBusyRuns(): string[] {
  const ids = busyRunIds();
  for (const id of ids) {
    const a = active.get(id);
    try {
      store.setRunStatus(id, 'interrupted');
      audit({
        actor: 'system',
        action: 'run.interrupted',
        entityType: 'run',
        entityId: id,
        runId: id,
        summary: 'Run was interrupted because Steward was stopped. Review and resume or cancel it.',
      });
      store.addLog(id, 'warn', 'Interrupted: Steward was stopped while this run was still running');
    } catch (err) {
      logger.warn({ err, runId: id }, 'could not mark the run interrupted');
    }
    // its remaining work must not overwrite the status (the process exits right after)
    if (a) a.ctx.interrupted = true;
  }
  return ids;
}

/**
 * For tests: what a restart leaves of a waiting run – the run only in the record. Its context and task waiters are
 * dropped (never resolved), so a later decision replays the run from its journal.
 */
export async function forgetRunForTests(runId: string): Promise<void> {
  const a = active.get(runId);
  if (!a) return;
  a.ctx.interrupted = true;
  for (const t of store.listTasks({ runId, status: 'open' })) taskWaiters.delete(t.id);
  active.delete(runId);
}

/** For tests: start accepting runs again after a simulated shutdown. */
export function resumeAcceptingRuns(): void {
  accepting = true;
  pumpQueue();
}

/**
 * `only`: the slots to resolve (a single-node debug run resolves only its node's slots); `offline`: no slot is resolved,
 * each gets a placeholder without credentials that answers only from a pasted answer or a sample answer.
 */
async function resolveBindings(
  def: ProcessDefinition,
  requested: Record<string, string>,
  o: { only?: Set<string>; offline?: boolean } = {},
): Promise<Record<string, Binding>> {
  const out: Record<string, Binding> = {};
  for (const slot of def.connections) {
    if (o.only && !o.only.has(slot.slot)) continue;
    if (o.offline) {
      out[slot.slot] = { platform: offlinePlatform(slot.slot, slot.kind), secrets: {}, baseUrl: OFFLINE_BASE };
      continue;
    }
    const pid = requested[slot.slot];
    if (!pid) throw new HttpError(400, `Select a platform for connection "${slot.slot}"`);
    // the platform with its default identity (0.9.0, ADR 0009: choosing another one per slot comes in step 2)
    const { platform, secrets } = getConnection(pid);
    out[slot.slot] = { platform, secrets, baseUrl: await resolveBaseUrl(platform, secrets) };
  }
  return out;
}

/** The placeholder of an offline single-node run: nothing behind it is ever contacted. */
const OFFLINE_BASE = 'https://offline.invalid';
function offlinePlatform(slot: string, kind?: string): Platform {
  return { id: `offline:${slot}`, name: `${slot} (offline)`, kind: kind ?? 'generic', baseUrl: OFFLINE_BASE, config: { variables: {} } } as unknown as Platform;
}

/** The debug part of a start: what is stored (`spec`) and, for a single node, its seed. */
export interface DebugStart {
  spec: DebugSpec;
  seed?: DebugNodeSeed;
}

/** The slots a node uses (a single-node debug run resolves only these). */
export function nodeSlots(node: FlowNode): Set<string> {
  const out = new Set<string>();
  const c = (node as { connection?: unknown }).connection;
  if (typeof c === 'string' && c) out.add(c);
  if (node.type === 'subprocess') for (const v of Object.values(node.connections ?? {})) out.add(v);
  return out;
}

/** Single-node debug runs per person at the same time (they never wait for a slot of SM_MAX_CONCURRENT_RUNS). */
export const MAX_NODE_RUNS_PER_PERSON = 2;
const nodeRunsOf = new Map<string, number>();
function releaseNodeRun(actor: string): void {
  const n = (nodeRunsOf.get(actor) ?? 1) - 1;
  if (n > 0) nodeRunsOf.set(actor, n);
  else nodeRunsOf.delete(actor);
}

type StartOpts = Parameters<typeof startRunInner>[1];

export async function startRun(req: StartRunRequest, opts: StartOpts = {}): Promise<string> {
  // a single node runs at once, never queued behind scheduled runs – but at most two per person at a time (reserved
  // before anything is awaited, so parallel requests cannot slip past)
  const nodeActor = opts.debug?.spec.kind === 'node' && !opts.parent ? (opts.actor ?? currentActor()) : null;
  if (nodeActor) {
    if ((nodeRunsOf.get(nodeActor) ?? 0) >= MAX_NODE_RUNS_PER_PERSON)
      throw new HttpError(429, `${MAX_NODE_RUNS_PER_PERSON} of your single-node runs are still running – wait until one has finished`, 'DEBUG_NODE_BUSY', {
        max: MAX_NODE_RUNS_PER_PERSON,
      });
    nodeRunsOf.set(nodeActor, (nodeRunsOf.get(nodeActor) ?? 0) + 1);
  }
  try {
    return await startRunInner(req, { ...opts, nodeActor });
  } catch (e) {
    if (nodeActor) releaseNodeRun(nodeActor);
    throw e;
  }
}

async function startRunInner(
  req: StartRunRequest,
  opts: {
    trigger?: 'manual' | 'schedule' | 'subprocess' | 'webhook' | 'monitor' | 'debug';
    scheduleId?: string;
    /** Webhook trigger (trigger 'webhook') or monitor (trigger 'monitor', with the output id) that started the run */
    webhook?: { triggerId: string; triggerName: string; test?: boolean; output?: string };
    actor?: string;
    /** Sub-process: the run and step (activation key) that started this run */
    parent?: { runId: string; stepKey: string };
    /** A debug run (ADR 0010): never live */
    debug?: DebugStart;
    /** Internal: the person whose single-node run slot this run holds until it ends */
    nodeActor?: string | null;
  } = {},
): Promise<string> {
  if (!accepting && opts.trigger !== 'subprocess') throw new HttpError(503, 'Steward is shutting down: no new runs start now', 'SHUTTING_DOWN');
  const debug = opts.debug;
  if (debug && !req.dryRun && !req.recorded) throw new HttpError(400, 'A debug run is a dry run or a test run, never a live run', 'DEBUG_LIVE_RUN');
  const proc = getProcess(req.processId, req.version);
  // a library on hold (ADR 0014: its key was revoked, or it is suspect): no new runs of its processes until it is lifted
  const held = heldLibraryOf(proc.id);
  if (held)
    throw new HttpError(409, `The library ${held} is on hold – its processes do not run until an administrator lifts the hold`, 'LIBRARY_HELD', {
      library: held,
    });
  let def = proc.definition;
  let defHash = proc.definitionHash;
  const node = debug?.spec.kind === 'node' ? debugNodeOf(def, debug) : undefined;
  if (node && debug?.seed?.node) {
    // the editor's unsaved node: checked like a saved definition; the run's definition hash covers it
    const checked = validateProcess({ ...def, nodes: def.nodes.map((n) => (n.id === node.id ? node : n)) });
    if (!checked.ok || !checked.definition) {
      throw Object.assign(new HttpError(400, 'Invalid node: ' + checked.issues.map((x) => `${x.path}: ${x.message}`).join('; '), 'DEBUG_NODE_INVALID'), {
        issues: checked.issues,
      });
    }
    def = checked.definition;
    defHash = definitionHash(def);
  }
  // a test run is a dry run whose platform calls are answered by recorded responses
  const recorded = !!req.recorded;
  if (recorded) req = { ...req, dryRun: true };
  const inputs = coerceInputs(def.inputs ?? [], req.inputs ?? {}, !!node);
  // inputs of type "secret": only stored encrypted, "***" in the protocol and the audit log
  const { visible: storedInputs, sealed } = sealInputs(def.inputs, inputs);
  const offline = debug?.spec.answers === 'offline';
  const bindings = await resolveBindings(def, req.bindings ?? {}, node ? { only: nodeSlots(node), offline } : {});
  const runId = newId('run_');
  const actor = opts.actor ?? currentActor();
  const startedAt = nowIso();
  const bindingInfo = Object.fromEntries(
    Object.entries(bindings).map(([k, b]) => [k, { platformId: b.platform.id, platformName: b.platform.name, baseUrl: b.baseUrl }]),
  );
  // all slots taken (or others waiting before it, or shutting down: a sub-process run then starts after the restart);
  // a single-node debug run executes one node at once
  const queued = !node && (!accepting || runQueue.length > 0 || !slotFree());
  const busy = busyRunIds().length;
  // an offline single node touches nothing: like the expression assistant, it is not audited (it is still stored)
  const audited = !(node && offline);
  const mode = modeOf(req);
  const trigger = opts.trigger ?? 'manual';
  db().tx(() => {
    db().run(
      `INSERT INTO runs (id, process_id, process_name, process_version, definition_hash, status, dry_run, recorded, trigger, schedule_id, actor, inputs, bindings, started_at, stats, parent_run_id, parent_step_key, trigger_id, trigger_name, trigger_output, sealed_inputs, debug)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      runId,
      proc.id,
      proc.name,
      req.version ?? proc.currentVersion,
      defHash,
      queued ? 'queued' : 'running',
      req.dryRun ? 1 : 0,
      recorded ? 1 : 0,
      trigger,
      opts.scheduleId ?? null,
      actor,
      JSON.stringify(storedInputs),
      JSON.stringify(bindingInfo),
      startedAt,
      JSON.stringify(store.emptyStats()),
      opts.parent?.runId ?? null,
      opts.parent?.stepKey ?? null,
      opts.webhook?.triggerId ?? null,
      opts.webhook?.triggerName ?? null,
      opts.webhook?.output ?? null,
      sealed,
      debug ? JSON.stringify(debug.spec) : null,
    );
    if (!audited) return;
    const kindText = debug ? (debug.spec.kind === 'node' ? `Debug run of node "${debug.spec.nodeId}" (${debug.spec.answers})` : 'Debug run') : '';
    audit({
      actor,
      action: 'run.started',
      entityType: 'process',
      entityId: proc.id,
      runId,
      summary: `${kindText ? `${kindText}${recorded ? ', test run' : ', dry run'}` : recorded ? 'Test run' : req.dryRun ? 'Dry run' : 'Run'} of "${proc.name}" v${req.version ?? proc.currentVersion} started (${trigger}${opts.parent ? ` by run ${opts.parent.runId}` : ''}${opts.webhook ? ` "${opts.webhook.triggerName}"${opts.webhook.test ? ', test' : ''}` : ''})${queued ? (accepting ? `; queued: ${busy} of at most ${config.maxConcurrentRuns} runs are running` : '; queued: Steward is shutting down, it starts after the restart') : ''}`,
      details: {
        ...(queued ? { queued: true } : {}),
        inputs: storedInputs,
        bindings: bindingInfo,
        definitionHash: defHash,
        dryRun: !!req.dryRun,
        ...(recorded ? { recorded: true } : {}),
        // mode on run.started (ADR 0011); debug: what kind of debug run and where its variables came from – never values
        ...(debug ? { mode, debug: debugDetails(debug.spec) } : {}),
        scheduleId: opts.scheduleId,
        ...(opts.webhook ? { triggerId: opts.webhook.triggerId, test: !!opts.webhook.test } : {}),
        ...(opts.parent ? { parentRunId: opts.parent.runId, parentStepKey: opts.parent.stepKey } : {}),
      },
    });
  });
  if (queued) {
    runQueue.push(runId);
    store.addLog(
      runId,
      'info',
      accepting
        ? `Waiting for a free slot: at most ${config.maxConcurrentRuns} runs run at the same time`
        : 'Waiting: Steward is shutting down, the run starts after the restart',
    );
    pumpQueue();
    return runId;
  }
  launch(runId, def, inputs, bindings, !!req.dryRun, actor, startedAt, store.emptyStats(), undefined, recorded, { debug, audited, nodeActor: opts.nodeActor });
  return runId;
}

/** The node a single-node debug run executes (the editor's unsaved node takes its place). */
function debugNodeOf(def: ProcessDefinition, debug: DebugStart): FlowNode {
  const id = debug.spec.nodeId ?? '';
  const saved = def.nodes.find((n) => n.id === id);
  const draft = debug.seed?.node;
  if (draft && draft.id !== id) throw new HttpError(400, 'The unsaved node must keep its id', 'DEBUG_NODE_INVALID');
  const n = draft ?? saved;
  if (!n) throw new HttpError(404, `Node ${id.slice(0, 100)} not found`, 'DEBUG_NODE_NOT_FOUND');
  if (n.type === 'start' || n.type === 'note') throw new HttpError(400, 'This node does not run on its own', 'DEBUG_NODE_NOT_RUNNABLE');
  return n;
}

/** The audit details of a debug run: kind, node, answers, where the variables came from – never their values. */
function debugDetails(d: DebugSpec): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      kind: d.kind,
      nodeId: d.nodeId,
      answers: d.answers,
      varsFrom: d.varsFrom,
      varsRunId: d.varsRunId,
      draft: d.draft,
      pasted: d.pasted,
      pauseBeforeEach: d.pauseBeforeEach,
      breakpoints: d.breakpoints?.length,
    }).filter(([, v]) => v !== undefined),
  );
}

function launch(
  runId: string,
  def: ProcessDefinition,
  inputs: Record<string, unknown>,
  bindings: Record<string, Binding>,
  dryRun: boolean,
  actor: string,
  startedAt: string,
  stats: RunStats,
  resumedBy?: string,
  recorded = false,
  extra: { debug?: DebugStart; audited?: boolean; nodeActor?: string | null } = {},
): void {
  const ctx = new RunContext(runId, def, inputs, bindings, dryRun || recorded, actor, startedAt, stats);
  ctx.recorded = recorded;
  ctx.redactor.add(...secretValuesOf(def.inputs, inputs));
  ctx.resumedBy = resumedBy;
  ctx.audited = extra.audited ?? true;
  if (extra.debug) {
    ctx.debug = { ...extra.debug.spec };
    if (extra.debug.spec.kind === 'node') {
      ctx.debugNode = extra.debug.seed ?? { vars: {} };
      ctx.rootVars = { ...ctx.debugNode.vars };
      // variables copied from a run carry that run's sources; sample data a person typed or pasted is a run input
      const src = extra.debug.spec.varsFrom === 'run' ? extra.debug.spec.varsRunId : undefined;
      if (src) ctx.copiedFrom = src;
      const sources = src ? [...runSources(src)] : [INPUT];
      for (const k of Object.keys(ctx.rootVars)) ctx.taint(k, sources);
    } else if (!store.runRow(runId).parent_run_id) {
      // pauses only in the run the person steps through; its sub-process runs run without them
      ctx.gate = new DebugGate({ pauseBeforeEach: extra.debug.spec.pauseBeforeEach, breakpoints: extra.debug.spec.breakpoints });
    }
  }
  const done = execute(ctx).finally(() => {
    ctx.gate?.close();
    if (extra.nodeActor) releaseNodeRun(extra.nodeActor);
    active.delete(runId);
    pumpQueue();
  });
  active.set(runId, { ctx, done });
}

/** Resume a waiting/interrupted run by replaying its journal. */
export async function resumeRun(runId: string, actor = currentActor()): Promise<void> {
  if (active.has(runId)) return;
  const r = store.runRow(runId);
  if (!['waiting', 'interrupted'].includes(r.status)) throw new HttpError(409, `Run is ${r.status}`);
  // a debug run lives in one session of its debugger: it is never resumed (ADR 0010)
  if (r.debug) throw new HttpError(409, 'A debug run cannot be resumed – start a new one', 'DEBUG_NOT_RESUMABLE');
  const proc = getProcess(r.process_id, r.process_version);
  const bindingInfo = parseJson<Record<string, { platformId: string }>>(r.bindings, {});
  const bindings = await resolveBindings(proc.definition, Object.fromEntries(Object.entries(bindingInfo).map(([k, v]) => [k, v.platformId])));
  store.setRunStatus(runId, 'running');
  audit({ actor, action: 'run.resumed', entityType: 'run', entityId: runId, runId, summary: `Run resumed (was ${r.status})` });
  launch(
    runId,
    proc.definition,
    openInputs(parseJson(r.inputs, {}), (r as { sealed_inputs?: string | null }).sealed_inputs),
    bindings,
    !!r.dry_run,
    r.actor,
    r.started_at,
    { ...store.emptyStats(), ...parseJson(r.stats, {}) },
    actor,
    !!r.recorded,
  );
}

/**
 * Cancels a run with a reason (ADR 0011: the run.cancelled entry says why): its open tasks, the step's open request
 * (AbortSignal), its place in the queue and its unfinished sub-process runs.
 */
export async function cancelRun(runId: string, actor = currentActor(), reason = `Cancelled by ${actor}`): Promise<void> {
  const r = store.runRow(runId);
  if (['succeeded', 'failed', 'cancelled'].includes(r.status)) throw new HttpError(409, `Run already ${r.status}`);
  const why = cancelReasonText(reason);
  const a = active.get(runId);
  for (const t of store.listTasks({ runId, status: 'open' })) {
    try {
      store.decideTask(t.id, 'cancelled', null, actor);
    } catch {
      continue; // decided in the meantime (exactly once): its waiter was settled by that decision
    }
    taskWaiters.get(t.id)?.(null);
    taskWaiters.delete(t.id);
    decisionSettled(t.id, { status: 'cancelled', by: actor });
  }
  if (a) {
    a.ctx.cancelReason ??= why;
    a.ctx.cancelledBy ??= actor;
    a.ctx.abort.abort();
  }
  const queuedAt = runQueue.indexOf(runId);
  if (queuedAt >= 0) runQueue.splice(queuedAt, 1);
  // sub-process runs started by this run are cancelled with it
  for (const child of store.unfinishedChildRuns(runId)) {
    await cancelRun(child, actor, `Parent run ${runId} was cancelled: ${why}`).catch((e) =>
      logger.warn({ err: e, runId: child }, 'could not cancel sub-process run'),
    );
  }
  if (a) {
    await a.done.catch(() => undefined); // the earlier run reports its own failure
  } else {
    store.setRunStatus(runId, 'cancelled', { finished: true });
    if (!isOfflineNodeRun(r))
      audit({
        actor,
        action: 'run.cancelled',
        entityType: 'run',
        entityId: runId,
        runId,
        summary: `Run cancelled by ${actor}${reasonTail(why, actor)}`,
        details: { reason: why, cancelledBy: actor },
      });
  }
}

/** A cancel reason as plain text: one line, no control characters, at most 500 characters. */
export function cancelReasonText(reason: string): string {
  const oneLine = [...reason].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('');
  return oneLine.replace(/\s+/g, ' ').trim().slice(0, 500) || 'Cancelled';
}

/** The reason after "cancelled by <who>" – left out when it only repeats that (the default reason). */
function reasonTail(reason: string, by: string): string {
  return reason === `Cancelled by ${by}` ? '' : ` – reason: ${reason.slice(0, 200)}`;
}

/** An offline single-node debug run (never audited). */
function isOfflineNodeRun(r: store.RunRow): boolean {
  const d = r.debug ? parseJson<DebugSpec | null>(r.debug, null) : null;
  return d?.kind === 'node' && d.answers === 'offline';
}

export async function completeTask(taskId: string, decision: TaskDecision, actor = currentActor(), auditExtra: Record<string, unknown> = {}): Promise<void> {
  const t = store.getTask(taskId);
  if (t.status !== 'open') throw new HttpError(409, `Task is ${t.status}`);
  if (t.mode === 'manual') throw new HttpError(400, 'Complete a manual step with its checklist and fields', 'TASK_IS_MANUAL');
  const validKeys = new Set(t.items.map((i) => i.key));
  const selectedKeys = (decision.selectedKeys ?? []).filter((k) => validKeys.has(k));
  const d: TaskDecision = {
    approved: !!decision.approved,
    selectedKeys,
    comment: decision.comment?.slice(0, 4000),
    // decided from a card in Microsoft Teams (ADR 0013): stored with the decision, shown in protocols and evidence
    ...(decision.via === 'teams' ? { via: 'teams' as const } : {}),
  };
  const at = nowIso();
  db().tx(() => {
    store.decideTask(taskId, 'completed', d, actor);
    audit({
      actor,
      action: 'task.completed',
      entityType: 'task',
      entityId: taskId,
      runId: t.runId,
      summary:
        t.mode === 'approve'
          ? `"${t.title}" ${d.approved ? 'approved' : 'rejected'}${d.via === 'teams' ? ' via Microsoft Teams' : ''}`
          : `"${t.title}": ${selectedKeys.length} of ${t.items.length} items selected`,
      details: { decision: d, unselectedKeys: t.items.map((i) => i.key).filter((k) => !selectedKeys.includes(k)), ...auditExtra },
    });
  });
  decisionSettled(taskId, {
    status: d.approved || t.mode !== 'approve' ? (t.mode === 'approve' ? 'approved' : 'completed') : 'rejected',
    by: actor,
    at,
    via: decision.via,
  });
  await settleTask(taskId, t.runId, { decision: d, by: actor, at }, actor);
}

/**
 * The outcome follows the decision cards to their channels (ADR 0013 stage 1, msteams/cards.ts), outside the
 * deciding step; a failure there never touches the run.
 */
export function decisionSettled(
  taskId: string,
  o: { status: 'approved' | 'rejected' | 'completed' | 'cancelled'; by: string; at?: string; via?: 'teams' },
): void {
  setImmediate(() => {
    void import('../msteams/followup.js').then((m) => m.taskSettled(taskId, o)).catch((err) => logger.warn({ err, taskId }, 'decision follow-up failed'));
  });
}

/** Lets the waiting run continue after a task was decided (or replays the run when the server restarted meanwhile). */
async function settleTask(taskId: string, runId: string, result: Settled, actor: string): Promise<void> {
  const waiter = taskWaiters.get(taskId);
  // the task id comes from the request: only a waiter this process registered is called
  if (typeof waiter === 'function') {
    taskWaiters.delete(taskId);
    waiter(result);
  } else {
    // Server was restarted while waiting: replay the run up to this task.
    await resumeRun(runId, actor).catch((e) => {
      logger.error({ err: e, runId }, 'resume after decision failed');
      if (isUnexpected(e)) reportError(e, { tags: { phase: 'resume', run_id: runId } });
    });
  }
}

/** Person A completes a manual step (permission checked by the caller). The run continues unless a second person must verify it. */
export async function completeManualTask(taskId: string, input: ManualCompletionInput, actor = currentActor()): Promise<{ verificationNeeded: boolean }> {
  const t = store.getTask(taskId);
  const settled = completeManual(t, input, actor);
  if (settled) await settleTask(taskId, t.runId, settled, actor);
  return { verificationNeeded: !settled };
}

/** Person B verifies or rejects a manual step (permission checked by the caller). */
export async function verifyManualTask(
  taskId: string,
  input: { approved: boolean; comment?: string },
  actor = currentActor(),
): Promise<{ outcome: 'verified' | 'returned' | 'failed' }> {
  const t = store.getTask(taskId);
  const settled = verifyManual(t, input, actor);
  if (settled) await settleTask(taskId, t.runId, settled, actor);
  return { outcome: input.approved ? 'verified' : settled ? 'failed' : 'returned' };
}

/**
 * On startup: resume waiting runs, mark in-flight ones as interrupted; queued runs keep their place and start when a
 * slot is free. Debug runs are cancelled instead (ADR 0010): a paused or half-done debug run belongs to a session of
 * its debugger that is gone.
 */
export async function recoverRuns(): Promise<void> {
  accepting = true;
  const rows = db().all<{ id: string; status: string; debug: string | null }>(
    "SELECT id, status, debug FROM runs WHERE status IN ('running', 'queued', 'waiting') ORDER BY started_at, id",
  );
  for (const r of rows) {
    if (active.has(r.id)) continue; // already re-attached (e.g. by a resumed parent run)
    if (r.debug) {
      try {
        await cancelRun(r.id, 'system', 'Steward restarted');
      } catch (e) {
        logger.warn({ err: e, runId: r.id }, 'could not cancel the debug run');
      }
      continue;
    }
    if (r.status === 'queued') {
      if (!runQueue.includes(r.id)) runQueue.push(r.id);
      continue;
    }
    if (r.status === 'waiting') {
      try {
        store.setRunStatus(r.id, 'interrupted');
        await resumeRun(r.id, 'system');
      } catch (e) {
        logger.error({ err: e, runId: r.id }, 'could not resume run');
        if (isUnexpected(e)) reportError(e, { tags: { phase: 'recover', run_id: r.id } });
      }
    } else {
      store.setRunStatus(r.id, 'interrupted');
      audit({
        actor: 'system',
        action: 'run.interrupted',
        entityType: 'run',
        entityId: r.id,
        runId: r.id,
        summary: 'Run was interrupted by an application restart. Review and resume or cancel it.',
      });
    }
  }
  pumpQueue();
}

/** The run's mode now (a debug run switches to test after a simulated decision). */
const ctxMode = (ctx: RunContext): RunMode => (ctx.recorded ? 'test' : ctx.dryRun ? 'dry' : 'live');

/** What the events of a debug run say about it (consumers skip debug runs). */
const debugEvent = (ctx: RunContext) => (ctx.debug ? { kind: ctx.debug.kind, ...(ctx.debug.nodeId ? { nodeId: ctx.debug.nodeId } : {}) } : null);

async function execute(ctx: RunContext): Promise<void> {
  let status: 'succeeded' | 'failed' | 'cancelled' = 'succeeded';
  let error: string | undefined;
  const run = store.runRow(ctx.runId);
  const log = logger.child({ runId: ctx.runId, processId: run.process_id, processVersion: run.process_version });
  const t0 = Date.now();
  log.info({ trigger: run.trigger, actor: ctx.actor, dryRun: ctx.dryRun, resumed: ctx.journal.size > 0, debug: ctx.debug?.kind }, 'run started');
  const evBase = { runId: ctx.runId, processId: run.process_id, processName: ctx.def.name, actor: ctx.actor, trigger: run.trigger, dryRun: ctx.dryRun };
  emit('run.started', { ...evBase, mode: ctxMode(ctx), debug: debugEvent(ctx) });
  try {
    await withSpan(
      `run ${ctx.def.name}`,
      {
        'sm.run.id': ctx.runId,
        'sm.process.id': run.process_id,
        'sm.process.version': run.process_version,
        'sm.run.trigger': run.trigger,
        'sm.run.dry_run': ctx.dryRun,
        'sm.run.resumed': ctx.journal.size > 0,
        ...(ctx.debug ? { 'sm.run.debug': ctx.debug.kind } : {}),
        // a pseudonym, not the user name (traces go to a collector outside the audit boundary)
        'enduser.pseudo.id': tracePseudonym(ctx.actor),
      },
      async () => {
        if (ctx.debug?.kind === 'node') return execDebugNode(ctx);
        const start = ctx.def.nodes.find((n) => n.type === 'start');
        if (!start) throw new Error('Process has no start node');
        await runNode(start, ctx, null);
      },
    );
    if (ctx.debug?.kind !== 'node') await evaluateOutputs(ctx);
  } catch (e) {
    if (e instanceof Cancelled || ctx.signal.aborted) {
      status = 'cancelled';
      error = 'Cancelled';
    } else {
      status = 'failed';
      error = ctx.redactor.apply((e as Error).message);
      // A failed run is a business outcome; only engine bugs (TypeError & co.) are reported.
      if (!(e instanceof StepFailure) && isInternalError(e)) reportError(e, { tags: { phase: 'run', run_id: ctx.runId }, secrets: ctx.redactor.list() });
    }
  } finally {
    if (ctx.browser) await ctx.browser.close().catch(() => undefined); // best effort at the end of the run: the browser process ends with it
  }
  store.saveStats(ctx.runId, ctx.stats);
  if (ctx.interrupted) {
    log.info({ status, durationMs: Date.now() - t0 }, 'run ended after it was marked interrupted at shutdown; its status stays interrupted');
    return;
  }
  store.setRunStatus(ctx.runId, status, { error: error ?? null, finished: true });
  log[status === 'failed' ? 'warn' : 'info']({ status, error, durationMs: Date.now() - t0, stats: ctx.stats }, 'run finished');
  emit('run.finished', {
    ...evBase,
    scheduleId: run.schedule_id ?? null,
    status,
    error,
    durationMs: Date.now() - t0,
    mode: ctxMode(ctx),
    debug: debugEvent(ctx),
  });
  if (error && status === 'failed') ctx.log('error', `Run failed: ${error}`);
  if (status === 'cancelled' && ctx.cancelReason) ctx.log('warn', `Cancelled: ${ctx.cancelReason}`);
  if (!ctx.audited) return;
  const reason = status === 'cancelled' ? (ctx.cancelReason ?? 'Cancelled') : undefined;
  audit({
    actor: ctx.actor,
    action: `run.${status}`,
    entityType: 'run',
    entityId: ctx.runId,
    runId: ctx.runId,
    // the entry's actor is the run's starter: who cancelled it is named in the summary, before the free-text reason
    summary: `Run of "${ctx.def.name}" ${status}${error && status === 'failed' ? `: ${error.slice(0, 200)}` : ''}${
      reason ? ` by ${ctx.cancelledBy ?? 'system'}${reasonTail(reason, ctx.cancelledBy ?? 'system')}` : ''
    }`,
    details: {
      stats: ctx.stats,
      protocolHash: store.protocolHash(ctx.runId),
      dryRun: ctx.dryRun,
      ...(reason ? { reason, cancelledBy: ctx.cancelledBy ?? null } : {}),
      ...(ctx.debug ? { debug: debugDetails(ctx.debug), ...(ctx.debug.recordedFrom ? { recordedFrom: ctx.debug.recordedFrom } : {}) } : {}),
    },
  });
}

/** Evaluate the definition's `outputs` (values returned to a parent process) and store them on the run. */
async function evaluateOutputs(ctx: RunContext): Promise<void> {
  const defs = Object.entries(ctx.def.outputs ?? {});
  if (!defs.length) return;
  const out: Record<string, unknown> = {};
  for (const [name, expr] of defs) {
    try {
      const v = await ctx.eval(expr);
      out[name] = v === undefined ? null : v;
    } catch (e) {
      throw new Error(`Output "${name}": ${(e as Error).message}`);
    }
  }
  store.saveOutputs(ctx.runId, ctx.redactor.apply(out));
}

/** Record the end of a step and publish a step.finished event (metrics). */
function finishStep(
  ctx: RunContext,
  key: string,
  nodeType: string,
  f: { status: StepStatus; output?: unknown; summary?: string; error?: string; startedMs: number },
): void {
  store.finishStep(ctx.runId, key, f);
  emit('step.finished', {
    runId: ctx.runId,
    processId: ctx.processId,
    nodeType,
    status: f.status,
    durationMs: Date.now() - f.startedMs,
    ...(ctx.debug ? { debug: true } : {}),
  });
}

const MAX_ACTIVATIONS = 200000;

/** Journal key of this activation: <loop scope>/<node id>[#n when reached again]. */
function activationKey(ctx: RunContext, scope: string | null, nodeId: string): string {
  const base = scope ? `${scope}/${nodeId}` : nodeId;
  const n = (ctx.activations.get(base) ?? 0) + 1;
  ctx.activations.set(base, n);
  if (++ctx.totalActivations > MAX_ACTIVATIONS) throw new Error(`More than ${MAX_ACTIVATIONS} node executions – stopping`);
  return n === 1 ? base : `${base}#${n}`;
}

/** Execute a node, then everything wired to the ports it fires (depth first, top-to-bottom). */
/** Last time a run handed the event loop back (shared: the event loop is shared too). */
let lastYield = performance.now();

async function runNode(node: FlowNode, ctx: RunContext, scope: string | null): Promise<void> {
  // A run of many cheap steps never waits for I/O; let other requests in regularly.
  if (performance.now() - lastYield > 20) {
    await yieldToEventLoop();
    lastYield = performance.now();
  }
  if (ctx.signal.aborted) throw new Cancelled();
  if (node.type === 'note') return;
  const key = activationKey(ctx, scope, node.id);
  // step through (ADR 0010): the pause gate, before a node that is not replayed; a decision pauses at itself
  if (ctx.gate && node.type !== 'start' && node.type !== 'userTask' && !ctx.journal.has(key)) {
    const reason = ctx.gate.reasonFor(node.id);
    if (reason) {
      const action = await debugPause(ctx, node, key, reason);
      if (action.type === 'stop') throw new Cancelled();
      if (action.type === 'skip') {
        for (const port of debugSkip(ctx, node, key, scope, action.by)) {
          for (const next of outgoing(ctx.nodes, ctx.def.wires, node.id, port)) await runNode(next, ctx, scope);
        }
        return;
      }
    }
  }
  const ports = await withSpan(
    `node ${node.type} ${node.id}`,
    { 'sm.node.id': node.id, 'sm.node.type': node.type, 'sm.step.key': key, 'sm.run.id': ctx.runId },
    async (span) => {
      const p = await execNode(node, ctx, scope, key);
      span.setAttribute('sm.node.ports', p.join(','));
      const row = ctx.journalStatus(key);
      if (row) span.setAttribute('sm.node.status', row);
      return p;
    },
  );
  for (const port of ports) {
    for (const next of outgoing(ctx.nodes, ctx.def.wires, node.id, port)) await runNode(next, ctx, scope);
  }
}

const TERMINAL: StepStatus[] = ['succeeded', 'skipped', 'dryrun', 'failed'];

function hasWires(ctx: RunContext, nodeId: string, port: string): boolean {
  return ctx.def.wires.some((w) => w.from === nodeId && w.port === port);
}

/** Port fired when a node is skipped ("Only run when" false): it passes through. */
function skipPorts(node: FlowNode): string[] {
  if (node.type === 'forEach') return ['done'];
  if (node.type === 'userTask' && node.mode === 'approve') return ['approved'];
  if (node.type === 'if') return ['false'];
  const first = nodePorts(node as never)[0];
  return first ? [first.id] : [];
}

function successPorts(node: FlowNode, output: unknown): string[] {
  if (node.type === 'userTask' && node.mode === 'approve') return (output as { approved?: boolean })?.approved ? ['approved'] : ['rejected'];
  const first = nodePorts(node as never)[0];
  return first ? [first.id] : [];
}

/** Ports for a step that failed but the flow may continue; null = the failure stops the run. */
function failurePorts(node: FlowNode, ctx: RunContext): string[] | null {
  if (node.type === 'check' && !node.failRun) return ['out'];
  if (hasWires(ctx, node.id, 'error')) return ['error'];
  if (node.onError === 'continue') return successPorts(node, undefined).filter((p) => p !== 'rejected');
  return null;
}

async function execNode(node: FlowNode, ctx: RunContext, scope: string | null, key: string): Promise<string[]> {
  const name = node.name || node.id;
  const journaled = ctx.journal.get(key);

  if (node.type === 'start') {
    if (!journaled) {
      store.upsertStep(ctx.runId, { key, parentKey: scope, stepId: node.id, type: 'start', name, status: 'running' });
      finishStep(ctx, key, 'start', { status: 'succeeded', summary: 'Run started', startedMs: Date.now() });
    }
    return ['out'];
  }

  // ----- replay: a finished step is not executed again -----
  const isControl = node.type === 'forEach' || node.type === 'if';
  // a read whose stored output was cut down (too large to keep in the run) is read again rather than replayed short
  const cutRead = !!journaled && node.type === 'http' && !isMutating(node) && store.isTruncatedOutput(journaled.output);
  if (journaled && TERMINAL.includes(journaled.status) && !isControl && !cutRead) {
    const output = parseJson<unknown>(journaled.output, undefined);
    if (journaled.status === 'skipped') return skipPorts(node);
    const ports = journaled.status === 'failed' ? failurePorts(node, ctx) : successPorts(node, output);
    if (ports) {
      applyOutput(node, ctx, output, journaled.status);
      return ports;
    }
  }
  if (journaled?.status === 'skipped') return skipPorts(node);

  // ----- condition -----
  if (node.when && !(await ctx.bool(node.when))) {
    store.upsertStep(ctx.runId, { key, parentKey: scope, stepId: node.id, type: node.type, name, status: 'skipped' });
    finishStep(ctx, key, node.type, { status: 'skipped', summary: 'Condition not met', startedMs: Date.now() });
    return skipPorts(node);
  }

  if (isControl) return execControl(node, ctx, scope, key, name, journaled);
  // debug runs: a decision or manual step is answered by the debugger, never by a real task (ADR 0010)
  if (ctx.debug && node.type === 'userTask') return execDebugUserTask(node, ctx, scope, key, name);

  const started = Date.now();
  store.upsertStep(ctx.runId, { key, parentKey: scope, stepId: node.id, type: node.type, name, status: 'running' });
  const attempts = node.retry?.attempts ?? 1;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await execLeaf(node, ctx, key, attempt);
      const status = res.status ?? 'succeeded';
      const output = ctx.redactor.apply(res.output);
      // one commit for step result + run stats
      db().tx(() => {
        finishStep(ctx, key, node.type, { status, output, summary: res.summary ? ctx.redactor.apply(res.summary) : undefined, startedMs: started });
        ctx.stats.steps++;
        if (status === 'failed') ctx.stats.failedSteps++;
        store.saveStats(ctx.runId, ctx.stats);
      });
      applyOutput(node, ctx, output, status);
      return status === 'failed' ? (failurePorts(node, ctx) ?? ['out']) : successPorts(node, output);
    } catch (e) {
      lastErr = e;
      if (e instanceof Cancelled || ctx.signal.aborted) {
        finishStep(ctx, key, node.type, { status: 'failed', error: 'Cancelled', startedMs: started });
        throw new Cancelled();
      }
      if (attempt < attempts) {
        ctx.log('warn', `Attempt ${attempt} failed: ${(e as Error).message}. Retrying…`, key);
        await sleep(node.retry?.delayMs ?? 2000, ctx.signal).catch(() => undefined); // cancelled while waiting: the loop checks the signal
      }
    }
  }
  const message = ctx.redactor.apply((lastErr as Error)?.message ?? String(lastErr));
  if (isInternalError(lastErr)) reportError(lastErr, { tags: { phase: 'step', node_type: node.type, run_id: ctx.runId }, secrets: ctx.redactor.list() });
  db().tx(() => {
    finishStep(ctx, key, node.type, { status: 'failed', error: message, output: { error: message }, startedMs: started });
    ctx.stats.steps++;
    ctx.stats.failedSteps++;
    store.saveStats(ctx.runId, ctx.stats);
  });
  const ports = failurePorts(node, ctx);
  if (ports) {
    ctx.log('warn', `"${name}" failed, continuing${ports.includes('error') ? ' on its error output' : ''}: ${message}`, key);
    if (node.saveAs) {
      ctx.vars[node.saveAs] = { error: message };
      ctx.taint(node.saveAs, outputSources(node, ctx));
    }
    return ports;
  }
  logger.warn({ runId: ctx.runId, stepKey: key, nodeType: node.type, error: message }, 'step failed');
  throw new StepFailure(`Step "${name}" failed: ${message}`, key);
}

function applyOutput(node: FlowNode, ctx: RunContext, output: unknown, status: StepStatus): void {
  // the step type's own part (an AI answer is remembered, a "set" step's values become variables), also on replay
  if (stepOf(node)?.applyOutput?.(node as NodeOf<StepType>, ctx, output)) return;
  if (node.saveAs) {
    ctx.vars[node.saveAs] = status === 'failed' && node.type !== 'check' ? { error: (output as { error?: string })?.error } : output;
    ctx.taint(node.saveAs, outputSources(node, ctx));
  }
}

/**
 * Where a step's result comes from (ai/provenance.ts), as its step type says (StepExecutor.sources): the platform of an
 * API call, a query or a browser step; for an AI step the gateway and everything its context may carry; ANY for every
 * other step – its result is computed from the run.
 */
function outputSources(node: FlowNode, ctx: RunContext): string[] {
  return stepOf(node)?.sources?.(node as NodeOf<StepType>, ctx) ?? [ANY];
}

function journalHasPrefix(ctx: RunContext, prefix: string): boolean {
  for (const k of ctx.journal.keys()) if (k.startsWith(prefix)) return true;
  return false;
}

async function execControl(
  node: NodeOf<'forEach'> | NodeOf<'if'>,
  ctx: RunContext,
  scope: string | null,
  key: string,
  name: string,
  journaled: store.StepRow | undefined,
): Promise<string[]> {
  const started = Date.now();
  const recorded = parseJson<{ decision?: unknown } | null>(journaled?.input ?? null, null);
  store.upsertStep(ctx.runId, { key, parentKey: scope, stepId: node.id, type: node.type, name, status: 'running' });
  try {
    if (node.type === 'if') {
      let cond: boolean;
      if (recorded && typeof recorded.decision === 'boolean') cond = recorded.decision;
      else {
        cond = await ctx.bool(node.condition);
        store.updateStepInput(ctx.runId, key, { decision: cond });
      }
      finishStep(ctx, key, node.type, { status: 'succeeded', summary: cond ? '→ true' : '→ false', startedMs: started, output: { result: cond } });
      return [cond ? 'true' : 'false'];
    }
    let items: unknown[];
    if (recorded && Array.isArray(recorded.decision)) items = recorded.decision;
    else {
      items = await ctx.list(node.items);
      if (node.maxItems && items.length > node.maxItems) throw new Error(`${items.length} items exceed the safety limit of ${node.maxItems}`);
      store.updateStepInput(ctx.runId, key, { decision: ctx.redactor.apply(items) });
    }
    if (ctx.debug?.kind === 'node') {
      // a single node: the item list is the result, the body does not run
      const output = { count: items.length, items: ctx.redactor.apply(items.slice(0, 50)) };
      finishStep(ctx, key, node.type, {
        status: 'succeeded',
        summary: `${items.length} item(s) – the body does not run in a single-node run`,
        startedMs: started,
        output,
      });
      if (node.saveAs) {
        ctx.vars[node.saveAs] = { count: items.length };
        ctx.taint(node.saveAs, [ANY]);
      }
      return ['done'];
    }
    const body = outgoing(ctx.nodes, ctx.def.wires, node.id, 'each');
    // stepping through, a parallel loop runs one item at a time (one pause at a time)
    const concurrency = ctx.gate ? 1 : Math.max(1, Math.min(node.concurrency ?? 1, 20));
    if (ctx.gate && (node.concurrency ?? 1) > 1) ctx.log('info', `Debug run: "${name}" runs its items one at a time`, key);
    let output: { count: number; results?: Record<string, unknown>[] };
    if (concurrency > 1) {
      const results = await runItemsInParallel(node, ctx, key, items, body, concurrency);
      output = { count: items.length, results: ctx.redactor.apply(results) };
    } else {
      for (let i = 0; i < items.length; i++) {
        if (ctx.signal.aborted) throw new Cancelled();
        ctx.vars[node.as] = items[i];
        ctx.vars[`${node.as}Index`] = i;
        ctx.taint(node.as, [ANY]);
        ctx.taint(`${node.as}Index`, [ANY]);
        for (const b of body) await runNode(b, ctx, `${key}[${i}]`);
        if (node.delayMs && i < items.length - 1 && !journalHasPrefix(ctx, `${key}[${i + 1}]/`)) await sleep(node.delayMs, ctx.signal);
      }
      output = { count: items.length };
    }
    finishStep(ctx, key, node.type, {
      status: 'succeeded',
      summary: `${items.length} item(s)${concurrency > 1 ? `, ${concurrency} in parallel` : ''}`,
      startedMs: started,
      output,
    });
    if (node.saveAs) {
      ctx.vars[node.saveAs] = output;
      ctx.taint(node.saveAs, [ANY]);
    }
    return ['done'];
  } catch (e) {
    const cancelled = e instanceof Cancelled || ctx.signal.aborted;
    const message = cancelled ? 'Cancelled' : ctx.redactor.apply((e as Error).message);
    finishStep(ctx, key, node.type, { status: 'failed', error: message, startedMs: started });
    if (cancelled) throw new Cancelled();
    if (node.onError === 'continue') {
      ctx.log('warn', `"${name}" failed, continuing: ${message}`, key);
      return node.type === 'forEach' ? ['done'] : [];
    }
    throw e instanceof StepFailure ? e : new StepFailure(`Step "${name}" failed: ${message}`, key);
  }
}

/**
 * Parallel for-each: up to `concurrency` items at a time, item starts spaced by
 * delayMs. Each item body works on its own copy of the variables (writes do
 * not leak to the outer scope); the variables an item set are returned in item
 * order (the loop's `results`). The first failure stops starting new items.
 */
async function runItemsInParallel(
  node: NodeOf<'forEach'>,
  ctx: RunContext,
  key: string,
  items: unknown[],
  body: FlowNode[],
  concurrency: number,
): Promise<Record<string, unknown>[]> {
  const outer = ctx.vars;
  const results: Record<string, unknown>[] = items.map(() => ({}));
  const local = new Set([node.as, `${node.as}Index`]);
  for (const v of local) ctx.taint(v, [ANY]);
  let next = 0;
  let failure: { error: unknown } | undefined;
  let gate: Promise<void> = Promise.resolve();
  let lastStart = 0;
  const stop = () => !!failure || ctx.signal.aborted;

  const startSlot = async (i: number): Promise<boolean> => {
    if (!node.delayMs || i === 0 || journalHasPrefix(ctx, `${key}[${i}]/`)) {
      lastStart = Date.now();
      return true;
    }
    const mine = gate.then(async () => {
      const wait = lastStart + node.delayMs! - Date.now();
      if (wait > 0 && !stop()) await sleep(wait, ctx.signal);
      lastStart = Date.now();
    });
    gate = mine.catch(() => undefined); // only the order matters here: the caller gets the failure
    try {
      await mine;
      return !stop();
    } catch {
      return false;
    }
  };

  const worker = async () => {
    for (;;) {
      if (stop()) return;
      const i = next++;
      if (i >= items.length) return;
      if (!(await startSlot(i))) return;
      const vars: Record<string, unknown> = { ...outer, [node.as]: items[i], [`${node.as}Index`]: i };
      try {
        await varScope.run({ ctx, vars }, async () => {
          for (const b of body) await runNode(b, ctx, `${key}[${i}]`);
        });
        for (const [k, v] of Object.entries(vars)) if (!local.has(k) && (!(k in outer) || outer[k] !== v)) results[i]![k] = v;
      } catch (e) {
        failure ??= { error: e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (ctx.signal.aborted) throw new Cancelled();
  if (failure) throw failure.error;
  return results;
}

// ---------------------------------------------------------------------------
// Sub-processes
// ---------------------------------------------------------------------------

const FINISHED_RUN = ['succeeded', 'failed', 'cancelled'];

/** Process permissions of a user by name (sub-processes run with the rights of the run's actor). */
function actorPermissions(actor: string, processId: string): string[] {
  const u = findUserByName(actor);
  if (!u || !u.active) return [];
  return runAs(toAuthUser(u), () => permissionsFor(processId));
}

/** Wait until a child run has finished (it may be running, waiting for a task, or interrupted by a restart). */
async function waitForChildRun(childId: string, ctx: RunContext, key: string): Promise<store.RunRow> {
  let waiting = false;
  let warned = false;
  let resumed = false;
  const aborted = new Promise<void>((resolve) => {
    if (ctx.signal.aborted) resolve();
    ctx.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  try {
    for (;;) {
      if (ctx.signal.aborted) throw new Cancelled();
      const row = store.runRow(childId);
      if (FINISHED_RUN.includes(row.status)) return row;
      if (!waiting) {
        waiting = true;
        store.setStepStatus(ctx.runId, key, 'waiting');
        ctx.beginWait();
      }
      const a = active.get(childId);
      if (a) {
        await Promise.race([a.done, aborted]);
        continue;
      }
      if (row.status === 'interrupted') {
        // a person resuming the parent also resumes the interrupted child; otherwise it needs review
        if (!resumed && ctx.resumedBy && ctx.resumedBy !== 'system') {
          resumed = true;
          await resumeRun(childId, ctx.resumedBy).catch((e) => ctx.log('warn', `Could not resume sub-process run ${childId}: ${(e as Error).message}`, key));
          continue;
        }
        if (!warned) {
          warned = true;
          ctx.log('warn', `Sub-process run ${childId} was interrupted – resume or cancel it to continue`, key);
        }
      }
      await sleep(500, ctx.signal).catch(() => undefined); // cancelled while waiting: the loop checks the signal
    }
  } finally {
    if (waiting) {
      ctx.endWait();
      if (!ctx.signal.aborted) store.setStepStatus(ctx.runId, key, 'running');
    }
  }
}

// ---------------------------------------------------------------------------
// Leaf steps: one module per step type behind the registry (steps/index.ts, steps/context.ts)
// ---------------------------------------------------------------------------

/** A step runs through its step type's module (steps/index.ts); the engine around it journals, retries and redacts. */
async function execLeaf(step: FlowNode, ctx: RunContext, key: string, attempt = 1): Promise<LeafResult> {
  const ex = stepOf(step);
  if (!ex) throw new Error(`Unsupported node type ${step.type}`);
  return ex.exec(step as NodeOf<StepType>, ctx, key, attempt);
}

// ---------------------------------------------------------------------------
// Debug runs (ADR 0010): one node, step through. The same step functions as every run; no second executor.
// ---------------------------------------------------------------------------

let pauseMsForTests: number | null = null;
/** For tests: how long a debug pause waits (null: the setting debugPauseMinutes). */
export function setDebugPauseMsForTests(ms: number | null): void {
  pauseMsForTests = ms;
}
const debugPauseMs = (): number => pauseMsForTests ?? Math.max(1, getSettings().debugPauseMinutes ?? 30) * 60_000;

/** The node's resolved inputs for a pause preview (redacted by the caller); a failing expression shows its error. */
async function previewInputs(node: FlowNode, ctx: RunContext): Promise<unknown> {
  try {
    const ex = stepOf(node);
    if (ex) return await ex.preview?.(node as NodeOf<StepType>, ctx);
    switch (node.type) {
      case 'if':
        return { condition: node.condition, result: await ctx.bool(node.condition) };
      case 'forEach': {
        const items = await ctx.list(node.items);
        return { items: items.length, first: items.slice(0, 5) };
      }
      default:
        return undefined;
    }
  } catch (e) {
    return { error: ctx.redactor.apply((e as Error).message) };
  }
}

/** Waits at the gate before a node (or for a simulated answer). The run counts as waiting: it holds no slot. */
async function debugPause(ctx: RunContext, node: FlowNode, key: string, reason: DebugPause['reason'], task?: DebugPause['task']): Promise<GateAction> {
  const gate = ctx.gate!;
  const now = Date.now();
  const ms = debugPauseMs();
  const pause: DebugPause = {
    reason,
    nodeId: node.id,
    nodeType: node.type,
    nodeName: node.name || node.id,
    stepKey: key,
    vars: ctx.redactor.apply(structuredClone(ctx.vars)),
    ...(reason !== 'decision' ? { preview: ctx.redactor.apply(await previewInputs(node, ctx)) } : {}),
    ...(task ? { task: ctx.redactor.apply(task) } : {}),
    since: new Date(now).toISOString(),
    expiresAt: new Date(now + ms).toISOString(),
  };
  ctx.log(
    'info',
    reason === 'decision' ? `Debug run: waiting for the simulated answer of "${pause.nodeName}"` : `Debug run: paused before "${pause.nodeName}"`,
    key,
  );
  ctx.beginWait();
  try {
    const action = await gate.wait(pause, {
      timeoutMs: ms,
      signal: ctx.signal,
      onTimeout: () =>
        void cancelRun(ctx.runId, 'system', 'debug pause timed out').catch((e) =>
          logger.warn({ err: e, runId: ctx.runId }, 'could not cancel the paused debug run'),
        ),
    });
    if (action.type === 'run') ctx.log('info', `Debug run: ${action.how === 'step' ? 'one step' : 'continued'} (${action.by})`, key);
    else if (action.type === 'skip') ctx.log('info', `Debug run: skipped by ${action.by}`, key);
    return action;
  } finally {
    ctx.endWait();
  }
}

/** "Skip this node": recorded as skipped, its pass-through ports fire (as for a false condition). */
function debugSkip(ctx: RunContext, node: FlowNode, key: string, scope: string | null, by: string): string[] {
  store.upsertStep(ctx.runId, { key, parentKey: scope, stepId: node.id, type: node.type, name: node.name || node.id, status: 'running' });
  finishStep(ctx, key, node.type, { status: 'skipped', summary: `Skipped while debugging by ${by}`, startedMs: Date.now() });
  if (node.type === 'userTask') recordedOnlyFrom(ctx, key, node.name || node.id);
  return skipPorts(node);
}

/** From the first simulated or skipped decision on, the run answers from recordings only (ADR 0010). */
function recordedOnlyFrom(ctx: RunContext, key: string, name: string): void {
  if (!ctx.debug || ctx.debug.recordedFrom) return;
  switchToRecorded(ctx, key, `"${name}" was answered while debugging, nobody really decided it`);
  // the whole run tree – the run that stepped through and every sub-process run of it – answers from recordings only
  // from now on (ADR 0010): a decision nobody really made never lets data leave Steward, wherever it was skipped
  const root = store.ancestorChain(ctx.runId).at(-1)?.id ?? ctx.runId;
  const from = ctx.runId === root ? key : `${ctx.runId}/${key}`;
  for (const a of active.values()) {
    if (a.ctx === ctx || !a.ctx.debug || a.ctx.debug.recordedFrom) continue;
    if ((store.ancestorChain(a.ctx.runId).at(-1)?.id ?? a.ctx.runId) !== root) continue;
    switchToRecorded(a.ctx, from, `a decision was answered while debugging in run ${ctx.runId}`);
  }
}

function switchToRecorded(ctx: RunContext, from: string, why: string): void {
  ctx.debug!.recordedFrom = from;
  ctx.recorded = true;
  ctx.dryRun = true;
  store.setRunDebug(ctx.runId, ctx.debug!);
  ctx.log('warn', `From here on the run answers from recordings only: ${why}`);
}

/** A decision, selection or manual step in a debug run: answered by the debugger (simulated), never a real task. */
async function execDebugUserTask(step: NodeOf<'userTask'>, ctx: RunContext, scope: string | null, key: string, name: string): Promise<string[]> {
  const started = Date.now();
  store.upsertStep(ctx.runId, { key, parentKey: scope, stepId: step.id, type: step.type, name, status: 'running' });
  let action: GateAction;
  const view = await taskView(step, ctx);
  if (ctx.debugNode) {
    action = { type: 'answer', by: ctx.actor, decision: ctx.debugNode.decision, manual: ctx.debugNode.manual };
  } else if (ctx.gate) {
    const spec = step.mode === 'manual' ? manualSpec(step) : undefined;
    store.setStepStatus(ctx.runId, key, 'waiting');
    action = await debugPause(ctx, step, key, 'decision', {
      mode: step.mode,
      title: view.title,
      ...(view.instructions ? { instructions: view.instructions } : {}),
      columns: view.columns.map((c) => ({ label: c.label })),
      items: view.items,
      ...(spec ? { checklist: spec.checklist, fields: spec.fields.map((f) => ({ id: f.id, label: f.label, type: f.type })) } : {}),
    });
    store.setStepStatus(ctx.runId, key, 'running');
  } else {
    // a sub-process run of a debug run has nobody to answer: it uses the recorded answers rule at once
    action = { type: 'skip', by: 'system' };
  }
  if (action.type === 'stop') {
    finishStep(ctx, key, step.type, { status: 'failed', error: 'Cancelled', startedMs: started });
    throw new Cancelled();
  }
  if (action.type === 'skip') return debugSkip(ctx, step, key, scope, action.by === 'system' ? ctx.actor : action.by);
  if (action.type !== 'answer') throw new Error('unexpected debug action');
  const by = action.by;
  const at = nowIso();
  let output: Record<string, unknown>;
  let summary: string;
  let ports: string[];
  if (step.mode === 'manual') {
    const spec = manualSpec(step);
    const m = action.manual ?? {};
    output = {
      completed: true,
      completedBy: by,
      completedAt: at,
      checklist: spec.checklist.map((item, i) => ({ item, checked: !!m.checked?.includes(i) })),
      fields: Object.fromEntries(
        Object.entries(m.fields ?? {})
          .filter(([k]) => spec.fields.some((f) => f.id === k))
          .map(([k, v]) => [k, String(v).slice(0, 4000)]),
      ),
      comment: (m.comment ?? '').slice(0, 4000),
      simulated: true,
    };
    summary = `Simulated: completed by ${by}`;
    ports = successPorts(step, output);
  } else {
    const d = action.decision;
    if (!d) throw new StepFailure(`Step "${name}" needs a simulated decision in a debug run`, key);
    if (step.mode === 'approve') {
      output = { approved: !!d.approved, comment: d.comment?.slice(0, 4000) ?? '', decidedBy: by, decidedAt: at, simulated: true };
      summary = `Simulated: ${d.approved ? 'approved' : 'rejected'} by ${by}`;
      if (!d.approved && !hasWires(ctx, step.id, 'rejected')) {
        finishStep(ctx, key, step.type, { status: 'failed', error: `Rejected by ${by} (simulated)`, output, startedMs: started });
        recordedOnlyFrom(ctx, key, name);
        throw new StepFailure(`Step "${name}" failed: Rejected by ${by} (simulated)`, key);
      }
    } else {
      const valid = new Set(view.items.map((i) => i.key));
      const sel = new Set((d.selectedKeys ?? []).filter((k) => valid.has(k)));
      output = {
        approved: true,
        selected: view.rawItems.filter((_, i) => sel.has(view.items[i]!.key)),
        unselected: view.rawItems.filter((_, i) => !sel.has(view.items[i]!.key)),
        selectedKeys: [...sel],
        comment: d.comment?.slice(0, 4000) ?? '',
        decidedBy: by,
        decidedAt: at,
        simulated: true,
      };
      summary = `Simulated: ${by} selected ${sel.size} of ${view.rawItems.length}`;
    }
    ports = successPorts(step, output);
  }
  const redacted = ctx.redactor.apply(output);
  db().tx(() => {
    finishStep(ctx, key, step.type, { status: 'succeeded', output: redacted, summary, startedMs: started });
    ctx.stats.steps++;
    store.saveStats(ctx.runId, ctx.stats);
  });
  applyOutput(step, ctx, redacted, 'succeeded');
  recordedOnlyFrom(ctx, key, name);
  return ports;
}

/** A single-node debug run: the node runs once with the given variables; wires are not followed. */
async function execDebugNode(ctx: RunContext): Promise<void> {
  const node = ctx.nodes.get(ctx.debug!.nodeId ?? '');
  if (!node) throw new Error(`Node ${ctx.debug!.nodeId} not found`);
  await execNode(node, ctx, null, activationKey(ctx, null, node.id));
}

/** The record first; only the queue position and a debug pause come from memory (ADR 0011). */
function queryRun(runId: string): RunState {
  const r = store.runRow(runId);
  const current = db()
    .all<{ key: string }>("SELECT key FROM run_steps WHERE run_id = ? AND status IN ('running', 'waiting') ORDER BY id", runId)
    .map((x) => x.key);
  const waitingTasks = store.listTasks({ runId, status: 'open' }).map((t) => ({
    taskId: t.id,
    stepKey: t.stepKey,
    mode: t.mode,
    ...(t.manual?.stage === 'work' || t.manual?.stage === 'verify' ? { stage: t.manual.stage } : {}),
  }));
  const a = active.get(runId);
  const q = runQueue.indexOf(runId);
  const mode = a ? ctxMode(a.ctx) : modeOfRow(r);
  return {
    runId,
    status: r.status,
    mode,
    current,
    waitingTasks,
    ...(q >= 0 ? { queuePosition: q + 1 } : {}),
    ...(a?.ctx.gate?.paused ? { paused: a.ctx.gate.paused } : {}),
  };
}

/** A debug signal from the run's starter (checked by the command layer before). */
async function debugSignal(runId: string, s: DebugSignal, actor: string): Promise<SignalResult> {
  const r = store.runRow(runId);
  if (!r.debug) throw new HttpError(409, 'Not a debug run', 'DEBUG_NOT_A_DEBUG_RUN');
  if (s.type === 'debug.stop') {
    await cancelRun(runId, actor, `Stopped while debugging by ${actor}`);
    return { ok: true, paused: null };
  }
  const a = active.get(runId);
  if (!a?.ctx.gate) throw new HttpError(409, `The debug run is ${r.status}`, 'DEBUG_NOT_PAUSED');
  a.ctx.gate.apply(s, actor);
  if (s.type === 'debug.breakpoints' && a.ctx.debug) {
    // what the run is (runs.debug) shows the breakpoints of now
    a.ctx.debug.breakpoints = s.breakpoints;
    store.setRunDebug(runId, a.ctx.debug);
    a.ctx.log('info', `Debug run: breakpoints set (${s.breakpoints.length})`);
  }
  // the run takes the next steps before the panel asks again
  await yieldToEventLoop();
  return { ok: true, paused: a.ctx.gate.paused };
}

/** One step-through run per person at a time: starting another one stops the first (also one still queued). */
async function stopOtherStepRuns(actor: string): Promise<void> {
  const ids = db()
    .all<{ id: string; debug: string }>(
      "SELECT id, debug FROM runs WHERE actor = ? AND debug IS NOT NULL AND parent_run_id IS NULL AND status IN ('queued', 'running', 'waiting')",
      actor,
    )
    .filter((r) => parseJson<DebugSpec | null>(r.debug, null)?.kind === 'step')
    .map((r) => r.id);
  for (const id of ids)
    await cancelRun(id, actor, 'Replaced by a new debug run').catch((e) => logger.warn({ err: e, runId: id }, 'could not stop the earlier debug run'));
}

/** The built-in engine (ADR 0011): today's runner behind the engine interface. */
export const builtinEngine: RunEngine = {
  id: 'builtin',
  async start(cmd: StartCommand) {
    if (cmd.debug?.kind === 'step' && !cmd.origin.parent) await stopOtherStepRuns(cmd.actor);
    const runId = await startRun(
      {
        processId: cmd.processId,
        version: cmd.version,
        inputs: cmd.inputs,
        bindings: cmd.bindings,
        dryRun: cmd.mode !== 'live',
        recorded: cmd.mode === 'test',
      },
      {
        trigger: cmd.origin.trigger,
        scheduleId: cmd.origin.scheduleId,
        webhook: cmd.origin.webhook,
        parent: cmd.origin.parent,
        actor: cmd.actor,
        ...(cmd.debug ? { debug: { spec: cmd.debug, seed: cmd.debugSeed } } : {}),
      },
    );
    return { runId, status: store.runRow(runId).status === 'queued' ? 'queued' : 'running' };
  },
  async signal(runId: string, s: RunSignal, actor: string): Promise<SignalResult> {
    switch (s.type) {
      case 'task.decide':
        await completeTask(s.taskId, s.decision, actor, s.audit ?? {});
        return { ok: true };
      case 'manual.complete':
        return { ok: true, ...(await completeManualTask(s.taskId, s.input, actor)) };
      case 'manual.verify':
        return { ok: true, ...(await verifyManualTask(s.taskId, s.input, actor)) };
      case 'resume':
        await resumeRun(runId, actor);
        return { ok: true };
      default:
        return debugSignal(runId, s, actor);
    }
  },
  cancel: (runId, reason, actor) => cancelRun(runId, actor, reason),
  query: queryRun,
  recover: recoverRuns,
  stopAccepting: stopAcceptingRuns,
  drain: (graceMs) => drainRuns(graceMs),
  interruptBusy: interruptBusyRuns,
  counts: () => ({ active: activeRunIds(), busy: busyRunIds(), queued: queuedRunIds() }),
};
