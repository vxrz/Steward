import {
  CONFLUENT_KIND,
  KAFKA_KIND,
  DATA_COST_MEASURE_UNITS,
  SNOWFLAKE_KIND,
  convertQuantity,
  parsePrice,
  parseQuantity,
  roundDiv,
  PRICE_SCALE,
  type DataCostMeasure,
  type Platform,
} from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { runAs } from '../auth/context.js';
import { CheckSetupError, ownerProblem, platformFor } from '../monitors/platforms.js';
import { platformRequest } from '../platforms/http.js';
import { CREDIT_SKU, entriesForSkus, snowflakeCreditPrice } from '../costs/price-books.js';
import { nowIso, parseJson } from '../util.js';
import { chunks, elementsByIds, marks, membersOf } from './store.js';

/**
 * Cost splitting by measured use (ADR 0036 part 11, phase 2; docs/DATA-PRODUCTS.md#measured-use). An allocation with the
 * rule `measured` names what is measured – Snowflake credits per warehouse (`ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY`)
 * or per query tag (`ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY`), Confluent Cloud bytes received per topic of a cluster
 * (the Metrics API) – and per product the warehouses, tags or topics that are its use (topics: by default the product's
 * member topics). The job `data-products` reads the quantities once a day, per platform, measure and scope, for the
 * current and the previous month, as the person who last set the allocation (their use right on the platform is
 * checked before every read), through the platform's client and so through the outbound policy. Only the declared
 * subjects and the scope's total are kept (dp_cost_usage; subject '' is the total).
 *
 * Pricing (costs.ts applies it): where the platform's contracted price book has a price for the measure – the price per
 * credit (`compute-credit`, also the Snowflake fallback's price) or Confluent's `KAFKA_NETWORK_WRITE` per GB – a
 * product's part of a line is its quantity × that price; without a price (or in another currency) it is its share of
 * the measured total. Either way the parts never add up to more than the line: above it they are scaled down to it.
 */

const DAY = 86_400_000;
/** A measure is read again after this long (the views and the Metrics API settle within a day). */
export const MEASURE_READ_INTERVAL_MS = 20 * 3_600_000;
/** Rows of one read (a scope with more subjects keeps the first; the totals stay complete). */
const MAX_ROWS = 20_000;
/** Pages of one Metrics API read */
const MAX_PAGES = 20;

export const DEFAULT_CONFLUENT_METRICS_URL = 'https://api.telemetry.confluent.cloud';

/**
 * The platform kinds a measure's cost lines may belong to: a Snowflake account; Confluent Cloud – or the Kafka platform
 * its cluster's lines are mapped to (variable confluentClusterId, docs/COSTS.md), read through the Confluent Cloud
 * platform that read those lines.
 */
export const MEASURE_PLATFORM_KINDS: Record<DataCostMeasure, readonly string[]> = {
  snowflakeWarehouse: [SNOWFLAKE_KIND],
  snowflakeQueryTag: [SNOWFLAKE_KIND],
  confluentTopic: [CONFLUENT_KIND, KAFKA_KIND],
};

/** The Confluent cluster a Kafka platform's variable confluentClusterId names ('' when none). */
export function clusterOfPlatform(platformId: string): string {
  const r = db().get<{ config: string }>('SELECT config FROM platforms WHERE id = ?', platformId);
  return String(parseJson<{ variables?: Record<string, unknown> }>(r?.config ?? '{}', {}).variables?.confluentClusterId ?? '').trim();
}

export interface MeasuredAllocationRow {
  id: string;
  platform_id: string;
  match_kind: string;
  match_value: string;
  tag_key: string;
  rule: string;
  measure: DataCostMeasure | null;
  subjects: string;
  read_at: string | null;
  read_error: string | null;
  updated_by: string;
}

/**
 * The scope a measure reads for an allocation's key: a Confluent cluster – a resource key `lkc-…`, else the cluster the
 * Kafka platform names –, for Snowflake the whole account ('').
 */
export function measureScope(measure: DataCostMeasure, key: { kind: string; value: string }, platformId?: string): string {
  if (measure !== 'confluentTopic') return '';
  if (key.kind === 'resource' && key.value.startsWith('lkc-')) return key.value;
  return platformId ? clusterOfPlatform(platformId) : '';
}

/** The Confluent Cloud platform that reads a platform's cluster lines: itself, or the source of the lines mapped to it. */
function confluentReader(platformId: string, kind: string): string | null {
  if (kind === CONFLUENT_KIND) return platformId;
  const r = db().get<{ id: string }>(
    `SELECT p.id FROM cost_records c JOIN platforms p ON p.id = c.source_platform_id WHERE c.platform_id = ? AND p.kind = ? LIMIT 1`,
    platformId,
    CONFLUENT_KIND,
  );
  return r?.id ?? null;
}

const monthStart = (m: string) => `${m}-01T00:00:00Z`;
function monthsToRead(now: number): string[] {
  const d = new Date(now);
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  const cur = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const f = (x: Date) => `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`;
  return [f(prev), f(cur)];
}

/** Quantity text (decimal) → millionths of the unit; anything else → null. */
const micros = (v: unknown): bigint | null => (v === null || v === undefined || v === '' ? null : parseQuantity(typeof v === 'number' ? String(v) : String(v)));

// ---------- reading ----------

interface Reading {
  /** month → subject → quantity (millionths of the unit); subject '' is the scope's total */
  byMonth: Map<string, Map<string, bigint>>;
}

const add = (r: Reading, month: string, subject: string, q: bigint) => {
  const m = r.byMonth.get(month) ?? new Map<string, bigint>();
  r.byMonth.set(month, m);
  m.set(subject, (m.get(subject) ?? 0n) + q);
};

/** Snowflake: credits per warehouse of the account, or per query tag (and the account's warehouse credits as the total). */
async function readSnowflake(
  platform: Platform,
  secrets: Record<string, string>,
  measure: DataCostMeasure,
  subjects: string[],
  from: string,
): Promise<Reading> {
  const { snowflakeClient } = await import('../snowflake/service.js');
  const c = snowflakeClient(platform, secrets);
  const r: Reading = { byMonth: new Map() };
  const wanted = new Set(subjects.map((s) => s.toUpperCase()));
  const warehouses = await c.query(
    `/* steward:costs-measure-warehouses */ SELECT WAREHOUSE_NAME, TO_VARCHAR(START_TIME, 'YYYY-MM') AS MONTH, TO_VARCHAR(SUM(CREDITS_USED)) AS CREDITS
     FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY WHERE START_TIME >= TO_TIMESTAMP_LTZ(?) GROUP BY 1, 2 ORDER BY 2, 1 LIMIT ${MAX_ROWS}`,
    [from],
  );
  for (const row of warehouses) {
    const month = String(row.MONTH ?? '');
    const q = micros(row.CREDITS);
    if (month.length !== 7 || q === null) continue;
    add(r, month, '', q);
    const name = String(row.WAREHOUSE_NAME ?? '').toUpperCase();
    if (measure === 'snowflakeWarehouse' && wanted.has(name)) add(r, month, name, q);
  }
  if (measure === 'snowflakeQueryTag' && subjects.length) {
    // the declared tags as bind parameters, never in the statement's text
    const tags = subjects.slice(0, 500);
    const rows = await c.query(
      `/* steward:costs-measure-tags */ SELECT QUERY_TAG, TO_VARCHAR(START_TIME, 'YYYY-MM') AS MONTH, TO_VARCHAR(SUM(CREDITS_ATTRIBUTED_COMPUTE)) AS CREDITS
       FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_ATTRIBUTION_HISTORY WHERE START_TIME >= TO_TIMESTAMP_LTZ(?) AND QUERY_TAG IN (${tags.map(() => '?').join(', ')})
       GROUP BY 1, 2 ORDER BY 2, 1 LIMIT ${MAX_ROWS}`,
      [from, ...tags],
    );
    for (const row of rows) {
      const month = String(row.MONTH ?? '');
      const q = micros(row.CREDITS);
      const tag = String(row.QUERY_TAG ?? '');
      if (month.length !== 7 || q === null || !tags.includes(tag)) continue;
      add(r, month, tag, q);
    }
  }
  return r;
}

interface MetricsPage {
  data?: { timestamp?: string; value?: number; 'metric.topic'?: string }[];
  meta?: { pagination?: { next_page_token?: string | null } };
}

/** Confluent Cloud: bytes received per topic of one cluster (io.confluent.kafka.server/received_bytes), by day. */
async function readConfluent(
  platform: Platform,
  secrets: Record<string, string>,
  cluster: string,
  subjects: string[],
  from: string,
  now: number,
): Promise<Reading> {
  const r: Reading = { byMonth: new Map() };
  if (!cluster) throw new Error('measured use of Confluent topics needs a cost match on the cluster (resource lkc-…)');
  const base = String(platform.config.variables?.metricsUrl ?? '').trim() || DEFAULT_CONFLUENT_METRICS_URL;
  const url = `${base.replace(/\/$/, '')}/v2/metrics/cloud/query`;
  const wanted = new Set(subjects);
  const to = new Date(Math.floor(now / DAY) * DAY).toISOString();
  let token: string | null = null;
  let rows = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await platformRequest(
      platform,
      secrets,
      {
        method: 'POST',
        url,
        body: {
          aggregations: [{ metric: 'io.confluent.kafka.server/received_bytes' }],
          filter: { field: 'resource.kafka.id', op: 'EQ', value: cluster },
          granularity: 'P1D',
          intervals: [`${from}/${to}`],
          group_by: ['metric.topic'],
          limit: 1000,
        },
        ...(token ? { query: { page_token: token } } : {}),
        maxResponseBytes: 8 * 1024 * 1024,
        noRedirects: true,
      },
      AbortSignal.timeout(30_000),
    );
    if (!res.ok)
      throw new Error(
        `the Metrics API answered HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' – the Cloud API key needs the MetricsViewer role, and the Metrics API’s address must be one of the platform’s trusted origins' : ''}`,
      );
    const body = (res.body ?? {}) as MetricsPage;
    for (const d of body.data ?? []) {
      const month = String(d.timestamp ?? '').slice(0, 7);
      const v = typeof d.value === 'number' && Number.isFinite(d.value) && d.value >= 0 ? BigInt(Math.round(d.value)) * 1_000_000n : null;
      if (month.length !== 7 || v === null) continue;
      add(r, month, '', v);
      const topic = String(d['metric.topic'] ?? '');
      if (wanted.has(topic)) add(r, month, topic, v);
      if (++rows > MAX_ROWS) return r;
    }
    token = typeof body.meta?.pagination?.next_page_token === 'string' && body.meta.pagination.next_page_token ? body.meta.pagination.next_page_token : null;
    if (!token) return r;
  }
  return r;
}

/** The subjects of an allocation per product, as stored – topics left out fall back to the product's member topics. */
export function storedSubjects(a: Pick<MeasuredAllocationRow, 'subjects'>): Map<string, string[]> {
  const o = parseJson<Record<string, unknown>>(a.subjects, {});
  const out = new Map<string, string[]>();
  for (const [k, v] of Object.entries(o))
    if (Array.isArray(v))
      out.set(
        k,
        v.filter((x): x is string => typeof x === 'string'),
      );
  return out;
}

/** The member topics (kafka.topic elements) of these products, by product – one statement per chunk. */
export function memberTopics(productIds: readonly string[]): Map<string, string[]> {
  const members = membersOf(productIds);
  const elements = elementsByIds(members.map((m) => m.element_id));
  const out = new Map<string, string[]>();
  for (const m of members) {
    const e = elements.get(m.element_id);
    if (!e || e.kind !== 'kafka.topic') continue;
    out.set(m.product_id, [...new Set([...(out.get(m.product_id) ?? []), e.qualified_name])]);
  }
  return out;
}

/** What each product is measured by: its declared subjects, else (topics) its member topics. */
export function subjectsOf(
  a: Pick<MeasuredAllocationRow, 'subjects' | 'measure'>,
  productIds: readonly string[],
  topics?: Map<string, string[]>,
): Map<string, string[]> {
  const stored = storedSubjects(a);
  const out = new Map<string, string[]>();
  const fallback = a.measure === 'confluentTopic' ? (topics ?? memberTopics(productIds)) : new Map<string, string[]>();
  for (const p of productIds) {
    const own = stored.get(p);
    const list = own && own.length ? own : (fallback.get(p) ?? []);
    out.set(p, a.measure === 'confluentTopic' || a.measure === 'snowflakeQueryTag' ? list : list.map((s) => s.toUpperCase()));
  }
  return out;
}

/** The products that claim an allocation's key (own matches and those inherited from elements) – for the reads. */
function claimantsOf(a: MeasuredAllocationRow): string[] {
  const own = db().all<{ product_id: string }>(
    'SELECT DISTINCT product_id FROM dp_cost_matches WHERE platform_id = ? AND match_kind = ? AND match_value = ? AND tag_key = ? AND product_id IS NOT NULL',
    a.platform_id,
    a.match_kind,
    a.match_value,
    a.tag_key,
  );
  const viaElements = db().all<{ product_id: string }>(
    `SELECT DISTINCT m.product_id FROM dp_cost_matches c JOIN dp_members m ON m.element_id = c.element_id
      WHERE c.platform_id = ? AND c.match_kind = ? AND c.match_value = ? AND c.tag_key = ? AND c.element_id IS NOT NULL`,
    a.platform_id,
    a.match_kind,
    a.match_value,
    a.tag_key,
  );
  return [...new Set([...own, ...viaElements].map((r) => r.product_id))];
}

/** Reads one platform's measure for one scope (the subjects of every allocation that uses it) and stores the quantities. */
async function readGroup(group: MeasuredAllocationRow[], now: number): Promise<void> {
  const a = group[0]!;
  const measure = a.measure!;
  const scope = measureScope(measure, { kind: a.match_kind, value: a.match_value }, a.platform_id);
  const subjects = new Set<string>();
  for (const x of group) for (const list of subjectsOf(x, claimantsOf(x)).values()) for (const s of list) subjects.add(s);
  const months = monthsToRead(now);
  const from = monthStart(months[0]!);
  const at = new Date(now).toISOString();
  const ids = group.map((x) => x.id);
  try {
    // the person who last set the allocation (a platform manager) – their use right is checked before every read
    const owner = [...group].sort((x, y) => (x.updated_by < y.updated_by ? -1 : 1))[0]!.updated_by;
    const kind = db().get<{ kind: string }>('SELECT kind FROM platforms WHERE id = ?', a.platform_id)?.kind ?? '';
    if (!MEASURE_PLATFORM_KINDS[measure].includes(kind)) throw new Error(`the platform is not of kind ${MEASURE_PLATFORM_KINDS[measure].join(' or ')}`);
    const readerId = measure === 'confluentTopic' ? confluentReader(a.platform_id, kind) : a.platform_id;
    if (!readerId) throw new Error('no Confluent Cloud platform has read cost lines of this cluster – its Metrics API cannot be read');
    const problem = ownerProblem(owner, readerId);
    if (problem) throw new CheckSetupError(`the allocation was set by ${owner}: ${problem} – a person who may manage the platform saves it again`);
    const { platform, secrets } = platformFor(owner, readerId);
    const reading =
      measure === 'confluentTopic'
        ? await readConfluent(platform, secrets, scope, [...subjects], from, now)
        : await readSnowflake(platform, secrets, measure, [...subjects], from);
    db().tx(() => {
      for (const m of months)
        db().run('DELETE FROM dp_cost_usage WHERE platform_id = ? AND measure = ? AND scope = ? AND month = ?', a.platform_id, measure, scope, m);
      for (const [month, bySubject] of reading.byMonth) {
        if (!months.includes(month)) continue;
        for (const [subject, q] of bySubject)
          db().run(
            'INSERT INTO dp_cost_usage (platform_id, measure, scope, month, subject, quantity, read_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            a.platform_id,
            measure,
            scope,
            month,
            subject,
            formatMicros(q),
            at,
          );
      }
      for (const part of chunks(ids))
        db().run(`UPDATE dp_cost_allocations SET read_at = ?, read_error = NULL WHERE id IN (${marks(part.length)})`, at, ...part);
    });
  } catch (e) {
    const error = (e as Error).message.slice(0, 500);
    logger.warn({ platform: a.platform_id, measure, error }, 'measured use of a data products allocation could not be read');
    for (const part of chunks(ids))
      db().run(`UPDATE dp_cost_allocations SET read_at = ?, read_error = ? WHERE id IN (${marks(part.length)})`, at, error, ...part);
  }
}

const formatMicros = (q: bigint): string => {
  const neg = q < 0n;
  const a = neg ? -q : q;
  const s = `${a / 1_000_000n}.${String(a % 1_000_000n).padStart(6, '0')}`.replace(/\.?0+$/, '');
  return `${neg ? '-' : ''}${s || '0'}`;
};

/**
 * The job's part (daily per platform, measure and scope): reads what measured allocations need when their last read is
 * older than MEASURE_READ_INTERVAL_MS (`force`: all of them – tests and "Read now").
 */
export async function readMeasuredUse(now = Date.now(), o: { force?: boolean; platformId?: string } = {}): Promise<{ read: number; failed: number }> {
  if (!vault().unlocked) return { read: 0, failed: 0 };
  const rows = db().all<MeasuredAllocationRow>("SELECT * FROM dp_cost_allocations WHERE rule = 'measured' AND measure IS NOT NULL ORDER BY platform_id, id");
  const groups = new Map<string, MeasuredAllocationRow[]>();
  for (const r of rows) {
    if (o.platformId && r.platform_id !== o.platformId) continue;
    const k = JSON.stringify([r.platform_id, r.measure, measureScope(r.measure!, { kind: r.match_kind, value: r.match_value }, r.platform_id)]);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  let read = 0;
  let failed = 0;
  for (const g of groups.values()) {
    const due = o.force || g.some((x) => !x.read_at || now - Date.parse(x.read_at) >= MEASURE_READ_INTERVAL_MS);
    if (!due) continue;
    await runAs(null, () => readGroup(g, now));
    read++;
    if (db().get('SELECT 1 FROM dp_cost_allocations WHERE id = ? AND read_error IS NOT NULL', g[0]!.id)) failed++;
  }
  return { read, failed };
}

// ---------- what attribution needs ----------

export interface MeasuredPrice {
  /** Price per 1 unit of the measure as a fraction num / den, in 10⁻¹² of the currency (exact: no rounding per byte) */
  num: bigint;
  den: bigint;
  currency: string;
}

/** The price of a measure from the platform's contracted price book (ADR 0035): the price per credit, or per GB written. */
export function measurePrice(platformId: string, measure: DataCostMeasure): MeasuredPrice | null {
  if (measure === 'snowflakeWarehouse' || measure === 'snowflakeQueryTag') {
    const p = snowflakeCreditPrice(platformId);
    const v = p ? parsePrice(p.price) : null;
    return p && v !== null ? { num: v, den: 1n, currency: p.currency.toUpperCase() } : null;
  }
  const book = db().get<{ id: string; current_version: number }>(
    "SELECT id, current_version FROM cost_price_books WHERE platform_id = ? AND kind = 'contracted' ORDER BY created_at, id LIMIT 1",
    platformId,
  );
  if (!book || !Number(book.current_version)) return null;
  const v = db().get<{ id: string }>('SELECT id FROM cost_price_book_versions WHERE book_id = ? AND number = ?', book.id, Number(book.current_version));
  if (!v) return null;
  const day = nowIso().slice(0, 10);
  const e = entriesForSkus(v.id, ['KAFKA_NETWORK_WRITE']).find(
    (x) => x.currency && !x.creditSku && !x.tiers && (!x.validFrom || x.validFrom <= day) && (!x.validTo || x.validTo >= day),
  );
  if (!e) return null;
  const price = parsePrice(e.price);
  if (price === null) return null;
  // the price per block of the entry's unit → per byte (the measure's unit): convert one million bytes and divide
  const oneMillionBytes = convertQuantity(1_000_000n * 1_000_000n, DATA_COST_MEASURE_UNITS.confluentTopic, e.unit);
  if (oneMillionBytes === null) return null;
  // price per byte = price/block × (units per byte); units per byte = oneMillionBytes / 10^6 / 10^6 (micros)
  return { num: price * oneMillionBytes, den: BigInt(e.block) * 1_000_000n * 1_000_000n, currency: (e.currency ?? '').toUpperCase() };
}

/** Kept for the credit SKU's name in texts and tests. */
export const MEASURE_PRICE_SKUS: Record<DataCostMeasure, string> = {
  snowflakeWarehouse: CREDIT_SKU,
  snowflakeQueryTag: CREDIT_SKU,
  confluentTopic: 'KAFKA_NETWORK_WRITE',
};

/** Measured quantities of these platforms and months: (platform, measure, scope) → month → subject → millionths. */
export function usageOf(platformIds: readonly string[], months: readonly string[]): Map<string, Map<string, Map<string, bigint>>> {
  const out = new Map<string, Map<string, Map<string, bigint>>>();
  if (!platformIds.length || !months.length) return out;
  for (const part of chunks([...new Set(platformIds)], 200)) {
    const rows = db().all<{ platform_id: string; measure: string; scope: string; month: string; subject: string; quantity: string }>(
      `SELECT platform_id, measure, scope, month, subject, quantity FROM dp_cost_usage WHERE platform_id IN (${marks(part.length)}) AND month IN (${marks(months.length)})`,
      ...part,
      ...months,
    );
    for (const r of rows) {
      const k = usageKey(r.platform_id, r.measure as DataCostMeasure, r.scope);
      const byMonth = out.get(k) ?? new Map<string, Map<string, bigint>>();
      out.set(k, byMonth);
      const bySubject = byMonth.get(r.month) ?? new Map<string, bigint>();
      byMonth.set(r.month, bySubject);
      bySubject.set(r.subject, parseQuantity(r.quantity) ?? 0n);
    }
  }
  return out;
}

export const usageKey = (platformId: string, measure: DataCostMeasure, scope: string): string => JSON.stringify([platformId, measure, scope]);

/** A product's part of a line in micros: quantity (millionths of the unit) × price per unit (10⁻¹²), rounded once. */
export const pricedMicros = (quantity: bigint, p: Pick<MeasuredPrice, 'num' | 'den'>): bigint => roundDiv(quantity * p.num, p.den * PRICE_SCALE);
