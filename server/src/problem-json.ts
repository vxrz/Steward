/**
 * Errors of the internal API (/api, used by the web app) as problem details (RFC 9457), like the public API
 * (/api/v1, see api/v1/problem.ts): Content-Type application/problem+json with `type`, `title`, `status`, `detail`
 * and `instance`. The members the web app reads stay as extension members – `error` (the message), `code`,
 * `params`, `issues`, `stepUp` … – and every problem carries the `requestId` to quote (also in X-Request-Id).
 *
 * Routes, hooks and the error handler keep answering `{ error, code, params }`; one onSend hook turns every such
 * answer into a problem, so no error path can be missed. The internal API is private and may change between
 * releases (docs/API.md); integrations use /api/v1.
 */
import { STATUS_CODES } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { BRAND } from '@sm/shared';
import { MCP_PATH } from './mcp/config.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

/** `type` of a coded error: one URN per error code (`urn:steward:error:NOT_SIGNED_IN`); without a code "about:blank". */
export const problemType = (code: unknown): string =>
  typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? `urn:${BRAND.slug}:error:${code}` : 'about:blank';

/** Internal API answers (not /api/v1 – problems of its own – and not the MCP endpoint, which answers JSON-RPC). */
function internalApi(url: string): boolean {
  const path = url.split('?')[0]!;
  if (!path.startsWith('/api/')) return false;
  if (path === '/api/v1' || path.startsWith('/api/v1/')) return false;
  return path !== MCP_PATH;
}

export interface InternalProblem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance: string;
  /** The message, as before (the web app shows it). */
  error: string;
  code?: string;
  params?: Record<string, unknown>;
  requestId: string;
  [extension: string]: unknown;
}

/** The problem for an internal error body `{ error, code?, params?, … }`. */
export function toProblem(body: { error: string; [k: string]: unknown }, status: number, instance: string, requestId: string): InternalProblem {
  const { error, ...rest } = body;
  const standard = { type: problemType(body.code), title: STATUS_CODES[status] ?? 'Error', status, detail: error, instance };
  // the standard members first and never overwritten by an extension member of the same name
  return Object.assign({ ...standard }, rest, standard, { error, requestId }) as InternalProblem;
}

/** onSend hook: an internal API error with a JSON `{ error: … }` body is sent as application/problem+json. */
export async function internalProblemJson(req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  if (reply.statusCode < 400 || typeof payload !== 'string' || !internalApi(req.url)) return payload;
  const type = String(reply.getHeader('content-type') ?? '');
  if (!type.startsWith('application/json')) return payload;
  let body: unknown;
  try {
    body = JSON.parse(payload);
  } catch {
    return payload; // not JSON after all: sent as it is
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof (body as { error?: unknown }).error !== 'string') return payload;
  reply.header('content-type', PROBLEM_CONTENT_TYPE);
  return JSON.stringify(toProblem(body as { error: string }, reply.statusCode, req.url.split('?')[0]!, req.id));
}
