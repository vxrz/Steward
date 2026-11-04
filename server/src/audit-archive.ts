import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';
import {
  DEFAULT_AUDIT_ARCHIVE_SETTINGS,
  type AuditArchiveInfo,
  type AuditArchiveSettings,
  type AuditArchiveStatus,
  type AuditCheckpoint,
  type AuditEntry,
} from '@sm/shared';
import { config, env } from './config.js';
import { db } from './db.js';
import {
  DELETE_STARTED_ACTION,
  DIGEST_SEED,
  GENESIS,
  KEPT_ON_DELETE_SQL,
  audit,
  digestStep,
  prunedBase,
  publicResult,
  resetPrunedBase,
  toEntry,
  type AuditRow,
  type PrunedBase,
  type VerifyOutcome,
} from './audit.js';
import { createCheckpoint, lastVerifications, validCheckpoint, verifyWithAnchors } from './audit-anchor.js';
import { ARCHIVE_CHECKPOINTS, ARCHIVE_ENTRIES, ARCHIVE_FORMAT, ARCHIVE_SIGNATURE_DOMAIN, verifyArchive, type ArchiveManifest } from './audit-archive-verify.js';
import { ZipWriter } from './compliance/zip.js';
import { currentActor } from './auth/context.js';
import { logger } from './log.js';
import { readSetting, writeSetting } from './settings.js';
import { publicKeyFingerprint, publicKeyPem, vault } from './vault.js';
import { HttpError, newId, nowIso, parseJson } from './util.js';

/**
 * Epochs, archives and retention of the audit log (0.4.0).
 *
 * Epochs: every signed checkpoint (audit-anchor.ts, hourly when there are new entries) closes an epoch – the entries
 * after the previous checkpoint up to it. Verification is incremental from the newest checkpoint; a full verification
 * (every entry in the database) runs in the background with progress, by hand and every SM_AUDIT_FULL_VERIFY_DAYS.
 *
 * Archives: once a month of checkpoints is over, its epochs – the entries from the end of the previous archive up to
 * the month's last checkpoint – are exported to <data dir>/audit-archives as a signed, self-verifying ZIP (entries as
 * JSON lines, the checkpoints, a manifest with SHA-256 of each file, signed with the installation's Ed25519 key;
 * `steward audit verify-archive` checks it offline), and optionally uploaded to the S3 target of the backups,
 * encrypted with the backup key. Off by default (Audit log → Archive).
 *
 * Retention (off by default): archived entries older than the retention period are deleted from the database, in
 * batches, archive by archive and only when the archive file is there and unchanged (and uploaded, when uploading is
 * on). A record of the deletion is written to the chain first; entries that other evidence relies on stay (see
 * KEPT_ON_DELETE_SQL). The signed checkpoint the archive ends at then links the chain: the first remaining entry
 * points to it, so the database still verifies, and the archives verify on their own.
 */

const SETTINGS_KEY = 'audit.archive';
/** Retention periods below this are refused (a slip should not delete last month's evidence) */
export const MIN_RETENTION_DAYS = 30;
/** Rows deleted per statement (each its own transaction); the event loop gets a turn in between */
export const DELETE_BATCH = 500;
const PAGE = 2000;
const DAY = 86_400_000;
export const FULL_VERIFY_DAYS = env.SM_AUDIT_FULL_VERIFY_DAYS;

export const archivesDir = (): string => path.join(config.dataDir, 'audit-archives');
const turn = () => new Promise((resolve) => setImmediate(resolve));

// ---------- settings ----------

export function archiveSettings(): AuditArchiveSettings {
  return { ...DEFAULT_AUDIT_ARCHIVE_SETTINGS, ...readSetting<Partial<AuditArchiveSettings>>(SETTINGS_KEY, {}) };
}

const settingsSchema = z.object({
  archive: z.boolean(),
  upload: z.boolean(),
  retentionDays: z.number().int().min(0).max(36_500),
});

const uploadAvailable = async (): Promise<boolean> => (await import('./backup/service.js')).backupTargetAvailable();

export async function saveArchiveSettings(input: unknown): Promise<AuditArchiveSettings> {
  const v = settingsSchema.parse(input);
  if (v.retentionDays > 0 && v.retentionDays < MIN_RETENTION_DAYS)
    throw new HttpError(400, `Keep archived entries at least ${MIN_RETENTION_DAYS} days in the database`, 'AUDIT_RETENTION_SHORT', {
      min: MIN_RETENTION_DAYS,
    });
  if ((v.retentionDays > 0 || v.upload) && !v.archive)
    throw new HttpError(400, 'Turn on archiving first: only archived entries are uploaded or deleted', 'AUDIT_ARCHIVE_OFF');
  if (v.upload && !(await uploadAvailable()))
    throw new HttpError(400, 'Uploading needs backups to S3 with a backup passphrase (Settings → Backups)', 'AUDIT_UPLOAD_UNAVAILABLE');
  const previous = archiveSettings();
  writeSetting(SETTINGS_KEY, v);
  audit({
    action: 'audit.archive_settings_updated',
    entityType: 'audit',
    summary: `Audit archive: ${v.archive ? 'closed epochs are archived' : 'off'}${v.upload ? ', uploaded to the backup target' : ''}; ${
      v.retentionDays ? `archived entries older than ${v.retentionDays} days are deleted from the database` : 'entries are never deleted'
    }`,
    details: { ...v, previous },
  });
  return v;
}

// ---------- archives ----------

interface ArchiveRow {
  id: string;
  first_seq: number;
  last_seq: number;
  first_ts: string;
  last_ts: string;
  entries: number;
  epochs: number;
  start_hash: string;
  start_digest: string;
  checkpoint: string;
  file: string;
  size: number;
  sha256: string;
  remote_key: string | null;
  uploaded_at: string | null;
  created_at: string;
  created_by: string;
  prune_started_at: string | null;
  pruned_at: string | null;
  pruned_entries: number | null;
}

export const archiveFile = (r: { file: string }): string => path.join(archivesDir(), path.basename(r.file));

const toInfo = (r: ArchiveRow): AuditArchiveInfo => ({
  id: r.id,
  firstSeq: Number(r.first_seq),
  lastSeq: Number(r.last_seq),
  firstTs: r.first_ts,
  lastTs: r.last_ts,
  entries: Number(r.entries),
  epochs: Number(r.epochs),
  file: r.file,
  size: Number(r.size),
  sha256: r.sha256,
  fileMissing: !fs.existsSync(archiveFile(r)),
  remoteKey: r.remote_key,
  uploadedAt: r.uploaded_at,
  createdAt: r.created_at,
  createdBy: r.created_by,
  pruning: !!r.prune_started_at && !r.pruned_at,
  prunedAt: r.pruned_at,
  prunedEntries: r.pruned_entries === null ? null : Number(r.pruned_entries),
});

export function listArchives(limit = 100): AuditArchiveInfo[] {
  return db().all<ArchiveRow>('SELECT * FROM audit_archives ORDER BY last_seq DESC LIMIT ?', limit).map(toInfo);
}

function archiveRow(id: string): ArchiveRow {
  const r = db().get<ArchiveRow>('SELECT * FROM audit_archives WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'No such audit archive');
  return r;
}

/** Archives overlapping entries `from`–`to` (evidence packs over an archived period), oldest first. */
export function archivesCovering(fromSeq: number, toSeq: number): (AuditArchiveInfo & { path: string; checkpoint: AuditCheckpoint })[] {
  return db()
    .all<ArchiveRow>('SELECT * FROM audit_archives WHERE last_seq >= ? AND first_seq <= ? ORDER BY last_seq', fromSeq, toSeq)
    .map((r) => ({ ...toInfo(r), path: archiveFile(r), checkpoint: JSON.parse(r.checkpoint) as AuditCheckpoint }));
}

async function fileSha256(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Valid signed checkpoints of this installation covering entries from `fromSeq` on, in order (one per seq). */
function* checkpointsFrom(fromSeq: number): Generator<AuditCheckpoint> {
  let after = Math.max(0, fromSeq - 1);
  let lastSeq = fromSeq - 1;
  for (;;) {
    const rows = db().all<{ seq: number; details: string | null }>(
      "SELECT seq, details FROM audit_log WHERE action = 'audit.checkpoint' AND seq > ? ORDER BY seq LIMIT 500",
      after,
    );
    if (!rows.length) return;
    for (const r of rows) {
      const c = parseJson<AuditCheckpoint | null>(r.details, null);
      if (c && typeof c.seq === 'number' && c.seq > lastSeq && c.seq < Number(r.seq) && validCheckpoint(c)) {
        lastSeq = c.seq;
        yield c;
      }
    }
    after = Number(rows.at(-1)!.seq);
  }
}

const monthOf = (ts: string) => ts.slice(0, 7);

interface Range {
  month: string;
  firstSeq: number;
  startHash: string;
  startDigest: string;
  startCheckpoint: AuditCheckpoint | null;
  end: AuditCheckpoint;
  checkpoints: AuditCheckpoint[];
}

/** The next closed month of epochs: from the end of the newest archive to the last checkpoint of a past month. */
export function nextArchiveRange(now = Date.now()): Range | null {
  const last = db().get<ArchiveRow>('SELECT * FROM audit_archives ORDER BY last_seq DESC LIMIT 1');
  const startCheckpoint = last ? (JSON.parse(last.checkpoint) as AuditCheckpoint) : null;
  const firstSeq = last ? Number(last.last_seq) + 1 : 1;
  const current = monthOf(new Date(now).toISOString());
  let month: string | null = null;
  const checkpoints: AuditCheckpoint[] = [];
  for (const c of checkpointsFrom(firstSeq)) {
    const m = monthOf(c.ts);
    if (month === null) {
      if (m >= current) return null;
      month = m;
    }
    if (m !== month) break;
    checkpoints.push(c);
  }
  if (!month || !checkpoints.length) return null;
  return {
    month,
    firstSeq,
    startHash: startCheckpoint?.hash ?? GENESIS,
    startDigest: startCheckpoint?.digest ?? DIGEST_SEED,
    startCheckpoint,
    end: checkpoints.at(-1)!,
    checkpoints,
  };
}

const pad = (n: number) => String(n).padStart(9, '0');

/** Writes the archive of a range, checks it as an auditor would, and records it. */
async function buildArchive(range: Range, by: string): Promise<AuditArchiveInfo> {
  const pub = vault().signingPublicKey();
  if (!pub) throw new Error('No signing key – unlock the vault');
  const dir = archivesDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = newId();
  const end = range.end;
  const name = `steward-audit-${range.month}-${pad(range.firstSeq)}-${pad(end.seq)}.zip`;
  const file = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.tmp`);
  if (fs.existsSync(file)) throw new Error(`${name} already exists in ${dir} – move it away to archive this range again`);
  fs.rmSync(tmp, { force: true });
  const st = { prev: { seq: range.firstSeq - 1, hash: range.startHash }, digest: range.startDigest, count: 0, firstTs: '', lastTs: '' };
  // the entries straight from the database, in pages; linkage and the public digest are checked on the way
  async function* entries(): AsyncGenerator<Buffer> {
    for (let seq = range.firstSeq; seq <= end.seq;) {
      const rows = db().all<AuditRow>('SELECT * FROM audit_log WHERE seq >= ? AND seq <= ? ORDER BY seq LIMIT ?', seq, end.seq, PAGE);
      if (!rows.length) break;
      let out = '';
      for (const r of rows) {
        const e: AuditEntry = toEntry(r);
        if (e.seq !== st.prev.seq + 1) throw new Error(`Entry #${st.prev.seq + 1} is missing`);
        if (e.prevHash !== st.prev.hash) throw new Error(`Entry #${e.seq} does not link to entry #${st.prev.seq}`);
        st.digest = digestStep(st.digest, e);
        st.prev = { seq: e.seq, hash: e.hash };
        st.count++;
        if (!st.firstTs) st.firstTs = e.ts;
        st.lastTs = e.ts;
        out += JSON.stringify(e) + '\n';
      }
      yield Buffer.from(out, 'utf8');
      seq = Number(rows.at(-1)!.seq) + 1;
      await turn();
    }
  }
  const zip = await ZipWriter.create(tmp);
  try {
    const entriesFile = await zip.add(ARCHIVE_ENTRIES, Readable.from(entries()), { compress: true });
    if (st.prev.seq !== end.seq || st.prev.hash !== end.hash || st.digest !== end.digest)
      throw new Error(`Entries #${range.firstSeq}–#${end.seq} in the database differ from what the signed checkpoint #${end.seq} covers`);
    const cpFile = await zip.add(ARCHIVE_CHECKPOINTS, Buffer.from(JSON.stringify(range.checkpoints, null, 1) + '\n'), { compress: true });
    const manifest: ArchiveManifest = {
      format: ARCHIVE_FORMAT,
      version: 1,
      archive: {
        id,
        firstSeq: range.firstSeq,
        lastSeq: end.seq,
        firstTs: st.firstTs,
        lastTs: st.lastTs,
        entries: st.count,
        epochs: range.checkpoints.length,
        startHash: range.startHash,
        startDigest: range.startDigest,
        createdAt: nowIso(),
        createdBy: by,
      },
      startCheckpoint: range.startCheckpoint,
      endCheckpoint: end,
      keyFingerprint: publicKeyFingerprint(pub),
      files: [entriesFile, cpFile].map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    await zip.add('manifest.json', manifestBytes, { compress: true });
    await zip.add('manifest.sig', Buffer.from(vault().sign(Buffer.concat([Buffer.from(ARCHIVE_SIGNATURE_DOMAIN, 'utf8'), manifestBytes])) + '\n'));
    await zip.add('public-key.pem', Buffer.from(publicKeyPem(pub)));
    await zip.finish();
  } catch (e) {
    // the archive failed already; that error is thrown below, a failing abort adds nothing
    await zip.abort().catch(() => undefined);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  const check = await verifyArchive(tmp, { publicKey: publicKeyPem(pub) });
  if (!check.ok) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`The archive written does not verify: ${check.message}`);
  }
  fs.renameSync(tmp, file);
  const size = fs.statSync(file).size;
  const sha = await fileSha256(file);
  const row = {
    id,
    first_seq: range.firstSeq,
    last_seq: end.seq,
    first_ts: st.firstTs,
    last_ts: st.lastTs,
    entries: st.count,
    epochs: range.checkpoints.length,
    start_hash: range.startHash,
    start_digest: range.startDigest,
    checkpoint: JSON.stringify(end),
    file: name,
    size,
    sha256: sha,
    created_at: nowIso(),
    created_by: by,
  };
  db().tx(() => {
    db().run(
      `INSERT INTO audit_archives (id, first_seq, last_seq, first_ts, last_ts, entries, epochs, start_hash, start_digest, checkpoint, file, size, sha256, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...Object.values(row),
    );
    audit({
      actor: by,
      action: 'audit.archived',
      entityType: 'audit_archive',
      entityId: id,
      summary: `Audit entries #${range.firstSeq}–#${end.seq} (${st.count}, ${range.checkpoints.length} epochs of ${range.month}) archived to ${name}, sha256 ${sha.slice(0, 16)}…`,
      details: {
        file: name,
        firstSeq: range.firstSeq,
        lastSeq: end.seq,
        entries: st.count,
        epochs: range.checkpoints.length,
        size,
        sha256: sha,
        checkpoint: end,
      },
    });
  });
  logger.info({ archive: { id, file: name, firstSeq: range.firstSeq, lastSeq: end.seq, sha256: sha } }, 'audit archive written');
  return toInfo({ ...row, remote_key: null, uploaded_at: null, prune_started_at: null, pruned_at: null, pruned_entries: null });
}

async function uploadPending(by: string): Promise<{ uploaded: number; failed: string | null }> {
  let uploaded = 0;
  for (const r of db().all<ArchiveRow>('SELECT * FROM audit_archives WHERE uploaded_at IS NULL ORDER BY last_seq')) {
    const f = archiveFile(r);
    if (!fs.existsSync(f)) continue; // moved away by hand: nothing to upload
    try {
      const { uploadToBackupTarget } = await import('./backup/service.js');
      const up = await uploadToBackupTarget(f, 'audit-archives', r.file);
      db().tx(() => {
        db().run('UPDATE audit_archives SET remote_key = ?, uploaded_at = ? WHERE id = ?', up.key, nowIso(), r.id);
        audit({
          actor: by,
          action: 'audit.archive_uploaded',
          entityType: 'audit_archive',
          entityId: r.id,
          summary: `Audit archive ${r.file} uploaded to the backup target as ${up.key} (encrypted, ${up.bytes} bytes)`,
          details: { key: up.key, bytes: up.bytes, sha256: up.sha256 },
        });
      });
      uploaded++;
    } catch (e) {
      const message = (e as Error).message.slice(0, 500);
      logger.warn({ err: message, archive: r.file }, 'audit archive could not be uploaded');
      audit({
        actor: by,
        action: 'audit.archive_upload_failed',
        entityType: 'audit_archive',
        entityId: r.id,
        summary: `Audit archive ${r.file} could not be uploaded: ${message}`,
      });
      return { uploaded, failed: message };
    }
  }
  return { uploaded, failed: null };
}

/** Deletes the entries of archives older than the retention period (and finishes an interrupted deletion). */
async function deleteArchived(by: string, now: number): Promise<{ deleted: number; archives: number; blocked: string | null }> {
  const s = archiveSettings();
  const out = { deleted: 0, archives: 0, blocked: null as string | null };
  const cutoff = new Date(now - s.retentionDays * DAY).toISOString();
  for (const r of db().all<ArchiveRow>('SELECT * FROM audit_archives WHERE pruned_at IS NULL ORDER BY last_seq')) {
    if (!r.prune_started_at) {
      if (!s.archive || !s.retentionDays || r.last_ts >= cutoff) break;
      // not under a full verification that is walking these entries (it would find them missing)
      if (fullJob) {
        out.blocked = 'a full verification is running';
        break;
      }
      if (s.upload && !r.uploaded_at) {
        out.blocked = `${r.file} is not uploaded yet`;
        break;
      }
      // only what is safely archived: the file is there and unchanged
      const f = archiveFile(r);
      const intact = fs.existsSync(f) && (await fileSha256(f)) === r.sha256;
      if (!intact) {
        out.blocked = `${r.file} is missing from ${archivesDir()} or was changed`;
        logger.warn({ archive: r.file }, 'audit archive missing or changed – its entries are not deleted');
        break;
      }
      const cp = JSON.parse(r.checkpoint) as AuditCheckpoint;
      db().tx(() => {
        audit({
          actor: by,
          action: DELETE_STARTED_ACTION,
          entityType: 'audit_archive',
          entityId: r.id,
          summary: `Archived audit entries #${r.first_seq}–#${r.last_seq} older than ${s.retentionDays} days are deleted from the database (archive ${r.file}; entries other evidence relies on are kept)`,
          details: {
            archiveId: r.id,
            file: r.file,
            sha256: r.sha256,
            firstSeq: Number(r.first_seq),
            throughSeq: Number(r.last_seq),
            checkpointHash: cp.hash,
            checkpointDigest: cp.digest,
            retentionDays: s.retentionDays,
          },
        });
        db().run('UPDATE audit_archives SET prune_started_at = ? WHERE id = ?', nowIso(), r.id);
      });
      resetPrunedBase();
    }
    let n = 0;
    for (;;) {
      const c = db().run(
        `DELETE FROM audit_log WHERE seq IN (SELECT seq FROM audit_log WHERE seq >= ? AND seq <= ? AND NOT ${KEPT_ON_DELETE_SQL} ORDER BY seq LIMIT ?)`,
        r.first_seq,
        r.last_seq,
        DELETE_BATCH,
      ).changes;
      n += c;
      if (c < DELETE_BATCH) break;
      await turn();
    }
    const kept = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log WHERE seq >= ? AND seq <= ?', r.first_seq, r.last_seq)!.n);
    const total = Number(r.pruned_entries ?? 0) + n;
    db().tx(() => {
      db().run('UPDATE audit_archives SET pruned_at = ?, pruned_entries = ? WHERE id = ?', nowIso(), total, r.id);
      audit({
        actor: by,
        action: 'audit.entries_deleted',
        entityType: 'audit_archive',
        entityId: r.id,
        summary: `${total} archived audit entries #${r.first_seq}–#${r.last_seq} deleted from the database (archive ${r.file}); ${kept} kept as evidence`,
        details: { archiveId: r.id, firstSeq: Number(r.first_seq), throughSeq: Number(r.last_seq), deleted: total, kept },
      });
    });
    out.deleted += n;
    out.archives++;
  }
  return out;
}

let archiving: Promise<ArchivingResult> | null = null;

export interface ArchivingResult {
  archived: AuditArchiveInfo[];
  uploaded: number;
  deleted: number;
  problems: string[];
}

/**
 * Archives every closed month of epochs, uploads pending archives and applies the retention period. Run by the daily
 * cleanup (maintenance.ts) and by hand (POST /api/audit/archive/run). One at a time.
 */
export function runArchiving(o: { by?: string; now?: number } = {}): Promise<ArchivingResult> {
  if (archiving) return archiving;
  const by = o.by ?? currentActor();
  archiving = doArchiving(by, o.now ?? Date.now()).finally(() => {
    archiving = null;
  });
  return archiving;
}

async function doArchiving(by: string, now: number): Promise<ArchivingResult> {
  const out: ArchivingResult = { archived: [], uploaded: 0, deleted: 0, problems: [] };
  const s = archiveSettings();
  if (!vault().unlocked) return out;
  // an interrupted deletion is finished even when archiving was turned off since
  const interrupted = db().get('SELECT 1 FROM audit_archives WHERE prune_started_at IS NOT NULL AND pruned_at IS NULL');
  if (!s.archive && !interrupted) return out;
  if (s.archive) {
    for (let i = 0; i < 240; i++) {
      const range = nextArchiveRange(now);
      if (!range) break;
      try {
        out.archived.push(await buildArchive(range, by));
      } catch (e) {
        const message = (e as Error).message.slice(0, 500);
        out.problems.push(message);
        logger.error({ err: message }, 'audit archive could not be written');
        audit({
          actor: by,
          action: 'audit.archive_failed',
          entityType: 'audit',
          summary: `Audit entries #${range.firstSeq}–#${range.end.seq} could not be archived: ${message}`,
        });
        break;
      }
    }
    if (s.upload) {
      const up = await uploadPending(by);
      out.uploaded = up.uploaded;
      if (up.failed) out.problems.push(`Upload: ${up.failed}`);
    }
  }
  const del = await deleteArchived(by, now);
  out.deleted = del.deleted;
  if (del.blocked && s.retentionDays) out.problems.push(`Retention: ${del.blocked}`);
  return out;
}

// ---------- full verification in the background ----------

interface FullJob {
  startedAt: string;
  by: string;
  checked: number;
  total: number;
  done: Promise<VerifyOutcome>;
}
let fullJob: FullJob | null = null;

/** The archive files in the data folder are unchanged (SHA-256 as recorded); missing files are only noted. */
async function checkArchiveFiles(): Promise<{ problem: string | null; note: string | null }> {
  const missing: string[] = [];
  for (const r of db().all<ArchiveRow>('SELECT * FROM audit_archives ORDER BY last_seq')) {
    const f = archiveFile(r);
    if (!fs.existsSync(f)) {
      missing.push(r.file);
      continue;
    }
    if ((await fileSha256(f)) !== r.sha256) return { problem: `The audit archive ${r.file} was changed (SHA-256 differs from the one recorded)`, note: null };
  }
  return { problem: null, note: missing.length ? `${missing.length} archive file(s) are not in the data folder (${missing.slice(0, 3).join(', ')})` : null };
}

/** A full verification (all entries in the database, then the archive files), as it runs in the background. */
async function fullVerification(by: string, job?: FullJob): Promise<VerifyOutcome> {
  let r = await verifyWithAnchors([], {
    mode: 'full',
    by,
    onProgress: (checked, total) => {
      if (job) Object.assign(job, { checked, total });
    },
    extraCheck: async () => {
      const files = await checkArchiveFiles();
      return files;
    },
  });
  audit({
    actor: by,
    action: 'audit.verified',
    entityType: 'audit',
    summary: `Audit chain verified in full: ${r.message}`,
    details: { ...publicResult(r), mode: 'full' },
  });
  if (r.ok) {
    const cp = await createCheckpoint('verify');
    if (cp) r = { ...r, checkpoint: cp };
  }
  return r;
}

/** Starts a full verification in the background (one at a time); its progress is in archiveStatus(). */
export function startFullVerification(by = currentActor()): { started: boolean } {
  if (fullJob) return { started: false };
  if (!vault().unlocked) throw new HttpError(409, 'Unlock the vault first', 'VAULT_LOCKED');
  const job: FullJob = { startedAt: nowIso(), by, checked: 0, total: 0, done: Promise.resolve(null as unknown as VerifyOutcome) };
  fullJob = job;
  job.done = fullVerification(by, job)
    .catch((e: Error) => {
      logger.error({ err: e }, 'full verification of the audit chain failed to run');
      return { ok: false, checked: job.checked, message: `The verification could not run: ${e.message}` } as VerifyOutcome;
    })
    .finally(() => {
      if (fullJob === job) fullJob = null;
    });
  return { started: true };
}

/** Tests: the running full verification (or null). */
export const runningFullVerification = (): Promise<VerifyOutcome> | null => fullJob?.done ?? null;

/** The scheduled full verification (hourly job "audit-full-verification", jobs/builtin.ts): every FULL_VERIFY_DAYS. */
export function scheduledFullVerification(now = Date.now()): boolean {
  if (!FULL_VERIFY_DAYS || fullJob || !vault().unlocked) return false;
  const last = lastVerifications().full;
  if (last && now - Date.parse(last.at) < FULL_VERIFY_DAYS * DAY) return false;
  return startFullVerification('system').started;
}

// ---------- status ----------

export function archiveStatus(canUpload: boolean): AuditArchiveStatus {
  const d = db();
  const last = d.get<ArchiveRow>('SELECT * FROM audit_archives ORDER BY last_seq DESC LIMIT 1');
  const base = prunedBase();
  const pruned = base && !('problem' in base) ? (base as PrunedBase) : null;
  const closed = Number(d.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'audit.checkpoint'")!.n);
  const archivedEpochs = Number(d.get<{ n: number | null }>('SELECT SUM(epochs) AS n FROM audit_archives')!.n ?? 0);
  const latestEntry = d.get<{ details: string }>("SELECT details FROM audit_log WHERE action = 'audit.checkpoint' ORDER BY seq DESC LIMIT 1");
  const latest = latestEntry ? parseJson<AuditCheckpoint | null>(latestEntry.details, null) : null;
  const v = lastVerifications();
  return {
    settings: archiveSettings(),
    canUpload,
    // checkpoint entries of deleted ranges are kept, so they still count
    epochs: { closed: Math.max(closed, archivedEpochs), archived: archivedEpochs },
    latestCheckpoint: latest ? { seq: latest.seq, ts: latest.ts } : null,
    archivedThrough: last ? { seq: Number(last.last_seq), ts: last.last_ts } : null,
    deletedThrough: pruned ? { seq: pruned.seq, ts: pruned.ts } : null,
    entriesInDatabase: Number(d.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log WHERE seq >= 1')!.n),
    archives: listArchives(),
    verification: {
      incremental: v.incremental,
      full: v.full,
      running: fullJob ? { startedAt: fullJob.startedAt, by: fullJob.by, checked: fullJob.checked, total: fullJob.total } : null,
      fullIntervalDays: FULL_VERIFY_DAYS,
    },
  };
}

export async function archiveStatusAsync(): Promise<AuditArchiveStatus> {
  return archiveStatus(await uploadAvailable().catch(() => false));
}

/** An archive file for download (auditors and administrators); audited. */
export function archiveForDownload(id: string): { file: string; name: string } {
  const r = archiveRow(id);
  const f = archiveFile(r);
  if (!fs.existsSync(f)) throw new HttpError(404, `${r.file} is no longer in the data folder`, 'AUDIT_ARCHIVE_FILE_MISSING');
  audit({ action: 'audit.archive_downloaded', entityType: 'audit_archive', entityId: r.id, summary: `Audit archive ${r.file} downloaded` });
  return { file: f, name: r.file };
}
