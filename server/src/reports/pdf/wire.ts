import type { HttpError } from '../../util.js';

/**
 * What crosses the boundary between the main thread and the PDF worker (pool.ts, worker-entry.ts): plain data only.
 * Its own module, so the worker loads it without the pool (configuration, logging, the queue).
 */

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
