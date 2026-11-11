import { z, type ZodTypeAny } from 'zod';
import {
  COST_BUDGET_SCOPES,
  COST_PLAN_CADENCES,
  COST_PLAN_CATEGORIES,
  COST_PLAN_TARGET_KINDS,
  COST_SCHEDULE_BILLINGS,
  COST_SCOPES,
  COST_PAYER_KINDS,
  COST_VOLUME_BILLINGS,
  COST_VOLUME_COMMITTED,
  COST_VOLUME_CONSUMPTION,
  COST_VOLUME_PER,
  COST_VOLUME_WARNINGS,
  COST_SOURCES,
  FISCAL_YEAR_MAX,
  FISCAL_YEAR_MIN,
  SUPPLIER_STATUSES,
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
const SupplierRef = z.object({ id: z.string(), name: z.string(), status: z.enum(SUPPLIER_STATUSES) }).nullable();
const ContractRef = z.object({ id: z.string(), title: z.string(), reference: z.string() }).nullable();
const figures = {
  planned: planAmount('Planned for the fiscal year'),
  plannedToDate: planAmount('Planned up to and including the current month'),
  incurredToDate: planAmount('Incurred up to today (entries, and the cloud and platform costs read where shown)'),
  expected: planAmount('Expected for the fiscal year'),
  difference: planAmount('Expected minus planned'),
};

const Payer = z
  .object({ kind: z.enum(COST_PAYER_KINDS), id: z.string(), name: z.string() })
  .describe('Whose plan, or who pays: a service, or a platform (0.19.0, ADR 0032)');

const VolumeStatus = {
  per: z.enum(COST_VOLUME_PER),
  billing: z.enum(COST_VOLUME_BILLINGS),
  committed: z.enum(COST_VOLUME_COMMITTED),
  consumption: z.enum(COST_VOLUME_CONSUMPTION).describe('Where the use comes from: the entries booked to the contract, or the paying platform’s read costs'),
  currency: z.string(),
  period: z.object({ index: z.number().int(), from: z.string(), to: z.string() }).describe('The current period: a contract year or the whole term'),
  amount: planAmount('The volume of the period'),
  minimum: planAmount('What is committed of it (full: the volume; none: 0)'),
  used: planAmount('Used from the period’s first day up to today'),
  left: planAmount('The volume minus what is used'),
  sharePct: z.number().nullable(),
  expectedAtEnd: planAmount('An estimate: the use at the period’s end at the rate of the recent months (null: too early)'),
  runsOutOn: z.string().nullable().describe('An estimate: the day the volume is used up at that rate, when inside the period'),
  ratePerDay: planAmount('Use per day of the estimate’s window'),
  window: z.object({ from: z.string(), to: z.string() }).nullable(),
  warnings: z.array(z.enum(COST_VOLUME_WARNINGS)),
  stateOnly: z.boolean().describe('The use counts entries of services or platforms the token owner may not see: warnings only, no figures'),
};

export const CostPlanYear = z.object({
  owner: Payer,
  serviceId: z.string().describe("The service ('' for a platform's plan)"),
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
      supplier: SupplierRef.describe('The linked supplier (0.17.0; null: none, or one the token owner may not see); vendor is the fallback text'),
      supplierHidden: z.boolean().describe('A supplier is linked that the token owner may not see (0.18.0)'),
      supplierContract: ContractRef.describe('The supplier contract the line pays for'),
      supplierContractHidden: z.boolean().describe('A contract is named that the token owner may not see (0.18.0, ADR 0031): no title or values'),
      supplierContractUncovered: z.boolean().describe('The contract no longer covers the service (0.18.0)'),
      amount: planAmount('As entered: a year for yearly, a month for monthly, the payment for once'),
      currency: z.string(),
      cadence: z.enum(COST_PLAN_CADENCES),
      onceMonth: z.string().nullable(),
      fromMonth: z.string().nullable().describe('Only part of the year (0.18.0): the first month (YYYY-MM); null: the whole year'),
      toMonth: z.string().nullable().describe('Only part of the year (0.18.0): the last month (YYYY-MM); null: the whole year'),
      coversFrom: z.string().nullable().describe('A prepaid one-off payment (0.18.0): the first day it covers'),
      coversTo: z.string().nullable().describe('A prepaid one-off payment: the last day it covers'),
      renewalDate: z.string().nullable(),
      note: z.string(),
      schedule: z
        .object({ id: z.string(), contractId: z.string(), title: z.string(), changed: z.boolean() })
        .nullable()
        .describe('The payment schedule of a supplier contract the line was made from (0.18.0); changed: the contract changed since (Contract changed)'),
      contractEnds: z.string().nullable().describe('A line naming a contract without a schedule: the end of its contract when it falls in this fiscal year'),
      twoLines: z.boolean().describe('A hand-made line for a contract that also has a payment schedule paying in this year'),
      paymentDates: z.array(z.string().nullable()).nullable().describe('A schedule line: the payment date in each month of the year (null: no payment)'),
      volume: z
        .object({
          billing: z.enum(COST_VOLUME_BILLINGS),
          consumption: z.enum(COST_VOLUME_CONSUMPTION),
          suggested: planAmount('Book: the average use per month so far'),
        })
        .nullable()
        .describe('A line of a volume schedule (0.19.0)'),
      bookable: z.boolean().describe('Monthly, quarterly and one-off lines with a payment: a person can book them'),
      notBooked: z.array(z.string()).describe('Months (YYYY-MM) up to the current one with a planned payment and no entry on the line'),
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
      supplier: SupplierRef.describe('The supplier (0.18.0; null: none, or one the token owner may not see)'),
      supplierHidden: z.boolean().describe('A supplier is linked that the token owner may not see'),
      supplierContract: ContractRef.describe('The supplier contract'),
      supplierContractHidden: z.boolean().describe('A contract is named that the token owner may not see (0.18.0, ADR 0031)'),
      supplierContractUncovered: z.boolean().describe('The contract no longer covers the service (0.18.0)'),
      importId: z.string().nullable().describe('The CSV import the entry came from (0.18.0)'),
      reference: z.string().describe('Invoice or order number'),
      note: z.string(),
      unplanned: z.boolean().describe('No plan line of this fiscal year'),
      drawn: planAmount('The part drawn from a prepaid volume of its contract (0.19.0): not counted as incurred again'),
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
      drawn: z
        .object({ toDate: planAmount('Drawn so far'), months: z.array(z.string().nullable()) })
        .nullable()
        .describe('Use drawn from prepaid volumes (read costs, entries): shown, not counted as incurred (0.19.0)'),
    }),
  ),
  renewals: z.array(z.object({ lineId: z.string(), title: z.string(), fiscalYear: z.number().int(), renewalDate: z.string(), days: z.number().int() })),
  targets: z.array(z.object({ kind: z.enum(['application', 'system']), id: z.string(), name: z.string() })),
  volumes: z
    .array(z.object({ scheduleId: z.string(), title: z.string(), contractId: z.string(), contractHidden: z.boolean(), ...VolumeStatus }))
    .describe('The volume schedules the plan’s owner pays, each with its current period (0.19.0)'),
  years: z.array(z.object({ fiscalYear: z.number().int(), label: z.string() })),
  limits: z.object({ linesPerYear: z.number().int(), entriesPerYear: z.number().int() }),
  prepaid: z
    .array(
      z.object({
        lineId: z.string(),
        title: z.string(),
        fiscalYear: z.number().int(),
        label: z.string(),
        amount: planAmount('The prepaid amount'),
        currency: z.string(),
        coversFrom: z.string(),
        coversTo: z.string(),
      }),
    )
    .describe('Payments of earlier fiscal years that cover part of this one (prepaid): shown, not counted'),
  proposals: z.number().int().describe('Payment schedules of the service with payments in this year and no lines for it yet'),
  contractChanges: z
    .array(z.object({ scheduleId: z.string(), title: z.string(), changes: z.array(z.object({}).passthrough()) }))
    .describe('Contract changed: per payment schedule, its lines before and after (current and later fiscal years)'),
  commitments: z.array(z.object({}).passthrough()).optional().describe("The service's commitments (as GET /api/v1/cost-commitments rows)"),
});

export const CostPlanQuery = z.object({
  fiscalYear: z.coerce
    .number()
    .int()
    .min(FISCAL_YEAR_MIN)
    .max(FISCAL_YEAR_MAX)
    .optional()
    .describe('The fiscal year (the calendar year it starts in); default: the current one'),
});

// ---------- commitments (0.18.0, ADR 0030) ----------

const owed = (d: string) =>
  z.string().nullable().describe(`${d} – a decimal in the schedule's currency; null when the token owner may not see the paying service's amounts`);

export const CostCommitment = z.object({
  scheduleId: z.string(),
  title: z.string().describe('The payment schedule'),
  serviceId: z.string().describe("The paying service ('' when a platform pays)"),
  serviceName: z.string(),
  payer: Payer,
  teams: z.array(z.object({ id: z.string(), name: z.string() })).describe("The payer's owning teams"),
  supplier: SupplierRef.describe('null with contractHidden: a contract of a supplier the token owner may not see'),
  contract: ContractRef,
  contractHidden: z.boolean(),
  billing: z.enum(COST_SCHEDULE_BILLINGS),
  currency: z.string().describe('ISO 4217 code (never converted)'),
  amountsVisible: z.boolean(),
  nextPayment: z.object({ date: z.string(), amount: owed('The next payment') }).nullable(),
  owedThisYear: owed('Owed in the current fiscal year from today (to contract end)'),
  owedLaterYears: owed('Owed in the later fiscal years (to contract end)'),
  toContractEnd: owed("Scheduled payments dated today or later up to the schedule's or the contract's end (automatic renewal: the earliest exit)"),
  toEarliestExit: owed('Scheduled payments dated today or later up to the end of the term after the next notice-by date'),
  contractEnd: z.string().nullable(),
  earliestExit: z.string().nullable(),
  years: z.array(owed('To contract end in a fiscal year')).describe('The current fiscal year and the next four'),
  later: owed('To contract end after those five fiscal years'),
  noticeBy: z.string().nullable().describe("The contract's next notice-by date"),
  warning: z
    .object({ noticeBy: z.string(), fiscalYear: z.number().int(), label: z.string(), days: z.number().int(), soon: z.boolean() })
    .nullable()
    .describe('The notice-by date is ahead and the fiscal year of the next term has no plan lines of the paying service (soon: within 90 days)'),
  changed: z.boolean().describe('Lines of the current or a later fiscal year made from it show "Contract changed"'),
  notBooked: z.array(z.string()).describe('Months of the current fiscal year with a payment of its lines and no entry'),
  upTo: owed('A volume that is not fully committed: what it may still bill at most beyond what is owed – never part of what is owed (0.19.0)'),
  volume: z.object(VolumeStatus).nullable().describe("A volume's current period (0.19.0)"),
});

const attrAmount = (d: string) => z.string().nullable().describe(`${d} – null when the token owner may not see the service's amounts`);
export const CostAttribution = z.object({
  kind: z.enum(['application', 'system']),
  id: z.string(),
  name: z.string(),
  fiscalYear: z.number().int(),
  label: z.string(),
  years: z.array(z.object({ fiscalYear: z.number().int(), label: z.string() })),
  contracts: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      reference: z.string(),
      supplier: SupplierRef,
      endsOn: z.string().nullable(),
      services: z.array(z.object({ id: z.string(), name: z.string(), purpose: z.string() })),
      named: z.boolean().describe('Named on the contract for a covered service; else only through a line, entry or schedule'),
    }),
  ),
  lines: z.array(
    z.object({
      id: z.string(),
      serviceId: z.string(),
      serviceName: z.string(),
      title: z.string(),
      category: z.enum(COST_PLAN_CATEGORIES),
      cadence: z.enum(COST_PLAN_CADENCES),
      currency: z.string(),
      amount: attrAmount('As entered'),
      planned: attrAmount('Planned for the fiscal year'),
      contract: z.object({ id: z.string(), title: z.string() }).nullable(),
      contractHidden: z.boolean(),
    }),
  ),
  entries: z.array(
    z.object({
      id: z.string(),
      serviceId: z.string(),
      serviceName: z.string(),
      date: z.string(),
      currency: z.string(),
      amount: attrAmount('The amount'),
      reference: z.string(),
      planLineTitle: z.string().nullable(),
    }),
  ),
  schedules: z.array(
    z.object({
      id: z.string(),
      serviceId: z.string(),
      serviceName: z.string(),
      title: z.string(),
      billing: z.string(),
      currency: z.string(),
      amount: attrAmount('Per payment in contract year 1, or the volume'),
      contract: z.object({ id: z.string(), title: z.string() }).nullable(),
      contractHidden: z.boolean(),
    }),
  ),
  totals: z.array(z.object({ fiscalYear: z.number().int(), label: z.string(), currency: z.string(), planned: z.string(), incurred: z.string() })),
  amountsHidden: z.boolean(),
});

export const CostCommitmentsQuery = z.object({
  serviceId: z.string().max(100).optional().describe('Only this service'),
  platformId: z.string().max(100).optional().describe('Only the schedules this platform pays (0.19.0)'),
  teamId: z.string().max(100).optional().describe("Only this team's services and platforms"),
  supplierId: z.string().max(100).optional().describe("Only this supplier's contracts"),
  currency: z.string().length(3).optional().describe('Only this currency'),
  limit,
  cursor,
});

export const COST_COMPONENTS: Record<string, ZodTypeAny> = { CostOverviewRow, CostScopeDetail, CostPlanYear, CostCommitment, CostAttribution };

export const CostListQuery = z.object({
  scope: z.enum(COST_SCOPES).default('service').describe('service, application, team or platform'),
  limit,
  cursor,
});
