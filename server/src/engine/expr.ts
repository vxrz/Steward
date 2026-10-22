import jsonata from 'jsonata';
import crypto from 'node:crypto';

/**
 * Expressions are JSONata (https://jsonata.org). Templates are strings with
 * {{ expression }} placeholders; a string that is exactly one placeholder
 * returns the raw value (array, object, number ...).
 */

export type Bindings = Record<string, unknown>;

const cache = new Map<string, jsonata.Expression>();

/** Guard rails for untrusted/interactive evaluation (expression assistant). */
export interface EvalOptions {
  /** Abort evaluation after this many milliseconds (JSONata guard rail + wall clock) */
  timeoutMs?: number;
  /** Maximum JSONata stack depth */
  maxDepth?: number;
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

function compile(expr: string, opts?: EvalOptions): jsonata.Expression {
  const guarded = !!(opts?.timeoutMs || opts?.maxDepth);
  const cacheKey = guarded ? `${opts!.timeoutMs ?? 0}|${opts!.maxDepth ?? 0}|${expr}` : expr;
  let c = cache.get(cacheKey);
  if (!c) {
    try {
      c = guarded
        ? (jsonata as unknown as (e: string, o: Record<string, unknown>) => jsonata.Expression)(expr, { timeout: opts!.timeoutMs, stack: opts!.maxDepth })
        : jsonata(expr);
    } catch (e) {
      throw new ExpressionError(expr, (e as Error).message);
    }
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
  const compiled = compile(source, opts);
  try {
    const run = compiled.evaluate(root, { ...standardBindings, ...bindings });
    let timer: NodeJS.Timeout | undefined;
    const result = opts?.timeoutMs
      ? await Promise.race([
          run,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Evaluation timeout after ${opts.timeoutMs} milliseconds`)), opts.timeoutMs! + 50);
          }),
        ]).finally(() => clearTimeout(timer))
      : await run;
    return normalize(result);
  } catch (e) {
    const err = e as { message?: string; code?: string };
    throw new ExpressionError(source, err.message ?? String(e));
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

export async function evalBool(expr: string, root: unknown, bindings: Bindings = {}): Promise<boolean> {
  const v = await evalExpr(expr, root, bindings);
  return Boolean(Array.isArray(v) ? v.length : v);
}

/** Evaluate an expression that should yield a list; singletons are wrapped. */
export async function evalList(expr: string, root: unknown, bindings: Bindings = {}): Promise<unknown[]> {
  const v = await evalExpr(expr, root, bindings);
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

export async function renderString(value: string | undefined, root: unknown, bindings: Bindings = {}): Promise<string> {
  if (value === undefined) return '';
  return stringify(await render(value, root, bindings));
}

export function stringify(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
