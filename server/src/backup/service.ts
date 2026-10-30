import fs from 'node:fs';
import path from 'node:path';
import { Cron } from 'croner';
import { z } from 'zod';
import {
  BRAND,
  DEFAULT_BACKUP_SETTINGS,
  type BackupRun,
  type BackupRunKind,
  type BackupSettings,
  type BackupStatus,
  type BackupStep,
  type StoredBackup,
} from '@sm/shared';
import { config } from '../config.js';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { vault } from '../vault.js';
import { logger } from '../log.js';
import { readSetting, writeSetting } from '../settings.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { currentActor } from '../auth/context.js';
import { listUsers } from '../auth/users.js';
import { getPlatform, getSecrets } from '../platforms/service.js';
import { createArchive, checkArchive, workDir } from './archive.js';
import { BACKUP_PASSPHRASE_MIN, decryptFile, deriveBackupKey, encryptFile, keyIdOf, newKdf, readHeader, type KdfParams } from './crypto.js';
import { retained } from './retention.js';
import { S3Client, type S3Object } from './s3.js';

/**
 * Backups to S3 (#117). On a schedule (or by hand) Steward makes a consistent copy of its database and data folder
 * (archive.ts), encrypts it with the backup key (crypto.ts) and uploads it to an S3 bucket (s3.ts). The retention rule
 * (retention.ts) removes older copies; once a week the newest copy is downloaded, decrypted and checked completely.
 * Failures notify the administrators (event backup.failed).
 *
 * The backup key comes from a backup passphrase an administrator sets once and keeps offline (it is the only way to
 * read a backup without this installation). Steward stores the derived key encrypted in the vault, never the passphrase.
 */

const SETTINGS_KEY = 'backup.settings';
const KEY_KEY = 'backup.key';
const OBJECT_RE = /(?:^|\/)steward-(\d{8}T\d{6}Z)(?:-\d+)?\.smbackup$/;

interface StoredKey {
  blob: string;
  keyId: string;
  kdf: KdfParams;
  setAt: string;
  setBy: string;
}

const retentionSchema = z.object({
  daily: z.number().int().min(1).max(366),
  weekly: z.number().int().min(0).max(260),
  monthly: z.number().int().min(0).max(120),
});

export const backupSettingsSchema = z.object({
  enabled: z.boolean(),
  platformId: z.string().trim().min(1).max(100).nullable(),
  prefix: z
    .string()
    .trim()
    .max(200)
    .regex(/^([A-Za-z0-9._-]+\/)*$/, 'Use folder names of letters, digits and . _ - , each ending with /'),
  cron: z.string().trim().min(1).max(100),
  timezone: z.string().trim().min(1).max(64),
  retention: retentionSchema,
  restoreTest: z.object({ enabled: z.boolean(), cron: z.string().trim().min(1).max(100) }),
});

export function backupSettings(): BackupSettings {
  const s = readSetting<Partial<BackupSettings>>(SETTINGS_KEY, {});
  return {
    ...DEFAULT_BACKUP_SETTINGS,
    ...s,
    retention: { ...DEFAULT_BACKUP_SETTINGS.retention, ...s.retention },
    restoreTest: { ...DEFAULT_BACKUP_SETTINGS.restoreTest, ...s.restoreTest },
  };
}

function checkCron(cron: string, tz: string, what: string): Cron {
  let job: Cron;
  try {
    job = new Cron(cron, { paused: true, timezone: tz });
  } catch (e) {
    throw new HttpError(400, `Invalid cron expression for the ${what}: ${(e as Error).message}`, 'CRON_INVALID', { detail: (e as Error).message });
  }
  if (cron.trim().split(/\s+/).length !== 5) {
    job.stop();
    throw new HttpError(400, 'Use a cron expression with five fields (minute hour day month weekday)', 'CRON_FIVE_FIELDS', { context: 'backup' });
  }
  return job;
}

/** The platform must sign with AWS SigV4 for S3 – a backup is never sent with other credentials. */
function storagePlatform(id: string | null) {
  if (!id) throw new HttpError(400, 'Choose the S3 platform the backups go to', 'BACKUP_NO_STORAGE');
  const p = getPlatform(id);
  const aws = p.config.auth?.type === 'aws_sigv4' ? p.config.auth.aws : undefined;
  if (!aws || aws.service !== 's3')
    throw new HttpError(400, `"${p.name}" is not S3 storage: its sign-in must be AWS request signing (SigV4) with the service s3`, 'BACKUP_NOT_S3', {
      name: p.name,
    });
  if (!/^https:/i.test(p.baseUrl ?? '') && !(config.demo && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(p.baseUrl ?? '')))
    throw new HttpError(400, 'Backups only go to S3 over https', 'BACKUP_HTTPS_ONLY');
  return p;
}

export function saveBackupSettings(input: unknown): BackupSettings {
  const v = backupSettingsSchema.parse(input) as BackupSettings;
  checkCron(v.cron, v.timezone, 'backup').stop();
  checkCron(v.restoreTest.cron, v.timezone, 'restore test').stop();
  if (v.platformId) storagePlatform(v.platformId);
  if (v.enabled && !v.platformId) throw new HttpError(400, 'Choose the S3 platform the backups go to', 'BACKUP_NO_STORAGE');
  if (v.enabled && !storedKey()) throw new HttpError(400, 'Set the backup passphrase first', 'BACKUP_NO_KEY');
  writeSetting(SETTINGS_KEY, v);
  audit({
    action: 'backup.settings_updated',
    entityType: 'backup',
    summary: v.enabled
      ? `Backups to ${getPlatform(v.platformId!).name}/${v.prefix} (${v.cron} ${v.timezone}), keeping ${v.retention.daily} daily, ${v.retention.weekly} weekly and ${v.retention.monthly} monthly`
      : 'Scheduled backups off',
    details: v,
  });
  scheduleJobs();
  return v;
}

// ---------- the backup key ----------

const storedKey = (): StoredKey | null => readSetting<StoredKey | null>(KEY_KEY, null);

function backupKey(): { key: Buffer; stored: StoredKey } {
  const stored = storedKey();
  if (!stored) throw new HttpError(400, 'Set the backup passphrase first', 'BACKUP_NO_KEY');
  return { key: Buffer.from(vault().decrypt<string>(stored.blob), 'base64'), stored };
}

/**
 * Sets the backup passphrase: the key is derived (scrypt, new salt), kept encrypted in the vault; the passphrase is
 * forgotten. Backups made before stay readable with the passphrase they were made with.
 */
export async function setBackupPassphrase(passphrase: string): Promise<{ keyId: string }> {
  if (typeof passphrase !== 'string' || passphrase.length < BACKUP_PASSPHRASE_MIN || passphrase.length > 1024)
    throw new HttpError(400, `The backup passphrase needs at least ${BACKUP_PASSPHRASE_MIN} characters`, 'BACKUP_PASSPHRASE_SHORT', {
      min: BACKUP_PASSPHRASE_MIN,
    });
  const kdf = newKdf();
  const key = await deriveBackupKey(passphrase, kdf);
  const keyId = keyIdOf(key);
  const previous = storedKey();
  writeSetting(KEY_KEY, { blob: vault().encrypt(key.toString('base64')), keyId, kdf, setAt: nowIso(), setBy: currentActor() } satisfies StoredKey);
  audit({
    action: 'backup.key_set',
    entityType: 'backup',
    summary: previous ? `Backup passphrase changed (key ${previous.keyId} → ${keyId})` : `Backup passphrase set (key ${keyId})`,
    details: { keyId, previousKeyId: previous?.keyId ?? null },
  });
  return { keyId };
}

// ---------- runs ----------

interface RunRow {
  id: string;
  kind: BackupRunKind;
  status: BackupRun['status'];
  trigger_kind: BackupRun['trigger'];
  triggered_by: string | null;
  started_at: string;
  finished_at: string | null;
  object_key: string | null;
  bytes: number | null;
  sha256: string | null;
  message: string | null;
  steps: string;
  deleted: number;
}

const toRun = (r: RunRow): BackupRun => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  trigger: r.trigger_kind,
  triggeredBy: r.triggered_by,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  objectKey: r.object_key,
  bytes: r.bytes === null ? null : Number(r.bytes),
  sha256: r.sha256,
  message: r.message,
  steps: parseJson<BackupStep[]>(r.steps, []),
  deleted: Number(r.deleted ?? 0),
});

export function listBackupRuns(limit = 30): BackupRun[] {
  return db()
    .all<RunRow>('SELECT * FROM backup_runs ORDER BY started_at DESC, id DESC LIMIT ?', Math.min(200, Math.max(1, limit)))
    .map(toRun);
}

function lastRun(where: string): BackupRun | null {
  const r = db().get<RunRow>(`SELECT * FROM backup_runs WHERE ${where} ORDER BY started_at DESC, id DESC LIMIT 1`);
  return r ? toRun(r) : null;
}

let running: BackupRunKind | null = null;

/** Starts a backup or restore test in the background; the run is returned right away (status running). */
export function startBackupRun(kind: BackupRunKind, trigger: BackupRun['trigger']): BackupRun {
  if (running) throw new HttpError(409, running === 'backup' ? 'A backup is running' : 'A restore test is running', 'BACKUP_BUSY');
  const s = backupSettings();
  storagePlatform(s.platformId);
  backupKey();
  const run: BackupRun = {
    id: newId('bkp'),
    kind,
    status: 'running',
    trigger,
    triggeredBy: trigger === 'manual' ? currentActor() : null,
    startedAt: nowIso(),
    finishedAt: null,
    objectKey: null,
    bytes: null,
    sha256: null,
    message: null,
    steps: [],
    deleted: 0,
  };
  db().run(
    'INSERT INTO backup_runs (id, kind, status, trigger_kind, triggered_by, started_at, steps) VALUES (?, ?, ?, ?, ?, ?, ?)',
    run.id,
    kind,
    'running',
    trigger,
    run.triggeredBy,
    run.startedAt,
    '[]',
  );
  running = kind;
  current = (kind === 'backup' ? backup(run) : restoreTest(run))
    .catch((e: Error) => {
      logger.error({ err: e, kind }, 'backup run failed');
      run.status = 'failed';
      run.message = e.message;
    })
    .then(() => finish(run))
    .finally(() => {
      running = null;
      current = null;
    });
  return run;
}

let current: Promise<void> | null = null;
/** Waits for the running backup or restore test (tests, shutdown). */
export const backupIdle = (): Promise<void> => current ?? Promise.resolve();

function finish(run: BackupRun): void {
  if (run.status === 'running') run.status = run.steps.every((s) => s.ok) ? 'succeeded' : 'failed';
  if (run.status === 'failed' && !run.message) run.message = run.steps.find((s) => !s.ok)?.message ?? 'failed';
  run.finishedAt = nowIso();
  db().run(
    'UPDATE backup_runs SET status = ?, finished_at = ?, object_key = ?, bytes = ?, sha256 = ?, message = ?, steps = ?, deleted = ? WHERE id = ?',
    run.status,
    run.finishedAt,
    run.objectKey,
    run.bytes,
    run.sha256,
    run.message,
    JSON.stringify(run.steps),
    run.deleted,
    run.id,
  );
  const what = run.kind === 'backup' ? 'Backup' : 'Restore test';
  audit({
    action: run.kind === 'backup' ? (run.status === 'succeeded' ? 'backup.created' : 'backup.failed') : 'backup.restore_tested',
    entityType: 'backup',
    entityId: run.id,
    summary:
      run.status === 'succeeded'
        ? run.kind === 'backup'
          ? `Backup ${run.objectKey} uploaded (${run.bytes} bytes, SHA-256 ${run.sha256?.slice(0, 12)}…)${run.deleted ? `, ${run.deleted} older backup(s) removed` : ''}`
          : `Restore test of ${run.objectKey} passed`
        : `${what} failed: ${run.message}`,
    details: { kind: run.kind, status: run.status, objectKey: run.objectKey, sha256: run.sha256, steps: run.steps },
  });
  if (run.status === 'failed') notifyFailure(run);
  cleanWorkDir();
}

function notifyFailure(run: BackupRun): void {
  void import('../notifications/service.js')
    .then(({ notify }) => {
      const recipients = listUsers().filter((u) => u.active && u.roles.includes('admin'));
      notify({
        event: 'backup.failed',
        recipients,
        text: (locale) =>
          locale === 'de'
            ? {
                title: `${BRAND.name}: ${run.kind === 'backup' ? 'Sicherung fehlgeschlagen' : 'Wiederherstellungstest fehlgeschlagen'}`,
                body: `${run.kind === 'backup' ? 'Die Sicherung' : 'Der Wiederherstellungstest der Sicherungen'} ist fehlgeschlagen: ${run.message}. Bitte prüfen Sie die Sicherungen unter Administration → Sicherungen.`,
              }
            : {
                title: `${BRAND.name}: ${run.kind === 'backup' ? 'backup failed' : 'restore test failed'}`,
                body: `The ${run.kind === 'backup' ? 'backup' : 'restore test of the backups'} failed: ${run.message}. Check the backups under Administration → Backups.`,
              },
        link: '/admin/backups',
        inAppKey: run.id,
        externalKey: `backup:${run.kind}:${run.id}`,
        data: { kind: run.kind, runId: run.id },
      });
    })
    .catch((err) => logger.warn({ err }, 'could not notify the administrators of a failed backup'));
}

/** Leftovers of interrupted runs (a crash, a restart) in the work folder. */
function cleanWorkDir(): void {
  try {
    const dir = workDir();
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true, recursive: true });
  } catch (err) {
    logger.warn({ err }, 'could not clean the backup work folder');
  }
}

const stampOf = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/** When a backup object was made, from its name (steward-20261030T021500Z.smbackup). */
export function backupTime(key: string): Date | null {
  const m = OBJECT_RE.exec(key);
  if (!m) return null;
  const s = m[1]!;
  const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function client(s: BackupSettings): S3Client {
  const p = storagePlatform(s.platformId);
  return new S3Client(p, getSecrets(p.id));
}

async function backup(run: BackupRun): Promise<void> {
  const s = backupSettings();
  const { key, stored } = backupKey();
  const dir = workDir();
  const now = new Date();
  const base = `${s.prefix}steward-${stampOf(now)}`;
  const zip = path.join(dir, `${run.id}.zip`);
  const enc = path.join(dir, `${run.id}.smbackup`);
  const step = (name: string, ok: boolean, message: string) => run.steps.push({ name, ok, message });
  try {
    const manifest = await createArchive(zip, { now });
    const zipSize = fs.statSync(zip).size;
    step(
      'archive',
      true,
      `${manifest.database.kind === 'sqlite' ? 'SQLite snapshot' : 'pg_dump'} and ${manifest.files.length - 1} files of the data folder (${zipSize} bytes)`,
    );
    const e = await encryptFile(zip, enc, key, {
      kdf: stored.kdf,
      now,
      info: { product: BRAND.name, version: config.version, database: manifest.database.kind },
    });
    fs.rmSync(zip, { force: true });
    step('encrypt', true, `AES-256-GCM with key ${e.header.keyId}`);
    run.bytes = e.bytes;
    run.sha256 = e.sha256;
    const c = client(s);
    // a second backup within the same second gets a suffix (never overwrite a backup)
    const existing = new Set((await c.list(base)).map((o) => o.key));
    let objectKey = `${base}.smbackup`;
    for (let n = 2; existing.has(objectKey); n++) objectKey = `${base}-${n}.smbackup`;
    const up = await c.putFile(objectKey, enc, { sha256: e.sha256, keyid: e.header.keyId });
    run.objectKey = objectKey;
    step('upload', true, `${objectKey} (${e.bytes} bytes${up.parts > 1 ? `, ${up.parts} parts` : ''})`);
  } finally {
    fs.rmSync(zip, { force: true });
    fs.rmSync(enc, { force: true });
  }
  // retention: only after a successful upload, only objects Steward named
  try {
    const r = await applyRetention(s);
    run.deleted = r.deleted.length;
    step(
      'retention',
      true,
      `${r.kept} kept${r.deleted.length ? `, ${r.deleted.length} removed` : ''}${r.locked.length ? `, ${r.locked.length} kept by S3 Object Lock` : ''}`,
    );
  } catch (e) {
    step('retention', false, `Older backups could not be removed: ${(e as Error).message}`);
  }
}

async function storedBackups(s: BackupSettings, c = client(s)): Promise<(S3Object & { at: Date })[]> {
  return (await c.list(s.prefix))
    .filter((o) => !o.key.slice(s.prefix.length).includes('/'))
    .map((o) => ({ ...o, at: backupTime(o.key) }))
    .filter((o): o is S3Object & { at: Date } => !!o.at);
}

async function applyRetention(s: BackupSettings): Promise<{ kept: number; deleted: string[]; locked: string[] }> {
  const c = client(s);
  const all = await storedBackups(s, c);
  const keep = retained(all, (o) => o.at, s.retention);
  const deleted: string[] = [];
  const locked: string[] = [];
  for (const o of all) {
    if (keep.has(o)) continue;
    const r = await c.delete(o.key);
    (r.deleted ? deleted : locked).push(o.key);
  }
  return { kept: keep.size, deleted, locked };
}

/** The backups in the bucket, newest first, with what the retention rule keeps. */
export async function listStoredBackups(): Promise<StoredBackup[]> {
  const s = backupSettings();
  const all = await storedBackups(s);
  const keep = retained(all, (o) => o.at, s.retention);
  return all
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .map((o) => ({ key: o.key, size: o.size, createdAt: o.at.toISOString(), keptAs: keep.get(o) ?? [] }));
}

async function restoreTest(run: BackupRun): Promise<void> {
  const s = backupSettings();
  const step = (name: string, ok: boolean, message: string) => (run.steps.push({ name, ok, message }), ok);
  const c = client(s);
  const newest = (await storedBackups(s, c)).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  if (!newest) {
    step('download', false, `There is no backup in ${s.prefix || 'the bucket'} yet`);
    return;
  }
  run.objectKey = newest.key;
  const dir = workDir();
  const enc = path.join(dir, `${run.id}.smbackup`);
  const zip = path.join(dir, `${run.id}.zip`);
  try {
    const got = await c.getFile(newest.key, enc);
    run.bytes = got.bytes;
    run.sha256 = got.sha256;
    // the checksum recorded when it was uploaded: the run that made it, else the object's metadata
    const made = db().get<{ sha256: string | null }>(
      "SELECT sha256 FROM backup_runs WHERE kind = 'backup' AND object_key = ? AND status = 'succeeded'",
      newest.key,
    );
    const expected = made?.sha256 ?? got.meta.sha256;
    if (
      !step(
        'download',
        !expected || expected === got.sha256,
        expected === got.sha256
          ? `${newest.key} (${got.bytes} bytes), SHA-256 as uploaded`
          : expected
            ? `${newest.key}: SHA-256 differs from the upload – the copy in the bucket was changed`
            : `${newest.key} (${got.bytes} bytes), no recorded SHA-256 to compare`,
      )
    )
      return;
    const { header } = await readHeader(enc);
    let key: Buffer;
    try {
      ({ key } = backupKey());
    } catch (e) {
      step('decrypt', false, (e as Error).message);
      return;
    }
    if (keyIdOf(key) !== header.keyId) {
      step(
        'decrypt',
        false,
        `The newest backup was made with key ${header.keyId}, the current key is ${keyIdOf(key)} – it can only be read with its passphrase`,
      );
      return;
    }
    try {
      await decryptFile(enc, zip, key);
    } catch (e) {
      step('decrypt', false, (e as Error).message);
      return;
    }
    fs.rmSync(enc, { force: true });
    step('decrypt', true, `Decrypted and authenticated (key ${header.keyId})`);
    const check = await checkArchive(zip, { deep: true });
    run.steps.push(...check.steps);
  } finally {
    fs.rmSync(enc, { force: true });
    fs.rmSync(zip, { force: true });
  }
}

// ---------- status & jobs ----------

const jobs: Cron[] = [];
let jobsStarted = false;

export function backupStatus(): BackupStatus {
  const s = backupSettings();
  const k = storedKey();
  const next = (cron: string, on: boolean) => {
    if (!on) return null;
    try {
      const j = new Cron(cron, { paused: true, timezone: s.timezone });
      const n = j.nextRun();
      j.stop();
      return n ? n.toISOString() : null;
    } catch {
      return null;
    }
  };
  return {
    settings: s,
    key: k ? { keyId: k.keyId, setAt: k.setAt, setBy: k.setBy } : null,
    running,
    lastBackup: lastRun("kind = 'backup'"),
    lastSuccess: lastRun("kind = 'backup' AND status = 'succeeded'"),
    lastRestoreTest: lastRun("kind = 'restore_test'"),
    nextBackupAt: next(s.cron, s.enabled),
    nextRestoreTestAt: next(s.restoreTest.cron, s.enabled && s.restoreTest.enabled),
    runs: listBackupRuns(30),
    database: config.database.kind,
  };
}

/** (Re)plans the scheduled backup and restore test; called at start and when the settings change. */
export function scheduleJobs(): void {
  stopBackupJobs();
  if (!jobsStarted) return;
  const s = backupSettings();
  if (!s.enabled) return;
  const fire = (kind: BackupRunKind) => () => {
    try {
      startBackupRun(kind, 'schedule');
    } catch (err) {
      // nothing to run with (no key, storage removed) or still busy: recorded as a failed run, so it is not silent
      const message = (err as Error).message;
      const id = newId('bkp');
      const at = nowIso();
      if ((err as HttpError).statusCode === 409) return logger.warn({ kind }, 'backup skipped: another backup run is still going');
      db().run(
        "INSERT INTO backup_runs (id, kind, status, trigger_kind, started_at, finished_at, message, steps) VALUES (?, ?, 'failed', 'schedule', ?, ?, ?, '[]')",
        id,
        kind,
        at,
        at,
        message,
      );
      notifyFailure({ ...toRun(db().get<RunRow>('SELECT * FROM backup_runs WHERE id = ?', id)!) });
    }
  };
  jobs.push(new Cron(s.cron, { timezone: s.timezone, protect: true }, fire('backup')));
  if (s.restoreTest.enabled) jobs.push(new Cron(s.restoreTest.cron, { timezone: s.timezone, protect: true }, fire('restore_test')));
}

export function startBackupJobs(): void {
  jobsStarted = true;
  // a run cut off by a restart stays "running" forever otherwise
  db().run("UPDATE backup_runs SET status = 'failed', finished_at = ?, message = 'Interrupted (the server stopped)' WHERE status = 'running'", nowIso());
  cleanWorkDir();
  scheduleJobs();
}
export function stopBackupJobs(): void {
  for (const j of jobs.splice(0)) j.stop();
}
