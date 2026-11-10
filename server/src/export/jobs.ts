import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Cron } from 'croner';
import { z } from 'zod';
import {
  BRAND,
  EXPORT_FISCAL_YEARS,
  EXPORT_FORMATS,
  EXPORT_LIMITS,
  EXPORT_PART_IDS,
  type ExportFileInfo,
  type ExportJob,
  type ExportJobInput,
  type ExportPartChoice,
  type ExportRun,
  type ExportsStatus,
} from '@sm/shared';
import { config } from '../config.js';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { HttpError, newId, nowIso, parseJson, sha256 } from '../util.js';
import { currentActor, runAs, type AuthUser } from '../auth/context.js';
import { listUsers } from '../auth/users.js';
import { getPlatform, getSecrets } from '../platforms/service.js';
import { backupKey, backupKeySet, backupSettings, s3Client, storagePlatform } from '../backup/service.js';
import { encryptFile } from '../backup/crypto.js';
import type { S3Client } from '../backup/s3.js';
import { exportPart, exportPartInfos, EXPORT_PARTS, partLimits, type ExportContext, type ExportWriter } from './parts.js';

/**
 * Scheduled exports to S3 (0.16.0, docs/EXPORTS.md, ADR 0027): an administrator defines an export – a name, a
 * schedule, an S3 target (the backup's platform or another one, with its own folder) and the parts to export – and
 * Steward writes readable files on that schedule to `<prefix><name>/<UTC time>/<file>`, with a manifest.json that
 * names every file with its size and SHA-256. Optionally every file is encrypted with the backup key (the backup file
 * format; `steward backup decrypt` reads it). The newest `keepRuns` successful runs stay in the bucket; the retention
 * rule only removes files that a run of this export wrote (from the run history, never by listing the bucket).
 *
 * Exports are for sharing and archiving outside Steward, not for a restore. They run as the system and contain
 * everything of their parts – only administrators define them, and a change asks for a step-up (control point
 * export.settings). No part writes a secret (parts.ts).
 */

/** The principal exports run as: sees everything, like an administrator. Audit entries name "system". */
export const EXPORT_USER: AuthUser = { id: 'system', username: 'system', displayName: `${BRAND.name} (export)`, roles: ['admin'], teams: [] };

const WORK = '.export-work';
/** Bytes a work file buffers before it writes them */
const WRITE_BUFFER = 256 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Folder names Steward writes below a backup prefix itself */
const RESERVED_NAMES = new Set(['audit-archives']);

const partChoice = z
  .object({
    id: z.enum(EXPORT_PART_IDS),
    format: z.enum(EXPORT_FORMATS),
    fiscalYear: z.enum(EXPORT_FISCAL_YEARS).optional(),
    days: z.number().int().min(1).max(EXPORT_LIMITS.auditDaysMax).optional(),
  })
  .strict();

export const exportJobSchema = z
  .object({
    name: z.string().trim().min(1).max(EXPORT_LIMITS.nameMax).regex(NAME_RE, 'Use letters, digits and . _ - (it is the folder in the bucket)'),
    enabled: z.boolean(),
    platformId: z.string().trim().min(1).max(100).nullable(),
    prefix: z
      .string()
      .trim()
      .max(200)
      .regex(/^([A-Za-z0-9._-]+\/)*$/, 'Use folder names of letters, digits and . _ - , each ending with /'),
    cron: z.string().trim().min(1).max(100),
    timezone: z.string().trim().min(1).max(64),
    parts: z.array(partChoice).min(1, 'Choose at least one part to export').max(EXPORT_PARTS.length),
    encrypt: z.boolean(),
    keepRuns: z.number().int().min(1).max(EXPORT_LIMITS.keepRunsMax),
  })
  .strict();

interface JobRow {
  id: string;
  name: string;
  enabled: number;
  platform_id: string | null;
  prefix: string;
  cron: string;
  timezone: string;
  parts: string;
  encrypt: number;
  keep_runs: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  target_fingerprint: string | null;
}

interface RunRow {
  id: string;
  job_id: string;
  status: ExportRun['status'];
  trigger_kind: ExportRun['trigger'];
  triggered_by: string | null;
  started_at: string;
  finished_at: string | null;
  platform_id: string | null;
  folder: string | null;
  files: string;
  bytes: number | null;
  message: string | null;
  pruned: number;
}

const toRun = (r: RunRow): ExportRun => ({
  id: r.id,
  jobId: r.job_id,
  status: r.status,
  trigger: r.trigger_kind,
  triggeredBy: r.triggered_by,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  folder: r.folder,
  files: parseJson<ExportFileInfo[]>(r.files, []),
  bytes: r.bytes === null ? null : Number(r.bytes),
  message: r.message,
  pruned: !!Number(r.pruned),
});

const running = new Map<string, Promise<void>>();

function nextRun(cron: string, tz: string, on: boolean): string | null {
  if (!on) return null;
  try {
    const j = new Cron(cron, { paused: true, timezone: tz });
    const n = j.nextRun();
    j.stop();
    return n ? n.toISOString() : null;
  } catch {
    return null;
  }
}

// ---------- the confirmed target ----------

/**
 * What identifies where an export's files go: the platform, its address (the bucket), region and service, how it
 * connects (proxy, TLS, extra origins, the role it assumes, its variables), the access key id (hashed – never a
 * secret) and the folder. The platform can be changed by whoever manages it, without the export's step-up; a run
 * compares this with the fingerprint an administrator confirmed (ADR 0027).
 */
export function targetFingerprint(platformId: string | null, prefix: string): string {
  const p = storagePlatform(platformId);
  const aws = p.config.auth?.aws;
  const http = p.config.http ?? {};
  const secrets = getSecrets(p.id);
  return sha256(
    JSON.stringify({
      v: 1,
      platform: p.id,
      baseUrl: (p.baseUrl ?? '').trim().replace(/\/+$/, ''),
      variables: p.config.variables ?? {},
      region: aws?.region ?? null,
      service: aws?.service ?? null,
      roleArn: aws?.roleArn ?? null,
      externalId: aws?.externalId ?? null,
      stsEndpoint: aws?.stsEndpoint ?? null,
      proxy: http.proxy ?? null,
      insecureTls: !!http.insecureTls,
      caPem: http.caPem ? sha256(http.caPem) : null,
      trustedOrigins: http.trustedOrigins ?? [],
      accessKey: sha256(`access-key-id:${secrets.accessKeyId ?? ''}`),
      prefix,
    }),
  );
}

/** Whether the target differs from the confirmed one (a target that cannot be read is reported by the run). */
function targetChanged(r: JobRow): boolean {
  if (!r.target_fingerprint) return true;
  try {
    return targetFingerprint(r.platform_id, r.prefix) !== r.target_fingerprint;
  } catch {
    return false;
  }
}

function toJob(r: JobRow): ExportJob {
  const last = db().get<RunRow>('SELECT * FROM export_runs WHERE job_id = ? ORDER BY started_at DESC, id DESC LIMIT 1', r.id);
  return {
    id: r.id,
    name: r.name,
    enabled: !!Number(r.enabled),
    platformId: r.platform_id,
    prefix: r.prefix,
    cron: r.cron,
    timezone: r.timezone,
    parts: parseJson<ExportPartChoice[]>(r.parts, []),
    encrypt: !!Number(r.encrypt),
    keepRuns: Number(r.keep_runs),
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
    nextRunAt: nextRun(r.cron, r.timezone, !!Number(r.enabled)),
    running: running.has(r.id),
    lastRun: last ? toRun(last) : null,
    targetChanged: targetChanged(r),
  };
}

function jobRow(id: string): JobRow {
  const r = db().get<JobRow>('SELECT * FROM export_jobs WHERE id = ?', id);
  if (!r) throw new HttpError(404, 'Export not found', 'EXPORT_NOT_FOUND');
  return r;
}

export const getExportJob = (id: string): ExportJob => toJob(jobRow(id));

export async function exportsStatus(): Promise<ExportsStatus> {
  return {
    jobs: db().all<JobRow>('SELECT * FROM export_jobs ORDER BY name').map(toJob),
    parts: await exportPartInfos(),
    encryptionAvailable: backupKeySet(),
    backupPlatformId: backupSettings().platformId,
  };
}

export function listExportRuns(jobId: string, limit = 30): ExportRun[] {
  jobRow(jobId);
  return db()
    .all<RunRow>('SELECT * FROM export_runs WHERE job_id = ? ORDER BY started_at DESC, id DESC LIMIT ?', jobId, Math.min(200, Math.max(1, limit)))
    .map(toRun);
}

// ---------- definitions ----------

function checkCron(cron: string, tz: string): void {
  let job: Cron;
  try {
    job = new Cron(cron, { paused: true, timezone: tz });
  } catch (e) {
    throw new HttpError(400, `Invalid cron expression for the export: ${(e as Error).message}`, 'CRON_INVALID', { detail: (e as Error).message });
  }
  job.stop();
  if (cron.trim().split(/\s+/).length !== 5)
    throw new HttpError(400, 'Use a cron expression with five fields (minute hour day month weekday)', 'CRON_FIVE_FIELDS', { context: 'export' });
}

/** Checks an export definition: target, schedule, parts and their formats, encryption. */
function checkInput(input: unknown, id: string | null): ExportJobInput {
  const v = exportJobSchema.parse(input) as ExportJobInput;
  if (RESERVED_NAMES.has(v.name.toLowerCase()))
    throw new HttpError(400, `"${v.name}" is a folder Steward uses itself – choose another name`, 'EXPORT_NAME_RESERVED');
  checkCron(v.cron, v.timezone);
  if (!v.platformId) throw new HttpError(400, 'Choose the S3 platform the export goes to', 'EXPORT_NO_STORAGE');
  storagePlatform(v.platformId);
  const seen = new Set<string>();
  for (const p of v.parts) {
    if (seen.has(p.id)) throw new HttpError(400, `The part ${p.id} is chosen twice`, 'EXPORT_PART_TWICE', { part: p.id });
    seen.add(p.id);
    const def = exportPart(p.id)!;
    if (!def.formats.includes(p.format))
      throw new HttpError(400, `The part ${p.id} is exported as ${def.formats.join(' or ')}, not ${p.format}`, 'EXPORT_FORMAT_UNSUPPORTED', {
        part: p.id,
        format: p.format,
      });
  }
  if (v.encrypt && !backupKeySet())
    throw new HttpError(400, 'Encrypted exports use the backup key: set the backup passphrase first (Settings → Backups)', 'EXPORT_NO_KEY');
  const clash = db().get<{ id: string }>('SELECT id FROM export_jobs WHERE lower(name) = lower(?)', v.name);
  if (clash && clash.id !== id) throw new HttpError(409, `There is an export named "${v.name}" already`, 'EXPORT_NAME_TAKEN', { name: v.name });
  return v;
}

const describe = (v: ExportJobInput) =>
  `${v.parts.map((p) => `${p.id} (${p.format})`).join(', ')} to ${getPlatform(v.platformId!).name}/${v.prefix}${v.name}/ (${v.enabled ? `${v.cron} ${v.timezone}` : 'not scheduled'}${v.encrypt ? ', encrypted' : ', readable'}, keeping ${v.keepRuns} runs)`;

export function createExportJob(input: unknown): ExportJob {
  const n = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM export_jobs')?.n ?? 0);
  if (n >= EXPORT_LIMITS.jobs) throw new HttpError(400, `At most ${EXPORT_LIMITS.jobs} exports`, 'EXPORT_LIMIT', { max: EXPORT_LIMITS.jobs });
  const v = checkInput(input, null);
  const id = newId('exp');
  const at = nowIso();
  const by = currentActor();
  db().tx(() => {
    db().run(
      `INSERT INTO export_jobs (id, name, enabled, platform_id, prefix, cron, timezone, parts, encrypt, keep_runs, created_at, created_by, updated_at, updated_by,
       target_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      v.name,
      v.enabled ? 1 : 0,
      v.platformId,
      v.prefix,
      v.cron,
      v.timezone,
      JSON.stringify(v.parts),
      v.encrypt ? 1 : 0,
      v.keepRuns,
      at,
      by,
      at,
      by,
      // what the administrator confirmed with the step-up
      targetFingerprint(v.platformId, v.prefix),
    );
    audit({ action: 'export.job_created', entityType: 'export', entityId: id, summary: `Export "${v.name}" defined: ${describe(v)}`, details: v });
  });
  scheduleExportJobs();
  return getExportJob(id);
}

export function updateExportJob(id: string, input: unknown): ExportJob {
  const before = toJob(jobRow(id));
  const v = checkInput(input, id);
  db().tx(() => {
    db().run(
      `UPDATE export_jobs SET name = ?, enabled = ?, platform_id = ?, prefix = ?, cron = ?, timezone = ?, parts = ?, encrypt = ?, keep_runs = ?,
       updated_at = ?, updated_by = ?, target_fingerprint = ? WHERE id = ?`,
      v.name,
      v.enabled ? 1 : 0,
      v.platformId,
      v.prefix,
      v.cron,
      v.timezone,
      JSON.stringify(v.parts),
      v.encrypt ? 1 : 0,
      v.keepRuns,
      nowIso(),
      currentActor(),
      targetFingerprint(v.platformId, v.prefix),
      id,
    );
    const { id: _i, createdAt: _c, createdBy: _b, updatedAt: _u, updatedBy: _ub, nextRunAt: _n, running: _r, lastRun: _l, targetChanged: _t, ...was } = before;
    audit({
      action: 'export.job_changed',
      entityType: 'export',
      entityId: id,
      summary: `Export "${v.name}" changed: ${describe(v)}`,
      details: { before: was, after: v },
    });
  });
  scheduleExportJobs();
  return getExportJob(id);
}

/**
 * Confirms the export's S3 target as the platform is now (after its platform was changed): an administrator with a
 * step-up, like a change of the export. Audited with the target as it is confirmed.
 */
export function confirmExportTarget(id: string): ExportJob {
  const r = jobRow(id);
  const p = storagePlatform(r.platform_id);
  const fingerprint = targetFingerprint(r.platform_id, r.prefix);
  db().tx(() => {
    db().run('UPDATE export_jobs SET target_fingerprint = ?, updated_at = ?, updated_by = ? WHERE id = ?', fingerprint, nowIso(), currentActor(), id);
    audit({
      action: 'export.target_confirmed',
      entityType: 'export',
      entityId: id,
      summary: `Export "${r.name}": the S3 target confirmed as ${p.name} (${p.baseUrl}${p.config.auth?.aws?.region ? `, ${p.config.auth.aws.region}` : ''})/${r.prefix}${r.name}/`,
      details: {
        platformId: p.id,
        platform: p.name,
        baseUrl: p.baseUrl,
        region: p.config.auth?.aws?.region ?? null,
        prefix: r.prefix,
        changed: r.target_fingerprint !== fingerprint,
      },
    });
  });
  return getExportJob(id);
}

/** Removes the definition and its history; the files in the bucket stay (remove them there). */
export function removeExportJob(id: string): void {
  const r = jobRow(id);
  if (running.has(id)) throw new HttpError(409, 'The export is running – remove it when the run has ended', 'EXPORT_BUSY');
  db().tx(() => {
    db().run('DELETE FROM export_runs WHERE job_id = ?', id);
    db().run('DELETE FROM export_jobs WHERE id = ?', id);
    audit({
      action: 'export.job_removed',
      entityType: 'export',
      entityId: id,
      summary: `Export "${r.name}" removed (its files in the bucket stay)`,
      details: { name: r.name, platformId: r.platform_id, prefix: r.prefix },
    });
  });
  scheduleExportJobs();
}

// ---------- runs ----------

/** A work folder in the data folder (0700), not /tmp and not the backup's (emptied by every backup). */
function workDir(): string {
  const dir = path.join(config.dataDir, WORK);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  return dir;
}

const stampOf = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/** Starts a run of an export in the background; the run is returned right away (status running). */
export function startExportRun(jobId: string, trigger: ExportRun['trigger']): ExportRun {
  const job = toJob(jobRow(jobId));
  if (running.has(jobId)) throw new HttpError(409, 'This export is running', 'EXPORT_BUSY');
  storagePlatform(job.platformId);
  if (job.encrypt) backupKey();
  const run: ExportRun = {
    id: newId('xrun'),
    jobId,
    status: 'running',
    trigger,
    triggeredBy: trigger === 'manual' ? currentActor() : null,
    startedAt: nowIso(),
    finishedAt: null,
    folder: null,
    files: [],
    bytes: null,
    message: null,
    pruned: false,
  };
  db().run(
    'INSERT INTO export_runs (id, job_id, status, trigger_kind, triggered_by, started_at, platform_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    run.id,
    jobId,
    'running',
    trigger,
    run.triggeredBy,
    run.startedAt,
    job.platformId,
  );
  let code: string | undefined;
  const p = runExport(job, run)
    .then(
      () => {
        run.status = 'succeeded';
      },
      (e: Error) => {
        logger.warn({ err: e, export: job.name }, 'export failed');
        run.status = 'failed';
        run.message = e.message;
        code = e instanceof HttpError ? e.code : undefined;
      },
    )
    .then(() => finish(job, run, code))
    .catch((err) => logger.error({ err }, 'could not record an export run'))
    .finally(() => running.delete(jobId));
  running.set(jobId, p);
  return run;
}

/**
 * Waits for the running exports (tests, shutdown) – at most `timeoutMs`; true when none runs any more. At shutdown
 * stopExportJobs() has asked them to stop at the next file: a run that ends removes what it uploaded; one that is
 * still going when the process ends keeps its uploaded files recorded, and they are removed after the next start.
 */
export async function exportsIdle(timeoutMs?: number): Promise<boolean> {
  const until = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
  while (running.size) {
    const left = until - Date.now();
    if (left <= 0) return false;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all([...running.values()]), ...(Number.isFinite(left) ? [new Promise((resolve) => (timer = setTimeout(resolve, left)))] : [])]);
    clearTimeout(timer);
  }
  return true;
}

/** Set while the server stops: a run ends at its next file (and removes what it uploaded). */
let stopping = false;
const INTERRUPTED = 'Interrupted (the server stopped)';
function checkStopping(): void {
  if (stopping) throw new Error(INTERRUPTED);
}

/** Records the files of a run as they are uploaded – the retention rule can remove them whatever happens to the run. */
function recordFiles(run: ExportRun): void {
  db().run('UPDATE export_runs SET folder = ?, files = ? WHERE id = ?', run.folder, JSON.stringify(run.files), run.id);
}

/** The content type of an exported file, by its name (encrypted files are application/octet-stream). */
export function contentTypeOf(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return (
    { csv: 'text/csv; charset=utf-8', json: 'application/json', jsonl: 'application/x-ndjson', yaml: 'application/yaml' }[ext] ?? 'application/octet-stream'
  );
}

/**
 * A file of a part in the work folder: written in pieces (buffered), hashed while it is written – a part never builds
 * its whole file as one string, and the file is never read again to hash it.
 */
class WorkFile implements ExportWriter {
  readonly path: string;
  bytes = 0;
  private readonly hash = crypto.createHash('sha256');
  private readonly fh: Promise<fs.promises.FileHandle>;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private closed = false;

  constructor(
    dir: string,
    runId: string,
    readonly name: string,
  ) {
    this.path = path.join(dir, `${runId}-${newId()}`);
    this.fh = fs.promises.open(this.path, 'wx', 0o600);
    this.fh.catch(() => undefined); // reported by the first write
  }

  async write(text: string): Promise<void> {
    if (this.closed) throw new Error(`${this.name} was written after it was closed`);
    checkStopping();
    if (!text) return;
    const b = Buffer.from(text, 'utf8');
    this.hash.update(b);
    this.bytes += b.length;
    this.pending.push(b);
    this.pendingBytes += b.length;
    if (this.pendingBytes >= WRITE_BUFFER) await this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.pendingBytes) return;
    const data = Buffer.concat(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    await (await this.fh).writeFile(data);
  }

  /** Writes what is buffered and closes the file; returns the SHA-256 of what was written. */
  async close(): Promise<string> {
    if (!this.closed) {
      this.closed = true;
      await this.flush();
      await (await this.fh).close();
    }
    return this.hash.copy().digest('hex');
  }

  /** Closes the file without writing what is buffered (a failed run). */
  async discard(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.pending = [];
    // the file is removed next; a handle that never opened has nothing to close
    await this.fh.then((h) => h.close()).catch(() => undefined);
  }
}

/** The run's target is the one an administrator confirmed – checked before anything is written or listed. */
function checkTarget(jobId: string): void {
  const r = jobRow(jobId);
  if (r.target_fingerprint && targetFingerprint(r.platform_id, r.prefix) === r.target_fingerprint) return;
  throw new HttpError(
    409,
    `The S3 target of the export changed since an administrator confirmed it (its platform's address, region, connection or access key) – nothing was written. Check the platform, then confirm the target under Settings → Exports`,
    'EXPORT_TARGET_CHANGED',
    { name: r.name },
  );
}

async function runExport(job: ExportJob, run: ExportRun): Promise<void> {
  const now = new Date(run.startedAt);
  checkTarget(job.id);
  const c = s3Client(job.platformId);
  const enc = job.encrypt ? backupKey() : null;
  const base = `${job.prefix}${job.name}/${stampOf(now)}`;
  // a second run within the same second gets a suffix (never overwrite an export)
  const existing = new Set((await c.list(`${base}`)).map((o) => o.key.slice(base.length).split('/')[0]));
  let folder = `${base}/`;
  for (let n = 2; existing.has(folder.slice(base.length, -1)); n++) folder = `${base}-${n}/`;
  run.folder = folder;
  recordFiles(run);
  const dir = workDir();
  const { moduleEnabled } = await import('../modules/registry.js');
  const skipped: { part: string; reason: string }[] = [];
  const parts: { id: string; format: string; options: Record<string, unknown>; files: string[]; notes?: Record<string, unknown> }[] = [];
  const work: WorkFile[] = [];
  const upload = async (part: ExportFileInfo['part'], f: WorkFile): Promise<void> => {
    const hash = await f.close();
    const target = enc ? `${f.path}.smbackup` : f.path;
    try {
      let meta: Record<string, string> = { sha256: hash };
      let objectName = f.name;
      if (enc) {
        const e = await encryptFile(f.path, target, enc.key, {
          kdf: enc.stored.kdf,
          now,
          info: { product: BRAND.name, version: config.version, content: 'export', file: f.name },
        });
        // only what anyone who can read the object sees anyway: no hash of the content (it would let them confirm a
        // guess of a small or templated file); that is in the encrypted manifest and the run history
        meta = { sha256: e.sha256, keyid: e.header.keyId };
        objectName = `${f.name}.smbackup`;
      }
      const key = `${folder}${objectName}`;
      checkStopping();
      // recorded before it is uploaded: a run that is cut off (the server stops) leaves no object Steward forgets
      run.files.push({
        part,
        name: objectName,
        key,
        bytes: fs.statSync(target).size,
        sha256: meta.sha256!,
        ...(enc ? { contentBytes: f.bytes, contentSha256: hash } : {}),
      });
      recordFiles(run);
      await c.putFile(key, target, meta, { contentType: enc ? 'application/octet-stream' : contentTypeOf(f.name) });
    } finally {
      fs.rmSync(f.path, { force: true });
      fs.rmSync(`${f.path}.smbackup`, { force: true });
    }
  };
  try {
    for (const choice of job.parts) {
      checkStopping();
      const def = exportPart(choice.id);
      if (!def) {
        skipped.push({ part: choice.id, reason: 'not known to this version' });
        continue;
      }
      if (def.module && !moduleEnabled(def.module)) {
        skipped.push({ part: choice.id, reason: `the module ${def.module} is switched off` });
        continue;
      }
      const files: WorkFile[] = [];
      const notes: Record<string, unknown> = {};
      const ctx: ExportContext = {
        now,
        file: (name) => {
          if (files.some((f) => f.name === name)) throw new Error(`The part ${choice.id} wrote ${name} twice`);
          const f = new WorkFile(dir, run.id, name);
          files.push(f);
          work.push(f);
          return f;
        },
        pause: () =>
          new Promise((resolve, reject) =>
            setImmediate(() => {
              try {
                checkStopping();
                resolve();
              } catch (e) {
                reject(e as Error);
              }
            }),
          ),
        note: (facts) => void Object.assign(notes, facts),
      };
      // as the export's system principal: every part sees everything (only administrators define exports)
      await runAs(EXPORT_USER, () => def.write(choice, ctx));
      for (const f of files) await upload(choice.id, f);
      const { id: _id, format, ...options } = choice;
      parts.push({ id: choice.id, format, options, files: files.map((f) => f.name), ...(Object.keys(notes).length ? { notes } : {}) });
    }
    const manifest = {
      format: 'steward-export',
      v: 1,
      product: BRAND.name,
      version: config.version,
      name: job.name,
      createdAt: now.toISOString(),
      encrypted: !!enc,
      ...(enc ? { keyId: enc.stored.keyId } : {}),
      parts,
      skipped,
      // size and SHA-256 of each object as stored; encrypted exports also of the content (this manifest is encrypted too)
      files: run.files.map((f) => ({
        name: f.name,
        part: f.part,
        bytes: f.bytes,
        sha256: f.sha256,
        ...(f.contentSha256 ? { contentBytes: f.contentBytes, contentSha256: f.contentSha256 } : {}),
      })),
    };
    const m = new WorkFile(dir, run.id, 'manifest.json');
    work.push(m);
    await m.write(JSON.stringify(manifest, null, 2) + '\n');
    await upload('manifest', m);
    run.bytes = run.files.reduce((n, f) => n + f.bytes, 0);
    const cut = parts.filter((p) => p.notes?.truncated).map((p) => p.id);
    const notes = [
      ...(skipped.length ? [`Not exported: ${skipped.map((s) => `${s.part} (${s.reason})`).join(', ')}`] : []),
      ...(cut.length ? [`Cut to the newest ${partLimits.auditEntries} entries: ${cut.join(', ')}`] : []),
    ];
    if (notes.length) run.message = notes.join('; ');
  } catch (e) {
    // a failed run leaves nothing behind: what it uploaded is removed again; what cannot be removed now stays recorded,
    // and the retention rule removes it later
    run.files = await removeFiles(c, run.files);
    throw e;
  } finally {
    for (const f of work) {
      await f.discard();
      fs.rmSync(f.path, { force: true });
      fs.rmSync(`${f.path}.smbackup`, { force: true });
    }
  }
}

async function finish(job: ExportJob, run: ExportRun, code?: string): Promise<void> {
  run.finishedAt = nowIso();
  db().run(
    'UPDATE export_runs SET status = ?, finished_at = ?, folder = ?, files = ?, bytes = ?, message = ? WHERE id = ?',
    run.status,
    run.finishedAt,
    run.folder,
    JSON.stringify(run.files),
    run.bytes,
    run.message,
    run.id,
  );
  audit({
    action: run.status === 'succeeded' ? 'export.completed' : 'export.failed',
    entityType: 'export',
    entityId: job.id,
    summary:
      run.status === 'succeeded'
        ? `Export "${job.name}" written to ${run.folder}: ${run.files.length} files, ${run.bytes} bytes${job.encrypt ? ', encrypted' : ''}${run.message ? ` – ${run.message}` : ''}`
        : `Export "${job.name}" failed: ${run.message}`,
    details: {
      runId: run.id,
      status: run.status,
      trigger: run.trigger,
      folder: run.folder,
      encrypted: job.encrypt,
      files: run.files.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256 })),
      ...(code ? { code } : {}),
    },
  });
  if (run.status === 'failed') notifyFailure(job, run);
  else await applyRetention(job).catch((err) => logger.warn({ err, export: job.name }, 'export retention failed'));
  // the history: the newest runs only – a run whose files are still in the bucket stays until they are gone
  db().run(
    `DELETE FROM export_runs WHERE job_id = ? AND (pruned = 1 OR files = '[]') AND id NOT IN (
       SELECT id FROM (SELECT id FROM export_runs WHERE job_id = ? ORDER BY started_at DESC, id DESC LIMIT ?) AS keep)`,
    job.id,
    job.id,
    EXPORT_LIMITS.historyRuns,
  );
}

/** Deletes the objects of a run; returns those that are still there (refused or not reachable). */
async function removeFiles(c: S3Client, files: ExportFileInfo[]): Promise<ExportFileInfo[]> {
  const left: ExportFileInfo[] = [];
  for (const f of files) {
    const d = await c.delete(f.key).catch(() => ({ deleted: false }));
    if (!d.deleted) left.push(f);
  }
  return left;
}

/**
 * Removes the files of older successful runs beyond keepRuns, and the files failed or interrupted runs left behind –
 * only files a run of this export recorded, from its own target (never by listing the bucket).
 */
export async function applyRetention(job: ExportJob): Promise<{ pruned: number; locked: number }> {
  const runs = db().all<RunRow>("SELECT * FROM export_runs WHERE job_id = ? AND status <> 'running' AND pruned = 0 ORDER BY started_at DESC, id DESC", job.id);
  const succeeded = runs.filter((r) => r.status === 'succeeded');
  const keep = new Set(succeeded.slice(0, job.keepRuns).map((r) => r.id));
  const old = runs.filter((r) => !keep.has(r.id) && (r.status === 'succeeded' || parseJson<ExportFileInfo[]>(r.files, []).length > 0));
  if (!old.length) return { pruned: 0, locked: 0 };
  let pruned = 0;
  let locked = 0;
  const done: string[] = [];
  for (const r of old) {
    const files = parseJson<ExportFileInfo[]>(r.files, []);
    // the run's own target: the export may point to another bucket now (never delete a key of the same name there)
    let c;
    try {
      c = s3Client(r.platform_id);
    } catch {
      continue;
    }
    const left = await removeFiles(c, files);
    locked += left.length;
    // a failed run keeps the files that are left recorded; a successful one keeps its list (its history shows it)
    if (r.status === 'failed') db().run('UPDATE export_runs SET files = ?, pruned = ? WHERE id = ?', JSON.stringify(left), left.length ? 0 : 1, r.id);
    else if (!left.length) db().run('UPDATE export_runs SET pruned = 1 WHERE id = ?', r.id);
    if (!left.length) (pruned++, done.push(r.id));
  }
  if (pruned)
    audit({
      action: 'export.pruned',
      entityType: 'export',
      entityId: job.id,
      summary: `Export "${job.name}": the files of ${pruned} run(s) removed by the retention rule (keeping ${job.keepRuns} successful runs)${locked ? `, ${locked} file(s) could not be removed` : ''}`,
      details: { runs: done, locked },
    });
  return { pruned, locked };
}

/**
 * After the vault is unlocked (bootstrap): removes what interrupted and failed runs left in the bucket, for every
 * export – their files are recorded as they are uploaded.
 */
export async function cleanUpExportRuns(): Promise<void> {
  const ids = db()
    .all<{ job_id: string }>("SELECT DISTINCT job_id FROM export_runs WHERE status = 'failed' AND pruned = 0 AND files <> '[]'")
    .map((r) => r.job_id);
  for (const id of ids) {
    const r = db().get<JobRow>('SELECT * FROM export_jobs WHERE id = ?', id);
    if (!r || running.has(id)) continue;
    await applyRetention(toJob(r)).catch((err) => logger.warn({ err, export: r.name }, 'could not remove the files of interrupted export runs'));
  }
}

function notifyFailure(job: ExportJob, run: ExportRun): void {
  void import('../notifications/service.js')
    .then(({ notify }) => {
      const recipients = listUsers().filter((u) => u.active && u.roles.includes('admin'));
      notify({
        event: 'export.failed',
        recipients,
        text: (locale) =>
          locale === 'de'
            ? {
                title: `${BRAND.name}: Export „${job.name}“ fehlgeschlagen`,
                body: `Der Export „${job.name}“ nach S3 ist fehlgeschlagen: ${run.message}. Bitte prüfen Sie ihn unter Einstellungen → Exporte.`,
              }
            : {
                title: `${BRAND.name}: export "${job.name}" failed`,
                body: `The export "${job.name}" to S3 failed: ${run.message}. Check it under Settings → Exports.`,
              },
        link: '/settings/exports',
        inAppKey: run.id,
        externalKey: `export:${run.id}`,
        data: { exportId: job.id, runId: run.id },
      });
    })
    .catch((err) => logger.warn({ err }, 'could not notify the administrators of a failed export'));
}

// ---------- schedule ----------

const crons: { jobId: string; cron: Cron }[] = [];
let started = false;

/** The scheduled exports (tests). */
export const scheduledExports = (): readonly { jobId: string; cron: Cron }[] => crons;

/** (Re)plans the scheduled exports; called at start and when a definition changes. */
export function scheduleExportJobs(): void {
  for (const j of crons.splice(0)) j.cron.stop();
  if (!started) return;
  for (const r of db().all<JobRow>('SELECT * FROM export_jobs WHERE enabled = 1')) {
    try {
      crons.push({
        jobId: r.id,
        cron: new Cron(r.cron, { timezone: r.timezone, protect: true }, () => {
          try {
            startExportRun(r.id, 'schedule');
          } catch (err) {
            if ((err as HttpError).statusCode === 409) return logger.warn({ export: r.name }, 'export skipped: the last run is still going');
            // nothing to run with (storage removed, no key): a failed run, so it is not silent
            const at = nowIso();
            const id = newId('xrun');
            db().run(
              "INSERT INTO export_runs (id, job_id, status, trigger_kind, started_at, finished_at, message) VALUES (?, ?, 'failed', 'schedule', ?, ?, ?)",
              id,
              r.id,
              at,
              at,
              (err as Error).message,
            );
            notifyFailure(toJob(r), toRun(db().get<RunRow>('SELECT * FROM export_runs WHERE id = ?', id)!));
          }
        }),
      });
    } catch (err) {
      logger.warn({ err, export: r.name }, 'could not schedule an export');
    }
  }
}

export function startExportJobs(): void {
  started = true;
  stopping = false;
  // runs the last process did not finish: failed, with the files they uploaded recorded (cleanUpExportRuns removes them)
  const at = nowIso();
  for (const r of db().all<RunRow>("SELECT * FROM export_runs WHERE status = 'running'")) {
    if (running.has(r.job_id)) continue;
    db().run("UPDATE export_runs SET status = 'failed', finished_at = ?, message = ? WHERE id = ?", at, INTERRUPTED, r.id);
    const j = db().get<JobRow>('SELECT * FROM export_jobs WHERE id = ?', r.job_id);
    if (!j) continue;
    const run = toRun({ ...r, status: 'failed', finished_at: at, message: INTERRUPTED });
    audit({
      actor: 'system',
      action: 'export.failed',
      entityType: 'export',
      entityId: j.id,
      summary: `Export "${j.name}" failed: ${INTERRUPTED}${run.files.length ? ` – its ${run.files.length} uploaded file(s) are removed once the vault is unlocked` : ''}`,
      details: {
        runId: r.id,
        status: 'failed',
        trigger: r.trigger_kind,
        folder: r.folder,
        files: run.files.map((f) => ({ name: f.name, key: f.key })),
        code: 'EXPORT_INTERRUPTED',
      },
    });
    notifyFailure(toJob(j), run);
  }
  try {
    const dir = path.join(config.dataDir, WORK);
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true, recursive: true });
  } catch (err) {
    logger.warn({ err }, 'could not clean the export work folder');
  }
  scheduleExportJobs();
}

export function stopExportJobs(): void {
  started = false;
  // a running export stops at its next file (shutdown waits for it: exportsIdle)
  stopping = true;
  for (const j of crons.splice(0)) j.cron.stop();
}
