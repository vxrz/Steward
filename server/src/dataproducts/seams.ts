import type { AuthUser } from '../auth/context.js';

/**
 * Seams to work packages that are built in parallel (ADR 0036, implementation plan): the MCP tools and /api/v1 of WP7
 * call these, and the integrator points them at WP4's code once it is merged – costs.ts (`get_data_product_costs`)
 * and scorecard.ts (the scorecard summary). Until then they say "not available" and hold nothing.
 */

export interface CostsAnswer {
  available: boolean;
  /** Why there is nothing (until WP4 is merged: not built yet) */
  reason?: string;
  months: { month: string; totals: { currency: string; amount: string }[]; incomplete: boolean }[];
  /** A part the reader may not see makes the totals incomplete – never a figure the hidden part could be computed from */
  incomplete: boolean;
}

/** The attributed costs of a product as `u` may see them (WP4: costs.ts). */
export function productCosts(_u: AuthUser, _productId: string, _environment: string | null, _months: number): CostsAnswer {
  return { available: false, reason: 'Costs per data product are not available on this Steward yet', months: [], incomplete: false };
}

export interface ScorecardSummary {
  available: boolean;
  maturity: number | null;
  parts: { id: string; state: string }[];
}

/** The scorecard of a product in an environment, summed up (WP4: scorecard.ts). */
export function scorecardSummary(_productId: string, _environment: string | null): ScorecardSummary {
  return { available: false, maturity: null, parts: [] };
}
