import { DB_LIMITS } from '@sm/shared';
import { logger } from '../log.js';
import { DbError, type DriverConnection } from './types.js';

/**
 * A small pool per database platform (ADR 0008): at most `size` connections, closed after DB_LIMITS.idleSeconds idle,
 * all closed when the platform's settings or credentials change (the stamp differs, or invalidatePlatformCaches), when
 * it is deleted, and on shutdown. A connection a driver marks unusable (cancelled, timed out, broken) is closed, never
 * handed out again.
 */

interface Idle {
  conn: DriverConnection;
  timer: NodeJS.Timeout;
}

export class ConnectionPool {
  private idle: Idle[] = [];
  private open = 0;
  private waiters: (() => void)[] = [];
  private closed = false;

  constructor(
    private readonly opener: (signal: AbortSignal) => Promise<DriverConnection>,
    readonly size: number,
    private readonly idleMs = DB_LIMITS.idleSeconds * 1000,
  ) {}

  get stats() {
    return { open: this.open, idle: this.idle.length, waiting: this.waiters.length };
  }

  async acquire(signal: AbortSignal): Promise<DriverConnection> {
    for (;;) {
      if (this.closed) throw new DbError('DB_CONNECT_FAILED', 'The connections of this platform were closed (its settings changed) – try again');
      if (signal.aborted) throw new DbError('DB_CANCELLED', 'The statement was cancelled while waiting for a connection');
      const hit = this.idle.pop();
      if (hit) {
        clearTimeout(hit.timer);
        if (hit.conn.usable) return hit.conn;
        this.drop(hit.conn);
        continue;
      }
      if (this.open < this.size) {
        this.open++;
        try {
          return await this.opener(signal);
        } catch (e) {
          this.open--;
          this.wake();
          throw e;
        }
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          signal.removeEventListener('abort', done);
          this.waiters = this.waiters.filter((w) => w !== done);
          resolve();
        };
        this.waiters.push(done);
        signal.addEventListener('abort', done, { once: true });
      });
    }
  }

  release(conn: DriverConnection): void {
    if (this.closed || !conn.usable) {
      this.drop(conn);
      return;
    }
    const timer = setTimeout(() => {
      this.idle = this.idle.filter((i) => i.conn !== conn);
      this.drop(conn);
    }, this.idleMs);
    timer.unref?.();
    this.idle.push({ conn, timer });
    this.wake();
  }

  private drop(conn: DriverConnection): void {
    this.open = Math.max(0, this.open - 1);
    conn.close().catch((err) => logger.debug({ err }, 'closing a database connection failed')); // it is gone either way
    this.wake();
  }

  private wake(): void {
    this.waiters.shift()?.();
  }

  async close(): Promise<void> {
    this.closed = true;
    const idle = this.idle;
    this.idle = [];
    for (const i of idle) clearTimeout(i.timer);
    await Promise.all(idle.map((i) => i.conn.close().catch(() => undefined))); // shutting down: a connection that does not close goes with the process
    for (const w of this.waiters.splice(0)) w();
  }
}

const pools = new Map<string, { stamp: string; pool: ConnectionPool }>();

/** The pool of a platform identity (key `platformId:identityId`, platforms/http.ts identityKey) for its current settings (a new stamp closes the old pool). */
export function poolFor(key: string, stamp: string, size: number, opener: (signal: AbortSignal) => Promise<DriverConnection>): ConnectionPool {
  const hit = pools.get(key);
  if (hit && hit.stamp === stamp) return hit.pool;
  if (hit) void hit.pool.close();
  const pool = new ConnectionPool(opener, size);
  pools.set(key, { stamp, pool });
  return pool;
}

/** Closes the pools of a platform: of all its identities, or of one. */
export function closePool(platformId: string, identityId?: string): void {
  for (const [key, hit] of [...pools]) {
    if (identityId ? key !== `${platformId}:${identityId}` : !key.startsWith(`${platformId}:`)) continue;
    pools.delete(key);
    void hit.pool.close();
  }
}

export async function closeAllPools(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(all.map((p) => p.pool.close()));
}

export const poolCount = (): number => pools.size;
