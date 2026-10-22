import { STATUS_CODES } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { BRAND } from '@sm/shared';

/**
 * Errors of the public API are problem details (RFC 9457) with
 * Content-Type application/problem+json. `type` points to the matching
 * section of docs/API.md; generic HTTP errors use "about:blank".
 */
export const PROBLEM_BASE = `${BRAND.repoUrl}/blob/main/docs/API.md#`;

export type ProblemType =
  | 'invalid-token'
  | 'token-required'
  | 'owner-disabled'
  | 'forbidden'
  | 'password-change-required'
  | 'not-found'
  | 'validation-error'
  | 'invalid-cursor'
  | 'dataset-changed'
  | 'rate-limited'
  | 'vault-locked'
  | 'token-in-url'
  | 'method-not-allowed'
  | 'token-scope';

export interface ProblemInit {
  type?: ProblemType;
  title?: string;
  detail?: string;
  errors?: { in: string; name: string; message: string }[];
}

export interface Problem extends Omit<ProblemInit, 'type'> {
  type: string;
  title: string;
  status: number;
  instance: string;
}

/** Thrown inside handlers; rendered by the API's error handler. */
export class ProblemError extends Error {
  constructor(
    public status: number,
    public init: ProblemInit = {},
  ) {
    super(init.detail ?? STATUS_CODES[status] ?? 'Error');
  }
}

export function problemBody(req: FastifyRequest, status: number, init: ProblemInit = {}): Problem {
  return {
    type: init.type ? PROBLEM_BASE + init.type : 'about:blank',
    title: init.title ?? STATUS_CODES[status] ?? 'Error',
    status,
    ...(init.detail ? { detail: init.detail } : {}),
    instance: req.url.split('?')[0]!,
    ...(init.errors ? { errors: init.errors } : {}),
  };
}

export function sendProblem(req: FastifyRequest, reply: FastifyReply, status: number, init: ProblemInit = {}): FastifyReply {
  // Pre-serialised: problem bodies bypass the route's 200 response schema.
  return reply.code(status).type('application/problem+json; charset=utf-8').send(JSON.stringify(problemBody(req, status, init)));
}
