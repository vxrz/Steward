import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { Db, db } from '../db.js';
import { flushPendingAudit, verifyAuditAsync } from '../audit.js';
import { ZipReader, ZipWriter, type WrittenEntry } from '../compliance/zip.js';
import { openSqliteFile } from '../database/sqlite-file.js';
import { explainPgToolError, pgConnection, pgDumpArgs } from '../database/pg-dump.js';
import { parseDatabaseTarget, quoteIdent } from '../database/sql.js';
import { snapshotSqlite } from '../database/sqlite-snapshot.js';
import { env } from '../config.js';
import type { BackupExcludedPart, BackupOptionalPart } from '@sm/shared';
import { excludedText, PART_FOLDER } from './contents.js';

/**
 * The backup archive (#117), before encryption: a ZIP with
 *   manifest.json            what is in it, with the SHA-256 of every file, and the head of the audit log
 *   database/steward.db      SQLite: a consistent snapshot (VACUUM INTO, online, in a worker thread)
 *   database/steward.pgdump  PostgreSQL: pg_dump of the schema in the custom format (pg_restore)
 *   data/…                   the data folder: vault.json, artifacts, documents, reports, audit anchors, …
 * Not included: the live database files (the snapshot stands for them), the automatic pre-upgrade copies (backups/)
 * and the work folder of backups. The master passphrase is never in a backup: keep it apart, like the backup passphrase.
 * From 0.16.0 an administrator may leave out run artifacts, archived reports and evidence packs (contents.ts): the
 * manifest's "excluded" names what was left out, so a restore test and `steward backup verify` can say what is missing.
 */

export const MANIFEST = 'manifest.json';
export const WORK_DIR = '.backup-work';

export interface BackupManifest {
  format: 'steward-backup';
  v: 1;
  createdAt: string;
  version: string;
  database: { kind: 'sqlite' | 'postgres'; file: string; schema?: string };
  files: { path: string; size: number; sha256: string }[];
  /** The last audit log entry in the snapshot */
  audit: { seq: number; hash: string } | null;
  /** Parts of the data folder the backup settings left out (0.16.0; missing or empty: nothing) */
  excluded?: BackupExcludedPart[];
}

/** A work folder in the data folder (0700) – never /tmp: the snapshot holds the same encrypted secrets as the database. */
export function workDir(): string {
  const dir = path.join(config.dataDir, WORK_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  return dir;
}

const pgDumpBin = () => env.SM_PG_DUMP;
const pgRestoreBin = () => env.SM_PG_RESTORE;

/** Runs a program without a shell; the error carries the end of its stderr. */
function run(bin: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (b: Buffer) => (out = (out + b.toString('utf8')).slice(-1024 * 1024)));
    child.stderr.on('data', (b: Buffer) => (err = (err + b.toString('utf8')).slice(-4000)));
    child.on('error', (e: NodeJS.ErrnoException) => reject(new Error(explainPgToolError(bin, '', null, e))));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(explainPgToolError(bin, err, code)))));
  });
}

/** Runs a tool and hands back its exit code and the end of its error output (a failure to start still rejects). */
function runCapture(bin: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (b: Buffer) => (err = (err + b.toString('utf8')).slice(-16_000)));
    child.on('error', (e: NodeJS.ErrnoException) => reject(new Error(explainPgToolError(bin, '', null, e))));
    child.on('close', (code) => resolve({ code, err }));
  });
}

/**
 * pg_restore 17 and newer start every connection with `SET transaction_timeout = 0`, which PostgreSQL 16 and older do
 * not know: restoring into such a server reports exactly that error and nothing else goes wrong. True when every error
 * pg_restore reported is this one (and it counted no others).
 */
export function onlyTransactionTimeoutErrors(stderr: string): boolean {
  const errors = stderr.split('pg_restore: error:').slice(1);
  if (!errors.length) return false;
  const known = (e: string) => e.includes('unrecognized configuration parameter "transaction_timeout"') && e.includes('SET transaction_timeout');
  if (!errors.every(known)) return false;
  const ignored = /errors ignored on restore: (\d+)/.exec(stderr);
  return !ignored || Number(ignored[1]) === errors.length;
}

type AuditHead = { seq: number; hash: string } | null;
const HEAD_SQL = 'SELECT seq, hash FROM audit_log WHERE seq >= 1 ORDER BY seq DESC LIMIT 1';
const headOf = (r: { seq: number; hash: string } | undefined): AuditHead => (r ? { seq: Number(r.seq), hash: String(r.hash) } : null);

async function snapshotDatabase(dir: string): Promise<{ file: string; entry: string; kind: 'sqlite' | 'postgres'; schema?: string; audit: AuditHead }> {
  const target = config.database;
  flushPendingAudit();
  if (target.kind === 'sqlite') {
    const file = path.join(dir, 'database.db');
    // VACUUM INTO wants a missing or empty file: created exclusively, 0600
    fs.closeSync(fs.openSync(file, 'wx', 0o600));
    try {
      // in a worker thread on its own connection: the event loop (requests, probes) does not wait for the copy
      await snapshotSqlite(target.file, file, () => db().snapshotTo(file));
    } catch (e) {
      fs.rmSync(file, { force: true });
      throw e;
    }
    // the head of the audit log as the snapshot has it
    const snap = openSqliteFile(file);
    try {
      return { file, entry: 'database/steward.db', kind: 'sqlite', audit: headOf(snap.get<{ seq: number; hash: string }>(HEAD_SQL)) };
    } finally {
      snap.close();
    }
  }
  const file = path.join(dir, 'database.pgdump');
  // read before the dump starts: the dump has at least these entries
  const audit = headOf(db().get<{ seq: number; hash: string }>(HEAD_SQL));
  const c = pgDumpArgs(target, file);
  await run(pgDumpBin(), c.args, c.env);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return { file, entry: 'database/steward.pgdump', kind: 'postgres', schema: target.schema, audit };
}

/**
 * Files of the data folder that go into the backup (regular files only; links are not followed). `exclude`: optional
 * parts left out (contents.ts) – their top-level folders are skipped.
 */
export function dataFiles(root = config.dataDir, exclude: readonly BackupOptionalPart[] = []): { rel: string; abs: string }[] {
  const dbFile = config.database.kind === 'sqlite' ? path.resolve(config.database.file) : null;
  // the map's tile cache is rebuilt from its source, and its PMTiles files are placed by whoever runs Steward (#234)
  // .export-work: files of a scheduled export on their way to S3 (export/jobs.ts)
  const skipTop = new Set(['backups', WORK_DIR, '.export-work', 'instance.json', 'cache', 'maps', ...exclude.map((p) => PART_FOLDER[p])]);
  const out: { rel: string; abs: string }[] = [];
  const walk = (dir: string, rel: string) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      const abs = path.join(dir, d.name);
      if (!rel && skipTop.has(d.name)) continue;
      // the database goes in as a snapshot; its instance lock (database/sqlite-lock.ts) belongs to the running process
      if (dbFile && [dbFile, `${dbFile}-wal`, `${dbFile}-shm`, `${dbFile}-journal`, `${dbFile}.lock`, `${dbFile}.lock.json`].includes(path.resolve(abs)))
        continue;
      if (d.isDirectory()) walk(abs, r);
      else if (d.isFile()) out.push({ rel: r, abs });
    }
  };
  walk(root, '');
  return out;
}

/** What the left-out parts hold now (files and bytes), for the manifest. */
function excludedParts(exclude: readonly BackupOptionalPart[]): BackupExcludedPart[] {
  return exclude.map((part) => {
    const folder = path.join(config.dataDir, PART_FOLDER[part]);
    let files = 0;
    let bytes = 0;
    if (fs.existsSync(folder))
      for (const f of dataFiles(folder)) {
        try {
          bytes += fs.statSync(f.abs).size;
          files++;
        } catch {
          // removed meanwhile
        }
      }
    return { part, path: `${PART_FOLDER[part]}/`, files, bytes };
  });
}

/** Builds the archive at `out` (must not exist). `exclude`: optional parts the backup settings leave out. */
export async function createArchive(out: string, o: { now?: Date; exclude?: readonly BackupOptionalPart[] } = {}): Promise<BackupManifest> {
  const dir = workDir();
  const exclude = o.exclude ?? [];
  const snap = await snapshotDatabase(dir);
  // ZIP64 where needed: backups past 4 GB or 65,535 files (an archive within those limits is plain PKZIP 2.0)
  const zip = await ZipWriter.create(out, undefined, { zip64: true });
  try {
    const files: WrittenEntry[] = [];
    files.push(await zip.addFile(snap.entry, snap.file));
    fs.rmSync(snap.file, { force: true });
    for (const f of dataFiles(config.dataDir, exclude)) {
      try {
        files.push(await zip.addFile(`data/${f.rel}`, f.abs));
      } catch (e) {
        // a file removed while the backup runs (a temporary report, …) is skipped
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    const manifest: BackupManifest = {
      format: 'steward-backup',
      v: 1,
      createdAt: (o.now ?? new Date()).toISOString(),
      version: config.version,
      database: { kind: snap.kind, file: snap.entry, ...(snap.schema ? { schema: snap.schema } : {}) },
      files: files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
      audit: snap.audit,
      ...(exclude.length ? { excluded: excludedParts(exclude) } : {}),
    };
    await zip.add(MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2)));
    await zip.finish();
    return manifest;
  } catch (e) {
    await zip.abort().catch(() => undefined); // cleanup after a failure: the original error is thrown below
    fs.rmSync(snap.file, { force: true });
    throw e;
  }
}

export interface ArchiveCheck {
  ok: boolean;
  manifest?: BackupManifest;
  /** One line per check, in order */
  steps: { name: string; ok: boolean; message: string }[];
}

/**
 * Checks a decrypted archive: every file against the manifest (SHA-256, CRC, nothing missing or extra) and, with
 * `deep`, the database itself – SQLite: integrity_check and the audit chain of the snapshot (the vault's audit key,
 * so only on the installation that made it); PostgreSQL: pg_restore --list reads the dump.
 */
export async function checkArchive(file: string, o: { deep?: boolean } = {}): Promise<ArchiveCheck> {
  const steps: ArchiveCheck['steps'] = [];
  const step = (name: string, ok: boolean, message: string) => (steps.push({ name, ok, message }), ok);
  let zip: ZipReader;
  try {
    zip = await ZipReader.open(file, { zip64: true });
  } catch (e) {
    step('archive', false, `The archive cannot be read: ${(e as Error).message}`);
    return { ok: false, steps };
  }
  const m = zip.find(MANIFEST);
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse((await zip.read(m!, 4 * 1024 * 1024)).toString('utf8')) as BackupManifest;
    if (!m || manifest.format !== 'steward-backup' || manifest.v !== 1 || !Array.isArray(manifest.files)) throw new Error('not a Steward backup manifest');
  } catch (e) {
    step('manifest', false, `The manifest is missing or broken: ${(e as Error).message}`);
    return { ok: false, steps };
  }
  step('manifest', true, `Backup of ${manifest.createdAt} (Steward ${manifest.version}, ${manifest.database.kind}), ${manifest.files.length} files`);
  const listed = new Set(manifest.files.map((f) => f.path));
  const extra = zip.entries.filter((e) => e.name !== MANIFEST && !listed.has(e.name)).map((e) => e.name);
  const bad: string[] = [];
  for (const f of manifest.files) {
    const e = zip.find(f.path);
    if (!e) {
      bad.push(`${f.path} is missing`);
      continue;
    }
    const d = await zip.digest(e).catch((err: Error) => ({ sha256: '', size: -1, crcOk: false, err }));
    if (!d.crcOk || d.sha256 !== f.sha256 || d.size !== f.size) bad.push(`${f.path} differs from the manifest`);
  }
  if (extra.length) bad.push(`not in the manifest: ${extra.slice(0, 5).join(', ')}`);
  if (!step('checksums', !bad.length, bad.length ? bad.slice(0, 5).join('; ') : `All ${manifest.files.length} files match their SHA-256`))
    return { ok: false, manifest, steps };
  // left out on purpose (0.16.0): not a failure, but a restore from this backup lacks these folders
  if (manifest.excluded?.length)
    step('contents', true, `Left out by the backup settings – a restore from this backup lacks them: ${excludedText(manifest.excluded)}`);
  if (!o.deep) return { ok: true, manifest, steps };

  const dbEntry = zip.find(manifest.database.file)!;
  const tmp = path.join(workDir(), `check-${process.pid}-${Date.now()}${manifest.database.kind === 'sqlite' ? '.db' : '.pgdump'}`);
  try {
    const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
    const s = await zip.stream(dbEntry);
    await new Promise<void>((resolve, reject) => {
      s.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve());
      s.pipe(out);
    });
    if (manifest.database.kind === 'sqlite') {
      const snap = openSqliteFile(tmp);
      try {
        const rows = snap.integrity();
        const okIntegrity = rows.length === 1 && rows[0] === 'ok';
        step('database', okIntegrity, okIntegrity ? 'SQLite integrity check: ok' : `SQLite integrity check: ${rows.slice(0, 3).join('; ')}`);
        if (okIntegrity) {
          const v = await verifyAuditAsync({ source: snap });
          const headOk = !manifest.audit || (v.head?.seq === manifest.audit.seq && v.head.hash === manifest.audit.hash);
          step(
            'audit',
            v.ok && headOk,
            !v.ok
              ? `Audit chain of the snapshot: ${v.message}`
              : headOk
                ? `Audit chain of the snapshot: ${v.message}`
                : 'The audit log of the snapshot ends elsewhere than the manifest says',
          );
        }
      } finally {
        snap.close();
      }
    } else {
      const list = await run(pgRestoreBin(), ['--list', tmp]).then(
        (t) => ({ ok: true, n: t.split('\n').filter((l) => l && !l.startsWith(';')).length, toc: t }),
        (e: Error) => ({ ok: false, n: 0, toc: '', message: e.message }),
      );
      step('database', list.ok, list.ok ? `pg_restore reads the dump (${list.n} objects)` : (list as { message: string }).message);
      // with a scratch database: restored there and checked like a SQLite snapshot (SM_BACKUP_RESTORE_TEST_DATABASE_URL)
      if (list.ok && env.SM_BACKUP_RESTORE_TEST_DATABASE_URL) await restoreIntoScratch(tmp, list.toc, manifest, step);
    }
  } catch (e) {
    step('database', false, `The database could not be checked: ${(e as Error).message}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return { ok: steps.every((s) => s.ok), manifest, steps };
}

/** Marks the schemas of the scratch database that the restore test may replace. */
const SCRATCH_MARK = 'Steward restore test (SM_BACKUP_RESTORE_TEST_DATABASE_URL): replaced by every restore test';

/** host:port/database of a PostgreSQL URL, to tell whether two URLs name the same database. */
export function databaseIdentity(url: string): string {
  const u = new URL(url);
  return `${u.hostname.toLowerCase()}:${u.port || '5432'}/${decodeURIComponent(u.pathname.replace(/^\//, '')) || decodeURIComponent(u.username)}`;
}

/**
 * The PostgreSQL restore test (O14 of the 0.10 review): pg_restore of the dump into the scratch database
 * SM_BACKUP_RESTORE_TEST_DATABASE_URL – never the live one – then the same checks as for a SQLite snapshot: the schema
 * version, the audit chain of the restored data (against the installation's audit key) ending at the entry the
 * manifest names; the restored schema is dropped again. pg_restore restores into the schema the dump was made of, so
 * the scratch database must be another database; a schema of that name in it that the restore test did not create is
 * left alone (the check fails).
 */
async function restoreIntoScratch(
  dump: string,
  toc: string,
  manifest: BackupManifest,
  step: (name: string, ok: boolean, message: string) => boolean,
): Promise<void> {
  const scratchUrl = env.SM_BACKUP_RESTORE_TEST_DATABASE_URL!;
  const schema = manifest.database.schema ?? 'public';
  let scratch: Db | undefined;
  try {
    const live = config.database.kind === 'postgres' ? config.database.url : null;
    if (live && databaseIdentity(live) === databaseIdentity(scratchUrl))
      return void step('restore', false, 'SM_BACKUP_RESTORE_TEST_DATABASE_URL names the live database – the restore test needs a database of its own');
    const target = parseDatabaseTarget(scratchUrl, { schema: 'public', ca: env.SM_DATABASE_CA });
    if (target.kind !== 'postgres') return void step('restore', false, 'SM_BACKUP_RESTORE_TEST_DATABASE_URL is not a postgres:// URL');
    scratch = new Db({ ...target, lock: false, timeoutMs: 600_000 }, { migrate: false });
    const existing = scratch.get<{ mark: string | null; objects: number }>(
      `SELECT obj_description(n.oid, 'pg_namespace') AS mark, (SELECT COUNT(*) FROM pg_class c WHERE c.relnamespace = n.oid) AS objects
       FROM pg_namespace n WHERE n.nspname = ?`,
      schema,
    );
    if (existing && existing.mark !== SCRATCH_MARK && Number(existing.objects) > 0)
      return void step(
        'restore',
        false,
        `The restore test database already has a schema "${schema}" with data that the restore test did not create – use an empty database`,
      );
    const dropSchema = () => {
      scratch!.exec(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
      // the dump creates its schema itself unless it is "public"; an empty "public" is left marked for the next test
      if (schema === 'public') scratch!.exec(`CREATE SCHEMA public; COMMENT ON SCHEMA public IS '${SCRATCH_MARK}'`);
    };
    dropSchema();
    // the dump's table of contents lists "… SCHEMA - <name> <owner>" when it creates the schema itself (an exact match,
    // no pattern built from the configured name)
    const createsSchema = toc.split('\n').some((l) => ` ${l.trim()} `.includes(` SCHEMA - ${schema} `));
    if (!createsSchema) scratch.exec(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
    const c = pgConnection(scratchUrl);
    const t0 = Date.now();
    try {
      // without --exit-on-error: a pg_restore newer than the restore test server (16 or older) reports the unknown
      // transaction_timeout setting; that error alone is accepted, any other fails the step
      const r = await runCapture(pgRestoreBin(), ['--no-owner', '--no-privileges', `--dbname=${c.dbname}`, dump], c.env);
      if (r.code !== 0 && !onlyTransactionTimeoutErrors(r.err)) throw new Error(explainPgToolError(pgRestoreBin(), r.err, r.code));
    } catch (e) {
      step('restore', false, `pg_restore into the restore test database failed: ${(e as Error).message}`);
      dropSchema();
      return;
    }
    scratch.exec(`COMMENT ON SCHEMA ${quoteIdent(schema)} IS '${SCRATCH_MARK}'`);
    const restored = new Db({ ...target, schema, lock: false, timeoutMs: 600_000 }, { migrate: false });
    try {
      const tables = Number(
        restored.get<{ n: number }>("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'")
          ?.n ?? 0,
      );
      const version = restored.get<{ version: number }>('SELECT version FROM schema_version');
      step(
        'restore',
        tables > 0 && !!version,
        `Restored into the restore test database in ${Math.round((Date.now() - t0) / 1000)} s: ${tables} tables, schema version ${version?.version ?? '–'}`,
      );
      const v = await verifyAuditAsync({ source: restored });
      const headOk = !manifest.audit || (v.head?.seq === manifest.audit.seq && v.head.hash === manifest.audit.hash);
      step(
        'audit',
        v.ok && headOk,
        !v.ok || headOk ? `Audit chain of the restored database: ${v.message}` : 'The audit log of the restored database ends elsewhere than the manifest says',
      );
    } finally {
      restored.close();
      dropSchema();
    }
  } catch (e) {
    step('restore', false, `The restore test database could not be used: ${(e as Error).message}`);
  } finally {
    scratch?.close();
  }
}
