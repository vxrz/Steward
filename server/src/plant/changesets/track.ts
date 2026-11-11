import { createHash } from 'node:crypto';
import { PLANT_ENTRY_KINDS, sameValue, type PlantEntryKind, type PlantIdKind } from '@sm/shared';
import { db } from '../../db.js';
import { newId, nowIso } from '../../util.js';
import { refsOf } from '../model.js';
import { setRenameListener, type MovedOf, type RenameOf } from '../rename.js';
import { ASSET_SCOPED, KINDS, PER_ASSET, SITE_SCOPED, entryKey, readEntry, type EntrySnap } from './entries.js';
import { historyRetention } from './retention.js';
import { historyText, historyValues, storedValues } from './values.js';

/**
 * What a change does to the entries of the plant registry (0.13.0, ADR 0020): the entries a change can reach are read
 * before and after it, in its transaction, and compared. Every entry that changed gets its revision raised by one (a
 * write that changes nothing raises nothing) and one row of history with the full values of its changed fields before
 * and after – whatever wrote it: an edit form, the import, a bulk change, the rename or removal core. Renames are
 * followed (the rename core says what it renamed), so a renamed entry is one entry with a new id, not a removal and an
 * addition; 0.16: a moved entry (a device, data path or data collection to another asset) is one entry under its new
 * asset (op `move`, its old and new asset as the field `asset`).
 */

/** What a change may reach: everything, sites (their rows, hierarchy, buildings, OT network and assets), assets (with
 * their assignments, checks, devices, data paths and collections), the catalogue, every assignment, or single entries
 * (an edit form's save of an entry whose service writes nothing else). */
export interface Region {
  all?: boolean;
  /** With `all`: only these kinds (an import whose files hold only some kinds and remove and rename nothing) */
  kinds?: PlantEntryKind[];
  sites?: string[];
  assets?: string[];
  catalogue?: boolean;
  assignments?: boolean;
  entries?: { kind: PlantEntryKind; scope: string; id: string }[];
}

/** Two regions as one. */
export function joinRegions(a: Region, b: Region): Region {
  const empty = (r: Region) => !r.all && !r.sites?.length && !r.assets?.length && !r.catalogue && !r.assignments && !r.entries?.length;
  if (empty(a)) return b;
  if (empty(b)) return a;
  if (a.all && b.all && a.kinds && b.kinds) return { all: true, kinds: [...new Set([...a.kinds, ...b.kinds])] };
  if (a.all || b.all) return { all: true };
  const list = <T>(x: T[] | undefined, y: T[] | undefined) => (x?.length || y?.length ? [...(x ?? []), ...(y ?? [])] : undefined);
  const out: Region = {};
  const sites = list(a.sites, b.sites);
  const assets = list(a.assets, b.assets);
  const entries = list(a.entries, b.entries);
  if (sites) out.sites = [...new Set(sites)];
  if (assets) out.assets = [...new Set(assets)];
  if (entries) out.entries = entries;
  if (a.catalogue || b.catalogue) out.catalogue = true;
  if (a.assignments || b.assignments) out.assignments = true;
  return out;
}

export interface EntryChange {
  kind: PlantEntryKind;
  scope: string;
  id: string;
  name: string;
  siteId: string;
  op: 'add' | 'set' | 'remove' | 'rename' | 'move';
  /** rename and move: the key before */
  from?: { scope: string; id: string };
  /** The changed fields before and after (add: everything after; remove: everything before) */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** The revision the entry has now (remove: the last one) */
  revision: number;
}

type Row = Record<string, unknown>;
const marks = (k: number) => Array.from({ length: k }, () => '?').join(', ');
const str = (v: unknown) => String(v ?? '');

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

/**
 * An entry as stored: its row and, for sites and assets, its external references – everything its values are computed
 * from. Two equal raw entries have equal values, so only the entries whose rows differ are turned into values (the
 * costly part of a snapshot of a large registry).
 */
interface RawEntry {
  kind: PlantEntryKind;
  scope: string;
  id: string;
  row: Row;
  /** Sites and assets: their external references (as JSON) */
  refs: string | null;
}

/** Whether two raw entries are stored the same (their values are then the same). */
function sameRaw(a: RawEntry, b: RawEntry): boolean {
  if (a.refs !== b.refs) return false;
  const keys = Object.keys(a.row);
  if (keys.length !== Object.keys(b.row).length) return false;
  for (const k of keys) {
    const x = a.row[k];
    const y = b.row[k];
    if (x !== y && !(x instanceof Uint8Array && y instanceof Uint8Array && Buffer.compare(x, y) === 0)) return false;
  }
  return true;
}

const keyOfRow = (kind: PlantEntryKind, r: Row) => {
  const d = KINDS[kind];
  return { kind, scope: d.scopeCol ? str(r[d.scopeCol]) : '', id: str(r[d.idCol]) };
};

/** The stored entries of a region, by key (rows only; values are computed for what changed). */
function rawSnapshot(region: Region): Map<string, RawEntry> {
  const out = new Map<string, RawEntry>();
  const sites = region.sites ?? [];
  // the assets of the sites, and those named
  const wanted = (k: PlantEntryKind) => !region.all || !region.kinds || region.kinds.includes(k);
  const assetRows = region.all
    ? wanted('asset')
      ? db().all<Row>('SELECT * FROM plant_assets')
      : []
    : [...rowsIn('plant_assets', 'site_id', sites), ...rowsIn('plant_assets', 'id', region.assets ?? [])];
  const single = new Map<PlantEntryKind, { scope: string; id: string }[]>();
  if (!region.all) for (const e of region.entries ?? []) single.set(e.kind, [...(single.get(e.kind) ?? []), { scope: e.scope, id: e.id }]);
  for (const kind of PLANT_ENTRY_KINDS) {
    if (!wanted(kind)) continue;
    const d = KINDS[kind];
    let rows: Row[];
    if (region.all) rows = kind === 'asset' ? assetRows : db().all<Row>(`SELECT * FROM ${d.table}`);
    else if (kind === 'site') rows = rowsIn(d.table, 'id', sites);
    else if (SITE_SCOPED.includes(kind)) rows = rowsIn(d.table, 'site_id', sites);
    else if (kind === 'asset') rows = assetRows;
    else if (kind === 'profile' || kind === 'kpi') rows = region.catalogue ? db().all<Row>(`SELECT * FROM ${d.table}`) : [];
    else if (kind === 'assignment' && region.assignments) rows = db().all<Row>(`SELECT * FROM ${d.table}`);
    else rows = rowsIn(d.table, 'asset_id', region.assets ?? []);
    // single entries: by their id, the scope checked here
    const named = single.get(kind);
    if (named?.length) {
      const want = new Set(named.map((x) => entryKey({ kind, ...x })));
      rows = [
        ...rows,
        ...rowsIn(
          d.table,
          d.idCol,
          named.map((x) => x.id),
        ).filter((r) => want.has(entryKey(keyOfRow(kind, r)))),
      ];
    }
    const refs = kind === 'site' || kind === 'asset' ? refsOf(kind, [...new Set(rows.map((r) => str(r.id)))]) : null;
    for (const r of rows) {
      const k = keyOfRow(kind, r);
      out.set(entryKey(k), { ...k, row: r, refs: refs ? JSON.stringify(refs.get(str(r.id)) ?? []) : null });
    }
  }
  return out;
}

/**
 * The values of raw entries (one read per kind). A site's or asset's external references are those of the snapshot:
 * read again after the change, a removed entry's (or a changed list's) would be what is stored now.
 */
function snapsOf(list: RawEntry[]): Map<string, EntrySnap> {
  const out = new Map<string, EntrySnap>();
  const byKind = new Map<PlantEntryKind, Row[]>();
  for (const e of list) byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e.row]);
  const refs = new Map(list.filter((e) => e.refs !== null).map((e) => [entryKey(e), e.refs!]));
  for (const [kind, rows] of byKind)
    for (const e of KINDS[kind].read(rows)) {
      const k = entryKey(e);
      const r = refs.get(k);
      out.set(k, r === undefined ? e : { ...e, values: { ...e.values, refs: JSON.parse(r) as unknown } });
    }
  return out;
}

/** The entries of a region, by key, with their values. */
export function snapshot(region: Region): Map<string, EntrySnap> {
  return snapsOf([...rawSnapshot(region).values()]);
}

// ---------- the tracker ----------

interface Active {
  renames: (RenameOf | MovedOf)[];
}
let active: Active | null = null;
setRenameListener((r) => active?.renames.push(r));

/** Where an entry of before is after the renames and moves (in their order); `moved`: it went to another asset itself. */
function follow(e: { kind: PlantEntryKind; scope: string; id: string }, renames: (RenameOf | MovedOf)[]): { scope: string; id: string; moved: boolean } {
  let { scope, id } = e;
  let moved = false;
  for (const r of renames) {
    const k = r.kind as PlantIdKind;
    if ((k as string) === e.kind && r.scope === scope && r.from === id) {
      id = r.to;
      if (r.toScope !== undefined && r.toScope !== scope) {
        scope = r.toScope;
        moved = true;
      }
    } else if (k === 'site' && SITE_SCOPED.includes(e.kind) && scope === r.from) scope = r.to;
    else if (k === 'asset' && ASSET_SCOPED.includes(e.kind) && scope === r.from) scope = r.to;
    else if (k === 'asset' && PER_ASSET.includes(e.kind) && id === r.from) id = r.to;
  }
  return { scope, id, moved };
}

const changedFields = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !sameValue(a[k], b[k]));
const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));

/**
 * The entries that differ between two snapshots (renames followed). Entries whose rows (and references) are the same
 * are left out before their values are computed; the others are compared by their values, field by field.
 */
function compare(before: Map<string, RawEntry>, after: Map<string, RawEntry>, renames: (RenameOf | MovedOf)[]): EntryChange[] {
  // what differs, by the stored rows: removed, added, renamed or rows not the same
  const pairs: { b: RawEntry; a: RawEntry | undefined; to: { scope: string; id: string; moved: boolean } }[] = [];
  const seen = new Set<string>();
  for (const b of before.values()) {
    const to = follow(b, renames);
    const k = entryKey({ kind: b.kind, ...to });
    const a = after.get(k);
    seen.add(k);
    const renamed = to.id !== b.id || to.scope !== b.scope;
    if (a && !renamed && sameRaw(a, b)) continue;
    pairs.push({ b, a, to });
  }
  const added = [...after.entries()].filter(([k]) => !seen.has(k)).map(([, a]) => a);
  // their values (one read per kind and side)
  const was = snapsOf(pairs.map((p) => p.b));
  const is = snapsOf([...pairs.flatMap((p) => (p.a ? [p.a] : [])), ...added]);
  const out: EntryChange[] = [];
  for (const { b: raw, a: rawAfter, to } of pairs) {
    const b = was.get(entryKey(raw))!;
    if (!rawAfter) {
      out.push({ kind: b.kind, scope: b.scope, id: b.id, name: b.name, siteId: b.siteId, op: 'remove', before: b.values, after: null, revision: b.revision });
      continue;
    }
    const a = is.get(entryKey(rawAfter))!;
    const renamed = to.id !== b.id || to.scope !== b.scope;
    const fields = changedFields(b.values, a.values);
    if (!fields.length && !renamed) continue;
    // a move shows (and its history keeps) the asset it left and the one it is on now
    const where = to.moved ? (side: string) => ({ asset: side }) : () => ({});
    out.push({
      kind: a.kind,
      scope: a.scope,
      id: a.id,
      name: a.name,
      siteId: a.siteId,
      op: to.moved ? 'move' : renamed && to.id !== b.id ? 'rename' : 'set',
      ...(renamed ? { from: { scope: b.scope, id: b.id } } : {}),
      before: { ...where(b.scope), ...pick(b.values, fields) },
      after: { ...where(a.scope), ...pick(a.values, fields) },
      revision: b.revision + 1,
    });
  }
  for (const raw of added) {
    const a = is.get(entryKey(raw))!;
    out.push({ kind: a.kind, scope: a.scope, id: a.id, name: a.name, siteId: a.siteId, op: 'add', before: null, after: a.values, revision: a.revision });
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

/** Rows per multi-row statement (13 values a history row: far below the parameter limits of SQLite and PostgreSQL). */
const BATCH = 200;
const chunks = <T>(list: T[], size = BATCH): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
/** Lists grouped by a key (in the order of their first item). */
function groupBy<T>(list: T[], key: (x: T) => string): T[][] {
  const out = new Map<string, T[]>();
  for (const x of list) out.set(key(x), [...(out.get(key(x)) ?? []), x]);
  return [...out.values()];
}

/**
 * Runs fn (inside a transaction) and keeps track of what it did to the entries of the region: raises the revisions of
 * the entries that changed and writes their history. Must run inside db().tx (the caller's transaction). The writes
 * are batched per kind (one statement per up to 200 entries: every statement crosses the PostgreSQL bridge).
 */
export function tracked<T>(region: Region, meta: TrackMeta, fn: () => T): Tracked<T> {
  if (!db().inTransaction) throw new Error('tracked() runs inside a transaction');
  if (active) {
    // nested (an import inside a change set's apply): the outer tracker sees everything
    return { result: fn(), changes: [], historySha256: '' };
  }
  const before = rawSnapshot(region);
  const me: Active = { renames: [] };
  active = me;
  let result: T;
  try {
    result = fn();
  } finally {
    active = null;
  }
  // a site or asset renamed takes its own region along
  const after = rawSnapshot(widen(region, me.renames));
  // in a fixed order (kind, scope, id): the hash of the history rows can be computed again from the database
  const order = (c: { kind: string; scope: string; id: string }) => [c.kind, c.scope, c.id];
  const list = compare(before, after, me.renames).sort((a, b) => {
    const x = order(a);
    const y = order(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
    return 0;
  });
  if (meta.dryRun) return { result, changes: list, historySha256: '' };
  const at = meta.at ?? nowIso();
  const hash = createHash('sha256');
  const rows = list.map((c) => ({ c, beforeJson: JSON.stringify(c.before), afterJson: JSON.stringify(c.after) }));
  // the revisions reached, per table, scope and revision
  for (const group of groupBy(
    list.filter((c) => c.op === 'set' || c.op === 'rename' || c.op === 'move'),
    (c) => `${c.kind}\u0000${c.scope}\u0000${c.revision}`,
  )) {
    const { kind, scope, revision } = group[0]!;
    const d = KINDS[kind];
    for (const part of chunks(group.map((c) => c.id)))
      if (d.scopeCol)
        db().run(`UPDATE ${d.table} SET revision = ? WHERE ${d.scopeCol} = ? AND ${d.idCol} IN (${marks(part.length)})`, revision, scope, ...part);
      else db().run(`UPDATE ${d.table} SET revision = ? WHERE ${d.idCol} IN (${marks(part.length)})`, revision, ...part);
  }
  for (const part of chunks(rows)) {
    db().run(
      `INSERT INTO plant_entry_history (id, kind, scope, entry_id, revision, change_set_id, op, at, author, applied_by, before_values, after_values, removed_at)
       VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      ...part.flatMap(({ c, beforeJson, afterJson }) => [
        newId('peh_'),
        c.kind,
        c.scope,
        c.id,
        c.revision,
        meta.changeSetId,
        c.op,
        at,
        meta.author,
        meta.appliedBy,
        storedValues(beforeJson),
        storedValues(afterJson),
        c.op === 'remove' ? at : null,
      ]),
    );
  }
  // the history of a removed entry is kept for the retention period from now (a later entry with its id starts anew);
  // its baseline goes with it
  for (const group of groupBy(
    list.filter((c) => c.op === 'remove' || c.op === 'add'),
    (c) => `${c.op}\u0000${c.kind}\u0000${c.scope}`,
  )) {
    const { op, kind, scope } = group[0]!;
    for (const part of chunks(
      group.map((c) => c.id),
      500,
    )) {
      const ids = marks(part.length);
      if (op === 'remove') {
        db().run(`DELETE FROM plant_entry_baselines WHERE kind = ? AND scope = ? AND entry_id IN (${ids})`, kind, scope, ...part);
        db().run(`DELETE FROM plant_import_baselines WHERE kind = ? AND scope = ? AND entry_id IN (${ids})`, kind, scope, ...part);
        db().run(
          `UPDATE plant_entry_history SET removed_at = ? WHERE kind = ? AND scope = ? AND entry_id IN (${ids}) AND removed_at IS NULL`,
          at,
          kind,
          scope,
          ...part,
        );
      } else
        db().run(
          `UPDATE plant_entry_history SET removed_at = NULL WHERE kind = ? AND scope = ? AND entry_id IN (${ids}) AND removed_at IS NOT NULL`,
          kind,
          scope,
          ...part,
        );
    }
  }
  for (const { c, beforeJson, afterJson } of rows) hash.update(historyLine(c.kind, c.scope, c.id, c.revision, c.op, beforeJson, afterJson));
  return { result, changes: list, historySha256: list.length ? hash.digest('hex') : '' };
}

/** One history row as the audit entry's historySha256 hashes it: its values as JSON text (stored compressed or not). */
const historyLine = (kind: string, scope: string, id: string, revision: number, op: string, before: string, after: string) =>
  `${kind}\u0000${scope}\u0000${id}\u0000${revision}\u0000${op}\u0000${before}\u0000${after}\n`;

/**
 * The SHA-256 of the history rows of an applied change set, computed again from the database – what its audit entry
 * `plant.change_set_applied` carries as historySha256 while no row was changed: the rows ordered by kind, scope and
 * entry id (as strings, code unit by code unit), each `kind NUL scope NUL entry_id NUL revision NUL op NUL before NUL
 * after LF` with before and after as JSON text – a value stored compressed (`z1:`, values.ts) is decompressed first.
 */
export function historySha256Of(changeSetId: string): string {
  const rows = db().all<{ kind: string; scope: string; entry_id: string; revision: number; op: string; before_values: string; after_values: string }>(
    'SELECT kind, scope, entry_id, revision, op, before_values, after_values FROM plant_entry_history WHERE change_set_id = ?',
    changeSetId,
  );
  if (!rows.length) return '';
  const key = (r: (typeof rows)[number]) => [r.kind, r.scope, r.entry_id];
  rows.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
    return 0;
  });
  const hash = createHash('sha256');
  for (const r of rows)
    hash.update(historyLine(r.kind, r.scope, r.entry_id, Number(r.revision), r.op, historyText(r.before_values), historyText(r.after_values)));
  return hash.digest('hex');
}

/** The region after renames: a renamed site or asset is read under its new id, too. */
function widen(r: Region, renames: (RenameOf | MovedOf)[]): Region {
  if (r.all || !renames.length) return r;
  const sites = [...(r.sites ?? [])];
  const assets = [...(r.assets ?? [])];
  for (const x of renames) {
    if (x.kind === 'site' && sites.includes(x.from)) sites.push(x.to);
    if (x.kind === 'asset' && assets.includes(x.from)) assets.push(x.to);
  }
  return { ...r, sites, assets };
}

// ---------- baselines: what the last imports wrote ----------

/**
 * After an import (0.15.0): per entry it wrote (the rows with its import id), a baseline – what the import left there,
 * for its flags "changed in Steward since the last import" (ADR 0020). Stored as the entry's revision once the import's
 * change set is applied: its values are those of that revision, read back through the entry's history (kept while the
 * entry exists); a baseline equal to the entry's last one (the same revision) is not written again, and the last
 * `baselinesPerEntry` (a plant setting) of each entry are kept. With `values` the values are stored instead (compressed
 * where that is shorter): an import followed by other operations of its change set, whose revision at the end is not
 * what the import left. Reads and writes one statement per kind and up to 200 entries; removed entries lose theirs.
 */
export function recordBaselines(importId: string, o: { values?: boolean } = {}): number {
  const at = nowIso();
  const seq = nextSeq();
  const keep = historyRetention().baselinesPerEntry;
  let n = 0;
  for (const kind of PLANT_ENTRY_KINDS) {
    const d = KINDS[kind];
    const cols = `${d.scopeCol ? `${d.scopeCol}, ` : ''}${d.idCol}, revision`;
    const rows = o.values
      ? db().all<Row>(`SELECT * FROM ${d.table} WHERE import_id = ?`, importId)
      : db().all<Row>(`SELECT ${cols} FROM ${d.table} WHERE import_id = ?`, importId);
    if (!rows.length) continue;
    const values = o.values ? new Map(d.read(rows).map((e) => [entryKey(e), JSON.stringify(e.values)])) : null;
    // the baselines the entries have, newest first (one read per kind)
    const had = new Map<string, { importId: string; revision: number | null }[]>();
    for (const b of db().all<{ scope: string; entry_id: string; import_id: string; revision: number | null }>(
      `SELECT b.scope, b.entry_id, b.import_id, b.revision FROM plant_entry_baselines b
        JOIN ${d.table} t ON t.${d.idCol} = b.entry_id AND ${d.scopeCol ? `t.${d.scopeCol} = b.scope` : "b.scope = ''"}
        WHERE b.kind = ? AND t.import_id = ? ORDER BY b.seq DESC, b.recorded_at DESC`,
      kind,
      importId,
    )) {
      const k = entryKey({ kind, scope: b.scope, id: b.entry_id });
      had.set(k, [...(had.get(k) ?? []), { importId: b.import_id, revision: b.revision === null ? null : Number(b.revision) }]);
    }
    const write: { scope: string; id: string; revision: number | null; values: string | null }[] = [];
    const drop: { scope: string; id: string; importId: string }[] = [];
    for (const r of rows) {
      const { scope, id } = keyOfRow(kind, r);
      const k = entryKey({ kind, scope, id });
      const revision = Number(r.revision ?? 1);
      const old = (had.get(k) ?? []).filter((b) => b.importId !== importId);
      if (!values && old[0]?.revision === revision) continue;
      write.push({ scope, id, revision: values ? null : revision, values: values ? storedValues(values.get(k) ?? '{}') : null });
      for (const b of old.slice(keep - 1)) drop.push({ scope, id, importId: b.importId });
    }
    for (const part of chunks(write)) {
      db().run(
        `INSERT INTO plant_entry_baselines (kind, scope, entry_id, import_id, seq, revision, field_values, recorded_at)
         VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
         ON CONFLICT (kind, scope, entry_id, import_id) DO UPDATE SET seq = excluded.seq, revision = excluded.revision, field_values = excluded.field_values, recorded_at = excluded.recorded_at`,
        ...part.flatMap((e) => [kind, e.scope, e.id, importId, seq, e.revision, e.values, at]),
      );
      n += part.length;
    }
    for (const part of chunks(drop))
      db().run(
        `DELETE FROM plant_entry_baselines WHERE kind = ? AND (${part.map(() => '(scope = ? AND entry_id = ? AND import_id = ?)').join(' OR ')})`,
        kind,
        ...part.flatMap((e) => [e.scope, e.id, e.importId]),
      );
  }
  return n;
}

/** Baselines of an entry in the order they were recorded (a counter that never goes back within the process; time otherwise). */
let lastSeq = 0;
const nextSeq = () => (lastSeq = Math.max(lastSeq + 1, Date.now() * 1000));

/**
 * The values of an entry at an earlier revision of its current life, from its history: the values now with the before
 * values of every later change laid over them, newest first. Null when the history does not reach back that far.
 */
function valuesAtRevision(now: EntrySnap, revision: number): Record<string, unknown> | null {
  if (revision === now.revision) return now.values;
  if (revision > now.revision) return null;
  const rows = db().all<{ revision: number; op: string; before_values: string }>(
    'SELECT revision, op, before_values FROM plant_entry_history WHERE kind = ? AND scope = ? AND entry_id = ? AND revision > ? ORDER BY at DESC, revision DESC',
    now.kind,
    now.scope,
    now.id,
    revision,
  );
  let values = { ...now.values };
  let expect = now.revision;
  for (const r of rows) {
    if (Number(r.revision) !== expect || r.op === 'add' || r.op === 'remove') return null;
    values = { ...values, ...historyValues<Record<string, unknown>>(r.before_values, {}) };
    if (--expect === revision) return values;
  }
  return null;
}

export interface Baseline {
  /** What the import left in the entry */
  values: Record<string, unknown>;
  importId: string;
  /** The entry's revision the values are of (null: stored values) */
  revision: number | null;
  recordedAt: string;
}

/**
 * The baselines of an entry, newest first: what each of the last imports that wrote it left there. A baseline whose
 * values the history no longer reaches is left out.
 */
export function baselinesOf(kind: PlantEntryKind, scope: string, id: string, now = readEntry(kind, scope, id)): Baseline[] {
  if (!now) return [];
  const rows = db().all<{ import_id: string; revision: number | null; field_values: string | null; recorded_at: string }>(
    'SELECT import_id, revision, field_values, recorded_at FROM plant_entry_baselines WHERE kind = ? AND scope = ? AND entry_id = ? ORDER BY seq DESC, recorded_at DESC',
    kind,
    scope,
    id,
  );
  const out: Baseline[] = [];
  for (const r of rows) {
    const revision = r.revision === null ? null : Number(r.revision);
    const values = revision !== null ? valuesAtRevision(now, revision) : historyValues<Record<string, unknown> | null>(r.field_values, null);
    if (values) out.push({ values, importId: r.import_id, revision, recordedAt: r.recorded_at });
  }
  return out;
}

/** What the last import that wrote an entry left there (null: none, or the history no longer reaches it). */
export const baselineOf = (kind: PlantEntryKind, scope: string, id: string): { values: Record<string, unknown>; importId: string } | null => {
  const now = readEntry(kind, scope, id);
  if (!now) return null;
  const last = db().get<{ import_id: string; revision: number | null; field_values: string | null }>(
    'SELECT import_id, revision, field_values FROM plant_entry_baselines WHERE kind = ? AND scope = ? AND entry_id = ? ORDER BY seq DESC, recorded_at DESC LIMIT 1',
    kind,
    scope,
    id,
  );
  if (!last) return null;
  const values = last.revision !== null ? valuesAtRevision(now, Number(last.revision)) : historyValues<Record<string, unknown> | null>(last.field_values, null);
  return values ? { values, importId: last.import_id } : null;
};
