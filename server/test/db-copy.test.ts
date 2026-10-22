import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PG_TEST_URL } from './pg-env.js';

// SQLite → PostgreSQL with the db:copy CLI, then the app runs on the copy (and back to SQLite).
describe.skipIf(!PG_TEST_URL)('db:copy', () => {
  const SERVER = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-copy-'));
  const port = 40000 + Math.floor(Math.random() * 10000);
  const base = `http://127.0.0.1:${port}`;
  const schema = `${process.env.SM_TEST_SCHEMA_PREFIX ?? 'smt_adhoc'}_copy${process.pid}`;
  const env = (db: Record<string, string>) => {
    const e: Record<string, string | undefined> = { ...process.env, SM_LOG_LEVEL: 'info', SM_DATA_DIR: dataDir, SM_PORT: String(port), SM_DEMO: '1', SM_MASTER_PASSPHRASE: 'copy-test-pass' };
    delete e.SM_DATABASE_URL;
    delete e.SM_DATABASE_SCHEMA;
    return { ...e, ...db };
  };
  const pgEnv = { SM_DATABASE_URL: PG_TEST_URL!, SM_DATABASE_SCHEMA: schema };
  let proc: ChildProcess | undefined;
  let cookie = '';
  let sessionKey = '';
  afterAll(() => {
    proc?.kill('SIGKILL');
  });

  const start = (db: Record<string, string>) =>
    new Promise<ChildProcess>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER, env: env(db), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout!.on('data', (d: Buffer) => {
        out += d.toString();
        if (out.includes('service manager started')) resolve(child);
      });
      child.stderr!.on('data', (d) => (out += d.toString()));
      child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
      setTimeout(() => reject(new Error('server start timeout: ' + out)), 30000);
    });
  const stop = async () => {
    const p = proc!;
    proc = undefined;
    await new Promise((r) => {
      p.once('exit', r);
      p.kill('SIGTERM');
    });
  };
  const api = async (method: string, url: string, body?: unknown): Promise<any> => {
    const res = await fetch(base + '/api' + url, {
      method,
      headers: { 'x-sm-client': '1', ...(cookie ? { cookie } : {}), ...(sessionKey ? { 'x-sm-session': sessionKey } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    const key = res.headers.get('x-sm-session-key');
    if (key !== null) sessionKey = key;
    const t = await res.text();
    if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${t}`);
    return t ? JSON.parse(t) : null;
  };
  const waitFor = async (id: string, statuses: string[]) => {
    for (let i = 0; i < 200; i++) {
      const r = await api('GET', `/runs/${id}`);
      if (statuses.includes(r.status)) return r;
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error('timeout');
  };
  const copy = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/db-copy.ts', ...args], { cwd: SERVER, env: env({}), encoding: 'utf8' });

  it('copies SQLite to PostgreSQL; the app continues on the copy with a valid audit chain', async () => {
    proc = await start({});
    await api('POST', '/auth/setup', { passphrase: 'copy-test-pass', username: 'admin', password: 'Admin-password-1' });
    await api('POST', '/demo/setup', {});
    const hub = (await api('GET', '/platforms')).find((p: any) => p.kind === 'insights-hub').id;
    const { id } = await api('POST', '/runs', { processId: 'ih-access-review-1-flag', bindings: { hub } });
    const waiting = await waitFor(id, ['waiting', 'failed']);
    expect(waiting.status).toBe('waiting');
    const before = { runs: (await api('GET', '/runs')).length, audit: (await api('GET', '/audit?limit=5000')).length, platforms: (await api('GET', '/platforms')).length };
    expect((await api('GET', '/audit/verify')).ok).toBe(true);
    await stop();

    const sqliteFile = path.join(dataDir, 'service-manager.db');
    const first = copy('--from', `sqlite:${sqliteFile}`, '--to', PG_TEST_URL!, '--to-schema', schema);
    expect(first.stderr + first.stdout).toContain('Done:');
    expect(first.status).toBe(0);
    const again = copy('--from', `sqlite:${sqliteFile}`, '--to', PG_TEST_URL!, '--to-schema', schema);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('already holds data');
    const forced = copy('--from', `sqlite:${sqliteFile}`, '--to', PG_TEST_URL!, '--to-schema', schema, '--force');
    expect(forced.status, forced.stderr).toBe(0);

    cookie = '';
    proc = await start(pgEnv);
    await api('POST', '/auth/login', { username: 'admin', password: 'Admin-password-1' });
    expect((await api('GET', '/runs')).length).toBe(before.runs);
    expect((await api('GET', '/platforms')).length).toBe(before.platforms);
    expect((await api('GET', '/audit?limit=5000')).length).toBeGreaterThanOrEqual(before.audit);
    expect((await api('GET', '/audit/verify')).ok).toBe(true);
    const ready = await api('GET', '/ready');
    expect(ready.checks.database.ok).toBe(true);
    // the copied waiting run completes (new steps/logs need correctly reset identity sequences)
    const after = await waitFor(id, ['waiting', 'failed']);
    const task = after.tasks.find((t: any) => t.status === 'open');
    await api('POST', `/tasks/${task.id}/complete`, { approved: true, selectedKeys: task.items.map((i: any) => i.key) });
    expect((await waitFor(id, ['succeeded', 'failed'])).status).toBe('succeeded');
    expect((await api('GET', '/audit/verify')).ok).toBe(true);
    const audit = (await api('GET', '/audit?limit=5000')).length;
    await stop();

    // and back: PostgreSQL → a new SQLite file
    const back = path.join(dataDir, 'back.db');
    const r = copy('--from', PG_TEST_URL!, '--from-schema', schema, '--to', `sqlite:${back}`);
    expect(r.status, r.stderr).toBe(0);
    fs.renameSync(back, sqliteFile);
    for (const f of ['-wal', '-shm']) fs.rmSync(sqliteFile + f, { force: true });
    cookie = '';
    proc = await start({});
    await api('POST', '/auth/login', { username: 'admin', password: 'Admin-password-1' });
    expect((await api('GET', '/audit/verify')).ok).toBe(true);
    expect((await api('GET', '/audit?limit=5000')).length).toBeGreaterThanOrEqual(audit);
    expect((await api('GET', `/runs/${id}`)).status).toBe('succeeded');
  }, 120000);
});
