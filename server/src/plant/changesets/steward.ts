import {
  PLANT_ENTRY_KINDS,
  PLANT_STEWARD_LIMITS,
  sameValue,
  setAtPath,
  type PlantChangeKind,
  type PlantEntryKind,
  type PlantStewardChoice,
  type PlantStewardFlag,
  type PlantStewardFlags,
} from '@sm/shared';
import { db } from '../../db.js';
import { withAuditDetails } from '../../audit.js';
import type { AuthUser } from '../../auth/context.js';
import { me } from '../../auth/access.js';
import { siteRights } from '../access.js';
import { cutValue } from '../diff.js';
import { redactValue } from '../collections-redact.js';
import { withImportWriteHook, type ImportWriteHook } from '../import-data.js';
import { importKindsOf, type ImportInput } from '../import.js';
import { KINDS, entryKey, type EntrySnap } from './entries.js';
import { recordBaselineValues } from './track.js';
import { historyValues } from './values.js';

/**
 * Imports versus edits in Steward (0.19.0, ADR 0020 section 3, phase 2): an import's preview flags, per field, what was
 * changed in Steward since the last import – Steward's value differs from what the last import wrote there (its
 * baseline, track.ts) – and the file would change. Steward is the source of truth: a flagged field keeps Steward's value
 * unless the person takes the file's (per field, or for all: `changedInSteward` of the import's body). Unflagged fields
 * follow the import's mode as before.
 *
 * How: before the import, the entries whose revision moved on since their last baseline (or, imported before 0.13 and
 * without one, edited after that import) are read with the fields that differ from the baseline – one statement per
 * kind, the baselines' values read back through the history in batches. While the import compares each entry it writes
 * (`pushWrite`), a hook flags those fields the file would change and puts Steward's value back into what is written,
 * so the preview, the counts and the history show what really happens. The baseline of a kept entry records what the
 * file said (not Steward's value): the field stays flagged at the next import while Steward and the file differ.
 */

type Values = Record<string, unknown>;

interface Candidate {
  kind: PlantEntryKind;
  scope: string;
  id: string;
  name: string;
  siteId: string;
  /** The values now (as the history keeps them) and at the last import */
  now: Values;
  baseline: Values | null;
  importId: string;
  /** Fields that differ from the last import (objects key by key; a list is one field) */
  paths: string[][];
  wholeEntry: boolean;
}

const isObj = (v: unknown): v is Values => !!v && typeof v === 'object' && !Array.isArray(v);
const marks = (k: number) => Array.from({ length: k }, () => '?').join(', ');

/** The paths where two values differ: objects key by key, lists and other values as one field each (as the merge). */
export function differingPaths(a: unknown, b: unknown, keys: string[] = [], out: string[][] = []): string[][] {
  if (sameValue(a, b)) return out;
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) differingPaths(a[k], b[k], [...keys, k], out);
    return out;
  }
  out.push(keys);
  return out;
}

/** The value at a path (undefined: not there). */
export function valueAt(o: unknown, keys: string[]): unknown {
  let cur = o;
  for (const k of keys) {
    if (!isObj(cur) || !Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Sets a value at a path of an object in place, copying the objects on the way (they may be shared with `before`). */
function setInPlace(o: Values, keys: string[], value: unknown): void {
  const [k, ...rest] = keys;
  if (k === undefined) return;
  if (!rest.length) {
    if (value === undefined) delete o[k];
    else o[k] = value;
    return;
  }
  const child: Values = isObj(o[k]) ? { ...(o[k] as Values) } : {};
  o[k] = child;
  setInPlace(child, rest, value);
}

/** The entry an import's write is about (null: not an entry of its own). */
function entryOf(kind: PlantChangeKind, siteId: string, id: string): { kind: PlantEntryKind; scope: string; id: string } | null {
  const split = () => {
    const i = id.indexOf('/');
    return i < 0 ? null : { scope: id.slice(0, i), id: id.slice(i + 1) };
  };
  switch (kind) {
    case 'site':
    case 'asset':
    case 'profile':
    case 'kpi':
    case 'assignment':
    case 'asset_checks':
      return { kind, scope: '', id };
    case 'area':
    case 'work_center':
    case 'work_unit':
      return { kind: 'node', scope: siteId, id };
    case 'building':
    case 'vlan':
    case 'zone':
    case 'conduit':
      return { kind, scope: siteId, id };
    case 'device':
    case 'data_path':
    case 'collection': {
      const k = split();
      return k ? { kind, ...k } : null;
    }
    case 'collection_sinks': {
      const k = split();
      return k ? { kind: 'collection', ...k } : null;
    }
  }
}

/**
 * The values of entries at the revisions of their last baselines, read back through their history: the values now with
 * the before values of every later change laid over them, newest first (null: the history does not reach back). One
 * statement per kind and 500 entries.
 */
function valuesAtRevisions(kind: PlantEntryKind, list: { snap: EntrySnap; revision: number }[]): Map<string, Values | null> {
  const out = new Map<string, Values | null>();
  for (let i = 0; i < list.length; i += 500) {
    const part = list.slice(i, i + 500);
    const ids = [...new Set(part.map((x) => x.snap.id))];
    const rows = db().all<{ scope: string; entry_id: string; revision: number; op: string; before_values: string }>(
      `SELECT scope, entry_id, revision, op, before_values FROM plant_entry_history WHERE kind = ? AND entry_id IN (${marks(ids.length)}) ORDER BY at DESC, revision DESC`,
      kind,
      ...ids,
    );
    const byEntry = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = entryKey({ kind, scope: r.scope, id: r.entry_id });
      (byEntry.get(k) ?? byEntry.set(k, []).get(k)!).push(r);
    }
    for (const { snap, revision } of part) {
      const k = entryKey(snap);
      if (revision === snap.revision) {
        out.set(k, snap.values);
        continue;
      }
      let values: Values | null = null;
      if (revision < snap.revision) {
        let cur = { ...snap.values };
        let expect = snap.revision;
        for (const r of byEntry.get(k) ?? []) {
          if (Number(r.revision) <= revision) continue;
          if (Number(r.revision) !== expect || r.op === 'add' || r.op === 'remove') break;
          cur = { ...cur, ...historyValues<Values>(r.before_values, {}) };
          if (--expect === revision) {
            values = cur;
            break;
          }
        }
      }
      out.set(k, values);
    }
  }
  return out;
}

type Row = Record<string, unknown>;
const ownRow = (r: Row): Row => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('sm_b_')));

/**
 * The entries of these kinds changed in Steward since the last import that wrote them, with the fields that differ.
 * Per kind one statement for the entries whose revision moved on since their last baseline (or whose baseline keeps
 * values), one for entries imported before 0.13 – no baseline – and edited after that import (every field counts).
 */
export function stewardCandidates(kinds: readonly PlantEntryKind[]): Map<string, Candidate> {
  const out = new Map<string, Candidate>();
  for (const kind of kinds) {
    const d = KINDS[kind];
    const scopeExpr = d.scopeCol ? `t.${d.scopeCol}` : "''";
    const rows = db().all<Row>(
      `SELECT t.*, b.revision AS sm_b_revision, b.field_values AS sm_b_values, b.import_id AS sm_b_import
         FROM ${d.table} t JOIN plant_entry_baselines b ON b.kind = ? AND b.scope = ${scopeExpr} AND b.entry_id = t.${d.idCol}
        WHERE b.seq = (SELECT MAX(x.seq) FROM plant_entry_baselines x WHERE x.kind = b.kind AND x.scope = b.scope AND x.entry_id = b.entry_id)
          AND (b.revision IS NULL OR b.revision <> t.revision)
        ORDER BY b.recorded_at DESC`,
      kind,
    );
    const legacy = db().all<Row>(
      `SELECT t.*, i.id AS sm_b_import FROM ${d.table} t JOIN plant_imports i ON i.id = t.import_id
        WHERE t.updated_at > i.created_at
          AND NOT EXISTS (SELECT 1 FROM plant_entry_baselines x WHERE x.kind = ? AND x.scope = ${scopeExpr} AND x.entry_id = t.${d.idCol})`,
      kind,
    );
    if (!rows.length && !legacy.length) continue;
    const snaps = d.read([...rows, ...legacy].map(ownRow));
    const meta = [...rows, ...legacy];
    const byRevision: { snap: EntrySnap; revision: number }[] = [];
    const found: { snap: EntrySnap; row: Row; legacy: boolean }[] = [];
    const seen = new Set<string>();
    snaps.forEach((snap, i) => {
      const k = entryKey(snap);
      if (seen.has(k)) return;
      seen.add(k);
      const row = meta[i]!;
      found.push({ snap, row, legacy: i >= rows.length });
      if (i < rows.length && row.sm_b_revision !== null && row.sm_b_revision !== undefined) byRevision.push({ snap, revision: Number(row.sm_b_revision) });
    });
    const atRevision = valuesAtRevisions(kind, byRevision);
    for (const { snap, row, legacy: old } of found) {
      const k = entryKey(snap);
      const baseline = old
        ? null
        : row.sm_b_revision !== null && row.sm_b_revision !== undefined
          ? (atRevision.get(k) ?? null)
          : historyValues<Values | null>(row.sm_b_values as string | null, null);
      const whole = !baseline;
      const paths = whole
        ? Object.keys(snap.values)
            .filter((x) => x !== 'id')
            .map((x) => [x])
        : differingPaths(baseline, snap.values).filter((p) => p.length > 0 && p[0] !== 'id');
      if (!paths.length) continue;
      out.set(k, {
        kind,
        scope: snap.scope,
        id: snap.id,
        name: snap.name,
        siteId: snap.siteId,
        now: snap.values,
        baseline,
        importId: String(row.sm_b_import ?? ''),
        paths,
        wholeEntry: whole,
      });
    }
  }
  return out;
}

export interface StewardRun<T> {
  result: T;
  /** The flags as the reader may see them (null: none) */
  flags: PlantStewardFlags | null;
  /** After the import's baselines are recorded: those of the entries that kept Steward's values say what the file said */
  recordKept: (importId: string) => void;
}

/** The import's choice for every flagged field not listed. */
const takeOf = (input: ImportInput): PlantStewardChoice => input.changedInSteward?.take ?? 'steward';

/**
 * Runs an import (fn: the import core, previewing or applying `input`) with the flags of fields changed in Steward since
 * the last import, keeping Steward's values where chosen. Inside the import's transaction.
 */
export function withSteward<T>(input: ImportInput, fn: () => T, u: AuthUser = me()): StewardRun<T> {
  const none: StewardRun<T> = { result: undefined as T, flags: null, recordKept: () => undefined };
  // "add only" leaves every existing entry as it is
  if (input.mode === 'add') return { ...none, result: fn() };
  const candidates = stewardCandidates(importKindsOf(input) ?? PLANT_ENTRY_KINDS);
  if (!candidates.size) return { ...none, result: fn() };
  const take = takeOf(input);
  const chosen = new Map((input.changedInSteward?.fields ?? []).map((f) => [`${entryKey(f)}\u0000${f.path}`, f.choice]));
  const flags = new Map<string, PlantStewardFlag & { siteId: string }>();
  const kept = new Map<string, { c: Candidate; paths: { keys: string[]; file: unknown }[] }>();
  const extra: Record<string, unknown> = {};
  /** What the file says at a path, as the history would keep it (a data collection's secrets removed) */
  const shown = (c: Candidate, keys: string[], file: unknown) =>
    c.kind === 'collection' ? valueAt(redactValue(setAtPath(c.now, keys, file)).value, keys) : file;
  const hook: ImportWriteHook = (kind, siteId, id, before, after) => {
    const e = entryOf(kind, siteId, id);
    const c = e ? candidates.get(entryKey(e)) : undefined;
    if (!c) return;
    const k = entryKey(c);
    for (const keys of c.paths) {
      const was = valueAt(before, keys);
      const file = valueAt(after, keys);
      if (sameValue(was, file)) continue;
      const path = keys.join('.');
      const choice = chosen.get(`${k}\u0000${path}`) ?? take;
      flags.set(`${k}\u0000${path}`, {
        kind: c.kind,
        scope: c.scope,
        id: c.id,
        name: c.name,
        siteId: c.siteId,
        path,
        lastImport: c.baseline ? cutValue(valueAt(c.baseline, keys)) : null,
        steward: cutValue(valueAt(c.now, keys)),
        file: cutValue(shown(c, keys, file)),
        importId: c.importId,
        ...(c.wholeEntry ? { wholeEntry: true } : {}),
        choice,
      });
      if (choice !== 'steward') continue;
      const rec = kept.get(k) ?? kept.set(k, { c, paths: [] }).get(k)!;
      rec.paths.push({ keys, file: file === undefined ? undefined : structuredClone(file) });
      setInPlace(after as Values, keys, was === undefined ? undefined : structuredClone(was));
      // the import's audit entries say what was kept (paths, never values)
      const all = [...kept.values()];
      extra.keptInSteward = {
        fields: all.reduce((n, x) => n + x.paths.length, 0),
        entries: all.slice(0, 50).map((x) => `${x.c.kind}:${x.c.scope ? `${x.c.scope}/` : ''}${x.c.id} ${x.paths.map((p) => p.keys.join('.')).join(', ')}`),
      };
    }
  };
  const result = withAuditDetails(extra, () => withImportWriteHook(hook, fn));
  // who reads the preview sees the flags of the sites they see
  const rights = siteRights(db().all<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites'), u);
  const visible = [...flags.values()]
    .filter((f) => !f.siteId || !!rights.get(f.siteId)?.includes('view'))
    .map(({ siteId: _s, ...f }) => f)
    .sort((a, b) => (entryKey(a) < entryKey(b) ? -1 : entryKey(a) > entryKey(b) ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    result,
    flags: visible.length
      ? { flags: visible.slice(0, PLANT_STEWARD_LIMITS.flags), total: visible.length, kept: visible.filter((f) => f.choice === 'steward').length }
      : null,
    recordKept: (importId) => {
      if (!kept.size) return;
      const list: { kind: PlantEntryKind; scope: string; id: string; values: Values }[] = [];
      const byKind = new Map<PlantEntryKind, { c: Candidate; paths: { keys: string[]; file: unknown }[] }[]>();
      for (const x of kept.values()) (byKind.get(x.c.kind) ?? byKind.set(x.c.kind, []).get(x.c.kind)!).push(x);
      for (const [kind, recs] of byKind) {
        const d = KINDS[kind];
        for (let i = 0; i < recs.length; i += 500) {
          const part = recs.slice(i, i + 500);
          const ids = [...new Set(part.map((x) => x.c.id))];
          const rows = db().all<Row>(`SELECT * FROM ${d.table} WHERE ${d.idCol} IN (${marks(ids.length)})`, ...ids);
          const now = new Map(d.read(rows).map((s) => [entryKey(s), s.values]));
          for (const { c, paths } of part) {
            const values = now.get(entryKey(c));
            if (!values) continue;
            // what the import left with the file's values where Steward's were kept
            let v: Values = values;
            for (const p of paths) v = setAtPath(v, p.keys, p.file);
            list.push({ kind, scope: c.scope, id: c.id, values: kind === 'collection' ? redactValue(v).value : v });
          }
        }
      }
      recordBaselineValues(importId, list);
    },
  };
}
