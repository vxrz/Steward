import crypto from 'node:crypto';
import type { ErrorParam, ErrorParams } from '@sm/shared';

export type { ErrorParam, ErrorParams };

export const nowIso = (): string => new Date().toISOString();

export function newId(prefix = ''): string {
  return prefix + crypto.randomBytes(9).toString('base64url');
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Deterministic JSON (sorted keys) used for hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortKeys(val);
    }
    return out;
  }
  return v;
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text == null || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'item'
  );
}

/** Shorten big values for previews; returns [value, truncated]. */
export function preview(value: unknown, maxChars = 20000): [unknown, boolean] {
  if (value === undefined) return [undefined, false];
  const text = JSON.stringify(value);
  if (text === undefined || text.length <= maxChars) return [value, false];
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    let len = 2;
    for (const item of value) {
      const t = JSON.stringify(item) ?? '';
      if (len + t.length > maxChars) break;
      out.push(item);
      len += t.length + 1;
    }
    out.push(`… ${value.length - out.length} more items`);
    return [out, true];
  }
  return [text.slice(0, maxChars) + '…', true];
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('Cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    /** Stable machine-readable code (e.g. WRONG_CREDENTIALS). The web UI shows a translated text for known codes; the message stays English for logs and audit. */
    public code?: string,
    /** Details for the translated text (see ErrorParams); the English message has them already. */
    public params?: ErrorParams,
  ) {
    super(message);
  }
}

/** An error as a nested error parameter: its English message, code and parameters. */
export function errorParam(e: unknown): ErrorParam {
  if (e instanceof HttpError) return { message: e.message, ...(e.code ? { code: e.code } : {}), ...(e.params ? { params: e.params } : {}) };
  return { message: e instanceof Error ? e.message : String(e) };
}
