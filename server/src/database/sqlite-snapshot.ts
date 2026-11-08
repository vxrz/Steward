import { Worker } from 'node:worker_threads';
import { logger } from '../log.js';

/**
 * A consistent copy of a live SQLite database without blocking the event loop (O8 of the 0.10 review): VACUUM INTO on
 * a connection of its own in a worker thread. The database is in WAL mode, so the app's own connection keeps reading
 * and writing meanwhile; the copy is the state of the moment the worker's read transaction began. When the worker
 * cannot start (an unusual runtime) the copy is made on the main thread, as before 0.11.
 */
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
// node:sqlite's ExperimentalWarning is filtered on the main thread (warnings.ts); here as well
const emit = process.emitWarning.bind(process);
process.emitWarning = (w, ...rest) => (/SQLite is an experimental/.test(String(w && w.message ? w.message : w)) ? undefined : emit(w, ...rest));
const { DatabaseSync } = require('node:sqlite');
let d;
try {
  d = new DatabaseSync(workerData.file);
  d.exec('PRAGMA busy_timeout = 10000');
  d.exec("VACUUM INTO '" + workerData.out.replace(/'/g, "''") + "'");
  parentPort.postMessage({ ok: true });
} catch (e) {
  parentPort.postMessage({ ok: false, message: String((e && e.message) || e) });
} finally {
  try { d && d.close(); } catch {}
}
`;

/** Copies the database `file` into `out` (missing or empty: create it first with the permissions it should have). */
export function snapshotSqlite(file: string, out: string, fallback: () => void): Promise<{ inWorker: boolean }> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, { eval: true, execArgv: [], workerData: { file, out } });
    } catch (err) {
      logger.warn({ err }, 'the database snapshot worker could not start: copying on the main thread');
      try {
        fallback();
        resolve({ inWorker: false });
      } catch (e) {
        reject(e as Error);
      }
      return;
    }
    let settled = false;
    worker.once('message', (m: { ok: boolean; message?: string }) => {
      settled = true;
      if (m.ok) resolve({ inWorker: true });
      else reject(new Error(`database snapshot failed: ${m.message}`));
    });
    worker.once('error', (e) => {
      if (!settled) reject(e);
      settled = true;
    });
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`the database snapshot worker stopped (exit ${code})`));
    });
  });
}
