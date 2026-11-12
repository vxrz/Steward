/** Helpers shared by the /api/v1 route modules: request accessors, paging and visibility checks. */
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as processes from '../../processes/service.js';
import type * as store from '../../engine/store.js';
import { readableRun } from '../../engine/run-access.js';
import { ProblemError } from './problem.js';
import { linkNext } from './pagination.js';
import type { Op } from './routes.js';

export type Get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R) => unknown;

type Q = Record<string, unknown>;
type Paged<T> = { items: T[]; nextCursor: string | null };

export { params } from '../../routes/params.js';
export const query = <T = Q>(req: FastifyRequest) => req.query as T;
export const iso = (s: string | undefined) => (s ? new Date(s).toISOString() : undefined);
export const notFound = (what: string) => new ProblemError(404, { type: 'not-found', title: 'Not found', detail: `${what} not found` });

/** Send a page with an RFC 8288 Link header. */
export function paged<T>(req: FastifyRequest, reply: FastifyReply, page: Paged<T>): Paged<T> {
  linkNext(req, reply, page.nextCursor);
  return page;
}

// ---------- visibility helpers (mirror the internal API) ----------

/** The processes the caller may view (one statement, processes/service.ts), as a list. */
export const visibleProcessIds = (): string[] => [...processes.visibleProcessIds()];

/** A run the caller may read here (engine/run-access.ts: debug runs stay in the app); 404 otherwise. */
export function viewableRun(id: string): store.RunRow {
  const r = readableRun(id);
  if (!r) throw notFound(`Run ${id}`);
  return r;
}
