import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll } from 'vitest';

/**
 * A Steward server in a process of its own (`node --import tsx src/index.ts`, relative to `options.cwd`), for the tests
 * that restart, lock or upgrade an instance. Unlike a bare spawn() it cannot outlive the test file:
 * - its standard input is a pipe from this worker, and exit-with-parent.mjs stops it when the pipe closes – also when
 *   the worker is killed (out of memory) and no hook of the file runs;
 * - when the file ends (its afterAll, or the worker's exit after a hook time-out), every server it started and did not
 *   stop is killed.
 * Orphaned test servers (about 230 MB each) once filled the memory of a shared machine.
 */
const TETHER = pathToFileURL(path.join(import.meta.dirname, 'exit-with-parent.mjs')).href;
const started = new Set<ChildProcess>();

export function spawnTestServer(options: SpawnOptions & { args?: string[] } = {}): ChildProcess {
  const { args = ['src/index.ts'], stdio = ['ignore', 'pipe', 'pipe'], ...rest } = options;
  const io = (typeof stdio === 'string' ? [stdio, stdio, stdio] : [...stdio]) as Exclude<SpawnOptions['stdio'], string | undefined>;
  io[0] = 'pipe';
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', TETHER, ...args], {
    ...rest,
    env: { ...(rest.env ?? process.env), SM_TEST_EXIT_WITH_PARENT: '1' },
    stdio: io,
  });
  started.add(child);
  child.once('exit', () => started.delete(child));
  return child;
}

/** Kills every server this file started that is still running (also run when the file ends). */
export function stopServers(): void {
  for (const c of started) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  started.clear();
}

afterAll(stopServers);
process.once('exit', stopServers);
