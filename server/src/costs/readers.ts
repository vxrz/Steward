import { COST_LIMITS, FOCUS_CATEGORY, fromMicros, toMicros, type Platform } from '@sm/shared';
import { db } from '../db.js';
import type { SnowflakeClient } from '../snowflake/client.js';
import type { CostLine } from './store.js';

/**
 * The connectors' cost lines (#226, docs/COSTS.md#sources), as FOCUS columns:
 *
 *   AWS         Cost Explorer GetCostAndUsage, UnblendedCost per month, by the application tag and by service
 *   Snowflake   ORGANIZATION_USAGE.USAGE_IN_CURRENCY_DAILY per day, service type and billing type – or, without the
 *               organisation's usage views, ACCOUNT_USAGE.METERING_DAILY_HISTORY credits × the price per credit
 *   Confluent   the Costs API GET /billing/v1/costs, daily lines per resource, product and line type (US dollars)
 *   AI          the usage log's costs per day, gateway, model and process (the prices set on the models)
 *
 * Amounts stay decimal text until they become whole millionths (toMicros) – never a binary float on the way.
 */

const DAY = 86_400_000;
const dayIso = (d: string) => `${d.slice(0, 10)}T00:00:00.000Z`;
const nextDayIso = (d: string) => new Date(Date.parse(dayIso(d)) + DAY).toISOString();
const monthIso = (m: string) => `${m}-01T00:00:00.000Z`;
const nextMonthIso = (m: string) => {
  const d = new Date(monthIso(m));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
};

/** The first day a read covers: the start of the month 12 months back on a first read, else the last 35 days. */
export function readFrom(platformId: string, source: string, now: number): string {
  const has = db().get('SELECT id FROM cost_records WHERE source_platform_id = ? AND source = ? LIMIT 1', platformId, source);
  const d = new Date(now);
  if (!has) return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - COST_LIMITS.months, 1)).toISOString().slice(0, 10);
  return new Date(now - COST_LIMITS.rereadDays * DAY).toISOString().slice(0, 10);
}

const base = (o: { start: string; end: string; granularity: 'day' | 'month' }) => ({
  granularity: o.granularity,
  chargePeriodStart: o.start,
  chargePeriodEnd: o.end,
  billingPeriodStart: monthIso(o.start.slice(0, 7)),
  billingPeriodEnd: nextMonthIso(o.start.slice(0, 7)),
});

// ---------- AWS ----------

const AWS_CATEGORY: [string, string][] = [
  ['Compute', FOCUS_CATEGORY.compute],
  ['Lambda', FOCUS_CATEGORY.compute],
  ['Container', FOCUS_CATEGORY.compute],
  ['Relational Database', FOCUS_CATEGORY.databases],
  ['DynamoDB', FOCUS_CATEGORY.databases],
  ['Storage', FOCUS_CATEGORY.storage],
  ['Load Balancing', FOCUS_CATEGORY.networking],
  ['CloudFront', FOCUS_CATEGORY.networking],
  ['Bedrock', FOCUS_CATEGORY.ai],
];
const awsCategory = (service: string) => AWS_CATEGORY.find(([k]) => service.includes(k))?.[1] ?? '';

/** Cost Explorer's lines (month, tag value, service) as cost lines; the tag goes into Tags under the platform's tag key. */
export function awsLines(lines: { month: string; tag: string; service: string; amount: string; unit: string }[], tagKey: string): CostLine[] {
  const out: CostLine[] = [];
  for (const l of lines) {
    const micros = toMicros(l.amount);
    if (micros === null || l.unit.length !== 3) continue;
    out.push({
      key: `${l.month}|${l.tag}|${l.service}`,
      ...base({ start: monthIso(l.month), end: nextMonthIso(l.month), granularity: 'month' }),
      billed: micros,
      effective: micros,
      currency: l.unit.toUpperCase(),
      provider: 'AWS',
      service: l.service.slice(0, COST_LIMITS.textChars),
      category: awsCategory(l.service),
      resourceId: '',
      resourceName: '',
      subAccountId: '',
      chargeCategory: 'Usage',
      tags: l.tag ? Object.fromEntries([[tagKey, l.tag.slice(0, COST_LIMITS.tagChars)]]) : {},
    });
  }
  return out;
}

/** The months an AWS read covers (charge period starts): 12 months back to the end of the current one. */
export function awsWindow(lines: { month: string }[]): { from: string; to: string } | null {
  if (!lines.length) return null;
  const months = lines.map((l) => l.month).sort();
  return { from: monthIso(months[0]!), to: nextMonthIso(months.at(-1)!) };
}

// ---------- Snowflake ----------

const SF_CATEGORY: Record<string, string> = {
  STORAGE: FOCUS_CATEGORY.storage,
  DATA_TRANSFER: FOCUS_CATEGORY.networking,
  AI_SERVICES: FOCUS_CATEGORY.ai,
};
const sfCharge = (billingType: string) => {
  const b = billingType.toLowerCase();
  return b === 'consumption' || !b ? 'Usage' : b.includes('rebate') || b.includes('credit') ? 'Credit' : b.includes('adjust') ? 'Adjustment' : billingType;
};

/** The account names a USAGE_IN_CURRENCY_DAILY row can carry for this platform: the locator and the name after "ORG-". */
export function snowflakeAccountNames(p: Platform): { locator: string; name: string } {
  const a = String(p.config.variables?.account ?? '')
    .trim()
    .toUpperCase();
  const dash = a.indexOf('-');
  return { locator: a, name: dash > 0 ? a.slice(dash + 1) : a };
}

export interface SnowflakeCostRead {
  lines: CostLine[];
  note: string;
}

/**
 * The costs of the platform's account from `from` (YYYY-MM-DD) on: in currency from the organisation's usage views, or
 * – where they cannot be read (no ORGANIZATION_USAGE, a reseller contract) – credits × the platform's price per credit.
 */
export async function snowflakeCosts(
  c: SnowflakeClient,
  p: Platform,
  from: string,
  price: { price: string | null; currency: string | null },
): Promise<SnowflakeCostRead> {
  const acct = snowflakeAccountNames(p);
  let viewError: string;
  try {
    const rows = await c.query(
      `/* steward:costs-currency */ SELECT TO_VARCHAR(USAGE_DATE, 'YYYY-MM-DD') AS USAGE_DATE, SERVICE_TYPE, BILLING_TYPE, CURRENCY,
         TO_VARCHAR(SUM(USAGE_IN_CURRENCY)) AS AMOUNT
       FROM SNOWFLAKE.ORGANIZATION_USAGE.USAGE_IN_CURRENCY_DAILY
       WHERE USAGE_DATE >= TO_DATE(?) AND (UPPER(ACCOUNT_LOCATOR) = ? OR UPPER(ACCOUNT_NAME) = ?)
       GROUP BY 1, 2, 3, 4 ORDER BY 1`,
      [from, acct.locator, acct.name],
    );
    const lines: CostLine[] = [];
    for (const r of rows) {
      const day = String(r.USAGE_DATE ?? '');
      const micros = toMicros(r.AMOUNT ?? null);
      const currency = String(r.CURRENCY ?? '').toUpperCase();
      if (day.length !== 10 || micros === null || currency.length !== 3) continue;
      const service = String(r.SERVICE_TYPE ?? '');
      const billing = String(r.BILLING_TYPE ?? '');
      lines.push({
        key: `${day}|${service}|${billing}|${currency}`,
        ...base({ start: dayIso(day), end: nextDayIso(day), granularity: 'day' }),
        billed: micros,
        effective: micros,
        currency,
        provider: 'Snowflake',
        service: service.slice(0, COST_LIMITS.textChars),
        category: SF_CATEGORY[service.toUpperCase()] ?? FOCUS_CATEGORY.analytics,
        resourceId: '',
        resourceName: '',
        subAccountId: acct.locator,
        chargeCategory: sfCharge(billing),
        tags: {},
      });
    }
    return { lines, note: 'ORGANIZATION_USAGE.USAGE_IN_CURRENCY_DAILY' };
  } catch (e) {
    viewError = (e as Error).message.slice(0, 200);
  }
  const unit = price.price ? toMicros(price.price) : null;
  if (unit === null)
    throw new Error(
      `the organisation's usage views cannot be read (${viewError}) and no price per credit is set for the fallback from ACCOUNT_USAGE.METERING_DAILY_HISTORY – set one under Costs → the platform → Source`,
    );
  const rows = await c.query(
    `/* steward:costs-credits */ SELECT TO_VARCHAR(USAGE_DATE, 'YYYY-MM-DD') AS USAGE_DATE, SERVICE_TYPE, TO_VARCHAR(SUM(CREDITS_BILLED)) AS CREDITS
     FROM SNOWFLAKE.ACCOUNT_USAGE.METERING_DAILY_HISTORY WHERE USAGE_DATE >= TO_DATE(?) GROUP BY 1, 2 ORDER BY 1`,
    [from],
  );
  const currency = (price.currency ?? 'USD').toUpperCase();
  const lines: CostLine[] = [];
  for (const r of rows) {
    const day = String(r.USAGE_DATE ?? '');
    const credits = toMicros(r.CREDITS ?? null);
    if (day.length !== 10 || credits === null) continue;
    // credits (millionths) × price (millionths) / 1,000,000, exactly
    const micros = Number((BigInt(credits) * BigInt(unit)) / 1_000_000n);
    const service = String(r.SERVICE_TYPE ?? '');
    lines.push({
      key: `${day}|${service}|credits`,
      ...base({ start: dayIso(day), end: nextDayIso(day), granularity: 'day' }),
      billed: micros,
      effective: micros,
      currency,
      provider: 'Snowflake',
      service: service.slice(0, COST_LIMITS.textChars),
      category: SF_CATEGORY[service.toUpperCase()] ?? FOCUS_CATEGORY.analytics,
      resourceId: '',
      resourceName: `${fromMicros(credits, 0)} credits`,
      subAccountId: acct.locator,
      chargeCategory: 'Usage',
      tags: {},
    });
  }
  return { lines, note: `ACCOUNT_USAGE.METERING_DAILY_HISTORY × ${fromMicros(unit)} ${currency} per credit` };
}

// ---------- Confluent Cloud ----------

export interface ConfluentCost {
  start_date?: string;
  end_date?: string;
  granularity?: string;
  line_type?: string;
  product?: string;
  network_access_type?: string;
  amount?: number | string;
  original_amount?: number | string;
  discount_amount?: number | string;
  resource?: { id?: string; display_name?: string; environment?: { id?: string } };
}

const CONFLUENT_CATEGORY: Record<string, string> = {
  KAFKA: 'Integration',
  CONNECT: 'Integration',
  CLUSTER_LINK: 'Integration',
  KSQL: FOCUS_CATEGORY.analytics,
  FLINK: FOCUS_CATEGORY.analytics,
  STREAM_GOVERNANCE: 'Management and Governance',
  AUDIT_LOG: 'Management and Governance',
  SUPPORT: FOCUS_CATEGORY.other,
};

/** Confluent's cost lines (US dollars, daily) as cost lines; promotional credits are "Credit". */
export function confluentLines(items: ConfluentCost[]): CostLine[] {
  const out: CostLine[] = [];
  for (const x of items) {
    const day = String(x.start_date ?? '').slice(0, 10);
    if (day.length !== 10 || !Number.isFinite(Date.parse(`${day}T00:00:00Z`))) continue;
    const amount = toMicros(typeof x.amount === 'number' ? x.amount : String(x.amount ?? ''));
    if (amount === null) continue;
    const product = String(x.product ?? '').slice(0, 100);
    const lineType = String(x.line_type ?? '').slice(0, 100);
    const resource = String(x.resource?.id ?? '').slice(0, 200);
    const env = String(x.resource?.environment?.id ?? '').slice(0, 200);
    const end = String(x.end_date ?? '').slice(0, 10);
    out.push({
      key: `${day}|${resource}|${product}|${lineType}|${String(x.network_access_type ?? '').slice(0, 50)}`,
      ...base({ start: dayIso(day), end: end.length === 10 && end > day ? dayIso(end) : nextDayIso(day), granularity: 'day' }),
      billed: amount,
      effective: amount,
      currency: 'USD',
      provider: 'Confluent',
      service: product,
      category: CONFLUENT_CATEGORY[product.toUpperCase()] ?? FOCUS_CATEGORY.other,
      resourceId: resource,
      resourceName: String(x.resource?.display_name ?? '').slice(0, COST_LIMITS.textChars),
      subAccountId: env,
      chargeCategory: lineType.includes('CREDIT') || amount < 0 ? 'Credit' : 'Usage',
      tags: {},
    });
  }
  return out;
}

/**
 * The requests of a Confluent read: at most one month each (the API's limit), from `from` to three days before today
 * (the API's lines are complete after 72 hours). Dates YYYY-MM-DD, end exclusive.
 */
export function confluentRanges(from: string, now: number): { start: string; end: string }[] {
  const last = new Date(now - 3 * DAY).toISOString().slice(0, 10);
  const out: { start: string; end: string }[] = [];
  let start = from;
  while (start < last && out.length < 15) {
    const d = new Date(`${start.slice(0, 7)}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const monthEnd = d.toISOString().slice(0, 10);
    const end = monthEnd < last ? monthEnd : last;
    out.push({ start, end });
    start = end;
  }
  return out;
}

// ---------- AI gateways ----------

/** The usage log's costs of a gateway from `from` on, per day, model and process (calls without a price have none). */
export function aiLines(platformId: string, from: string, currency: string): CostLine[] {
  const rows = db().all<{ day: string; model: string; process_id: string | null; process_name: string | null; cost: number | null; calls: number }>(
    `SELECT day, model, process_id, MAX(process_name) AS process_name, SUM(cost) AS cost, COUNT(*) AS calls FROM ai_usage
      WHERE platform_id = ? AND day >= ? AND cost IS NOT NULL GROUP BY day, model, process_id ORDER BY day`,
    platformId,
    from,
  );
  const out: CostLine[] = [];
  for (const r of rows) {
    // the log keeps costs as numbers: written as decimal text with at most six decimals before they become millionths
    const micros = toMicros(Number(r.cost ?? 0).toFixed(6));
    if (micros === null) continue;
    out.push({
      key: `${r.day}|${r.model}|${r.process_id ?? ''}`,
      ...base({ start: dayIso(r.day), end: nextDayIso(r.day), granularity: 'day' }),
      billed: micros,
      effective: micros,
      currency,
      provider: 'AI gateway',
      service: r.model.slice(0, COST_LIMITS.textChars),
      category: FOCUS_CATEGORY.ai,
      resourceId: r.model.slice(0, 200),
      resourceName: '',
      subAccountId: '',
      chargeCategory: 'Usage',
      tags: r.process_id ? { process: String(r.process_id).slice(0, COST_LIMITS.tagChars) } : {},
    });
  }
  return out;
}
