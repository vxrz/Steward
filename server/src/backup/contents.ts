import {
  BACKUP_OPTIONAL_PARTS,
  BACKUP_PART_PATHS,
  BACKUP_PARTS,
  isBackupOptionalPart,
  type BackupContentPart,
  type BackupExcludedPart,
  type BackupOptionalPart,
  type BackupPart,
} from '@sm/shared';
import { db } from '../db.js';
import { HttpError } from '../util.js';

/**
 * What a backup holds, part by part (0.16.0, docs/BACKUPS.md#contents). The database, vault.json, audit-anchor.json,
 * the audit archives and the manifest are always in a backup: without them there is nothing to restore, or no proof
 * that the audit log is complete. An administrator may leave out the bulky folders BACKUP_OPTIONAL_PARTS – run
 * artifacts, archived reports and evidence packs. All three are evidence, so they are included by default; leaving one
 * out is recorded in the manifest, in the backup file's header, in the run's steps and shown by the restore test.
 */

/** The top-level folder of an optional part in the data folder. */
export const PART_FOLDER: Record<BackupOptionalPart, string> = {
  artifacts: 'artifacts',
  reports: 'reports',
  evidencePacks: 'evidence-packs',
};

/** The part a file of the data folder (path relative to it, with /) belongs to. */
export function partOf(rel: string): BackupPart {
  const top = rel.split('/')[0]!;
  if (top === 'vault.json' || top.startsWith('vault.json.')) return 'vault';
  if (top === 'audit-anchor.json') return 'auditAnchor';
  for (const p of BACKUP_PARTS) {
    const at = BACKUP_PART_PATHS[p];
    if (at?.endsWith('/') && rel.includes('/') && `${top}/` === at) return p;
  }
  return 'other';
}

/**
 * The parts to leave out, checked: only optional parts, each once. A required part (the database, the vault, the audit
 * anchor …) or an unknown one is refused – never silently dropped.
 */
export function checkExclude(input: unknown): BackupOptionalPart[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > BACKUP_PARTS.length)
    throw new HttpError(400, 'exclude must be a list of backup parts', 'BACKUP_PART_UNKNOWN', { part: String(input).slice(0, 40) });
  const out: BackupOptionalPart[] = [];
  for (const x of input) {
    if (isBackupOptionalPart(x)) {
      if (!out.includes(x)) out.push(x);
      continue;
    }
    if (typeof x === 'string' && (BACKUP_PARTS as readonly string[]).includes(x))
      throw new HttpError(400, `"${x}" is always in a backup – a restore needs it`, 'BACKUP_PART_REQUIRED', { part: x });
    throw new HttpError(400, `Unknown backup part "${String(x).slice(0, 40)}"`, 'BACKUP_PART_UNKNOWN', { part: String(x).slice(0, 40) });
  }
  // a fixed order, whatever the order of the request
  return BACKUP_OPTIONAL_PARTS.filter((p) => out.includes(p));
}

/** The parts with their size now (the files of the data folder that a backup takes, and the database). */
export function contentsOf(files: { rel: string; size: number }[], exclude: readonly BackupOptionalPart[]): BackupContentPart[] {
  const sum = new Map<BackupPart, { files: number; bytes: number }>(BACKUP_PARTS.map((p) => [p, { files: 0, bytes: 0 }]));
  for (const f of files) {
    const s = sum.get(partOf(f.rel))!;
    s.files++;
    s.bytes += f.size;
  }
  const dbPart = sum.get('database')!;
  dbPart.files = 1;
  try {
    dbPart.bytes = db().sizeBytes();
  } catch {
    dbPart.bytes = 0;
  }
  return BACKUP_PARTS.map((id) => ({
    id,
    path: BACKUP_PART_PATHS[id],
    required: !isBackupOptionalPart(id),
    excluded: isBackupOptionalPart(id) && exclude.includes(id),
    ...sum.get(id)!,
  }));
}

/** One line for the run's step and the restore test: what was left out and what a restore lacks. */
export function excludedText(parts: readonly BackupExcludedPart[]): string {
  return parts.map((p) => `${p.path} (${p.files} files, ${p.bytes} bytes)`).join(', ');
}
