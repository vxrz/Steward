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
 * PostgreSQL (ADR 0008): the session starts with default_transaction_read_only=on; every statement runs in
 * BEGIN TRANSACTION READ ONLY with a local statement_timeout, through a cursor (DECLARE … NO SCROLL CURSOR FOR, which
 * PostgreSQL accepts for queries only and refuses for data-modifying WITH), in the extended protocol (one statement per
 * message, enforced by the server), read in batches within the limits, and always rolled back. Before the connection
 * goes back to the pool, session-level advisory locks (which survive ROLLBACK) are released – a permitted statement
 * should not be able to take one, but the pool does not rely on that.
 */

/** The part of a pg client the session uses (a fake one in the unit tests). */
export interface PgQueryable {
  query(config: { text: string; values?: unknown[]; queryMode: 'extended'; rowMode?: 'array' }): Promise<{ rows: unknown[][]; fields: { name: string }[] }>;
}

const FETCH = 500;
const CURSOR = 'steward_q';
/** Steward's own statement after every ROLLBACK: what a session keeps beyond the transaction (advisory locks) goes */
export const PG_SESSION_RESET = 'SELECT pg_advisory_unlock_all()';

/**
 * Runs one statement on a connected client. `unclean` is called when the session could not be reset (the connection
 * must not be reused then). Exported for the unit tests.
 */
export async function pgRun(
  client: PgQueryable,
  stmt: Statement,
  limits: RunLimits,
  signal: AbortSignal,
  unclean: () => void = () => undefined,
): Promise<DbQueryResult> {
  const t0 = Date.now();
  const q = (text: string, values: unknown[] = []) => client.query({ text, values, queryMode: 'extended', rowMode: 'array' });
  const rows = new RowCollector(limits);
  await q('BEGIN TRANSACTION READ ONLY');
  try {
    await q("SELECT set_config('statement_timeout', $1, true)", [String(limits.timeoutMs)]);
    await q(`DECLARE ${CURSOR} NO SCROLL CURSOR FOR ${stmt.sql}`, stmt.params);
    let first = true;
    for (;;) {
      if (signal.aborted) throw abortError(signal);
      const r = await q(`FETCH ${FETCH} FROM ${CURSOR}`);
      if (first) rows.setColumns(r.fields.map((f) => f.name));
      first = false;
      let more = true;
      for (const v of r.rows) if (!(more = rows.add(v))) break;
      if (!more || r.rows.length < FETCH) break;
    }
  } finally {
    // a transaction that failed is aborted already; ROLLBACK ends it either way
    await q('ROLLBACK').catch(() => undefined); // the connection is broken then: the caller destroys it
    await q(PG_SESSION_RESET).catch(() => unclean()); // a session that may still hold a lock is not pooled again
  }
  return rows.result(Date.now() - t0);
}

/** TLS options of the pg client. */
export function pgSsl(t: ConnectTarget): false | Record<string, unknown> {
  if (t.tls.mode === 'off') return false;
  if (t.tls.mode === 'require') return { rejectUnauthorized: false };
  const name = t.tls.serverName || (net.isIP(t.host) ? undefined : t.host);
  return { rejectUnauthorized: true, ...(t.tls.ca?.trim() ? { ca: t.tls.ca } : {}), ...(name ? { servername: name } : {}) };
}

export const postgresDriver: DbDriver = {
  async connect(t: ConnectTarget, signal: AbortSignal): Promise<DriverConnection> {
    // a dynamic import: bundled into the desktop executable, loaded only when a PostgreSQL platform is used
    const mod = await import('pg');
    const pg = ((mod as unknown as { default?: unknown }).default ?? mod) as typeof import('pg');
    const client = new pg.Client({
      host: t.host,
      port: t.port,
      database: t.database,
      user: t.user,
      password: t.password,
      ssl: pgSsl(t) as never,
      // pg calls connect() on the stream itself: the socket is opened (through the guarded lookup) by Steward already
      stream: () => {
        const s = t.socket();
        (s as unknown as { connect: () => net.Socket }).connect = () => s;
        return s;
      },
      connectionTimeoutMillis: t.connectTimeoutMs,
      application_name: 'steward',
      // every transaction of the session is read-only unless it says otherwise – and Steward never says otherwise
      options: '-c default_transaction_read_only=on',
    } as never);
    let usable = true;
    client.on('error', () => {
      usable = false; // the socket broke between statements: the pool drops the connection
    });
    const destroy = () => {
      usable = false;
      (client as unknown as { connection?: { stream?: net.Socket } }).connection?.stream?.destroy();
    };
    const onAbort = () => destroy();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await client.connect();
    } catch (e) {
      destroy();
      throw mapDriverError('postgresql', e, 'connect', [t.password]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    let server: ServerInfo = { flavour: 'postgresql', version: '' };
    try {
      const v = await (client as unknown as PgQueryable).query({ text: 'SHOW server_version', queryMode: 'extended', rowMode: 'array' });
      server = { flavour: 'postgresql', version: String(v.rows[0]?.[0] ?? '') };
    } catch {
      /* the version is only shown: a server that does not say it still works */
    }
    return {
      server,
      get usable() {
        return usable;
      },
      async run(stmt, limits, outer) {
        const d = deadline(limits.timeoutMs, outer);
        const kill = () => destroy();
        d.signal.addEventListener('abort', kill, { once: true });
        try {
          return await pgRun(client as unknown as PgQueryable, stmt, limits, d.signal, () => {
            usable = false;
          });
        } catch (e) {
          if (d.signal.aborted) throw abortError(d.signal);
          if (e instanceof DbError) throw e;
          const err = mapDriverError('postgresql', e, 'query', [t.password]);
          // an error inside the transaction leaves the connection usable (ROLLBACK ran); a protocol error does not
          if (!(e as { code?: string }).code || String((e as { code?: string }).code).length !== 5) usable = false;
          throw err;
        } finally {
          d.signal.removeEventListener('abort', kill);
          d.done();
        }
      },
      async close() {
        usable = false;
        await client.end().catch(() => undefined); // closing is best effort: the socket goes away with it
      },
    };
  },
};
