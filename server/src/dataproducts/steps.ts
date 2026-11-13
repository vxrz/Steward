import { DATA_PRODUCT_ID_PREFIX, dataStepInput, type AclEntry, type DataStep, type DataStepRunner, type PlatformPermission } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { forbid, me } from '../auth/access.js';
import type { AuthUser } from '../auth/context.js';
import { platformAccess } from '../auth/policy.js';
import { permissionsFor } from '../processes/service.js';
import { canViewCatalogue } from '../records/access.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { elementAccess, productAccess } from './access.js';
import { L, actorName, elementNotFound, json, limitReached, stepNotFound } from './common.js';
import {
  elementTeamIds,
  elementsByIds,
  membersOf,
  membershipsOfElements,
  productsByIds,
  stepRow,
  stepsOfElements,
  stepsWithEnds,
  type StepElementRow,
  type StepRow,
} from './store.js';

/**
 * Steps (ADR 0036 part 9): how data moves between elements – inputs, a runner (an application, platform, process or
 * element of Steward, a connector, or a tool named in text), outputs, a kind, a schedule and ordered transformation
 * notes. Documentation only: Steward runs no step and evaluates no expression.
 *
 * A step is documented where its result lives (decision 16): who may change the products its output elements belong
 * to changes it (an output in no product: who may change those elements). Elements the editor may not see stay on save
 * and are counted, never named. A product's pipeline is the steps that read or write its members.
 */

type StepInput = ReturnType<typeof dataStepInput.parse>;

/** Whether `u` may change a step with these outputs (bulk-friendly: memberships and products read once per call). */
export function canEditStep(u: AuthUser | null, outputs: readonly string[]): boolean {
  if (!u || !outputs.length) return false;
  const ms = membershipsOfElements(outputs);
  if (ms.length) {
    const prods = productsByIds(ms.map((m) => m.product_id));
    return [...prods.values()].some((p) => productAccess(u, p).permissions.includes('edit'));
  }
  const teams = elementTeamIds(outputs);
  return outputs.every((id) => elementAccess(u, teams.get(id) ?? []).permissions.includes('edit'));
}

/** Whether `u` may see a runner that is an item of Steward (memoised per kind and id: a pipeline names few runners). */
function runnerSeen(u: AuthUser | null, r: Exclude<DataStepRunner, { kind: 'tool' }>, seenCache?: Map<string, boolean>): boolean {
  const key = `${r.kind}:${r.kind === 'connector' ? r.platformId : r.id}`;
  const hit = seenCache?.get(key);
  if (hit !== undefined) return hit;
  const platformSeen = (id: string) => {
    const p = db().get<{ id: string; acl: string }>('SELECT id, acl FROM platforms WHERE id = ?', id);
    return !!p && platformAccess(u, { id: p.id, acl: parseJson<AclEntry<PlatformPermission>[]>(p.acl, []) }).permissions.length > 0;
  };
  let seen = false;
  if (r.kind === 'connector') seen = platformSeen(r.platformId);
  else if (r.kind === 'platform') seen = platformSeen(r.id);
  else if (r.kind === 'element') seen = elementsByIds([r.id]).has(r.id) && elementAccess(u, elementTeamIds([r.id]).get(r.id) ?? []).permissions.length > 0;
  else if (r.kind === 'process') seen = !!db().get('SELECT 1 FROM processes WHERE id = ?', r.id) && permissionsFor(r.id).includes('view');
  else if (r.kind === 'application') {
    const a = db().get<{ id: string; owners: string }>('SELECT id, owners FROM applications WHERE id = ?', r.id);
    seen = !!a && canViewCatalogue(u, { kind: 'application', id: a.id, owners: parseJson<string[]>(a.owners, []) });
  }
  seenCache?.set(key, seen);
  return seen;
}

/** The runner as `u` may see it (an item they may not see: hidden, its id not handed out – process ids carry names). */
function runnerOf(
  u: AuthUser | null,
  raw: string | null,
  visibleElements: Map<string, boolean>,
  seenCache?: Map<string, boolean>,
): { runner: DataStepRunner | null; hidden: boolean } {
  const r = parseJson<DataStepRunner | null>(raw, null);
  if (!r) return { runner: null, hidden: false };
  if (r.kind === 'tool') return { runner: r, hidden: false };
  const seen = (r.kind === 'element' && !!visibleElements.get(r.id)) || runnerSeen(u, r, seenCache);
  return seen ? { runner: r, hidden: false } : { runner: null, hidden: true };
}

/** What the views of many steps share: the elements' owning teams, the products of the outputs, the runners seen. */
interface StepContext {
  teams: Map<string, string[]>;
  productsOf: Map<string, string[]>;
  editable: Set<string>;
  runners: Map<string, boolean>;
}

function stepContext(u: AuthUser | null, ends: StepElementRow[]): StepContext {
  const teams = elementTeamIds([...new Set(ends.map((e) => e.element_id))]);
  // which steps `u` may change: by the products of their outputs (read once for all steps)
  const outputs = [...new Set(ends.filter((e) => e.direction === 'out').map((e) => e.element_id))];
  const ms = membershipsOfElements(outputs);
  const prods = productsByIds(ms.map((m) => m.product_id));
  const editable = new Set([...prods.values()].filter((p) => productAccess(u, p).permissions.includes('edit')).map((p) => p.id));
  const productsOf = new Map<string, string[]>();
  for (const m of ms) productsOf.set(m.element_id, [...(productsOf.get(m.element_id) ?? []), m.product_id]);
  return { teams, productsOf, editable, runners: new Map() };
}

/**
 * The steps as `u` sees them: element ids they may see (or that are members of the product, `members`, decision 15),
 * the rest counted. `ctx`: shared by the products of an export (read once for all their steps).
 */
function stepViews(u: AuthUser | null, steps: StepRow[], ends: StepElementRow[], members: ReadonlySet<string>, ctx = stepContext(u, ends)): DataStep[] {
  const { teams, productsOf, editable } = ctx;
  const ids = [...new Set(ends.map((e) => e.element_id))];
  const visible = new Map(ids.map((id) => [id, members.has(id) || elementAccess(u, teams.get(id) ?? []).permissions.length > 0]));
  const by = new Map<string, StepElementRow[]>();
  for (const e of ends) by.set(e.step_id, [...(by.get(e.step_id) ?? []), e]);
  return steps.map((s) => {
    const mine = by.get(s.id) ?? [];
    const ins = mine.filter((e) => e.direction === 'in').map((e) => e.element_id);
    const outs = mine.filter((e) => e.direction === 'out').map((e) => e.element_id);
    const inProducts = outs.flatMap((o) => productsOf.get(o) ?? []);
    const canEdit = inProducts.length
      ? inProducts.some((p) => editable.has(p))
      : outs.length > 0 && outs.every((o) => elementAccess(u, teams.get(o) ?? []).permissions.includes('edit'));
    const { runner, hidden } = runnerOf(u, s.runner, visible, ctx.runners);
    return {
      id: s.id,
      name: s.name,
      kind: s.step_kind,
      runner,
      runnerHidden: hidden,
      schedule: s.schedule,
      description: s.description,
      notes: parseJson(s.notes, []),
      inputs: ins.filter((id) => visible.get(id)),
      outputs: outs.filter((id) => visible.get(id)),
      hiddenInputs: ins.filter((id) => !visible.get(id)).length,
      hiddenOutputs: outs.filter((id) => !visible.get(id)).length,
      canEdit,
      // 0.24.0: the last run a lineage source reported (OpenLineage, dbt run results)
      lastRun: parseJson<DataStep['lastRun']>(s.last_run, null),
      revision: s.revision,
      createdAt: s.created_at,
      createdBy: s.created_by,
      updatedAt: s.updated_at,
      updatedBy: s.updated_by,
    };
  });
}

const membersSet = (productId: string) => new Set(membersOf([productId]).map((m) => m.element_id));

/** The pipeline of a product: the steps that read or write its members. */
export function productSteps(productId: string): DataStep[] {
  const members = membersSet(productId);
  const { steps, ends } = stepsOfElements([...members]);
  return stepViews(me(), steps, ends, members);
}

/**
 * The pipelines of many products at once (an export): their members, steps, ends, owning teams and runners read once
 * for all of them – a fixed number of statements however many products there are.
 */
export function productsSteps(productIds: readonly string[]): Map<string, DataStep[]> {
  const u = me();
  const members = new Map<string, Set<string>>(productIds.map((id) => [id, new Set()]));
  for (const m of membersOf(productIds)) members.get(m.product_id)?.add(m.element_id);
  const { steps, ends } = stepsOfElements([...new Set([...members.values()].flatMap((x) => [...x]))]);
  const ctx = stepContext(u, ends);
  const endsOf = new Map<string, StepElementRow[]>();
  const stepsOf = new Map<string, string[]>();
  for (const e of ends) {
    endsOf.set(e.step_id, [...(endsOf.get(e.step_id) ?? []), e]);
    stepsOf.set(e.element_id, [...(stepsOf.get(e.element_id) ?? []), e.step_id]);
  }
  const order = new Map(steps.map((s, i) => [s.id, i]));
  const out = new Map<string, DataStep[]>();
  for (const [id, mine] of members) {
    const ids = new Set([...mine].flatMap((e) => stepsOf.get(e) ?? []));
    const own = [...ids].sort((a, b) => order.get(a)! - order.get(b)!).map((x) => steps[order.get(x)!]!);
    out.set(
      id,
      stepViews(
        u,
        own,
        own.flatMap((x) => endsOf.get(x.id) ?? []),
        mine,
        ctx,
      ),
    );
  }
  return out;
}

/** Checks a step's ends: every element exists and is one the editor may see (or a member of the product), never both in and out. */
function checkEnds(productId: string, input: StepInput, keptHidden: Set<string>): void {
  const u = me();
  const ids = [...new Set([...input.inputs, ...input.outputs])];
  const rows = elementsByIds(ids);
  const teams = elementTeamIds(ids);
  const members = new Set(membersOf([productId]).map((m) => m.element_id));
  for (const id of ids)
    if (!rows.has(id) || (!keptHidden.has(id) && !members.has(id) && !elementAccess(u, teams.get(id) ?? []).permissions.length)) throw elementNotFound(id);
  const both = input.inputs.find((id) => input.outputs.includes(id));
  if (both) throw new HttpError(400, 'An element is either read or written by a step, not both', 'DATA_STEP_INVALID', { context: 'inAndOut' });
  // a step is documented where its result lives: one of its outputs is part of this product
  if (!input.outputs.some((id) => members.has(id)))
    throw new HttpError(400, 'A step of this product writes at least one of its elements', 'DATA_STEP_INVALID', { context: 'noOutputInProduct' });
  if (input.runner && input.runner.kind !== 'tool') {
    const ref = input.runner.kind === 'connector' ? input.runner.platformId : input.runner.id;
    const table = { application: 'applications', platform: 'platforms', connector: 'platforms', process: 'processes', element: 'dp_elements' }[
      input.runner.kind
    ];
    if (!db().get(`SELECT 1 FROM ${table} WHERE id = ?`, ref)) throw new HttpError(400, 'The runner is not known', 'DATA_STEP_INVALID', { context: 'runner' });
  }
}

export function writeEnds(stepId: string, inputs: string[], outputs: string[]): void {
  db().run('DELETE FROM dp_step_elements WHERE step_id = ?', stepId);
  for (const e of new Set(inputs)) db().run("INSERT INTO dp_step_elements (step_id, element_id, direction) VALUES (?, ?, 'in')", stepId, e);
  for (const e of new Set(outputs)) db().run("INSERT INTO dp_step_elements (step_id, element_id, direction) VALUES (?, ?, 'out')", stepId, e);
}

export function createStep(productId: string, productName: string, body: unknown): DataStep {
  const input = dataStepInput.parse(body);
  checkEnds(productId, input, new Set());
  const members = membersOf([productId]).map((m) => m.element_id);
  if (stepsOfElements(members).steps.length >= L.stepsPerPipeline) throw limitReached('stepsPerPipeline', L.stepsPerPipeline);
  const id = newId(DATA_PRODUCT_ID_PREFIX.step);
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO dp_steps (id, name, step_kind, runner, schedule, description, notes, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.kind,
      input.runner ? json(input.runner) : null,
      input.schedule,
      input.description,
      json(input.notes),
      now,
      actorName(),
      now,
      actorName(),
    );
    writeEnds(id, input.inputs, input.outputs);
    audit({
      action: 'dataproduct.step_added',
      entityType: 'data_product',
      entityId: productId,
      summary: `Data product "${productName}": step "${input.name}" (${input.kind}) added – ${input.inputs.length} in, ${input.outputs.length} out`,
      details: { stepId: id, kind: input.kind, inputs: input.inputs.length, outputs: input.outputs.length },
    });
  });
  const { steps, ends } = stepsWithEnds([id]);
  return stepViews(me(), steps, ends, membersSet(productId))[0]!;
}

/** A step of this product's pipeline that the caller may change. */
function editableStep(productId: string, stepId: string): { row: StepRow; ends: StepElementRow[] } {
  const row = stepRow(stepId);
  if (!row) throw stepNotFound(stepId);
  const members = new Set(membersOf([productId]).map((m) => m.element_id));
  const ends = db().all<StepElementRow>('SELECT * FROM dp_step_elements WHERE step_id = ?', row.id);
  if (!ends.some((e) => members.has(e.element_id))) throw stepNotFound(stepId);
  if (
    !canEditStep(
      me(),
      ends.filter((e) => e.direction === 'out').map((e) => e.element_id),
    )
  )
    forbid('change this step', 'dataProducts');
  return { row, ends };
}

/** Elements of a step that `u` may not see (they stay on save, as they were). */
function hiddenEnds(u: AuthUser | null, ends: StepElementRow[], productId: string): StepElementRow[] {
  const ids = ends.map((e) => e.element_id);
  const teams = elementTeamIds(ids);
  const members = new Set(membersOf([productId]).map((m) => m.element_id));
  return ends.filter((e) => !members.has(e.element_id) && !elementAccess(u, teams.get(e.element_id) ?? []).permissions.length);
}

export function updateStep(productId: string, productName: string, stepId: string, body: unknown): DataStep {
  const { row, ends } = editableStep(productId, stepId);
  const input = dataStepInput.parse(body);
  const hidden = hiddenEnds(me(), ends, productId);
  const inputs = [...new Set([...input.inputs, ...hidden.filter((e) => e.direction === 'in').map((e) => e.element_id)])];
  const outputs = [...new Set([...input.outputs, ...hidden.filter((e) => e.direction === 'out').map((e) => e.element_id)])];
  if (inputs.length > L.stepEnds || outputs.length > L.stepEnds) throw limitReached('stepEnds', L.stepEnds);
  checkEnds(productId, { ...input, inputs, outputs }, new Set(hidden.map((e) => e.element_id)));
  // a runner the editor may not see is not in their form: without a runner of their own it stays as it was
  const keepRunner = !input.runner && row.runner !== null && runnerOf(me(), row.runner, new Map()).hidden;
  const runner = input.runner ? json(input.runner) : keepRunner ? row.runner : null;
  db().tx(() => {
    db().run(
      `UPDATE dp_steps SET name = ?, step_kind = ?, runner = ?, schedule = ?, description = ?, notes = ?, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?`,
      input.name,
      input.kind,
      runner,
      input.schedule,
      input.description,
      json(input.notes),
      nowIso(),
      actorName(),
      row.id,
    );
    writeEnds(row.id, inputs, outputs);
    audit({
      action: 'dataproduct.step_changed',
      entityType: 'data_product',
      entityId: productId,
      summary: `Data product "${productName}": step "${input.name}" changed`,
      details: { stepId: row.id, kind: input.kind, inputs: inputs.length, outputs: outputs.length },
    });
  });
  const r = stepsWithEnds([row.id]);
  return stepViews(me(), r.steps, r.ends, membersSet(productId))[0]!;
}

export function deleteStep(productId: string, productName: string, stepId: string): void {
  const { row } = editableStep(productId, stepId);
  db().tx(() => {
    db().run('DELETE FROM dp_step_elements WHERE step_id = ?', row.id);
    db().run('DELETE FROM dp_check_links WHERE step_id = ?', row.id);
    // 0.24.0: a proposal that became this step, or that it documented, waits for a decision again
    db().run("UPDATE dp_lineage_proposals SET status = 'open', step_id = NULL, changed = 0 WHERE step_id = ?", row.id);
    db().run('DELETE FROM dp_steps WHERE id = ?', row.id);
    audit({
      action: 'dataproduct.step_removed',
      entityType: 'data_product',
      entityId: productId,
      summary: `Data product "${productName}": step "${row.name}" removed`,
      details: { stepId: row.id },
    });
  });
}
