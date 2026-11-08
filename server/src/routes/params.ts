import type { FastifyRequest } from 'fastify';

/** The path parameters of a request (`/runs/:id` → `params(req).id`); Fastify types them as unknown. */
export const params = (req: FastifyRequest) => req.params as Record<string, string>;
