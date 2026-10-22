import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-restart-'));
const port = 40000 + Math.floor(Math.random() * 10000);
const base = `http://127.0.0.1:${port}`;
let proc: ChildProcess | undefined;

function startServer(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: path.join(ROOT, 'server'),
    env: { ...process.env, SM_LOG_LEVEL: 'info', SM_DATA_DIR: dataDir, SM_PORT: String(port), SM_DEMO: '1', SM_MASTER_PASSPHRASE: 'restart-test-pass' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const onData = (d: Buffer) => {
      out += d.toString();
      if (out.includes('service manager started')) resolve(child);
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', (d) => (out += d.toString()));
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${out}`)));
    setTimeout(() => reject(new Error('server start timeout: ' + out)), 30000);
  });
}

let cookie = '';
async function api(method: string, url: string, body?: unknown): Promise<any> {
  const res = await fetch(base + '/api' + url, {
    method,
    headers: { 'x-sm-client': '1', ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0]!;
  const t = await res.text();
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${t}`);
  return t ? JSON.parse(t) : null;
}

async function waitFor(id: string, statuses: string[]): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const r = await api('GET', `/runs/${id}`);
    if (statuses.includes(r.status)) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('timeout');
}

afterAll(() => {
  proc?.kill('SIGKILL');
});

describe('durable runs', () => {
  it('resumes a waiting run after a crash without repeating finished steps', async () => {
    proc = await startServer();
    await api('POST', '/auth/setup', { passphrase: 'restart-test-pass', username: 'admin', password: 'Admin-password-1' });
    await api('POST', '/demo/setup', {});
    const hub = (await api('GET', '/platforms')).find((p: any) => p.kind === 'insights-hub').id;
    const { id } = await api('POST', '/runs', { processId: 'ih-access-review-1-flag', bindings: { hub } });
    const waiting = await waitFor(id, ['waiting', 'failed']);
    expect(waiting.status).toBe('waiting');
    const listStep = waiting.steps.find((s: any) => s.stepId === 'listUsers');

    proc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    proc = await startServer(); // unlocks via SM_MASTER_PASSPHRASE and recovers runs

    const after = await waitFor(id, ['waiting', 'failed']);
    expect(after.status).toBe('waiting');
    const task = after.tasks.find((t: any) => t.status === 'open');
    expect(task.id).toBe(waiting.tasks[0].id);
    await api('POST', `/tasks/${task.id}/complete`, { approved: true, selectedKeys: task.items.map((i: any) => i.key) });
    const done = await waitFor(id, ['succeeded', 'failed']);
    expect(done.status).toBe('succeeded');
    expect(done.stats.writes).toBe(task.items.length);
    // the list call ran exactly once
    const listAfter = done.steps.find((s: any) => s.stepId === 'listUsers');
    expect(listAfter.startedAt).toBe(listStep.startedAt);
    const audit = await api('GET', `/audit?runId=${id}&limit=500`);
    expect(audit.filter((a: any) => a.action === 'run.started')).toHaveLength(1);
    expect(audit.filter((a: any) => a.action === 'run.resumed')).toHaveLength(1);
    expect((await api('GET', '/audit/verify')).ok).toBe(true);
  }, 60000);
});
