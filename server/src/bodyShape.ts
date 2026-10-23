import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';
import { HttpError } from './util.js';

/**
 * Limits on the shape of a parsed request body, checked before any route validates it.
 *
 * Zod (3.x, and 4.x on arrays without `.max()`) checks every element of an array, and every value of a
 * record, and keeps one issue object per failing element – also when the array is longer than its
 * `.max()`. A 23 MB body with one array of 12 million numbers made the server allocate 3 GB
 * (GHSA-mrhx-c7xc-m3w5). Counting the values first is linear and allocates nothing per value, so a
 * body within these limits can only produce a bounded number of issues, whatever the schema.
 */
export interface BodyShapeLimits {
  /** Items in one array */
  arrayItems: number;
  /** Keys of one object */
  objectKeys: number;
  /** All values in the body (objects, arrays and scalars) */
  values: number;
  /** Nesting depth of objects and arrays */
  depth: number;
}

/** Every JSON route: well above the largest array a schema accepts (5,000) and any form or editor payload. */
export const DEFAULT_BODY_SHAPE: BodyShapeLimits = { arrayItems: 10_000, objectKeys: 10_000, values: 200_000, depth: 100 };

/** Import routes (bundles, platform types, monitors): an export of a large installation in one request. */
export const IMPORT_BODY_SHAPE: BodyShapeLimits = { arrayItems: 50_000, objectKeys: 50_000, values: 1_000_000, depth: 100 };

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Larger limits for the parsed body of this route (see bodyShape.ts) */
    smBodyShape?: BodyShapeLimits;
  }
}

/** The first limit the value exceeds (with that limit), or null. Iterative: deep nesting can't overflow the stack. */
export function bodyShapeProblem(body: unknown, limits: BodyShapeLimits): { limit: keyof BodyShapeLimits; max: number } | null {
  if (body === null || typeof body !== 'object' || Buffer.isBuffer(body)) return null;
  const stack: { value: object; depth: number }[] = [{ value: body, depth: 1 }];
  let values = 1;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (depth > limits.depth) return { limit: 'depth', max: limits.depth };
    const children = Array.isArray(value) ? value : Object.values(value);
    if (Array.isArray(value) ? value.length > limits.arrayItems : children.length > limits.objectKeys) {
      return Array.isArray(value) ? { limit: 'arrayItems', max: limits.arrayItems } : { limit: 'objectKeys', max: limits.objectKeys };
    }
    values += children.length;
    if (values > limits.values) return { limit: 'values', max: limits.values };
    for (const child of children) if (child !== null && typeof child === 'object') stack.push({ value: child, depth: depth + 1 });
  }
  return null;
}

/** preValidation hook: refuses a parsed body over the route's limits with 413 BODY_TOO_COMPLEX. */
export function checkBodyShape(req: FastifyRequest, _reply: FastifyReply, done: HookHandlerDoneFunction): void {
  const problem = bodyShapeProblem(req.body, req.routeOptions.config?.smBodyShape ?? DEFAULT_BODY_SHAPE);
  if (!problem) return done();
  const what = { arrayItems: 'items in one list', objectKeys: 'fields in one object', values: 'values', depth: 'levels of nesting' }[problem.limit];
  done(new HttpError(413, `Request body has more than ${problem.max} ${what} – split it into smaller requests`, 'BODY_TOO_COMPLEX', { limit: problem.max }));
}
