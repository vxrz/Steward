import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startedUrl } from './helpers.js';
import { freshDbEnv, PG_TEST_URL } from './pg-env.js';

/**
 * A clean stop on SIGTERM (main.ts, bootstrap.ts) and, on PostgreSQL, the single-instance lease (database/lease.ts):
 * a second instance waits and answers /api/ready with 503 instead of exiting, takes over when the first stops or its
 * lease expires, and a crashed holder's lingering session no longer blocks the start.
 */
const ROOT = path.resolve(__dirname, '..', '..');
const children: ChildProcess[] = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Server {
  proc: ChildProcess;
  out: () => string;
  exited: Promise<number | null>;
}

function spawnServer(env: Record<string, string>): Server {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-lease-'));
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'server'),
    env: { ...process.env, SM_LOG_LEVEL: 'info', SM_DATA_DIR: dataDir, SM_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);
  let out = '';
  proc.stdout!.on('data', (d) => (out += d.toString()));
  proc.stderr!.on('data', (d) => (out += d.toString()));
  const exited = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)));
  return { proc, out: () => out, exited };
}

async function until<T>(fn: () => T | undefined | Promise<T | undefined>, ms: number, what: string, out?: () => string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`${what} not reached in ${ms} ms${out ? `: ${out().slice(-3000)}` : ''}`);
    await wait(100);
  }
}

const logLines = (s: Server, msg: string) =>
  s
    .out()
    .split('\n')
    .filter((l) => l.includes(`"msg":"${msg}`))
    .map((l) => JSON.parse(l) as Record<string, unknown>);

afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
});

describe('stop on SIGTERM', () => {
  it('stops the background work in order and exits 0', async () => {
    const s = spawnServer({ ...freshDbEnv(), SM_SHUTDOWN_GRACE_SECONDS: '5' });
    await until(() => startedUrl(s.out()), 60_000, 'start', s.out);
    s.proc.kill('SIGTERM');
    expect(await s.exited).toBe(0);
    expect(logLines(s, 'stop signal received')[0]).toMatchObject({ signal: 'SIGTERM', graceSeconds: 5 });
    expect(logLines(s, 'background work stopped')[0]).toMatchObject({ interrupted: [], jobsRunning: [] });
    expect(logLines(s, 'service manager stopped')).toHaveLength(1);
  }, 90_000);
});

describe.skipIf(!PG_TEST_URL)('single-instance lease on PostgreSQL', () => {
  const schema = () => `${process.env.SM_TEST_SCHEMA_PREFIX ?? 'smt_adhoc'}_lease${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

  it('a second instance waits (alive, not ready) and takes over when the first one stops', async () => {
    const env = { SM_DATABASE_URL: PG_TEST_URL!, SM_DATABASE_SCHEMA: schema() };
    const first = spawnServer(env);
    await until(() => startedUrl(first.out()), 60_000, 'first start', first.out);
    const second = spawnServer(env);
    const waitingLog = await until(() => logLines(second, 'waiting for the database lease')[0], 30_000, 'waiting', second.out);
    expect(waitingLog).toMatchObject({ level: 40 });
    // the first stops cleanly and deletes its lease: the second starts within its retry interval
    first.proc.kill('SIGTERM');
    expect(await first.exited).toBe(0);
    const t0 = Date.now();
    await until(() => startedUrl(second.out()), 30_000, 'second start', second.out);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(logLines(second, 'database lease acquired')).toHaveLength(1);
    second.proc.kill('SIGTERM');
    expect(await second.exited).toBe(0);
  }, 150_000);

  it('answers /api/health with 200 and /api/ready with 503 while it waits', async () => {
    const { InstanceLease } = await import('../src/database/lease.js');
    const sc = schema();
    const holder = new InstanceLease({ url: PG_TEST_URL!, schema: sc, version: 'test' });
    await holder.acquire();
    const port = 40000 + Math.floor(Math.random() * 20000);
    const waiting = spawnServer({ SM_DATABASE_URL: PG_TEST_URL!, SM_DATABASE_SCHEMA: sc, SM_PORT: String(port) });
    await until(() => logLines(waiting, 'waiting for the database lease')[0], 30_000, 'waiting', waiting.out);
    const health = await until(() => fetch(`http://127.0.0.1:${port}/api/health`).catch(() => undefined), 10_000, 'health');
    expect(health.status).toBe(200);
    const ready = await fetch(`http://127.0.0.1:${port}/api/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ ready: false, checks: { database: { ok: false, message: expect.stringMatching(/another instance/) } } });
    // not ready for traffic either: the instance that holds the lease gets it
    const traffic = await fetch(`http://127.0.0.1:${port}/api/ready/traffic`);
    expect(traffic.status).toBe(503);
    expect(await traffic.json()).toMatchObject({ ready: false, message: expect.stringMatching(/another instance/) });
    expect((await fetch(`http://127.0.0.1:${port}/api/processes`)).status).toBe(503);
    // still waiting a while later (it does not exit)
    await wait(2000);
    expect(waiting.proc.exitCode).toBeNull();
    // a stop signal while waiting ends it cleanly
    waiting.proc.kill('SIGTERM');
    expect(await waiting.exited).toBe(0);
    await holder.release();
  }, 90_000);

  describe('lease rules', () => {
    it('one holder at a time; a release hands over at once', async () => {
      const { InstanceLease } = await import('../src/database/lease.js');
      const sc = schema();
      const a = new InstanceLease({ url: PG_TEST_URL!, schema: sc, version: 'a', retryMs: 200 });
      expect(await a.acquire()).toEqual({ takeover: null, terminated: null });
      const b = new InstanceLease({ url: PG_TEST_URL!, schema: sc, version: 'b', retryMs: 200 });
      const waits: string[] = [];
      const got = b.acquire((w) => waits.push(w.reason === 'held' ? `held by ${w.current.version}` : w.reason));
      await until(() => waits.length >= 2 || undefined, 10_000, 'b waits');
      expect(waits[0]).toBe('held by a');
      expect(b.status).toBe('waiting');
      expect(await a.release()).toBe(true);
      expect(await got).toEqual({ takeover: null, terminated: null });
      expect(b.status).toBe('held');
      await b.release();
    });

    it('a crashed holder (no renewals) loses the lease after its TTL; the next one takes over', async () => {
      const { InstanceLease } = await import('../src/database/lease.js');
      const pg = (await import('pg')).default;
      const sc = schema();
      const a = new InstanceLease({ url: PG_TEST_URL!, schema: sc, version: 'a', ttlMs: 3000, renewMs: 500 });
      await a.acquire();
      // another machine: its process cannot be checked from here
      const c = new pg.Client({ connectionString: PG_TEST_URL });
      await c.connect();
      await c.query(`UPDATE "${sc}".sm_instance_lease SET host = 'elsewhere'`);
      await a.abandon();
      const b = new InstanceLease({ url: PG_TEST_URL!, schema: sc, version: 'b', ttlMs: 3000, retryMs: 200 });
      const t0 = Date.now();
      const got = await b.acquire();
      expect(Date.now() - t0).toBeGreaterThan(1000);
      expect(Date.now() - t0).toBeLessThan(8000);
      expect(got.takeover).toMatchObject({ holder: a.holder, version: 'a', host: 'elsewhere' });
      await b.release();
      await c.end();
    });

    it('takes over at once from a dead holder on the same machine (restart after kill -9)', async () => {
      const { InstanceLease } = await import('../src/database/lease.js');
      const pg = (await import('pg')).default;
      const sc = schema();
      const a = new InstanceLease({ url: PG_TEST_URL!, schema: sc, version: 'a', ttlMs: 60_000 });
      await a.acquire();
      await a.abandon();
      // the dead process's number (a process that has exited)
      const dead = spawn(process.execPath, ['-e', '0']);
      const deadPid = dead.pid!;
      await new Promise((r) => dead.on('exit', r));
      const c = new pg.Client({ connectionString: PG_TEST_URL });
      await c.connect();
      await c.query(`UPDATE "${sc}".sm_instance_lease SET pid = $1`, [deadPid]);
      await c.end();
      const b = new InstanceLease({ url: PG_TEST_URL!, schema: sc, version: 'b' });
      const t0 = Date.now();
      const got = await b.acquire();
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(got.takeover).toMatchObject({ holder: a.holder });
      await b.release();
    });

    it("ends the expired holder's lingering session that still holds the advisory lock (a crashed VM)", async () => {
      const { InstanceLease } = await import('../src/database/lease.js');
      const { LOCK_CLASS } = await import('../src/database/pg-bridge.js');
      const pg = (await import('pg')).default;
      const sc = schema();
      const a = new InstanceLease({ url: PG_TEST_URL!, schema: sc, version: 'a', ttlMs: 60_000 });
      await a.acquire();
      await a.abandon();
      // the old session: still holds the instance lock, and the lease names it – but the lease has expired
      const lingering = new pg.Client({ connectionString: PG_TEST_URL });
      lingering.on('error', () => undefined);
      await lingering.connect();
      expect((await lingering.query('SELECT pg_try_advisory_lock($1::int, hashtext($2)) AS ok', [LOCK_CLASS, sc])).rows[0].ok).toBe(true);
      const pid = (await lingering.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      await lingering.query(`UPDATE "${sc}".sm_instance_lease SET backend_pid = $1, host = 'crashed-vm', expires_at = now() - interval '1 second'`, [pid]);
      const b = new InstanceLease({ url: PG_TEST_URL!, schema: sc, version: 'b' });
      const got = await b.acquire();
      expect(got.terminated).toEqual({ pid, ok: true });
      expect(got.takeover).toMatchObject({ host: 'crashed-vm' });
      await expect(lingering.query('SELECT 1')).rejects.toThrow();
      await b.release();
    });

    it('waits while an instance of an older version (advisory lock, no lease) runs', async () => {
      const { InstanceLease } = await import('../src/database/lease.js');
      const { LOCK_CLASS } = await import('../src/database/pg-bridge.js');
      const pg = (await import('pg')).default;
      const sc = schema();
      const old = new pg.Client({ connectionString: PG_TEST_URL });
      await old.connect();
      await old.query(`CREATE SCHEMA IF NOT EXISTS "${sc}"`);
      await old.query('SELECT pg_advisory_lock($1::int, hashtext($2))', [LOCK_CLASS, sc]);
      const b = new InstanceLease({ url: PG_TEST_URL!, schema: sc, version: 'b', retryMs: 200 });
      const waits: string[] = [];
      const got = b.acquire((w) => waits.push(w.reason));
      await until(() => waits.length >= 2 || undefined, 10_000, 'b waits');
      expect(waits).toContain('advisoryLock');
      expect(b.status).toBe('waiting');
      await old.end();
      expect(await got).toMatchObject({ takeover: null });
      await b.release();
    });

    it('notices when another instance holds the lease now, and says so', async () => {
      const { InstanceLease } = await import('../src/database/lease.js');
      const pg = (await import('pg')).default;
      const sc = schema();
      const a = new InstanceLease({ url: PG_TEST_URL!, schema: sc, version: 'a', renewMs: 60_000 });
      await a.acquire();
      const lost: string[] = [];
      a.onLost((r) => lost.push(r));
      expect(await a.renewNow()).toBe(true);
      const c = new pg.Client({ connectionString: PG_TEST_URL });
      await c.connect();
      await c.query(`UPDATE "${sc}".sm_instance_lease SET holder = 'someone-else'`);
      await c.end();
      expect(await a.renewNow()).toBe(false);
      expect(lost).toEqual(['another instance holds the lease now']);
      expect(a.status).toBe('lost');
      await a.release();
    });

    it('keeps command-line tools that take the instance lock out while an instance runs', async () => {
      const { InstanceLease } = await import('../src/database/lease.js');
      const { Db } = await import('../src/db.js');
      const sc = schema();
      const a = new InstanceLease({ url: PG_TEST_URL!, schema: sc, version: 'a' });
      await a.acquire();
      const { PostgresDriver } = await import('../src/database/drivers.js');
      expect(() => new Db(new PostgresDriver({ kind: 'postgres', url: PG_TEST_URL!, schema: sc }, { lockWaitMs: 300 }), { migrate: false })).toThrow(
        /Another .* instance is already using this database schema/,
      );
      await a.release();
    });
  });
});
