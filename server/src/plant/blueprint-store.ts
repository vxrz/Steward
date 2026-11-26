import { BLUEPRINT_LIMITS, type BlueprintTargetKind, type PlantBlueprintSignal, type PlantBlueprintValues } from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import { teamsChanged } from '../auth/policy.js';
import { sharesChanged } from '../auth/share-store.js';

/**
 * Machine blueprints as stored (0.30.0, ADR 0041): the rows and their writes, without rights – the service
 * (blueprints.ts) decides who may do what. Kept apart so that removing a profile or an asset (data-model.ts, model.ts)
 * can forget what blueprints say about it without the plant services importing each other.
 */

export interface BlueprintRow {
  id: string;
  name: string;
  description: string;
  reference: string;
  version: string;
  import_id: string | null;
  not_in_source: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

interface SignalRow {
  blueprint_id: string;
  id: string;
  position: number;
  name: string;
  meaning: string;
  why: string;
  importance: string;
  aliases: string;
  kpis: string;
}

export interface BlueprintMeta {
  at: string;
  by: string;
  importId?: string | null;
  notInSource?: boolean;
}

export interface TargetKey {
  kind: BlueprintTargetKind;
  id: string;
}

export interface StoredMark {
  blueprint: string;
  signal: string;
  reason: string;
  by: string;
  at: string;
}

export interface StoredMapping {
  blueprint: string;
  signal: string;
  dataPoint: string;
}

// ---------- reading ----------

export const blueprintRowOf = (id: string): BlueprintRow | undefined => db().get<BlueprintRow>('SELECT * FROM plant_blueprints WHERE id = ?', id);

const signalOf = (r: SignalRow): PlantBlueprintSignal => ({
  id: r.id,
  name: r.name,
  meaning: r.meaning,
  why: parseJson<PlantBlueprintSignal['why']>(r.why, []),
  importance: (r.importance as PlantBlueprintSignal['importance']) || 'should',
  aliases: parseJson<string[]>(r.aliases, []),
  kpis: parseJson<string[]>(r.kpis, []),
});

export function signalsOf(blueprintId: string): PlantBlueprintSignal[] {
  return db().all<SignalRow>('SELECT * FROM plant_blueprint_signals WHERE blueprint_id = ? ORDER BY position, id', blueprintId).map(signalOf);
}

export const valuesOf = (r: BlueprintRow, signals: PlantBlueprintSignal[]): PlantBlueprintValues => ({
  id: r.id,
  name: r.name,
  description: r.description,
  reference: r.reference,
  version: r.version,
  signals,
});

/** Every blueprint with its signals, in the order of its name. */
export function allBlueprints(): { row: BlueprintRow; values: PlantBlueprintValues }[] {
  const bySignals = new Map<string, PlantBlueprintSignal[]>();
  for (const r of db().all<SignalRow>('SELECT * FROM plant_blueprint_signals ORDER BY blueprint_id, position, id'))
    bySignals.set(r.blueprint_id, [...(bySignals.get(r.blueprint_id) ?? []), signalOf(r)]);
  return db()
    .all<BlueprintRow>('SELECT * FROM plant_blueprints ORDER BY name, id')
    .map((row) => ({ row, values: valuesOf(row, bySignals.get(row.id) ?? []) }));
}

/** The blueprints assigned to a profile or an asset (ids, in the order of assignment). */
export const assignedTo = (t: TargetKey): string[] =>
  db()
    .all<{ blueprint_id: string }>(
      'SELECT blueprint_id FROM plant_blueprint_assignments WHERE target_kind = ? AND target_id = ? ORDER BY created_at, blueprint_id',
      t.kind,
      t.id,
    )
    .map((r) => r.blueprint_id);

/** The profiles and assets a blueprint is assigned to. */
export const assignedOf = (blueprintId: string): { kind: BlueprintTargetKind; id: string }[] =>
  db()
    .all<{ target_kind: BlueprintTargetKind; target_id: string }>(
      'SELECT target_kind, target_id FROM plant_blueprint_assignments WHERE blueprint_id = ? ORDER BY target_kind, target_id',
      blueprintId,
    )
    .map((r) => ({ kind: r.target_kind, id: r.target_id }));

export const isAssigned = (blueprintId: string, t: TargetKey): boolean =>
  !!db().get('SELECT 1 FROM plant_blueprint_assignments WHERE blueprint_id = ? AND target_kind = ? AND target_id = ?', blueprintId, t.kind, t.id);

/** The mappings of a target (signal → data point), per blueprint. */
export function mappingsOf(t: TargetKey): StoredMapping[] {
  return db()
    .all<{ blueprint_id: string; signal_id: string; data_point_id: string }>(
      'SELECT blueprint_id, signal_id, data_point_id FROM plant_blueprint_mappings WHERE target_kind = ? AND target_id = ? ORDER BY blueprint_id, signal_id, data_point_id',
      t.kind,
      t.id,
    )
    .map((r) => ({ blueprint: r.blueprint_id, signal: r.signal_id, dataPoint: r.data_point_id }));
}

/** The not-applicable marks of a target. */
export function marksOf(t: TargetKey): StoredMark[] {
  return db()
    .all<{ blueprint_id: string; signal_id: string; reason: string; marked_by: string; marked_at: string }>(
      'SELECT blueprint_id, signal_id, reason, marked_by, marked_at FROM plant_blueprint_not_applicable WHERE target_kind = ? AND target_id = ? ORDER BY blueprint_id, signal_id',
      t.kind,
      t.id,
    )
    .map((r) => ({ blueprint: r.blueprint_id, signal: r.signal_id, reason: r.reason, by: r.marked_by, at: r.marked_at }));
}

/** The key a target is grouped by in the bulk readers below. */
export const targetKey = (t: TargetKey): string => `${t.kind}:${t.id}`;

/** Every assignment, by target (the matrix reads them once instead of once per asset). */
export function allAssignments(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of db().all<{ blueprint_id: string; target_kind: BlueprintTargetKind; target_id: string }>(
    'SELECT blueprint_id, target_kind, target_id FROM plant_blueprint_assignments ORDER BY created_at, blueprint_id',
  )) {
    const k = targetKey({ kind: r.target_kind, id: r.target_id });
    out.set(k, [...(out.get(k) ?? []), r.blueprint_id]);
  }
  return out;
}

/** Every mapping, by target. */
export function allMappings(): Map<string, StoredMapping[]> {
  const out = new Map<string, StoredMapping[]>();
  for (const r of db().all<{ blueprint_id: string; target_kind: BlueprintTargetKind; target_id: string; signal_id: string; data_point_id: string }>(
    'SELECT blueprint_id, target_kind, target_id, signal_id, data_point_id FROM plant_blueprint_mappings ORDER BY blueprint_id, signal_id, data_point_id',
  )) {
    const k = targetKey({ kind: r.target_kind, id: r.target_id });
    out.set(k, [...(out.get(k) ?? []), { blueprint: r.blueprint_id, signal: r.signal_id, dataPoint: r.data_point_id }]);
  }
  return out;
}

/** Every not-applicable mark, by target. */
export function allMarks(): Map<string, StoredMark[]> {
  const out = new Map<string, StoredMark[]>();
  for (const r of db().all<{
    blueprint_id: string;
    target_kind: BlueprintTargetKind;
    target_id: string;
    signal_id: string;
    reason: string;
    marked_by: string;
    marked_at: string;
  }>(
    'SELECT blueprint_id, target_kind, target_id, signal_id, reason, marked_by, marked_at FROM plant_blueprint_not_applicable ORDER BY blueprint_id, signal_id',
  )) {
    const k = targetKey({ kind: r.target_kind, id: r.target_id });
    out.set(k, [...(out.get(k) ?? []), { blueprint: r.blueprint_id, signal: r.signal_id, reason: r.reason, by: r.marked_by, at: r.marked_at }]);
  }
  return out;
}

// ---------- writing ----------

/** A blueprint with its signals: the row, and the signals as listed (others are removed with their mappings and marks). */
export function writeBlueprint(v: PlantBlueprintValues, m: BlueprintMeta, opts: { keepSource?: boolean } = {}): void {
  db().run(
    `INSERT INTO plant_blueprints (id, name, description, reference, version, import_id, not_in_source, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, reference = excluded.reference, version = excluded.version,
       ${opts.keepSource ? '' : 'import_id = excluded.import_id, not_in_source = excluded.not_in_source,'} updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    v.id,
    v.name,
    v.description,
    v.reference,
    v.version,
    m.importId ?? null,
    m.notInSource ? 1 : 0,
    m.at,
    m.by,
    m.at,
    m.by,
  );
  const keep = new Set(v.signals.map((s) => s.id));
  for (const r of db().all<{ id: string }>('SELECT id FROM plant_blueprint_signals WHERE blueprint_id = ?', v.id))
    if (!keep.has(r.id)) removeSignalRows(v.id, r.id);
  v.signals.forEach((s, position) =>
    db().run(
      `INSERT INTO plant_blueprint_signals (blueprint_id, id, position, name, meaning, why, importance, aliases, kpis) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (blueprint_id, id) DO UPDATE SET position = excluded.position, name = excluded.name, meaning = excluded.meaning, why = excluded.why,
         importance = excluded.importance, aliases = excluded.aliases, kpis = excluded.kpis`,
      v.id,
      s.id,
      position,
      s.name,
      s.meaning,
      JSON.stringify(s.why),
      s.importance,
      JSON.stringify(s.aliases),
      JSON.stringify(s.kpis ?? []),
    ),
  );
}

/** A signal's row and what refers to it (mappings, marks). */
export function removeSignalRows(blueprintId: string, signalId: string): void {
  db().run('DELETE FROM plant_blueprint_signals WHERE blueprint_id = ? AND id = ?', blueprintId, signalId);
  db().run('DELETE FROM plant_blueprint_mappings WHERE blueprint_id = ? AND signal_id = ?', blueprintId, signalId);
  db().run('DELETE FROM plant_blueprint_not_applicable WHERE blueprint_id = ? AND signal_id = ?', blueprintId, signalId);
}

export function addAssignment(blueprintId: string, t: TargetKey, at: string, by: string): boolean {
  if (isAssigned(blueprintId, t)) return false;
  db().run(
    'INSERT INTO plant_blueprint_assignments (blueprint_id, target_kind, target_id, created_at, created_by) VALUES (?, ?, ?, ?, ?)',
    blueprintId,
    t.kind,
    t.id,
    at,
    by,
  );
  return true;
}

/**
 * Takes a blueprint off a profile or an asset, with that target's own mappings and marks. Taken off a profile, the
 * mappings and marks its assets made for the blueprint stay (the caller may not manage those assets); they are not shown,
 * counted or exported while the blueprint is not assigned to the asset, and they return when it is assigned again.
 */
export function removeAssignment(blueprintId: string, t: TargetKey): boolean {
  const had = isAssigned(blueprintId, t);
  db().run('DELETE FROM plant_blueprint_assignments WHERE blueprint_id = ? AND target_kind = ? AND target_id = ?', blueprintId, t.kind, t.id);
  clearTarget(blueprintId, t);
  return had;
}

function clearTarget(blueprintId: string, t: TargetKey): void {
  for (const table of ['plant_blueprint_mappings', 'plant_blueprint_not_applicable'])
    db().run(`DELETE FROM ${table} WHERE blueprint_id = ? AND target_kind = ? AND target_id = ?`, blueprintId, t.kind, t.id);
}

/** Replaces the data points one signal is mapped to on a target; whether anything changed. */
export function setMapping(blueprintId: string, t: TargetKey, signalId: string, points: string[], at: string, by: string): boolean {
  const before = db()
    .all<{ data_point_id: string }>(
      'SELECT data_point_id FROM plant_blueprint_mappings WHERE blueprint_id = ? AND target_kind = ? AND target_id = ? AND signal_id = ?',
      blueprintId,
      t.kind,
      t.id,
      signalId,
    )
    .map((r) => r.data_point_id);
  const next = [...new Set(points)].slice(0, BLUEPRINT_LIMITS.pointsPerSignal);
  if (before.length === next.length && before.every((x) => next.includes(x))) return false;
  db().run(
    'DELETE FROM plant_blueprint_mappings WHERE blueprint_id = ? AND target_kind = ? AND target_id = ? AND signal_id = ?',
    blueprintId,
    t.kind,
    t.id,
    signalId,
  );
  for (const p of next)
    db().run(
      'INSERT INTO plant_blueprint_mappings (blueprint_id, target_kind, target_id, signal_id, data_point_id, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      blueprintId,
      t.kind,
      t.id,
      signalId,
      p,
      at,
      by,
    );
  return true;
}

export function pointsMapped(blueprintId: string, t: TargetKey, signalId: string): string[] {
  return db()
    .all<{ data_point_id: string }>(
      'SELECT data_point_id FROM plant_blueprint_mappings WHERE blueprint_id = ? AND target_kind = ? AND target_id = ? AND signal_id = ? ORDER BY data_point_id',
      blueprintId,
      t.kind,
      t.id,
      signalId,
    )
    .map((r) => r.data_point_id);
}

export function markOf(blueprintId: string, t: TargetKey, signalId: string): StoredMark | undefined {
  return marksOf(t).find((m) => m.blueprint === blueprintId && m.signal === signalId);
}

export function setMark(blueprintId: string, t: TargetKey, signalId: string, reason: string, at: string, by: string): void {
  db().run(
    `INSERT INTO plant_blueprint_not_applicable (blueprint_id, target_kind, target_id, signal_id, reason, marked_by, marked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (blueprint_id, target_kind, target_id, signal_id) DO UPDATE SET reason = excluded.reason, marked_by = excluded.marked_by, marked_at = excluded.marked_at`,
    blueprintId,
    t.kind,
    t.id,
    signalId,
    reason,
    by,
    at,
  );
}

export function clearMark(blueprintId: string, t: TargetKey, signalId: string): boolean {
  return (
    db().run(
      'DELETE FROM plant_blueprint_not_applicable WHERE blueprint_id = ? AND target_kind = ? AND target_id = ? AND signal_id = ?',
      blueprintId,
      t.kind,
      t.id,
      signalId,
    ).changes > 0
  );
}

// ---------- removing ----------

/** What blueprints say about a profile or an asset goes with it. */
export function forgetTarget(t: TargetKey): void {
  for (const table of ['plant_blueprint_assignments', 'plant_blueprint_mappings', 'plant_blueprint_not_applicable'])
    db().run(`DELETE FROM ${table} WHERE target_kind = ? AND target_id = ?`, t.kind, t.id);
}

/** A removed blueprint: its signals, assignments, mappings, marks, owning teams, shares and Restricted scope. */
export function removeBlueprintRow(id: string): void {
  for (const table of ['plant_blueprint_signals', 'plant_blueprint_assignments', 'plant_blueprint_mappings', 'plant_blueprint_not_applicable'])
    db().run(`DELETE FROM ${table} WHERE blueprint_id = ?`, id);
  db().run('DELETE FROM plant_blueprints WHERE id = ?', id);
  for (const table of ['resource_teams', 'resource_shares', 'resource_restrictions'])
    db().run(`DELETE FROM ${table} WHERE kind = 'blueprint' AND resource_id = ?`, id);
  teamsChanged();
  sharesChanged();
}
