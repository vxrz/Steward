import type { FlowNode, NodeInspection, ProcessDefinition } from '@sm/shared';
import { db } from '../db.js';
import { parseJson, preview } from '../util.js';
import { getProcess } from '../processes/service.js';
import { getPlatform, getSecrets } from '../platforms/service.js';
import { secretValues } from '../platforms/http.js';
import { CUSTOM_FUNCTIONS, stringify, type Bindings } from './expr.js';
import { Redactor } from './runner.js';
import * as store from './store.js';

/**
 * Editor support: rebuild a run's variables from its journal and give the
 * expression assistant a context that never contains secrets.
 *
 * Variables are not snapshotted per step: every change of `vars` is derivable
 * from the journal (set outputs, saveAs outputs, for-each items), which is
 * recorded in full and already redacted. This works for old runs as well.
 */

interface Row {
  id: number;
  key: string;
  parent_key: string | null;
  step_id: string;
  type: string;
  status: string;
  started_at: string;
  duration_ms: number | null;
  input: string | null;
  output: string | null;
  error: string | null;
}

interface LoopRef {
  loopKey: string;
  index: number;
}

/** "outer[0]/inner[2]" → loops outer#0, outer[0]/inner#2 */
function loopsOf(scope: string | null): LoopRef[] {
  if (!scope) return [];
  const out: LoopRef[] = [];
  let prefix = '';
  for (const seg of scope.split('/')) {
    const m = /^(.*)\[(\d+)\]$/.exec(seg);
    if (m) out.push({ loopKey: prefix ? `${prefix}/${m[1]}` : m[1]!, index: Number(m[2]) });
    prefix = prefix ? `${prefix}/${seg}` : seg;
  }
  return out;
}

export interface VarsSnapshot {
  vars: Record<string, unknown>;
  /** Key of the activation the snapshot was taken before (undefined = final variables) */
  beforeKey?: string;
}

/** Variables of a run: final, or just before the first activation of `beforeNodeId`. */
export function reconstructVars(runId: string, def: ProcessDefinition, beforeNodeId?: string): VarsSnapshot {
  const rows = db().all<Row>(
    'SELECT id, key, parent_key, step_id, type, status, started_at, duration_ms, input, output, error FROM run_steps WHERE run_id = ? ORDER BY id',
    runId,
  );
  const nodes = new Map<string, FlowNode>(def.nodes.map((n) => [n.id, n]));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const target = beforeNodeId ? rows.find((r) => r.step_id === beforeNodeId) : undefined;
  const targetLoops = loopsOf(target?.parent_key ?? null);
  const inTargetChain = (l: LoopRef) => targetLoops.some((t) => t.loopKey === l.loopKey && t.index === l.index);
  const loopInfo = (loopKey: string) => {
    const r = byKey.get(loopKey);
    const n = r ? nodes.get(r.step_id) : undefined;
    if (!r || n?.type !== 'forEach') return undefined;
    const items = parseJson<{ decision?: unknown[] }>(r.input, {}).decision;
    return { node: n, items: Array.isArray(items) ? items : [] };
  };
  // writes inside a parallel loop item are local to that item
  const visible = (scope: string | null) => {
    for (const l of loopsOf(scope)) {
      if (inTargetChain(l)) continue;
      const info = loopInfo(l.loopKey);
      if (info && (info.node.concurrency ?? 1) > 1) return false;
    }
    return true;
  };
  const vars: Record<string, unknown> = {};
  const setItem = (l: LoopRef) => {
    const info = loopInfo(l.loopKey);
    if (!info) return;
    vars[info.node.as] = info.items[l.index];
    vars[`${info.node.as}Index`] = l.index;
  };
  const enclosing = new Set(targetLoops.map((l) => l.loopKey));
  for (const r of rows) {
    if (target && r.id >= target.id) break;
    if (enclosing.has(r.key) || !visible(r.parent_key)) continue;
    for (const l of loopsOf(r.parent_key)) setItem(l);
    const node = nodes.get(r.step_id);
    if (!node) continue;
    const out = parseJson<unknown>(r.output, undefined);
    if (r.status === 'failed') {
      if (node.saveAs && node.type !== 'check') vars[node.saveAs] = { error: (out as { error?: string } | undefined)?.error ?? r.error };
      else if (node.saveAs) vars[node.saveAs] = out;
      continue;
    }
    if (r.status !== 'succeeded' && r.status !== 'dryrun') continue;
    if (node.type === 'set' && out && typeof out === 'object') Object.assign(vars, out);
    else if (node.saveAs) vars[node.saveAs] = out;
  }
  for (const l of targetLoops) setItem(l);
  return { vars, beforeKey: target?.key };
}

/** Latest run of a process (or the given run, which must belong to it). */
export function pickRun(processId: string, runId?: string): store.RunRow | undefined {
  if (runId) {
    const r = store.runRow(runId);
    if (r.process_id !== processId) throw Object.assign(new Error(`Run ${runId} does not belong to process ${processId}`), { statusCode: 400 });
    return r;
  }
  const latest = db().get<{ id: string }>('SELECT id FROM runs WHERE process_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1', processId);
  return latest ? store.runRow(latest.id) : undefined;
}

export interface ExpressionContext {
  runId: string | null;
  definition: ProcessDefinition;
  scope: Record<string, unknown>;
  bindings: Bindings;
  redactor: Redactor;
  vars: Record<string, unknown>;
  connections: { slot: string; vars: string[] }[];
}

/** Scope like the engine's (inputs, vars, const, run, conn) built from a run's data – without secrets. */
export function expressionContext(processId: string, opts: { runId?: string; nodeId?: string } = {}): ExpressionContext {
  const run = pickRun(processId, opts.runId);
  const definition = run ? getProcess(run.process_id, run.process_version).definition : getProcess(processId).definition;
  const redactor = new Redactor();
  const conn: Record<string, unknown> = {};
  const platformVars: Record<string, Record<string, string>> = {};
  const connections: { slot: string; vars: string[] }[] = definition.connections.map((c) => ({ slot: c.slot, vars: [] }));
  let inputs: Record<string, unknown> = {};
  let vars: Record<string, unknown> = {};
  if (run) {
    inputs = parseJson(run.inputs, {});
    vars = reconstructVars(run.id, definition, opts.nodeId).vars;
    const bound = parseJson<Record<string, { platformId: string; platformName: string; baseUrl: string }>>(run.bindings, {});
    for (const [slot, b] of Object.entries(bound)) {
      try {
        const p = getPlatform(b.platformId);
        platformVars[slot] = p.config.variables ?? {};
        conn[slot] = { name: p.name, kind: p.kind, baseUrl: b.baseUrl, vars: p.config.variables ?? {} };
        const entry = connections.find((c) => c.slot === slot);
        if (entry) entry.vars = Object.keys(p.config.variables ?? {});
        try {
          const secrets = getSecrets(b.platformId);
          redactor.add(...Object.values(secrets), ...secretValues(secrets));
        } catch {
          /* vault locked or platform without secrets */
        }
      } catch {
        conn[slot] = { name: b.platformName, baseUrl: b.baseUrl, vars: {} };
      }
    }
  } else {
    for (const d of definition.inputs ?? []) inputs[d.name] = d.default ?? (d.type === 'list' || d.type === 'table' ? [] : d.type === 'boolean' ? false : null);
  }
  const constants = definition.constants ?? {};
  const scope = {
    inputs,
    vars,
    const: constants,
    run: run ? { id: run.id, dryRun: !!run.dry_run, actor: run.actor, startedAt: run.started_at } : { id: null, dryRun: true, actor: '', startedAt: null },
    conn,
  };
  const bindings: Bindings = {
    inputs,
    vars,
    const: constants,
    secret: () => {
      throw new Error('Secrets are not available in the expression assistant');
    },
    pvar: (slot: string, name: string, fallback?: unknown) => {
      const v = platformVars[slot]?.[name];
      return v === undefined || v === '' ? fallback : v;
    },
  };
  return { runId: run?.id ?? null, definition, scope, bindings, redactor, vars, connections };
}

/** Shorten a value to roughly `max` characters of JSON (arrays/objects keep their first entries). */
export function limitSize(value: unknown, max = 50000): unknown {
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= max) return value;
  let budget = max;
  const walk = (v: unknown, depth: number): unknown => {
    if (budget <= 0) return '…';
    if (typeof v === 'string') {
      const room = Math.max(40, Math.min(budget, 10000));
      const s = v.length > room ? v.slice(0, room) + `… (${v.length} chars)` : v;
      budget -= s.length + 2;
      return s;
    }
    if (v === null || typeof v !== 'object') {
      budget -= String(v).length + 1;
      return v;
    }
    if (depth > 20) {
      budget -= 3;
      return '…';
    }
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        if (budget <= 0) {
          out.push(`… ${v.length - i} more items`);
          break;
        }
        out.push(walk(v[i], depth + 1));
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    const entries = Object.entries(v as Record<string, unknown>);
    for (let i = 0; i < entries.length; i++) {
      const [k, val] = entries[i]!;
      if (budget <= 0) {
        out['…'] = `${entries.length - i} more keys`;
        break;
      }
      budget -= k.length + 3;
      out[k] = walk(val, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

export function sample(v: unknown, max = 120): string {
  const s = v === undefined ? 'undefined' : typeof v === 'string' ? JSON.stringify(v) : stringify(v);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Commonly used JSONata functions plus the engine's own ones. */
export const FUNCTIONS: { name: string; signature: string; help: string }[] = [
  { name: '$count', signature: '$count(array)', help: 'Number of items in an array' },
  { name: '$sum', signature: '$sum(array)', help: 'Sum of an array of numbers' },
  { name: '$max', signature: '$max(array)', help: 'Largest number in an array' },
  { name: '$min', signature: '$min(array)', help: 'Smallest number in an array' },
  { name: '$average', signature: '$average(array)', help: 'Mean of an array of numbers' },
  { name: '$map', signature: '$map(array, function($v, $i))', help: 'Apply a function to each item' },
  { name: '$filter', signature: '$filter(array, function($v, $i))', help: 'Items for which the function returns true' },
  { name: '$reduce', signature: '$reduce(array, function($acc, $v), init?)', help: 'Fold an array into one value' },
  { name: '$sort', signature: '$sort(array, function($a, $b)?)', help: 'Sort (the function returns true when $a goes after $b)' },
  { name: '$distinct', signature: '$distinct(array)', help: 'Array without duplicates' },
  { name: '$reverse', signature: '$reverse(array)', help: 'Array in reverse order' },
  { name: '$append', signature: '$append(array1, array2)', help: 'Concatenate two arrays' },
  { name: '$join', signature: '$join(array, separator?)', help: 'Join strings into one string' },
  { name: '$string', signature: '$string(value)', help: 'Convert a value to a string (objects become JSON)' },
  { name: '$number', signature: '$number(value)', help: 'Convert a string or boolean to a number' },
  { name: '$boolean', signature: '$boolean(value)', help: 'Truthiness of a value' },
  { name: '$exists', signature: '$exists(value)', help: 'true when the value (path) exists' },
  { name: '$lowercase', signature: '$lowercase(string)', help: 'Lower-case string' },
  { name: '$uppercase', signature: '$uppercase(string)', help: 'Upper-case string' },
  { name: '$trim', signature: '$trim(string)', help: 'Remove surrounding and duplicate whitespace' },
  { name: '$contains', signature: '$contains(string, pattern)', help: 'true when the string contains the text or regex' },
  { name: '$substring', signature: '$substring(string, start, length?)', help: 'Part of a string' },
  { name: '$substringBefore', signature: '$substringBefore(string, chars)', help: 'Text before the first occurrence of chars' },
  { name: '$substringAfter', signature: '$substringAfter(string, chars)', help: 'Text after the first occurrence of chars' },
  { name: '$split', signature: '$split(string, separator, limit?)', help: 'Split a string into an array' },
  { name: '$replace', signature: '$replace(string, pattern, replacement)', help: 'Replace text or regex matches' },
  { name: '$length', signature: '$length(string)', help: 'Number of characters' },
  { name: '$keys', signature: '$keys(object)', help: 'Keys of an object' },
  { name: '$lookup', signature: '$lookup(object, key)', help: 'Value of a key (also for keys with special characters)' },
  { name: '$merge', signature: '$merge(array of objects)', help: 'Merge objects into one' },
  { name: '$each', signature: '$each(object, function($v, $k))', help: 'Apply a function to each key/value pair' },
  { name: '$type', signature: '$type(value)', help: 'Type name: string, number, boolean, array, object, null' },
  { name: '$now', signature: '$now()', help: 'Current time as ISO timestamp' },
  { name: '$millis', signature: '$millis()', help: 'Current time in epoch milliseconds' },
  { name: '$toMillis', signature: '$toMillis(timestamp, picture?)', help: 'ISO timestamp → epoch milliseconds' },
  { name: '$fromMillis', signature: '$fromMillis(number, picture?, timezone?)', help: 'Epoch milliseconds → ISO timestamp' },
  { name: '$round', signature: '$round(number, precision?)', help: 'Round to a number of decimals' },
  { name: '$floor', signature: '$floor(number)', help: 'Round down' },
  { name: '$abs', signature: '$abs(number)', help: 'Absolute value' },
  ...CUSTOM_FUNCTIONS,
  { name: '$secret', signature: "$secret(slot, key)", help: 'Secret of a bound platform (not available in the expression assistant)' },
  { name: '$pvar', signature: "$pvar(slot, name, fallback?)", help: 'Variable of the platform bound to a connection slot' },
];

/** All activations of a node in a run (input/output previews) plus the variables before the first one. */
export function inspectNode(runId: string, nodeId: string): NodeInspection {
  const run = store.runRow(runId);
  const def = getProcess(run.process_id, run.process_version).definition;
  const rows = db().all<Row>(
    'SELECT id, key, parent_key, step_id, type, status, started_at, duration_ms, input, output, error FROM run_steps WHERE run_id = ? AND step_id = ? ORDER BY id',
    runId,
    nodeId,
  );
  const snap = rows.length ? reconstructVars(runId, def, nodeId) : { vars: {} };
  const varsBefore: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(snap.vars)) varsBefore[k] = preview(v, 2000)[0];
  return {
    runId,
    nodeId,
    activations: rows.map((r) => ({
      key: r.key,
      status: r.status,
      startedAt: r.started_at,
      durationMs: r.duration_ms,
      input: preview(parseJson<unknown>(r.input, undefined), 8000)[0],
      output: preview(parseJson<unknown>(r.output, undefined), 8000)[0],
      error: r.error,
    })),
    varsBefore,
  };
}
