import {
  DATA_LINEAGE_LIMITS as LL,
  DATA_LINEAGE_ORIGINS,
  DATA_LINEAGE_PROPOSAL_STATUSES,
  DATA_PRODUCT_ID_PREFIX,
  dataLineageAcceptInput,
  type DataLineageEnd,
  type DataLineageProposal,
  type DataLineageProposalPage,
  type DataLineageProposalStatus,
} from '@sm/shared';
import { z } from 'zod';
import { db } from '../../db.js';
import { audit } from '../../audit.js';
import { forbid, me } from '../../auth/access.js';
import type { AuthUser } from '../../auth/context.js';
import { HttpError, newId, nowIso, parseJson } from '../../util.js';
import { elementAccess, productAccess } from '../access.js';
import { L, decodeCursor, encodeCursor, json, limitReached } from '../common.js';
import { listSources as listDiscoverySources } from '../discovery/sources.js';
import { canEditStep, writeEnds } from '../steps.js';
import {
  chunks,
  elementTeamIds,
  elementsByIds,
  marks,
  membersOf,
  membershipsOfElements,
  productsByIds,
  stepRow,
  stepsOfElements,
  type ElementRow,
} from '../store.js';
import { sourcePermissions } from './sources.js';
import { proposalEnds, proposalNotFound, proposalRow, type LineageSourceRow, type ProposalRow, type Unmatched } from './store.js';

/**
 * The inbox of proposed steps (ADR 0036 part 9: "Suggestions are confirmed by a person") – from the lineage sources
 * (OpenLineage jobs, dbt models) and from Snowflake discovery sources (OBJECT_DEPENDENCIES):
 *
 * - **Who sees a proposal:** who sees its source (a lineage source's owning teams; a discovery source's platform and
 *   element teams). Its elements the reader may not see are counted, never named; a dataset no element matches is
 *   shown as the tool sent it (it names nothing in Steward).
 * - **Accepting** makes a step (documented where its result lives, decision 16): the person must see every end and may
 *   change the products its outputs belong to (or, outside products, the outputs) – as when they write the step by
 *   hand. A proposal that was a step already and changed since updates that step (its ends the person may not see stay).
 * - **Rejecting**: who could accept it, or who manages its source. A rejected proposal stays rejected until the tool
 *   names other datasets for the job.
 *
 * A page costs a fixed number of statements whatever its size (proposals, ends, elements, their teams, the products of
 * the outputs – each one statement per chunk).
 */

/** The ids of the sources the reader sees (lineage sources and Snowflake discovery sources), with their names. */
function visibleSources(u: AuthUser): Map<string, { name: string; manage: boolean }> {
  const out = new Map<string, { name: string; manage: boolean }>();
  for (const r of db().all<LineageSourceRow>('SELECT id, name, team_ids FROM dp_lineage_sources')) {
    const p = sourcePermissions(u, r);
    if (p.length) out.set(r.id, { name: r.name, manage: p.includes('manage') });
  }
  // discovery sources have their own rights (the platform's, their element teams); at most 50 exist
  const hasSnowflake = db().get('SELECT 1 FROM dp_lineage_proposals WHERE origin = ? LIMIT 1', 'snowflake');
  if (hasSnowflake) for (const s of listDiscoverySources()) out.set(s.id, { name: s.name, manage: !!s.permissions?.includes('manage') });
  return out;
}

const listQuery = z
  .object({
    sourceId: z.string().trim().min(1).max(100).optional(),
    status: z.enum(DATA_LINEAGE_PROPOSAL_STATUSES).default('open'),
    origin: z.enum(DATA_LINEAGE_ORIGINS).optional(),
    elementId: z.string().trim().min(1).max(100).optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(LL.page).default(LL.page),
  })
  .strict();

interface Views {
  rows: Map<string, ElementRow>;
  visible: Map<string, boolean>;
  editable: Set<string>;
  productsOf: Map<string, string[]>;
}

/** What the reader may see and change of these elements (bulk). */
function viewsOf(u: AuthUser, elementIds: readonly string[], outputIds: readonly string[]): Views {
  const rows = elementsByIds(elementIds);
  const teams = elementTeamIds([...rows.keys()]);
  const visible = new Map([...rows.keys()].map((id) => [id, elementAccess(u, teams.get(id) ?? []).permissions.length > 0]));
  const ms = membershipsOfElements(outputIds);
  const prods = productsByIds(ms.map((m) => m.product_id));
  const editable = new Set([...prods.values()].filter((p) => productAccess(u, p).permissions.includes('edit')).map((p) => p.id));
  const productsOf = new Map<string, string[]>();
  for (const m of ms) productsOf.set(m.element_id, [...(productsOf.get(m.element_id) ?? []), m.product_id]);
  // outputs in no product: the element's own edit right decides
  for (const id of outputIds)
    if (!productsOf.has(id) && rows.has(id) && elementAccess(u, teams.get(id) ?? []).permissions.includes('edit')) editable.add(`element:${id}`);
  return { rows, visible, editable, productsOf };
}

function toProposal(
  u: AuthUser,
  p: ProposalRow,
  ends: { in: string[]; out: string[] },
  v: Views,
  source: { name: string; manage: boolean },
): DataLineageProposal {
  const end = (id: string): DataLineageEnd | null => {
    const r = v.rows.get(id);
    return r && v.visible.get(id) ? { id: r.id, kind: r.kind, qualifiedName: r.qualified_name, displayName: r.display_name, environment: r.environment } : null;
  };
  const known = (ids: string[]) => ids.filter((id) => v.rows.has(id));
  const ins = known(ends.in);
  const outs = known(ends.out);
  const inputs = ins.map(end).filter((x): x is DataLineageEnd => !!x);
  const outputs = outs.map(end).filter((x): x is DataLineageEnd => !!x);
  const hiddenInputs = ins.length - inputs.length;
  const hiddenOutputs = outs.length - outputs.length;
  // may change the products of the outputs (any of them, as canEditStep), or – outside products – every output
  // as steps.canEditStep: outputs in products – who may change one of those products; else who may change every output
  const inProducts = outs.some((o) => v.productsOf.has(o));
  const mayChange =
    outs.length > 0 &&
    (inProducts ? outs.some((o) => (v.productsOf.get(o) ?? []).some((pid) => v.editable.has(pid))) : outs.every((o) => v.editable.has(`element:${o}`)));
  const cannotAccept: DataLineageProposal['cannotAccept'] = !outs.length
    ? 'noOutputs'
    : hiddenInputs + hiddenOutputs
      ? 'hiddenEnds'
      : !mayChange
        ? 'notAllowed'
        : null;
  const un = parseJson<Unmatched>(p.unmatched, { in: [], out: [], inCount: 0, outCount: 0 });
  const decidable = p.status === 'open' || p.status === 'rejected';
  return {
    id: p.id,
    origin: p.origin,
    sourceId: p.source_id,
    sourceName: source.name,
    key: p.job_key,
    name: p.name,
    kind: p.step_kind,
    tool: p.tool,
    status: p.status,
    changed: !!Number(p.changed),
    inputs,
    outputs,
    hiddenInputs,
    hiddenOutputs,
    unmatchedInputs: un.in,
    unmatchedOutputs: un.out,
    unmatchedInputCount: un.inCount,
    unmatchedOutputCount: un.outCount,
    // the step is named where the reader sees one of its outputs
    stepId: p.step_id && outputs.length ? p.step_id : null,
    lastRun: p.last_run_state && p.last_run_at ? { state: p.last_run_state, at: p.last_run_at, completeAt: p.last_complete_at } : null,
    firstSeenAt: p.first_seen_at,
    lastSeenAt: p.last_seen_at,
    decidedBy: p.decided_by,
    decidedAt: p.decided_at,
    canAccept: decidable && p.status !== 'documented' && !cannotAccept,
    cannotAccept,
    canReject: p.status === 'open' && (source.manage || mayChange),
  };
}

/** The proposals with their ends, as `u` sees them (bulk). */
function viewProposals(u: AuthUser, rows: ProposalRow[], sources: Map<string, { name: string; manage: boolean }>): DataLineageProposal[] {
  const ends = proposalEnds(rows.map((r) => r.id));
  const by = new Map<string, { in: string[]; out: string[] }>();
  for (const e of ends) {
    const cur = by.get(e.proposal_id) ?? { in: [], out: [] };
    cur[e.direction].push(e.element_id);
    by.set(e.proposal_id, cur);
  }
  const v = viewsOf(
    u,
    ends.map((e) => e.element_id),
    ends.filter((e) => e.direction === 'out').map((e) => e.element_id),
  );
  return rows.map((r) => toProposal(u, r, by.get(r.id) ?? { in: [], out: [] }, v, sources.get(r.source_id)!));
}

/** A page of proposals (newest seen first), filtered by source, status (default open), origin or an element they name. */
export function listProposals(query: unknown): DataLineageProposalPage {
  const u = me();
  const q = listQuery.parse(query);
  const sources = visibleSources(u);
  const ids = q.sourceId ? (sources.has(q.sourceId) ? [q.sourceId] : []) : [...sources.keys()];
  if (!ids.length) return { items: [], next: null };
  const after = decodeCursor(q.cursor);
  const where = [`source_id IN (${marks(ids.length)})`, 'status = ?'];
  const args: unknown[] = [...ids, q.status];
  if (q.origin) {
    where.push('origin = ?');
    args.push(q.origin);
  }
  if (q.elementId) {
    where.push('id IN (SELECT proposal_id FROM dp_lineage_proposal_elements WHERE element_id = ?)');
    args.push(q.elementId);
  }
  if (after) {
    where.push('(last_seen_at < ? OR (last_seen_at = ? AND id < ?))');
    args.push(after[0], after[0], after[1]);
  }
  const rows = db().all<ProposalRow>(
    `SELECT * FROM dp_lineage_proposals WHERE ${where.join(' AND ')} ORDER BY last_seen_at DESC, id DESC LIMIT ${q.limit + 1}`,
    ...args,
  );
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return { items: viewProposals(u, page, sources), next: rows.length > q.limit && last ? encodeCursor(last.last_seen_at, last.id) : null };
}

/** The proposal as the reader sees it (404 when they may not see its source). */
function visibleProposal(id: string): { row: ProposalRow; u: AuthUser; source: { name: string; manage: boolean }; view: DataLineageProposal } {
  const u = me();
  const row = proposalRow(id);
  if (!row) throw proposalNotFound(id);
  const sources = visibleSources(u);
  const source = sources.get(row.source_id);
  if (!source) throw proposalNotFound(id);
  return { row, u, source, view: viewProposals(u, [row], sources)[0]! };
}

export function getProposal(id: string): DataLineageProposal {
  return visibleProposal(id).view;
}

/** The product an audit entry of a new step names: the first product of its outputs the person may change. */
function auditProduct(u: AuthUser, outputs: readonly string[]): { id: string; name: string } | null {
  const ms = membershipsOfElements(outputs);
  const prods = productsByIds(ms.map((m) => m.product_id));
  const p = [...prods.values()].find((x) => productAccess(u, x).permissions.includes('edit'));
  return p ? { id: p.id, name: p.name } : null;
}

/** Accepts a proposal: a new step, or – when it was a step already – that step's ends as the tool says now. */
export function acceptProposal(id: string, body: unknown): DataLineageProposal {
  const { row, u, view } = visibleProposal(id);
  const input = dataLineageAcceptInput.parse(body ?? {});
  // who may not decide learns nothing about its state
  if (view.cannotAccept === 'notAllowed') forbid('accept this proposal', 'dataLineageProposal');
  if (row.status === 'documented' || row.status === 'accepted')
    throw new HttpError(409, 'The steps say this already', 'DATA_LINEAGE_PROPOSAL_DECIDED', { status: row.status });
  if (view.cannotAccept === 'noOutputs')
    throw new HttpError(400, 'No element of the catalogue is written by this job – a step needs an output', 'DATA_LINEAGE_NO_OUTPUTS', { name: row.name });
  if (view.cannotAccept === 'hiddenEnds')
    throw new HttpError(403, 'The proposal names elements you may not see – someone who sees them all accepts it', 'DATA_LINEAGE_ENDS_HIDDEN', {
      count: view.hiddenInputs + view.hiddenOutputs,
    });
  const inputs = view.inputs.map((e) => e.id);
  const outputs = view.outputs.map((e) => e.id);
  const now = nowIso();
  const existing = row.step_id ? stepRow(row.step_id) : undefined;
  const product = auditProduct(u, outputs);
  let stepId: string;
  db().tx(() => {
    if (existing) {
      // the step it became changed at the tool: its ends as the tool says now (ends the person may not see stay)
      const ends = db().all<{ element_id: string; direction: 'in' | 'out' }>(
        'SELECT element_id, direction FROM dp_step_elements WHERE step_id = ?',
        existing.id,
      );
      if (
        !canEditStep(
          u,
          ends.filter((e) => e.direction === 'out').map((e) => e.element_id),
        )
      )
        forbid('change this step', 'dataLineageProposal');
      const teams = elementTeamIds(ends.map((e) => e.element_id));
      const hidden = ends.filter((e) => !elementAccess(u, teams.get(e.element_id) ?? []).permissions.length);
      const ins = [...new Set([...inputs, ...hidden.filter((e) => e.direction === 'in').map((e) => e.element_id)])];
      const outs = [...new Set([...outputs, ...hidden.filter((e) => e.direction === 'out').map((e) => e.element_id)])];
      writeEnds(
        existing.id,
        ins.filter((i) => !outs.includes(i)),
        outs,
      );
      db().run('UPDATE dp_steps SET revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?', now, u.username, existing.id);
      stepId = existing.id;
      audit({
        action: 'dataproduct.step_changed',
        entityType: product ? 'data_product' : 'data_element',
        entityId: product?.id ?? outputs[0]!,
        summary: `${product ? `Data product "${product.name}": step` : 'Step'} "${existing.name}" changed from proposal "${row.name}" (${row.origin})`,
        details: { stepId: existing.id, proposalId: row.id, inputs: ins.length, outputs: outs.length },
      });
    } else {
      // the step's right, as when it is written by hand (decision 16), and the step limit of the products of its outputs
      if (!canEditStep(u, outputs)) forbid('accept this proposal', 'dataLineageProposal');
      for (const pid of new Set(membershipsOfElements(outputs).map((m) => m.product_id))) {
        const members = membersOf([pid]).map((m) => m.element_id);
        if (stepsOfElements(members).steps.length >= L.stepsPerPipeline) throw limitReached('stepsPerPipeline', L.stepsPerPipeline);
      }
      stepId = newId(DATA_PRODUCT_ID_PREFIX.step);
      const name = input.name ?? row.name;
      const kind = input.kind ?? row.step_kind;
      const sourceName = view.sourceName;
      db().run(
        `INSERT INTO dp_steps (id, name, step_kind, runner, schedule, description, notes, last_run, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, '', ?, '[]', ?, ?, ?, ?, ?)`,
        stepId,
        name.slice(0, L.name),
        kind,
        json({ kind: 'tool', tool: row.tool.slice(0, L.short), text: row.job_key.slice(0, L.text) }),
        `Proposed by ${sourceName} (${row.origin === 'openlineage' ? 'OpenLineage' : row.origin === 'dbt' ? 'dbt' : 'Snowflake object dependencies'}).`.slice(
          0,
          L.description,
        ),
        row.last_run_state && row.last_run_at
          ? json({ state: row.last_run_state, at: row.last_run_at, completeAt: row.last_complete_at, origin: row.origin, sourceId: row.source_id })
          : null,
        now,
        u.username,
        now,
        u.username,
      );
      writeEnds(stepId, inputs, outputs);
      audit({
        action: 'dataproduct.step_added',
        entityType: product ? 'data_product' : 'data_element',
        entityId: product?.id ?? outputs[0]!,
        summary: `${product ? `Data product "${product.name}": step` : 'Step'} "${name}" (${kind}) added from proposal (${row.origin}) – ${inputs.length} in, ${outputs.length} out`,
        details: { stepId, proposalId: row.id, kind, inputs: inputs.length, outputs: outputs.length },
      });
    }
    db().run(
      "UPDATE dp_lineage_proposals SET status = 'accepted', changed = 0, step_id = ?, decided_by = ?, decided_at = ? WHERE id = ?",
      stepId,
      u.username,
      now,
      row.id,
    );
    audit({
      action: 'datalineage.proposal_accepted',
      entityType: 'data_lineage_source',
      entityId: row.source_id,
      summary: `Proposal "${row.name}" (${row.origin}) accepted as a step`,
      details: { proposalId: row.id, stepId, key: row.job_key.slice(0, 200), changedStep: !!existing },
    });
  });
  return getProposal(row.id);
}

/** Rejects a proposal: it stays rejected until the tool names other datasets for the job. */
export function rejectProposal(id: string): DataLineageProposal {
  const { row, u, source } = visibleProposal(id);
  // who manages the source, or may change what the job writes (as for accepting) – asked before its state is told
  const outputs = proposalEnds([row.id])
    .filter((e) => e.direction === 'out')
    .map((e) => e.element_id);
  if (!source.manage && !canEditStep(u, outputs)) forbid('reject this proposal', 'dataLineageProposal');
  if (row.status !== 'open') throw new HttpError(409, 'Only an open proposal can be rejected', 'DATA_LINEAGE_PROPOSAL_DECIDED', { status: row.status });
  const now = nowIso();
  db().tx(() => {
    // a proposal that had become a step and changed: rejecting keeps the step as it is (and the proposal accepted)
    const status: DataLineageProposalStatus = row.step_id && Number(row.changed) && stepRow(row.step_id) ? 'accepted' : 'rejected';
    db().run('UPDATE dp_lineage_proposals SET status = ?, changed = 0, decided_by = ?, decided_at = ? WHERE id = ?', status, u.username, now, row.id);
    audit({
      action: 'datalineage.proposal_rejected',
      entityType: 'data_lineage_source',
      entityId: row.source_id,
      summary: `Proposal "${row.name}" (${row.origin}) rejected${status === 'accepted' ? ' – the documented step stays as it is' : ''}`,
      details: { proposalId: row.id, key: row.job_key.slice(0, 200) },
    });
  });
  return getProposal(row.id);
}

/**
 * Open proposals between these elements for the lineage picture (proposed against documented edges): their ends among
 * the elements, as plain rows – the caller applies the reader's rights as for steps. One statement per chunk.
 */
export function openProposalsAround(elementIds: readonly string[]): { id: string; name: string; tool: string; inputs: string[]; outputs: string[] }[] {
  const ids = [...new Set(elementIds)];
  if (!ids.length) return [];
  const u = me();
  const sources = visibleSources(u);
  const proposalIds = new Set<string>();
  for (const part of chunks(ids))
    for (const r of db().all<{ proposal_id: string }>(
      `SELECT DISTINCT pe.proposal_id FROM dp_lineage_proposal_elements pe JOIN dp_lineage_proposals p ON p.id = pe.proposal_id
       WHERE p.status = 'open' AND pe.element_id IN (${marks(part.length)})`,
      ...part,
    ))
      proposalIds.add(r.proposal_id);
  if (!proposalIds.size) return [];
  const rows = chunks([...proposalIds]).flatMap((part) =>
    db().all<ProposalRow>(`SELECT * FROM dp_lineage_proposals WHERE id IN (${marks(part.length)}) ORDER BY id`, ...part),
  );
  const visible = rows.filter((r) => sources.has(r.source_id)).slice(0, 200);
  const ends = proposalEnds(visible.map((r) => r.id));
  return visible.map((r) => ({
    id: r.id,
    name: r.name,
    tool: r.tool,
    inputs: ends.filter((e) => e.proposal_id === r.id && e.direction === 'in').map((e) => e.element_id),
    outputs: ends.filter((e) => e.proposal_id === r.id && e.direction === 'out').map((e) => e.element_id),
  }));
}
