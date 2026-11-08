/**
 * Single-instance lock on SQLite (ADR 0002, update 0.10.1): the counterpart of the PostgreSQL lease (lease.ts).
 *
 * The holder keeps a second, tiny SQLite database next to the app's database (`<database file>.lock`) open with
 * `BEGIN EXCLUSIVE`. That is a lock of the operating system (POSIX `fcntl` locks on Linux and macOS, `LockFileEx` on
 * Windows), the same SQLite uses for its own database files: it holds across processes and across containers that
 * share the volume on one machine, and it ends with the process – a crash or `kill -9` leaves no stale lock behind.
 * A second instance cannot take it (SQLITE_BUSY at once, no busy timeout) and waits.
 *
 * A separate file, and not a lock on the app's database itself: the app's own connection reads and writes that one
 * (WAL), and a waiting instance must not open, let alone migrate, a database another one uses.
 *
 * Who holds the lock is written to `<database file>.lock.json` (process, host, version, start), only for the log
 * lines and messages of whoever waits: the lock itself decides. Like SQLite's own locking, this does not work
 * reliably on network file systems (NFS, SMB); docs/INSTALL.md says so.
 */
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { BRAND } from '@sm/shared';

export interface LockHolder {
  pid: number | null;
  host: string | null;
  version: string | null;
  startedAt: string | null;
}

export const lockFileOf = (dbFile: string): string => `${dbFile}.lock`;
export const holderFileOf = (dbFile: string): string => `${dbFile}.lock.json`;

/** SQLITE_BUSY / SQLITE_LOCKED: someone else holds the lock. */
function isBusy(e: unknown): boolean {
  const code = (e as { errcode?: number } | null)?.errcode;
  return code === 5 || code === 6 || /database is locked|SQLITE_BUSY/i.test(String((e as Error)?.message));
}

function identity(file: string): string | null {
  try {
    const st = fs.statSync(file);
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

/** The holder as it last wrote itself down (null: unknown). */
export function readHolder(dbFile: string): LockHolder | null {
  try {
    const h = JSON.parse(fs.readFileSync(holderFileOf(dbFile), 'utf8')) as Partial<LockHolder>;
    return { pid: h.pid ?? null, host: h.host ?? null, version: h.version ?? null, startedAt: h.startedAt ?? null };
  } catch {
    return null;
  }
}

/** "process 123 on host-a, version 0.10.1, since …" (for messages). */
export function describeHolder(h: LockHolder | null): string {
  if (!h) return 'another process';
  const parts = [`process ${h.pid ?? '?'}${h.host ? ` on ${h.host}` : ''}`];
  if (h.version) parts.push(`version ${h.version}`);
  if (h.startedAt) parts.push(`since ${h.startedAt}`);
  return parts.join(', ');
}

export interface SqliteLockOptions {
  /** The app's SQLite database file; the lock is `<file>.lock` next to it. */
  file: string;
  version: string;
  /** Retry while waiting (ms). */
  retryMs?: number;
  /** How often the holder checks that its lock file is still there (ms). */
  checkMs?: number;
}

/**
 * Opens the lock database and takes its exclusive lock: the connection that holds it, or null when another process
 * holds it. Other errors (no access, read-only file system) are thrown.
 */
function attempt(lockFile: string): DatabaseSync | null {
  // Loaded lazily so the ExperimentalWarning filter in warnings.ts is active first.
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  let c: DatabaseSync;
  try {
    c = new DatabaseSync(lockFile);
  } catch (e) {
    throw new Error(`could not open the instance lock ${lockFile}: ${(e as Error).message}`, { cause: e });
  }
  try {
    // fail at once while someone else holds it; never wait inside SQLite (the event loop would stand still)
    c.exec('PRAGMA busy_timeout = 0');
    c.exec('BEGIN EXCLUSIVE');
    return c;
  } catch (e) {
    c.close();
    if (isBusy(e)) return null;
    throw new Error(`could not take the instance lock ${lockFile}: ${(e as Error).message}`, { cause: e });
  }
}

export class SqliteInstanceLock {
  readonly lockFile: string;
  private conn: DatabaseSync | null = null;
  private heldId: string | null = null;
  private state: 'idle' | 'waiting' | 'held' | 'lost' | 'released' = 'idle';
  private lostHandlers: ((reason: string) => void)[] = [];
  private checkTimer: NodeJS.Timeout | undefined;
  private wake: (() => void) | undefined;
  private cancelled = false;
  private readonly startedAt = new Date().toISOString();

  constructor(private readonly opts: SqliteLockOptions) {
    this.lockFile = lockFileOf(opts.file);
  }

  get status(): 'idle' | 'waiting' | 'held' | 'lost' | 'released' {
    return this.state;
  }

  /** One attempt: true when this process holds the lock now. Errors other than "held by someone else" are thrown. */
  tryAcquire(): boolean {
    if (this.state === 'held') return true;
    const c = attempt(this.lockFile);
    if (!c) return false;
    this.conn = c;
    this.heldId = identity(this.lockFile);
    this.state = 'held';
    this.writeHolder();
    clearInterval(this.checkTimer);
    this.checkTimer = setInterval(() => this.check(), this.opts.checkMs ?? 10_000);
    this.checkTimer.unref();
    return true;
  }

  /**
   * Resolves once the lock is held; `onWait` is told about each attempt that had to wait. Resolves `false` when
   * release() was called while waiting.
   */
  async acquire(onWait?: (holder: LockHolder | null) => void): Promise<boolean> {
    this.cancelled = false;
    for (;;) {
      if (this.cancelled) return false;
      this.state = 'waiting';
      if (this.tryAcquire()) return true;
      onWait?.(readHolder(this.opts.file));
      await new Promise<void>((r) => {
        const t = setTimeout(r, this.opts.retryMs ?? 2_000);
        this.wake = () => (clearTimeout(t), r());
      });
      this.wake = undefined;
    }
  }

  /** Called once when the held lock is lost (its file was removed and another process took the new one). */
  onLost(fn: (reason: string) => void): void {
    this.lostHandlers.push(fn);
  }

  /** Gives the lock up (the next instance takes over within its retry interval); also ends a wait. */
  release(): void {
    const wasHeld = this.state === 'held';
    this.state = 'released';
    this.cancelled = true;
    this.wake?.();
    clearInterval(this.checkTimer);
    if (wasHeld) {
      try {
        const h = readHolder(this.opts.file);
        if (h?.pid === process.pid && h.host === os.hostname() && h.startedAt === this.startedAt) fs.rmSync(holderFileOf(this.opts.file), { force: true });
      } catch {
        /* only informative */
      }
    }
    this.closeConn();
  }

  private closeConn(): void {
    const c = this.conn;
    this.conn = null;
    this.heldId = null;
    try {
      c?.close();
    } catch {
      /* already closed */
    }
  }

  private writeHolder(): void {
    const holder: LockHolder = { pid: process.pid, host: os.hostname(), version: this.opts.version, startedAt: this.startedAt };
    const file = holderFileOf(this.opts.file);
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ product: BRAND.slug, ...holder }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      fs.rmSync(tmp, { force: true });
    }
  }

  /**
   * The lock lives on the file's inode: if someone deleted or replaced `<file>.lock`, a new instance could take a
   * lock on the new file. Then take it again ourselves, or – if another process was faster – report the loss.
   */
  private check(): void {
    if (this.state !== 'held' || identity(this.lockFile) === this.heldId) return;
    const old = this.conn;
    this.conn = null;
    this.state = 'idle';
    let again: boolean;
    try {
      again = this.tryAcquire();
    } catch {
      again = false; // the new file cannot be opened: treated like a lock someone else holds
    }
    try {
      old?.close();
    } catch {
      /* already closed */
    }
    if (again) return;
    clearInterval(this.checkTimer);
    this.state = 'lost';
    const reason = `the instance lock ${this.lockFile} was removed or replaced, and ${describeHolder(readHolder(this.opts.file))} holds the new one`;
    for (const h of this.lostHandlers) h(reason);
  }
}

/**
 * For the command-line tools that write to the database (admin, migrate, db:copy): takes the lock for the rest of the
 * process, so Steward cannot start on the same database meanwhile (it waits). Throws a message naming the holder when
 * Steward (or another tool) runs with this database.
 */
export function lockForCommand(dbFile: string, version: string): SqliteInstanceLock {
  const lock = new SqliteInstanceLock({ file: dbFile, version });
  if (!lock.tryAcquire()) {
    throw new Error(
      `${BRAND.name} is running with this database (${dbFile}; ${describeHolder(readHolder(dbFile))}), or is starting, or another command uses it – stop it first`,
    );
  }
  return lock;
}

/** Whether another process holds the lock of `dbFile` right now (taken and given back at once, nothing written). */
export function lockHeldElsewhere(dbFile: string): { held: false } | { held: true; holder: LockHolder | null } {
  if (!fs.existsSync(lockFileOf(dbFile))) return { held: false };
  let c: DatabaseSync | null;
  try {
    c = attempt(lockFileOf(dbFile));
  } catch {
    return { held: false };
  }
  if (!c) return { held: true, holder: readHolder(dbFile) };
  c.close();
  return { held: false };
}
