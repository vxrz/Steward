import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Running PostgreSQL's own client programs (pg_dump, pg_restore) for a database target: the password goes in
 * PGPASSWORD, never on the command line (where `ps` shows it), and nothing goes through a shell.
 */

/** A connection string without the password (that goes in PGPASSWORD, never on the command line). */
export function pgConnection(url: string): { dbname: string; env: NodeJS.ProcessEnv } {
  const u = new URL(url);
  const password = decodeURIComponent(u.password);
  u.password = '';
  return { dbname: u.toString(), env: password ? { PGPASSWORD: password } : {} };
}

/** The arguments of a dump of one schema in pg_dump's custom format (restore with pg_restore). */
export function pgDumpArgs(target: { url: string; schema: string }, file: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const c = pgConnection(target.url);
  return { args: ['--format=custom', `--schema=${target.schema}`, `--file=${file}`, `--dbname=${c.dbname}`], env: c.env };
}

/**
 * Why a pg_dump/pg_restore failed, with what to do for the common cases: the program is missing, or it is older than
 * the server (the container image has PostgreSQL 17's programs; a newer server needs its own, SM_PG_DUMP).
 */
export function explainPgToolError(bin: string, stderr: string, code: number | null, error?: NodeJS.ErrnoException): string {
  const name = path.basename(bin);
  if (error?.code === 'ENOENT') return `${bin} is not installed (set SM_PG_DUMP / SM_PG_RESTORE to its path)`;
  if (error?.code === 'ETIMEDOUT') return `${name} did not finish in time`;
  if (error) return `${name}: ${error.message}`;
  const tail = stderr.trim().slice(-1000);
  const hint = /server version mismatch|aborting because of server version/i.test(stderr)
    ? ` – the PostgreSQL server is newer than ${name}: point ${name === 'pg_restore' ? 'SM_PG_RESTORE' : 'SM_PG_DUMP'} at the program of the server's version (or newer)`
    : '';
  return `${name} failed (exit ${code}): ${tail}${hint}`;
}

/**
 * A dump of `target`'s schema into `file`, synchronously: used before migrating at start-up, when nothing else runs
 * yet. The caller creates the file first with the permissions it should keep (0600: it holds the same encrypted
 * secrets as the database); pg_dump overwrites it. A failed or timed-out dump removes the file and throws with the
 * reason.
 */
export function pgDumpSync(o: { bin: string; target: { url: string; schema: string }; file: string; timeoutMs: number }): { bytes: number; ms: number } {
  const t0 = Date.now();
  const { args, env } = pgDumpArgs(o.target, o.file);
  const r = spawnSync(o.bin, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: o.timeoutMs > 0 ? o.timeoutMs : undefined,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    fs.rmSync(o.file, { force: true });
    throw new Error(explainPgToolError(o.bin, r.stderr?.toString('utf8') ?? '', r.status, r.error as NodeJS.ErrnoException | undefined));
  }
  return { bytes: fs.statSync(o.file).size, ms: Date.now() - t0 };
}
