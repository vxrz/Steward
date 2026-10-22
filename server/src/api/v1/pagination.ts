import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ProblemError } from './problem.js';

/**
 * Cursor pagination: `nextCursor` is opaque base64url(JSON) holding the sort
 * key of the last item and a fingerprint of the filters, so a cursor cannot be
 * combined with different filters. Permission checks run on every page, so a
 * forged cursor reveals nothing.
 */
type Key = (string | number)[];

const filterHash = (filters: Record<string, unknown>): string =>
  crypto
    .createHash('sha256')
    .update(
      JSON.stringify(
        Object.keys(filters)
          .sort()
          .filter((k) => filters[k] !== undefined && k !== 'cursor' && k !== 'limit')
          .map((k) => [k, filters[k]]),
      ),
    )
    .digest('base64url')
    .slice(0, 12);

export function encodeCursor(key: Key, filters: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ v: 1, f: filterHash(filters), k: key })).toString('base64url');
}

export function decodeCursor(cursor: string | undefined, filters: Record<string, unknown>): Key | undefined {
  if (cursor === undefined || cursor === '') return undefined;
  let parsed: { v?: number; f?: string; k?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ProblemError(400, { type: 'invalid-cursor', title: 'Invalid cursor', detail: 'The cursor is malformed – pass `nextCursor` unchanged' });
  }
  if (parsed?.v !== 1 || !Array.isArray(parsed.k) || !parsed.k.every((x) => typeof x === 'string' || typeof x === 'number')) {
    throw new ProblemError(400, { type: 'invalid-cursor', title: 'Invalid cursor', detail: 'The cursor is malformed – pass `nextCursor` unchanged' });
  }
  if (parsed.f !== filterHash(filters)) {
    throw new ProblemError(400, { type: 'invalid-cursor', title: 'Invalid cursor', detail: 'The cursor belongs to a request with different filters' });
  }
  return parsed.k as Key;
}

const cmp = (a: Key, b: Key): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? '';
    const y = b[i] ?? '';
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
};

/** Page through an in-memory list ordered ascending by `keyOf`. */
export function pageArray<T>(all: T[], keyOf: (x: T) => Key, q: { cursor?: string; limit: number }, filters: Record<string, unknown>): { items: T[]; nextCursor: string | null } {
  const after = decodeCursor(q.cursor, filters);
  const sorted = [...all].sort((a, b) => cmp(keyOf(a), keyOf(b)));
  const rest = after ? sorted.filter((x) => cmp(keyOf(x), after) > 0) : sorted;
  const items = rest.slice(0, q.limit);
  const nextCursor = rest.length > q.limit ? encodeCursor(keyOf(items[items.length - 1]!), filters) : null;
  return { items, nextCursor };
}

/** Page from a query that returned up to limit + 1 rows. */
export function pageRows<T>(rows: T[], limit: number, keyOf: (x: T) => Key, filters: Record<string, unknown>): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? encodeCursor(keyOf(items[items.length - 1]!), filters) : null };
}

/** RFC 8288 Link header pointing to the next page (relative URL). */
export function linkNext(req: FastifyRequest, reply: FastifyReply, nextCursor: string | null): void {
  if (!nextCursor) return;
  const url = new URL(req.url, 'http://local');
  url.searchParams.set('cursor', nextCursor);
  reply.header('link', `<${url.pathname}${url.search}>; rel="next"`);
}
