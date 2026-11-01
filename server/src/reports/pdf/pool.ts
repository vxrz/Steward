import * as sea from 'node:sea';
import { Worker } from 'node:worker_threads';
import { config } from '../../config.js';
import { logger } from '../../log.js';
import { HttpError } from '../../util.js';
import type { PdfDrawers } from './drawers.js';

/**
 * PDFs are drawn in a worker thread (#13), one at a time, with a time and a memory limit: a large or unusual
 * document cannot hold up the requests of everyone else, and one that takes too long is stopped. The data is
 * collected in the main thread first; drawing reads no database (forbidDatabase in the worker).
 *
 * SM_PDF_WORKER=auto (default) falls back to drawing in the main thread when the worker cannot start (logged
 * once); "off" always draws in the main thread. Without the worker there is no time limit.
 */

export const PDF_LIMITS = {
  /** The time one PDF may take in the worker */
  timeoutMs: 60_000,
  /** PDFs waiting for their turn; more are refused with 503 PDF_BUSY */
  queue: 20,
  /** Heap of the worker */
  memoryMb: 512,
  /** The time the worker may take to start */
  bootMs: 30_000,
};

export type PdfKind = keyof PdfDrawers;
type Args<K extends PdfKind> = Parameters<PdfDrawers[K]>;
type Result<K extends PdfKind> = Awaited<ReturnType<PdfDrawers[K]>>;

interface Job {
  id: number;
  kind: PdfKind;
  args: unknown[];
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

/** What crosses the thread boundary: Buffers arrive as Uint8Arrays and are turned back into Buffers. */
export function reviveBuffers<T>(v: T): T {
  if (v instanceof Uint8Array) return (Buffer.isBuffer(v) ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength)) as T;
  if (Array.isArray(v)) return v.map(reviveBuffers) as T;
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = reviveBuffers(x);
    return out as T;
  }
  return v;
}

/** An error from the worker, as plain data (HttpError keeps its status, code and parameters). */
export interface WorkerError {
  message: string;
  statusCode?: number;
  code?: string;
  params?: Record<string, unknown>;
  stack?: string;
}
export const toWorkerError = (e: unknown): WorkerError => {
  const err = e as Partial<HttpError> & { message?: string; stack?: string };
  return {
    message: String(err?.message ?? e),
    statusCode: err?.statusCode,
    code: err?.code,
    params: err?.params as Record<string, unknown>,
    stack: err?.stack,
  };
};
const fromWorkerError = (e: WorkerError): Error => {
  if (e.statusCode) {
    // the error as the drawer threw it in the worker (its code is one of the drawer's own)
    const err = new HttpError(e.statusCode, e.message, 'PDF_FAILED');
    err.code = e.code ?? 'PDF_FAILED';
    err.params = e.params as never;
    return err;
  }
  const err = new Error(e.message);
  if (e.stack) err.stack = e.stack;
  return err;
};

let worker: Worker | null = null;
let ready: Promise<boolean> | null = null;
/** The worker could not start: draw in the main thread from now on (logged once) */
let unavailable: string | null = null;
let current: Job | null = null;
/** The worker that reported "ready" (a crash after that is a failing PDF, not a worker that cannot start) */
let booted: Worker | null = null;
/** Sections of scheduled reports the worker knows */
let workerSections = new Set<string>();
let timer: NodeJS.Timeout | null = null;
const waiting: Job[] = [];
let seq = 0;

/** Where the worker's code is: the bundled file in the desktop executable, else the TypeScript entry (run with tsx). */
function workerSource(): { src: string | URL; eval: boolean } {
  if (sourceOverride) return { src: sourceOverride, eval: false };
  // the desktop executable carries the bundled worker as an asset (scripts/build-exe.mjs)
  if (sea.isSea()) return { src: sea.getAsset('pdf-worker.cjs', 'utf8'), eval: true };
  return { src: new URL('./worker-boot.mjs', import.meta.url), eval: false };
}

function start(): Promise<boolean> {
  ready ??= (async () => {
    try {
      const s = workerSource();
      const w = new Worker(s.src, {
        eval: s.eval,
        resourceLimits: { maxOldGenerationSizeMb: PDF_LIMITS.memoryMb },
      });
      worker = w;
      w.unref();
      return await new Promise<boolean>((resolve) => {
        const boot = setTimeout(() => {
          fail(w, `did not start within ${PDF_LIMITS.bootMs / 1000} s`);
          resolve(false);
        }, PDF_LIMITS.bootMs);
        boot.unref();
        w.once('message', (m: { type?: string; sections?: string[] }) => {
          clearTimeout(boot);
          if (m?.type !== 'ready') {
            fail(w, 'answered unexpectedly');
            return resolve(false);
          }
          workerSections = new Set(m.sections ?? []);
          w.on('message', onMessage);
          booted = w;
          resolve(true);
        });
        w.on('error', (e) => {
          clearTimeout(boot);
          onCrash(w, e);
          resolve(false);
        });
        w.on('exit', (code) => {
          clearTimeout(boot);
          onCrash(w, new Error(`exited with code ${code}`));
          resolve(false);
        });
      });
    } catch (e) {
      unavailable = (e as Error).message;
      logger.warn({ err: e }, 'PDF worker unavailable – PDFs are drawn in the main thread');
      return false;
    }
  })();
  return ready;
}

/** The worker could not start (not a failing PDF): from now on, draw in the main thread. */
function fail(w: Worker, why: string): void {
  if (worker !== w) return;
  unavailable = why;
  logger.warn({ reason: why }, 'PDF worker unavailable – PDFs are drawn in the main thread');
  worker = null;
  void w.terminate();
}

/** The worker stopped while it drew (memory limit, crash) or before it was ready. */
function onCrash(w: Worker, e: Error): void {
  if (worker !== w) return;
  worker = null;
  ready = null;
  // before it was ready: the worker cannot start here (the waiting PDF is drawn in the main thread)
  if (booted !== w) {
    if (!unavailable) {
      unavailable = e.message;
      logger.warn({ err: e }, 'PDF worker unavailable – PDFs are drawn in the main thread');
    }
    return;
  }
  const job = current;
  // stopped while idle: a new one starts with the next PDF
  if (!job) return;
  finishCurrent();
  const oom = (e as { code?: string }).code === 'ERR_WORKER_OUT_OF_MEMORY';
  logger.warn({ err: e, kind: job.kind }, 'PDF worker stopped while drawing');
  job.reject(
    oom
      ? new HttpError(422, `The PDF needed more than ${PDF_LIMITS.memoryMb} MB of memory and was stopped – shorten the document`, 'PDF_TOO_LARGE', {
          mb: PDF_LIMITS.memoryMb,
        })
      : new HttpError(500, 'Drawing the PDF failed', 'PDF_FAILED'),
  );
  next();
}

function onMessage(m: { id: number; ok: boolean; result?: unknown; error?: WorkerError }): void {
  const job = current;
  if (!job || m.id !== job.id) return;
  finishCurrent();
  if (m.ok) job.resolve(reviveBuffers(m.result));
  else job.reject(fromWorkerError(m.error!));
  next();
}

function finishCurrent(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  current = null;
  worker?.unref();
}

async function inProcess(job: Job): Promise<void> {
  try {
    const { PDF_DRAWERS } = await import('./drawers.js');
    const draw = PDF_DRAWERS[job.kind] as (...a: unknown[]) => Promise<unknown>;
    job.resolve(await draw(...job.args));
  } catch (e) {
    job.reject(e);
  }
}

/** A scheduled report with a section the worker does not know (registered only in this thread) is drawn here. */
function workerKnows(job: Job): boolean {
  if (job.kind !== 'scheduled') return true;
  const model = job.args[0] as { sections?: { id: string }[] };
  return (model.sections ?? []).every((x) => workerSections.has(x.id));
}

/** The next waiting PDF, one at a time. */
function next(): void {
  if (current) return;
  const job = waiting.shift();
  if (!job) return;
  current = job;
  void (async () => {
    const useWorker = config.pdfWorker === 'auto' && !unavailable && (await start()) && workerKnows(job);
    if (!useWorker || !worker) {
      await inProcess(job);
      finishCurrent();
      return next();
    }
    const w = worker;
    w.ref();
    timer = setTimeout(() => {
      if (current !== job) return;
      worker = null;
      ready = null;
      finishCurrent();
      void w.terminate();
      logger.warn({ kind: job.kind, ms: PDF_LIMITS.timeoutMs }, 'PDF took too long and was stopped');
      job.reject(
        new HttpError(
          422,
          `Creating the PDF took longer than ${PDF_LIMITS.timeoutMs / 1000} s and was stopped – shorten very long text, especially long words without spaces`,
          'PDF_TIMEOUT',
          { seconds: PDF_LIMITS.timeoutMs / 1000 },
        ),
      );
      next();
    }, PDF_LIMITS.timeoutMs);
    try {
      w.postMessage({ id: job.id, kind: job.kind, args: job.args });
    } catch (e) {
      // something in the data cannot be sent to another thread: draw it here
      logger.warn({ err: e, kind: job.kind }, 'PDF data cannot be sent to the worker – drawn in the main thread');
      finishCurrent();
      await inProcess(job);
      next();
    }
  })();
}

/** Draws a PDF (in the worker when it is available), one after the other. */
export function drawPdf<K extends PdfKind>(kind: K, ...args: Args<K>): Promise<Result<K>> {
  if (current && waiting.length >= PDF_LIMITS.queue)
    return Promise.reject(new HttpError(503, 'Steward is creating other PDFs right now – try again in a moment', 'PDF_BUSY'));
  return new Promise<Result<K>>((resolve, reject) => {
    waiting.push({ id: ++seq, kind, args, resolve: resolve as (v: unknown) => void, reject });
    next();
  });
}

/** For tests and the status page: how PDFs are drawn now. */
export function pdfWorkerStatus(): { mode: 'auto' | 'off'; worker: 'running' | 'idle' | 'unavailable' | 'off'; reason: string | null; waiting: number } {
  return {
    mode: config.pdfWorker,
    worker: config.pdfWorker === 'off' ? 'off' : unavailable ? 'unavailable' : worker ? 'running' : 'idle',
    reason: unavailable,
    waiting: waiting.length,
  };
}

/** For tests: another worker file (one that cannot start, say) */
let sourceOverride: URL | null = null;

/** For tests: stop the worker, forget that it was unavailable and optionally start the next one from another file. */
export async function resetPdfWorker(o: { source?: URL } = {}): Promise<void> {
  const w = worker;
  worker = null;
  ready = null;
  booted = null;
  unavailable = null;
  sourceOverride = o.source ?? null;
  if (w) await w.terminate();
}
