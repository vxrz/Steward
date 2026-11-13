import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnTestServer, stopServers } from './server-process.js';

/**
 * Test servers in processes of their own (server-process.ts) end with the test worker that started them – also when the
 * worker is killed and none of its hooks runs. Before, a worker killed for lack of memory left its servers running
 * (parent 1, about 230 MB each), which took more memory from the next workers.
 */

const TETHER = pathToFileURL(path.join(import.meta.dirname, 'exit-with-parent.mjs')).href;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(fn: () => boolean, ms = 15_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (fn()) return true;
  return fn();
}

describe('test servers in their own process', () => {
  it('stop when the worker that started them is killed', async () => {
    // a stand-in for the test worker: starts a long-running child the way spawnTestServer does, names its pid, then waits
    const worker = spawn(
      process.execPath,
      [
        '-e',
        `const c = require('node:child_process').spawn(process.execPath, ['--import', ${JSON.stringify(TETHER)}, '-e', 'setInterval(() => {}, 1000)'], { env: { ...process.env, SM_TEST_EXIT_WITH_PARENT: '1' }, stdio: ['pipe', 'ignore', 'ignore'] });
         console.log(c.pid); setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const pid = await new Promise<number>((resolve) => worker.stdout!.once('data', (d: Buffer) => resolve(Number(String(d).trim()))));
    expect(alive(pid)).toBe(true);
    worker.kill('SIGKILL'); // no hook, no exit handler runs
    expect(await until(() => !alive(pid))).toBe(true);
  });

  it('still end by themselves while the worker runs', async () => {
    const child = spawnTestServer({ args: ['-e', 'setTimeout(() => process.exit(7), 200)'] });
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).toBe(7);
  });

  it('are killed when the test file ends without stopping them', async () => {
    const child = spawnTestServer({ args: ['-e', 'setInterval(() => {}, 1000)'] });
    await new Promise((r) => child.once('spawn', r));
    stopServers(); // what the file's afterAll and the worker's exit handler run
    expect(await until(() => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  });
});
