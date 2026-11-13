import type { DataHealthStatus, GraphHealth } from '@sm/shared';
import type { AuthUser } from '../auth/context.js';
import { elementHealthOf, healthOf } from './health.js';

/**
 * The one seam between the pictures (views.ts) and the health of elements and products (health.ts, in bulk: a fixed
 * number of statements however many nodes). Never OK without a check: an element without a running linked check and a
 * product without a monitor or checked output elements say _No data_.
 */

/** Health of these elements, by element id (an element lives in one environment, so the environment is not needed). */
export function elementHealth(u: AuthUser | null, elementIds: readonly string[], _environment: string): Map<string, GraphHealth> {
  const out = new Map<string, GraphHealth>();
  if (!elementIds.length) return out;
  for (const [id, h] of elementHealthOf(u, elementIds)) out.set(id, { status: h.status, checks: h.checks });
  return out;
}

/** Health of these products in an environment, by product id. */
export function productHealth(u: AuthUser | null, productIds: readonly string[], environment: string): Map<string, DataHealthStatus> {
  const out = new Map<string, DataHealthStatus>();
  if (!productIds.length) return out;
  for (const [id, h] of healthOf(u, productIds, environment)) out.set(id, h.status);
  return out;
}
