import type { FlowNode, ProcessDefinition } from '@sm/shared';
import { db } from '../db.js';
import { getProcess } from '../processes/service.js';

/**
 * Where the value of a run variable may come from, for the allowed data of an LLM gateway (docs/AI.md, "Allowed data").
 *
 * The runner records the sources of every write to a variable (RunContext.taint): the platform of a step that calls
 * one (API call, browser), what an AI step was given (its context sources and the gateway), and ANY for everything
 * else (set variables, for each, sub-process outputs, user tasks …) – Steward cannot know what a computed value
 * contains. A name keeps every source ever written to it in the run (a union that never shrinks), so a later step,
 * or a parallel loop item, writing the same name can only make it count as more, never as less. The writes are
 * replayed in the same order when a durable run resumes, so the sources are recomputed, not stored.
 *
 * Before an AI step sends a variable, ANY and INPUT are expanded (runSources, inputSources) and every source must be
 * allowed: each platform (but the gateway itself), INPUT by "inputs of a run", dataset:<key> by a dataset pattern.
 */

/** Unknown: everything the run may have read */
export const ANY = '*';
/** Inputs of the run */
export const INPUT = 'input';
export const DATASET = 'dataset:';
export const datasetSource = (key: string): string => `${DATASET}${key}`;

/** The variables a step's result is in: the keys of a set step, else its "Save result as". */
export function resultVars(node: FlowNode): string[] {
  if (node.type === 'set') return Object.keys(node.values ?? {});
  return node.saveAs ? [node.saveAs] : [];
}

const TREND = /\$(?:trend|daysUntil)\s*\(\s*(?:(['"])([^'"/]+)\/[^'"]*\1)?/g;

/**
 * The datasets a definition may read: the dataset context of its AI steps, the datasets named in $trend() and
 * $daysUntil(), and those of its sub-processes. "*" (every dataset) for $systems() – the system inventory – and for
 * a $trend()/$daysUntil() whose dataset is not written out.
 */
export function datasetsReadBy(def: ProcessDefinition, seen = new Set<string>()): Set<string> {
  const out = new Set<string>();
  const visit = (v: unknown, depth: number): void => {
    if (depth > 30) return;
    if (typeof v === 'string') {
      if (v.includes('$systems')) out.add('*');
      for (const m of v.matchAll(TREND)) out.add(m[2] ?? '*');
    } else if (Array.isArray(v)) v.forEach((x) => visit(x, depth + 1));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => visit(x, depth + 1));
  };
  visit(def, 0);
  for (const n of def.nodes) {
    if (n.type === 'ai') for (const c of n.context ?? []) if (c.from === 'dataset' && c.dataset) out.add(c.dataset);
    if (n.type === 'subprocess') {
      const ref = `${n.process}@${n.version ?? ''}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      try {
        if (seen.size > 50) throw new Error('too many sub-processes');
        for (const k of datasetsReadBy(getProcess(n.process, n.version).definition, seen)) out.add(k);
      } catch {
        out.add('*');
      }
    }
  }
  return out;
}

interface RunFacts {
  process_id: string;
  process_version: number;
  inputs: string;
  bindings: string;
  parent_run_id: string | null;
}

const parse = (s: string | null | undefined): Record<string, unknown> => {
  try {
    const v = JSON.parse(s ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/**
 * What ANY stands for in a run: every platform bound to it, the datasets its definition may read, and – when it has
 * inputs – its inputs (inputSources: for a sub-process run also everything of its parent run, which computed them).
 */
export function runSources(runId: string): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  let id: string | null = runId;
  while (id && !seen.has(id) && seen.size < 20) {
    seen.add(id);
    // debug runs: one run by its id (a debug run's own AI step reads its own run)
    const r: RunFacts | undefined = db().get<RunFacts>('SELECT process_id, process_version, inputs, bindings, parent_run_id FROM runs WHERE id = ?', id);
    if (!r) {
      out.add(INPUT).add(datasetSource('*'));
      break;
    }
    for (const b of Object.values(parse(r.bindings))) {
      const p = (b as { platformId?: unknown } | null)?.platformId;
      if (typeof p === 'string') out.add(p);
    }
    try {
      for (const k of datasetsReadBy(getProcess(r.process_id, r.process_version).definition)) out.add(datasetSource(k));
    } catch {
      out.add(datasetSource('*'));
    }
    if (!Object.keys(parse(r.inputs)).length) break;
    out.add(INPUT);
    // a sub-process run's inputs are computed in its parent run: they may carry anything of it
    id = r.parent_run_id;
  }
  return out;
}

/** What the inputs of a run may carry: the inputs – and for a sub-process run everything of its parent run. */
export function inputSources(runId: string): Set<string> {
  // debug runs: one run by its id (a debug run's own AI step reads its own run)
  const parent = db().get<{ parent_run_id: string | null }>('SELECT parent_run_id FROM runs WHERE id = ?', runId)?.parent_run_id;
  return new Set([INPUT, ...(parent ? runSources(parent) : [])]);
}
