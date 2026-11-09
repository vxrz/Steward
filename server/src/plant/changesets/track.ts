import { createHash } from 'node:crypto';
import { PLANT_ENTRY_KINDS, sameValue, type PlantEntryKind, type PlantIdKind } from '@sm/shared';
import { db } from '../../db.js';
import { newId, nowIso, parseJson } from '../../util.js';
import { setRenameListener, type RenameOf } from '../rename.js';
import { ASSET_SCOPED, KINDS, PER_ASSET, SITE_SCOPED, entryKey, type EntrySnap } from './entries.js';

/**
 * What a change does to the entries of the plant registry (0.13.0, ADR 0020): the entries a change can reach are read
 * before and after it, in its transaction, and compared. Every entry that changed gets its revision raised by one (a
 * write that changes nothing raises nothing) and one row of history with the full values of its changed fields before
 * and after – whatever wrote it: an edit form, the import, a bulk change, the rename or removal core. Renames are
 * followed (the rename core says what it renamed), so a renamed entry is one entry with a new id, not a removal and an
 * addition.
 */

/** What a change may reach: everything, sites (their rows, hierarchy, buildings, OT network and assets), assets (with
 * their assignments, checks, devices, data paths and collections), the catalogue, or every assignment. */
export interface Region {
  all?: boolean;
  sites?: string[];
  assets?: string[];
  catalogue?: boolean;
  assignments?: boolean;
}

export interface EntryChange {
  kind: PlantEntryKind;
  scope: string;
  id: string;
  name: string;
  siteId: string;
  op: 'add' | 'set' | 'remove' | 'rename';
  /** rename: the key before */
  from?: { scope: string; id: string };
  /** The changed fields before and after (add: everything after; remove: everything before) */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** The revision the entry has now (remove: the last one) */
  revision: number;
}

type Row = Record<string, unknown>;
const marks = (k: number) => Array.from({ length: k }, () => '?').join(', ');

/** Rows of a table where a column is one of the values (in chunks). */
function rowsIn(table: string, column: string, values: string[]): Row[] {
  const out: Row[] = [];
  const uniq = [...new Set(values)];
  for (let i = 0; i < uniq.length; i += 500) {
    const chunk = uniq.slice(i, i + 500);
    if (chunk.length) out.push(...db().all<Row>(`SELECT * FROM ${table} WHERE ${column} IN (${marks(chunk.length)})`, ...chunk));
  }
  return out;
}

/** The entries of a region, by key. */
export function snapshot(region: Region): Map<string, EntrySnap> {
  const out = new Map<string, EntrySnap>();
  const put = (list: EntrySnap[]) => list.forEach((e) => out.set(entryKey(e), e));
  const sites = region.sites ?? [];
  // the assets of the sites, and those named
  const assetRows = region.all
    ? db().all<Row>('SELECT * FROM plant_assets')
    : [...rowsIn('plant_assets', 'site_id', sites), ...rowsIn('plant_assets', 'id', region.assets ?? [])];
  for (const kind of PLANT_ENTRY_KINDS) {
    const d = KINDS[kind];
    let rows: Row[];
    if (region.all) rows = kind === 'asset' ? assetRows : db().all<Row>(`SELECT * FROM ${d.table}`);
    else if (kind === 'site') rows = rowsIn(d.table, 'id', sites);
    else if (SITE_SCOPED.includes(kind)) rows = rowsIn(d.table, 'site_id', sites);
    else if (kind === 'asset') rows = assetRows;
    else if (kind === 'profile' || kind === 'kpi') rows = region.catalogue ? db().all<Row>(`SELECT * FROM ${d.table}`) : [];
    else if (kind === 'assignment' && region.assignments) rows = db().all<Row>(`SELECT * FROM ${d.table}`);
    else rows = rowsIn(d.table, 'asset_id', region.assets ?? []);
    put(d.read(rows));
  }
  return out;
}

// ---------- the tracker ----------

interface Active {
  renames: RenameOf[];
}
let active: Active | null = null;
setRenameListener((r) => active?.renames.push(r));

/** Where an entry of before is after the renames (in their order). */
function follow(e: { kind: PlantEntryKind; scope: string; id: string }, renames: RenameOf[]): { scope: string; id: string } {
  let { scope, id } = e;
  for (const r of renames) {
    const k = r.kind as PlantIdKind;
    if ((k as string) === e.kind && r.scope === scope && r.from === id) id = r.to;
    else if (k === 'site' && SITE_SCOPED.includes(e.kind) && scope === r.from) scope = r.to;
    else if (k === 'asset' && ASSET_SCOPED.includes(e.kind) && scope === r.from) scope = r.to;
    else if (k === 'asset' && PER_ASSET.includes(e.kind) && id === r.from) id = r.to;
  }
  return { scope, id };
}

const changedFields = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !sameValue(a[k], b[k]));
const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));

/** The entries that differ between two snapshots (renames followed). */
export function compare(before: Map<string, EntrySnap>, after: Map<string, EntrySnap>, renames: RenameOf[]): (EntryChange & { prev: EntrySnap | null })[] {
  const out: (EntryChange & { prev: EntrySnap | null })[] = [];
  const seen = new Set<string>();
  for (const b of before.values()) {
    const to = follow(b, renames);
    const k = entryKey({ kind: b.kind, ...to });
    const a = after.get(k);
    seen.add(k);
    const renamed = to.id !== b.id || to.scope !== b.scope;
    if (!a) {
      out.push({
        kind: b.kind,
        scope: b.scope,
        id: b.id,
        name: b.name,
        siteId: b.siteId,
        op: 'remove',
        before: b.values,
        after: null,
        revision: b.revision,
        prev: b,
      });
      continue;
    }
    const fields = changedFields(b.values, a.values);
    if (!fields.length && !renamed) continue;
    out.push({
      kind: a.kind,
      scope: a.scope,
      id: a.id,
      name: a.name,
      siteId: a.siteId,
      op: renamed && to.id !== b.id ? 'rename' : 'set',
      ...(renamed ? { from: { scope: b.scope, id: b.id } } : {}),
      before: pick(b.values, fields),
      after: pick(a.values, fields),
      revision: b.revision + 1,
      prev: b,
    });
  }
  for (const [k, a] of after) {
    if (seen.has(k)) continue;
    out.push({
      kind: a.kind,
      scope: a.scope,
      id: a.id,
      name: a.name,
      siteId: a.siteId,
      op: 'add',
      before: null,
      after: a.values,
      revision: a.revision,
      prev: null,
    });
  }
  return out;
}

export interface Tracked<T> {
  result: T;
  changes: EntryChange[];
  /** SHA-256 of the history rows written (the audit entry carries it) */
  historySha256: string;
}

export interface TrackMeta {
  changeSetId: string;
  /** Who wrote the change (the change set's authors) and who applied it */
  author: string;
  appliedBy: string;
  at?: string;
  /** Write nothing of its own (a preview): compare only */
  dryRun?: boolean;
}

/**
 * Runs fn (inside a transaction) and keeps track of what it did to the entries of the region: raises the revisions of
 * the entries that changed and writes their history. Must run inside db().tx (the caller's transaction).
 */
export function tracked<T>(region: Region, meta: TrackMeta, fn: () => T): Tracked<T> {
  if (!db().inTransaction) throw new Error('tracked() runs inside a transaction');
  if (active) {
    // nested (an import inside a change set's apply): the outer tracker sees everything
    return { result: fn(), changes: [], historySha256: '' };
  }
  const before = snapshot(region);
  const me: Active = { renames: [] };
  active = me;
  let result: T;
  try {
    result = fn();
  } finally {
    active = null;
  }
  // a site or asset renamed takes its own region along
  const after = snapshot(widen(region, me.renames));
  // in a fixed order (kind, scope, id): the hash of the history rows can be computed again from the database
  const order = (c: { kind: string; scope: string; id: string }) => [c.kind, c.scope, c.id];
  const list = compare(before, after, me.renames).sort((a, b) => {
    const x = order(a);
    const y = order(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
    return 0;
  });
  if (meta.dryRun) return { result, changes: list.map(({ prev: _p, ...c }) => c), historySha256: '' };
  const at = meta.at ?? nowIso();
  const hash = createHash('sha256');
  for (const c of list) {
    const d = KINDS[c.kind];
    if (c.op === 'set' || c.op === 'rename') {
      if (d.scopeCol) db().run(`UPDATE ${d.table} SET revision = ? WHERE ${d.scopeCol} = ? AND ${d.idCol} = ?`, c.revision, c.scope, c.id);
      else db().run(`UPDATE ${d.table} SET revision = ? WHERE ${d.idCol} = ?`, c.revision, c.id);
    }
    const id = newId('peh_');
    const beforeJson = JSON.stringify(c.before);
    const afterJson = JSON.stringify(c.after);
    db().run(
      `INSERT INTO plant_entry_history (id, kind, scope, entry_id, revision, change_set_id, op, at, author, applied_by, before_values, after_values, removed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      c.kind,
      c.scope,
      c.id,
      c.revision,
      meta.changeSetId,
      c.op,
      at,
      meta.author,
      meta.appliedBy,
      beforeJson,
      afterJson,
      c.op === 'remove' ? at : null,
    );
    // the history of a removed entry is kept for the retention period from now (a later entry with its id starts anew);
    // its baseline goes with it
    if (c.op === 'remove') db().run('DELETE FROM plant_import_baselines WHERE kind = ? AND scope = ? AND entry_id = ?', c.kind, c.scope, c.id);
    if (c.op === 'remove')
      db().run('UPDATE plant_entry_history SET removed_at = ? WHERE kind = ? AND scope = ? AND entry_id = ? AND removed_at IS NULL', at, c.kind, c.scope, c.id);
    if (c.op === 'add') db().run('UPDATE plant_entry_history SET removed_at = NULL WHERE kind = ? AND scope = ? AND entry_id = ?', c.kind, c.scope, c.id);
    hash.update(`${c.kind}\u0000${c.scope}\u0000${c.id}\u0000${c.revision}\u0000${c.op}\u0000${beforeJson}\u0000${afterJson}\n`);
  }
  return { result, changes: list.map(({ prev: _p, ...c }) => c), historySha256: list.length ? hash.digest('hex') : '' };
}

/** The region after renames: a renamed site or asset is read under its new id, too. */
function widen(r: Region, renames: RenameOf[]): Region {
  if (r.all || !renames.length) return r;
  const sites = [...(r.sites ?? [])];
  const assets = [...(r.assets ?? [])];
  for (const x of renames) {
    if (x.kind === 'site' && sites.includes(x.from)) sites.push(x.to);
    if (x.kind === 'asset' && assets.includes(x.from)) assets.push(x.to);
  }
  return { ...r, sites, assets };
}

// ---------- baselines: what the last import wrote ----------

/**
 * After an import: the values it left in every entry it wrote (the rows with its import id), per entry – the baselines
 * of the import's flags "changed in Steward since the last import" (phase 2). One upsert per entry, in the import's
 * transaction; removed entries lose theirs.
 */
export function recordBaselines(importId: string): number {
  const at = nowIso();
  let n = 0;
  for (const kind of PLANT_ENTRY_KINDS) {
    const d = KINDS[kind];
    const cols = db().all<{ c: number }>(`SELECT COUNT(*) AS c FROM ${d.table} WHERE import_id = ?`, importId);
    if (!Number(cols[0]?.c ?? 0)) continue;
    for (const e of d.read(db().all<Row>(`SELECT * FROM ${d.table} WHERE import_id = ?`, importId))) {
      db().run(
        `INSERT INTO plant_import_baselines (kind, scope, entry_id, field_values, import_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (kind, scope, entry_id) DO UPDATE SET field_values = excluded.field_values, import_id = excluded.import_id, updated_at = excluded.updated_at`,
        e.kind,
        e.scope,
        e.id,
        JSON.stringify(e.values),
        importId,
        at,
      );
      n++;
    }
  }
  return n;
}

export const baselineOf = (kind: PlantEntryKind, scope: string, id: string): { values: Record<string, unknown>; importId: string } | null => {
  const r = db().get<{ field_values: string; import_id: string }>(
    'SELECT field_values, import_id FROM plant_import_baselines WHERE kind = ? AND scope = ? AND entry_id = ?',
    kind,
    scope,
    id,
  );
  return r ? { values: parseJson(r.field_values, {}), importId: r.import_id } : null;
};
