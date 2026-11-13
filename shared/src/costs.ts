import { z } from 'zod';

/**
 * Platform costs (0.9.0, #226, docs/COSTS.md): one cost model for AWS, Snowflake, Confluent Cloud, AI gateways and
 * FOCUS file imports – showback per service, application, team and platform, not FinOps.
 *
 * Every cost line carries a subset of the columns of the FinOps Open Cost and Usage Specification (FOCUS 1.x, FinOps
 * Foundation): BillingPeriodStart/End, ChargePeriodStart/End, BilledCost, EffectiveCost, BillingCurrency,
 * ProviderName, ServiceName, ServiceCategory, ResourceId, ResourceName, SubAccountId, ChargeCategory and Tags – plus
 * Steward's links (platform, component, application; services and owning teams follow from the application).
 *
 * Amounts are decimals with their currency. They are kept as whole millionths of the currency unit ("micros", an
 * integer – never a binary float) and travel as decimal strings ("1840.00"). There is no conversion between
 * currencies: totals are per currency.
 */

export const COST_SOURCES = ['aws', 'snowflake', 'confluent', 'ai', 'focus'] as const;
export type CostSource = (typeof COST_SOURCES)[number];

/** What costs are shown for. */
export const COST_SCOPES = ['service', 'application', 'team', 'platform'] as const;
export type CostScope = (typeof COST_SCOPES)[number];

/** What a budget can be set for. */
export const COST_BUDGET_SCOPES = ['service', 'application', 'team'] as const;
export type CostBudgetScope = (typeof COST_BUDGET_SCOPES)[number];

export const COST_GRANULARITIES = ['day', 'month'] as const;
export type CostGranularity = (typeof COST_GRANULARITIES)[number];

/** A notice goes out at 80 % and at 100 % of a monthly budget (once per budget, month and level). */
export const COST_BUDGET_WARN_PCT = 80;

/** The built-in dataset "Costs" (administrators and auditors, like the AI usage). */
export const COSTS_DATASET = 'costs.overview';
/** The built-in dataset "Cost plans" (ADR 0026): the services' plans of the current fiscal year, administrators and auditors. */
export const COST_PLANS_DATASET = 'costs.plans';

export const COST_LIMITS = {
  /** Months shown (complete months before the current one) */
  months: 12,
  /** A FOCUS file at most (uploaded or pushed) */
  importBytes: 25 * 1024 * 1024,
  /** Rows of a FOCUS file at most */
  importRows: 500_000,
  /** Columns of a FOCUS file at most */
  importColumns: 300,
  /** Characters of one cell at most (longer: the file is refused) */
  cellChars: 16_000,
  /** Tags kept per line, and characters per key and value */
  tags: 50,
  tagChars: 256,
  /** Rows shown in an import preview */
  previewRows: 20,
  /** Characters of a text column kept (provider, service, resource …) */
  textChars: 400,
  /** Imports listed per platform */
  importsListed: 50,
  /** Push tokens per platform */
  pushTokensPerTarget: 10,
  /** An amount at most, in the currency unit (keeps every sum exact in JavaScript numbers) */
  maxAmount: 1_000_000_000,
  /** Days a source re-reads (late and corrected figures: AWS and Snowflake change for up to 72 hours and until month close) */
  rereadDays: 35,
} as const;

/** ISO 4217 currency codes: three upper-case letters (plus the few that sources write in lower case). */
export const currencyCode = z
  .string()
  .trim()
  .length(3)
  .transform((s) => s.toUpperCase())
  .refine((s) => /^[A-Z]{3}$/.test(s), 'a currency code like EUR or USD');

/**
 * The ISO 4217 currency codes (the list of the ISO 4217 maintenance agency, including funds codes and precious metals,
 * and codes withdrawn in recent years – HRK, SLL, BGN … – that earlier entries may use; without XTS and XXX, which are
 * no currency). Static, so the browser and the server agree whatever their ICU data knows.
 */
export const ISO_4217_CODES: ReadonlySet<string> = new Set(
  (
    'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW ' +
    'CLF CLP CNY COP COU CRC CUC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HRK ' +
    'HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK ' +
    'MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD ' +
    'SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW UZS ' +
    'VED VES VND VUV WST XAF XAG XAU XBA XBB XBC XBD XCD XCG XDR XOF XPD XPF XPT XSU XUA YER ZAR ZMW ZWG ZWL'
  ).split(' '),
);

/** An ISO 4217 code from the list above – for amounts typed by hand (cost plans), where a typo would open a currency of its own. */
export const isoCurrencyCode = currencyCode.refine((s) => ISO_4217_CODES.has(s), 'an ISO 4217 currency code like EUR or USD');

/**
 * The minor units (decimals) of the ISO 4217 currencies that do not have two (0.18.0): no decimals for the yen, the
 * won, the króna, the Chilean peso, the dong …, three for the dinars of Bahrain, Iraq, Jordan, Kuwait, Libya and
 * Tunisia and the Omani rial, four for the Chilean and Uruguayan units of account. Every other code has two – also the
 * funds codes and precious metals, which ISO 4217 gives none (N.A.). Static, like ISO_4217_CODES.
 */
export const CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4,
};

/** The decimals of a currency's amounts: 0 for JPY, 3 for KWD, 2 for EUR and any other or unknown code. */
export const currencyMinorUnits = (currency: string): number => CURRENCY_MINOR_UNITS[currency.trim().toUpperCase()] ?? 2;

// ---------- decimals ----------

const MICROS = 1_000_000n;
const MAX_MICROS = BigInt(COST_LIMITS.maxAmount) * MICROS;

/**
 * A decimal number as text ("1840.0000000000", "-12.5", "1.2E-5", "  3 ") → whole millionths, rounded half away from
 * zero; null when it is not a number or larger than COST_LIMITS.maxAmount. Parsed character by character (no regular
 * expression on the input).
 */
export function toMicros(text: string | number | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  let s = typeof text === 'number' ? (Number.isFinite(text) ? String(text) : '') : String(text).trim();
  if (!s || s.length > 64) return null;
  let neg = false;
  if (s[0] === '-' || s[0] === '+') {
    neg = s[0] === '-';
    s = s.slice(1);
  }
  let exp = 0;
  const e = s.search(/[eE]/);
  if (e >= 0) {
    const ex = s.slice(e + 1);
    s = s.slice(0, e);
    let i = 0;
    let eneg = false;
    if (ex[0] === '-' || ex[0] === '+') {
      eneg = ex[0] === '-';
      i = 1;
    }
    if (i >= ex.length || ex.length - i > 3) return null;
    for (let k = i; k < ex.length; k++) if (ex[k]! < '0' || ex[k]! > '9') return null;
    exp = Number(ex.slice(i)) * (eneg ? -1 : 1);
  }
  let int = '';
  let frac = '';
  let dot = false;
  for (const ch of s) {
    if (ch === '.') {
      if (dot) return null;
      dot = true;
    } else if (ch >= '0' && ch <= '9') {
      if (dot) frac += ch;
      else int += ch;
    } else return null;
  }
  if (!int && !frac) return null;
  // move the decimal point by the exponent
  let digits = int + frac;
  let point = int.length + exp;
  if (point < 0) {
    digits = '0'.repeat(-point) + digits;
    point = 0;
  }
  if (point > digits.length) digits += '0'.repeat(point - digits.length);
  const whole = digits.slice(0, point) || '0';
  const rest = digits.slice(point);
  if (whole.replace(/^0+/, '').length > 12) return null;
  let micros = BigInt(whole) * MICROS + BigInt((rest + '000000').slice(0, 6));
  if (rest.length > 6 && rest[6]! >= '5') micros += 1n;
  if (micros > MAX_MICROS) return null;
  return Number(neg ? -micros : micros);
}

/** Whole millionths → a decimal string with at least `min` (default 2) and at most 6 decimals: 1840000000 → "1840.00". */
export function fromMicros(micros: number, min = 2): string {
  const neg = micros < 0;
  const abs = BigInt(Math.round(Math.abs(micros)));
  const whole = (abs / MICROS).toString();
  let frac = (abs % MICROS).toString().padStart(6, '0');
  while (frac.length > min && frac.endsWith('0')) frac = frac.slice(0, -1);
  return `${neg && abs !== 0n ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/**
 * Whole millionths rounded (half away from zero) to the minor units of the currency: 1500.5 JPY → 1501 JPY. The one
 * rounding of amounts to their currency – display, CSV and the check of typed amounts (fitsCurrency) use it.
 */
export function roundToCurrency(micros: number, currency: string): number {
  const unit = 10 ** (6 - currencyMinorUnits(currency));
  const r = Math.round(Math.abs(micros) / unit) * unit;
  return micros < 0 && r !== 0 ? -r : r;
}

/**
 * Whole millionths → a decimal string with exactly the currency's minor units, rounded: "1501" for JPY, "8333.33"
 * for EUR, "12.500" for KWD – how amounts are shown and written to CSV (the API keeps every decimal).
 */
export const fromMicrosIn = (micros: number, currency: string): string => fromMicros(roundToCurrency(micros, currency), currencyMinorUnits(currency));

/** "1501 JPY" – an amount with its code for texts (audit summaries, notifications, monitor messages). */
export const moneyText = (micros: number, currency: string): string => `${fromMicrosIn(micros, currency)} ${currency}`;

/** Whether an amount has no more decimals than its currency has minor units (1500.50 JPY has too many): rounding keeps it. */
export const fitsCurrency = (micros: number, currency: string): boolean => roundToCurrency(micros, currency) === micros;

/** The zod issue for an amount with more decimals than its currency allows (path `amount`). */
export function checkCurrencyDecimals(x: { amount: string | null; currency: string }, ctx: z.RefinementCtx): void {
  const micros = x.amount === null ? null : toMicros(x.amount);
  if (micros === null || fitsCurrency(micros, x.currency)) return;
  const n = currencyMinorUnits(x.currency);
  ctx.addIssue({
    code: 'custom',
    path: ['amount'],
    message: n ? `at most ${n} decimals for ${x.currency}` : `a whole amount: ${x.currency} has no decimals`,
  });
}

// ---------- FOCUS columns ----------

/**
 * The FOCUS columns Steward reads from a file (FOCUS 1.x column ids). Required: BilledCost, BillingCurrency,
 * ChargePeriodStart, ChargePeriodEnd. ServiceProviderName (FOCUS 1.3) is read where ProviderName is missing. Other
 * columns, and custom columns (x_…), are ignored.
 */
export const FOCUS_COLUMNS = [
  'BillingPeriodStart',
  'BillingPeriodEnd',
  'ChargePeriodStart',
  'ChargePeriodEnd',
  'BilledCost',
  'EffectiveCost',
  'BillingCurrency',
  'ProviderName',
  'ServiceProviderName',
  'ServiceName',
  'ServiceCategory',
  'ResourceId',
  'ResourceName',
  'SubAccountId',
  'ChargeCategory',
  'Tags',
] as const;
export type FocusColumn = (typeof FOCUS_COLUMNS)[number];
export const FOCUS_REQUIRED: readonly FocusColumn[] = ['BilledCost', 'BillingCurrency', 'ChargePeriodStart', 'ChargePeriodEnd'];

/** FOCUS ServiceCategory values Steward sets for its own sources. */
export const FOCUS_CATEGORY = {
  compute: 'Compute',
  databases: 'Databases',
  storage: 'Storage',
  networking: 'Networking',
  ai: 'AI and Machine Learning',
  analytics: 'Analytics',
  other: 'Other',
} as const;

// ---------- the API ----------

/** One month of a scope in one currency. Amounts are null when the reader may not see them. */
export interface CostMonth {
  /** YYYY-MM; the current month is so far */
  month: string;
  /** EffectiveCost (what Steward shows) */
  amount: string | null;
  /** BilledCost */
  billed: string | null;
}

export type CostTrendConfidence = 'stable' | 'rough';

/** Costs of a scope in one currency: the last 12 complete months and the current month so far, trend and forecast. */
export interface CostCurrencySummary {
  currency: string;
  months: CostMonth[];
  thisMonth: string | null;
  lastMonth: string | null;
  /** The current month projected from its days so far (null before the 3rd day or without data this month) */
  forecast: string | null;
  /** The forecast against the last month, in percent (null without both) */
  changePct: number | null;
  /** Theil–Sen line through the complete months (#145): change per month and in percent of the start */
  trend: { perMonth: string | null; changePctPerMonth: number | null; confidence: CostTrendConfidence; months: number } | null;
}

export type CostBudgetStateName = 'ok' | 'warning' | 'exceeded';

export interface CostBudget {
  scope: CostBudgetScope;
  scopeId: string;
  /** The month's budget, in its currency (null when the reader may not see amounts) */
  amount: string | null;
  currency: string;
  /** This month so far in the budget's currency (null when the reader may not see amounts, or with `stateOnly`) */
  used: string | null;
  /** used / amount in percent, one decimal (null with `stateOnly`) */
  pct: number | null;
  /** The forecast of the month in percent of the budget (null with `stateOnly`) */
  forecastPct: number | null;
  state: CostBudgetStateName;
  /**
   * The reader does not see every application of the service or team: the budget covers all of them, so only its
   * state is given – no use, no percentages (they would give away the costs of the others by subtraction)
   */
  stateOnly: boolean;
  comment: string;
  updatedAt: string;
  updatedBy: string;
}

export interface CostSourceRef {
  platformId: string;
  platformName: string;
  source: CostSource;
  /** Newest line read for this scope */
  readAt: string | null;
}

/** GET /api/costs/:scope/:id */
export interface CostScopeDetail {
  scope: CostScope;
  id: string;
  name: string;
  /** The reader sees amounts (else only percentages and states) */
  amountsVisible: boolean;
  /** The current month (UTC) */
  month: string;
  currencies: CostCurrencySummary[];
  /** Platforms: what no application is linked to, per currency (this month and last month) */
  unassigned: { currency: string; thisMonth: string | null; lastMonth: string | null }[];
  /** This month and the last by provider and service (FOCUS ProviderName / ServiceName), largest first */
  byService: { provider: string; service: string; category: string; currency: string; thisMonth: string | null; lastMonth: string | null }[];
  /** Applications (services, teams) or platforms (applications) behind the scope; hidden ones are one row "other" */
  parts: {
    kind: 'application' | 'platform' | 'other' | 'unassigned';
    id: string | null;
    name: string;
    currency: string;
    thisMonth: string | null;
    lastMonth: string | null;
  }[];
  sources: CostSourceRef[];
  budget: CostBudget | null;
  /** May set or change the budget (scopes with budgets) */
  canEditBudget: boolean;
  /** Platforms: may change the cost source, import files and manage push tokens */
  canManageSource: boolean;
}

/** One row of GET /api/costs?scope=… */
export interface CostOverviewRow {
  scope: CostScope;
  id: string;
  name: string;
  currency: string;
  amountsVisible: boolean;
  thisMonth: string | null;
  lastMonth: string | null;
  forecast: string | null;
  changePct: number | null;
  /** Platforms: what no application is linked to this month */
  unassigned: string | null;
  /** This month so far in percent of the budget (null without a budget, or when the reader sees only its state) */
  budgetPct: number | null;
  budgetState: CostBudgetStateName | null;
}

export interface CostOverview {
  scope: CostScope;
  month: string;
  rows: CostOverviewRow[];
  /** Totals per currency of the rows the reader sees amounts of (platforms only: services and teams overlap) */
  totals: { currency: string; thisMonth: string; lastMonth: string }[];
  /** The setting "hide amounts from viewers" */
  hideAmounts: boolean;
  /** May change the cost settings (administrators) */
  canManageSettings: boolean;
}

// ---------- sources ----------

export interface CostSourceSettings {
  platformId: string;
  platformName: string;
  platformKind: string;
  /** What reads this platform's costs: a connector, or file imports only (any other kind) */
  source: CostSource;
  /** Read costs from the platform once a day (connectors; FOCUS imports need no switch) */
  enabled: boolean;
  /** The tag whose value names the application (AWS, FOCUS Tags) */
  tagKey: string;
  /** Snowflake without the organisation's usage views: the price of one credit (decimal) and its currency */
  creditPrice: string | null;
  creditCurrency: string | null;
  /** AI gateways: the currency of the prices on the models */
  currency: string | null;
  lastReadAt: string | null;
  lastReadError: string | null;
  /** How the last read got its figures (e.g. "USAGE_IN_CURRENCY_DAILY" or "METERING_DAILY_HISTORY × price per credit") */
  lastReadNote: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  canManage: boolean;
}

export const costSourceInput = z
  .object({
    enabled: z.boolean(),
    tagKey: z.string().trim().min(1).max(128).default('application'),
    creditPrice: z
      .string()
      .trim()
      .max(32)
      .nullable()
      .default(null)
      .refine((v) => v === null || v === '' || (toMicros(v) !== null && toMicros(v)! >= 0), 'a price like 2.50'),
    creditCurrency: currencyCode.nullable().default(null),
    currency: currencyCode.nullable().default(null),
  })
  .strict();
export type CostSourceInput = z.input<typeof costSourceInput>;

// ---------- FOCUS imports ----------

export const COST_IMPORT_MODES = ['replace', 'add'] as const;
export type CostImportMode = (typeof COST_IMPORT_MODES)[number];

export const costImportInput = z
  .object({
    /** The CSV text */
    csv: z.string().min(1).max(COST_LIMITS.importBytes),
    fileName: z.string().trim().max(200).default(''),
    /** replace: lines of earlier imports for the same days are replaced (a corrected file); add: kept */
    mode: z.enum(COST_IMPORT_MODES).default('replace'),
  })
  .strict();
export type CostImportInput = z.input<typeof costImportInput>;

export interface CostImportPreview {
  fileName: string;
  sha256: string;
  bytes: number;
  rows: number;
  /** Lines after summing the rows per day, provider, service, resource and tags */
  lines: number;
  columns: { found: string[]; missing: string[]; ignored: number };
  periodStart: string | null;
  periodEnd: string | null;
  totals: { currency: string; billed: string; effective: string }[];
  providers: string[];
  /** Lines whose tag names an application Steward knows, and those that stay unassigned */
  assigned: number;
  unassigned: number;
  sample: { chargePeriodStart: string; provider: string; service: string; resourceId: string; billed: string; effective: string; currency: string }[];
  warnings: string[];
  /** The same file (SHA-256) was imported before */
  duplicateOf: { id: string; importedAt: string; fileName: string } | null;
  /** Lines of earlier imports for these days that mode "replace" removes */
  replacesLines: number;
}

export interface CostImport {
  id: string;
  platformId: string;
  fileName: string;
  sha256: string;
  bytes: number;
  rows: number;
  lines: number;
  periodStart: string | null;
  periodEnd: string | null;
  mode: CostImportMode;
  via: 'ui' | 'push';
  actor: string;
  importedAt: string;
}

// ---------- budgets ----------

export const costBudgetInput = z
  .object({
    scope: z.enum(COST_BUDGET_SCOPES),
    scopeId: z.string().trim().min(1).max(100),
    /** The month's budget (decimal); null removes the budget */
    amount: z
      .string()
      .trim()
      .max(32)
      .nullable()
      .refine((v) => v === null || (toMicros(v) !== null && toMicros(v)! > 0), 'an amount above 0, like 1500 or 1500.50'),
    currency: currencyCode,
    comment: z.string().trim().max(1000).optional(),
  })
  .strict()
  // no more decimals than the currency has (0.18.0): a budget of 1500.50 JPY is refused
  .superRefine(checkCurrencyDecimals);
export type CostBudgetInput = z.input<typeof costBudgetInput>;

// ---------- settings ----------

export interface CostSettings {
  /** Amounts only for owners, members of owning teams, administrators and auditors – everyone else sees states and percentages */
  hideAmountsFromViewers: boolean;
  /** The currency of AI gateway prices when a gateway names none */
  defaultCurrency: string;
  /** The month the fiscal year starts in, for the whole instance (1 = January; service cost planning, ADR 0026) */
  fiscalYearStartMonth: number;
  /** "Estimate changed" (0.23.0, ADR 0035 part 6): the change of an estimate's monthly total, in percent, that is notified */
  estimateChangePct: number;
}
export const costSettingsInput = z
  .object({
    hideAmountsFromViewers: z.boolean(),
    defaultCurrency: currencyCode,
    /** Left out: unchanged */
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
    /** Left out: unchanged (default 5) */
    estimateChangePct: z.number().min(0.1).max(100).optional(),
  })
  .strict();

// ---------- push tokens (FOCUS files from CI) ----------

/**
 * A cost push token: bound to one platform, it can do nothing but push a FOCUS CSV file for it – POST
 * /api/hooks/costs/<platformId> with "Authorization: Bearer scp_…". Stored as a SHA-256 hash only.
 */
export const COST_PUSH_TOKEN_PREFIX = 'scp_';
export const COST_PUSH_LIMITS = {
  tokensPerTarget: COST_LIMITS.pushTokensPerTarget,
  nameChars: 100,
  cidrs: 20,
  expiresInDays: 730,
  rateLimitPerMinute: { default: 6, max: 60 },
} as const;

export interface CostPushToken {
  id: string;
  name: string;
  prefix: string;
  allowedCidrs: string[];
  rateLimitPerMinute: number;
  expiresAt: string | null;
  createdAt: string;
  createdBy: string;
  rotatedAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  expired: boolean;
  /** The creator is deactivated or may no longer manage the platform: the token stops working */
  creatorInactive: boolean;
}
export interface CostPushTokenCreated extends CostPushToken {
  token: string;
  path: string;
}
export const costPushTokenInput = z
  .object({
    name: z.string().trim().min(1).max(COST_PUSH_LIMITS.nameChars),
    expiresInDays: z.number().int().min(1).max(COST_PUSH_LIMITS.expiresInDays).optional(),
    allowedCidrs: z.array(z.string().trim().min(1).max(64)).max(COST_PUSH_LIMITS.cidrs).default([]),
    rateLimitPerMinute: z.number().int().min(1).max(COST_PUSH_LIMITS.rateLimitPerMinute.max).default(COST_PUSH_LIMITS.rateLimitPerMinute.default),
  })
  .strict();
export type CostPushTokenInput = z.input<typeof costPushTokenInput>;
export const costPushPath = (platformId: string): string => `/api/hooks/costs/${encodeURIComponent(platformId)}`;

// ---------- the monitor check "Cost change" ----------

export const COST_CHECK_PERIODS = ['month', 'monthToDate'] as const;
export type CostCheckPeriod = (typeof COST_CHECK_PERIODS)[number];
