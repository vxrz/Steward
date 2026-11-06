import type { EventEmitter } from 'node:events';
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
 * MariaDB and MySQL (ADR 0008): the session is SET SESSION TRANSACTION READ ONLY; every statement runs in
 * START TRANSACTION READ ONLY with the session's time limit (MAX_EXECUTION_TIME on MySQL, max_statement_time on
 * MariaDB), as a server-side prepared statement (one statement; multipleStatements stays off), then ROLLBACK. Rows are
 * read as they arrive; a limit reached closes the connection (the server rolls back), it is not reused. When the
 * client-side time limit or a cancel stops a statement, Steward first sends KILL QUERY over a second, short-lived
 * connection (the same account and socket factory) – closing the socket alone would leave the server running it.
 */

/** The part of a mysql2 connection the session uses (a fake one in the unit tests). */
export interface MyQueryable {
  query(sql: string, cb: (err: Error | null) => void): unknown;
  execute(opts: { sql: string; values?: unknown[]; rowsAsArray: true }): EventEmitter;
  /** query() without values as an emitter (catalog statements such as SHOW REPLICA STATUS cannot always be prepared) */
  query(opts: { sql: string; rowsAsArray: true }): EventEmitter;
  destroy(): void;
}

const exec = (c: MyQueryable, sql: string) => new Promise<void>((resolve, reject) => void c.query(sql, (err) => (err ? reject(err) : resolve())));

/** How long Steward waits for KILL QUERY (the second connection included) before it closes the socket anyway. */
export const KILL_TIMEOUT_MS = 5000;

/** The part of the second connection KILL QUERY uses (a fake one in the unit tests). */
export interface MyKillConnection {
  query(sql: string, cb: (err: Error | null) => void): unknown;
  end(cb: () => void): void;
  destroy(): void;
}

/**
 * Stops the statement of connection `threadId` on the server: KILL QUERY over a connection `open` makes, closed
 * afterwards. Best effort within KILL_TIMEOUT_MS; never throws. Exported for the unit tests.
 */
export async function killQuery(open: () => Promise<MyKillConnection>, threadId: number | undefined, timeoutMs = KILL_TIMEOUT_MS): Promise<boolean> {
  if (!Number.isSafeInteger(threadId) || (threadId as number) <= 0) return false;
  let conn: MyKillConnection | undefined;
  let timer: NodeJS.Timeout | undefined;
  const work = (async () => {
    conn = await open();
    // KILL QUERY ends the statement, not the connection; a thread id is a number Steward read from the server
    await exec(conn as unknown as MyQueryable, `KILL QUERY ${Number(threadId)}`);
    return true;
  })();
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, late]);
  } catch {
    return false; // the server may have ended the statement already (or refuses the second connection): the socket closes either way
  } finally {
    clearTimeout(timer);
    work.catch(() => undefined); // a late failure of the abandoned attempt changes nothing
    const c = conn;
    if (c)
      await new Promise<void>((resolve) => {
        try {
          c.end(() => resolve());
        } catch {
          c.destroy();
          resolve();
        }
        setTimeout(() => {
          c.destroy();
          resolve();
        }, 1000).unref?.();
      });
  }
}

/** The session time limit: MySQL counts milliseconds (SELECT only), MariaDB seconds (every statement). */
export function timeLimitStatement(server: ServerInfo, timeoutMs: number): string {
  const ms = Math.max(1, Math.floor(timeoutMs));
  return server.flavour === 'mariadb' ? `SET SESSION max_statement_time = ${Math.ceil(ms / 1000)}` : `SET SESSION MAX_EXECUTION_TIME = ${ms}`;
}

/**
 * Runs one statement. `onStop` is called when the driver has to stop reading (a limit, a cancel): the connection is
 * destroyed then. Exported for the unit tests.
 */
export async function mysqlRun(
  conn: MyQueryable,
  server: ServerInfo,
  stmt: Statement,
  limits: RunLimits,
  signal: AbortSignal,
  /** Stops the running statement on the server (KILL QUERY) before the connection is closed on a timeout or cancel */
  kill: () => Promise<unknown> = async () => undefined,
): Promise<{ result: DbQueryResult; destroyed: boolean }> {
  const t0 = Date.now();
  const rows = new RowCollector(limits);
  await exec(conn, timeLimitStatement(server, limits.timeoutMs));
  await exec(conn, 'START TRANSACTION READ ONLY');
  let destroyed = false;
  try {
    await new Promise<void>((resolve, reject) => {
      // catalog statements without parameters go as text (SHOW … is not preparable on every version); everything else prepared
      const cmd =
        stmt.trusted && !stmt.params.length
          ? conn.query({ sql: stmt.sql, rowsAsArray: true })
          : conn.execute({ sql: stmt.sql, values: stmt.params, rowsAsArray: true });
      let settled = false;
      /** Stopped by the time limit or a cancel: what the statement still sends is ignored until KILL QUERY is done */
      let aborting = false;
      let sets = 0;
      const stop = (err?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (!destroyed && err !== undefined) {
          destroyed = true;
          conn.destroy();
        }
        if (err) reject(err);
        else resolve();
      };
      // the time limit or a cancel: the server stops the statement first, then the connection goes
      const onAbort = () => {
        if (settled || aborting) return;
        aborting = true;
        void kill()
          .catch(() => undefined) // killQuery never throws; a fake or a later change might – the socket closes anyway
          .then(() => stop(abortError(signal)));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      cmd.on('fields', (fields: { name: string }[] | undefined) => {
        if (!fields || aborting) return;
        if (++sets > 1) return stop(new DbError('DB_MULTIPLE_RESULTS', 'The statement returned more than one result set', undefined, 422));
        rows.setColumns(fields.map((f) => f.name));
      });
      cmd.on('result', (row: unknown) => {
        if (settled || aborting) return;
        if (!Array.isArray(row)) return; // an OK packet (no rows)
        try {
          if (!rows.add(row)) {
            destroyed = true;
            conn.destroy(); // stop reading: the server rolls back with the connection
            stop();
          }
        } catch (e) {
          stop(e);
        }
      });
      cmd.on('error', (e: unknown) => {
        // aborting: the error is KILL QUERY's own ("execution was interrupted") – the abort answers instead
        if (!settled && !aborting) {
          settled = true;
          signal.removeEventListener('abort', onAbort);
          reject(e);
        }
      });
      cmd.on('end', () => {
        if (!aborting) stop();
      });
    });
  } finally {
    if (!destroyed) await exec(conn, 'ROLLBACK').catch(() => undefined); // a broken connection is destroyed by the caller
  }
  return { result: rows.result(Date.now() - t0), destroyed };
}

export function mysqlSsl(t: ConnectTarget): undefined | Record<string, unknown> {
  if (t.tls.mode === 'off') return undefined;
  // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification -- the opt-in TLS mode "require" (encrypted, any certificate, like libpq sslmode=require); the default is "verify", the UI warns, and changing it is audited (docs/DATABASES.md)
  if (t.tls.mode === 'require') return { rejectUnauthorized: false };
  return { rejectUnauthorized: true, verifyIdentity: true, ...(t.tls.ca?.trim() ? { ca: t.tls.ca } : {}) };
}

export const mysqlDriver: DbDriver = {
  async connect(t: ConnectTarget, signal: AbortSignal): Promise<DriverConnection> {
    // a dynamic import: bundled into the desktop executable, loaded only when a MariaDB/MySQL platform is used
    const mod = await import('mysql2');
    const mysql = ((mod as unknown as { default?: unknown }).default ?? mod) as typeof import('mysql2');
    // TLS checks the server name against `host`: the name (or the configured server name), never the pinned address
    const name = t.tls.serverName || t.host;
    const options = {
      host: name,
      port: t.port,
      user: t.user,
      password: t.password,
      database: t.database,
      ssl: mysqlSsl(t) as never,
      stream: () => t.socket(),
      connectTimeout: t.connectTimeoutMs,
      multipleStatements: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      timezone: 'Z',
      maxPreparedStatements: 64,
      connectAttributes: { program_name: 'steward' },
    };
    const conn = mysql.createConnection(options as never) as unknown as MyQueryable &
      EventEmitter & { connect(cb: (e: Error | null) => void): void; end(cb: () => void): void };
    let usable = true;
    conn.on('error', () => {
      usable = false; // the socket broke between statements: the pool drops the connection
    });
    const onAbort = () => {
      usable = false;
      conn.destroy();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => conn.connect((e) => (e ? reject(e) : resolve())));
      // the server's own default collation for utf8mb4 (MariaDB 11.4: utf8mb4_uca1400_ai_ci, MySQL 8: utf8mb4_0900_ai_ci):
      // the driver's default (utf8mb4_unicode_ci) makes literals clash with strings the server builds, e.g. JSON_VALUE
      await exec(conn, 'SET NAMES utf8mb4');
      await exec(conn, 'SET SESSION TRANSACTION READ ONLY');
    } catch (e) {
      usable = false;
      conn.destroy();
      throw mapDriverError('mysql', e, 'connect', [t.password]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    let version = '';
    try {
      version = await new Promise<string>((resolve, reject) =>
        (conn as unknown as { query(s: string, cb: (e: Error | null, r?: { v?: string }[]) => void): void }).query('SELECT VERSION() AS v', (e, r) =>
          e ? reject(e) : resolve(String(r?.[0]?.v ?? '')),
        ),
      );
    } catch {
      /* the version tells MariaDB from MySQL; without it MySQL is assumed */
    }
    const server: ServerInfo = { flavour: /mariadb/i.test(version) ? 'mariadb' : 'mysql', version };
    // KILL QUERY over a second connection: the same account, TLS and socket factory (the guarded lookup applies)
    const threadId = (conn as unknown as { threadId?: number }).threadId;
    const kill = () =>
      killQuery(async () => {
        const k = mysql.createConnection({
          ...options,
          connectTimeout: Math.min(t.connectTimeoutMs, KILL_TIMEOUT_MS),
        } as never) as unknown as MyKillConnection & {
          connect(cb: (e: Error | null) => void): void;
          on(ev: 'error', fn: () => void): void;
        };
        k.on('error', () => undefined); // a broken second connection only means the kill did not happen
        await new Promise<void>((resolve, reject) => k.connect((e) => (e ? reject(e) : resolve())));
        return k;
      }, threadId);
    return {
      server,
      get usable() {
        return usable;
      },
      async run(stmt: Statement, limits: RunLimits, outer: AbortSignal) {
        const d = deadline(limits.timeoutMs, outer);
        try {
          const r = await mysqlRun(conn, server, stmt, limits, d.signal, kill);
          if (r.destroyed) usable = false;
          return r.result;
        } catch (e) {
          if (d.signal.aborted) {
            usable = false;
            throw abortError(d.signal);
          }
          if (e instanceof DbError) {
            if (e.code === 'DB_ROW_LIMIT' || e.code === 'DB_SIZE_LIMIT' || e.code === 'DB_MULTIPLE_RESULTS') usable = false;
            throw e;
          }
          if (!(e as { errno?: number }).errno) usable = false; // not an answer of the server: the protocol state is unknown
          throw mapDriverError('mysql', e, 'query', [t.password]);
        } finally {
          d.done();
        }
      },
      async close() {
        usable = false;
        await new Promise<void>((resolve) => {
          try {
            conn.end(() => resolve());
          } catch {
            conn.destroy();
            resolve();
          }
        });
      },
    };
  },
};
