import crypto from 'node:crypto';
import {
  DATA_LINEAGE_ID_PREFIX,
  DATA_LINEAGE_LIMITS as LL,
  normaliseOlNamespace,
  type DataLineageNamespaceAlias,
  type DataLineageOrigin,
  type DataLineageProposalStatus,
  type DataLineageRunState,
  type DataStepKind,
} from '@sm/shared';
import { db } from '../../db.js';
import { HttpError, newId, nowIso, parseJson } from '../../util.js';
import { chunks, marks } from '../store.js';

/**
 * The tables of lineage from tools (0.24.0, ADR 0036 phase 2): lineage sources, their push tokens, proposed steps with
 * their matched elements, the tests of a dbt manifest. The functions here are shared by the three origins (OpenLineage,
 * dbt, Snowflake OBJECT_DEPENDENCIES): matching datasets to elements in bulk, and writing a proposal with a fixed number
 * of statements whatever the number of its datasets.
 */

export interface LineageSourceRow {
  id: string;
  name: string;
  kind: 'openlineage' | 'dbt';
  platform_id: string | null;
  namespace_aliases: string;
  team_ids: string;
  enabled: number;
  received: number;
  refused: number;
  last_event_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  last_import: string | null;
  revision: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface ProposalRow {
  id: string;
  origin: DataLineageOrigin;
  source_id: string;
  job_key: string;
  name: string;
  step_kind: DataStepKind;
  tool: string;
  ends_hash: string;
  unmatched: string;
  status: DataLineageProposalStatus;
  changed: number;
  step_id: string | null;
  last_run_id: string | null;
  last_run_state: DataLineageRunState | null;
  last_run_at: string | null;
  last_complete_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  decided_by: string | null;
  decided_at: string | null;
}

export interface ProposalEndRow {
  proposal_id: string;
  element_id: string;
  direction: 'in' | 'out';
}

/** Unmatched datasets of a proposal as stored: the first names per side and the counts. */
export interface Unmatched {
  in: string[];
  out: string[];
  inCount: number;
  outCount: number;
}

export const lineageSourceRow = (id: string): LineageSourceRow | undefined => db().get<LineageSourceRow>('SELECT * FROM dp_lineage_sources WHERE id = ?', id);
export const proposalRow = (id: string): ProposalRow | undefined => db().get<ProposalRow>('SELECT * FROM dp_lineage_proposals WHERE id = ?', id);

/** The ends of these proposals (one statement per chunk). */
export function proposalEnds(ids: readonly string[]): ProposalEndRow[] {
  return chunks([...new Set(ids)]).flatMap((part) =>
    db().all<ProposalEndRow>(`SELECT * FROM dp_lineage_proposal_elements WHERE proposal_id IN (${marks(part.length)})`, ...part),
  );
}

// ---------- matching datasets to elements ----------

export interface Dataset {
  namespace: string;
  name: string;
}

/** The namespace after the source's aliases (compared without case and trailing slashes). */
export function aliased(ns: string, aliases: readonly DataLineageNamespaceAlias[]): string {
  const n = normaliseOlNamespace(ns);
  const a = aliases.find((x) => normaliseOlNamespace(x.from) === n);
  return a ? normaliseOlNamespace(a.to) : n;
}

const datasetKey = (ns: string, name: string) => `${normaliseOlNamespace(ns)}\n${name.trim().toLowerCase()}`;

/**
 * The elements of these OpenLineage datasets (by the namespace and name discovery gave them – names compared without
 * case, as Snowflake keeps unquoted names upper case): dataset key → element ids. One statement per chunk of names.
 */
export function elementsOfDatasets(datasets: readonly Dataset[], aliases: readonly DataLineageNamespaceAlias[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!datasets.length) return out;
  const wanted = new Map<string, Dataset>();
  for (const d of datasets) wanted.set(datasetKey(aliased(d.namespace, aliases), d.name), d);
  const namespaces = new Set<string>();
  const names = new Set<string>();
  for (const d of datasets) {
    const ns = aliased(d.namespace, aliases);
    namespaces.add(ns);
    namespaces.add(d.namespace.trim());
    const n = d.name.trim();
    names.add(n);
    names.add(n.toUpperCase());
    names.add(n.toLowerCase());
  }
  const nsList = [...namespaces].slice(0, 200);
  for (const part of chunks([...names], 400))
    for (const r of db().all<{ id: string; ol_namespace: string; ol_name: string }>(
      `SELECT id, ol_namespace, ol_name FROM dp_elements WHERE ol_namespace IN (${marks(nsList.length)}) AND ol_name IN (${marks(part.length)}) ORDER BY id`,
      ...nsList,
      ...part,
    )) {
      const k = datasetKey(r.ol_namespace, r.ol_name);
      if (!wanted.has(k)) continue;
      const list = out.get(k) ?? [];
      if (list.length < 5) list.push(r.id);
      out.set(k, list);
    }
  return out;
}

/** The key of a dataset for elementsOfDatasets' answer. */
export const keyOfDataset = (d: Dataset, aliases: readonly DataLineageNamespaceAlias[]): string => datasetKey(aliased(d.namespace, aliases), d.name);

/**
 * Elements of a platform by qualified name (dbt relations; compared without case): normalised name → element ids,
 * tables and views before containers. One statement per chunk of names.
 */
export function elementsByNames(platformId: string, names: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const uniq = [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))];
  for (const part of chunks(uniq))
    for (const r of db().all<{ id: string; name_norm: string; kind: string }>(
      `SELECT id, name_norm, kind FROM dp_elements WHERE platform_id = ? AND name_norm IN (${marks(part.length)}) ORDER BY id`,
      platformId,
      ...part,
    )) {
      const list = out.get(r.name_norm) ?? [];
      const container = r.kind.endsWith('.database') || r.kind.endsWith('.schema');
      if (container) list.push(r.id);
      else list.unshift(r.id);
      out.set(r.name_norm, list);
    }
  return out;
}

// ---------- coverage by documented steps ----------

/**
 * Whether the documented steps say what a proposal says already: every input → output pair (or, without inputs, every
 * output) is a way of one step. Returns the step that covers it all (or the first that covers a part, when several do
 * it together); one statement.
 */
export function documentedBy(inputs: readonly string[], outputs: readonly string[]): { covered: boolean; stepId: string | null } {
  if (!outputs.length) return { covered: false, stepId: null };
  const ids = [...new Set([...inputs, ...outputs])];
  const rows = chunks(ids).flatMap((part) =>
    db().all<{ step_id: string; element_id: string; direction: 'in' | 'out' }>(
      `SELECT step_id, element_id, direction FROM dp_step_elements WHERE element_id IN (${marks(part.length)})`,
      ...part,
    ),
  );
  const ins = new Map<string, Set<string>>();
  const outs = new Map<string, Set<string>>();
  for (const r of rows) {
    const m = r.direction === 'in' ? ins : outs;
    m.set(r.step_id, (m.get(r.step_id) ?? new Set()).add(r.element_id));
  }
  const steps = [...outs.keys()].sort();
  const covers = (s: string, i: string | null, o: string) => !!outs.get(s)?.has(o) && (i === null || !!ins.get(s)?.has(i));
  const pairs: [string | null, string][] = inputs.length
    ? inputs.flatMap((i) => outputs.map((o) => [i, o] as [string, string]))
    : outputs.map((o) => [null, o]);
  const whole = steps.find((s) => pairs.every(([i, o]) => covers(s, i, o)));
  if (whole) return { covered: true, stepId: whole };
  const each = pairs.every(([i, o]) => steps.some((s) => covers(s, i, o)));
  if (!each) return { covered: false, stepId: null };
  return { covered: true, stepId: steps.find((s) => pairs.some(([i, o]) => covers(s, i, o))) ?? null };
}

// ---------- writing proposals ----------

export interface ProposalDraft {
  origin: DataLineageOrigin;
  sourceId: string;
  key: string;
  name: string;
  kind: DataStepKind;
  tool: string;
  inputs: string[];
  outputs: string[];
  unmatchedInputs: string[];
  unmatchedOutputs: string[];
  /** A run of the job (OpenLineage, dbt run results); null: the ends only (a manifest, a static job event) */
  run: { id: string | null; state: DataLineageRunState; at: string } | null;
  /**
   * OpenLineage: the datasets add to the stored ones (START, RUNNING and other events may name a part); a COMPLETE
   * event (and a static job event) says the job's datasets as they are
   */
  union?: boolean;
  /** A run only: keep the stored ends (an event without datasets) */
  runOnly?: boolean;
}

export interface ProposalWrite {
  id: string;
  created: boolean;
  /** Its datasets changed (or it is new) */
  changed: boolean;
  status: DataLineageProposalStatus;
}

const endsHash = (inputs: readonly string[], outputs: readonly string[]) =>
  crypto
    .createHash('sha256')
    .update(`${[...new Set(inputs)].sort().join(',')}>${[...new Set(outputs)].sort().join(',')}`)
    .digest('hex')
    .slice(0, 32);

const cut = (xs: readonly string[]) => [...new Set(xs)].slice(0, LL.ends);
const RUN_ORDER: Record<DataLineageRunState, number> = { start: 0, running: 1, other: 2, abort: 3, fail: 3, complete: 3 };

/**
 * Writes what a tool says about one job (model, referencing object): creates the proposal or updates it – its ends when
 * they changed (re-checked against the documented steps: _documented_ when the steps say the same, else _open_, with
 * `changed` when it had become a step), its last run when the run is newer (and the step's last run when it has one).
 * A rejected proposal stays rejected until its datasets change. A fixed number of statements: the proposal, its ends
 * (when needed), the coverage, the writes. Call inside a transaction.
 */
export function writeProposal(d: ProposalDraft, now = nowIso()): ProposalWrite | null {
  const existing = db().get<ProposalRow>(
    'SELECT * FROM dp_lineage_proposals WHERE source_id = ? AND origin = ? AND job_key = ?',
    d.sourceId,
    d.origin,
    d.key.slice(0, LL.key),
  );
  let inputs = cut(d.inputs);
  let outputs = cut(d.outputs);
  let unmatched: Unmatched = {
    in: [...new Set(d.unmatchedInputs)].slice(0, LL.unmatchedKept).map((n) => n.slice(0, LL.key)),
    out: [...new Set(d.unmatchedOutputs)].slice(0, LL.unmatchedKept).map((n) => n.slice(0, LL.key)),
    inCount: new Set(d.unmatchedInputs).size + Math.max(0, new Set(d.inputs).size - LL.ends),
    outCount: new Set(d.unmatchedOutputs).size + Math.max(0, new Set(d.outputs).size - LL.ends),
  };
  const keepEnds = !!existing && (d.runOnly || (!inputs.length && !outputs.length && !unmatched.inCount && !unmatched.outCount));
  if (existing && (keepEnds || d.union)) {
    const stored = db().all<ProposalEndRow>('SELECT * FROM dp_lineage_proposal_elements WHERE proposal_id = ?', existing.id);
    const was = parseJson<Unmatched>(existing.unmatched, { in: [], out: [], inCount: 0, outCount: 0 });
    const storedIn = stored.filter((e) => e.direction === 'in').map((e) => e.element_id);
    const storedOut = stored.filter((e) => e.direction === 'out').map((e) => e.element_id);
    if (keepEnds) {
      inputs = storedIn;
      outputs = storedOut;
      unmatched = was;
    } else {
      inputs = cut([...storedIn, ...inputs]);
      outputs = cut([...storedOut, ...outputs]);
      const ui = [...new Set([...was.in, ...unmatched.in])];
      const uo = [...new Set([...was.out, ...unmatched.out])];
      unmatched = {
        in: ui.slice(0, LL.unmatchedKept),
        out: uo.slice(0, LL.unmatchedKept),
        inCount: Math.max(was.inCount, unmatched.inCount, ui.length),
        outCount: Math.max(was.outCount, unmatched.outCount, uo.length),
      };
    }
  }
  // an element is read or written by a step, not both: a dataset a job reads and writes is an output
  inputs = inputs.filter((i) => !outputs.includes(i));
  const hash = endsHash(inputs, outputs) + (unmatched.inCount || unmatched.outCount ? `+${unmatched.inCount}/${unmatched.outCount}` : '');
  const endsChanged = !existing || existing.ends_hash !== hash;
  // the run: only a newer one (or a later state of the same run) replaces the stored one
  const run = d.run;
  const newerRun =
    !!run &&
    (!existing?.last_run_at ||
      run.at > existing.last_run_at ||
      (run.at === existing.last_run_at && RUN_ORDER[run.state] >= RUN_ORDER[existing.last_run_state ?? 'start']));
  let status: DataLineageProposalStatus = existing?.status ?? 'open';
  let stepId = existing?.step_id ?? null;
  let changed = !!existing?.changed;
  if (endsChanged) {
    const doc = documentedBy(inputs, outputs);
    if (doc.covered) {
      status = 'documented';
      stepId = doc.stepId;
      changed = false;
    } else {
      // it had become a step (accepted or documented): accepting again changes that step
      changed = !!stepId && (status === 'accepted' || status === 'documented' || (status === 'open' && changed));
      if (!changed) stepId = null;
      status = 'open';
    }
  }
  const lastRun = newerRun
    ? {
        id: run!.id,
        state: run!.state,
        at: run!.at,
        completeAt: run!.state === 'complete' ? run!.at : (existing?.last_complete_at ?? null),
      }
    : null;
  if (!existing) {
    const n = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_lineage_proposals WHERE source_id = ?', d.sourceId)!.n);
    if (n >= LL.proposalsPerSource) return null;
    const id = newId(DATA_LINEAGE_ID_PREFIX.proposal);
    db().run(
      `INSERT INTO dp_lineage_proposals (id, origin, source_id, job_key, name, step_kind, tool, ends_hash, unmatched, status, changed, step_id,
         last_run_id, last_run_state, last_run_at, last_complete_at, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      d.origin,
      d.sourceId,
      d.key.slice(0, LL.key),
      d.name.slice(0, LL.name),
      d.kind,
      d.tool.slice(0, 60),
      hash,
      JSON.stringify(unmatched),
      status,
      changed ? 1 : 0,
      stepId,
      lastRun?.id ?? null,
      lastRun?.state ?? null,
      lastRun?.at ?? null,
      lastRun?.completeAt ?? null,
      now,
      now,
    );
    writeEnds(id, inputs, outputs);
    if (stepId && lastRun) stepLastRun(stepId, d, lastRun);
    return { id, created: true, changed: true, status };
  }
  db().run(
    `UPDATE dp_lineage_proposals SET name = ?, step_kind = ?, tool = ?, ends_hash = ?, unmatched = ?, status = ?, changed = ?, step_id = ?,
       last_run_id = ?, last_run_state = ?, last_run_at = ?, last_complete_at = ?, last_seen_at = ? WHERE id = ?`,
    d.name.slice(0, LL.name),
    d.kind,
    d.tool.slice(0, 60) || existing.tool,
    hash,
    JSON.stringify(unmatched),
    status,
    changed ? 1 : 0,
    stepId,
    lastRun ? lastRun.id : existing.last_run_id,
    lastRun ? lastRun.state : existing.last_run_state,
    lastRun ? lastRun.at : existing.last_run_at,
    lastRun ? lastRun.completeAt : existing.last_complete_at,
    now,
    existing.id,
  );
  if (endsChanged) writeEnds(existing.id, inputs, outputs);
  if (stepId && lastRun) stepLastRun(stepId, d, lastRun);
  return { id: existing.id, created: false, changed: endsChanged, status };
}

function writeEnds(proposalId: string, inputs: readonly string[], outputs: readonly string[]): void {
  db().run('DELETE FROM dp_lineage_proposal_elements WHERE proposal_id = ?', proposalId);
  const rows: [string, string, string][] = [
    ...inputs.map((e) => [proposalId, e, 'in'] as [string, string, string]),
    ...outputs.map((e) => [proposalId, e, 'out'] as [string, string, string]),
  ];
  for (const part of chunks(rows, 200))
    if (part.length)
      db().run(
        `INSERT INTO dp_lineage_proposal_elements (proposal_id, element_id, direction) VALUES ${part.map(() => '(?, ?, ?)').join(', ')}`,
        ...part.flat(),
      );
}

/** The step's last run (dp_steps.last_run): the state, when, and where it was reported. */
function stepLastRun(
  stepId: string,
  d: Pick<ProposalDraft, 'origin' | 'sourceId'>,
  run: { state: DataLineageRunState; at: string; completeAt: string | null },
): void {
  db().run(
    'UPDATE dp_steps SET last_run = ? WHERE id = ?',
    JSON.stringify({ state: run.state, at: run.at, completeAt: run.completeAt, origin: d.origin, sourceId: d.sourceId }),
    stepId,
  );
}

/** Counts of a source's proposals by status (one statement for all sources). */
export function proposalCounts(sourceIds: readonly string[]): Map<string, Record<DataLineageProposalStatus, number>> {
  const out = new Map<string, Record<DataLineageProposalStatus, number>>();
  for (const part of chunks([...new Set(sourceIds)]))
    for (const r of db().all<{ source_id: string; status: DataLineageProposalStatus; n: number }>(
      `SELECT source_id, status, COUNT(*) AS n FROM dp_lineage_proposals WHERE source_id IN (${marks(part.length)}) GROUP BY source_id, status`,
      ...part,
    )) {
      const c = out.get(r.source_id) ?? { open: 0, accepted: 0, rejected: 0, documented: 0 };
      c[r.status] = Number(r.n);
      out.set(r.source_id, c);
    }
  return out;
}

/** Deletes a source's proposals, their ends and its dbt tests (the steps made from them stay). */
export function deleteProposalsOf(sourceId: string): number {
  db().run('DELETE FROM dp_lineage_proposal_elements WHERE proposal_id IN (SELECT id FROM dp_lineage_proposals WHERE source_id = ?)', sourceId);
  db().run('DELETE FROM dp_lineage_tests WHERE source_id = ?', sourceId);
  return db().run('DELETE FROM dp_lineage_proposals WHERE source_id = ?', sourceId).changes;
}

/** 404 of a lineage source the caller may not see (the same answer as a missing one). */
export const sourceNotFound = (id: string) => new HttpError(404, `Lineage source ${id} not found`, 'DATA_LINEAGE_SOURCE_NOT_FOUND', { id });
export const proposalNotFound = (id: string) => new HttpError(404, `Proposal ${id} not found`, 'DATA_LINEAGE_PROPOSAL_NOT_FOUND', { id });
