import { z } from 'zod';
import {
  BLUEPRINT_IMPORTANCES,
  BLUEPRINT_LIMITS as L,
  BLUEPRINT_WHY,
  type BlueprintImportance,
  type BlueprintState,
  type BlueprintTargetKind,
  type PlantAssetBrief,
  type PlantBlueprintCoverage,
  type PlantBlueprintCoverageView,
  type PlantBlueprintDetail,
  type PlantBlueprintMappedPoint,
  type PlantBlueprintSignal,
  type PlantBlueprintSignalCoverage,
  type PlantBlueprintSuggestion,
  type PlantBlueprintSummary,
  type PlantBlueprintTotals,
  type PlantBlueprintValues,
  type PlantCataloguePermission,
  type PlantDataPoint,
  type PlantInterface,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import { isAdmin } from '../auth/permissions.js';
import { HttpError, nowIso } from '../util.js';
import { canManageCatalogue, requireManage } from './access.js';
import { requirePlant } from './settings.js';
import { changedKeys, plantId } from './model.js';
import { profileRowOf, resolvedProfile, assignmentRowOf, assignmentValuesOf } from './data-model.js';
import { assetModel } from './resolve.js';
import { collectedPoints } from './potential.js';
import { profileNotFound, visibleAssets } from './catalogue.js';
import { catalogueScope, idUnavailable, requireEntry, requireRight, type CatalogueScope } from './catalogue-access.js';
import { visibleAsset } from './service.js';
import * as store from './blueprint-store.js';
import type { TargetKey } from './blueprint-store.js';
import { applyCreationAccess } from '../auth/creation-access.js';

/**
 * Machine blueprints (0.30.0, ADR 0041, docs/PLANT.md "Machine blueprints"): a checklist per kind of machine, compared
 * with device profiles and assets. Advice only – a blueprint never changes a profile or an asset, and never blocks a save.
 *
 * Rights follow the device profiles: whoever may add sites (designers, administrators) adds blueprints, owning teams and
 * shares decide who sees and changes one (catalogue-access.ts, the kind `blueprint`). Assigning, mapping and marking
 * need the right to change the profile (Edit) or the asset (its site's Manage). A reader never sees, counts or is told
 * about a blueprint they may not see: lists, counts and coverage leave it out, an unknown id and a hidden one answer alike.
 * Every change is audited on the blueprint (blueprint.created, .updated, .deleted, .assigned, .unassigned,
 * .mapping_changed, .not_applicable_set, .not_applicable_cleared).
 */

// ---------- input ----------

const text = (max: number) => z.string().trim().max(max).default('');
const word = z.string().trim().min(1).max(L.name);

export const signalInput = z
  .object({
    id: plantId.describe('Stable id in the blueprint'),
    name: word.describe('What it is called'),
    meaning: text(L.text).describe('What it tells (no data type, unit or address)'),
    why: z
      .array(z.enum(BLUEPRINT_WHY))
      .max(BLUEPRINT_WHY.length)
      .default([])
      .transform((v) => [...new Set(v)]),
    importance: z.enum(BLUEPRINT_IMPORTANCES).default('should'),
    aliases: z
      .array(word)
      .max(L.aliases)
      .default([])
      .transform((v) => [...new Set(v)]),
    kpis: z
      .array(plantId)
      .max(L.kpisPerSignal)
      .default([])
      .transform((v) => [...new Set(v)])
      .describe('Ids of the KPI definitions this signal feeds'),
  })
  .strict();

export const signalUpdate = signalInput.omit({ id: true }).partial();

export const blueprintInput = z
  .object({
    id: plantId,
    name: word,
    description: text(L.text),
    reference: text(L.name),
    version: text(60),
    signals: z.array(signalInput).max(L.signals).default([]),
  })
  .strict();

/** A change gives the keys it changes; `signals`, when given, is the whole list (its order too). */
export const blueprintUpdate = blueprintInput.omit({ id: true }).partial().strict();

export const mappingInput = z.object({ dataPoints: z.array(z.string().trim().min(1).max(120)).max(L.pointsPerSignal) }).strict();
export const mappingAdd = z.object({ dataPoint: z.string().trim().min(1).max(120) }).strict();
export const markInput = z.object({ reason: z.string().trim().min(1).max(L.reason) }).strict();

export const notFound = (id: string): HttpError => new HttpError(404, `Machine blueprint ${id} not found`, 'PLANT_BLUEPRINT_NOT_FOUND', { id });
const signalNotFound = (blueprint: string, id: string): HttpError =>
  new HttpError(404, `Signal ${id} of machine blueprint ${blueprint} not found`, 'PLANT_BLUEPRINT_SIGNAL_NOT_FOUND', { id });
const invalid = (path: string, message: string): HttpError => new HttpError(400, `${path}: ${message}`, 'PLANT_BLUEPRINT_INVALID', { path, message });

/** Problems of a blueprint's signals (an id twice). */
export function signalProblems(signals: PlantBlueprintSignal[]): { path: string; message: string }[] {
  const seen = new Set<string>();
  const out: { path: string; message: string }[] = [];
  signals.forEach((s, i) => {
    if (seen.has(s.id)) out.push({ path: `signals[${i}].id`, message: `The signal id ${s.id} is used twice` });
    seen.add(s.id);
  });
  return out;
}

// ---------- rights ----------

function requireCatalogue(what: string): string {
  requirePlant();
  const u = me();
  if (!canManageCatalogue(u)) throw new HttpError(403, `You are not allowed to ${what}`, 'FORBIDDEN', { context: 'managePlantCatalogue' });
  return u.username;
}

/** An existing blueprint the caller may see (404 like an unknown one otherwise) and may change as `need` says (403). */
function requireBlueprint(scope: CatalogueScope, id: string, need: PlantCataloguePermission, what: string): { row: store.BlueprintRow; by: string } {
  requirePlant();
  const u = me();
  const row = store.blueprintRowOf(id);
  const rights = requireEntry(scope, 'blueprint', id, notFound);
  if (!row) throw notFound(id);
  requireRight(rights, need, what);
  return { row, by: u.username };
}

// ---------- reading ----------

const emptyCounts = () => ({ must: 0, should: 0, nice: 0 });

/** Visible profiles (id, name) and assets per blueprint. */
function usersOf(scope: CatalogueScope): Map<string, { profiles: { id: string; name: string }[]; assets: PlantAssetBrief[] }> {
  const out = new Map<string, { profiles: { id: string; name: string }[]; assets: PlantAssetBrief[] }>();
  const slot = (id: string) => out.get(id) ?? (out.set(id, { profiles: [], assets: [] }), out.get(id)!);
  const profiles = new Map(
    db()
      .all<{ id: string; name: string }>('SELECT id, name FROM plant_profiles')
      .map((p) => [p.id, p.name]),
  );
  const v = visibleAssets();
  for (const a of db().all<{ blueprint_id: string; target_kind: BlueprintTargetKind; target_id: string }>(
    'SELECT blueprint_id, target_kind, target_id FROM plant_blueprint_assignments ORDER BY target_id',
  )) {
    if (a.target_kind === 'profile') {
      if (profiles.has(a.target_id) && scope.profile(a.target_id)) slot(a.blueprint_id).profiles.push({ id: a.target_id, name: profiles.get(a.target_id)! });
    } else {
      const brief = v.briefs.get(a.target_id);
      if (brief) slot(a.blueprint_id).assets.push(brief);
    }
  }
  for (const u of out.values()) {
    u.profiles.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
    u.assets.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  }
  return out;
}

function summaryOf(
  row: store.BlueprintRow,
  signals: PlantBlueprintSignal[],
  users: { profiles: unknown[]; assets: unknown[] } | undefined,
): PlantBlueprintSummary {
  const byImportance = emptyCounts();
  for (const s of signals) byImportance[s.importance]++;
  return {
    id: row.id,
    name: row.name,
    reference: row.reference,
    version: row.version,
    signalCount: signals.length,
    byImportance,
    profileCount: users?.profiles.length ?? 0,
    assetCount: users?.assets.length ?? 0,
    importId: row.import_id,
    notInSource: !!row.not_in_source,
    updatedAt: row.updated_at,
  };
}

/** The signals as a reader sees them: links to KPI definitions that are gone or that they may not see are left out. */
export function signalsForReader(signals: PlantBlueprintSignal[], scope: CatalogueScope): PlantBlueprintSignal[] {
  const known = new Map<string, boolean>();
  const ok = (k: string) => known.get(k) ?? (known.set(k, kpiKnown(k, scope)), known.get(k)!);
  return signals.map((s) => (s.kpis?.length ? { ...s, kpis: s.kpis.filter(ok) } : { ...s, kpis: [] }));
}

/** The machine blueprints the caller may see. */
export function listBlueprints(scope: CatalogueScope = catalogueScope()): PlantBlueprintSummary[] {
  requirePlant();
  const users = usersOf(scope);
  return store
    .allBlueprints()
    .filter((b) => scope.blueprint(b.row.id))
    .map((b) => summaryOf(b.row, b.values.signals, users.get(b.row.id)));
}

export function getBlueprint(id: string, scope: CatalogueScope = catalogueScope()): PlantBlueprintDetail {
  requirePlant();
  const row = store.blueprintRowOf(id);
  const rights = requireEntry(scope, 'blueprint', id, notFound);
  if (!row) throw notFound(id);
  const signals = signalsForReader(store.signalsOf(id), scope);
  const users = usersOf(scope).get(id);
  return {
    ...summaryOf(row, signals, users),
    description: row.description,
    signals,
    profiles: users?.profiles ?? [],
    assets: users?.assets ?? [],
    canEdit: rights.includes('edit'),
    canManage: rights.includes('manage'),
    updatedBy: row.updated_by,
  };
}

// ---------- writing blueprints ----------

/** Whether a KPI definition exists and the caller may see it (a hidden one reads like an unknown one). */
const kpiKnown = (id: string, scope: CatalogueScope): boolean => !!db().get('SELECT 1 FROM plant_kpis WHERE id = ?', id) && scope.kpi(id);

/**
 * The blueprint as it may be saved: signal ids once, and the KPI definitions its signals feed exist (and are visible).
 * A link a signal had already may stay although its KPI definition is gone. An import gives `warnings`: such a name is
 * dropped with a message instead of refused.
 */
function checked(v: PlantBlueprintValues, scope: CatalogueScope, before?: PlantBlueprintValues, warnings?: string[]): PlantBlueprintValues {
  const p = signalProblems(v.signals);
  if (p.length) throw invalid(p[0]!.path, p[0]!.message);
  const had = new Map((before?.signals ?? []).map((s) => [s.id, new Set(s.kpis ?? [])]));
  const signals = v.signals.map((s, i) => {
    const bad = (s.kpis ?? []).filter((k) => !had.get(s.id)?.has(k) && !kpiKnown(k, scope));
    if (bad.length && !warnings) throw invalid(`signals[${i}].kpis`, `KPI definition ${bad[0]} not found`);
    for (const k of bad) warnings!.push(`KPI definition "${k}" not found – signal ${s.id} of machine blueprint "${v.id}" does not link to it`);
    // the links to KPI definitions the caller may not see are not theirs to change: they stay
    const hidden = [...(had.get(s.id) ?? [])].filter((k) => !scope.kpi(k) && !(s.kpis ?? []).includes(k));
    return { ...s, kpis: [...(s.kpis ?? []).filter((k) => !bad.includes(k)), ...hidden] };
  });
  return { ...v, signals };
}

export function createBlueprint(input: z.infer<typeof blueprintInput>): PlantBlueprintDetail {
  const by = requireCatalogue('add machine blueprints');
  const scope = catalogueScope();
  if (store.blueprintRowOf(input.id))
    throw scope.blueprint(input.id)
      ? new HttpError(409, `A machine blueprint with the id ${input.id} exists already`, 'PLANT_ID_TAKEN', { id: input.id })
      : idUnavailable(input.id);
  if (Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_blueprints')!.n) >= L.blueprints)
    throw new HttpError(409, `At most ${L.blueprints} machine blueprints`, 'PLANT_LIMIT', { max: L.blueprints });
  const v = checked(input, scope);
  db().tx(() => {
    // like a new device profile: it belongs to no team, whoever adds it; teams restrict it deliberately
    store.writeBlueprint(v, { at: nowIso(), by });
    applyCreationAccess('blueprint', v.id, v.name, undefined);
    audit({
      action: 'blueprint.created',
      entityType: 'blueprint',
      entityId: v.id,
      summary: `Machine blueprint "${v.name}" (${v.id}) added with ${v.signals.length} signals`,
      details: { reference: v.reference, version: v.version, signals: v.signals.map((s) => s.id) },
    });
  });
  return getBlueprint(v.id);
}

/** What changed in a blueprint, for the audit entry: its own keys, and its signals by id. */
function blueprintChanges(before: PlantBlueprintValues, after: PlantBlueprintValues) {
  const keys = changedKeys(before, after, ['signals']);
  const b = new Map(before.signals.map((s) => [s.id, s]));
  const a = new Map(after.signals.map((s) => [s.id, s]));
  const signals = {
    added: [...a.keys()].filter((k) => !b.has(k)),
    removed: [...b.keys()].filter((k) => !a.has(k)),
    changed: [...a.keys()].filter((k) => b.has(k) && JSON.stringify(b.get(k)) !== JSON.stringify(a.get(k))),
  };
  const order = !signals.added.length && !signals.removed.length && !signals.changed.length && JSON.stringify(before.signals) !== JSON.stringify(after.signals);
  const changed = keys.length > 0 || signals.added.length + signals.removed.length + signals.changed.length > 0 || order;
  return { keys, signals, order, changed };
}

/** Writes a changed blueprint and audits it; whether anything changed. Callers check the right. */
export function saveBlueprint(
  before: PlantBlueprintValues,
  after: PlantBlueprintValues,
  by: string,
  meta: { importId?: string | null; keepSource?: boolean } = {},
): boolean {
  const c = blueprintChanges(before, after);
  if (!c.changed) return false;
  const removedWithData = c.signals.removed.filter(
    (id) =>
      !!db().get('SELECT 1 FROM plant_blueprint_mappings WHERE blueprint_id = ? AND signal_id = ?', after.id, id) ||
      !!db().get('SELECT 1 FROM plant_blueprint_not_applicable WHERE blueprint_id = ? AND signal_id = ?', after.id, id),
  );
  store.writeBlueprint(after, { at: nowIso(), by, importId: meta.importId ?? null }, { keepSource: meta.keepSource ?? true });
  const parts = [...c.keys, ...(c.signals.added.length + c.signals.removed.length + c.signals.changed.length || c.order ? ['signals'] : [])];
  audit({
    action: 'blueprint.updated',
    entityType: 'blueprint',
    entityId: after.id,
    summary: `Machine blueprint "${after.name}" changed (${parts.join(', ')})`,
    details: {
      changes: c.keys,
      old: Object.fromEntries(c.keys.map((k) => [k, (before as unknown as Record<string, unknown>)[k]])),
      new: Object.fromEntries(c.keys.map((k) => [k, (after as unknown as Record<string, unknown>)[k]])),
      signals: c.signals,
      ...(removedWithData.length ? { mappingsAndMarksRemovedWith: removedWithData } : {}),
    },
  });
  return true;
}

function valuesOfId(id: string): PlantBlueprintValues {
  const row = store.blueprintRowOf(id)!;
  return store.valuesOf(row, store.signalsOf(id));
}

export function updateBlueprint(id: string, input: z.infer<typeof blueprintUpdate>): PlantBlueprintDetail {
  const scope = catalogueScope();
  const { by } = requireBlueprint(scope, id, 'edit', 'change this machine blueprint');
  const before = valuesOfId(id);
  const after = checked({ ...before, ...input, id }, scope, before);
  db().tx(() => saveBlueprint(before, after, by));
  return getBlueprint(id);
}

export function addSignal(blueprintId: string, input: z.infer<typeof signalInput>): PlantBlueprintDetail {
  const scope = catalogueScope();
  const { by } = requireBlueprint(scope, blueprintId, 'edit', 'change this machine blueprint');
  const before = valuesOfId(blueprintId);
  if (before.signals.length >= L.signals) throw new HttpError(409, `At most ${L.signals} signals in a blueprint`, 'PLANT_LIMIT', { max: L.signals });
  if (before.signals.some((s) => s.id === input.id))
    throw new HttpError(409, `A signal with the id ${input.id} exists already`, 'PLANT_ID_TAKEN', { id: input.id });
  const after = checked({ ...before, signals: [...before.signals, input] }, scope, before);
  db().tx(() => saveBlueprint(before, after, by));
  return getBlueprint(blueprintId);
}

export function updateSignal(blueprintId: string, signalId: string, input: z.infer<typeof signalUpdate>): PlantBlueprintDetail {
  const scope = catalogueScope();
  const { by } = requireBlueprint(scope, blueprintId, 'edit', 'change this machine blueprint');
  const before = valuesOfId(blueprintId);
  if (!before.signals.some((s) => s.id === signalId)) throw signalNotFound(blueprintId, signalId);
  const after = checked({ ...before, signals: before.signals.map((s) => (s.id === signalId ? { ...s, ...input, id: signalId } : s)) }, scope, before);
  db().tx(() => saveBlueprint(before, after, by));
  return getBlueprint(blueprintId);
}

/** A signal goes with its mappings and marks (the audit entry names that it had some). */
export function deleteSignal(blueprintId: string, signalId: string): PlantBlueprintDetail {
  const scope = catalogueScope();
  const { by } = requireBlueprint(scope, blueprintId, 'edit', 'change this machine blueprint');
  const before = valuesOfId(blueprintId);
  if (!before.signals.some((s) => s.id === signalId)) throw signalNotFound(blueprintId, signalId);
  db().tx(() => saveBlueprint(before, { ...before, signals: before.signals.filter((s) => s.id !== signalId) }, by));
  return getBlueprint(blueprintId);
}

/** A blueprint that is assigned cannot be deleted – with the count only when the caller sees everything that has it. */
export function deleteBlueprint(id: string): void {
  const scope = catalogueScope();
  const { row, by } = requireBlueprint(scope, id, 'manage', 'delete this machine blueprint');
  const users = store.assignedOf(id);
  if (users.length) {
    const seen = usersOf(scope).get(id);
    const visible = (seen?.profiles.length ?? 0) + (seen?.assets.length ?? 0);
    if (visible !== users.length) throw new HttpError(409, 'The machine blueprint is in use – it cannot be deleted', 'PLANT_BLUEPRINT_IN_USE_HIDDEN');
    throw new HttpError(409, `The machine blueprint is assigned to ${users.length} device profiles and assets – take it off first`, 'PLANT_BLUEPRINT_IN_USE', {
      count: users.length,
    });
  }
  db().tx(() => {
    store.removeBlueprintRow(id);
    audit({
      action: 'blueprint.deleted',
      entityType: 'blueprint',
      entityId: id,
      summary: `Machine blueprint "${row.name}" (${id}) deleted`,
      details: { by },
    });
  });
}

// ---------- the data a target has ----------

export interface Point {
  id: string;
  name: string;
  aliases: string[];
  /** The normalised id, name and known-as names, worked out on first use */
  normalised?: string[];
}

export const pointsOfInterfaces = (ifaces: PlantInterface[]): Map<string, Point> => {
  const out = new Map<string, Point>();
  for (const i of ifaces)
    for (const g of i.groups)
      for (const d of g.dataPoints as PlantDataPoint[]) if (!out.has(d.id)) out.set(d.id, { id: d.id, name: d.name, aliases: d.aliases ?? [] });
  return out;
};

/** The data points a device profile has (resolved: inherited ones count). */
function profilePoints(profileId: string | null | undefined): Map<string, Point> {
  const p = resolvedProfile(profileId);
  return p ? pointsOfInterfaces(p.interfaces) : new Map();
}

/** The data points of an asset's data: its profile's and what it adds itself. */
function assetPoints(assetId: string): { profileId: string | null; points: Map<string, Point> } {
  const r = assignmentRowOf(assetId);
  const a = r ? assignmentValuesOf(r) : null;
  const profile = resolvedProfile(a?.profileId);
  return { profileId: a?.profileId ?? null, points: pointsOfInterfaces(assetModel(a, profile).interfaces) };
}

// ---------- suggestions ----------

const norm = (t: string): string =>
  t
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Data points whose id, name or known-as name matches the signal's name or one of its known-as names: equal after
 * normalising (`energy_total` = "Energy total"), or – for a keyword of four letters or more – one contains the other as
 * whole words. Never counted as covered: a person confirms a mapping.
 */
export function suggestionsFor(signal: PlantBlueprintSignal, points: Map<string, Point>, taken: Set<string> = new Set()): PlantBlueprintSuggestion[] {
  const wanted = [{ text: signal.name, by: 'name' as const }, ...signal.aliases.map((text) => ({ text, by: 'alias' as const }))]
    .map((w) => ({ ...w, n: norm(w.text) }))
    .filter((w) => w.n);
  const out: (PlantBlueprintSuggestion & { rank: number })[] = [];
  for (const p of points.values()) {
    if (taken.has(p.id)) continue;
    const have = (p.normalised ??= [p.id, p.name, ...p.aliases].map(norm).filter(Boolean));
    let best: (PlantBlueprintSuggestion & { rank: number }) | null = null;
    for (const w of wanted)
      for (const h of have) {
        const exact = w.n === h;
        const words =
          !exact &&
          (w.n.length >= 4 || h.length >= 4) &&
          (` ${h} `.includes(` ${w.n} `) && w.n.length >= 4 ? true : ` ${w.n} `.includes(` ${h} `) && h.length >= 4);
        if (!exact && !words) continue;
        const cand = {
          dataPoint: p.id,
          name: p.name,
          matchedBy: exact ? w.by : ('keyword' as const),
          matched: w.text,
          rank: exact ? (w.by === 'name' ? 0 : 1) : 2,
        };
        if (!best || cand.rank < best.rank) best = cand;
      }
    if (best) out.push(best);
  }
  return out
    .sort((a, b) => a.rank - b.rank || a.dataPoint.localeCompare(b.dataPoint))
    .slice(0, 5)
    .map(({ rank: _r, ...s }) => s);
}

// ---------- coverage ----------

export const noTotals = (): PlantBlueprintTotals => ({ total: 0, applicable: 0, covered: 0, notCollected: 0, missing: 0, notApplicable: 0, suggested: 0 });

export function tally(list: PlantBlueprintSignalCoverage[]): PlantBlueprintTotals {
  const t = noTotals();
  for (const s of list) {
    t.total++;
    if (s.state === 'notApplicable') t.notApplicable++;
    else {
      t.applicable++;
      t[s.state === 'covered' ? 'covered' : s.state === 'notCollected' ? 'notCollected' : 'missing']++;
      if (s.state === 'missing' && s.suggestions.length) t.suggested++;
    }
  }
  return t;
}

export interface Ctx {
  /** The data points of the target (a profile's, an asset's data) */
  points: Map<string, Point>;
  /** An asset: the data points its data collections read; a profile: null */
  collected: Set<string> | null;
}

/** One signal against the mappings and marks that hold for a target. */
function signalCoverage(
  signal: PlantBlueprintSignal,
  mapped: { source: BlueprintTargetKind; dataPoint: string }[],
  mark: { reason: string; by: string; at: string; on: BlueprintTargetKind } | null,
  ctx: Ctx,
  withSuggestions: boolean,
): PlantBlueprintSignalCoverage {
  const seen = new Set<string>();
  const points: PlantBlueprintMappedPoint[] = [];
  for (const m of mapped) {
    if (seen.has(m.dataPoint)) continue;
    seen.add(m.dataPoint);
    const have = ctx.points.get(m.dataPoint);
    points.push({
      id: m.dataPoint,
      name: have?.name ?? m.dataPoint,
      source: m.source,
      ...(have ? {} : { missing: true }),
      collected: ctx.collected ? (have ? ctx.collected.has(m.dataPoint) : false) : null,
    });
  }
  const existing = points.filter((p) => !p.missing);
  let state: BlueprintState;
  if (mark) state = 'notApplicable';
  else if (!existing.length) state = 'missing';
  else if (ctx.collected && !existing.every((p) => p.collected)) state = 'notCollected';
  else state = 'covered';
  return {
    signal,
    state,
    points,
    notApplicable: mark,
    // suggestions only where nothing counts yet; a data point already mapped to the signal is not suggested again
    suggestions: withSuggestions && state === 'missing' ? suggestionsFor(signal, ctx.points, seen) : [],
  };
}

/** Mappings or marks of one target by `blueprint\0signal`, read once instead of filtering the list per signal. */
export type Indexed<T> = Map<string, T[]>;
export function indexBySignal<T extends { blueprint: string; signal: string }>(list: T[]): Indexed<T> {
  const out: Indexed<T> = new Map();
  for (const x of list) {
    const k = `${x.blueprint}\0${x.signal}`;
    const l = out.get(k);
    if (l) l.push(x);
    else out.set(k, [x]);
  }
  return out;
}

export interface CoverageOptions {
  /** Suggestions cost a scan of the target's data points per missing signal: aggregate views (matrix, KPI) leave them out. Default true. */
  suggestions?: boolean;
}

export function coverageOf(
  bp: { id: string; name: string; reference: string; version: string; signals: PlantBlueprintSignal[] },
  via: PlantBlueprintCoverage['via'],
  mappings: { source: BlueprintTargetKind; list: store.StoredMapping[]; by?: Indexed<store.StoredMapping> }[],
  marks: { on: BlueprintTargetKind; list: store.StoredMark[]; by?: Indexed<store.StoredMark> }[],
  ctx: Ctx,
  opts: CoverageOptions = {},
): PlantBlueprintCoverage {
  const withSuggestions = opts.suggestions !== false;
  const mapIndex = mappings.map((m) => ({ source: m.source, by: m.by ?? indexBySignal(m.list) }));
  const markIndex = marks.map((m) => ({ on: m.on, by: m.by ?? indexBySignal(m.list) }));
  const signals = bp.signals.map((s) => {
    const key = `${bp.id}\0${s.id}`;
    const mapped = mapIndex.flatMap((m) => (m.by.get(key) ?? []).map((x) => ({ source: m.source, dataPoint: x.dataPoint })));
    // the profile's mark holds for its assets, an asset's own comes beside it; the profile's is shown first
    let mark: { reason: string; by: string; at: string; on: BlueprintTargetKind } | null = null;
    for (const m of markIndex) {
      const x = m.by.get(key)?.[0];
      if (x) {
        mark = { reason: x.reason, by: x.by, at: x.at, on: m.on };
        break;
      }
    }
    return signalCoverage(s, mapped, mark, ctx, withSuggestions);
  });
  const byImportance = Object.fromEntries(BLUEPRINT_IMPORTANCES.map((i) => [i, tally(signals.filter((s) => s.signal.importance === i))])) as Record<
    BlueprintImportance,
    PlantBlueprintTotals
  >;
  return { blueprint: { id: bp.id, name: bp.name, reference: bp.reference, version: bp.version }, via, totals: tally(signals), byImportance, signals };
}

/** The blueprints (that the caller may see) with their ids, ordered by name. */
function visibleBlueprints(ids: string[], scope: CatalogueScope) {
  const wanted = new Set(ids);
  return store
    .allBlueprints()
    .filter((b) => wanted.has(b.row.id) && scope.blueprint(b.row.id))
    .map((b) => ({ ...b.values, signals: signalsForReader(b.values.signals, scope) }));
}

/** Coverage of a device profile: per blueprint it has, each signal covered, missing or not applicable. */
export function profileCoverage(profileId: string, scope: CatalogueScope = catalogueScope()): PlantBlueprintCoverageView {
  requirePlant();
  const row = profileRowOf(profileId);
  const rights = requireEntry(scope, 'device_profile', profileId, profileNotFound);
  if (!row) throw profileNotFound(profileId);
  const t: TargetKey = { kind: 'profile', id: profileId };
  const ctx: Ctx = { points: profilePoints(profileId), collected: null };
  const mappings = [{ source: 'profile' as const, list: store.mappingsOf(t) }];
  const marks = [{ on: 'profile' as const, list: store.marksOf(t) }];
  return {
    target: { kind: 'profile', id: profileId, name: row.name },
    profile: null,
    canEdit: rights.includes('edit'),
    blueprints: visibleBlueprints(store.assignedTo(t), scope).map((b) => coverageOf(b, 'direct', mappings, marks, ctx)),
  };
}

/**
 * Coverage of an asset: the blueprints of its profile and those it has itself. A signal the profile maps to a data point
 * is covered when a data collection of this asset reads it – otherwise the profile has it, but this asset does not collect
 * it (`notCollected`); a signal nothing is mapped to is missing: the profile lacks it.
 */
export function assetCoverage(assetId: string, scope: CatalogueScope = catalogueScope()): PlantBlueprintCoverageView {
  const { row, perms } = visibleAsset(assetId);
  const own: TargetKey = { kind: 'asset', id: assetId };
  const { profileId, points } = assetPoints(assetId);
  const profileRow = profileId ? profileRowOf(profileId) : undefined;
  // a profile the caller may not see is not named; what it maps and marks still counts for the asset
  const profileShown = profileRow && scope.profile(profileRow.id) ? { id: profileRow.id, name: profileRow.name } : null;
  const prof: TargetKey | null = profileRow ? { kind: 'profile', id: profileRow.id } : null;
  const direct = new Set(store.assignedTo(own));
  const viaProfile = new Set(prof ? store.assignedTo(prof) : []);
  const ctx: Ctx = { points, collected: collectedPoints(new Set([assetId])).get(assetId) ?? new Set() };
  const mappings = [...(prof ? [{ source: 'profile' as const, list: store.mappingsOf(prof) }] : []), { source: 'asset' as const, list: store.mappingsOf(own) }];
  const marks = [...(prof ? [{ on: 'profile' as const, list: store.marksOf(prof) }] : []), { on: 'asset' as const, list: store.marksOf(own) }];
  const via = (id: string): PlantBlueprintCoverage['via'] => (direct.has(id) && viaProfile.has(id) ? 'both' : direct.has(id) ? 'direct' : 'profile');
  return {
    target: { kind: 'asset', id: assetId, name: row.name },
    profile: profileShown,
    canEdit: perms.includes('manage'),
    blueprints: visibleBlueprints([...new Set([...viaProfile, ...direct])], scope).map((b) => coverageOf(b, via(b.id), mappings, marks, ctx)),
  };
}

// ---------- assigning, mapping, marking ----------

interface Writable {
  target: TargetKey;
  name: string;
  by: string;
  /** The data points the mapping may name */
  points: Map<string, Point>;
}

/** A profile or an asset the caller may see and change (404 like an unknown one, 403 without the right to change it). */
function writable(kind: BlueprintTargetKind, id: string, scope: CatalogueScope): Writable {
  requirePlant();
  const u = me();
  if (kind === 'profile') {
    const row = profileRowOf(id);
    const rights = requireEntry(scope, 'device_profile', id, profileNotFound);
    if (!row) throw profileNotFound(id);
    requireRight(rights, 'edit', 'change the machine blueprints of this device profile');
    return { target: { kind, id }, name: row.name, by: u.username, points: profilePoints(id) };
  }
  const { row, perms } = visibleAsset(id);
  requireManage(perms, 'change the machine blueprints of this asset');
  return { target: { kind, id }, name: row.name, by: u.username, points: assetPoints(id).points };
}

/** A blueprint the target has (assigned to it, or – an asset – to its profile) and the caller sees. */
function blueprintOf(w: Writable, blueprintId: string, scope: CatalogueScope): store.BlueprintRow {
  requireEntry(scope, 'blueprint', blueprintId, notFound);
  const row = store.blueprintRowOf(blueprintId);
  if (!row) throw notFound(blueprintId);
  const own = store.isAssigned(blueprintId, w.target);
  const profileId = w.target.kind === 'asset' ? (assignmentRowOf(w.target.id)?.profile_id ?? null) : null;
  if (!own && !(profileId && store.isAssigned(blueprintId, { kind: 'profile', id: profileId })))
    throw new HttpError(
      409,
      `The machine blueprint is not assigned to this ${w.target.kind === 'profile' ? 'device profile' : 'asset'}`,
      'PLANT_BLUEPRINT_NOT_ASSIGNED',
      {
        id: blueprintId,
      },
    );
  return row;
}

const labelOf = (t: TargetKey, name: string) => `${t.kind === 'profile' ? 'device profile' : 'asset'} "${name}" (${t.id})`;

/** The coverage view of a target after a change. */
const viewOf = (t: TargetKey, scope: CatalogueScope) => (t.kind === 'profile' ? profileCoverage(t.id, scope) : assetCoverage(t.id, scope));

export function assignBlueprint(kind: BlueprintTargetKind, id: string, blueprintId: string): PlantBlueprintCoverageView {
  const scope = catalogueScope();
  const w = writable(kind, id, scope);
  requireEntry(scope, 'blueprint', blueprintId, notFound);
  const row = store.blueprintRowOf(blueprintId);
  if (!row) throw notFound(blueprintId);
  if (store.assignedTo(w.target).length >= L.perTarget)
    throw new HttpError(409, `At most ${L.perTarget} machine blueprints per ${kind}`, 'PLANT_LIMIT', { max: L.perTarget });
  db().tx(() => {
    if (!store.addAssignment(blueprintId, w.target, nowIso(), w.by)) return;
    audit({
      action: 'blueprint.assigned',
      entityType: 'blueprint',
      entityId: blueprintId,
      summary: `Machine blueprint "${row.name}" assigned to ${labelOf(w.target, w.name)}`,
      details: { target: w.target },
    });
  });
  return viewOf(w.target, scope);
}

export function unassignBlueprint(kind: BlueprintTargetKind, id: string, blueprintId: string): PlantBlueprintCoverageView {
  const scope = catalogueScope();
  const w = writable(kind, id, scope);
  requireEntry(scope, 'blueprint', blueprintId, notFound);
  const row = store.blueprintRowOf(blueprintId);
  if (!row) throw notFound(blueprintId);
  db().tx(() => {
    const mappings = store.mappingsOf(w.target).filter((m) => m.blueprint === blueprintId).length;
    const marks = store.marksOf(w.target).filter((m) => m.blueprint === blueprintId).length;
    if (!store.removeAssignment(blueprintId, w.target)) return;
    audit({
      action: 'blueprint.unassigned',
      entityType: 'blueprint',
      entityId: blueprintId,
      summary: `Machine blueprint "${row.name}" taken off ${labelOf(w.target, w.name)}`,
      details: { target: w.target, mappingsRemoved: mappings, marksRemoved: marks },
    });
  });
  return viewOf(w.target, scope);
}

/** Sets the data points a signal is mapped to on a target (an empty list unmaps it). */
export function mapSignal(kind: BlueprintTargetKind, id: string, blueprintId: string, signalId: string, dataPoints: string[]): PlantBlueprintCoverageView {
  const scope = catalogueScope();
  const w = writable(kind, id, scope);
  const row = blueprintOf(w, blueprintId, scope);
  if (!store.signalsOf(blueprintId).some((s) => s.id === signalId)) throw signalNotFound(blueprintId, signalId);
  const wanted = [...new Set(dataPoints)];
  // a mapping that exists already may stay although its data point is gone; a new one must name a data point the target has
  const had = new Set(store.pointsMapped(blueprintId, w.target, signalId));
  for (const p of wanted)
    if (!w.points.has(p) && !had.has(p))
      throw new HttpError(400, `The ${kind === 'profile' ? 'device profile' : 'asset'} has no data point ${p}`, 'PLANT_BLUEPRINT_POINT_NOT_FOUND', { id: p });
  db().tx(() => {
    const before = store.pointsMapped(blueprintId, w.target, signalId);
    if (!store.setMapping(blueprintId, w.target, signalId, wanted, nowIso(), w.by)) return;
    audit({
      action: 'blueprint.mapping_changed',
      entityType: 'blueprint',
      entityId: blueprintId,
      summary: `Signal ${signalId} of machine blueprint "${row.name}" ${wanted.length ? `mapped to ${wanted.join(', ')}` : 'unmapped'} on ${labelOf(w.target, w.name)}`,
      details: { target: w.target, signal: signalId, before, after: wanted },
    });
  });
  return viewOf(w.target, scope);
}

export function mapSignalAdd(kind: BlueprintTargetKind, id: string, blueprintId: string, signalId: string, dataPoint: string): PlantBlueprintCoverageView {
  requirePlant();
  const now = store.pointsMapped(blueprintId, { kind, id }, signalId);
  return mapSignal(kind, id, blueprintId, signalId, [...now, dataPoint]);
}

export function mapSignalRemove(kind: BlueprintTargetKind, id: string, blueprintId: string, signalId: string, dataPoint: string): PlantBlueprintCoverageView {
  requirePlant();
  const now = store.pointsMapped(blueprintId, { kind, id }, signalId);
  return mapSignal(
    kind,
    id,
    blueprintId,
    signalId,
    now.filter((p) => p !== dataPoint),
  );
}

export function markNotApplicable(kind: BlueprintTargetKind, id: string, blueprintId: string, signalId: string, reason: string): PlantBlueprintCoverageView {
  const scope = catalogueScope();
  const w = writable(kind, id, scope);
  const row = blueprintOf(w, blueprintId, scope);
  if (!store.signalsOf(blueprintId).some((s) => s.id === signalId)) throw signalNotFound(blueprintId, signalId);
  const why = reason.trim();
  if (!why) throw invalid('reason', 'Give a reason');
  db().tx(() => {
    const before = store.markOf(blueprintId, w.target, signalId);
    if (before?.reason === why) return;
    store.setMark(blueprintId, w.target, signalId, why, nowIso(), w.by);
    audit({
      action: 'blueprint.not_applicable_set',
      entityType: 'blueprint',
      entityId: blueprintId,
      summary: `Signal ${signalId} of machine blueprint "${row.name}" marked not applicable on ${labelOf(w.target, w.name)}: ${why.slice(0, 200)}`,
      details: { target: w.target, signal: signalId, reason: why, ...(before ? { before: before.reason } : {}) },
    });
  });
  return viewOf(w.target, scope);
}

export function unmarkNotApplicable(kind: BlueprintTargetKind, id: string, blueprintId: string, signalId: string): PlantBlueprintCoverageView {
  const scope = catalogueScope();
  const w = writable(kind, id, scope);
  const row = blueprintOf(w, blueprintId, scope);
  db().tx(() => {
    const before = store.markOf(blueprintId, w.target, signalId);
    if (!before || !store.clearMark(blueprintId, w.target, signalId)) return;
    audit({
      action: 'blueprint.not_applicable_cleared',
      entityType: 'blueprint',
      entityId: blueprintId,
      summary: `Signal ${signalId} of machine blueprint "${row.name}" is applicable again on ${labelOf(w.target, w.name)}`,
      details: { target: w.target, signal: signalId, was: { reason: before.reason, by: before.by, at: before.at } },
    });
  });
  return viewOf(w.target, scope);
}

// ---------- the file format (blueprint-exchange.ts) ----------

/**
 * A blueprint of a file (`blueprint:`): added with the right to add blueprints, changed with the right to edit it. Keys the
 * file leaves out keep their values (a list given replaces the stored one). Imported blueprints name their import.
 */
export function importBlueprint(
  v: Partial<Omit<PlantBlueprintValues, 'id' | 'name'>> & Pick<PlantBlueprintValues, 'id' | 'name'>,
  importId: string,
): { result: 'added' | 'changed' | 'unchanged'; name: string; fields: string[]; drops: string[]; warnings: string[] } {
  const scope = catalogueScope();
  const warnings: string[] = [];
  const row = store.blueprintRowOf(v.id);
  if (!row) {
    const by = requireCatalogue('add machine blueprints');
    if (Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_blueprints')!.n) >= L.blueprints)
      throw new HttpError(409, `At most ${L.blueprints} machine blueprints`, 'PLANT_LIMIT', { max: L.blueprints });
    const made = checked({ description: '', reference: '', version: '', signals: [], ...v }, scope, undefined, warnings);
    store.writeBlueprint(made, { at: nowIso(), by, importId });
    applyCreationAccess('blueprint', made.id, made.name, undefined);
    audit({
      action: 'blueprint.created',
      entityType: 'blueprint',
      entityId: made.id,
      summary: `Machine blueprint "${made.name}" (${made.id}) added by import with ${made.signals.length} signals`,
      details: { reference: made.reference, version: made.version, signals: made.signals.map((s) => s.id), import: importId },
    });
    return { result: 'added', name: made.name, fields: [], drops: [], warnings };
  }
  const { by } = requireBlueprint(scope, v.id, 'edit', 'change this machine blueprint');
  const before = valuesOfId(v.id);
  const after = checked(
    { ...before, ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)), id: v.id } as PlantBlueprintValues,
    scope,
    before,
    warnings,
  );
  const c = blueprintChanges(before, after);
  const saved = saveBlueprint(before, after, by, { importId, keepSource: false });
  return {
    result: saved ? 'changed' : 'unchanged',
    name: after.name,
    fields: [...c.keys, ...(c.signals.added.length + c.signals.removed.length + c.signals.changed.length || c.order ? ['signals'] : [])],
    // a list given replaces the stored one: the signals it leaves out go with their mappings and marks
    drops: [
      ...c.signals.removed.map((id) => `signals[${id}]`),
      // a list of a signal that a file gives replaces the stored one: what it leaves out is dropped
      ...c.signals.changed.flatMap((sid) => {
        const was = before.signals.find((x) => x.id === sid)!;
        const now = after.signals.find((x) => x.id === sid)!;
        return (['aliases', 'kpis', 'why'] as const).flatMap((k) =>
          (was[k] ?? []).filter((x) => !(now[k] ?? []).includes(x as never)).map((x) => `signals[${sid}].${k}: ${x}`),
        );
      }),
    ],
    warnings,
  };
}

/** What a file says about the blueprints of one profile or asset; a key left out leaves that part as it is. */
export interface TargetBlueprints {
  blueprints?: string[];
  mappings?: { blueprint: string; signal: string; dataPoints: string[] }[];
  marks?: { blueprint: string; signal: string; reason: string; by?: string; at?: string }[];
}

/**
 * Applies the blueprint keys of a profile or an asset of a file (they replace the lists given, among the blueprints the
 * caller may see – the others are left alone). Names that lead nowhere are skipped with a message. Throws when the caller
 * may not change the target. Returns the messages and whether anything changed.
 */
export function applyTargetBlueprints(
  kind: BlueprintTargetKind,
  id: string,
  t: TargetBlueprints,
  importId: string,
): { messages: string[]; changed: boolean; name: string; fields: string[]; drops: string[]; marks: number } {
  const scope = catalogueScope();
  const w = writable(kind, id, scope);
  const messages: string[] = [];
  let changed = false;
  // what changed (blueprints, mappings, marks), what a list given took away, and how many marks were set or cleared
  const fields = new Set<string>();
  const drops: string[] = [];
  let marks = 0;
  const known = (b: string) => (store.blueprintRowOf(b) && scope.blueprint(b) ? store.blueprintRowOf(b)! : null);
  const label = labelOf(w.target, w.name);
  if (t.blueprints) {
    const want = new Set<string>();
    for (const b of t.blueprints) {
      if (!known(b)) messages.push(`Machine blueprint "${b}" not found – skipped (${label})`);
      else want.add(b);
    }
    for (const b of store.assignedTo(w.target).filter((x) => scope.blueprint(x) && !want.has(x))) {
      const row = store.blueprintRowOf(b)!;
      store.removeAssignment(b, w.target);
      changed = true;
      fields.add('blueprints');
      drops.push(`blueprints: ${b}`);
      audit({
        action: 'blueprint.unassigned',
        entityType: 'blueprint',
        entityId: b,
        summary: `Machine blueprint "${row.name}" taken off ${label} by import`,
        details: { target: w.target, import: importId },
      });
    }
    for (const b of want)
      if (store.addAssignment(b, w.target, nowIso(), w.by)) {
        changed = true;
        fields.add('blueprints');
        audit({
          action: 'blueprint.assigned',
          entityType: 'blueprint',
          entityId: b,
          summary: `Machine blueprint "${known(b)!.name}" assigned to ${label} by import`,
          details: { target: w.target, import: importId },
        });
      }
  }
  // the blueprints the target has now (its profile's too, for an asset) and the caller sees
  const profileId = kind === 'asset' ? (assignmentRowOf(id)?.profile_id ?? null) : null;
  const effective = new Set(
    [...store.assignedTo(w.target), ...(profileId ? store.assignedTo({ kind: 'profile', id: profileId }) : [])].filter((b) => scope.blueprint(b)),
  );
  const signalsOfB = new Map([...effective].map((b) => [b, store.signalsOf(b).map((x) => x.id)]));
  if (t.mappings) {
    const want = new Map<string, string[]>();
    for (const m of t.mappings) {
      if (!effective.has(m.blueprint)) messages.push(`Machine blueprint "${m.blueprint}" is not assigned – its mapping of ${m.signal} is skipped (${label})`);
      else if (!signalsOfB.get(m.blueprint)!.includes(m.signal))
        messages.push(`Signal "${m.signal}" of machine blueprint "${m.blueprint}" not found – skipped (${label})`);
      else {
        const ok = m.dataPoints.filter(
          (p) => w.points.has(p) || (messages.push(`Data point "${p}" not found – the mapping of ${m.signal} skips it (${label})`), false),
        );
        want.set(`${m.blueprint}\0${m.signal}`, [...(want.get(`${m.blueprint}\0${m.signal}`) ?? []), ...ok]);
      }
    }
    for (const [b, sigs] of signalsOfB)
      for (const sg of sigs) {
        const before = store.pointsMapped(b, w.target, sg);
        const after = want.get(`${b}\0${sg}`) ?? [];
        if (!store.setMapping(b, w.target, sg, after, nowIso(), w.by)) continue;
        changed = true;
        fields.add('blueprint_mappings');
        for (const x of before.filter((y) => !after.includes(y))) drops.push(`blueprint_mappings[${b}/${sg}]: ${x}`);
        audit({
          action: 'blueprint.mapping_changed',
          entityType: 'blueprint',
          entityId: b,
          summary: `Signal ${sg} of machine blueprint "${store.blueprintRowOf(b)!.name}" ${after.length ? `mapped to ${after.join(', ')}` : 'unmapped'} on ${label} by import`,
          details: { target: w.target, signal: sg, before, after, import: importId },
        });
      }
  }
  if (t.marks) {
    const want = new Map<string, NonNullable<TargetBlueprints['marks']>[number]>();
    for (const m of t.marks) {
      if (!effective.has(m.blueprint))
        messages.push(`Machine blueprint "${m.blueprint}" is not assigned – its not-applicable mark of ${m.signal} is skipped (${label})`);
      else if (!signalsOfB.get(m.blueprint)!.includes(m.signal))
        messages.push(`Signal "${m.signal}" of machine blueprint "${m.blueprint}" not found – skipped (${label})`);
      else want.set(`${m.blueprint}\0${m.signal}`, m);
    }
    for (const [b, sigs] of signalsOfB)
      for (const sg of sigs) {
        const before = store.markOf(b, w.target, sg);
        const m = want.get(`${b}\0${sg}`);
        if (!m && before) {
          store.clearMark(b, w.target, sg);
          changed = true;
          marks++;
          fields.add('blueprint_not_applicable');
          drops.push(`blueprint_not_applicable[${b}/${sg}]`);
          audit({
            action: 'blueprint.not_applicable_cleared',
            entityType: 'blueprint',
            entityId: b,
            summary: `Signal ${sg} of machine blueprint "${store.blueprintRowOf(b)!.name}" is applicable again on ${label} by import`,
            details: { target: w.target, signal: sg, import: importId },
          });
        } else if (m && (!before || before.reason !== m.reason.trim())) {
          const who = markAuthor(m);
          store.setMark(b, w.target, sg, m.reason.trim(), who.at, who.by);
          changed = true;
          marks++;
          fields.add('blueprint_not_applicable');
          audit({
            action: 'blueprint.not_applicable_set',
            entityType: 'blueprint',
            entityId: b,
            summary: `Signal ${sg} of machine blueprint "${store.blueprintRowOf(b)!.name}" marked not applicable on ${label} by import: ${m.reason.trim().slice(0, 200)}`,
            details: { target: w.target, signal: sg, reason: m.reason.trim(), import: importId },
          });
        }
      }
  }
  return { messages, changed, name: w.name, fields: [...fields], drops, marks };
}

/**
 * Who set a mark an import brings: the importing user, now. Only an administrator restoring an export keeps `by` and `at`
 * from the file – `at` only as an ISO timestamp, `by` capped – so nobody can forge another person's mark.
 */
function markAuthor(m: { by?: string; at?: string }): { by: string; at: string } {
  const u = me();
  if (!isAdmin(u)) return { by: u.username, at: nowIso() };
  const t = m.at && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(m.at) ? Date.parse(m.at) : NaN;
  return { by: m.by?.trim().slice(0, 100) || u.username, at: Number.isFinite(t) ? new Date(t).toISOString() : nowIso() };
}

/** The blueprint keys of a profile or an asset as a file holds them (only blueprints the reader may see). */
export function targetBlueprintsOut(kind: BlueprintTargetKind, id: string, scope: CatalogueScope): Record<string, unknown> {
  const t: TargetKey = { kind, id };
  const ids = store.assignedTo(t).filter((b) => scope.blueprint(b));
  const shown = new Set(ids);
  // an asset's own mappings and marks may also name the blueprints of its profile
  const profileId = kind === 'asset' ? (assignmentRowOf(id)?.profile_id ?? null) : null;
  if (profileId) for (const b of store.assignedTo({ kind: 'profile', id: profileId })) if (scope.blueprint(b)) shown.add(b);
  const mappings = new Map<string, string[]>();
  for (const m of store.mappingsOf(t))
    if (shown.has(m.blueprint)) mappings.set(`${m.blueprint}\0${m.signal}`, [...(mappings.get(`${m.blueprint}\0${m.signal}`) ?? []), m.dataPoint]);
  const marks = store.marksOf(t).filter((m) => shown.has(m.blueprint));
  return {
    ...(ids.length ? { blueprints: ids } : {}),
    ...(mappings.size
      ? { blueprint_mappings: [...mappings].map(([k, data_points]) => ({ blueprint: k.split('\0')[0], signal: k.split('\0')[1], data_points })) }
      : {}),
    ...(marks.length
      ? { blueprint_not_applicable: marks.map((m) => ({ blueprint: m.blueprint, signal: m.signal, reason: m.reason, by: m.by, at: m.at })) }
      : {}),
  };
}

/** A blueprint as the file holds it. */
export const blueprintOut = (v: PlantBlueprintValues): Record<string, unknown> => ({
  id: v.id,
  name: v.name,
  ...(v.description ? { description: v.description } : {}),
  ...(v.reference ? { reference: v.reference } : {}),
  ...(v.version ? { version: v.version } : {}),
  ...(v.signals.length
    ? {
        signals: v.signals.map((s) => ({
          id: s.id,
          name: s.name,
          ...(s.meaning ? { meaning: s.meaning } : {}),
          ...(s.why.length ? { why: s.why } : {}),
          importance: s.importance,
          ...(s.aliases.length ? { aliases: s.aliases } : {}),
          ...(s.kpis?.length ? { kpis: s.kpis } : {}),
        })),
      }
    : {}),
});

/** The blueprints the reader may see, as file documents. */
export function visibleBlueprintsOut(scope: CatalogueScope, only?: string): Record<string, unknown>[] {
  return store
    .allBlueprints()
    .filter((b) => scope.blueprint(b.row.id) && (!only || b.row.id === only))
    .map((b) => blueprintOut({ ...b.values, signals: signalsForReader(b.values.signals, scope) }));
}
