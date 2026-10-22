/**
 * Synchronous PostgreSQL client: a worker thread owns one `pg.Client`; the calling
 * thread posts a request and blocks with `Atomics.wait` until the worker signals the
 * reply, then reads it with `receiveMessageOnPort` (the pattern of the `synckit` library).
 *
 * The app's database API is synchronous (like node:sqlite) and the app is one process,
 * so all statements run one after another on one connection – the same model as SQLite.
 * This keeps every call site unchanged. The cost is a thread hop per statement (see
 * docs/INSTALL.md "Database") and that a slow database blocks the event loop.
 */
import { createRequire } from 'node:module';
import { BRAND } from '@sm/shared';
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads';

export interface PgBridgeOptions {
  url: string;
  schema: string;
  /** Take a session advisory lock for this schema (single app instance). */
  lock: boolean;
  /** Longest wait for one statement (ms). */
  timeoutMs: number;
  /** Server-side statement_timeout (ms, 0 = off). Default: a bit below timeoutMs, so the server cancels first. */
  statementTimeoutMs?: number;
  /** How long to retry the advisory lock at start-up (ms) – a just-killed instance's session may still linger. */
  lockWaitMs?: number;
  connectTimeoutMs?: number;
}

export interface PgResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

type Op = 'connect' | 'query' | 'exec' | 'begin' | 'commit' | 'rollback' | 'close';
interface Reply {
  id: number;
  ok: boolean;
  rows?: Record<string, unknown>[];
  rowCount?: number | null;
  error?: Record<string, unknown> & { message: string };
}

/** Advisory lock namespace ("SM"); the second key is hashtext(<schema>). */
export const LOCK_CLASS = 0x534d;

// Plain CommonJS, evaluated in the worker (no TypeScript loader needed there).
const WORKER_SOURCE = String.raw`
const { workerData } = require('node:worker_threads');
const { port, state, pgPath, url, schema, lock, statementTimeoutMs, lockWaitMs, connectTimeoutMs, lockClass, appName, productName } = workerData;
const pg = require(pgPath);
// BIGINT (COUNT(*), identity columns) and NUMERIC as JS numbers, like node:sqlite
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

let client = null;
let inTx = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qi = (s) => '"' + s.replace(/"/g, '""') + '"';

async function connect() {
  const c = new pg.Client({ connectionString: url, application_name: appName, keepAlive: true, connectionTimeoutMillis: connectTimeoutMs });
  const lost = () => { if (client === c) client = null; };
  c.on('error', lost);
  c.on('end', lost);
  await c.connect();
  try {
    if (schema !== 'public') {
      const has = await c.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
      if (!has.rowCount) await c.query('CREATE SCHEMA IF NOT EXISTS ' + qi(schema));
    }
    await c.query('SET search_path TO ' + qi(schema));
    if (statementTimeoutMs > 0) await c.query('SET statement_timeout = ' + Math.floor(statementTimeoutMs));
    if (lock) {
      const deadline = Date.now() + lockWaitMs;
      for (;;) {
        const r = await c.query('SELECT pg_try_advisory_lock($1::int, hashtext($2)) AS ok', [lockClass, schema]);
        if (r.rows[0].ok) break;
        if (Date.now() >= deadline) {
          const h = await c.query(
            "SELECT a.pid, a.application_name, a.client_addr::text AS addr, a.backend_start::text AS since FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory' AND l.classid = $1 AND l.objid = hashtext($2)::oid AND l.granted LIMIT 1",
            [lockClass, schema],
          ).catch(() => ({ rows: [] }));
          const who = h.rows[0] ? ' (database session pid ' + h.rows[0].pid + (h.rows[0].addr ? ' from ' + h.rows[0].addr : '') + ', since ' + h.rows[0].since + ')' : '';
          const e = new Error('Another ' + productName + ' instance is already using this database schema "' + schema + '"' + who + '. Only one instance per database schema is supported – stop the other one (or end its session with pg_terminate_backend) or use another SM_DATABASE_SCHEMA.');
          e.code = 'SM_LOCKED';
          throw e;
        }
        await sleep(250);
      }
    }
  } catch (e) {
    c.end().catch(() => undefined);
    throw e;
  }
  client = c;
}

async function ensure() {
  if (client) return client;
  if (inTx) {
    const e = new Error('The database connection was lost inside a transaction; the transaction was rolled back');
    e.code = '08006';
    throw e;
  }
  await connect();
  return client;
}

function errorOf(e) {
  const out = { message: (e && e.message) || String(e) };
  for (const k of ['code', 'detail', 'hint', 'constraint', 'table', 'column', 'schema', 'severity', 'position', 'where', 'routine']) {
    if (e && e[k] !== undefined) out[k] = e[k];
  }
  return out;
}

const toPg = (v) => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v);

async function handle(req) {
  switch (req.op) {
    case 'connect':
      await ensure();
      return {};
    case 'query': {
      const c = await ensure();
      const r = await c.query({ text: req.sql, values: (req.params || []).map(toPg) });
      return { rows: r.rows, rowCount: r.rowCount };
    }
    case 'exec': {
      const c = await ensure();
      await c.query(req.sql);
      return {};
    }
    case 'begin': {
      const c = await ensure();
      await c.query(req.sql || 'BEGIN');
      inTx = true;
      return {};
    }
    case 'commit':
    case 'rollback': {
      const wasTx = inTx;
      inTx = false;
      if (!client) {
        if (req.op === 'commit' && wasTx) throw Object.assign(new Error('The database connection was lost inside a transaction; nothing was committed'), { code: '08006' });
        return {};
      }
      await client.query(req.op === 'commit' ? 'COMMIT' : 'ROLLBACK');
      return {};
    }
    case 'close':
      if (client) await client.end().catch(() => undefined);
      client = null;
      return {};
    default:
      throw new Error('unknown op ' + req.op);
  }
}

port.on('message', async (req) => {
  let reply;
  try {
    reply = Object.assign({ id: req.id, ok: true }, await handle(req));
  } catch (e) {
    reply = { id: req.id, ok: false, error: errorOf(e) };
  }
  try {
    port.postMessage(reply);
  } catch (e) {
    port.postMessage({ id: req.id, ok: false, error: { message: 'Could not return the database result: ' + ((e && e.message) || e) } });
  }
  Atomics.add(state, 0, 1);
  Atomics.notify(state, 0);
});
`;

export class PgError extends Error {
  declare code?: string;
  declare detail?: string;
  declare constraint?: string;
  constructor(info: Record<string, unknown> & { message: string }, sql?: string) {
    super(info.message);
    this.name = 'PgError';
    Object.assign(this, info);
    if (sql !== undefined) Object.defineProperty(this, 'sql', { value: sql, enumerable: false });
  }
}

let pgPathCache: string | undefined;
function resolvePg(): string {
  if (!pgPathCache) pgPathCache = createRequire(import.meta.url).resolve('pg');
  return pgPathCache;
}

export class PgBridge {
  private worker!: Worker;
  private port!: MessagePort;
  private state!: Int32Array;
  private seq = 0;
  private connected = false;
  /** A call timed out inside a transaction: refuse statements until the transaction is ended. */
  private poisoned = false;
  private inTx = false;
  private closed = false;
  readonly opts: Required<PgBridgeOptions>;

  constructor(opts: PgBridgeOptions) {
    this.opts = {
      statementTimeoutMs: Math.max(Math.floor(opts.timeoutMs * 0.8), opts.timeoutMs - 5000),
      lockWaitMs: 10000,
      connectTimeoutMs: 10000,
      ...opts,
    };
    this.spawn();
    this.connect();
  }

  private spawn(): void {
    const { port1, port2 } = new MessageChannel();
    this.state = new Int32Array(new SharedArrayBuffer(4));
    this.port = port1;
    const o = this.opts;
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      execArgv: [],
      workerData: {
        port: port2,
        state: this.state,
        pgPath: resolvePg(),
        url: o.url,
        schema: o.schema,
        lock: o.lock,
        statementTimeoutMs: o.statementTimeoutMs,
        lockWaitMs: o.lockWaitMs,
        connectTimeoutMs: o.connectTimeoutMs,
        lockClass: LOCK_CLASS,
        appName: BRAND.slug,
        productName: BRAND.name,
      },
      transferList: [port2],
    });
    this.worker.unref();
    this.worker.on('error', () => undefined);
    port1.unref();
    this.connected = false;
  }

  private connect(): void {
    this.callRaw({ op: 'connect' }, this.opts.connectTimeoutMs + (this.opts.lock ? this.opts.lockWaitMs : 0) + 10000);
    this.connected = true;
  }

  /** Throws the database error (with `code`, `detail`, …) or a timeout error. */
  private callRaw(req: { op: Op; sql?: string; params?: unknown[] }, timeoutMs: number): Reply {
    const id = ++this.seq;
    this.port.postMessage({ id, ...req });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = Atomics.load(this.state, 0);
      const m = receiveMessageOnPort(this.port);
      if (m) {
        const reply = m.message as Reply;
        if (reply.id !== id) continue; // late reply of a call that timed out
        if (!reply.ok) throw new PgError(reply.error!, req.sql);
        return reply;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        // The connection is in an unknown state: drop it (the server rolls back and releases the lock).
        void this.worker.terminate();
        this.spawn();
        if (this.inTx) this.poisoned = true;
        throw Object.assign(new Error(`The database did not answer within ${Math.round(timeoutMs / 1000)} s (${req.op}${req.sql ? ': ' + req.sql.slice(0, 120) : ''})`), {
          code: 'SM_DB_TIMEOUT',
        });
      }
      Atomics.wait(this.state, 0, v, left);
    }
  }

  private call(req: { op: Op; sql?: string; params?: unknown[] }): Reply {
    if (this.closed) throw new Error('The database connection is closed');
    const ending = req.op === 'commit' || req.op === 'rollback';
    if (this.poisoned && !ending) throw Object.assign(new Error('The current database transaction was aborted after a timeout'), { code: 'SM_DB_TIMEOUT' });
    if (this.poisoned && ending) {
      this.poisoned = false;
      this.inTx = false;
      if (req.op === 'commit') throw Object.assign(new Error('The database transaction was aborted after a timeout; nothing was committed'), { code: 'SM_DB_TIMEOUT' });
      return { id: 0, ok: true };
    }
    if (!this.connected) this.connect();
    if (req.op === 'begin') this.inTx = true;
    if (ending) this.inTx = false;
    return this.callRaw(req, this.opts.timeoutMs);
  }

  query(sql: string, params: unknown[]): PgResult {
    const r = this.call({ op: 'query', sql, params });
    return { rows: r.rows ?? [], rowCount: r.rowCount ?? 0 };
  }
  exec(sql: string): void {
    this.call({ op: 'exec', sql });
  }
  begin(sql = 'BEGIN'): void {
    try {
      this.call({ op: 'begin', sql });
    } catch (e) {
      this.inTx = false;
      throw e;
    }
  }
  commit(): void {
    this.call({ op: 'commit' });
  }
  rollback(): void {
    this.call({ op: 'rollback' });
  }
  close(): void {
    if (this.closed) return;
    try {
      this.callRaw({ op: 'close' }, 5000);
    } catch {
      /* closing anyway */
    }
    this.closed = true;
    void this.worker.terminate();
  }
}
