import jsonata from 'jsonata';
import crypto from 'node:crypto';
import v8 from 'node:v8';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';

/**
 * Expressions are JSONata (https://jsonata.org). Templates are strings with
 * {{ expression }} placeholders; a string that is exactly one placeholder
 * returns the raw value (array, object, number ...).
 *
 * Every evaluation is guarded (see EvalOptions / expressionLimits): a time
 * limit, a stack depth limit, a sequence size limit, a heap watchdog and
 * regular expressions that cannot block the server. Long evaluations yield to
 * the event loop regularly, so one expensive expression never freezes the
 * whole server. Callers only pass options to tighten (or explicitly raise)
 * the limits.
 */

export type Bindings = Record<string, unknown>;

const cache = new Map<string, jsonata.Expression>();

/** Guard rails of an evaluation. Missing fields use expressionLimits(). */
export interface EvalOptions {
  /** Abort evaluation after this many milliseconds (JSONata guard rail + wall clock). Infinity = no limit (explicit opt-in). */
  timeoutMs?: number;
  /** Maximum JSONata stack depth */
  maxDepth?: number;
  /** Maximum length of a sequence (array) created during evaluation, including ranges [a..b] */
  maxSequence?: number;
  /** Abort the evaluation when this signal fires (e.g. the run was cancelled) */
  signal?: AbortSignal;
}

export interface ExpressionLimits {
  timeoutMs: number;
  maxDepth: number;
  maxSequence: number;
}

function envNumber(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Defaults for every evaluation; SM_EXPR_TIMEOUT_MS, SM_EXPR_MAX_DEPTH and SM_EXPR_MAX_SEQUENCE override them. */
const limits: ExpressionLimits = {
  timeoutMs: envNumber('SM_EXPR_TIMEOUT_MS', 5000),
  maxDepth: envNumber('SM_EXPR_MAX_DEPTH', 1000),
  maxSequence: envNumber('SM_EXPR_MAX_SEQUENCE', 1_000_000),
};

export function expressionLimits(): ExpressionLimits {
  return { ...limits };
}

/** Change the default limits (tests, embedding). */
export function setExpressionLimits(patch: Partial<ExpressionLimits>): void {
  for (const [k, v] of Object.entries(patch)) if (typeof v === 'number' && v > 0) limits[k as keyof ExpressionLimits] = v;
  cache.clear();
}

function effective(opts?: EvalOptions): ExpressionLimits {
  return {
    timeoutMs: opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : limits.timeoutMs,
    maxDepth: opts?.maxDepth && opts.maxDepth > 0 ? opts.maxDepth : limits.maxDepth,
    maxSequence: opts?.maxSequence && opts.maxSequence > 0 ? opts.maxSequence : limits.maxSequence,
  };
}

export class ExpressionError extends Error {
  constructor(
    public expression: string,
    message: string,
  ) {
    super(`Expression \`${truncate(expression, 120)}\`: ${message}`);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ---------------------------------------------------------------------------
// Cooperative guard: yield to the event loop, honour cancellation, watch the heap
// ---------------------------------------------------------------------------

interface GuardState {
  steps: number;
  lastYield: number;
  deadline: number;
  signal?: AbortSignal;
}
const guardStore = new AsyncLocalStorage<GuardState>();
/** Long evaluations hand the event loop back this often (ms). */
const YIELD_EVERY_MS = 10;
/** Evaluations stop when the V8 heap is fuller than this share of its limit. */
const HEAP_STOP_RATIO = 0.85;

/** Called by JSONata before every evaluation step (Symbol.for('jsonata.__evaluate_entry')). */
function onEvaluateEntry(): Promise<void> | undefined {
  const g = guardStore.getStore();
  // Check cheaply every few steps: the heap watchdog catches memory growth and
  // cancellation early, before the (coarser) time-based yield below.
  if (!g || (++g.steps & 7) !== 0) return undefined;
  if (g.signal?.aborted) throw new Error('Evaluation cancelled');
  const heap = v8.getHeapStatistics();
  if (heap.used_heap_size > heap.heap_size_limit * HEAP_STOP_RATIO) {
    throw new Error('Evaluation stopped: the server is running out of memory (the expression builds too much data)');
  }
  const now = performance.now();
  if (now - g.lastYield < YIELD_EVERY_MS) return undefined;
  return yieldToEventLoop().then(() => {
    g.lastYield = performance.now();
    if (g.signal?.aborted) throw new Error('Evaluation cancelled');
  });
}

/**
 * Maximum width of $pad – a single builtin call can otherwise allocate a
 * multi-GB string in one step, which the between-steps watchdog cannot catch.
 */
const MAX_PAD_WIDTH = 1_000_000;

/** Safe override of $pad that refuses to build an enormous string. */
function safePad(str: unknown, width: unknown, char?: unknown): unknown {
  if (str === undefined) return undefined;
  const s = typeof str === 'string' ? str : String(str);
  const w = Number(width);
  if (!Number.isFinite(w)) return s;
  if (Math.abs(w) > MAX_PAD_WIDTH) throw new Error(`$pad width ${Math.abs(w)} exceeds the limit of ${MAX_PAD_WIDTH}`);
  const target = Math.trunc(Math.abs(w));
  if (target <= s.length) return s;
  const padChar = char === undefined || char === '' ? ' ' : String(char);
  if (!padChar) return s;
  let fill = '';
  while (fill.length < target - s.length) fill += padChar;
  fill = fill.slice(0, target - s.length);
  return w < 0 ? fill + s : s + fill;
}

// ---------------------------------------------------------------------------
// Regular expressions that cannot block the server
// ---------------------------------------------------------------------------

// Patterns the linear-time engine can run switch to it after excessive backtracking
// (catastrophic backtracking such as /(a+)+$/ becomes linear). The second flag only
// enables the "l" flag, used below to find out whether a pattern is linear-capable.
v8.setFlagsFromString('--enable-experimental-regexp-engine-on-excessive-backtracks');
v8.setFlagsFromString('--enable-experimental-regexp-engine');

const linearCapable = new Map<string, boolean>();
function isLinearCapable(re: RegExp): boolean {
  const k = `${re.flags}/${re.source}`;
  let v = linearCapable.get(k);
  if (v === undefined) {
    try {
      new RegExp(re.source, re.flags + 'l');
      v = true;
    } catch {
      v = false;
    }
    if (linearCapable.size > 5000) linearCapable.clear();
    linearCapable.set(k, v);
  }
  return v;
}

const REGEX_WORKER_SRC = `
const { workerData } = require('node:worker_threads');
const flag = new Int32Array(workerData.sab);
Atomics.store(flag, 1, 1);
Atomics.notify(flag, 1);
workerData.port.on('message', ({ source, flags, str, lastIndex }) => {
  let out;
  try {
    const re = new RegExp(source, flags);
    re.lastIndex = lastIndex;
    const m = re.exec(str);
    out = { match: m ? { values: Array.from(m), index: m.index } : null, lastIndex: re.lastIndex };
  } catch (e) {
    out = { error: String((e && e.message) || e) };
  }
  workerData.port.postMessage(out);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
});`;

interface RegexWorker {
  worker: Worker;
  port: MessagePort;
  flag: Int32Array;
}
let regexWorker: RegexWorker | undefined;

function startRegexWorker(): RegexWorker {
  // [0] result ready, [1] worker booted
  const sab = new SharedArrayBuffer(8);
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(REGEX_WORKER_SRC, { eval: true, workerData: { sab, port: port2 }, transferList: [port2] });
  worker.unref();
  port1.unref();
  worker.on('error', () => {
    if (regexWorker?.worker === worker) regexWorker = undefined;
  });
  return { worker, port: port1, flag: new Int32Array(sab) };
}

interface WorkerMatch {
  values: string[] | null;
  index: number;
  lastIndex: number;
}

/** Run one exec() of a backtracking-only pattern in a worker thread with a hard time limit. */
function execInWorker(re: RegExp, lastIndex: number, str: string, timeoutMs: number): WorkerMatch {
  const w = (regexWorker ??= startRegexWorker());
  // a fresh worker needs a moment to boot (not counted against the match)
  if (Atomics.load(w.flag, 1) === 0) Atomics.wait(w.flag, 1, 0, 5000);
  Atomics.store(w.flag, 0, 0);
  w.port.postMessage({ source: re.source, flags: re.flags, str, lastIndex });
  const wait = Atomics.wait(w.flag, 0, 0, timeoutMs);
  if (wait === 'timed-out') {
    void w.worker.terminate();
    // boot the replacement in the background
    regexWorker = startRegexWorker();
    throw new Error(`Regular expression /${truncate(re.source, 60)}/ took longer than ${timeoutMs} ms – simplify it (avoid nested quantifiers such as (a+)+)`);
  }
  const msg = receiveMessageOnPort(w.port)?.message as
    { match: { values: string[]; index: number } | null; lastIndex: number; error?: undefined } | { error: string } | undefined;
  if (!msg) throw new Error('Regular expression evaluation failed');
  if (msg.error !== undefined) throw new Error(msg.error);
  return { values: msg.match?.values ?? null, index: msg.match?.index ?? -1, lastIndex: msg.lastIndex };
}

/** Time limit of one regular expression match in the worker. */
const REGEX_TIMEOUT_MS = 500;

/**
 * RegexEngine for JSONata: patterns the linear-time engine supports run natively
 * (with the V8 fallback above); all others (case-insensitive, unicode, lookaround,
 * back references) run in a worker thread that is terminated after a time limit.
 */
class GuardedRegExp {
  lastIndex = 0;
  private re!: RegExp;
  constructor(pattern: RegExp | string, flags?: string) {
    const re = pattern instanceof RegExp ? new RegExp(pattern) : new RegExp(pattern, flags);
    if (isLinearCapable(re)) return re as unknown as GuardedRegExp;
    this.re = re;
  }
  exec(str: string): RegExpExecArray | null {
    const g = guardStore.getStore();
    const left = g ? Math.max(50, Math.min(REGEX_TIMEOUT_MS, g.deadline - performance.now())) : REGEX_TIMEOUT_MS;
    const r = execInWorker(this.re, this.lastIndex, String(str), left);
    this.lastIndex = r.lastIndex;
    if (!r.values) return null;
    return Object.assign(r.values, { index: r.index, input: String(str) }) as unknown as RegExpExecArray;
  }
}

function compile(expr: string, l: ExpressionLimits): jsonata.Expression {
  const cacheKey = `${l.timeoutMs}|${l.maxDepth}|${l.maxSequence}|${expr}`;
  let c = cache.get(cacheKey);
  if (!c) {
    try {
      c = (jsonata as unknown as (e: string, o: Record<string, unknown>) => jsonata.Expression)(expr, {
        timeout: Number.isFinite(l.timeoutMs) ? l.timeoutMs : 0,
        stack: l.maxDepth,
        sequence: l.maxSequence,
        RegexEngine: GuardedRegExp,
      });
    } catch (e) {
      throw new ExpressionError(expr, (e as Error).message);
    }
    (c.assign as (name: unknown, value: unknown) => void)(Symbol.for('jsonata.__evaluate_entry'), onEvaluateEntry);
    if (cache.size > 2000) cache.clear();
    cache.set(cacheKey, c);
  }
  return c;
}

/** Remove a single surrounding {{ }} if present. */
export function stripBraces(expr: string): string {
  const t = expr.trim();
  const segs = parseTemplate(t);
  if (segs.length === 1 && segs[0]!.kind === 'expr') return segs[0]!.text;
  return t;
}

export const standardBindings: Bindings = {
  /** Capped replacement for the $pad builtin (guards against huge single allocations). */
  pad: safePad,
  /** Days elapsed since a timestamp (ISO string or epoch millis). undefined if empty. */
  daysSince: (t: unknown) => {
    const ms = toMillis(t);
    if (ms === undefined) return undefined;
    return Math.floor((Date.now() - ms) / 86400000);
  },
  /** ISO timestamp n days in the past. */
  daysAgo: (n: number) => new Date(Date.now() - Number(n) * 86400000).toISOString(),
  uuid: () => crypto.randomUUID(),
  /** Parse a timestamp leniently into epoch millis (undefined if invalid). */
  ts: (t: unknown) => toMillis(t),
};

function toMillis(t: unknown): number | undefined {
  if (t === undefined || t === null || t === '') return undefined;
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  const n = Date.parse(String(t));
  return Number.isNaN(n) ? undefined : n;
}

/** Help for the custom functions above (expression assistant). */
export const CUSTOM_FUNCTIONS: { name: string; signature: string; help: string }[] = [
  { name: '$daysSince', signature: '$daysSince(timestamp)', help: 'Whole days since an ISO timestamp or epoch millis (undefined when empty)' },
  { name: '$daysAgo', signature: '$daysAgo(n)', help: 'ISO timestamp n days in the past' },
  { name: '$uuid', signature: '$uuid()', help: 'Random UUID' },
  { name: '$ts', signature: '$ts(timestamp)', help: 'Parse a timestamp leniently into epoch millis (undefined if invalid)' },
];

export async function evalExpr(expr: string, root: unknown, bindings: Bindings = {}, opts?: EvalOptions): Promise<unknown> {
  const source = stripBraces(expr);
  if (source === '') return undefined;
  const l = effective(opts);
  const compiled = compile(source, l);
  if (opts?.signal?.aborted) throw new ExpressionError(source, 'Evaluation cancelled');
  const now = performance.now();
  const state: GuardState = { steps: 0, lastYield: now, deadline: now + l.timeoutMs, signal: opts?.signal };
  try {
    const run = guardStore.run(state, () => compiled.evaluate(root, { ...standardBindings, ...bindings }));
    let timer: NodeJS.Timeout | undefined;
    const result = Number.isFinite(l.timeoutMs)
      ? await Promise.race([
          run,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Evaluation timeout after ${l.timeoutMs} milliseconds`)), l.timeoutMs + 50);
          }),
        ]).finally(() => clearTimeout(timer))
      : await run;
    return normalize(result);
  } catch (e) {
    const err = e as { message?: string; code?: string };
    throw new ExpressionError(source, describeError(err, l));
  }
}

/** Clearer messages for the guard rails (JSONata's own say "check for infinite loop"). */
function describeError(err: { message?: string; code?: string }, l: ExpressionLimits): string {
  switch (err.code) {
    case 'D1012':
      return `Evaluation took longer than ${l.timeoutMs} ms and was stopped (limit: SM_EXPR_TIMEOUT_MS)`;
    case 'D1011':
      return `Evaluation nested deeper than ${l.maxDepth} levels and was stopped (limit: SM_EXPR_MAX_DEPTH)`;
    case 'D2015':
      return `Evaluation built a sequence longer than ${l.maxSequence} items and was stopped (limit: SM_EXPR_MAX_SEQUENCE)`;
    default:
      return err.message ?? String(err);
  }
}

/** JSONata returns special array subclasses / sequences; convert to plain JSON values. */
function normalize(v: unknown): unknown {
  if (v === undefined || v === null) return v;
  if (typeof v === 'function') return undefined;
  if (Array.isArray(v)) return Array.from(v, normalize);
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString();
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as object)) out[k] = normalize(val);
    return out;
  }
  return v;
}

export async function evalBool(expr: string, root: unknown, bindings: Bindings = {}, opts?: EvalOptions): Promise<boolean> {
  const v = await evalExpr(expr, root, bindings, opts);
  return Boolean(Array.isArray(v) ? v.length : v);
}

/** Evaluate an expression that should yield a list; singletons are wrapped. */
export async function evalList(expr: string, root: unknown, bindings: Bindings = {}, opts?: EvalOptions): Promise<unknown[]> {
  const v = await evalExpr(expr, root, bindings, opts);
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

type Segment = { kind: 'text' | 'expr'; text: string };

export function parseTemplate(s: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  let text = '';
  while (i < s.length) {
    if (s[i] === '{' && s[i + 1] === '{') {
      const end = findClose(s, i + 2);
      if (end < 0) {
        text += s.slice(i);
        break;
      }
      if (text) out.push({ kind: 'text', text });
      text = '';
      out.push({ kind: 'expr', text: s.slice(i + 2, end).trim() });
      i = end + 2;
    } else {
      text += s[i];
      i++;
    }
  }
  if (text) out.push({ kind: 'text', text });
  return out;
}

/** Find the closing "}}" honoring string literals and nested braces. */
function findClose(s: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') {
      if (depth === 0 && s[i + 1] === '}') return i;
      if (depth > 0) depth--;
    }
  }
  return -1;
}

export function hasTemplate(v: unknown): boolean {
  if (typeof v === 'string') return v.includes('{{');
  if (Array.isArray(v)) return v.some(hasTemplate);
  if (v && typeof v === 'object') return Object.values(v).some(hasTemplate);
  return false;
}

/** Render templates recursively in strings, arrays and objects. */
export async function render(value: unknown, root: unknown, bindings: Bindings = {}, opts?: EvalOptions): Promise<unknown> {
  if (typeof value === 'string') {
    if (!value.includes('{{')) return value;
    const segs = parseTemplate(value);
    if (segs.length === 1 && segs[0]!.kind === 'expr') return evalExpr(segs[0]!.text, root, bindings, opts);
    let out = '';
    for (const seg of segs) {
      if (seg.kind === 'text') out += seg.text;
      else out += stringify(await evalExpr(seg.text, root, bindings, opts));
    }
    return out;
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => render(v, root, bindings, opts)));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await render(v, root, bindings, opts);
    return out;
  }
  return value;
}

export async function renderString(value: string | undefined, root: unknown, bindings: Bindings = {}, opts?: EvalOptions): Promise<string> {
  if (value === undefined) return '';
  return stringify(await render(value, root, bindings, opts));
}

export function stringify(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
