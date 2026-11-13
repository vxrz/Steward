import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startedUrl } from './helpers.js';
import { freshDbEnv } from './pg-env.js';
import { spawnTestServer } from './server-process.js';

/**
 * The engine contract after a crash (ADR 0011, invariant 3): waiting runs resume, running runs become interrupted
 * (only a person resumes them), queued runs keep their place – and debug runs (ADR 0010) are cancelled with the
 * reason "Steward restarted", never resumed. Two real server processes on one database (SQLite or PostgreSQL).
 */

const ROOT = path.resolve(__dirname, '..', '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-contract-restart-'));
let port = 0;
let base = '';
let proc: ChildProcess | undefined;
const dbEnv = freshDbEnv();

function startServer(): Promise<ChildProcess> {
  const child = spawnTestServer({
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      ...dbEnv,
      SM_LOG_LEVEL: 'info',
      SM_DATA_DIR: dataDir,
      SM_PORT: String(port),
      SM_MASTER_PASSPHRASE: 'contract-restart-pass',
      SM_MAX_CONCURRENT_RUNS: '1',
      SM_GATUS_AUTOSTART: '0',
      SM_MONITOR_AUTOSTART: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const onData = (d: Buffer) => {
      out += d.toString();
      const url = startedUrl(out);
      if (url) {
        base = url;
        port = Number(new URL(url).port);
        resolve(child);
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', (d) => (out += d.toString()));
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
    setTimeout(() => reject(new Error('server start timeout: ' + out)), 60000);
  });
}

let cookie = '';
let sessionKey = '';
async function api(method: string, url: string, body?: unknown): Promise<any> {
  const res = await fetch(base + '/api' + url, {
    method,
    headers: {
      'x-sm-client': '1',
      ...(cookie ? { cookie } : {}),
      ...(sessionKey ? { 'x-sm-session': sessionKey } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0]!;
  const key = res.headers.get('x-sm-session-key');
  if (key !== null) sessionKey = key;
  const t = await res.text();
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${t}`);
  return t ? JSON.parse(t) : null;
}

async function waitFor(id: string, statuses: string[]): Promise<any> {
  for (let i = 0; i < 300; i++) {
    const r = await api('GET', `/runs/${id}`);
    if (statuses.includes(r.status)) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`run ${id} did not reach ${statuses}`);
}

const n = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, ...extra });
const w = (from: string, to: string, port = 'out') => ({ from, port, to });
const define = async (name: string, nodes: unknown[], wires: unknown[]) =>
  (await api('POST', '/processes', { definition: { name, nodes, wires } })).id as string;

afterAll(() => {
  proc?.kill('SIGKILL');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('engine contract: resume after a crash', () => {
  it('waiting runs resume, running ones become interrupted, queued ones keep their place, debug runs are cancelled', async () => {
    proc = await startServer();
    await api('POST', '/auth/setup', { passphrase: 'contract-restart-pass', username: 'admin', password: 'Admin-password-1' });
    const ask = await define(
      'Restart ask',
      [n('start', 'start'), n('ok', 'userTask', { mode: 'approve', title: 'Go?' }), n('after', 'log', { message: 'after' })],
      [w('start', 'ok'), w('ok', 'after', 'approved')],
    );
    const long = await define('Restart long', [n('start', 'start'), n('w', 'wait', { seconds: 120 })], [w('start', 'w')]);
    const steps = await define('Restart steps', [n('start', 'start'), n('a', 'set', { values: { a: 1 } })], [w('start', 'a')]);

    const dbg = (await api('POST', `/processes/${steps}/debug/runs`, { pauseBeforeEach: true })).runId;
    await waitFor(dbg, ['waiting']);
    const waiting = (await api('POST', '/runs', { processId: ask, dryRun: true })).id;
    const before = await waitFor(waiting, ['waiting']);
    const running = (await api('POST', '/runs', { processId: long, dryRun: true })).id;
    await waitFor(running, ['running']);
    const queued = (await api('POST', '/runs', { processId: long, dryRun: true })).id;
    expect((await api('GET', `/runs/${queued}`)).status).toBe('queued');

    proc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    proc = await startServer();

    expect((await waitFor(running, ['interrupted'])).status).toBe('interrupted');
    const debugRun = await waitFor(dbg, ['cancelled']);
    expect(debugRun.status).toBe('cancelled');
    const audit = await api('GET', `/audit?runId=${dbg}&limit=50`);
    expect(audit.find((a: { action: string }) => a.action === 'run.cancelled').details.reason).toBe('Steward restarted');
    // the queued run kept its place: it starts now that the slot is free, it was never interrupted
    const q = await waitFor(queued, ['queued', 'running']);
    expect(['queued', 'running']).toContain(q.status);
    // the waiting run resumed: deciding it finishes it, without repeating a step
    const after = await waitFor(waiting, ['waiting']);
    expect(after.tasks[0].id).toBe(before.tasks[0].id);
    await api('POST', `/tasks/${after.tasks[0].id}/complete`, { approved: true });
    const done = await waitFor(waiting, ['succeeded', 'failed']);
    expect(done.status).toBe('succeeded');
    expect(done.steps.map((s: { key: string }) => s.key)).toEqual(['start', 'ok', 'after']);
    await api('POST', `/runs/${queued}/cancel`, {});
    await api('POST', `/runs/${running}/cancel`, {});
    expect((await api('GET', '/audit/verify')).ok).toBe(true);
  }, 120000);
});
