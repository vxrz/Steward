import type net from 'node:net';
import type { DbDialect, DbQueryResult, DbTlsMode } from '@sm/shared';
import { HttpError } from '../util.js';

/**
 * The driver interface of database platforms (ADR 0008): one implementation per DBMS (postgres.ts, mysql.ts,
 * sqlserver.ts; demo.ts for demo mode). Oracle (oracledb thin mode, SET TRANSACTION READ ONLY) fits the same shape.
 */

/** What a driver needs to open a connection. The socket factory is Steward's (outbound policy, pinned address). */
export interface ConnectTarget {
  dialect: DbDialect;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  tls: { mode: DbTlsMode; ca?: string; serverName?: string };
  connectTimeoutMs: number;
  /** A TCP socket to host:port through the guarded DNS lookup (not yet connected for pg; connected for the others) */
  socket: () => net.Socket;
}

/** The server a connection talks to (flavour: MariaDB and MySQL differ in their role tables). */
export interface ServerInfo {
  flavour: 'postgresql' | 'mysql' | 'mariadb' | 'sqlserver';
  version: string;
}

export interface Statement {
  sql: string;
  params: unknown[];
  /** A catalog query of Steward (catalog.ts): not run through the statement check (SHOW … is allowed) */
  trusted: boolean;
}

export interface RunLimits {
  maxRows: number;
  maxBytes: number;
  timeoutMs: number;
  /** Keep the first rows instead of failing when a limit is reached */
  truncate: boolean;
}

export interface DriverConnection {
  readonly server: ServerInfo;
  /** Runs one statement in a read-only (or always rolled back) transaction, within the limits. */
  run(stmt: Statement, limits: RunLimits, signal: AbortSignal): Promise<DbQueryResult>;
  /** false once the connection may not be reused (cancelled, timed out, protocol error) */
  readonly usable: boolean;
  close(): Promise<void>;
}

export interface DbDriver {
  connect(target: ConnectTarget, signal: AbortSignal): Promise<DriverConnection>;
}

/** Errors of database platforms: a stable code (problem+json, translated in the web app) and an English message. */
export class DbError extends HttpError {
  constructor(code: DbErrorCode, message: string, params?: Record<string, string | number>, status = 502) {
    super(status, message, code, params);
  }
}

export type DbErrorCode =
  | 'DB_NOT_A_DATABASE'
  | 'DB_SETTINGS_MISSING'
  | 'DB_SETTINGS_INVALID'
  | 'DB_CREDENTIALS_MISSING'
  | 'DB_DIALECT_MISMATCH'
  | 'DB_STATEMENT_REFUSED'
  | 'DB_PARAM_INVALID'
  | 'DB_ROW_LIMIT'
  | 'DB_SIZE_LIMIT'
  | 'DB_TIMEOUT'
  | 'DB_CANCELLED'
  | 'DB_CONNECT_FAILED'
  | 'DB_AUTH_FAILED'
  | 'DB_TLS_FAILED'
  | 'DB_PERMISSION_DENIED'
  | 'DB_READ_ONLY_VIOLATION'
  | 'DB_QUERY_FAILED'
  | 'DB_MULTIPLE_RESULTS';

// ---------- results ----------

/** A cell as JSON: dates as ISO text, big integers and decimals as text, binary data as base64 (cut at 4 kB). */
export function cellValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (Buffer.isBuffer(v)) return `base64:${v.subarray(0, 4096).toString('base64')}${v.length > 4096 ? '…' : ''}`;
  if (v instanceof Uint8Array) return cellValue(Buffer.from(v));
  if (Array.isArray(v)) return v.map(cellValue);
  if (typeof v === 'object') {
    try {
      return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
    } catch {
      return String(v);
    }
  }
  return v;
}

/**
 * Collects rows within the limits. `add` returns false once no more rows are wanted (the driver stops reading); a
 * limit reached without `truncate` throws DB_ROW_LIMIT or DB_SIZE_LIMIT.
 */
export class RowCollector {
  readonly rows: Record<string, unknown>[] = [];
  columns: string[] = [];
  truncated = false;
  private bytes = 2;
  constructor(private readonly limits: RunLimits) {}

  setColumns(names: string[]): void {
    // duplicate column names (SELECT a.id, b.id) get a suffix: id, id_2
    const seen = new Map<string, number>();
    this.columns = names.map((n) => {
      const base = n || 'column';
      const k = (seen.get(base) ?? 0) + 1;
      seen.set(base, k);
      return k === 1 ? base : `${base}_${k}`;
    });
  }

  /** One row as values in column order (or an object keyed by column). */
  add(values: unknown[] | Record<string, unknown>): boolean {
    if (this.truncated) return false;
    const list = Array.isArray(values) ? values : this.columns.map((c) => values[c]);
    const row = Object.fromEntries(this.columns.map((c, i) => [c, cellValue(list[i])]));
    if (this.rows.length >= this.limits.maxRows) return this.stop('rows');
    const size = JSON.stringify(row).length + 1;
    if (this.bytes + size > this.limits.maxBytes) return this.stop('bytes');
    this.bytes += size;
    this.rows.push(row);
    return true;
  }

  private stop(by: 'rows' | 'bytes'): false {
    if (!this.limits.truncate) {
      if (by === 'rows')
        throw new DbError(
          'DB_ROW_LIMIT',
          `The query returned more than ${this.limits.maxRows} rows (the limit) – narrow it, or raise maxRows (the platform's limit is the ceiling) or set onLimit: truncate`,
          { limit: this.limits.maxRows },
          422,
        );
      throw new DbError(
        'DB_SIZE_LIMIT',
        `The result is larger than ${Math.round(this.limits.maxBytes / 1024 / 1024)} MB (the limit) – select fewer columns or rows, or raise maxMb`,
        { limit: Math.round(this.limits.maxBytes / 1024 / 1024) },
        422,
      );
    }
    this.truncated = true;
    return false;
  }

  result(durationMs: number): DbQueryResult {
    return { columns: this.columns, rows: this.rows, rowCount: this.rows.length, truncated: this.truncated, durationMs };
  }
}

/** A timer that aborts a statement: the client-side time limit (on top of the server's statement timeout). */
export function deadline(timeoutMs: number, outer: AbortSignal): { signal: AbortSignal; done: () => void } {
  const ctl = new AbortController();
  const timer = setTimeout(
    () => ctl.abort(new DbError('DB_TIMEOUT', `The statement ran longer than ${Math.round(timeoutMs / 1000)} s (the limit)`)),
    timeoutMs + 2000,
  );
  timer.unref?.();
  const onAbort = () => ctl.abort(outer.reason ?? new DbError('DB_CANCELLED', 'The statement was cancelled'));
  if (outer.aborted) onAbort();
  else outer.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctl.signal,
    done: () => {
      clearTimeout(timer);
      outer.removeEventListener('abort', onAbort);
    },
  };
}

/** The error a signal was aborted with, as a DbError. */
export function abortError(signal: AbortSignal): DbError {
  const r = signal.reason;
  if (r instanceof DbError) return r;
  return new DbError('DB_CANCELLED', 'The statement was cancelled');
}
