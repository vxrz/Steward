import type { DataHealthStatus, GraphHealth } from '@sm/shared';
import type { AuthUser } from '../auth/context.js';

/**
 * The one seam between the pictures (views.ts) and the health of elements and products (WP3, health.ts:
 * `healthOf(user, elementIds, environment)` in bulk). Until that is merged nothing is linked here: every element and
 * product says _No data_ – never OK without a check. When WP3 lands, these two functions call it and nothing else in
 * the views changes.
 */

/** Health of these elements in an environment, by element id (missing: no linked check – the builders say No data). */
export function elementHealth(_u: AuthUser | null, _elementIds: readonly string[], _environment: string): Map<string, GraphHealth> {
  return new Map();
}

/** Health of these products in an environment, by product id (missing: no monitor and no linked check). */
export function productHealth(_u: AuthUser | null, _productIds: readonly string[], _environment: string): Map<string, DataHealthStatus> {
  return new Map();
}
