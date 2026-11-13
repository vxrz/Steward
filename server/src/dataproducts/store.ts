import {
  DATA_ELEMENT_KIND_DEFS,
  DATA_PRODUCT_ID_PREFIX,
  DATA_PRODUCT_LIMITS,
  elementNameNorm,
  elementShortName,
  type DataCheckLinkOrigin,
  type DataCheckPurpose,
  type DataElementKind,
  type DataElementSource,
  type DataMemberRole,
  type DataPortDirection,
  type DataStepKind,
  type DataStepsAround,
  type DiscoveredElement,
  type DiscoveryUpsertResult,
} from '@sm/shared';
import { db } from '../db.js';
import { newId, nowIso, parseJson, sha256 } from '../util.js';

/**
 * The data products module's storage (ADR 0036 part 18): rows and bulk reads the work packages share. No rights are
 * checked here – callers decide what the reader may see (access.ts) – and nothing is audited; the service (service.ts)
 * and the discovery job do both. Reads take lists of ids and answer with one statement per chunk of 500, never one
 * per item, so a page costs a fixed number of statements whatever its size.
 */

const CHUNK = 500;
export const chunks = <T>(xs: readonly T[], n = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};
export const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Rows of `sql` (which ends with `IN (`…`)` filled by `ids`), read in chunks. */
export function inChunks<T>(sql: (marks: string) => string, ids: readonly string[], ...before: unknown[]): T[] {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return [];
  return chunks(uniq).flatMap((part) => db().all<T>(sql(marks(part.length)), ...before, ...part));
}

// ---------- rows ----------

export interface DomainRow {
  id: string;
  key: string;
  name: string;
  description: string;
  parent_id: string | null;
  colour: string | null;
  owners: string;
  revision: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface ObjectRow {
  id: string;
  key: string;
  name: string;
  name_norm: string;
  definition: string;
  synonyms: string;
  domain_id: string | null;
  lifecycle: string;
  lifecycle_dates: string;
  classification: string | null;
  personal_data: string;
  categories: string;
  special_categories: string;
  subjects: string;
  legal_basis: string | null;
  legal_note: string;
  purposes: string;
  retention: string;
  deletion_rule: string;
  regulatory_flags: string;
  attributes: string;
  owner: string | null;
  stewards: string;
  custodians: string;
  external_refs: string;
  /** 0.25.0 (GDPR Art. 30(1)(e) and (g)): transfers to third countries (JSON) and the measures' reference (JSON) */
  transfers?: string;
  toms?: string | null;
  revision: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface ProductRow {
  id: string;
  key: string;
  name: string;
  name_norm: string;
  description: string;
  purpose: string;
  type: string | null;
  domain_id: string | null;
  owners: string;
  support: string;
  criticality: string | null;
  tier: number | null;
  classification: string | null;
  lifecycle: string;
  lifecycle_dates: string;
  sunset_date: string | null;
  successor_id: string | null;
  version: string;
  value_statement: string;
  value_tier: string | null;
  value_amount: number | null;
  value_currency: string | null;
  rating_reason: string;
  tags: string;
  external_refs: string;
  /** 0.25.0 (GDPR Art. 30(1)(e) and (g)): transfers to third countries (JSON) and the measures' reference (JSON) */
  transfers?: string;
  toms?: string | null;
  revision: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface RatingRow {
  kind: 'product' | 'object';
  item_id: string;
  dimension: string;
  level: string;
  justification: string;
  rated_at: string;
  rated_by: string;
  needs_rerating: number;
  previous_label: string | null;
}

export interface ProductEnvironmentRow {
  product_id: string;
  environment: string;
  state: string;
  monitor_id: string | null;
  updated_at: string;
  updated_by: string;
}

export interface ElementRow {
  id: string;
  /** '' : no platform */
  platform_id: string;
  kind: DataElementKind;
  qualified_name: string;
  name_norm: string;
  display_name: string;
  environment: string;
  parent_id: string | null;
  layer: string;
  description: string;
  type_label: string;
  source: DataElementSource;
  discovery_source_id: string | null;
  external_id: string | null;
  ol_namespace: string | null;
  ol_name: string | null;
  application_id: string | null;
  component_id: string | null;
  plant_sink: string | null;
  api_ref: string | null;
  flags: string;
  tech_hash: string | null;
  missing_since: string | null;
  revision: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface MemberRow {
  product_id: string;
  element_id: string;
  role: DataMemberRole;
  include_descendants: number;
  note: string;
  added_by: string;
  added_at: string;
}

export interface PortRow {
  id: string;
  product_id: string;
  direction: DataPortDirection;
  name: string;
  port_type: string;
  version: string;
  description: string;
  lifecycle: string;
  lifecycle_dates: string;
  sunset_date: string | null;
  successor_id: string | null;
  objectives: string;
  source_kind: 'port' | 'element' | 'text' | null;
  source_port_id: string | null;
  source_element_id: string | null;
  source_text: string;
  position: number;
  revision: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface BindingRow {
  id: string;
  port_id: string;
  environment: string;
  contract_id: string | null;
  contract_version: number | null;
  contract_server: string | null;
  objectives: string;
  updated_at: string;
  updated_by: string;
}

/** A binding with the elements it exposes (bindingsOf). */
export interface BindingWithElements extends BindingRow {
  elementIds: string[];
}

export interface ConsumerRow {
  id: string;
  port_id: string;
  consumer_kind: string;
  ref_id: string | null;
  consumer_subjects: string;
  consumer_text: string;
  purpose: string;
  since: string | null;
  end_date: string | null;
  agreement: string | null;
  contacts: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface StepRow {
  id: string;
  name: string;
  step_kind: DataStepKind;
  runner: string | null;
  schedule: string;
  description: string;
  notes: string;
  last_run: string | null;
  revision: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface StepElementRow {
  step_id: string;
  element_id: string;
  direction: 'in' | 'out';
}

export interface CheckLinkRow {
  id: string;
  element_id: string | null;
  step_id: string | null;
  monitor_id: string;
  check_id: string;
  purpose: DataCheckPurpose;
  origin: DataCheckLinkOrigin;
  created_at: string;
  created_by: string;
}

export interface DiscoverySourceRow {
  id: string;
  name: string;
  platform_id: string;
  scope: string;
  include_prefixes: string;
  exclude_prefixes: string;
  environment_rules: string;
  mode: string | null;
  identity_id: string | null;
  element_team_ids: string;
  interval_minutes: number;
  enabled: number;
  run_as: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  failing_since: string | null;
  revision: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

// ---------- single rows ----------

export const domainRow = (id: string): DomainRow | undefined => db().get<DomainRow>('SELECT * FROM dp_domains WHERE id = ?', id);
export const objectRow = (id: string): ObjectRow | undefined => db().get<ObjectRow>('SELECT * FROM dp_objects WHERE id = ?', id);
export const productRow = (id: string): ProductRow | undefined => db().get<ProductRow>('SELECT * FROM dp_products WHERE id = ?', id);
export const elementRow = (id: string): ElementRow | undefined => db().get<ElementRow>('SELECT * FROM dp_elements WHERE id = ?', id);
export const portRow = (id: string): PortRow | undefined => db().get<PortRow>('SELECT * FROM dp_ports WHERE id = ?', id);
export const stepRow = (id: string): StepRow | undefined => db().get<StepRow>('SELECT * FROM dp_steps WHERE id = ?', id);
export const discoverySourceRow = (id: string): DiscoverySourceRow | undefined =>
  db().get<DiscoverySourceRow>('SELECT * FROM dp_discovery_sources WHERE id = ?', id);

// ---------- bulk reads ----------

/** Elements by id (missing ids are left out). */
export function elementsByIds(ids: readonly string[]): Map<string, ElementRow> {
  return new Map(inChunks<ElementRow>((m) => `SELECT * FROM dp_elements WHERE id IN (${m})`, ids).map((r) => [r.id, r]));
}

export function productsByIds(ids: readonly string[]): Map<string, ProductRow> {
  return new Map(inChunks<ProductRow>((m) => `SELECT * FROM dp_products WHERE id IN (${m})`, ids).map((r) => [r.id, r]));
}

export function objectsByIds(ids: readonly string[]): Map<string, ObjectRow> {
  return new Map(inChunks<ObjectRow>((m) => `SELECT * FROM dp_objects WHERE id IN (${m})`, ids).map((r) => [r.id, r]));
}

/** The members of these products (all roles, every environment), in the order they were added. */
export function membersOf(productIds: readonly string[]): MemberRow[] {
  return inChunks<MemberRow>((m) => `SELECT * FROM dp_members WHERE product_id IN (${m}) ORDER BY added_at, element_id`, productIds);
}

/** The memberships of these elements: which products they are part of, with their role. */
export function membershipsOfElements(elementIds: readonly string[]): MemberRow[] {
  return inChunks<MemberRow>((m) => `SELECT * FROM dp_members WHERE element_id IN (${m})`, elementIds);
}

/** The ports of these products, in their order. */
export function portsOf(productIds: readonly string[]): PortRow[] {
  return inChunks<PortRow>((m) => `SELECT * FROM dp_ports WHERE product_id IN (${m}) ORDER BY product_id, position, name, id`, productIds);
}

/** The bindings of these ports with the elements each exposes (two statements per chunk). */
export function bindingsOf(portIds: readonly string[]): BindingWithElements[] {
  const rows = inChunks<BindingRow>((m) => `SELECT * FROM dp_port_bindings WHERE port_id IN (${m}) ORDER BY port_id, environment`, portIds);
  const els = inChunks<{ binding_id: string; element_id: string }>(
    (m) => `SELECT binding_id, element_id FROM dp_port_elements WHERE binding_id IN (${m}) ORDER BY element_id`,
    rows.map((r) => r.id),
  );
  const by = new Map<string, string[]>();
  for (const e of els) by.set(e.binding_id, [...(by.get(e.binding_id) ?? []), e.element_id]);
  return rows.map((r) => ({ ...r, elementIds: by.get(r.id) ?? [] }));
}

/** Registered consumers of these ports. */
export function consumersOf(portIds: readonly string[]): ConsumerRow[] {
  return inChunks<ConsumerRow>((m) => `SELECT * FROM dp_consumers WHERE port_id IN (${m}) ORDER BY port_id, created_at, id`, portIds);
}

/** Input ports (of any product) that name these output ports as their source: the consuming products. */
export function consumingPorts(outputPortIds: readonly string[]): PortRow[] {
  return inChunks<PortRow>((m) => `SELECT * FROM dp_ports WHERE source_port_id IN (${m})`, outputPortIds);
}

/** Data objects declared on these ports. */
export function portObjectsOf(portIds: readonly string[]): { port_id: string; object_id: string }[] {
  return inChunks((m) => `SELECT port_id, object_id FROM dp_port_objects WHERE port_id IN (${m})`, portIds);
}

/** Which data objects these elements implement. */
export function objectsOfElements(elementIds: readonly string[]): { object_id: string; element_id: string; note: string }[] {
  return inChunks((m) => `SELECT object_id, element_id, note FROM dp_object_elements WHERE element_id IN (${m})`, elementIds);
}

/** CIA ratings of these products or data objects. */
export function ratingsOf(kind: 'product' | 'object', ids: readonly string[]): RatingRow[] {
  return inChunks<RatingRow>((m) => `SELECT * FROM dp_ratings WHERE kind = ? AND item_id IN (${m})`, ids, kind);
}

/** Environments of these products. */
export function environmentsOf(productIds: readonly string[]): ProductEnvironmentRow[] {
  return inChunks<ProductEnvironmentRow>((m) => `SELECT * FROM dp_product_environments WHERE product_id IN (${m})`, productIds);
}

/** Check links of these elements (and steps). */
export function checkLinksOf(elementIds: readonly string[], stepIds: readonly string[] = []): CheckLinkRow[] {
  return [
    ...inChunks<CheckLinkRow>((m) => `SELECT * FROM dp_check_links WHERE element_id IN (${m}) ORDER BY created_at, id`, elementIds),
    ...inChunks<CheckLinkRow>((m) => `SELECT * FROM dp_check_links WHERE step_id IN (${m}) ORDER BY created_at, id`, stepIds),
  ];
}

/** Check links that name a check of these monitors (a deleted check, a monitor page). */
export function checkLinksOfMonitors(monitorIds: readonly string[]): CheckLinkRow[] {
  return inChunks<CheckLinkRow>((m) => `SELECT * FROM dp_check_links WHERE monitor_id IN (${m})`, monitorIds);
}

/** Adds a check link (WP3: made by Create monitor, linked by a person, found from a check's fields); returns its id. */
export function addCheckLink(l: Omit<CheckLinkRow, 'id' | 'created_at'> & { created_at?: string }): string {
  const id = newId(DATA_PRODUCT_ID_PREFIX.checkLink);
  db().run(
    'INSERT INTO dp_check_links (id, element_id, step_id, monitor_id, check_id, purpose, origin, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    l.element_id,
    l.step_id,
    l.monitor_id,
    l.check_id,
    l.purpose,
    l.origin,
    l.created_at ?? nowIso(),
    l.created_by,
  );
  return id;
}

/**
 * Removes check links whose monitor was deleted (the monitors area does not know this module; health and the checks
 * view already ignore them). Run by the job `data-products`; returns how many went.
 */
export function pruneCheckLinks(): number {
  return db().run('DELETE FROM dp_check_links WHERE NOT EXISTS (SELECT 1 FROM monitors m WHERE m.id = dp_check_links.monitor_id)').changes;
}

export function removeCheckLink(id: string): boolean {
  return db().run('DELETE FROM dp_check_links WHERE id = ?', id).changes > 0;
}

/** Steps touching these elements (as input or output), with all their ends. */
export function stepsOfElements(elementIds: readonly string[]): { steps: StepRow[]; ends: StepElementRow[] } {
  const stepIds = [
    ...new Set(
      inChunks<{ step_id: string }>((m) => `SELECT DISTINCT step_id FROM dp_step_elements WHERE element_id IN (${m})`, elementIds).map((r) => r.step_id),
    ),
  ];
  return stepsWithEnds(stepIds);
}

/** Steps by id with all their ends. */
export function stepsWithEnds(stepIds: readonly string[]): { steps: StepRow[]; ends: StepElementRow[] } {
  const steps = inChunks<StepRow>((m) => `SELECT * FROM dp_steps WHERE id IN (${m}) ORDER BY name, id`, stepIds);
  const ends = inChunks<StepElementRow>((m) => `SELECT * FROM dp_step_elements WHERE step_id IN (${m}) ORDER BY step_id, direction, element_id`, stepIds);
  return { steps, ends };
}

/**
 * The steps within `depth` steps upstream and downstream of these elements (part 9, lineage): breadth-first, one
 * statement per level and direction (by the index on element and direction), at most `maxNodes` elements (the rest
 * counted per direction). Rights are the caller's: hidden elements stay in the graph, counted not named, so the
 * picture stays true.
 */
export function stepsAround(
  elementIds: readonly string[],
  depth: number = DATA_PRODUCT_LIMITS.lineageDepth,
  maxNodes: number = DATA_PRODUCT_LIMITS.lineageNodes,
): DataStepsAround {
  const d = Math.max(0, Math.min(depth, DATA_PRODUCT_LIMITS.lineageDepth));
  const distance = new Map<string, number>(elementIds.map((id) => [id, 0]));
  const stepIds = new Set<string>();
  const truncated = { upstream: 0, downstream: 0 };
  for (const dir of ['up', 'down'] as const) {
    let frontier = [...elementIds];
    for (let level = 1; level <= d && frontier.length; level++) {
      // up: steps that write the frontier (it is their output); their inputs are one level further up
      const near = inChunks<StepElementRow>(
        (m) => `SELECT * FROM dp_step_elements WHERE direction = ? AND element_id IN (${m})`,
        frontier,
        dir === 'up' ? 'out' : 'in',
      );
      const ids = [...new Set(near.map((r) => r.step_id))].filter((id) => !stepIds.has(id));
      if (!ids.length) break;
      for (const id of ids) stepIds.add(id);
      const far = inChunks<StepElementRow>((m) => `SELECT * FROM dp_step_elements WHERE direction = ? AND step_id IN (${m})`, ids, dir === 'up' ? 'in' : 'out');
      const next: string[] = [];
      for (const r of far) {
        if (distance.has(r.element_id)) continue;
        if (distance.size >= maxNodes) {
          if (dir === 'up') truncated.upstream++;
          else truncated.downstream++;
          continue;
        }
        distance.set(r.element_id, dir === 'up' ? -level : level);
        next.push(r.element_id);
      }
      frontier = next;
    }
  }
  const { steps, ends } = stepsWithEnds([...stepIds]);
  const byStep = new Map<string, StepElementRow[]>();
  for (const e of ends) byStep.set(e.step_id, [...(byStep.get(e.step_id) ?? []), e]);
  return {
    steps: steps.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.step_kind,
      inputs: (byStep.get(s.id) ?? []).filter((e) => e.direction === 'in').map((e) => e.element_id),
      outputs: (byStep.get(s.id) ?? []).filter((e) => e.direction === 'out').map((e) => e.element_id),
    })),
    elements: [...distance].map(([id, dist]) => ({ id, distance: dist })),
    truncated,
  };
}

/** The elements below these (children of projects and bundles), one level per statement, at most `max`. */
export function descendantsOf(elementIds: readonly string[], max: number = DATA_PRODUCT_LIMITS.bundleTopics): string[] {
  const seen = new Set<string>(elementIds);
  const out: string[] = [];
  let frontier = [...elementIds];
  for (let level = 0; level < 4 && frontier.length && out.length < max; level++) {
    const rows = inChunks<{ id: string }>((m) => `SELECT id FROM dp_elements WHERE parent_id IN (${m}) ORDER BY name_norm, id`, frontier);
    frontier = [];
    for (const r of rows) {
      if (seen.has(r.id) || out.length >= max) continue;
      seen.add(r.id);
      out.push(r.id);
      frontier.push(r.id);
    }
  }
  return out;
}

/** The owning teams of these elements (team ids by element; elements without any are missing from the map). */
export function elementTeamIds(elementIds: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of inChunks<{ resource_id: string; team_id: string }>(
    (m) => `SELECT resource_id, team_id FROM resource_teams WHERE kind = 'data_element' AND resource_id IN (${m})`,
    elementIds,
  ))
    out.set(r.resource_id, [...(out.get(r.resource_id) ?? []), r.team_id]);
  return out;
}

// ---------- environments and monitors ----------

/** The product's monitor in an environment (WP3, Create monitor); null removes it. Adds the environment if it is missing. */
export function setProductMonitor(productId: string, environment: string, monitorId: string | null, actor: string): void {
  const now = nowIso();
  db().run(
    `INSERT INTO dp_product_environments (product_id, environment, state, monitor_id, updated_at, updated_by) VALUES (?, ?, 'planned', ?, ?, ?)
     ON CONFLICT (product_id, environment) DO UPDATE SET monitor_id = excluded.monitor_id, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    productId,
    environment,
    monitorId,
    now,
    actor,
  );
}

// ---------- notice bookkeeping (WP4) ----------

/** Whether a notice was sent (kind, item, key): notices go once. */
export const noticeSent = (kind: string, itemId: string, key: string): boolean =>
  !!db().get('SELECT 1 FROM dp_notices WHERE kind = ? AND item_id = ? AND notice_key = ?', kind, itemId, key);

export function markNoticeSent(kind: string, itemId: string, key: string): void {
  db().run('INSERT INTO dp_notices (kind, item_id, notice_key, sent_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', kind, itemId, key, nowIso());
}

export function forgetNotices(kind: string, itemId: string): void {
  db().run('DELETE FROM dp_notices WHERE kind = ? AND item_id = ?', kind, itemId);
}

// ---------- discovery (WP2) ----------

/** The technical fields of a discovered element, hashed: an unchanged read writes only the readout. */
const techHash = (e: DiscoveredElement, parentId: string | null): string =>
  sha256(
    JSON.stringify([
      e.kind,
      e.qualifiedName.trim(),
      e.displayName ?? '',
      parentId,
      e.externalId ?? null,
      e.flags ?? {},
      e.olNamespace ?? null,
      e.olName ?? null,
    ]),
  );

const readoutJson = (r: DiscoveredElement['readout']): string | null => {
  if (!r) return null;
  const s = JSON.stringify(r);
  return s.length <= DATA_PRODUCT_LIMITS.readoutBytes ? s : null;
};

/** Rows written per multi-row statement (a whole batch of discovery; well below the bind parameter limits of SQLite and PostgreSQL). */
const ROWS_PER_INSERT = 250;

/** INSERT of many rows in statements of ROWS_PER_INSERT (`head` names the table and columns; `tail` an ON CONFLICT). */
function insertRows(head: string, rows: readonly unknown[][], tail = ''): void {
  if (!rows.length) return;
  const one = `(${marks(rows[0]!.length)})`;
  for (const part of chunks(rows, ROWS_PER_INSERT)) db().run(`${head} VALUES ${part.map(() => one).join(', ')}${tail ? ` ${tail}` : ''}`, ...part.flat());
}

/**
 * Writes one batch of a discovery read (part 5) in one transaction: new elements are added (source `discovered`, the
 * source's owning teams for elements, else the platform's); existing ones get their technical fields – qualified
 * name, kind flags, external id, parent, OpenLineage dataset – and their readout; people's fields (description, layer,
 * owner application, data objects, links) are never overwritten. A known external id under a new name is a rename
 * (`renamed` lists them for the audit entry of the run). An element found again loses its missing mark. Batches of at
 * most 500 (discovery writes 250: DATA_DISCOVERY_LIMITS.batch), parents before children (a parent in the same batch is
 * found). The instance's element limit is kept:
 * beyond it nothing is added (`skipped`). New elements, their owning teams and the readouts are written with multi-row
 * statements, so a batch costs a few dozen statements, not three per element (WP2: 50,000 elements within the event
 * loop's budget on PostgreSQL too).
 */
export function upsertDiscovered(
  sourceId: string,
  batch: readonly DiscoveredElement[],
  actor = 'system',
): DiscoveryUpsertResult & { renames: { id: string; from: string; to: string }[] } {
  const src = discoverySourceRow(sourceId);
  if (!src) throw new Error(`discovery source ${sourceId} not found`);
  const platformId = src.platform_id;
  const result: DiscoveryUpsertResult & { renames: { id: string; from: string; to: string }[] } = {
    added: 0,
    changed: 0,
    renamed: 0,
    unchanged: 0,
    readouts: 0,
    skipped: 0,
    seen: [],
    renames: [],
  };
  if (!batch.length) return result;
  const d = db();
  const now = nowIso();
  const keyOf = (kind: string, env: string, norm: string) => `${kind}\u0000${env}\u0000${norm}`;
  type Known = Pick<
    ElementRow,
    | 'id'
    | 'kind'
    | 'environment'
    | 'name_norm'
    | 'qualified_name'
    | 'display_name'
    | 'external_id'
    | 'tech_hash'
    | 'missing_since'
    | 'parent_id'
    | 'discovery_source_id'
  >;
  const cols = 'id, kind, environment, name_norm, qualified_name, display_name, external_id, tech_hash, missing_since, parent_id, discovery_source_id';
  d.tx(() => {
    // what exists: by name (the batch and its parents) and by external id (renames)
    const names = new Set<string>();
    const kinds = new Set<string>();
    for (const e of batch) {
      names.add(elementNameNorm(e.qualifiedName));
      kinds.add(e.kind);
      if (e.parentQualifiedName) {
        names.add(elementNameNorm(e.parentQualifiedName));
        for (const k of DATA_ELEMENT_KIND_DEFS[e.kind].parentKinds) kinds.add(k);
      }
    }
    const known = new Map<string, Known>();
    // by kind and name (the index on both), so a platform with many elements is not scanned
    const kindList = [...kinds];
    for (const r of inChunks<Known>(
      (m) => `SELECT ${cols} FROM dp_elements WHERE platform_id = ? AND kind IN (${marks(kindList.length)}) AND name_norm IN (${m})`,
      [...names],
      platformId,
      ...kindList,
    ))
      known.set(keyOf(r.kind, r.environment, r.name_norm), r);
    const extIds = batch.map((e) => e.externalId).filter((x): x is string => !!x);
    const byExternal = new Map<string, Known>();
    for (const r of inChunks<Known>((m) => `SELECT ${cols} FROM dp_elements WHERE platform_id = ? AND external_id IN (${m})`, extIds, platformId))
      byExternal.set(`${r.kind}\u0000${r.environment}\u0000${r.external_id}`, r);
    let room = DATA_PRODUCT_LIMITS.elements - Number(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_elements')!.n);
    // owning teams of new elements: the source's, else the platform's
    let teams = parseJson<string[]>(src.element_team_ids, []);
    if (!teams.length)
      teams = d.all<{ team_id: string }>("SELECT team_id FROM resource_teams WHERE kind = 'platform' AND resource_id = ?", platformId).map((r) => r.team_id);
    teams = [...new Set(teams)];
    const parentOf = (e: DiscoveredElement): string | null => {
      if (!e.parentQualifiedName) return null;
      const norm = elementNameNorm(e.parentQualifiedName);
      for (const k of DATA_ELEMENT_KIND_DEFS[e.kind].parentKinds) {
        const p = known.get(keyOf(k, e.environment, norm));
        if (p) return p.id;
      }
      return null;
    };
    const inserts: unknown[][] = [];
    const orphans: string[] = [];
    const teamRows: unknown[][] = [];
    const readouts = new Map<string, string>();
    for (const e of batch) {
      const norm = elementNameNorm(e.qualifiedName);
      const qualified = e.qualifiedName.trim();
      const parentId = parentOf(e);
      const hash = techHash(e, parentId);
      const olNamespace = e.olNamespace ?? null;
      const olName = e.olName ?? null;
      let row = known.get(keyOf(e.kind, e.environment, norm));
      if (!row && e.externalId) {
        const prev = byExternal.get(`${e.kind}\u0000${e.environment}\u0000${e.externalId}`);
        // a known id under a new name: renamed, not replaced (people's fields and memberships stay)
        if (prev && prev.name_norm !== norm && !known.has(keyOf(e.kind, e.environment, norm))) {
          // the name shown follows while it is the default (the old short name); one people gave stays
          const displayName =
            prev.display_name === elementShortName(prev.qualified_name)
              ? (e.displayName ?? elementShortName(e.qualifiedName)).slice(0, DATA_PRODUCT_LIMITS.name)
              : prev.display_name;
          d.run(
            `UPDATE dp_elements SET qualified_name = ?, name_norm = ?, display_name = ?, parent_id = ?, flags = ?, ol_namespace = ?, ol_name = ?, tech_hash = ?,
               missing_since = NULL, revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?`,
            qualified,
            norm,
            displayName,
            parentId,
            JSON.stringify(e.flags ?? {}),
            olNamespace,
            olName,
            hash,
            now,
            actor,
            prev.id,
          );
          result.renames.push({ id: prev.id, from: prev.qualified_name, to: qualified });
          result.renamed++;
          known.delete(keyOf(prev.kind, prev.environment, prev.name_norm));
          row = { ...prev, name_norm: norm, qualified_name: qualified, display_name: displayName, tech_hash: hash, missing_since: null, parent_id: parentId };
          known.set(keyOf(e.kind, e.environment, norm), row);
        }
      } else if (row) {
        if (row.tech_hash !== hash || row.missing_since) {
          d.run(
            `UPDATE dp_elements SET qualified_name = ?, parent_id = ?, external_id = ?, flags = ?, ol_namespace = ?, ol_name = ?, tech_hash = ?, missing_since = NULL,
               discovery_source_id = COALESCE(discovery_source_id, ?), revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?`,
            qualified,
            parentId,
            e.externalId ?? null,
            JSON.stringify(e.flags ?? {}),
            olNamespace,
            olName,
            hash,
            sourceId,
            now,
            actor,
            row.id,
          );
          row = { ...row, tech_hash: hash, missing_since: null, parent_id: parentId, discovery_source_id: row.discovery_source_id ?? sourceId };
          known.set(keyOf(e.kind, e.environment, norm), row);
          result.changed++;
        } else {
          // an element no source looks after (entered, or its source deleted) is this source's from now on: it is
          // marked missing when the platform no longer has it
          if (!row.discovery_source_id) {
            orphans.push(row.id);
            row = { ...row, discovery_source_id: sourceId };
            known.set(keyOf(e.kind, e.environment, norm), row);
          }
          result.unchanged++;
        }
      }
      if (!row) {
        if (room <= 0) {
          result.skipped++;
          continue;
        }
        room--;
        const id = newId(DATA_PRODUCT_ID_PREFIX.element);
        inserts.push([
          id,
          platformId,
          e.kind,
          qualified,
          norm,
          (e.displayName ?? elementShortName(e.qualifiedName)).slice(0, DATA_PRODUCT_LIMITS.name),
          e.environment,
          parentId,
          'discovered',
          sourceId,
          e.externalId ?? null,
          olNamespace,
          olName,
          JSON.stringify(e.flags ?? {}),
          hash,
          now,
          actor,
          now,
          actor,
        ]);
        for (const t of teams) teamRows.push(['data_element', id, t, now]);
        row = {
          id,
          kind: e.kind,
          environment: e.environment,
          name_norm: norm,
          qualified_name: qualified,
          display_name: (e.displayName ?? elementShortName(e.qualifiedName)).slice(0, DATA_PRODUCT_LIMITS.name),
          external_id: e.externalId ?? null,
          tech_hash: hash,
          missing_since: null,
          parent_id: parentId,
          discovery_source_id: sourceId,
        };
        known.set(keyOf(e.kind, e.environment, norm), row);
        result.added++;
      }
      result.seen.push(row.id);
      const readout = readoutJson(e.readout);
      if (readout) readouts.set(row.id, readout);
    }
    for (const part of chunks(orphans)) d.run(`UPDATE dp_elements SET discovery_source_id = ? WHERE id IN (${marks(part.length)})`, sourceId, ...part);
    // parents come before their children in `inserts` (the batch's order), so a child never points ahead
    insertRows(
      `INSERT INTO dp_elements (id, platform_id, kind, qualified_name, name_norm, display_name, environment, parent_id, source, discovery_source_id,
         external_id, ol_namespace, ol_name, flags, tech_hash, created_at, created_by, updated_at, updated_by)`,
      inserts,
    );
    insertRows('INSERT INTO resource_teams (kind, resource_id, team_id, created_at)', teamRows, 'ON CONFLICT DO NOTHING');
    insertRows(
      'INSERT INTO dp_element_readouts (element_id, data, read_at)',
      [...readouts].map(([id, data]) => [id, data, now]),
      'ON CONFLICT (element_id) DO UPDATE SET data = excluded.data, read_at = excluded.read_at',
    );
    result.readouts = readouts.size;
  });
  return result;
}

/**
 * After a complete (not truncated) run: the source's elements it did not see are marked missing since `at`; returns
 * the ids newly missing (the products they are part of are told once, WP4's notice). Elements seen again lost their
 * mark in upsertDiscovered.
 */
export function markMissing(sourceId: string, seenIds: Iterable<string>, at = nowIso()): string[] {
  const seen = new Set(seenIds);
  const gone = db()
    .all<{ id: string }>('SELECT id FROM dp_elements WHERE discovery_source_id = ? AND missing_since IS NULL', sourceId)
    .map((r) => r.id)
    .filter((id) => !seen.has(id));
  db().tx(() => {
    for (const part of chunks(gone)) db().run(`UPDATE dp_elements SET missing_since = ? WHERE id IN (${marks(part.length)})`, at, ...part);
  });
  return gone;
}

/**
 * Removes elements missing since before `before` that are in no product (part 5: after 30 days), with their readouts,
 * links to data objects, step ends, check links and owning teams. Returns how many.
 */
export function removeLongMissing(before: string, sourceId?: string): number {
  const ids = db()
    .all<{ id: string }>(
      `SELECT e.id FROM dp_elements e WHERE e.missing_since IS NOT NULL AND e.missing_since < ?${sourceId ? ' AND e.discovery_source_id = ?' : ''}
       AND NOT EXISTS (SELECT 1 FROM dp_members m WHERE m.element_id = e.id)`,
      ...(sourceId ? [before, sourceId] : [before]),
    )
    .map((r) => r.id);
  db().tx(() => {
    for (const part of chunks(ids)) deleteElementRows(part);
  });
  return ids.length;
}

/** Deletes elements and everything that hangs on them (no audit; callers say why). */
export function deleteElementRows(ids: readonly string[]): void {
  if (!ids.length) return;
  const m = marks(ids.length);
  const d = db();
  d.run(`UPDATE dp_elements SET parent_id = NULL WHERE parent_id IN (${m})`, ...ids);
  d.run(`DELETE FROM dp_element_readouts WHERE element_id IN (${m})`, ...ids);
  d.run(`DELETE FROM dp_object_elements WHERE element_id IN (${m})`, ...ids);
  d.run(`DELETE FROM dp_port_elements WHERE element_id IN (${m})`, ...ids);
  d.run(`DELETE FROM dp_step_elements WHERE element_id IN (${m})`, ...ids);
  d.run(`DELETE FROM dp_check_links WHERE element_id IN (${m})`, ...ids);
  d.run(`DELETE FROM dp_cost_matches WHERE element_id IN (${m})`, ...ids);
  d.run(`DELETE FROM dp_members WHERE element_id IN (${m})`, ...ids);
  // 0.24.0: lineage proposals name it no more (they keep their other ends), its quality results go
  d.run(`DELETE FROM dp_lineage_proposal_elements WHERE element_id IN (${m})`, ...ids);
  d.run(`DELETE FROM dp_lineage_tests WHERE element_id IN (${m})`, ...ids);
  d.run(`DELETE FROM dp_quality_results WHERE element_id IN (${m})`, ...ids);
  d.run(`UPDATE dp_ports SET source_element_id = NULL, source_kind = NULL WHERE source_element_id IN (${m})`, ...ids);
  d.run(`DELETE FROM resource_teams WHERE kind = 'data_element' AND resource_id IN (${m})`, ...ids);
  d.run(`DELETE FROM dp_elements WHERE id IN (${m})`, ...ids);
}

/** The readouts of these elements. */
export function readoutsOf(elementIds: readonly string[]): Map<string, { data: string; read_at: string }> {
  return new Map(
    inChunks<{ element_id: string; data: string; read_at: string }>(
      (m) => `SELECT element_id, data, read_at FROM dp_element_readouts WHERE element_id IN (${m})`,
      elementIds,
    ).map((r) => [r.element_id, { data: r.data, read_at: r.read_at }]),
  );
}
