import type { EventEmitter } from 'node:events';
import net from 'node:net';
import type { DbQueryResult } from '@sm/shared';
import {
  abortError,
  DbError,
  deadline,
  RowCollector,
  type ConnectTarget,
  type DbDriver,
  type DriverConnection,
  type RunLimits,
  type ServerInfo,
  type Statement,
} from './types.js';
import { mapDriverError } from './errors.js';

/**
 * Microsoft SQL Server (ADR 0008). SQL Server has no read-only transaction: every statement runs in a transaction
 * that is always rolled back, with a request timeout, parameters bound as @p1 … (sp_executesql), one result set only –
 * and the account must be read-only (db_datareader, VIEW SERVER STATE, VIEW ANY DEFINITION). The statement check
 * refuses every word that starts another statement, because a T-SQL batch needs no semicolons.
 */

export interface MsRequest extends EventEmitter {
  addParameter(name: string, type: unknown, value: unknown): void;
  setTimeout(ms: number): void;
}

/** The parts of tedious the session uses (fakes in the unit tests). */
export interface MsLib {
  Request: new (sql: string, cb: (err: Error | null | undefined, rowCount?: number) => void) => MsRequest;
  TYPES: Record<string, unknown>;
}
export interface MsQueryable {
  beginTransaction(cb: (err: Error | null | undefined) => void): void;
  rollbackTransaction(cb: (err: Error | null | undefined) => void): void;
  execSql(request: MsRequest): void;
  cancel(): boolean;
}

/** The TDS type of a parameter value. */
export function msType(types: Record<string, unknown>, v: unknown): unknown {
  if (typeof v === 'boolean') return types.Bit;
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) <= 2_147_483_647 ? types.Int : Number.isSafeInteger(v) ? types.BigInt : types.Float;
  if (typeof v === 'bigint') return types.BigInt;
  if (v instanceof Date) return types.DateTimeOffset;
  return types.NVarChar;
}

/** Runs one statement. Exported for the unit tests. */
export async function mssqlRun(
  conn: MsQueryable,
  lib: MsLib,
  stmt: Statement,
  limits: RunLimits,
  signal: AbortSignal,
): Promise<{ result: DbQueryResult; cancelled: boolean }> {
  const t0 = Date.now();
  const rows = new RowCollector(limits);
  await new Promise<void>((resolve, reject) => conn.beginTransaction((e) => (e ? reject(e) : resolve())));
  let cancelled = false;
  let failure: unknown;
  try {
    await new Promise<void>((resolve, reject) => {
      let sets = 0;
      let stopped = false;
      const req = new lib.Request(stmt.sql, (err) => {
        signal.removeEventListener('abort', onAbort);
        // a cancel Steward asked for (a limit reached with truncate) ends the request with ECANCEL: that is no failure
        if (err && !(stopped && failure === undefined && (err as { code?: string }).code === 'ECANCEL')) reject(failure ?? err);
        else if (failure) reject(failure);
        else resolve();
      });
      const stop = (err?: unknown) => {
        if (stopped) return;
        stopped = true;
        cancelled = true;
        if (err !== undefined) failure = err;
        conn.cancel();
      };
      const onAbort = () => stop(abortError(signal));
      signal.addEventListener('abort', onAbort, { once: true });
      stmt.params.forEach((v, i) => req.addParameter(`p${i + 1}`, msType(lib.TYPES, v), v === undefined ? null : v));
      req.setTimeout(limits.timeoutMs);
      req.on('columnMetadata', (cols: { colName: string }[]) => {
        if (++sets > 1) return stop(new DbError('DB_MULTIPLE_RESULTS', 'The statement returned more than one result set', undefined, 422));
        rows.setColumns(cols.map((c) => c.colName));
      });
      req.on('row', (cols: { value: unknown }[]) => {
        if (stopped) return;
        try {
          if (!rows.add(cols.map((c) => c.value))) stop();
        } catch (e) {
          stop(e);
        }
      });
      conn.execSql(req);
    });
  } finally {
    // always rolled back: SQL Server has no read-only transaction
    await new Promise<void>((resolve) => conn.rollbackTransaction(() => resolve()));
  }
  return { result: rows.result(Date.now() - t0), cancelled };
}

export const sqlserverDriver: DbDriver = {
  async connect(t: ConnectTarget, signal: AbortSignal): Promise<DriverConnection> {
    // a dynamic import: bundled into the desktop executable, loaded only when a SQL Server platform is used
    const mod = await import('tedious');
    const tedious = ((mod as unknown as { default?: unknown }).default ?? mod) as typeof import('tedious');
    const serverName = t.tls.serverName || (net.isIP(t.host) ? undefined : t.host);
    const conn = new tedious.Connection({
      server: t.host,
      authentication: { type: 'default', options: { userName: t.user, password: t.password } },
      options: {
        port: t.port,
        database: t.database,
        encrypt: t.tls.mode !== 'off',
        trustServerCertificate: t.tls.mode === 'require',
        ...(t.tls.ca?.trim() ? { cryptoCredentialsDetails: { ca: t.tls.ca } } : {}),
        ...(serverName ? { serverName } : {}),
        connectTimeout: t.connectTimeoutMs,
        requestTimeout: 0, // per request (setTimeout)
        appName: 'steward',
        // the socket comes from Steward (outbound policy, pinned address); a routing redirect to another server is refused
        connector: (opts: { host: string; port: number }) =>
          new Promise<net.Socket>((resolve, reject) => {
            if (opts.host !== t.host || opts.port !== t.port)
              return reject(
                new DbError(
                  'DB_CONNECT_FAILED',
                  `The server sent the connection on to ${opts.host}:${opts.port} – Steward connects only to the platform's own host`,
                ),
              );
            const sock = t.socket();
            sock.once('connect', () => resolve(sock));
            sock.once('error', reject);
          }),
        rowCollectionOnRequestCompletion: false,
        useUTC: true,
      },
    } as never);
    let usable = true;
    conn.on('error', () => {
      usable = false;
    });
    conn.on('end', () => {
      usable = false;
    });
    const onAbort = () => conn.close();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => conn.connect((e) => (e ? reject(e) : resolve())));
    } catch (e) {
      usable = false;
      conn.close();
      throw mapDriverError('sqlserver', e, 'connect');
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    const lib: MsLib = { Request: tedious.Request as unknown as MsLib['Request'], TYPES: tedious.TYPES as unknown as Record<string, unknown> };
    let version = '';
    try {
      const r = await mssqlRun(
        conn as unknown as MsQueryable,
        lib,
        { sql: "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128))", params: [], trusted: true },
        { maxRows: 1, maxBytes: 4096, timeoutMs: 10_000, truncate: true },
        signal,
      );
      version = String(Object.values(r.result.rows[0] ?? {})[0] ?? '');
    } catch {
      /* the version is only shown */
    }
    const server: ServerInfo = { flavour: 'sqlserver', version };
    return {
      server,
      get usable() {
        return usable;
      },
      async run(stmt, limits, outer) {
        const d = deadline(limits.timeoutMs, outer);
        try {
          const r = await mssqlRun(conn as unknown as MsQueryable, lib, stmt, limits, d.signal);
          return r.result;
        } catch (e) {
          if (d.signal.aborted) throw abortError(d.signal);
          if (e instanceof DbError) throw e;
          const code = (e as { code?: string }).code;
          if (code === 'ETIMEOUT')
            throw new DbError('DB_TIMEOUT', `The statement ran longer than ${Math.round(limits.timeoutMs / 1000)} s (the limit)`, undefined, 504);
          if (code !== 'EREQUEST') usable = false;
          throw mapDriverError('sqlserver', e, 'query');
        } finally {
          d.done();
        }
      },
      async close() {
        usable = false;
        conn.close();
      },
    };
  },
};
