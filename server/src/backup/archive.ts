import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db.js';
import { flushPendingAudit, verifyAuditAsync } from '../audit.js';
import { ZipReader, ZipWriter, type WrittenEntry } from '../compliance/zip.js';
import { openSqliteFile } from '../database/sqlite-file.js';

/**
 * The backup archive (#117), before encryption: a ZIP with
 *   manifest.json            what is in it, with the SHA-256 of every file, and the head of the audit log
 *   database/steward.db      SQLite: a consistent snapshot (VACUUM INTO, online)
 *   database/steward.pgdump  PostgreSQL: pg_dump of the schema in the custom format (pg_restore)
 *   data/…                   the data folder: vault.json, artifacts, documents, reports, audit anchors, …
 * Not included: the live database files (the snapshot stands for them), the automatic pre-upgrade copies (backups/)
 * and the work folder of backups. The master passphrase is never in a backup: keep it apart, like the backup passphrase.
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
}

/** A work folder in the data folder (0700) – never /tmp: the snapshot holds the same encrypted secrets as the database. */
export function workDir(): string {
  const dir = path.join(config.dataDir, WORK_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  return dir;
}

const pgDumpBin = () => process.env.SM_PG_DUMP || 'pg_dump';
const pgRestoreBin = () => process.env.SM_PG_RESTORE || 'pg_restore';

/** Runs a program without a shell; the error carries the end of its stderr. */
function run(bin: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (b: Buffer) => (out = (out + b.toString('utf8')).slice(-1024 * 1024)));
    child.stderr.on('data', (b: Buffer) => (err = (err + b.toString('utf8')).slice(-4000)));
    child.on('error', (e: NodeJS.ErrnoException) =>
      reject(new Error(e.code === 'ENOENT' ? `${bin} is not installed (set SM_PG_DUMP / SM_PG_RESTORE to its path)` : `${bin}: ${e.message}`)),
    );
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(bin)} failed (exit ${code}): ${err.trim().slice(-1000)}`))));
  });
}

/** A connection string without the password (that goes in PGPASSWORD, never on the command line). */
function pgConnection(url: string): { dbname: string; env: NodeJS.ProcessEnv } {
  const u = new URL(url);
  const password = decodeURIComponent(u.password);
  u.password = '';
  return { dbname: u.toString(), env: password ? { PGPASSWORD: password } : {} };
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
      db().snapshotTo(file);
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
  const c = pgConnection(target.url);
  await run(pgDumpBin(), ['--format=custom', `--schema=${target.schema}`, `--file=${file}`, `--dbname=${c.dbname}`], c.env);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return { file, entry: 'database/steward.pgdump', kind: 'postgres', schema: target.schema, audit };
}

/** Files of the data folder that go into the backup (regular files only; links are not followed). */
export function dataFiles(root = config.dataDir): { rel: string; abs: string }[] {
  const dbFile = config.database.kind === 'sqlite' ? path.resolve(config.database.file) : null;
  const skipTop = new Set(['backups', WORK_DIR, 'instance.json']);
  const out: { rel: string; abs: string }[] = [];
  const walk = (dir: string, rel: string) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      const abs = path.join(dir, d.name);
      if (!rel && skipTop.has(d.name)) continue;
      if (dbFile && [dbFile, `${dbFile}-wal`, `${dbFile}-shm`, `${dbFile}-journal`].includes(path.resolve(abs))) continue;
      if (d.isDirectory()) walk(abs, r);
      else if (d.isFile()) out.push({ rel: r, abs });
    }
  };
  walk(root, '');
  return out;
}

/** Builds the archive at `out` (must not exist). */
export async function createArchive(out: string, o: { now?: Date } = {}): Promise<BackupManifest> {
  const dir = workDir();
  const snap = await snapshotDatabase(dir);
  const zip = await ZipWriter.create(out);
  try {
    const files: WrittenEntry[] = [];
    files.push(await zip.addFile(snap.entry, snap.file));
    fs.rmSync(snap.file, { force: true });
    for (const f of dataFiles()) {
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
    };
    await zip.add(MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2)));
    await zip.finish();
    return manifest;
  } catch (e) {
    await zip.abort().catch(() => undefined);
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
    zip = await ZipReader.open(file);
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
        (t) => ({ ok: true, n: t.split('\n').filter((l) => l && !l.startsWith(';')).length }),
        (e: Error) => ({ ok: false, n: 0, message: e.message }),
      );
      step('database', list.ok, list.ok ? `pg_restore reads the dump (${list.n} objects)` : (list as { message: string }).message);
    }
  } catch (e) {
    step('database', false, `The database could not be checked: ${(e as Error).message}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return { ok: steps.every((s) => s.ok), manifest, steps };
}
