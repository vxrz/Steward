import { z, type ZodTypeAny } from 'zod';
import {
  COST_BUDGET_SCOPES,
  COST_PLAN_CADENCES,
  COST_PLAN_CATEGORIES,
  COST_PLAN_TARGET_KINDS,
  COST_SCOPES,
  COST_SOURCES,
  FISCAL_YEAR_MAX,
  FISCAL_YEAR_MIN,
} from '@sm/shared';

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
  budgetPct: z
    .number()
    .nullable()
    .describe(
      'This month so far in percent of the monthly budget; null without a budget, or when the token owner does not see every application of the scope (then only budgetState)',
    ),
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
      pct: z.number().nullable().describe('This month so far in percent of the budget; null with stateOnly'),
      forecastPct: z.number().nullable().describe('The forecast of the month in percent of the budget; null with stateOnly'),
      state,
      stateOnly: z
        .boolean()
        .describe(
          'The token owner does not see every application of the service or team: only the state is given (used, pct and forecastPct are null), since the budget covers them all',
        ),
      comment: z.string(),
      updatedAt: ts(),
      updatedBy: z.string(),
    })
    .nullable(),
  canEditBudget: z.boolean(),
  canManageSource: z.boolean(),
});

// ---------- service cost planning (0.16.0, ADR 0026) ----------

const planAmount = (d: string) => z.string().nullable().describe(`${d} – a decimal in the currency; null when the token owner may not see amounts`);
const PlanTarget = z
  .object({
    kind: z.enum(COST_PLAN_TARGET_KINDS),
    id: z.string(),
    name: z.string().describe('Empty when the token owner may not see it'),
    visible: z.boolean(),
    gone: z.boolean().optional().describe('No longer an application or system of the service'),
  })
  .nullable()
  .describe('What it is for: an application or system of the service, or a platform');
const figures = {
  planned: planAmount('Planned for the fiscal year'),
  plannedToDate: planAmount('Planned up to and including the current month'),
  incurredToDate: planAmount('Incurred up to today (entries, and the cloud and platform costs read where shown)'),
  expected: planAmount('Expected for the fiscal year'),
  difference: planAmount('Expected minus planned'),
};

export const CostPlanYear = z.object({
  serviceId: z.string(),
  serviceName: z.string(),
  fiscalYear: z.number().int().describe('The calendar year the fiscal year starts in'),
  label: z.string().describe('"FY 2026" (start January) or "FY 2026/27"'),
  startMonth: z.number().int().describe('The month the fiscal year starts in (1–12), the same for the whole instance'),
  months: z.array(z.string()).describe('The 12 months (YYYY-MM)'),
  currentIndex: z.number().int().describe('Index of the current month in months: -1 before the year, 12 after it'),
  from: z.string().describe('First day (YYYY-MM-DD)'),
  to: z.string().describe('Last day (YYYY-MM-DD)'),
  amountsVisible: z.boolean(),
  canEdit: z.boolean(),
  cloud: z
    .enum(['shown', 'hidden', 'none'])
    .describe('The cloud and platform costs read for the service: hidden when the token owner does not see every application of the service'),
  lines: z.array(
    z.object({
      id: z.string(),
      serviceId: z.string(),
      fiscalYear: z.number().int(),
      title: z.string(),
      category: z.enum(COST_PLAN_CATEGORIES),
      target: PlanTarget,
      vendor: z.string().describe('Vendor or contract (free text)'),
      amount: planAmount('As entered: a year for yearly, a month for monthly, the payment for once'),
      currency: z.string(),
      cadence: z.enum(COST_PLAN_CADENCES),
      onceMonth: z.string().nullable(),
      renewalDate: z.string().nullable(),
      note: z.string(),
      months: z.array(z.string().nullable()).describe('Planned per month'),
      incurredMonths: z.array(z.string().nullable()).describe('Incurred per month'),
      ...figures,
      read: z
        .enum(['matched', 'hidden', 'taken', 'none'])
        .describe(
          'A cloud line for an application or platform takes the costs read for it (matched); hidden: not for this token owner; taken: an older line takes them',
        ),
      entries: z.number().int(),
      createdAt: z.string(),
      createdBy: z.string(),
      updatedAt: z.string(),
      updatedBy: z.string(),
    }),
  ),
  entries: z.array(
    z.object({
      id: z.string(),
      serviceId: z.string(),
      date: z.string(),
      amount: planAmount('The amount (negative: a credit)'),
      currency: z.string(),
      planLineId: z.string().nullable(),
      planLineTitle: z.string().nullable(),
      target: PlanTarget,
      reference: z.string().describe('Invoice or order number'),
      note: z.string(),
      unplanned: z.boolean().describe('No plan line of this fiscal year'),
      planLineYear: z
        .object({ fiscalYear: z.number().int(), label: z.string() })
        .nullable()
        .describe('The fiscal year of its plan line when that is another one (the fiscal year start changed since): the entry counts as unplanned'),
      createdAt: z.string(),
      createdBy: z.string(),
      updatedAt: z.string(),
      updatedBy: z.string(),
    }),
  ),
  currencies: z.array(
    z.object({
      currency: z.string().describe('No conversion between currencies'),
      months: z.array(z.object({ month: z.string(), planned: planAmount('Planned'), incurred: planAmount('Incurred'), read: planAmount('Of which read') })),
      ...figures,
      read: z
        .object({ incurredToDate: planAmount('Read so far'), expected: planAmount('Expected for the year'), months: z.array(z.string().nullable()) })
        .nullable()
        .describe('Cloud and platform costs read for the service that no plan line takes'),
      unplanned: z.object({
        incurredToDate: planAmount('Unplanned entries so far'),
        expected: planAmount('All unplanned entries of the year'),
        count: z.number().int(),
      }),
    }),
  ),
  renewals: z.array(z.object({ lineId: z.string(), title: z.string(), fiscalYear: z.number().int(), renewalDate: z.string(), days: z.number().int() })),
  targets: z.array(z.object({ kind: z.enum(['application', 'system']), id: z.string(), name: z.string() })),
  years: z.array(z.object({ fiscalYear: z.number().int(), label: z.string() })),
  limits: z.object({ linesPerYear: z.number().int(), entriesPerYear: z.number().int() }),
});

export const CostPlanQuery = z.object({
  year: z.coerce
    .number()
    .int()
    .min(FISCAL_YEAR_MIN)
    .max(FISCAL_YEAR_MAX)
    .optional()
    .describe('The fiscal year (the calendar year it starts in); default: the current one'),
});

export const COST_COMPONENTS: Record<string, ZodTypeAny> = { CostOverviewRow, CostScopeDetail, CostPlanYear };

export const CostListQuery = z.object({
  scope: z.enum(COST_SCOPES).default('service').describe('service, application, team or platform'),
  limit,
  cursor,
});
