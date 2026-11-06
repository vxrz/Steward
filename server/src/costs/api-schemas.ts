import { z, type ZodTypeAny } from 'zod';
import { COST_BUDGET_SCOPES, COST_SCOPES, COST_SOURCES } from '@sm/shared';

/** Response and query schemas of platform costs in the public API (/api/v1/costs, #226). */

const ts = () => z.string().datetime({ offset: true }).describe('ISO 8601 timestamp (UTC)');
const limit = z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)');
const cursor = z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)');
const amount = (d: string) =>
  z.string().nullable().describe(`${d} – a decimal (e.g. "1840.00"), in the row's currency; null when the token owner may not see amounts`);
const state = z.enum(['ok', 'warning', 'exceeded']);

export const CostOverviewRow = z.object({
  scope: z.enum(COST_SCOPES),
  id: z.string(),
  name: z.string(),
  currency: z.string().describe('ISO 4217 currency code (no conversion between currencies); empty when there are no costs yet'),
  amountsVisible: z.boolean().describe('The token owner may see the amounts (else only percentages and states)'),
  thisMonth: amount('EffectiveCost of the current month so far'),
  lastMonth: amount('EffectiveCost of the last month'),
  forecast: amount('The current month projected from its days so far'),
  changePct: z.number().nullable().describe('The forecast against the last month, in percent'),
  unassigned: amount('Platforms: the costs of this month that no application is linked to'),
  budgetPct: z.number().nullable().describe('This month so far in percent of the monthly budget'),
  budgetState: state.nullable(),
});

const Month = z.object({
  month: z.string().describe('YYYY-MM (UTC); the last one is the current month so far'),
  amount: amount('EffectiveCost'),
  billed: amount('BilledCost'),
});

export const CostScopeDetail = z.object({
  scope: z.enum(COST_SCOPES),
  id: z.string(),
  name: z.string(),
  amountsVisible: z.boolean(),
  month: z.string().describe('The current month (UTC), YYYY-MM'),
  currencies: z.array(
    z.object({
      currency: z.string(),
      months: z.array(Month).describe('The 12 complete months before the current one, and the current one'),
      thisMonth: amount('This month so far'),
      lastMonth: amount('The last month'),
      forecast: amount('The current month projected from its days so far (from the 3rd day)'),
      changePct: z.number().nullable(),
      trend: z
        .object({
          perMonth: amount('Change per month of the trend line'),
          changePctPerMonth: z.number().nullable(),
          confidence: z.enum(['stable', 'rough']),
          months: z.number().int(),
        })
        .nullable()
        .describe('Theil–Sen line through the complete months (at least 5)'),
    }),
  ),
  unassigned: z.array(z.object({ currency: z.string(), thisMonth: amount('This month'), lastMonth: amount('Last month') })),
  byService: z.array(
    z.object({
      provider: z.string().describe('FOCUS ProviderName'),
      service: z.string().describe('FOCUS ServiceName'),
      category: z.string().describe('FOCUS ServiceCategory'),
      currency: z.string(),
      thisMonth: amount('This month'),
      lastMonth: amount('Last month'),
    }),
  ),
  parts: z
    .array(
      z.object({
        kind: z.enum(['application', 'platform', 'other', 'unassigned']),
        id: z.string().nullable(),
        name: z.string().describe('Empty for "other" (what the token owner may not see) and unassigned lines of hidden platforms'),
        currency: z.string(),
        thisMonth: amount('This month'),
        lastMonth: amount('Last month'),
      }),
    )
    .describe('The applications (of a service, team or platform) or platforms (of an application) behind the costs'),
  sources: z.array(z.object({ platformId: z.string(), platformName: z.string(), source: z.enum(COST_SOURCES), readAt: ts().nullable() })),
  budget: z
    .object({
      scope: z.enum(COST_BUDGET_SCOPES),
      scopeId: z.string(),
      amount: amount('The monthly budget'),
      currency: z.string(),
      used: amount('This month so far'),
      pct: z.number(),
      forecastPct: z.number().nullable(),
      state,
      comment: z.string(),
      updatedAt: ts(),
      updatedBy: z.string(),
    })
    .nullable(),
  canEditBudget: z.boolean(),
  canManageSource: z.boolean(),
});

export const COST_COMPONENTS: Record<string, ZodTypeAny> = { CostOverviewRow, CostScopeDetail };

export const CostListQuery = z.object({
  scope: z.enum(COST_SCOPES).default('service').describe('service, application, team or platform'),
  limit,
  cursor,
});
