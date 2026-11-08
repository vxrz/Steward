import '../src/warnings.js';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startedUrl } from './helpers.js';
import { describeHolder, holderFileOf, lockFileOf, lockForCommand, lockHeldElsewhere, SqliteInstanceLock } from '../src/database/sqlite-lock.js';

/**
 * The single-instance lock on SQLite (database/sqlite-lock.ts, ADR 0002 update 0.10.1): a second instance on the same
 * database does not open it, waits (alive, not ready) and takes over when the first stops; a killed holder leaves no
 * stale lock.
 */
const ROOT = path.resolve(__dirname, '..', '..');
const children: ChildProcess[] = [];
const dirs: string[] = [];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-sqlite-lock-'));
  dirs.push(d);
  return d;
};

afterAll(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

async function until<T>(fn: () => T | undefined | Promise<T | undefined>, ms: number, what: string, out?: () => string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`${what} not reached in ${ms} ms${out ? `: ${out().slice(-3000)}` : ''}`);
    await wait(100);
  }
}

describe('SqliteInstanceLock', () => {
  it('one holder at a time; a release hands over, a waiting acquire takes it', async () => {
    const file = path.join(tmpDir(), 'service-manager.db');
    const a = new SqliteInstanceLock({ file, version: 'a' });
    expect(a.tryAcquire()).toBe(true);
    expect(fs.existsSync(lockFileOf(file))).toBe(true);
    expect(JSON.parse(fs.readFileSync(holderFileOf(file), 'utf8'))).toMatchObject({ pid: process.pid, host: os.hostname(), version: 'a' });
    // (a second connection in the same process is refused like another process)
    const b = new SqliteInstanceLock({ file, version: 'b', retryMs: 50 });
    expect(b.tryAcquire()).toBe(false);
    expect(lockHeldElsewhere(file)).toMatchObject({ held: true, holder: { pid: process.pid, version: 'a' } });
    expect(() => lockForCommand(file, 'cli')).toThrow(/is running with this database .*process \d+ on .*version a.* – stop it first/);
    const holders: string[] = [];
    const got = b.acquire((h) => holders.push(describeHolder(h)));
    await until(() => holders.length >= 2 || undefined, 5000, 'b waits');
    expect(b.status).toBe('waiting');
    expect(holders[0]).toMatch(/^process \d+ on .*, version a, since /);
    a.release();
    expect(fs.existsSync(holderFileOf(file))).toBe(false);
    expect(await got).toBe(true);
    expect(b.status).toBe('held');
    expect(JSON.parse(fs.readFileSync(holderFileOf(file), 'utf8'))).toMatchObject({ version: 'b' });
    b.release();
    expect(lockHeldElsewhere(file)).toEqual({ held: false });
  });

  it('release() ends a wait without taking the lock', async () => {
    const file = path.join(tmpDir(), 'x.db');
    const a = new SqliteInstanceLock({ file, version: 'a' });
    a.tryAcquire();
    const b = new SqliteInstanceLock({ file, version: 'b', retryMs: 10_000 });
    const got = b.acquire();
    await wait(50);
    b.release();
    expect(await got).toBe(false);
    expect(a.status).toBe('held');
    a.release();
  });

  it('takes a removed lock file again, and reports the loss when another process has the new one', async () => {
    const file = path.join(tmpDir(), 'x.db');
    const a = new SqliteInstanceLock({ file, version: 'a', checkMs: 50 });
    a.tryAcquire();
    const lost: string[] = [];
    a.onLost((r) => lost.push(r));
    fs.rmSync(lockFileOf(file));
    await until(() => fs.existsSync(lockFileOf(file)) || undefined, 5000, 'lock file again');
    expect(a.status).toBe('held');
    expect(lockHeldElsewhere(file).held).toBe(true);
    // removed again, and someone else is faster
    fs.rmSync(lockFileOf(file));
    const b = new SqliteInstanceLock({ file, version: 'b' });
    expect(b.tryAcquire()).toBe(true);
    await until(() => lost.length || undefined, 5000, 'lost');
    expect(a.status).toBe('lost');
    expect(lost[0]).toMatch(/was removed or replaced, and process \d+ .*version b/);
    b.release();
    a.release();
  });

  it('is free at once when the holding process is killed', async () => {
    const file = path.join(tmpDir(), 'x.db');
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(${JSON.stringify(lockFileOf(file))}); d.exec('BEGIN EXCLUSIVE'); console.log('held'); setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    children.push(holder);
    let out = '';
    holder.stdout!.on('data', (d) => (out += d));
    await until(() => out.includes('held') || undefined, 10_000, 'child holds the lock');
    expect(lockHeldElsewhere(file).held).toBe(true);
    const lock = new SqliteInstanceLock({ file, version: 'x' });
    expect(lock.tryAcquire()).toBe(false);
    holder.kill('SIGKILL');
    await new Promise((r) => holder.on('exit', r));
    expect(lock.tryAcquire()).toBe(true);
    lock.release();
  });
});

describe('desktop launcher', () => {
  it('does not start a second instance while the data folder is in use but its server does not answer', async () => {
    const dataDir = tmpDir();
    const lock = new SqliteInstanceLock({ file: path.join(dataDir, 'service-manager.db'), version: '9.9.9' });
    expect(lock.tryAcquire()).toBe(true);
    try {
      const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1', SM_DATA_DIR: dataDir };
      delete env.SM_DATABASE_URL;
      const r = spawnSync(
        path.join(ROOT, 'node_modules', '.bin', 'tsx'),
        [path.join(ROOT, 'server/src/desktop/launcher.ts'), '--no-open', '--port', String(await freePort())],
        {
          cwd: ROOT,
          encoding: 'utf8',
          env,
          timeout: 60_000,
        },
      );
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stderr).toMatch(/Steward is already running with your data folder .*version 9\.9\.9.*, but does not answer yet/);
      expect(fs.existsSync(path.join(dataDir, 'vault.json'))).toBe(false);
    } finally {
      lock.release();
    }
  });
});

// ---------- two servers on one data folder ----------

interface Server {
  proc: ChildProcess;
  out: () => string;
  exited: Promise<number | null>;
}

function spawnServer(dataDir: string, extra: Record<string, string> = {}): Server {
  const env: Record<string, string | undefined> = { ...process.env, SM_LOG_LEVEL: 'info', SM_DATA_DIR: dataDir, SM_PORT: '0', ...extra };
  // SQLite, also when the suite runs on PostgreSQL
  delete env.SM_DATABASE_URL;
  delete env.SM_DATABASE_SCHEMA;
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: path.join(ROOT, 'server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(proc);
  let out = '';
  proc.stdout!.on('data', (d) => (out += d.toString()));
  proc.stderr!.on('data', (d) => (out += d.toString()));
  const exited = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)));
  return { proc, out: () => out, exited };
}

const logLines = (s: Server, msg: string) =>
  s
    .out()
    .split('\n')
    .filter((l) => l.includes(`"msg":"${msg}`))
    .map((l) => JSON.parse(l) as Record<string, unknown>);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

describe('single instance on SQLite', () => {
  it('a second instance waits (alive, not ready, database untouched) and takes over when the first stops; a killed one frees it at once', async () => {
    const dataDir = tmpDir();
    const first = spawnServer(dataDir);
    await until(() => startedUrl(first.out()), 60_000, 'first start', first.out);
    expect(logLines(first, 'database lock acquired')).toHaveLength(1);

    const port = await freePort();
    const second = spawnServer(dataDir, { SM_PORT: String(port) });
    const waitingLog = await until(() => logLines(second, 'waiting for the database lock')[0], 30_000, 'waiting', second.out);
    expect(waitingLog).toMatchObject({ level: 40, holderPid: first.proc.pid, lockFile: path.join(dataDir, 'service-manager.db.lock') });
    const health = await until(() => fetch(`http://127.0.0.1:${port}/api/health`).catch(() => undefined), 10_000, 'health');
    expect(health.status).toBe(200);
    const ready = await fetch(`http://127.0.0.1:${port}/api/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ ready: false, checks: { database: { ok: false, message: expect.stringMatching(/another instance/) } } });
    const traffic = await fetch(`http://127.0.0.1:${port}/api/ready/traffic`);
    expect(traffic.status).toBe(503);
    expect(await traffic.json()).toMatchObject({ ready: false, message: expect.stringMatching(/another instance/) });
    expect((await fetch(`http://127.0.0.1:${port}/api/processes`)).status).toBe(503);
    await wait(1500);
    expect(second.proc.exitCode).toBeNull();
    expect(logLines(second, 'background jobs started')).toHaveLength(0);

    // the first stops cleanly: the second starts within its retry interval
    first.proc.kill('SIGTERM');
    expect(await first.exited).toBe(0);
    const t0 = Date.now();
    await until(() => startedUrl(second.out()), 60_000, 'second start', second.out);
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(logLines(second, 'database lock acquired: the other instance has stopped')).toHaveLength(1);
    expect(logLines(second, 'background jobs started')).toHaveLength(1);

    // a third waits; the second is killed (no clean stop): the third takes over at once, no stale lock
    const third = spawnServer(dataDir);
    await until(() => logLines(third, 'waiting for the database lock')[0], 30_000, 'third waits', third.out);
    second.proc.kill('SIGKILL');
    await second.exited;
    await until(() => startedUrl(third.out()), 60_000, 'third start', third.out);

    // a stop signal while waiting ends a waiting instance cleanly
    const fourth = spawnServer(dataDir);
    await until(() => logLines(fourth, 'waiting for the database lock')[0], 30_000, 'fourth waits', fourth.out);
    fourth.proc.kill('SIGTERM');
    expect(await fourth.exited).toBe(0);
    expect(logLines(fourth, 'stopped while waiting for the database lock')).toHaveLength(1);
    expect(fourth.out()).not.toContain('service manager started');

    // command-line tools that write to the database are refused while it runs
    const TSX = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
    const cliEnv: Record<string, string | undefined> = { ...process.env, SM_DATA_DIR: dataDir };
    delete cliEnv.SM_DATABASE_URL;
    const copy = spawnSync(TSX, [path.join(ROOT, 'server/src/cli/db-copy.ts'), `--to=sqlite:${path.join(tmpDir(), 'copy.db')}`], {
      cwd: ROOT,
      encoding: 'utf8',
      env: cliEnv,
      timeout: 60_000,
    });
    expect(copy.status, copy.stdout + copy.stderr).toBe(1);
    expect(copy.stderr).toMatch(/db:copy failed: Steward is running with this database .*service-manager\.db.* – stop it first/);

    // the desktop launcher on another port opens the running one instead of starting a second instance
    const desktop = spawnSync(TSX, [path.join(ROOT, 'server/src/desktop/launcher.ts'), '--no-open', '--port', String(await freePort())], {
      cwd: ROOT,
      encoding: 'utf8',
      env: cliEnv,
      timeout: 60_000,
    });
    expect(desktop.status, desktop.stdout + desktop.stderr).toBe(0);
    expect(desktop.stdout).toContain(`Steward is already running – opening ${startedUrl(third.out())}`);

    third.proc.kill('SIGTERM');
    expect(await third.exited).toBe(0);
    expect(lockHeldElsewhere(path.join(dataDir, 'service-manager.db'))).toEqual({ held: false });
  }, 300_000);
});
