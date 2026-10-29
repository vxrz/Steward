import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Credential } from '@sm/shared';
import { CredentialListQuery } from './api-schemas.js';
import { HttpError } from '../util.js';
import { ProblemError } from '../api/v1/problem.js';
import { linkNext, pageArray } from '../api/v1/pagination.js';
import type { Op } from '../api/v1/routes.js';
import * as svc from './service.js';

/**
 * The credentials register in the public, read-only API. Documentation only –
 * there are no secret values in the register. Same visibility as in the UI.
 */
type Get = <R>(url: string, op: Op, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<R> | R) => unknown;

const map = (c: Credential) => {
  const { permissions: _p, gatus: _g, reminders: _r, notes: _n, version: _v, ...rest } = c;
  return rest;
};

export function credentialApiRoutes(get: Get): void {
  get(
    '/credentials',
    {
      operationId: 'listCredentials',
      tag: 'Credentials',
      summary: 'List entries of the credentials register',
      description:
        'Documentation of credentials: type, platform, owners, where they are kept, expiry, rotation and review dates. The register never holds secret values. Ordered by name. Visible to all roles except viewers (who see only entries they own).',
      query: CredentialListQuery,
      paginated: true,
      response: {
        type: 'object',
        required: ['items', 'nextCursor'],
        properties: { items: { type: 'array', items: { $ref: 'CredentialEntry#' } }, nextCursor: { type: ['string', 'null'] } },
        additionalProperties: false,
      },
    },
    async (req, reply) => {
      const q = req.query as z.infer<typeof CredentialListQuery>;
      const list = svc
        .listCredentials({
          status: q.status,
          type: q.type,
          platform: q.platform,
          dueWithinDays: q.dueWithinDays,
          archived: q.archived,
          q: q.q,
          role: q.role,
          belongs: q.belongs,
          tag: q.tag,
        })
        .map(map);
      const page = pageArray(list, (c) => [c.name.toLowerCase(), c.id], q, q);
      linkNext(req, reply, page.nextCursor);
      return page;
    },
  );

  get(
    '/credentials/:credentialId',
    {
      operationId: 'getCredential',
      tag: 'Credentials',
      summary: 'Get an entry of the credentials register',
      params: { credentialId: 'Entry id (cred_…)' },
      response: { $ref: 'CredentialEntry#' },
    },
    async (req) => {
      try {
        return map(svc.getCredential((req.params as { credentialId: string }).credentialId));
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 404)
          throw new ProblemError(404, { type: 'not-found', title: 'Not found', detail: 'Credential not found' });
        throw e;
      }
    },
  );
}
