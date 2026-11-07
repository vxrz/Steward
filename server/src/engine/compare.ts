/**
 * Compare two runs of a process (ADR 0010): computed from the stored record only – run_steps, run_tasks – and
 * never from anything resolved again. Activations align by journal key (`<scope>/<node>#n`, deterministic for a path);
 * across versions nodes match by id. Values are the protocol's: redacted, secrets "***". A "***" is shown as masked,
 * never as equal; secret inputs are not compared at all. A comparison is a read: no audit entry.
 */
import {
  COMPARE_LIMITS,
  type CompareRow,
  type CompareStepSide,
  type CompareValue,
  type FlowNode,
  type ProcessDefinition,
  type RunCompareSide,
  type RunComparison,
  type StepStatus,
} from '@sm/shared';
import { canonicalJson, parseJson } from '../util.js';
import { db } from '../db.js';
import { getProcess } from '../processes/service.js';
import { reconstructVars } from './inspect.js';
import * as store from './store.js';
import { modeOfRow } from './engine.js';

interface StepRow {
  key: string;
  step_id: string;
  type: string;
  name: string;
  status: StepStatus;
  duration_ms: number | null;
  summary: string | null;
  error: string | null;
  input: string | null;
  output: string | null;
}

interface Loaded {
  run: store.RunRow;
  def: ProcessDefinition;
  steps: StepRow[];
  cut: boolean;
  tasks: Map<string, { decision: unknown; decidedBy: string | null; decidedAt: string | null }>;
}

const MASK = '***';
/** The most nodes whose variables are rebuilt (each rebuild reads the run's journal once). */
const VAR_NODES = 200;

function load(runId: string): Loaded {
  const run = store.runRow(runId);
  let def: ProcessDefinition;
  try {
    def = getProcess(run.process_id, run.process_version).definition;
  } catch {
    def = { name: run.process_name, nodes: [], wires: [], connections: [], inputs: [] } as unknown as ProcessDefinition;
  }
  const rows = db().all<StepRow>(
    'SELECT key, step_id, type, name, status, duration_ms, summary, error, input, output FROM run_steps WHERE run_id = ? ORDER BY id LIMIT ?',
    runId,
    COMPARE_LIMITS.activations + 1,
  );
  const tasks = new Map(
    db()
      .all<{ step_key: string; decision: string | null; decided_by: string | null; decided_at: string | null }>(
        "SELECT step_key, decision, decided_by, decided_at FROM run_tasks WHERE run_id = ? AND status = 'completed'",
        runId,
      )
      .map((t) => [t.step_key, { decision: parseJson<unknown>(t.decision, null), decidedBy: t.decided_by, decidedAt: t.decided_at }]),
  );
  return { run, def, steps: rows.slice(0, COMPARE_LIMITS.activations), cut: rows.length > COMPARE_LIMITS.activations, tasks };
}

const hasMask = (v: unknown, depth = 0): boolean => {
  if (depth > 30) return false;
  if (typeof v === 'string') return v.includes(MASK);
  if (Array.isArray(v)) return v.some((x) => hasMask(x, depth + 1));
  if (v && typeof v === 'object') return Object.values(v).some((x) => hasMask(x, depth + 1));
  return false;
};

/** A value as the comparison shows it: masked when the protocol masked (part of) it, cut to the size limit. */
function shown(v: unknown): CompareValue {
  if (v === undefined) return null;
  if (hasMask(v)) return { masked: true };
  const text = JSON.stringify(v) ?? 'null';
  if (text.length <= COMPARE_LIMITS.valueChars) return { value: v };
  return { value: text.slice(0, COMPARE_LIMITS.valueChars) + '…', cut: true };
}

/** Same in both runs: both present, neither masked, equal canonical JSON. Masked values are never "equal". */
function same(a: unknown, b: unknown): boolean {
  if (a === undefined && b === undefined) return true;
  if (hasMask(a) || hasMask(b)) return false;
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

function side(r: StepRow, l: Loaded): CompareStepSide {
  const input = parseJson<Record<string, unknown> | null>(r.input, null);
  const output = parseJson<Record<string, unknown> | null>(r.output, null);
  const out: CompareStepSide = { status: r.status, durationMs: r.duration_ms, error: r.error, summary: r.summary };
  if ((r.type === 'if' || r.type === 'forEach') && input && 'decision' in input) {
    out.decision = r.type === 'forEach' && Array.isArray(input.decision) ? { items: input.decision.length } : input.decision;
  }
  const task = l.tasks.get(r.key);
  if (task) out.task = task;
  else if (r.type === 'userTask' && output?.simulated)
    out.task = {
      decision: { ...output, simulated: true },
      decidedBy: String(output.decidedBy ?? output.completedBy ?? ''),
      decidedAt: String(output.decidedAt ?? output.completedAt ?? '') || null,
    };
  if (r.type === 'check' && output && typeof output.passed === 'boolean') {
    out.check = {
      passed: output.passed,
      severity: typeof output.severity === 'string' ? output.severity : undefined,
      message: typeof output.message === 'string' ? output.message : undefined,
    };
  }
  if ((r.type === 'http' || r.type === 'query') && input) {
    let path: string | undefined;
    if (typeof input.url === 'string') {
      try {
        const u = new URL(input.url);
        path = u.pathname;
      } catch {
        path = input.url.split('?')[0];
      }
    }
    out.request = {
      ...(typeof input.method === 'string' ? { method: input.method } : {}),
      ...(path ? { path } : {}),
      ...(typeof output?.status === 'number' ? { status: output.status } : {}),
      ...(typeof output?.durationMs === 'number' ? { durationMs: output.durationMs } : {}),
      ...(typeof output?.attempts === 'number' ? { attempts: output.attempts } : {}),
    };
  }
  return out;
}

/** Steps that took clearly longer or shorter: twice as long and at least a second apart. */
function durationDiffers(a?: number | null, b?: number | null): boolean {
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return hi - lo >= 1000 && hi >= 2 * Math.max(lo, 1);
}

function sideOfRun(l: Loaded): RunCompareSide {
  const r = l.run;
  const summary = store.getRunSummary(r.id);
  return {
    id: r.id,
    processVersion: r.process_version,
    status: r.status,
    outcome: summary.outcome,
    mode: modeOfRow(r),
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    actor: r.actor,
    durationMs: r.finished_at ? Date.parse(r.finished_at) - Date.parse(r.started_at) : null,
    cut: l.cut,
  };
}

/** Keys of both runs in one order: A's, with B's own keys after the key that comes before them in B. */
function mergedKeys(a: StepRow[], b: StepRow[]): string[] {
  const out = a.map((s) => s.key);
  const inOut = new Set(out);
  let after: string | null = null;
  for (const s of b) {
    if (inOut.has(s.key)) {
      after = s.key;
      continue;
    }
    const at = after === null ? 0 : out.indexOf(after) + 1;
    out.splice(at, 0, s.key);
    inOut.add(s.key);
    after = s.key;
  }
  return out;
}

/** Variables before the first activation of each node, per node id. */
function varsByNode(l: Loaded, nodeIds: string[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const id of nodeIds.slice(0, VAR_NODES)) out.set(id, reconstructVars(l.run.id, l.def, id).vars);
  return out;
}

export function compareRuns(aId: string, bId: string): RunComparison {
  const a = load(aId);
  const b = load(bId);
  const nodesA = new Map<string, FlowNode>(a.def.nodes.map((n) => [n.id, n]));
  const nodesB = new Map<string, FlowNode>(b.def.nodes.map((n) => [n.id, n]));
  const byKeyA = new Map(a.steps.map((s) => [s.key, s]));
  const byKeyB = new Map(b.steps.map((s) => [s.key, s]));
  // the first activation of each node in both runs: where the variables are compared
  const firstOf = (steps: StepRow[]) => {
    const m = new Map<string, string>();
    for (const s of steps) if (!m.has(s.step_id)) m.set(s.step_id, s.key);
    return m;
  };
  const firstA = firstOf(a.steps);
  const firstB = firstOf(b.steps);
  const both = [...firstA.keys()].filter((id) => firstB.has(id) && firstA.get(id) === firstB.get(id));
  const varsA = varsByNode(a, both);
  const varsB = varsByNode(b, both);

  const rows: CompareRow[] = [];
  for (const key of mergedKeys(a.steps, b.steps)) {
    const ra = byKeyA.get(key);
    const rb = byKeyB.get(key);
    const r = (ra ?? rb)!;
    const nodeId = r.step_id;
    const row: CompareRow = {
      key,
      nodeId,
      nodeName: r.name || nodeId,
      type: r.type,
      presence: ra && rb ? 'both' : ra ? 'a' : 'b',
      differs: [],
    };
    if (!nodesA.has(nodeId) && nodesB.has(nodeId)) row.node = 'added';
    else if (nodesA.has(nodeId) && !nodesB.has(nodeId)) row.node = 'removed';
    if (ra) row.a = side(ra, a);
    if (rb) row.b = side(rb, b);
    if (!ra || !rb) row.differs.push('path');
    else {
      const sa = row.a!;
      const sb = row.b!;
      if (sa.status !== sb.status) row.differs.push('status');
      if (!same(sa.decision, sb.decision) || !same(sa.task?.decision, sb.task?.decision)) row.differs.push('decision');
      if (!same(sa.check, sb.check)) row.differs.push('check');
      if (sa.request && sb.request && !same({ ...sa.request, durationMs: 0 }, { ...sb.request, durationMs: 0 })) row.differs.push('request');
      if ((sa.error ?? null) !== (sb.error ?? null)) row.differs.push('error');
      if (durationDiffers(sa.durationMs, sb.durationMs)) row.differs.push('duration');
      if (firstA.get(nodeId) === key && varsA.has(nodeId)) {
        const va = varsA.get(nodeId)!;
        const vb = varsB.get(nodeId)!;
        const vars: NonNullable<CompareRow['vars']> = {};
        let differ = false;
        for (const name of [...new Set([...Object.keys(va), ...Object.keys(vb)])].sort()) {
          const x = va[name];
          const y = vb[name];
          const masked = hasMask(x) && hasMask(y);
          if (same(x, y)) continue;
          vars[name] = { a: shown(x), b: shown(y) };
          if (!masked) differ = true;
        }
        if (Object.keys(vars).length) row.vars = vars;
        if (differ) row.differs.push('vars');
      }
    }
    rows.push(row);
  }

  // inputs side by side; secret inputs are never compared
  const secretInputs = new Set([...(a.def.inputs ?? []), ...(b.def.inputs ?? [])].filter((i) => i.type === 'secret').map((i) => i.name));
  const ia = parseJson<Record<string, unknown>>(a.run.inputs, {});
  const ib = parseJson<Record<string, unknown>>(b.run.inputs, {});
  const inputs: RunComparison['inputs'] = {};
  for (const name of [...new Set([...Object.keys(ia), ...Object.keys(ib)])].sort()) {
    if (secretInputs.has(name)) inputs[name] = { a: { secret: true }, b: { secret: true }, same: null };
    else inputs[name] = { a: shown(ia[name]), b: shown(ib[name]), same: same(ia[name], ib[name]) };
  }
  return {
    processId: a.run.process_id,
    processName: b.run.process_name,
    a: sideOfRun(a),
    b: sideOfRun(b),
    inputs,
    rows,
    summary: {
      steps: rows.length,
      differing: rows.filter((r) => r.differs.length).length,
      onlyA: rows.filter((r) => r.presence === 'a').length,
      onlyB: rows.filter((r) => r.presence === 'b').length,
    },
  };
}

/**
 * The last good run before `runId`: the latest earlier run of the same process that succeeded without findings, in the
 * same mode, not a debug run. Null when there is none.
 */
export function lastGoodRun(runId: string): string | null {
  const r = store.runRow(runId);
  const row = db().get<{ id: string }>(
    `SELECT id FROM runs WHERE process_id = ? AND id <> ? AND debug IS NULL AND status = 'succeeded' AND dry_run = ? AND recorded = ? AND started_at < ?
       AND NOT EXISTS (SELECT 1 FROM run_steps s WHERE s.run_id = runs.id AND s.type = 'check' AND s.status = 'failed')
     ORDER BY started_at DESC, id DESC LIMIT 1`,
    r.process_id,
    r.id,
    r.dry_run ? 1 : 0,
    r.recorded ? 1 : 0,
    r.started_at,
  );
  return row?.id ?? null;
}
