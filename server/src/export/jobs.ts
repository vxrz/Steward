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
import { getPlatform } from '../platforms/service.js';
import { backupKey, backupKeySet, backupSettings, s3Client, storagePlatform } from '../backup/service.js';
import { encryptFile } from '../backup/crypto.js';
import { exportPart, exportPartInfos, EXPORT_PARTS } from './parts.js';

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
      `INSERT INTO export_jobs (id, name, enabled, platform_id, prefix, cron, timezone, parts, encrypt, keep_runs, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
       updated_at = ?, updated_by = ? WHERE id = ?`,
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
      id,
    );
    const { id: _i, createdAt: _c, createdBy: _b, updatedAt: _u, updatedBy: _ub, nextRunAt: _n, running: _r, lastRun: _l, ...was } = before;
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
  const p = runExport(job, run)
    .then(
      () => {
        run.status = 'succeeded';
      },
      (e: Error) => {
        logger.warn({ err: e, export: job.name }, 'export failed');
        run.status = 'failed';
        run.message = e.message;
      },
    )
    .then(() => finish(job, run))
    .catch((err) => logger.error({ err }, 'could not record an export run'))
    .finally(() => running.delete(jobId));
  running.set(jobId, p);
  return run;
}

/** Waits for the running exports (tests, shutdown). */
export const exportsIdle = async (): Promise<void> => {
  while (running.size) await Promise.all([...running.values()]);
};

async function runExport(job: ExportJob, run: ExportRun): Promise<void> {
  const now = new Date(run.startedAt);
  const c = s3Client(job.platformId);
  const enc = job.encrypt ? backupKey() : null;
  const base = `${job.prefix}${job.name}/${stampOf(now)}`;
  // a second run within the same second gets a suffix (never overwrite an export)
  const existing = new Set((await c.list(`${base}`)).map((o) => o.key.slice(base.length).split('/')[0]));
  let folder = `${base}/`;
  for (let n = 2; existing.has(folder.slice(base.length, -1)); n++) folder = `${base}-${n}/`;
  run.folder = folder;
  const dir = workDir();
  const { moduleEnabled } = await import('../modules/registry.js');
  const skipped: { part: string; reason: string }[] = [];
  const parts: { id: string; format: string; options: Record<string, unknown>; files: string[] }[] = [];
  const upload = async (part: ExportFileInfo['part'], name: string, content: string): Promise<void> => {
    const plain = path.join(dir, `${run.id}-${newId()}`);
    fs.writeFileSync(plain, content, { mode: 0o600, flag: 'wx' });
    const target = enc ? `${plain}.smbackup` : plain;
    try {
      const hash = sha256(Buffer.from(content, 'utf8'));
      let meta: Record<string, string> = { sha256: hash };
      let objectName = name;
      if (enc) {
        const e = await encryptFile(plain, target, enc.key, {
          kdf: enc.stored.kdf,
          now,
          info: { product: BRAND.name, version: config.version, content: 'export', file: name },
        });
        meta = { sha256: e.sha256, keyid: e.header.keyId, 'content-sha256': hash };
        objectName = `${name}.smbackup`;
      }
      const key = `${folder}${objectName}`;
      await c.putFile(key, target, meta);
      run.files.push({ part, name: objectName, key, bytes: fs.statSync(target).size, sha256: hash });
    } finally {
      fs.rmSync(plain, { force: true });
      fs.rmSync(`${plain}.smbackup`, { force: true });
    }
  };
  try {
    for (const choice of job.parts) {
      const def = exportPart(choice.id);
      if (!def) {
        skipped.push({ part: choice.id, reason: 'not known to this version' });
        continue;
      }
      if (def.module && !moduleEnabled(def.module)) {
        skipped.push({ part: choice.id, reason: `the module ${def.module} is switched off` });
        continue;
      }
      // as the export's system principal: every part sees everything (only administrators define exports)
      const files = await runAs(EXPORT_USER, () => def.write(choice, { now }));
      const names: string[] = [];
      for (const f of files) {
        await upload(choice.id, f.name, f.content);
        names.push(f.name);
      }
      const { id: _id, format, ...options } = choice;
      parts.push({ id: choice.id, format, options, files: names });
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
      // SHA-256 of each file's content (encrypted exports: before encryption)
      files: run.files.map((f) => ({ name: f.name, part: f.part, bytes: f.bytes, sha256: f.sha256 })),
    };
    await upload('manifest', 'manifest.json', JSON.stringify(manifest, null, 2) + '\n');
    run.bytes = run.files.reduce((n, f) => n + f.bytes, 0);
    if (skipped.length) run.message = `Not exported: ${skipped.map((s) => `${s.part} (${s.reason})`).join(', ')}`;
  } catch (e) {
    // a failed run leaves nothing behind: what it uploaded is removed again (best effort)
    for (const f of run.files.splice(0)) await c.delete(f.key).catch(() => undefined);
    throw e;
  }
}

async function finish(job: ExportJob, run: ExportRun): Promise<void> {
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
    },
  });
  if (run.status === 'failed') notifyFailure(job, run);
  else await applyRetention(job).catch((err) => logger.warn({ err, export: job.name }, 'export retention failed'));
  // the history: the newest runs only
  db().run(
    `DELETE FROM export_runs WHERE job_id = ? AND id NOT IN (
       SELECT id FROM (SELECT id FROM export_runs WHERE job_id = ? ORDER BY started_at DESC, id DESC LIMIT ?) AS keep)`,
    job.id,
    job.id,
    EXPORT_LIMITS.historyRuns,
  );
}

/** Removes the files of older successful runs beyond keepRuns – only files a run of this export recorded. */
export async function applyRetention(job: ExportJob): Promise<{ pruned: number; locked: number }> {
  const old = db()
    .all<RunRow>("SELECT * FROM export_runs WHERE job_id = ? AND status = 'succeeded' ORDER BY started_at DESC, id DESC", job.id)
    .slice(job.keepRuns)
    .filter((r) => !Number(r.pruned));
  if (!old.length) return { pruned: 0, locked: 0 };
  let pruned = 0;
  let locked = 0;
  for (const r of old) {
    const files = parseJson<ExportFileInfo[]>(r.files, []);
    let allGone = true;
    // the run's own target: the export may point to another bucket now (never delete a key of the same name there)
    let c;
    try {
      c = s3Client(r.platform_id);
    } catch {
      continue;
    }
    for (const f of files) {
      const d = await c.delete(f.key);
      if (!d.deleted) ((allGone = false), locked++);
    }
    if (allGone) {
      db().run('UPDATE export_runs SET pruned = 1 WHERE id = ?', r.id);
      pruned++;
    }
  }
  if (pruned)
    audit({
      action: 'export.pruned',
      entityType: 'export',
      entityId: job.id,
      summary: `Export "${job.name}": the files of ${pruned} older run(s) removed by the retention rule (keeping ${job.keepRuns})${locked ? `, ${locked} file(s) kept by S3 Object Lock` : ''}`,
      details: { runs: old.map((r) => r.id), locked },
    });
  return { pruned, locked };
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
  db().run("UPDATE export_runs SET status = 'failed', finished_at = ?, message = 'Interrupted (the server stopped)' WHERE status = 'running'", nowIso());
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
  for (const j of crons.splice(0)) j.cron.stop();
}
