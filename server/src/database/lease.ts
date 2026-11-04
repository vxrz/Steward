/**
 * Single-instance lease on PostgreSQL: one row in `sm_instance_lease` (in the app's schema) names the instance that
 * may use the schema, until `expires_at`. The holder renews it every RENEW (10 s) for TTL (45 s); a stopped instance
 * deletes it; a crashed one simply stops renewing, so the lease frees itself after at most 45 s – no
 * `pg_terminate_backend` by hand. A second instance waits (it does not exit, so Kubernetes does not restart it in a
 * loop), answers /api/ready with 503 meanwhile (main.ts) and takes over when the lease has expired.
 *
 * The lease is kept by a worker thread with its own connection: the app's database calls block the main thread
 * (database/pg-bridge.ts), and a renewal must not wait behind a slow statement or a long synchronous step.
 *
 * The session advisory lock of earlier versions is still taken – on the lease connection, once the lease is held –
 * so an instance of an older version (which only knows the advisory lock) and this one never run side by side.
 * It no longer decides: if the advisory lock is held by the expired holder's lingering session (a crashed VM whose
 * connection the database has not noticed yet), that session is ended with pg_terminate_backend when the database
 * user may, and the takeover goes ahead either way. Held by any other session (an older Steward, or a command-line
 * tool such as db:copy), the new instance gives the lease back and keeps waiting.
 *
 * A holder on the same machine whose process has gone and whose lease session has ended (a restart after kill -9)
 * is taken over at once, without waiting for the expiry.
 *
 * The table is created here, not by a migration: a waiting instance must not migrate a schema another one uses.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { BRAND } from '@sm/shared';
import { LOCK_CLASS } from './pg-bridge.js';

export const LEASE_TABLE = 'sm_instance_lease';

export interface LeaseHolder {
  holder: string;
  host: string | null;
  pid: number | null;
  version: string | null;
  acquiredAt: string | null;
  renewedAt: string | null;
  expiresAt: string | null;
}

export type LeaseWait =
  | { reason: 'held'; current: LeaseHolder }
  /** the advisory lock is held by a session that is not the lease's (an older version, or db:copy) */
  | { reason: 'advisoryLock'; session: { pid: number; addr: string | null; application: string | null; since: string | null } }
  | { reason: 'error'; message: string };

export interface LeaseAcquired {
  /** the instance whose expired lease was taken over (null: there was none, or it had stopped cleanly) */
  takeover: LeaseHolder | null;
  /** the expired holder's lingering session was ended (pg_terminate_backend), or could not be (null: nothing lingered) */
  terminated: { pid: number; ok: boolean; error?: string } | null;
}

export interface LeaseOptions {
  url: string;
  schema: string;
  version: string;
  ttlMs?: number;
  renewMs?: number;
  /** Retry while waiting (ms). */
  retryMs?: number;
  connectTimeoutMs?: number;
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { pgPath, url, schema, table, ttlMs, renewMs, retryMs, connectTimeoutMs, lockClass, appName, me } = workerData;
const pg = require(pgPath);
const qi = (s) => '"' + s.replace(/"/g, '""') + '"';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let client = null;
let held = false;
let stopping = false;
let lastRenewOk = 0;
let renewTimer = null;
let soon = false;

async function conn() {
  if (client) return client;
  const c = new pg.Client({ connectionString: url, application_name: appName, keepAlive: true, connectionTimeoutMillis: connectTimeoutMs });
  const lost = () => { if (client === c) client = null; };
  c.on('error', lost);
  c.on('end', lost);
  await c.connect();
  try {
    if (schema !== 'public') {
      const has = await c.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
      if (!has.rowCount) await c.query('CREATE SCHEMA IF NOT EXISTS ' + qi(schema)).catch((e) => { if (e.code !== '23505' && e.code !== '42P06') throw e; });
    }
    await c.query('SET search_path TO ' + qi(schema));
    await c.query('SET statement_timeout = 5000');
    await c.query('CREATE TABLE IF NOT EXISTS ' + qi(table) + ' (name TEXT PRIMARY KEY, holder TEXT NOT NULL, host TEXT, pid INTEGER, version TEXT, backend_pid INTEGER, acquired_at TIMESTAMPTZ NOT NULL, renewed_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL)')
      .catch((e) => { if (e.code !== '23505' && e.code !== '42P07') throw e; });
    // a reconnect while holding the lease: the advisory lock went with the old session
    if (held) await c.query('SELECT pg_try_advisory_lock($1::int, hashtext($2))', [lockClass, schema]).catch(() => undefined);
  } catch (e) {
    c.end().catch(() => undefined);
    throw e;
  }
  client = c;
  return c;
}

const iso = (v) => (v == null ? null : new Date(v).toISOString());
const holderOf = (r) => ({ holder: r.holder, host: r.host, pid: r.pid, version: r.version, acquiredAt: iso(r.acquired_at), renewedAt: iso(r.renewed_at), expiresAt: iso(r.expires_at) });

async function lockSession(c) {
  const r = await c.query(
    "SELECT a.pid, a.application_name AS app, a.client_addr::text AS addr, a.backend_start::text AS since FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory' AND l.classid = $1 AND l.objid = hashtext($2)::oid AND l.granted AND a.pid <> pg_backend_pid() LIMIT 1",
    [lockClass, schema],
  ).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

/**
 * A holder on this machine whose process is gone and whose lease session has ended is dead for sure (a restart after
 * a crash or kill -9): no need to wait for its lease to expire. On another machine only the expiry tells.
 */
async function holderGone(c, prev) {
  if (!prev.host || prev.host !== me.host || prev.pid == null) return false;
  let alive = true;
  if (Number(prev.pid) === process.pid) alive = false; // a container restart: this process has its number now
  else {
    try {
      process.kill(Number(prev.pid), 0);
    } catch (e) {
      alive = e && e.code === 'EPERM';
    }
  }
  if (alive) return false;
  if (prev.backend_pid == null) return true;
  const r = await c.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [prev.backend_pid]);
  // the process is gone, its session not yet (the database notices within moments): ask again soon
  if (r.rowCount) soon = true;
  return !r.rowCount;
}

/** One attempt: {acquired} or {wait}. */
async function tryAcquire() {
  const c = await conn();
  const ttl = Math.round(ttlMs / 1000) + ' seconds';
  let prev = null;
  await c.query('BEGIN');
  try {
    const r = await c.query('SELECT *, expires_at < now() AS expired FROM ' + qi(table) + " WHERE name = 'instance' FOR UPDATE");
    prev = r.rows[0] || null;
    if (prev && prev.holder !== me.holder && !prev.expired && (await holderGone(c, prev))) prev.expired = true;
    if (prev && prev.holder !== me.holder && !prev.expired) {
      await c.query('ROLLBACK');
      return { wait: { reason: 'held', current: holderOf(prev) } };
    }
    await c.query(
      'INSERT INTO ' + qi(table) + " (name, holder, host, pid, version, backend_pid, acquired_at, renewed_at, expires_at) VALUES ('instance', $1, $2, $3, $4, pg_backend_pid(), now(), now(), now() + $5::interval) " +
        'ON CONFLICT (name) DO UPDATE SET holder = EXCLUDED.holder, host = EXCLUDED.host, pid = EXCLUDED.pid, version = EXCLUDED.version, backend_pid = EXCLUDED.backend_pid, acquired_at = EXCLUDED.acquired_at, renewed_at = EXCLUDED.renewed_at, expires_at = EXCLUDED.expires_at',
      [me.holder, me.host, me.pid, me.version, ttl],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    // two instances inserting the first row at the same moment: the other one won
    if (e.code === '23505' || e.code === '40001') return { wait: { reason: 'error', message: 'another instance took the lease at the same moment' } };
    throw e;
  }
  // the advisory lock of earlier versions (see lease.ts)
  let terminated = null;
  for (let i = 0; i < 20; i++) {
    const l = await c.query('SELECT pg_try_advisory_lock($1::int, hashtext($2)) AS ok', [lockClass, schema]);
    if (l.rows[0].ok) break;
    const s = await lockSession(c);
    if (!s) { await sleep(100); continue; }
    if (prev && prev.holder !== me.holder && prev.backend_pid != null && Number(s.pid) === Number(prev.backend_pid)) {
      // the crashed holder's lingering session
      if (!terminated) {
        try {
          const t = await c.query('SELECT pg_terminate_backend($1) AS ok', [s.pid]);
          terminated = { pid: Number(s.pid), ok: !!t.rows[0].ok };
        } catch (e) {
          terminated = { pid: Number(s.pid), ok: false, error: (e && e.message) || String(e) };
        }
      }
      if (!terminated.ok) break; // the lease decides
      await sleep(100);
      continue;
    }
    // somebody else: give the lease back and wait
    await c.query('DELETE FROM ' + qi(table) + " WHERE name = 'instance' AND holder = $1", [me.holder]).catch(() => undefined);
    return { wait: { reason: 'advisoryLock', session: { pid: Number(s.pid), addr: s.addr || null, application: s.app || null, since: s.since || null } } };
  }
  held = true;
  lastRenewOk = Date.now();
  startRenewing();
  const takeover = prev && prev.holder !== me.holder ? holderOf(prev) : null;
  return { acquired: { takeover, terminated } };
}

async function renew() {
  if (!held || stopping) return;
  try {
    const c = await conn();
    const r = await c.query(
      'UPDATE ' + qi(table) + " SET renewed_at = now(), expires_at = now() + $2::interval, backend_pid = pg_backend_pid() WHERE name = 'instance' AND holder = $1",
      [me.holder, Math.round(ttlMs / 1000) + ' seconds'],
    );
    if (!r.rowCount) return lose('another instance holds the lease now');
    lastRenewOk = Date.now();
  } catch (e) {
    // the database is away: once the lease may have expired, this instance must stop (another may take over)
    if (Date.now() - lastRenewOk >= ttlMs - Math.min(renewMs, 5000)) lose('the lease could not be renewed for ' + Math.round((Date.now() - lastRenewOk) / 1000) + ' s: ' + ((e && e.message) || e));
  }
}

function startRenewing() {
  if (renewTimer) return;
  renewTimer = setInterval(() => void renew(), renewMs);
}

function lose(reason) {
  if (!held) return;
  held = false;
  clearInterval(renewTimer);
  renewTimer = null;
  parentPort.postMessage({ type: 'lost', reason });
}

async function acquireLoop() {
  for (;;) {
    if (stopping) return;
    soon = false;
    try {
      const r = await tryAcquire();
      if (r.acquired) return parentPort.postMessage({ type: 'acquired', ...r.acquired });
      parentPort.postMessage({ type: 'waiting', wait: r.wait });
    } catch (e) {
      if (client) { client.end().catch(() => undefined); client = null; }
      parentPort.postMessage({ type: 'waiting', wait: { reason: 'error', message: (e && e.message) || String(e) } });
    }
    await sleep(soon ? Math.min(250, retryMs) : retryMs);
  }
}

parentPort.on('message', async (m) => {
  if (m.op === 'acquire') void acquireLoop();
  else if (m.op === 'release') {
    stopping = true;
    clearInterval(renewTimer);
    renewTimer = null;
    let ok = false;
    if (held && client) {
      try {
        await client.query('DELETE FROM ' + qi(table) + " WHERE name = 'instance' AND holder = $1", [me.holder]);
        await client.query('SELECT pg_advisory_unlock($1::int, hashtext($2))', [lockClass, schema]).catch(() => undefined);
        ok = true;
      } catch {
        /* expires by itself */
      }
    }
    held = false;
    if (client) await client.end().catch(() => undefined);
    client = null;
    parentPort.postMessage({ type: 'released', ok });
  } else if (m.op === 'renew') {
    await renew();
    parentPort.postMessage({ type: 'renewed', held });
  }
});
`;

type Message =
  | { type: 'waiting'; wait: LeaseWait }
  | ({ type: 'acquired' } & LeaseAcquired)
  | { type: 'lost'; reason: string }
  | { type: 'released'; ok: boolean }
  | { type: 'renewed'; held: boolean };

export class InstanceLease {
  readonly holder: string;
  private worker: Worker;
  private state: 'idle' | 'waiting' | 'held' | 'lost' | 'released' = 'idle';
  private lastWait: LeaseWait | null = null;
  private lostHandlers: ((reason: string) => void)[] = [];
  private waiters: ((m: Message) => void)[] = [];

  constructor(opts: LeaseOptions) {
    this.holder = `${os.hostname()}:${process.pid}:${crypto.randomBytes(6).toString('hex')}`;
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      execArgv: [],
      workerData: {
        pgPath: createRequire(import.meta.url).resolve('pg'),
        url: opts.url,
        schema: opts.schema,
        table: LEASE_TABLE,
        ttlMs: opts.ttlMs ?? 45_000,
        renewMs: opts.renewMs ?? 10_000,
        retryMs: opts.retryMs ?? 2_000,
        connectTimeoutMs: opts.connectTimeoutMs ?? 10_000,
        lockClass: LOCK_CLASS,
        appName: `${BRAND.slug}-lease`,
        me: { holder: this.holder, host: os.hostname(), pid: process.pid, version: opts.version },
      },
    });
    this.worker.unref();
    this.worker.on('error', (e) => this.onMessage({ type: 'lost', reason: `the lease worker failed: ${e.message}` }));
    this.worker.on('message', (m: Message) => this.onMessage(m));
  }

  private onMessage(m: Message): void {
    if (m.type === 'waiting') {
      this.state = 'waiting';
      this.lastWait = m.wait;
    } else if (m.type === 'acquired') this.state = 'held';
    else if (m.type === 'lost' && this.state === 'held') {
      this.state = 'lost';
      for (const h of this.lostHandlers) h(m.reason);
    }
    for (const w of this.waiters.splice(0)) w(m);
  }

  private next(pred: (m: Message) => boolean): Promise<Message> {
    return new Promise((resolve) => {
      const check = (m: Message) => (pred(m) ? resolve(m) : this.waiters.push(check));
      this.waiters.push(check);
    });
  }

  get status(): 'idle' | 'waiting' | 'held' | 'lost' | 'released' {
    return this.state;
  }
  get waitingFor(): LeaseWait | null {
    return this.state === 'waiting' ? this.lastWait : null;
  }

  /** Resolves once the lease is held; `onWait` is told about each attempt that had to wait. */
  async acquire(onWait?: (w: LeaseWait) => void): Promise<LeaseAcquired> {
    this.state = 'waiting';
    const done = new Promise<LeaseAcquired>((resolve) => {
      const step = (m: Message) => {
        if (m.type === 'acquired') return resolve({ takeover: m.takeover, terminated: m.terminated });
        if (m.type === 'waiting') onWait?.(m.wait);
        this.waiters.push(step);
      };
      this.waiters.push(step);
    });
    this.worker.postMessage({ op: 'acquire' });
    return done;
  }

  /** Called once when the held lease is lost (another instance took it, or it could not be renewed in time). */
  onLost(fn: (reason: string) => void): void {
    this.lostHandlers.push(fn);
  }

  /** For tests: renew now. */
  async renewNow(): Promise<boolean> {
    const p = this.next((m) => m.type === 'renewed' || m.type === 'lost');
    this.worker.postMessage({ op: 'renew' });
    const m = await p;
    return m.type === 'renewed' && m.held;
  }

  /** Gives the lease up (deleted, so the next instance takes over at once) and ends the worker. */
  async release(timeoutMs = 5000): Promise<boolean> {
    if (this.state === 'released') return false;
    const p = this.next((m) => m.type === 'released');
    this.worker.postMessage({ op: 'release' });
    let timer: NodeJS.Timeout | undefined;
    const m = await Promise.race([p, new Promise<null>((r) => (timer = setTimeout(() => r(null), timeoutMs)))]);
    clearTimeout(timer);
    this.state = 'released';
    await this.worker.terminate();
    return !!m && m.type === 'released' && m.ok;
  }

  /** For tests: stop without releasing, like a crash (the lease row stays until it expires). */
  async abandon(): Promise<void> {
    this.state = 'released';
    await this.worker.terminate();
  }
}
