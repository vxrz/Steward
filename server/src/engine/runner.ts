import fs from 'node:fs';
import path from 'node:path';
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
import { currentActor } from '../auth/context.js';
import { HttpError, newId, nowIso, parseJson, sha256, sleep } from '../util.js';
import { getPlatform, getSecrets } from '../platforms/service.js';
import { platformRequest, resolveBaseUrl, secretValues, type HttpResult } from '../platforms/http.js';
import { getProcess } from '../processes/service.js';
import { evalBool, evalExpr, evalList, render, renderString, stringify, type Bindings } from './expr.js';
import { openBrowser, type BrowserSession } from './browser.js';
import * as store from './store.js';

// ---------------------------------------------------------------------------
// Run context
// ---------------------------------------------------------------------------

interface Binding {
  platform: Platform;
  secrets: Record<string, string>;
  baseUrl: string;
}

class Redactor {
  private values = new Set<string>();
  add(...vals: string[]): void {
    for (const v of vals) if (v && v.length >= 4) this.values.add(v);
  }
  apply<T>(v: T): T {
    if (this.values.size === 0) return v;
    if (typeof v === 'string') {
      let s: string = v;
      for (const secret of this.values) if (s.includes(secret)) s = s.split(secret).join('***');
      return s as T;
    }
    if (Array.isArray(v)) return v.map((x) => this.apply(x)) as T;
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = /^(authorization|x-space-auth-key|cookie|set-cookie|password|client_secret)$/i.test(k) ? '***' : this.apply(val);
      }
      return out as T;
    }
    return v;
  }
}

class RunContext {
  vars: Record<string, unknown> = {};
  journal: Map<string, store.StepRow>;
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
    this.nodes = new Map(def.nodes.map((n) => [n.id, n]));
    this.stats = stats;
    for (const b of Object.values(bindings)) this.redactor.add(...Object.values(b.secrets));
  }

  get signal(): AbortSignal {
    return this.abort.signal;
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

  eval(expr: string, extra?: Bindings) {
    return evalExpr(expr, this.scope(), this.bindingsFn(extra));
  }
  bool(expr: string, extra?: Bindings) {
    return evalBool(expr, this.scope(), this.bindingsFn(extra));
  }
  list(expr: string, extra?: Bindings) {
    return evalList(expr, this.scope(), this.bindingsFn(extra));
  }
  render(v: unknown, extra?: Bindings) {
    return render(v, this.scope(), this.bindingsFn(extra));
  }
  str(v: string | undefined, extra?: Bindings) {
    return renderString(v, this.scope(), this.bindingsFn(extra));
  }
  /** Evaluate an expression against a single item ($item, and item fields at root). */
  item(expr: string, item: unknown) {
    return evalExpr(expr, item, this.bindingsFn({ item, vars: this.vars, inputs: this.inputs }));
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
      if (c === '"' && lines[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) row.push(field), (field = '');
    else if (c === '\n') row.push(field), rows.push(row), (row = []), (field = '');
    else field += c;
  }
  row.push(field);
  rows.push(row);
  const header = rows.shift()!.map((h) => h.trim());
  return rows
    .filter((r) => r.some((x) => x.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
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
  opts: { trigger?: 'manual' | 'schedule'; scheduleId?: string; actor?: string } = {},
): Promise<string> {
  const proc = getProcess(req.processId, req.version);
  const def = proc.definition;
  const inputs = coerceInputs(def.inputs ?? [], req.inputs ?? {});
  const bindings = await resolveBindings(def, req.bindings ?? {});
  const runId = newId('run_');
  const actor = opts.actor ?? currentActor();
  const startedAt = nowIso();
  const bindingInfo = Object.fromEntries(
    Object.entries(bindings).map(([k, b]) => [k, { platformId: b.platform.id, platformName: b.platform.name, baseUrl: b.baseUrl }]),
  );
  db().tx(() => {
    db().run(
      `INSERT INTO runs (id, process_id, process_name, process_version, definition_hash, status, dry_run, trigger, schedule_id, actor, inputs, bindings, started_at, stats)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)`,
      runId,
      proc.id,
      proc.name,
      req.version ?? proc.currentVersion,
      proc.definitionHash,
      req.dryRun ? 1 : 0,
      opts.trigger ?? 'manual',
      opts.scheduleId ?? null,
      actor,
      JSON.stringify(inputs),
      JSON.stringify(bindingInfo),
      startedAt,
      JSON.stringify(store.emptyStats()),
    );
    audit({
      actor,
      action: 'run.started',
      entityType: 'process',
      entityId: proc.id,
      runId,
      summary: `${req.dryRun ? 'Dry run' : 'Run'} of "${proc.name}" v${req.version ?? proc.currentVersion} started (${opts.trigger ?? 'manual'})`,
      details: { inputs, bindings: bindingInfo, definitionHash: proc.definitionHash, dryRun: !!req.dryRun, scheduleId: opts.scheduleId },
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
): void {
  const ctx = new RunContext(runId, def, inputs, bindings, dryRun, actor, startedAt, stats);
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
  const bindings = await resolveBindings(
    proc.definition,
    Object.fromEntries(Object.entries(bindingInfo).map(([k, v]) => [k, v.platformId])),
  );
  store.setRunStatus(runId, 'running');
  audit({ actor, action: 'run.resumed', entityType: 'run', entityId: runId, runId, summary: `Run resumed (was ${r.status})` });
  launch(
    runId,
    proc.definition,
    parseJson(r.inputs, {}),
    bindings,
    !!r.dry_run,
    r.actor,
    r.started_at,
    { ...store.emptyStats(), ...parseJson(r.stats, {}) },
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
  if (a) {
    a.ctx.abort.abort();
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
    await resumeRun(t.runId, actor).catch((e) => console.error('resume failed', e));
  }
}

/** On startup: resume waiting runs, mark in-flight ones as interrupted. */
export async function recoverRuns(): Promise<void> {
  const rows = db().all<{ id: string; status: string }>("SELECT id, status FROM runs WHERE status IN ('running', 'queued', 'waiting')");
  for (const r of rows) {
    if (r.status === 'waiting') {
      try {
        store.setRunStatus(r.id, 'interrupted');
        await resumeRun(r.id, 'system');
      } catch (e) {
        console.error(`Could not resume run ${r.id}:`, (e as Error).message);
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
  try {
    const start = ctx.def.nodes.find((n) => n.type === 'start');
    if (!start) throw new Error('Process has no start node');
    await runNode(start, ctx, null);
  } catch (e) {
    if (e instanceof Cancelled || ctx.signal.aborted) {
      status = 'cancelled';
      error = 'Cancelled';
    } else {
      status = 'failed';
      error = ctx.redactor.apply((e as Error).message);
    }
  } finally {
    if (ctx.browser) await ctx.browser.close().catch(() => undefined);
  }
  store.saveStats(ctx.runId, ctx.stats);
  store.setRunStatus(ctx.runId, status, { error: error ?? null, finished: true });
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
async function runNode(node: FlowNode, ctx: RunContext, scope: string | null): Promise<void> {
  if (ctx.signal.aborted) throw new Cancelled();
  if (node.type === 'note') return;
  const key = activationKey(ctx, scope, node.id);
  const ports = await execNode(node, ctx, scope, key);
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
      store.finishStep(ctx.runId, key, { status: 'succeeded', summary: 'Run started', startedMs: Date.now() });
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
    store.finishStep(ctx.runId, key, { status: 'skipped', summary: 'Condition not met', startedMs: Date.now() });
    return skipPorts(node);
  }

  if (isControl) return execControl(node, ctx, scope, key, name, journaled);

  const started = Date.now();
  store.upsertStep(ctx.runId, { key, parentKey: scope, stepId: node.id, type: node.type, name, status: 'running' });
  const attempts = node.retry?.attempts ?? 1;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await execLeaf(node, ctx, key);
      const status = res.status ?? 'succeeded';
      const output = ctx.redactor.apply(res.output);
      store.finishStep(ctx.runId, key, { status, output, summary: res.summary ? ctx.redactor.apply(res.summary) : undefined, startedMs: started });
      ctx.stats.steps++;
      if (status === 'failed') ctx.stats.failedSteps++;
      store.saveStats(ctx.runId, ctx.stats);
      applyOutput(node, ctx, output, status);
      return status === 'failed' ? (failurePorts(node, ctx) ?? ['out']) : successPorts(node, output);
    } catch (e) {
      lastErr = e;
      if (e instanceof Cancelled || ctx.signal.aborted) {
        store.finishStep(ctx.runId, key, { status: 'failed', error: 'Cancelled', startedMs: started });
        throw new Cancelled();
      }
      if (attempt < attempts) {
        ctx.log('warn', `Attempt ${attempt} failed: ${(e as Error).message}. Retrying…`, key);
        await sleep(node.retry?.delayMs ?? 2000, ctx.signal).catch(() => undefined);
      }
    }
  }
  const message = ctx.redactor.apply((lastErr as Error)?.message ?? String(lastErr));
  store.finishStep(ctx.runId, key, { status: 'failed', error: message, output: { error: message }, startedMs: started });
  ctx.stats.steps++;
  ctx.stats.failedSteps++;
  store.saveStats(ctx.runId, ctx.stats);
  const ports = failurePorts(node, ctx);
  if (ports) {
    ctx.log('warn', `"${name}" failed, continuing${ports.includes('error') ? ' on its error output' : ''}: ${message}`, key);
    if (node.saveAs) ctx.vars[node.saveAs] = { error: message };
    return ports;
  }
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
      store.finishStep(ctx.runId, key, { status: 'succeeded', summary: cond ? '→ true' : '→ false', startedMs: started, output: { result: cond } });
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
    for (let i = 0; i < items.length; i++) {
      if (ctx.signal.aborted) throw new Cancelled();
      ctx.vars[node.as] = items[i];
      ctx.vars[`${node.as}Index`] = i;
      for (const b of body) await runNode(b, ctx, `${key}[${i}]`);
      if (node.delayMs && i < items.length - 1 && !journalHasPrefix(ctx, `${key}[${i + 1}]/`)) await sleep(node.delayMs, ctx.signal);
    }
    store.finishStep(ctx.runId, key, { status: 'succeeded', summary: `${items.length} item(s)`, startedMs: started, output: { count: items.length } });
    return ['done'];
  } catch (e) {
    const cancelled = e instanceof Cancelled || ctx.signal.aborted;
    const message = cancelled ? 'Cancelled' : ctx.redactor.apply((e as Error).message);
    store.finishStep(ctx.runId, key, { status: 'failed', error: message, startedMs: started });
    if (cancelled) throw new Cancelled();
    if (node.onError === 'continue') {
      ctx.log('warn', `"${name}" failed, continuing: ${message}`, key);
      return node.type === 'forEach' ? ['done'] : [];
    }
    throw e instanceof StepFailure ? e : new StepFailure(`Step "${name}" failed: ${message}`, key);
  }
}


// ---------------------------------------------------------------------------
// Leaf steps
// ---------------------------------------------------------------------------

async function execLeaf(step: FlowNode, ctx: RunContext, key: string): Promise<LeafResult> {
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
      return { output: out, summary: Object.keys(out).map((k) => `${k} = ${describe(out[k])}`).join(', ') };
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
    case 'browser':
      return execBrowser(step, ctx, key);
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

async function execHttp(step: NodeOf<'http'>, ctx: RunContext, key: string): Promise<LeafResult> {
  const b = ctx.bindings[step.connection];
  if (!b) throw new Error(`Connection "${step.connection}" is not bound`);
  const p = await ctx.str(step.path);
  const query = (await ctx.render(step.query ?? {})) as Record<string, unknown>;
  const headers = Object.fromEntries(
    Object.entries((await ctx.render(step.headers ?? {})) as Record<string, unknown>).map(([k, v]) => [k, stringify(v)]),
  );
  const body = step.body === undefined ? undefined : await ctx.render(step.body);
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
    const res = await platformRequest(b.platform, b.secrets, { method: step.method, url, query: q, headers, body, bodyType: step.bodyType }, ctx.signal);
    ctx.redactor.add(...secretValues(b.secrets));
    if (!accept(res.status)) throw new Error(`HTTP ${res.status} from ${step.method} ${url}: ${snippet(res.body)}`);
    return res;
  };

  const pg = step.paginate;
  if (!pg || pg.mode === 'none') {
    const res = await doRequest(p, query);
    if (writes) auditWrite(ctx, b, step, p, res, key);
    return {
      output: { status: res.status, ok: res.ok, headers: res.headers, body: res.body, durationMs: res.durationMs },
      summary: `${step.method} ${p} → ${res.status} (${res.durationMs} ms)`,
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
      const v = await evalExpr(pg.itemsPath, bodyVal);
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
        const totalPages = Number(await evalExpr(pg.totalPagesPath ?? 'page.totalPages', res.body));
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
      const next = await evalExpr(pg.nextPath ?? '_links.next.href', res.body);
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

function joinUrl(base: string, p: string): string {
  if (/^https?:\/\//i.test(p)) return p;
  return base + (p.startsWith('/') ? '' : '/') + p;
}

function snippet(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return (s ?? '').slice(0, 400);
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
    store.insertTask({ id, runId: ctx.runId, stepKey: key, mode: step.mode, title, instructions, columns, items: ctx.redactor.apply(items), assignees: step.assignees ?? [], fourEyes: !!step.fourEyes });
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
    store.setRunStatus(ctx.runId, 'waiting');
    ctx.log('info', `Waiting for user decision: ${title}`, key);
    const taskId = task.id;
    result = await new Promise((resolve) => {
      taskWaiters.set(taskId, resolve);
      ctx.signal.addEventListener('abort', () => resolve(null), { once: true });
    });
    taskWaiters.delete(taskId);
    if (!result) throw new Cancelled();
    store.setRunStatus(ctx.runId, 'running');
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
    ctx.browser = await openBrowser({
      headless: settings.browserHeadless,
      timeoutMs: settings.browserTimeoutMs,
      ignoreHttpsErrors: !!b?.platform.config.http?.insecureTls,
    });
  }
  const page = ctx.browser.page;
  const portal = b ? (await ctx.str(b.platform.config.portalUrl || b.baseUrl, { vars: b.platform.config.variables })).replace(/\/+$/, '') : '';
  const extracted: Record<string, unknown> = {};
  const shots: { id: string; name: string; sha256: string }[] = [];
  const done: string[] = [];
  const extraBindings: Bindings = { page: () => ({ url: page.url() }) };
  for (const [i, a] of step.actions.entries()) {
    if (ctx.signal.aborted) throw new Cancelled();
    const sel = a.selector ? await ctx.str(a.selector) : '';
    const val = a.value !== undefined ? await ctx.str(a.value, { ...extraBindings, extracted }) : '';
    const opts = a.timeoutMs ? { timeout: a.timeoutMs } : undefined;
    const label = `${i + 1}. ${a.action}${sel ? ` ${sel}` : ''}`;
    try {
      switch (a.action) {
        case 'goto': {
          const url = /^https?:/i.test(val) ? val : portal + (val.startsWith('/') ? '' : '/') + val;
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
            v = await page.$$eval(
              sel,
              (els, attr) => els.map((e) => (attr ? e.getAttribute(attr as string) : (e.textContent ?? '').trim())),
              a.attribute,
            );
          } else if (a.attribute) v = await page.getAttribute(sel, a.attribute, opts);
          else v = ((await page.textContent(sel, opts)) ?? '').trim();
          extracted[a.as ?? `value${i + 1}`] = v;
          break;
        }
        case 'screenshot': {
          const buf = await page.screenshot({ fullPage: !!a.fullPage, type: 'png' });
          const id = newId('art_');
          const dir = path.join(config.dataDir, 'artifacts', ctx.runId);
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `${id}.png`);
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
        const dir = path.join(config.dataDir, 'artifacts', ctx.runId);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${id}.png`);
        fs.writeFileSync(file, buf);
        store.addArtifact({ id, runId: ctx.runId, stepKey: key, kind: 'screenshot', name: `failure-${i + 1}`, mime: 'image/png', path: file, sha256: sha256(buf), size: buf.length });
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
