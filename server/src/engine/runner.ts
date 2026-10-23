import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  isMutating,
  nodePorts,
  outgoing,
  type FlowNode,
  type NodeOf,
  type InputDef,
  type Platform,
  type ProcessDefinition,
  type RunStats,
  type StartRunRequest,
  type StepStatus,
  type TaskDecision,
  type TaskItem,
} from '@sm/shared';
import { audit } from '../audit.js';
import { config } from '../config.js';
import { db } from '../db.js';
import { getSettings } from '../settings.js';
import { currentActor, runAs } from '../auth/context.js';
import { findUserByName, toAuthUser } from '../auth/users.js';
import { tracePseudonym } from '../auth/login-audit.js';
import { HttpError, newId, nowIso, parseJson, pathInside, sha256, sleep } from '../util.js';
import { getPlatform, getSecrets } from '../platforms/service.js';
import { openInputs, sealInputs, secretValuesOf } from './secret-inputs.js';
import { platformRequest, resolveBaseUrl, secretValues, buildUrl, credentialsAllowed, type HttpResult } from '../platforms/http.js';
import { outboundContext } from '../platforms/policyContext.js';
import {
  assertAddressSafe,
  assertNoSecretLeak,
  assertOutboundAllowed,
  egressSecretValues,
  secretEncodings,
  type OutboundContext,
  type SecretBinding,
} from '../platforms/outbound.js';
import { getProcess, permissionsFor } from '../processes/service.js';
import { evalBool, evalExpr, evalList, render, renderString, stringify, type Bindings, type EvalOptions } from './expr.js';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { openBrowser, type BrowserSession } from './browser.js';
import * as store from './store.js';
import { publishDataset, datasetOwner } from '../dashboards/datasets.js';
import { recordStepAccessChanges, type AccessChangeInput } from '../compliance/run-entries.js';
import { logger } from '../log.js';
import { withSpan } from '../telemetry.js';
import { normalizeStatus, type DatasetRow } from '@sm/shared';
import { emit } from '../events.js';
import { isInternalError, isUnexpected, reportError } from '../errorReporting.js';

// ---------------------------------------------------------------------------
// Run context
// ---------------------------------------------------------------------------

interface Binding {
  platform: Platform;
  secrets: Record<string, string>;
  baseUrl: string;
}

/** Where a run's evidence file (screenshot) is stored: data folder/artifacts/<run id>/<file>. */
const artifactFile = (runId: string, name: string): string => pathInside(path.join(config.dataDir, 'artifacts'), runId, name);

/** Keys whose values are never stored in the protocol (headers, credentials, OAuth token responses). */
const REDACT_KEY =
  /^(authorization|proxy-authorization|x-space-auth-key|x-api-key|api[-_]?key|cookie|set-cookie|password|passphrase|client_secret|access_token|refresh_token|id_token)$/i;

export class Redactor {
  private values = new Set<string>();
  /** Registers secret values – and the encoded forms they typically appear in (JSON, URL/form encoding, Base64). */
  add(...vals: string[]): void {
    for (const v of vals) {
      if (!v || v.length < 4) continue;
      // Mask the raw value and its simple encodings (base64, URL and form encoding in upper- and
      // lowercase hex, JSON escaping) so a secret cannot be smuggled into a log/protocol field in an
      // encoded form – or come back from a platform that echoes a query API key (Link headers, bodies).
      for (const enc of secretEncodings(v)) this.values.add(enc);
    }
  }
  /** The registered secret values (for scrubbing error reports). */
  list(): string[] {
    return [...this.values];
  }
  apply<T>(v: T): T {
    if (typeof v === 'string') {
      if (this.values.size === 0) return v;
      let s: string = v;
      // longest first, so a secret containing another one is replaced as a whole
      for (const secret of [...this.values].sort((a, b) => b.length - a.length)) if (s.includes(secret)) s = s.split(secret).join('***');
      // Basic credentials: user:password in Base64 – masked when they contain a registered secret
      s = s.replace(/\b(Basic)\s+([A-Za-z0-9+/]{6,}={0,2})/g, (m, scheme: string, b64: string) => {
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        return [...this.values].some((x) => decoded.includes(x)) ? `${scheme} ***` : m;
      });
      return s as T;
    }
    if (Array.isArray(v)) return v.map((x) => this.apply(x)) as T;
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        if (REDACT_KEY.test(k)) {
          // a token found in a response is a secret from now on (also where it shows up later, e.g. in a header)
          if (typeof val === 'string') this.add(val);
          out[k] = '***';
        } else out[k] = this.apply(val);
      }
      return out as T;
    }
    return v;
  }
}

/**
 * Per-item variable scope of parallel for-each loops: the body of each item sees
 * a copy of the outer vars, so its writes stay local to the item.
 */
const varScope = new AsyncLocalStorage<{ ctx: RunContext; vars: Record<string, unknown> }>();

class RunContext {
  /** Run-level variables (outside parallel loop bodies). */
  rootVars: Record<string, unknown> = {};
  journal: Map<string, store.StepRow>;
  processId: string;
  /** Who resumed the run (undefined for a fresh start). */
  resumedBy?: string;
  /** Open waits (user tasks, sub-process runs); the run shows "waiting" while > 0. */
  private waits = 0;
  redactor = new Redactor();
  abort = new AbortController();
  browser?: BrowserSession;
  stats: RunStats;
  nodes: Map<string, FlowNode>;
  activations = new Map<string, number>();
  totalActivations = 0;

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

  beginWait(): void {
    if (this.waits++ === 0) store.setRunStatus(this.runId, 'waiting');
  }
  endWait(): void {
    if (--this.waits <= 0) {
      this.waits = 0;
      if (!this.signal.aborted) store.setRunStatus(this.runId, 'running');
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
      ...extra,
    };
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
}

class StepFailure extends Error {
  constructor(
    message: string,
    public stepKey: string,
  ) {
    super(message);
  }
}

class Cancelled extends Error {
  constructor() {
    super('Run was cancelled');
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
const taskWaiters = new Map<string, (d: { decision: TaskDecision; by: string; at: string } | null) => void>();

export function isActive(runId: string): boolean {
  return active.has(runId);
}

export function activeRunIds(): string[] {
  return [...active.keys()];
}

function coerceInputs(defs: InputDef[], raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    let v = raw[d.name];
    if (v === undefined || v === '' || v === null) v = d.default;
    if (v === undefined || v === '' || v === null) {
      if (d.required) throw new HttpError(400, `Input "${d.label ?? d.name}" is required`);
      out[d.name] = d.type === 'list' || d.type === 'table' ? [] : d.type === 'boolean' ? false : null;
      continue;
    }
    switch (d.type) {
      case 'number': {
        const n = Number(v);
        if (Number.isNaN(n)) throw new HttpError(400, `Input "${d.name}" must be a number`);
        out[d.name] = n;
        break;
      }
      case 'boolean':
        out[d.name] = v === true || v === 'true' || v === '1' || v === 1 || v === 'yes';
        break;
      case 'select':
        if (d.options?.length && !d.options.includes(String(v))) throw new HttpError(400, `Input "${d.name}" must be one of ${d.options.join(', ')}`);
        out[d.name] = String(v);
        break;
      case 'list':
        out[d.name] = Array.isArray(v)
          ? v.map(String)
          : String(v)
              .split(/[\n,;]/)
              .map((s) => s.trim())
              .filter(Boolean);
        break;
      case 'table':
        out[d.name] = Array.isArray(v) ? v : parseCsv(String(v));
        break;
      case 'json':
        if (typeof v === 'string') {
          try {
            out[d.name] = JSON.parse(v);
          } catch {
            throw new HttpError(400, `Input "${d.name}" must be valid JSON`);
          }
        } else out[d.name] = v;
        break;
      default:
        out[d.name] = String(v);
    }
  }
  // keep undeclared inputs out of the run to keep it reproducible
  return out;
}

/** Small CSV parser (comma, semicolon or tab separated, quoted fields, header row). */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n?/g, '\n').trim();
  if (!lines) return [];
  const first = lines.split('\n')[0]!;
  const delim = [';', '\t', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0]!;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < lines.length; i++) {
    const c = lines[i]!;
    if (q) {
      if (c === '"' && lines[i + 1] === '"') ((field += '"'), i++);
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) (row.push(field), (field = ''));
    else if (c === '\n') (row.push(field), rows.push(row), (row = []), (field = ''));
    else field += c;
  }
  row.push(field);
  rows.push(row);
  const header = rows.shift()!.map((h) => h.trim());
  return rows.filter((r) => r.some((x) => x.trim() !== '')).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

async function resolveBindings(def: ProcessDefinition, requested: Record<string, string>): Promise<Record<string, Binding>> {
  const out: Record<string, Binding> = {};
  for (const slot of def.connections) {
    const pid = requested[slot.slot];
    if (!pid) throw new HttpError(400, `Select a platform for connection "${slot.slot}"`);
    const platform = getPlatform(pid);
    const secrets = getSecrets(pid);
    out[slot.slot] = { platform, secrets, baseUrl: await resolveBaseUrl(platform, secrets) };
  }
  return out;
}

export async function startRun(
  req: StartRunRequest,
  opts: {
    trigger?: 'manual' | 'schedule' | 'subprocess' | 'webhook' | 'monitor';
    scheduleId?: string;
    /** Webhook trigger (trigger 'webhook') or monitor (trigger 'monitor') that started the run */
    webhook?: { triggerId: string; triggerName: string; test?: boolean };
    actor?: string;
    /** Sub-process: the run and step (activation key) that started this run */
    parent?: { runId: string; stepKey: string };
  } = {},
): Promise<string> {
  const proc = getProcess(req.processId, req.version);
  const def = proc.definition;
  const inputs = coerceInputs(def.inputs ?? [], req.inputs ?? {});
  // inputs of type "secret": only stored encrypted, "***" in the protocol and the audit log
  const { visible: storedInputs, sealed } = sealInputs(def.inputs, inputs);
  const bindings = await resolveBindings(def, req.bindings ?? {});
  const runId = newId('run_');
  const actor = opts.actor ?? currentActor();
  const startedAt = nowIso();
  const bindingInfo = Object.fromEntries(
    Object.entries(bindings).map(([k, b]) => [k, { platformId: b.platform.id, platformName: b.platform.name, baseUrl: b.baseUrl }]),
  );
  db().tx(() => {
    db().run(
      `INSERT INTO runs (id, process_id, process_name, process_version, definition_hash, status, dry_run, trigger, schedule_id, actor, inputs, bindings, started_at, stats, parent_run_id, parent_step_key, trigger_id, trigger_name, sealed_inputs)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      runId,
      proc.id,
      proc.name,
      req.version ?? proc.currentVersion,
      proc.definitionHash,
      req.dryRun ? 1 : 0,
      opts.trigger ?? 'manual',
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
      sealed,
    );
    audit({
      actor,
      action: 'run.started',
      entityType: 'process',
      entityId: proc.id,
      runId,
      summary: `${req.dryRun ? 'Dry run' : 'Run'} of "${proc.name}" v${req.version ?? proc.currentVersion} started (${opts.trigger ?? 'manual'}${opts.parent ? ` by run ${opts.parent.runId}` : ''}${opts.webhook ? ` "${opts.webhook.triggerName}"${opts.webhook.test ? ', test' : ''}` : ''})`,
      details: {
        inputs: storedInputs,
        bindings: bindingInfo,
        definitionHash: proc.definitionHash,
        dryRun: !!req.dryRun,
        scheduleId: opts.scheduleId,
        ...(opts.webhook ? { triggerId: opts.webhook.triggerId, test: !!opts.webhook.test } : {}),
        ...(opts.parent ? { parentRunId: opts.parent.runId, parentStepKey: opts.parent.stepKey } : {}),
      },
    });
  });
  launch(runId, def, inputs, bindings, !!req.dryRun, actor, startedAt, store.emptyStats());
  return runId;
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
): void {
  const ctx = new RunContext(runId, def, inputs, bindings, dryRun, actor, startedAt, stats);
  ctx.redactor.add(...secretValuesOf(def.inputs, inputs));
  ctx.resumedBy = resumedBy;
  const done = execute(ctx).finally(() => active.delete(runId));
  active.set(runId, { ctx, done });
}

/** Resume a waiting/interrupted run by replaying its journal. */
export async function resumeRun(runId: string, actor = currentActor()): Promise<void> {
  if (active.has(runId)) return;
  const r = store.runRow(runId);
  if (!['waiting', 'interrupted'].includes(r.status)) throw new HttpError(409, `Run is ${r.status}`);
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
  );
}

export async function cancelRun(runId: string, actor = currentActor()): Promise<void> {
  const r = store.runRow(runId);
  if (['succeeded', 'failed', 'cancelled'].includes(r.status)) throw new HttpError(409, `Run already ${r.status}`);
  const a = active.get(runId);
  for (const t of store.listTasks({ runId, status: 'open' })) {
    store.decideTask(t.id, 'cancelled', null, actor);
    taskWaiters.get(t.id)?.(null);
    taskWaiters.delete(t.id);
  }
  if (a) a.ctx.abort.abort();
  // sub-process runs started by this run are cancelled with it
  for (const child of store.unfinishedChildRuns(runId)) {
    await cancelRun(child, actor).catch((e) => logger.warn({ err: e, runId: child }, 'could not cancel sub-process run'));
  }
  if (a) {
    await a.done.catch(() => undefined);
  } else {
    store.setRunStatus(runId, 'cancelled', { finished: true });
    audit({ actor, action: 'run.cancelled', entityType: 'run', entityId: runId, runId, summary: 'Run cancelled' });
  }
}

export async function completeTask(taskId: string, decision: TaskDecision, actor = currentActor()): Promise<void> {
  const t = store.getTask(taskId);
  if (t.status !== 'open') throw new HttpError(409, `Task is ${t.status}`);
  const validKeys = new Set(t.items.map((i) => i.key));
  const selectedKeys = (decision.selectedKeys ?? []).filter((k) => validKeys.has(k));
  const d: TaskDecision = { approved: !!decision.approved, selectedKeys, comment: decision.comment?.slice(0, 4000) };
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
          ? `"${t.title}" ${d.approved ? 'approved' : 'rejected'}`
          : `"${t.title}": ${selectedKeys.length} of ${t.items.length} items selected`,
      details: { decision: d, unselectedKeys: t.items.map((i) => i.key).filter((k) => !selectedKeys.includes(k)) },
    });
  });
  const waiter = taskWaiters.get(taskId);
  if (waiter) {
    taskWaiters.delete(taskId);
    waiter({ decision: d, by: actor, at });
  } else {
    // Server was restarted while waiting: replay the run up to this task.
    await resumeRun(t.runId, actor).catch((e) => {
      logger.error({ err: e, runId: t.runId }, 'resume after decision failed');
      if (isUnexpected(e)) reportError(e, { tags: { phase: 'resume', run_id: t.runId } });
    });
  }
}

/** On startup: resume waiting runs, mark in-flight ones as interrupted. */
export async function recoverRuns(): Promise<void> {
  const rows = db().all<{ id: string; status: string }>("SELECT id, status FROM runs WHERE status IN ('running', 'queued', 'waiting')");
  for (const r of rows) {
    if (active.has(r.id)) continue; // already re-attached (e.g. by a resumed parent run)
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
}

async function execute(ctx: RunContext): Promise<void> {
  let status: 'succeeded' | 'failed' | 'cancelled' = 'succeeded';
  let error: string | undefined;
  const run = store.runRow(ctx.runId);
  const log = logger.child({ runId: ctx.runId, processId: run.process_id, processVersion: run.process_version });
  const t0 = Date.now();
  log.info({ trigger: run.trigger, actor: ctx.actor, dryRun: ctx.dryRun, resumed: ctx.journal.size > 0 }, 'run started');
  const evBase = { runId: ctx.runId, processId: run.process_id, processName: ctx.def.name, actor: ctx.actor, trigger: run.trigger, dryRun: ctx.dryRun };
  emit('run.started', evBase);
  try {
    const start = ctx.def.nodes.find((n) => n.type === 'start');
    if (!start) throw new Error('Process has no start node');
    await withSpan(
      `run ${ctx.def.name}`,
      {
        'sm.run.id': ctx.runId,
        'sm.process.id': run.process_id,
        'sm.process.version': run.process_version,
        'sm.run.trigger': run.trigger,
        'sm.run.dry_run': ctx.dryRun,
        'sm.run.resumed': ctx.journal.size > 0,
        // a pseudonym, not the user name (traces go to a collector outside the audit boundary)
        'enduser.pseudo.id': tracePseudonym(ctx.actor),
      },
      () => runNode(start, ctx, null),
    );
    await evaluateOutputs(ctx);
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
    if (ctx.browser) await ctx.browser.close().catch(() => undefined);
  }
  store.saveStats(ctx.runId, ctx.stats);
  store.setRunStatus(ctx.runId, status, { error: error ?? null, finished: true });
  log[status === 'failed' ? 'warn' : 'info']({ status, error, durationMs: Date.now() - t0, stats: ctx.stats }, 'run finished');
  emit('run.finished', { ...evBase, scheduleId: run.schedule_id ?? null, status, error, durationMs: Date.now() - t0 });
  if (error && status === 'failed') ctx.log('error', `Run failed: ${error}`);
  audit({
    actor: ctx.actor,
    action: `run.${status}`,
    entityType: 'run',
    entityId: ctx.runId,
    runId: ctx.runId,
    summary: `Run of "${ctx.def.name}" ${status}${error && status === 'failed' ? `: ${error.slice(0, 200)}` : ''}`,
    details: { stats: ctx.stats, protocolHash: store.protocolHash(ctx.runId), dryRun: ctx.dryRun },
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
  emit('step.finished', { runId: ctx.runId, processId: ctx.processId, nodeType, status: f.status, durationMs: Date.now() - f.startedMs });
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

interface LeafResult {
  output?: unknown;
  status?: StepStatus;
  summary?: string;
}

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
  if (journaled && TERMINAL.includes(journaled.status) && !isControl) {
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
        await sleep(node.retry?.delayMs ?? 2000, ctx.signal).catch(() => undefined);
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
    if (node.saveAs) ctx.vars[node.saveAs] = { error: message };
    return ports;
  }
  logger.warn({ runId: ctx.runId, stepKey: key, nodeType: node.type, error: message }, 'step failed');
  throw new StepFailure(`Step "${name}" failed: ${message}`, key);
}

function applyOutput(node: FlowNode, ctx: RunContext, output: unknown, status: StepStatus): void {
  if (node.type === 'set' && output && typeof output === 'object') {
    Object.assign(ctx.vars, output as Record<string, unknown>);
    return;
  }
  if (node.saveAs) ctx.vars[node.saveAs] = status === 'failed' && node.type !== 'check' ? { error: (output as { error?: string })?.error } : output;
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
    const body = outgoing(ctx.nodes, ctx.def.wires, node.id, 'each');
    const concurrency = Math.max(1, Math.min(node.concurrency ?? 1, 20));
    let output: { count: number; results?: Record<string, unknown>[] };
    if (concurrency > 1) {
      const results = await runItemsInParallel(node, ctx, key, items, body, concurrency);
      output = { count: items.length, results: ctx.redactor.apply(results) };
    } else {
      for (let i = 0; i < items.length; i++) {
        if (ctx.signal.aborted) throw new Cancelled();
        ctx.vars[node.as] = items[i];
        ctx.vars[`${node.as}Index`] = i;
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
    if (node.saveAs) ctx.vars[node.saveAs] = output;
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
    gate = mine.catch(() => undefined);
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

/** Maximum nesting of sub-process runs below a top-level run. */
export const MAX_SUBPROCESS_DEPTH = 5;
const FINISHED_RUN = ['succeeded', 'failed', 'cancelled'];

/** Process permissions of a user by name (sub-processes run with the rights of the run's actor). */
function actorPermissions(actor: string, processId: string): string[] {
  const u = findUserByName(actor);
  if (!u || !u.active) return [];
  return runAs(toAuthUser(u), () => permissionsFor(processId));
}

async function execSubprocess(step: NodeOf<'subprocess'>, ctx: RunContext, key: string, attempt: number): Promise<LeafResult> {
  let child = store.latestChildRun(ctx.runId, key);
  // a retry attempt starts a fresh child run; a resumed run re-attaches to the existing one
  if (child && attempt > 1 && FINISHED_RUN.includes(child.status) && child.status !== 'succeeded') child = undefined;
  if (child) {
    ctx.log('info', `Re-attached to sub-process run ${child.id} (${child.status})`, key);
  } else {
    const chain = store.ancestorChain(ctx.runId);
    const loop = chain.find((a) => a.processId === step.process);
    if (loop) {
      throw new Error(
        `Recursion: process "${step.process}" is already running in this chain (${chain
          .map((a) => a.processId)
          .reverse()
          .join(' → ')})`,
      );
    }
    if (chain.length > MAX_SUBPROCESS_DEPTH) throw new Error(`Sub-processes are nested too deeply (limit ${MAX_SUBPROCESS_DEPTH})`);
    if (!actorPermissions(ctx.actor, step.process).includes('run')) {
      throw new Error(`${ctx.actor} may not run process "${step.process}" (needs the "run" right)`);
    }
    const proc = getProcess(step.process, step.version);
    const bindings: Record<string, string> = {};
    for (const slot of proc.definition.connections) {
      const parentSlot = step.connections?.[slot.slot] ?? slot.slot;
      const b = ctx.bindings[parentSlot];
      if (!b) throw new Error(`Sub-process connection "${slot.slot}" needs connection "${parentSlot}" of this process, which is not bound`);
      bindings[slot.slot] = b.platform.id;
    }
    const inputs = (await ctx.render(step.inputs ?? {})) as Record<string, unknown>;
    const request = { process: step.process, version: step.version ?? proc.currentVersion, inputs, bindings };
    store.updateStepInput(ctx.runId, key, ctx.redactor.apply(request));
    const id = await startRun(
      { processId: step.process, version: step.version, inputs, bindings, dryRun: ctx.dryRun },
      { trigger: 'subprocess', actor: ctx.actor, parent: { runId: ctx.runId, stepKey: key } },
    );
    store.updateStepInput(ctx.runId, key, ctx.redactor.apply({ ...request, childRunId: id }));
    ctx.log('info', `Started sub-process run ${id} of "${proc.name}"${ctx.dryRun ? ' (dry run)' : ''}`, key);
    child = { id, status: 'running' };
  }
  const row = await waitForChild(child.id, ctx, key);
  if (ctx.signal.aborted) throw new Cancelled();
  if (row.status !== 'succeeded') {
    throw new Error(`Sub-process run ${row.id} ("${row.process_name}") ${row.status}${row.error ? `: ${row.error}` : ''}`);
  }
  const outputs = parseJson<Record<string, unknown>>(row.outputs ?? null, {});
  return { output: outputs, summary: `"${row.process_name}" succeeded (run ${row.id})` };
}

/** Wait until a child run has finished (it may be running, waiting for a task, or interrupted by a restart). */
async function waitForChild(childId: string, ctx: RunContext, key: string): Promise<store.RunRow> {
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
      await sleep(500, ctx.signal).catch(() => undefined);
    }
  } finally {
    if (waiting) {
      ctx.endWait();
      if (!ctx.signal.aborted) store.setStepStatus(ctx.runId, key, 'running');
    }
  }
}

// ---------------------------------------------------------------------------
// Leaf steps
// ---------------------------------------------------------------------------

async function execLeaf(step: FlowNode, ctx: RunContext, key: string, attempt = 1): Promise<LeafResult> {
  switch (step.type) {
    case 'http':
      return execHttp(step, ctx, key);
    case 'set': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(step.values ?? {})) {
        const val = await ctx.render(v);
        out[k] = val === undefined ? null : val;
        ctx.vars[k] = out[k];
      }
      return {
        output: out,
        summary: Object.keys(out)
          .map((k) => `${k} = ${describe(out[k])}`)
          .join(', '),
      };
    }
    case 'log': {
      const message = await ctx.str(step.message);
      const data = step.data ? await ctx.eval(step.data) : undefined;
      ctx.log(step.level ?? 'info', message, key, data);
      return { output: { message, data }, summary: message.slice(0, 300) };
    }
    case 'check': {
      const passed = await ctx.bool(step.condition);
      const message = (await ctx.str(step.message)) || (passed ? 'Passed' : `Condition not met: ${step.condition}`);
      const severity = step.severity ?? 'error';
      if (passed) ctx.stats.checksPassed++;
      else {
        ctx.stats.checksFailed++;
        audit({
          actor: ctx.actor,
          action: 'check.failed',
          entityType: 'run',
          entityId: ctx.runId,
          runId: ctx.runId,
          summary: `Check "${step.name || step.id}" failed (${severity}): ${message.slice(0, 200)}`,
        });
        emit('check.failed', {
          runId: ctx.runId,
          processId: store.runRow(ctx.runId).process_id,
          processName: ctx.def.name,
          check: step.name || step.id,
          severity,
          message,
          dryRun: ctx.dryRun,
        });
      }
      if (!passed && step.failRun) throw new Error(message);
      return { status: passed ? 'succeeded' : 'failed', output: { passed, severity, message }, summary: `${passed ? '✔' : '✘'} ${message}` };
    }
    case 'report': {
      const title = await ctx.str(step.title);
      const text = step.text ? await ctx.str(step.text) : undefined;
      let columns: string[] | undefined;
      let rows: unknown[][] | undefined;
      if (step.rows) {
        const list = await ctx.list(step.rows);
        if (step.columns?.length) {
          columns = step.columns.map((c) => c.label);
          rows = [];
          for (const item of list) rows.push(await Promise.all(step.columns.map(async (c) => stringify(await ctx.item(c.value, item)))));
        } else {
          const keys = new Set<string>();
          for (const it of list.slice(0, 50)) if (it && typeof it === 'object') Object.keys(it).forEach((k) => keys.add(k));
          columns = keys.size ? [...keys] : ['value'];
          rows = list.map((it) => (keys.size ? columns!.map((k) => stringify((it as Record<string, unknown>)?.[k])) : [stringify(it)]));
        }
      }
      return { output: { title, text, columns, rows }, summary: rows ? `${title}: ${rows.length} row(s)` : title };
    }
    case 'wait':
      await sleep(step.seconds * 1000, ctx.signal).catch(() => {
        throw new Cancelled();
      });
      return { summary: `Waited ${step.seconds}s` };
    case 'fail':
      throw new Error(await ctx.str(step.message));
    case 'userTask':
      return execUserTask(step, ctx, key);
    case 'publish':
      return execPublish(step, ctx, key);
    case 'accessChange':
      return execAccessChange(step, ctx, key);
    case 'browser':
      return execBrowser(step, ctx, key);
    case 'subprocess':
      return execSubprocess(step, ctx, key, attempt);
    default:
      throw new Error(`Unsupported node type ${(step as FlowNode).type}`);
  }
}

function describe(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length} items]`;
  if (v && typeof v === 'object') return '{…}';
  const s = stringify(v);
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}

/** Outbound destination policy context for this server (all configured platforms). */
export function engineOutboundContext(): OutboundContext {
  return outboundContext();
}

/** Secrets of all platforms bound to this run, with their allowed-origin check (for egress scanning). */
function secretBindings(ctx: RunContext): SecretBinding[] {
  return Object.values(ctx.bindings).map((b) => ({
    platformName: b.platform.name,
    values: egressSecretValues(b.secrets),
    allowed: (url: string) => credentialsAllowed(b.platform, b.secrets, url),
  }));
}

/**
 * Gate a process-controlled outbound request: the destination must pass the
 * outbound policy (SSRF) and must not carry any bound platform's secret to an
 * origin that platform does not allow. Shared by the http and browser nodes.
 */
async function enforceOutbound(ctx: RunContext, url: string, headers: Record<string, string> = {}, body?: unknown): Promise<void> {
  await assertOutboundAllowed(url, engineOutboundContext());
  await assertNoSecretLeak(url, headers, body, secretBindings(ctx));
}

async function execHttp(step: NodeOf<'http'>, ctx: RunContext, key: string): Promise<LeafResult> {
  const b = ctx.bindings[step.connection];
  if (!b) throw new Error(`Connection "${step.connection}" is not bound`);
  const p = await ctx.str(step.path);
  // Semgrep's res-render-injection takes (step, ctx, key) for Express's (req, res, next): ctx.render() evaluates the
  // step's expressions in the run scope, it never loads a file or template by name (false positive).
  const query = (await ctx.render(step.query ?? {})) as Record<string, unknown>; // nosemgrep: javascript.express.security.audit.res-render-injection.res-render-injection
  const headers = Object.fromEntries(Object.entries((await ctx.render(step.headers ?? {})) as Record<string, unknown>).map(([k, v]) => [k, stringify(v)])); // nosemgrep: javascript.express.security.audit.res-render-injection.res-render-injection
  const body = step.body === undefined ? undefined : await ctx.render(step.body); // nosemgrep: javascript.express.security.audit.res-render-injection.res-render-injection
  const writes = isMutating(step);
  const requestInfo = { platform: b.platform.name, method: step.method, url: joinUrl(b.baseUrl, p), query, headers, body, write: writes };
  store.updateStepInput(ctx.runId, key, ctx.redactor.apply(requestInfo));

  if (writes && ctx.dryRun) {
    ctx.stats.skippedWrites++;
    ctx.log('info', `DRY RUN – would call ${step.method} ${requestInfo.url}`, key, body);
    audit({
      actor: ctx.actor,
      action: 'api.write_skipped',
      entityType: 'platform',
      entityId: b.platform.id,
      runId: ctx.runId,
      summary: `Dry run: ${step.method} ${p} on "${b.platform.name}" not executed`,
      details: ctx.redactor.apply({ stepKey: key, query, body }),
    });
    return { status: 'dryrun', output: { status: 0, ok: true, dryRun: true, body: null }, summary: `DRY RUN ${step.method} ${p}` };
  }

  ctx.redactor.add(...secretValues(b.secrets));
  const accept = (s: number) => (step.expectStatus?.length ? step.expectStatus.includes(s) : s >= 200 && s < 300);
  const doRequest = async (url: string, q: Record<string, unknown>) => {
    const target = await buildUrl(b.platform, b.secrets, url, q);
    await enforceOutbound(ctx, target, headers, body);
    const res = await platformRequest(b.platform, b.secrets, { method: step.method, url, query: q, headers, body, bodyType: step.bodyType }, ctx.signal);
    ctx.redactor.add(...secretValues(b.secrets));
    if (res.attempts && res.attempts > 1) ctx.log('warn', `${step.method} ${url} → HTTP ${res.status} after ${res.attempts} attempts`, key);
    if (!accept(res.status)) throw new Error(`HTTP ${res.status} from ${step.method} ${url}: ${snippet(res.body)}`);
    return res;
  };

  const pg = step.paginate;
  if (!pg || pg.mode === 'none') {
    const res = await doRequest(p, query);
    if (writes) auditWrite(ctx, b, step, p, res, key);
    return {
      output: {
        status: res.status,
        ok: res.ok,
        headers: res.headers,
        body: res.body,
        durationMs: res.durationMs,
        ...(res.attempts ? { attempts: res.attempts } : {}),
      },
      summary: `${step.method} ${p} → ${res.status} (${res.durationMs} ms${res.attempts ? `, ${res.attempts} attempts` : ''})`,
    };
  }

  // ----- pagination -----
  const items: unknown[] = [];
  const maxPages = pg.maxPages ?? 500;
  const size = pg.pageSize ?? 100;
  let pages = 0;
  let lastStatus = 0;
  let totalMs = 0;
  const extract = async (bodyVal: unknown): Promise<unknown[]> => {
    if (pg.itemsPath) {
      const v = await ctx.data(pg.itemsPath, bodyVal);
      return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
    }
    if (Array.isArray(bodyVal)) return bodyVal;
    const o = bodyVal as Record<string, unknown> | null;
    if (pg.mode === 'scim') return ((o?.resources ?? o?.Resources) as unknown[]) ?? [];
    const emb = o?._embedded as Record<string, unknown> | undefined;
    if (emb) {
      const first = Object.values(emb).find(Array.isArray);
      if (first) return first as unknown[];
    }
    const arr = o && Object.values(o).find(Array.isArray);
    return (arr as unknown[]) ?? [];
  };

  if (pg.mode === 'scim') {
    let start = 1;
    for (;;) {
      const res = await doRequest(p, { ...query, [pg.pageParam ?? 'startIndex']: start, [pg.sizeParam ?? 'count']: size });
      pages++;
      lastStatus = res.status;
      totalMs += res.durationMs;
      const page = await extract(res.body);
      items.push(...page);
      const total = Number((res.body as { totalResults?: number })?.totalResults ?? 0);
      start += page.length || size;
      if (page.length === 0 || start > total || pages >= maxPages) break;
    }
  } else if (pg.mode === 'page' || pg.mode === 'offset') {
    let pageNo = pg.mode === 'page' ? (pg.firstPage ?? 0) : 0;
    for (;;) {
      const q =
        pg.mode === 'page'
          ? { ...query, [pg.pageParam ?? 'page']: pageNo, [pg.sizeParam ?? 'size']: size }
          : { ...query, [pg.pageParam ?? 'offset']: pageNo, [pg.sizeParam ?? 'limit']: size };
      const res = await doRequest(p, q);
      pages++;
      lastStatus = res.status;
      totalMs += res.durationMs;
      const page = await extract(res.body);
      items.push(...page);
      if (page.length === 0 || pages >= maxPages) break;
      if (pg.mode === 'page') {
        const totalPages = Number(await ctx.data(pg.totalPagesPath ?? 'page.totalPages', res.body));
        pageNo++;
        if (Number.isFinite(totalPages) && totalPages > 0) {
          if (pageNo - (pg.firstPage ?? 0) >= totalPages) break;
        } else if (page.length < size) break;
      } else {
        pageNo += page.length;
        if (page.length < size) break;
      }
    }
  } else if (pg.mode === 'nextLink') {
    let url: string | undefined = p;
    let q: Record<string, unknown> = query;
    while (url) {
      const res = await doRequest(url, q);
      pages++;
      lastStatus = res.status;
      totalMs += res.durationMs;
      items.push(...(await extract(res.body)));
      const next = await ctx.data(pg.nextPath ?? '_links.next.href', res.body);
      url = typeof next === 'string' && next ? next : undefined;
      q = {};
      if (pages >= maxPages) break;
    }
  }
  if (pages >= maxPages) ctx.log('warn', `Stopped after ${maxPages} pages (maxPages)`, key);
  return {
    output: { status: lastStatus, ok: true, body: items, pages, durationMs: totalMs },
    summary: `${step.method} ${p} → ${items.length} item(s) in ${pages} page(s)`,
  };
}

function auditWrite(ctx: RunContext, b: Binding, step: NodeOf<'http'>, p: string, res: HttpResult, key: string) {
  ctx.stats.writes++;
  audit({
    actor: ctx.actor,
    action: 'api.write',
    entityType: 'platform',
    entityId: b.platform.id,
    runId: ctx.runId,
    summary: `${step.method} ${p} on "${b.platform.name}" → HTTP ${res.status}`,
    details: { stepKey: key, status: res.status, durationMs: res.durationMs },
  });
}

function originOfSafe(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function joinUrl(base: string, p: string): string {
  if (/^https?:\/\//i.test(p)) return p;
  return base + (p.startsWith('/') ? '' : '/') + p;
}

function snippet(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return (s ?? '').slice(0, 400);
}

/** Cell values are kept flat so snapshots stay small and render as text. */
function cell(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v.length > 1000 ? v.slice(0, 1000) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object')) return v.join(', ');
  return stringify(v).slice(0, 500);
}

async function execPublish(step: NodeOf<'publish'>, ctx: RunContext, key: string): Promise<LeafResult> {
  const list = step.rows ? await ctx.list(step.rows) : [];
  const max = step.maxRows ?? 5000;
  if (list.length > max) throw new Error(`${list.length} rows exceed the limit of ${max} (maxRows)`);
  let columns: string[];
  const rows: DatasetRow[] = [];
  if (step.columns?.length) {
    columns = step.columns.map((c) => c.label);
  } else {
    const keys = new Set<string>();
    for (const it of list.slice(0, 50)) if (it && typeof it === 'object' && !Array.isArray(it)) Object.keys(it).forEach((k) => keys.add(k));
    columns = keys.size ? [...keys] : ['value'];
  }
  for (const item of list) {
    const row: DatasetRow = {};
    if (step.columns?.length) {
      for (const c of step.columns) row[c.label] = cell(await ctx.item(c.value, item));
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const c of columns) row[c] = cell((item as Record<string, unknown>)[c]);
    } else row.value = cell(item);
    if (step.key) row._key = stringify(await ctx.item(step.key, item));
    if (step.status) row._status = normalizeStatus(await ctx.item(step.status, item));
    if (step.statusText) row._statusText = stringify(await ctx.item(step.statusText, item));
    rows.push(row);
  }
  const metrics: Record<string, number> = {};
  for (const [name, expr] of Object.entries(step.metrics ?? {})) {
    const v = Number(await ctx.eval(expr));
    if (Number.isFinite(v)) metrics[name] = v;
    else ctx.log('warn', `Metric "${name}" is not a number – skipped`, key);
  }
  const run = store.runRow(ctx.runId);
  // A dataset key is owned by the first process to publish it. A real run by another
  // process is rejected inside publishDataset (dashboard poisoning). A *dry run* by
  // another process must not fail or overwrite the owner's data – e.g. previewing a
  // second instance of a template that publishes the same key – so it returns a preview.
  const owner = datasetOwner(step.dataset);
  if (ctx.dryRun && owner && owner !== run.process_id) {
    const statusCounts: Record<string, number> = {};
    for (const r of rows) if (r._status) statusCounts[r._status] = (statusCounts[r._status] ?? 0) + 1;
    const counts = Object.entries(statusCounts)
      .map(([k, n]) => `${n} ${k}`)
      .join(', ');
    ctx.log('info', `DRY RUN – "${step.dataset}" is owned by another process; it was not written`, key);
    return {
      status: 'dryrun',
      output: { dataset: step.dataset, rows: rows.length, statusCounts, metrics, dryRun: true },
      summary: `DRY RUN – would publish ${step.dataset}: ${rows.length} row(s)${counts ? ` (${counts})` : ''}`,
    };
  }
  const meta = publishDataset({
    key: step.dataset,
    title: step.title || step.name || step.dataset,
    processId: run.process_id,
    processName: run.process_name,
    runId: ctx.runId,
    dryRun: ctx.dryRun,
    columns,
    rows: ctx.redactor.apply(rows),
    metrics,
    staleAfterMinutes: step.staleAfterMinutes,
  });
  const counts = Object.entries(meta.statusCounts)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
  return {
    output: { dataset: step.dataset, rows: rows.length, statusCounts: meta.statusCounts, metrics },
    summary: `${step.dataset}: ${rows.length} row(s)${counts ? ` (${counts})` : ''}${
      Object.keys(metrics).length
        ? ` · ${Object.entries(metrics)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}`
        : ''
    }`,
  };
}

/** Rights as a clean list: an array, or text with one right per line or comma-separated. */
function rightsList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : typeof v === 'string' ? v.split(/[\n,]/) : [v];
  return [...new Set(raw.map((x) => stringify(x).trim()).filter(Boolean))].slice(0, 500);
}

/** accessChange: collects the access changes of this run; the entries are created when the run ends (compliance/access-changes.ts). */
async function execAccessChange(step: NodeOf<'accessChange'>, ctx: RunContext, key: string): Promise<LeafResult> {
  const b = ctx.bindings[step.connection];
  if (!b) throw new Error(`Connection "${step.connection}" is not bound`);
  const items = step.items ? await ctx.list(step.items) : [undefined];
  if (items.length > 1000) throw new Error(`${items.length} subjects exceed the limit of 1000 per step`);
  const at = (expr: string | undefined, item: unknown) => (!expr ? Promise.resolve(undefined) : step.items ? ctx.item(expr, item) : ctx.eval(expr));
  const reason = ((await ctx.str(step.reason)) || '').slice(0, 2000);
  const requestRef = ((await ctx.str(step.requestRef)) || '').slice(0, 500);
  const approvedBy = ((await ctx.str(step.approvedBy)) || '').slice(0, 200);
  const entries: AccessChangeInput[] = [];
  for (const item of items) {
    const subjectId = stringify(await at(step.subjectId, item)).trim();
    if (!subjectId) {
      ctx.log('warn', 'An access change without subject id was skipped', key);
      continue;
    }
    const rights = rightsList(await at(step.rights, item));
    const before = step.rightsBefore ? rightsList(await at(step.rightsBefore, item)) : null;
    const after = step.rightsAfter ? rightsList(await at(step.rightsAfter, item)) : null;
    entries.push({
      platformId: b.platform.id,
      subjectId: subjectId.slice(0, 300),
      subjectName: stringify((await at(step.subjectName, item)) ?? '').slice(0, 300),
      kind: step.kind,
      rights,
      rightsBefore: before,
      rightsAfter: after,
      reason,
      requestRef,
      approvedBy,
      performedAt: new Date().toISOString(),
    });
  }
  const output = ctx.redactor.apply({ platform: b.platform.name, kind: step.kind, entries });
  if (ctx.dryRun) {
    return { status: 'dryrun', output: { ...output, dryRun: true }, summary: `DRY RUN – would document ${entries.length} access change(s) (${step.kind})` };
  }
  recordStepAccessChanges(ctx.runId, key, b.platform.id, output.entries);
  return { output, summary: `${entries.length} access change(s) (${step.kind}) on ${b.platform.name} – documented when the run ends` };
}

async function execUserTask(step: NodeOf<'userTask'>, ctx: RunContext, key: string): Promise<LeafResult> {
  const title = await ctx.str(step.title);
  const instructions = step.instructions ? await ctx.str(step.instructions) : undefined;
  let rawItems: unknown[] = [];
  const items: TaskItem[] = [];
  const columns = step.columns?.length ? step.columns : [{ label: 'Item', value: '$string($)' }];
  if (step.mode === 'select') {
    rawItems = await ctx.list(step.items ?? '[]');
    for (let i = 0; i < rawItems.length; i++) {
      const it = rawItems[i];
      const k = step.itemKey ? stringify(await ctx.item(step.itemKey, it)) : String(i);
      items.push({
        key: k || String(i),
        cells: await Promise.all(columns.map(async (c) => stringify(await ctx.item(c.value, it)))),
        preselected: step.preselect ? Boolean(await ctx.item(step.preselect, it)) : true,
      });
    }
  }
  let task = store.findTask(ctx.runId, key);
  if (!task) {
    const id = newId('task_');
    store.insertTask({
      id,
      runId: ctx.runId,
      stepKey: key,
      mode: step.mode,
      title,
      instructions,
      columns,
      items: ctx.redactor.apply(items),
      assignees: step.assignees ?? [],
      fourEyes: !!step.fourEyes,
    });
    emit('task.created', {
      taskId: id,
      runId: ctx.runId,
      processId: store.runRow(ctx.runId).process_id,
      processName: ctx.def.name,
      title,
      assignees: step.assignees ?? [],
      fourEyes: !!step.fourEyes,
      runActor: ctx.actor,
    });
    audit({
      actor: ctx.actor,
      action: 'task.created',
      entityType: 'task',
      entityId: id,
      runId: ctx.runId,
      summary: `Waiting for decision: "${title}"${step.mode === 'select' ? ` (${items.length} items)` : ''}`,
    });
    task = store.getTask(id);
  }
  let result: { decision: TaskDecision; by: string; at: string } | null;
  if (task.status === 'completed' && task.decision) {
    result = { decision: task.decision, by: task.decidedBy ?? '', at: task.decidedAt ?? '' };
  } else if (task.status === 'cancelled') {
    throw new Cancelled();
  } else {
    store.setStepStatus(ctx.runId, key, 'waiting');
    ctx.beginWait();
    ctx.log('info', `Waiting for user decision: ${title}`, key);
    const taskId = task.id;
    try {
      result = await new Promise((resolve) => {
        taskWaiters.set(taskId, resolve);
        ctx.signal.addEventListener('abort', () => resolve(null), { once: true });
      });
    } finally {
      taskWaiters.delete(taskId);
      ctx.endWait();
    }
    if (!result) throw new Cancelled();
    store.setStepStatus(ctx.runId, key, 'running');
  }
  const { decision, by, at } = result;
  if (step.mode === 'approve') {
    ctx.log('info', `${decision.approved ? 'Approved' : 'Rejected'} by ${by}${decision.comment ? `: ${decision.comment}` : ''}`, key);
    if (!decision.approved && !hasWires(ctx, step.id, 'rejected')) throw new Error(`Rejected by ${by}${decision.comment ? `: ${decision.comment}` : ''}`);
    return {
      output: { approved: decision.approved, comment: decision.comment ?? '', decidedBy: by, decidedAt: at },
      summary: `${decision.approved ? 'Approved' : 'Rejected'} by ${by}`,
    };
  }
  const sel = new Set(decision.selectedKeys);
  const selected = rawItems.filter((_, i) => sel.has(items[i]!.key));
  const unselected = rawItems.filter((_, i) => !sel.has(items[i]!.key));
  ctx.log('info', `${by} selected ${selected.length} of ${rawItems.length} item(s)`, key, { selectedKeys: decision.selectedKeys });
  return {
    output: {
      approved: true,
      selected,
      unselected,
      selectedKeys: decision.selectedKeys,
      comment: decision.comment ?? '',
      decidedBy: by,
      decidedAt: at,
    },
    summary: `${by} selected ${selected.length} of ${rawItems.length}`,
  };
}

async function execBrowser(step: NodeOf<'browser'>, ctx: RunContext, key: string): Promise<LeafResult> {
  const b = step.connection ? ctx.bindings[step.connection] : undefined;
  if (step.connection && !b) throw new Error(`Connection "${step.connection}" is not bound`);
  if (step.mutating && ctx.dryRun) {
    ctx.stats.skippedWrites++;
    ctx.log('info', 'DRY RUN – browser step changes data and was skipped', key);
    return { status: 'dryrun', output: { dryRun: true }, summary: 'DRY RUN – skipped' };
  }
  const settings = getSettings();
  if (!ctx.browser) {
    const outCtx = engineOutboundContext();
    ctx.browser = await openBrowser({
      headless: settings.browserHeadless,
      timeoutMs: settings.browserTimeoutMs,
      ignoreHttpsErrors: !!b?.platform.config.http?.insecureTls,
      // Navigation obeys the full outbound policy; sub-resources need only be address-safe
      // (metadata / link-local / own port), so portals that pull assets from CDNs still load.
      requestGuard: async (url, navigation) => {
        try {
          if (navigation) await assertOutboundAllowed(url, outCtx);
          else await assertAddressSafe(url);
          return true;
        } catch {
          return false;
        }
      },
    });
  }
  const page = ctx.browser.page;
  const portal = b ? (await ctx.str(b.platform.config.portalUrl || b.baseUrl, { vars: b.platform.config.variables })).replace(/\/+$/, '') : '';
  let portalOrigin = '';
  try {
    if (portal) portalOrigin = new URL(portal).origin;
  } catch {
    /* ignore */
  }
  // The bound platform's own portal is a legitimate destination for its secrets (e.g. a login form).
  const browserBindings = secretBindings(ctx).map((sb) =>
    b && sb.platformName === b.platform.name
      ? { ...sb, allowed: async (url: string) => (await sb.allowed(url)) || (!!portalOrigin && originOfSafe(url) === portalOrigin) }
      : sb,
  );
  const extracted: Record<string, unknown> = {};
  const shots: { id: string; name: string; sha256: string }[] = [];
  const done: string[] = [];
  const extraBindings: Bindings = { page: () => ({ url: page.url() }) };
  // Actions that change the page rather than just read it. In a dry run these still
  // run (so a non-"mutating" browser step can change data in the target portal);
  // dryRunReadOnly skips them, and we warn once when they run in a dry run otherwise.
  const INTERACTION = new Set(['click', 'fill', 'press', 'select', 'check', 'evaluate']);
  let warnedDryInteraction = false;
  for (const [i, a] of step.actions.entries()) {
    if (ctx.signal.aborted) throw new Cancelled();
    const sel = a.selector ? await ctx.str(a.selector) : '';
    const val = a.value !== undefined ? await ctx.str(a.value, { ...extraBindings, extracted }) : '';
    const opts = a.timeoutMs ? { timeout: a.timeoutMs } : undefined;
    const label = `${i + 1}. ${a.action}${sel ? ` ${sel}` : ''}`;
    if (ctx.dryRun && INTERACTION.has(a.action)) {
      if (step.dryRunReadOnly) {
        ctx.stats.skippedWrites++;
        done.push(`${label} (skipped – dry run, read-only)`);
        continue;
      }
      if (!warnedDryInteraction) {
        warnedDryInteraction = true;
        ctx.log(
          'warn',
          'DRY RUN – this browser step performs page interactions (click/fill/…) that may change data in the portal. Mark the step "changes data" or set dryRunReadOnly to skip them.',
          key,
        );
      }
    }
    // An action that puts a value into the page would send it to the page's current origin:
    // make sure it is not a platform secret bound for an origin the page is not.
    if (val && ['fill', 'press', 'select', 'evaluate'].includes(a.action)) {
      await assertNoSecretLeak(page.url() || portal || 'about:blank', {}, val, browserBindings);
    }
    try {
      switch (a.action) {
        case 'goto': {
          const url = /^https?:/i.test(val) ? val : portal + (val.startsWith('/') ? '' : '/') + val;
          await enforceOutbound(ctx, url);
          await page.goto(url, { waitUntil: 'domcontentloaded', ...(opts ?? {}) });
          done.push(`${label} ${url}`);
          break;
        }
        case 'click':
          await page.click(sel, opts);
          break;
        case 'fill':
          await page.fill(sel, val, opts);
          break;
        case 'press':
          await page.press(sel || 'body', val, opts);
          break;
        case 'select':
          await page.selectOption(sel, val, opts);
          break;
        case 'check':
          await page.check(sel, opts);
          break;
        case 'waitFor':
          await page.waitForSelector(sel, { state: a.state ?? 'visible', ...(opts ?? {}) });
          break;
        case 'expectText': {
          const text = (await page.textContent(sel || 'body', opts)) ?? '';
          if (!text.includes(val)) throw new Error(`Expected "${val}" in ${sel || 'page'}, found "${text.trim().slice(0, 200)}"`);
          break;
        }
        case 'extract': {
          let v: unknown;
          if (a.all) {
            v = await page.$$eval(sel, (els, attr) => els.map((e) => (attr ? e.getAttribute(attr as string) : (e.textContent ?? '').trim())), a.attribute);
          } else if (a.attribute) v = await page.getAttribute(sel, a.attribute, opts);
          else v = ((await page.textContent(sel, opts)) ?? '').trim();
          extracted[a.as ?? `value${i + 1}`] = v;
          break;
        }
        case 'screenshot': {
          const buf = await page.screenshot({ fullPage: !!a.fullPage, type: 'png' });
          const id = newId('art_');
          const file = artifactFile(ctx.runId, `${id}.png`);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, buf);
          const hash = sha256(buf);
          const name = a.name || `screenshot-${i + 1}`;
          store.addArtifact({ id, runId: ctx.runId, stepKey: key, kind: 'screenshot', name, mime: 'image/png', path: file, sha256: hash, size: buf.length });
          shots.push({ id, name, sha256: hash });
          break;
        }
        case 'wait':
          await page.waitForTimeout(Number(val) || 1000);
          break;
        case 'evaluate': {
          const v = await page.evaluate(val);
          if (a.as) extracted[a.as] = v;
          break;
        }
      }
      if (a.action !== 'goto') done.push(label);
    } catch (e) {
      // capture evidence of the failure
      try {
        const buf = await page.screenshot({ type: 'png' });
        const id = newId('art_');
        const file = artifactFile(ctx.runId, `${id}.png`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
        store.addArtifact({
          id,
          runId: ctx.runId,
          stepKey: key,
          kind: 'screenshot',
          name: `failure-${i + 1}`,
          mime: 'image/png',
          path: file,
          sha256: sha256(buf),
          size: buf.length,
        });
      } catch {
        /* ignore */
      }
      throw new Error(`Browser action ${label} failed: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  if (shots.length) {
    audit({
      actor: ctx.actor,
      action: 'browser.evidence',
      entityType: 'run',
      entityId: ctx.runId,
      runId: ctx.runId,
      summary: `${shots.length} screenshot(s) captured in "${step.name || step.id}"`,
      details: { stepKey: key, screenshots: shots },
    });
  }
  store.updateStepInput(ctx.runId, key, { actions: done });
  return {
    output: { ...extracted, url: page.url(), title: await page.title(), screenshots: shots },
    summary: `${step.actions.length} action(s)${shots.length ? `, ${shots.length} screenshot(s)` : ''}`,
  };
}
