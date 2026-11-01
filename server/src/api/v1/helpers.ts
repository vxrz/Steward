/** Helpers shared by the /api/v1 route modules: request accessors, paging and visibility checks. */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../../db.js';
import * as processes from '../../processes/service.js';
import * as store from '../../engine/store.js';
import { ProblemError } from './problem.js';
import { linkNext } from './pagination.js';
import type { Op } from './routes.js';

export type Get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R) => unknown;

type Q = Record<string, unknown>;
type Paged<T> = { items: T[]; nextCursor: string | null };

export const params = (req: FastifyRequest) => req.params as Record<string, string>;
export const query = <T = Q>(req: FastifyRequest) => req.query as T;
export const iso = (s: string | undefined) => (s ? new Date(s).toISOString() : undefined);
export const notFound = (what: string) => new ProblemError(404, { type: 'not-found', title: 'Not found', detail: `${what} not found` });

/** Send a page with an RFC 8288 Link header. */
export function paged<T>(req: FastifyRequest, reply: FastifyReply, page: Paged<T>): Paged<T> {
  linkNext(req, reply, page.nextCursor);
  return page;
}

// ---------- visibility helpers (mirror the internal API) ----------

export function visibleProcessIds(): string[] {
  return db()
    .all<{ id: string }>('SELECT id FROM processes')
    .map((r) => r.id)
    .filter((id) => processes.permissionsFor(id).includes('view'));
}

export function viewableRun(id: string): store.RunRow {
  let r: store.RunRow;
  try {
    r = store.runRow(id);
  } catch {
    throw notFound(`Run ${id}`);
  }
  if (!processes.permissionsFor(r.process_id).includes('view')) throw notFound(`Run ${id}`);
  return r;
}
