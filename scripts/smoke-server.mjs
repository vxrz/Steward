// Smoke test of the compiled server (server/dist, `npm run build:server`): starts `node server/dist/index.js`
// on a free port with a new temporary data folder, waits for /api/health, runs the container health check
// (server/dist/healthcheck.js) against it, checks that the compiled PDF worker starts, and stops the server.
//
//   npm run build:server && node scripts/smoke-server.mjs
//
// Exit status: 0 = all good, 1 = a check failed.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'server', 'dist');
if (!fs.existsSync(path.join(dist, 'index.js'))) {
  console.error('server/dist/index.js is missing – run "npm run build:server" first.');
  process.exit(1);
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-smoke-'));
const env = { ...process.env, SM_DATA_DIR: dataDir, SM_PORT: '0', SM_HOST: '127.0.0.1', SM_LOG_LEVEL: 'info', SM_DEMO: '' };
const child = spawn(process.execPath, ['--enable-source-maps', path.join(dist, 'index.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

const fail = (msg) => {
  console.error(`✗ ${msg}\n--- server log ---\n${log.slice(-4000)}`);
  child.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
};

const port = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 60_000);
  const look = () => {
    const m = /Server listening at http:\/\/127\.0\.0\.1:(\d+)/.exec(log);
    if (m) {
      clearTimeout(timer);
      resolve(Number(m[1]));
    }
  };
  child.stdout.on('data', look);
  child.stderr.on('data', look);
  child.on('exit', () => resolve(null));
});
if (!port) fail('the compiled server did not start');

const health = await fetch(`http://127.0.0.1:${port}/api/health`).then(
  (r) => r.json(),
  () => null,
);
if (!health?.ok) fail(`/api/health answered ${JSON.stringify(health)}`);
console.log(`✓ node server/dist/index.js answers /api/health (version ${health.version})`);

const hc = spawnSync(process.execPath, [path.join(dist, 'healthcheck.js')], { env: { ...env, SM_PORT: String(port) }, encoding: 'utf8' });
if (hc.status !== 0) fail(`server/dist/healthcheck.js exited with ${hc.status}: ${hc.stderr}`);
console.log('✓ server/dist/healthcheck.js exits 0');

const ready = await new Promise((resolve) => {
  const w = new Worker(pathToFileURL(path.join(dist, 'pdf-worker.js')));
  const timer = setTimeout(() => (w.terminate(), resolve(false)), 30_000);
  w.once('message', (m) => (clearTimeout(timer), w.terminate(), resolve(m?.type === 'ready')));
  w.once('error', (e) => (clearTimeout(timer), resolve(e)));
});
if (ready !== true) fail(`the compiled PDF worker did not start: ${ready}`);
console.log('✓ server/dist/pdf-worker.js starts');

child.kill('SIGTERM');
await new Promise((r) => child.once('exit', r));
fs.rmSync(dataDir, { recursive: true, force: true });
console.log('Compiled server OK');
