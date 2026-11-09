import YAML from 'yaml';
import {
  PLANT_COLLECTION_LIMITS as L,
  PLANT_SOURCE_LIMITS as SL,
  type CollectionFormat,
  type PlantCollectionSource,
  type PlantCollector,
  type PlantSourceChange,
  type PlantSourceDiff,
  type PlantSourceDiffLine,
} from '@sm/shared';
import { db } from '../db.js';
import { HttpError, newId, parseJson, sha256 } from '../util.js';
import { parseYaml } from '../yaml-safe.js';
import { visibleAsset } from './service.js';
import { itemRef } from './network.js';
import { collectorKey } from './collections-model.js';
import type { RedactedFile } from './collections-redact.js';

/**
 * The kept files of collection imports (0.12, docs/PLANT.md "Gateway configurations"): per asset and collector one
 * version per import, each file as Steward keeps it – secrets removed (collections-redact.ts), never the original –
 * with the SHA-256 and size of the original and the paths where values were removed. They are read, downloaded and
 * compared by whoever sees the asset; they go with the asset, and with the last collection they belong to.
 */

export interface SourceRow {
  id: string;
  asset_id: string;
  collector_key: string;
  collector: string;
  version: number;
  file_name: string;
  format: string;
  sha256: string;
  size: number;
  content: string;
  redacted_sha256: string;
  redacted_paths: string;
  collections: string;
  imported_by: string;
  imported_at: string;
}

const viewOf = (r: SourceRow): PlantCollectionSource => {
  const collector = parseJson<PlantCollector>(r.collector, { kind: 'job', ref: '', host: null });
  return {
    id: r.id,
    assetId: r.asset_id,
    collector,
    collectorLabel: collector.kind === 'job' ? collector.ref : itemRef(collector.kind, collector.ref).label,
    version: Number(r.version),
    fileName: r.file_name,
    format: r.format as CollectionFormat,
    sha256: r.sha256,
    size: Number(r.size),
    redactedSha256: r.redacted_sha256,
    redactedSize: Buffer.byteLength(r.content),
    redactedPaths: parseJson<string[]>(r.redacted_paths, []),
    collections: parseJson<string[]>(r.collections, []),
    importedBy: r.imported_by,
    importedAt: r.imported_at,
  };
};

export const sourceRows = (assetId: string): SourceRow[] =>
  db().all<SourceRow>('SELECT * FROM plant_collection_sources WHERE asset_id = ? ORDER BY version DESC, file_name, id', assetId);

// ---------- writing (the import; inside its transaction) ----------

export interface KeptFile {
  name: string;
  /** The file as uploaded: only its hash and size are kept */
  original: string;
  redacted: RedactedFile;
}

/**
 * Keeps the files of one import as the next version of the asset's collector – unless they are the same as the last
 * version (then that one is returned, with the collections added). Versions beyond the limit go, the oldest first.
 */
export function keepSources(
  assetId: string,
  collector: PlantCollector,
  format: CollectionFormat,
  files: KeptFile[],
  collections: string[],
  meta: { at: string; by: string },
): { rows: SourceRow[]; added: boolean } {
  const key = collectorKey(collector);
  const total = files.reduce((n, f) => n + Buffer.byteLength(f.redacted.content), 0);
  if (total > L.fileBytes)
    throw new HttpError(413, `The files are too large (at most ${L.fileBytes / 1024 / 1024} MB)`, 'PLANT_IMPORT_TOO_LARGE', { mb: L.fileBytes / 1024 / 1024 });
  const last = Number(
    db().get<{ v: number | null }>('SELECT MAX(version) AS v FROM plant_collection_sources WHERE asset_id = ? AND collector_key = ?', assetId, key)?.v ?? 0,
  );
  const lastRows = last
    ? db().all<SourceRow>(
        'SELECT * FROM plant_collection_sources WHERE asset_id = ? AND collector_key = ? AND version = ? ORDER BY file_name, id',
        assetId,
        key,
        last,
      )
    : [];
  const fingerprint = (xs: { name: string; hash: string }[]) =>
    xs
      .map((x) => `${x.name}\u0000${x.hash}`)
      .sort()
      .join('\n');
  const same =
    lastRows.length > 0 &&
    fingerprint(lastRows.map((r) => ({ name: r.file_name, hash: r.redacted_sha256 }))) ===
      fingerprint(files.map((f) => ({ name: f.name, hash: sha256(f.redacted.content) })));
  if (same) {
    for (const r of lastRows) {
      const list = [...new Set([...parseJson<string[]>(r.collections, []), ...collections])];
      db().run('UPDATE plant_collection_sources SET collections = ? WHERE id = ?', JSON.stringify(list), r.id);
      r.collections = JSON.stringify(list);
    }
    return { rows: lastRows, added: false };
  }
  const version = last + 1;
  const rows = files.map((f): SourceRow => ({
    id: newId('pcs_'),
    asset_id: assetId,
    collector_key: key,
    collector: JSON.stringify(collector),
    version,
    file_name: f.name,
    format,
    sha256: sha256(f.original),
    size: Buffer.byteLength(f.original),
    content: f.redacted.content,
    redacted_sha256: sha256(f.redacted.content),
    redacted_paths: JSON.stringify(f.redacted.paths),
    collections: JSON.stringify(collections),
    imported_by: meta.by,
    imported_at: meta.at,
  }));
  for (const r of rows)
    db().run(
      `INSERT INTO plant_collection_sources (id, asset_id, collector_key, collector, version, file_name, format, sha256, size, content, redacted_sha256,
         redacted_paths, collections, imported_by, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id,
      r.asset_id,
      r.collector_key,
      r.collector,
      r.version,
      r.file_name,
      r.format,
      r.sha256,
      r.size,
      r.content,
      r.redacted_sha256,
      r.redacted_paths,
      r.collections,
      r.imported_by,
      r.imported_at,
    );
  // the oldest versions beyond the limit go
  db().run('DELETE FROM plant_collection_sources WHERE asset_id = ? AND collector_key = ? AND version <= ?', assetId, key, version - L.sourceVersions);
  return { rows, added: true };
}

/** Removes the kept files none of whose collections are left (after collections were removed). */
export function pruneSources(assetId: string): number {
  const left = new Set(
    db()
      .all<{ id: string }>('SELECT id FROM plant_collections WHERE asset_id = ?', assetId)
      .map((r) => r.id),
  );
  let n = 0;
  for (const r of db().all<{ id: string; collections: string }>('SELECT id, collections FROM plant_collection_sources WHERE asset_id = ?', assetId))
    if (!parseJson<string[]>(r.collections, []).some((c) => left.has(c))) n += db().run('DELETE FROM plant_collection_sources WHERE id = ?', r.id).changes;
  return n;
}

// ---------- reading (whoever sees the asset) ----------

/** The versions of an asset's collection imports, newest first; with a collection: those that wrote it. */
export function listSources(assetId: string, collectionId?: string): PlantCollectionSource[] {
  visibleAsset(assetId);
  return sourceRows(assetId)
    .map(viewOf)
    .filter((s) => !collectionId || s.collections.includes(collectionId));
}

function sourceRow(assetId: string, id: string): SourceRow {
  visibleAsset(assetId);
  const r = db().get<SourceRow>('SELECT * FROM plant_collection_sources WHERE asset_id = ? AND id = ?', assetId, id);
  if (!r) throw new HttpError(404, `Source ${id} not found`, 'PLANT_SOURCE_NOT_FOUND', { id });
  return r;
}

const syntaxOf = (r: Pick<SourceRow, 'file_name' | 'content'>): 'json' | 'yaml' | 'csv' =>
  /\.(csv|txt)$/i.test(r.file_name) ? 'csv' : /^\s*[[{]/.test(r.content) ? 'json' : 'yaml';

/** The kept file for download (secrets removed), named after the original with its version. */
export function sourceFile(assetId: string, id: string): { filename: string; content: string; contentType: string } {
  const r = sourceRow(assetId, id);
  const syntax = syntaxOf(r);
  const stem = r.file_name.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  const ext = syntax === 'csv' ? (/\.txt$/i.test(r.file_name) ? 'txt' : 'csv') : syntax === 'json' ? 'json' : 'yaml';
  return {
    filename: `${stem}.v${r.version}.redacted.${ext}`,
    content: r.content,
    contentType: syntax === 'json' ? 'application/json; charset=utf-8' : syntax === 'yaml' ? 'application/yaml; charset=utf-8' : 'text/csv; charset=utf-8',
  };
}

// ---------- comparing two versions ----------

/** Leaf values of a document by path (objects by key, lists by index), in document order. */
function leaves(v: unknown, at = '', out = new Map<string, string>(), depth = 0): Map<string, string> {
  if (out.size > 200_000 || depth > 100) return out;
  if (Array.isArray(v)) {
    if (!v.length) out.set(at, '[]');
    v.forEach((x, i) => leaves(x, `${at}[${i}]`, out, depth + 1));
  } else if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    if (!entries.length) out.set(at, '{}');
    for (const [k, x] of entries) leaves(x, /^[A-Za-z_$][\w$]*$/.test(k) ? (at ? `${at}.${k}` : k) : `${at}[${JSON.stringify(k)}]`, out, depth + 1);
  } else out.set(at || '(value)', v === null || v === undefined ? 'null' : typeof v === 'string' ? v : JSON.stringify(v));
  return out;
}

function parsed(r: SourceRow): unknown {
  const syntax = syntaxOf(r);
  if (syntax === 'csv') return undefined;
  try {
    return syntax === 'json' ? JSON.parse(r.content) : parseYaml(r.content, { maxBytes: L.fileBytes, maxKeys: 500_000, maxAliasCount: 100 });
  } catch {
    return undefined;
  }
}

/**
 * A line diff (Myers' algorithm on the lines between the common start and end). Above `maxD` differences it gives up
 * and shows the middle as removed and added.
 */
export function lineDiff(a: string[], b: string[], maxD = 4000): { op: 'same' | 'added' | 'removed'; text: string }[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  const head = a.slice(0, start).map((text) => ({ op: 'same' as const, text }));
  const tail = a.slice(endA).map((text) => ({ op: 'same' as const, text }));
  const n = x.length;
  const m = y.length;
  const fallback = () => [...x.map((text) => ({ op: 'removed' as const, text })), ...y.map((text) => ({ op: 'added' as const, text }))];
  if (!n || !m) return [...head, ...fallback(), ...tail];
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let i = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let j = i - k;
      while (i < n && j < m && x[i] === y[j]) {
        i++;
        j++;
      }
      v[off + k] = i;
      if (i >= n && j >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return [...head, ...fallback(), ...tail];
  const mid: { op: 'same' | 'added' | 'removed'; text: string }[] = [];
  let i = n;
  let j = m;
  for (let d = found; d > 0; d--) {
    const t = trace[d]!;
    const k = i - j;
    const prevK = k === -d || (k !== d && t[off + k - 1]! < t[off + k + 1]!) ? k + 1 : k - 1;
    const prevI = t[off + prevK]!;
    const prevJ = prevI - prevK;
    while (i > prevI && j > prevJ) {
      mid.push({ op: 'same', text: x[--i]! });
      j--;
    }
    if (prevK === k + 1) mid.push({ op: 'added', text: y[--j]! });
    else mid.push({ op: 'removed', text: x[--i]! });
  }
  while (i > 0 && j > 0) {
    mid.push({ op: 'same', text: x[--i]! });
    j--;
  }
  return [...head, ...mid.reverse(), ...tail];
}

/** The changed lines with three lines of context; longer runs of equal lines are one "gap". */
function withContext(ops: { op: 'same' | 'added' | 'removed'; text: string }[]): { lines: PlantSourceDiffLine[]; truncated: boolean } {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.op === 'same') return;
    for (let k = Math.max(0, i - 3); k <= Math.min(ops.length - 1, i + 3); k++) keep[k] = true;
  });
  const lines: PlantSourceDiffLine[] = [];
  let gap = false;
  for (let i = 0; i < ops.length; i++) {
    if (!keep[i]) {
      if (!gap) lines.push({ op: 'gap', text: '' });
      gap = true;
      continue;
    }
    gap = false;
    lines.push({ op: ops[i]!.op, text: ops[i]!.text });
  }
  return { lines: lines.slice(0, SL.diffLines), truncated: lines.length > SL.diffLines };
}

/** Two kept files compared: by path when both are JSON or YAML, and line by line. */
export function diffSources(assetId: string, fromId: string, toId: string): PlantSourceDiff {
  const a = sourceRow(assetId, fromId);
  const b = sourceRow(assetId, toId);
  const pa = parsed(a);
  const pb = parsed(b);
  const changes: PlantSourceChange[] = [];
  let structure = false;
  if (pa !== undefined && pb !== undefined) {
    structure = true;
    const la = leaves(pa);
    const lb = leaves(pb);
    for (const [p, v] of la) {
      if (!lb.has(p)) changes.push({ op: 'removed', path: p, before: v, after: null });
      else if (lb.get(p) !== v) changes.push({ op: 'changed', path: p, before: v, after: lb.get(p)! });
    }
    for (const [p, v] of lb) if (!la.has(p)) changes.push({ op: 'added', path: p, before: null, after: v });
  }
  // YAML is compared as written by Steward, so both sides have the same layout
  const text = (r: SourceRow, p: unknown) => (syntaxOf(r) === 'yaml' && p !== undefined ? YAML.stringify(p, { lineWidth: 0 }) : r.content);
  const ctx = withContext(lineDiff(text(a, pa).split('\n'), text(b, pb).split('\n')));
  const brief = (r: SourceRow) => ({ id: r.id, version: Number(r.version), fileName: r.file_name, importedAt: r.imported_at });
  return {
    from: brief(a),
    to: brief(b),
    kind: structure ? 'structure' : 'lines',
    changes: changes.slice(0, SL.diffChanges),
    lines: ctx.lines,
    truncated: ctx.truncated || changes.length > SL.diffChanges,
  };
}
