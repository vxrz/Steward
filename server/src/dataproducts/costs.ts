import {
  DATA_COST_MEASURE_LIMITS,
  DATA_PRODUCT_ID_PREFIX,
  dataCostAllocationInput,
  dataCostMatchInput,
  dataElementCostMatchInput,
  type DataCostAllocation,
  type DataCostAllocationRule,
  type DataCostMatch,
  type DataCostMatchKind,
  type DataCostMeasure,
  type DataProductCostLine,
  type DataProductCosts,
  type DataValueTier,
  type ProductCost,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { forbid, me } from '../auth/access.js';
import type { AuthUser } from '../auth/context.js';
import { platformScopes, type ScopeInfo } from '../costs/access.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { elementAccess, productAccess } from './access.js';
import {
  MEASURE_PLATFORM_KINDS,
  measurePrice,
  measureScope,
  memberTopics,
  pricedMicros,
  storedSubjects,
  subjectsOf,
  usageKey,
  usageOf,
  type MeasuredPrice,
} from './measured.js';
import { L, actorName, elementNotFound, refOf } from './common.js';
import { ensureEnvironment, editableProduct, sortEnvironments, visibleProduct } from './service.js';
import {
  chunks,
  elementRow,
  elementTeamIds,
  elementsByIds,
  environmentsOf,
  marks,
  membersOf,
  membershipsOfElements,
  productsByIds,
  type ProductRow,
} from './store.js';

/**
 * Costs of data products (ADR 0036 part 11, docs/DATA-PRODUCTS.md#costs): showback, never chargeback – a read-only
 * attribution of the cost lines Steward already reads (cost_records), never booked and never part of a plan.
 *
 * - **Matches** (dp_cost_matches) claim a platform's lines for a product in one environment: by resource id,
 *   sub-account, service name, a tag's value or the application the lines are mapped to. A match on an element is
 *   inherited by every product the element is a member of, in the element's environment.
 * - **Shares.** A line that one product (in one environment) claims is its **direct** cost. A line claimed by several is
 *   **shared** and split by the allocation of the most specific match key that claims it (resource, tag, application,
 *   service, sub-account; dp_cost_allocations): **equal** among the claimants, or **by weight** – a percentage per
 *   product (split equally between its environments), at most 100 % together; what no product takes is _not
 *   attributed_. Amounts are split in whole micros by the largest remainder, so the parts never exceed the line.
 * - **Visibility** (ADR 0032's rule): a reader sees a platform's part only when they see that platform's amounts
 *   (costs/access.ts); a part they may not see is left out and makes the month **incomplete** (`amountsHidden`) – never
 *   a figure from which it could be computed. Allocation weights are shown to who sees the platform's amounts; only who
 *   may manage the platform changes them (session only, audited `dataproduct.cost_allocation_changed`).
 * - **Bulk:** a fixed number of statements whatever the number of products, matches and lines – the matches of the
 *   platforms involved, the members, the elements, the allocations, one grouped read of the lines per chunk of
 *   platforms, the platforms' rights.
 */

// ---------- rows and keys ----------

export interface CostMatchRow {
  id: string;
  product_id: string | null;
  element_id: string | null;
  environment: string;
  platform_id: string;
  match_kind: DataCostMatchKind;
  match_value: string;
  tag_key: string;
  created_at: string;
  created_by: string;
}

interface AllocationRow {
  id: string;
  platform_id: string;
  match_kind: DataCostMatchKind;
  match_value: string;
  tag_key: string;
  rule: DataCostAllocationRule;
  /** {productId: percent} */
  weights: string;
  updated_at: string;
  updated_by: string;
  /** Rule measured (phase 2): what is measured, the subjects per product ({productId: [...]}), the last read */
  measure: DataCostMeasure | null;
  subjects: string;
  read_at: string | null;
  read_error: string | null;
}

interface Key {
  platformId: string;
  kind: DataCostMatchKind;
  value: string;
  tagKey: string;
}

const keyOf = (k: Key): string => JSON.stringify([k.platformId, k.kind, k.value, k.kind === 'tag' ? k.tagKey : '']);
const rowKey = (r: { platform_id: string; match_kind: DataCostMatchKind; match_value: string; tag_key: string }): Key => ({
  platformId: r.platform_id,
  kind: r.match_kind,
  value: r.match_value,
  tagKey: r.match_kind === 'tag' ? r.tag_key : '',
});

/** Which key's allocation decides a line several keys claim: the most specific one. */
const SPECIFICITY: Record<DataCostMatchKind, number> = { resource: 0, tag: 1, application: 2, service: 3, subAccount: 4 };
const bySpecificity = (a: Key, b: Key) => SPECIFICITY[a.kind] - SPECIFICITY[b.kind] || (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);

/** A claimant of lines: a product in one environment. */
interface Unit {
  productId: string;
  environment: string;
}
const unitKey = (u: Unit) => `${u.productId}\u0000${u.environment}`;

interface KeyClaims extends Key {
  units: Map<string, Unit>;
}

/** Basis points of a percentage (10,000 = 100 %). */
const bp = (pct: number): number => Math.round(pct * 100);

// ---------- the model: who claims what ----------

/**
 * The match keys of these platforms (null: every platform) with the products and environments that claim them – own
 * matches and those inherited from elements – and the allocations. Five statements per chunk, whatever the number.
 */
function claimsOf(platformIds: readonly string[] | null): { keys: Map<string, KeyClaims>; allocations: Map<string, AllocationRow>; rows: CostMatchRow[] } {
  const rows =
    platformIds === null
      ? db().all<CostMatchRow>('SELECT * FROM dp_cost_matches ORDER BY created_at, id')
      : chunks([...new Set(platformIds)]).flatMap((part) =>
          db().all<CostMatchRow>(`SELECT * FROM dp_cost_matches WHERE platform_id IN (${marks(part.length)}) ORDER BY created_at, id`, ...part),
        );
  const elementIds = rows.flatMap((r) => (r.element_id ? [r.element_id] : []));
  const elements = elementsByIds(elementIds);
  const memberships = membershipsOfElements(elementIds);
  const productsOfElement = new Map<string, string[]>();
  for (const m of memberships) productsOfElement.set(m.element_id, [...(productsOfElement.get(m.element_id) ?? []), m.product_id]);
  const keys = new Map<string, KeyClaims>();
  const claim = (k: Key, u: Unit) => {
    const id = keyOf(k);
    const c = keys.get(id) ?? { ...k, units: new Map<string, Unit>() };
    c.units.set(unitKey(u), u);
    keys.set(id, c);
  };
  for (const r of rows) {
    const k = rowKey(r);
    if (r.product_id) claim(k, { productId: r.product_id, environment: r.environment });
    else if (r.element_id) {
      const e = elements.get(r.element_id);
      if (!e) continue;
      for (const p of productsOfElement.get(r.element_id) ?? []) claim(k, { productId: p, environment: e.environment });
    }
  }
  const platforms = platformIds === null ? null : [...new Set(platformIds)];
  const allocRows =
    platforms === null
      ? db().all<AllocationRow>('SELECT * FROM dp_cost_allocations')
      : chunks(platforms).flatMap((part) => db().all<AllocationRow>(`SELECT * FROM dp_cost_allocations WHERE platform_id IN (${marks(part.length)})`, ...part));
  const allocations = new Map(allocRows.map((a) => [keyOf(rowKey(a)), a]));
  return { keys, allocations, rows };
}

// ---------- splitting a line in whole micros ----------

/**
 * Splits `amount` (micros, may be negative: credits) into parts num_i / den each, in whole micros by the largest
 * remainder: the parts add up to the rounded total share and never exceed the amount.
 */
export function splitMicros(amount: number, nums: readonly (number | bigint)[], den: number | bigint): number[] {
  if (!nums.length) return [];
  const sign = amount < 0 ? -1n : 1n;
  const a = BigInt(Math.abs(Math.trunc(amount)));
  const D = BigInt(den);
  if (D <= 0n) return nums.map(() => 0);
  const N = nums.map((n) => BigInt(n));
  const sum = N.reduce((x, y) => x + y, 0n);
  if (sum > D) throw new Error('shares above 100 %');
  // the total share, rounded half away from zero
  const total = (a * sum * 2n + D) / (2n * D);
  const parts = N.map((n) => (a * n) / D);
  let rest = total - parts.reduce((x, y) => x + y, 0n);
  const order = N.map((n, i) => ({ i, rem: (a * n) % D })).sort((x, y) => (y.rem > x.rem ? 1 : y.rem < x.rem ? -1 : x.i - y.i));
  for (const o of order) {
    if (rest <= 0n) break;
    if (N[o.i] === 0n) continue;
    parts[o.i]! += 1n;
    rest--;
  }
  return parts.map((p) => Number(p * sign));
}

// ---------- lines ----------

interface LineGroup {
  platform_id: string;
  month: string;
  currency: string;
  resource_id: string;
  sub_account_id: string;
  service_name: string;
  application_id: string | null;
  tags: string;
  amount: number | string;
}

/** Indexes of a platform's keys by what they compare, so a line finds its keys without scanning all of them. */
interface PlatformIndex {
  resource: Map<string, KeyClaims[]>;
  subAccount: Map<string, KeyClaims[]>;
  service: Map<string, KeyClaims[]>;
  application: Map<string, KeyClaims[]>;
  /** tag key → value → keys */
  tag: Map<string, Map<string, KeyClaims[]>>;
}

function indexKeys(keys: Iterable<KeyClaims>): Map<string, PlatformIndex> {
  const out = new Map<string, PlatformIndex>();
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => m.set(k, [...(m.get(k) ?? []), v]);
  for (const k of keys) {
    let ix = out.get(k.platformId);
    if (!ix) {
      ix = { resource: new Map(), subAccount: new Map(), service: new Map(), application: new Map(), tag: new Map() };
      out.set(k.platformId, ix);
    }
    if (k.kind === 'tag') {
      const byValue = ix.tag.get(k.tagKey) ?? new Map<string, KeyClaims[]>();
      push(byValue, k.value, k);
      ix.tag.set(k.tagKey, byValue);
    } else push(ix[k.kind], k.value, k);
  }
  return out;
}

function keysOfLine(ix: PlatformIndex, l: LineGroup): KeyClaims[] {
  const out = [
    ...(ix.resource.get(l.resource_id) ?? []),
    ...(ix.subAccount.get(l.sub_account_id) ?? []),
    ...(ix.service.get(l.service_name) ?? []),
    ...(l.application_id ? (ix.application.get(l.application_id) ?? []) : []),
  ];
  if (ix.tag.size && l.tags && l.tags !== '{}') {
    const tags = parseJson<Record<string, unknown>>(l.tags, {});
    for (const [k, byValue] of ix.tag) {
      const v = Object.prototype.hasOwnProperty.call(tags, k) ? tags[k] : undefined;
      if (typeof v === 'string') out.push(...(byValue.get(v) ?? []));
    }
  }
  return out;
}

/**
 * The platform's lines of these months that any key claims, summed per month, currency and the fields matches compare
 * (one statement per chunk of platforms; the charge days of a month add up in the database).
 */
function lineGroups(keys: Iterable<KeyClaims>, months: readonly string[]): LineGroup[] {
  const byPlatform = new Map<string, KeyClaims[]>();
  for (const k of keys) byPlatform.set(k.platformId, [...(byPlatform.get(k.platformId) ?? []), k]);
  if (!byPlatform.size || !months.length) return [];
  // narrow by the values the keys compare (a platform with tag keys reads its tagged lines)
  const values = { resource: new Set<string>(), subAccount: new Set<string>(), service: new Set<string>(), application: new Set<string>() };
  let tags = false;
  for (const ks of byPlatform.values())
    for (const k of ks) {
      if (k.kind === 'tag') tags = true;
      else values[k.kind].add(k.value);
    }
  const conds: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, set: Set<string>) => {
    if (!set.size) return;
    conds.push(`${col} IN (${marks(set.size)})`);
    params.push(...set);
  };
  add('resource_id', values.resource);
  add('sub_account_id', values.subAccount);
  add('service_name', values.service);
  add('application_id', values.application);
  if (tags) conds.push("tags <> '{}'");
  const out: LineGroup[] = [];
  for (const part of chunks([...byPlatform.keys()], 200))
    out.push(
      ...db().all<LineGroup>(
        `SELECT platform_id, month, billing_currency AS currency, resource_id, sub_account_id, service_name, application_id, tags, SUM(effective_cost) AS amount
           FROM cost_records
          WHERE platform_id IN (${marks(part.length)}) AND month IN (${marks(months.length)}) AND (${conds.join(' OR ')})
          GROUP BY platform_id, month, billing_currency, resource_id, sub_account_id, service_name, application_id, tags`,
        ...part,
        ...months,
        ...params,
      ),
    );
  return out;
}

/** The last `n` months up to the current one (YYYY-MM, oldest first). */
export function lastMonths(n: number, now = Date.now()): string[] {
  const d = new Date(now);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(`${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

// ---------- measured use (phase 2) ----------

interface MeasuredKey {
  measure: DataCostMeasure;
  /** Subjects (warehouses, query tags, topics) per product */
  subjects: Map<string, string[]>;
  /** month → subject → quantity (millionths of the unit); '' the scope's total */
  usage: Map<string, Map<string, bigint>> | undefined;
  price: MeasuredPrice | null;
}

/**
 * What the measured allocations among these keys need for these months – the subjects per claiming product, the
 * quantities read and the price – in a fixed number of statements: the quantities of all their platforms at once, the
 * member topics of the claimants at once, the price once per platform and measure.
 */
function measuredContext(keys: Map<string, KeyClaims>, allocations: Map<string, AllocationRow>, months: readonly string[]): Map<string, MeasuredKey> {
  const out = new Map<string, MeasuredKey>();
  const measuredIds = [...allocations].filter(([, a]) => a.rule === 'measured' && a.measure).map(([id]) => id);
  if (!measuredIds.length) return out;
  const usage = usageOf(
    measuredIds.map((id) => allocations.get(id)!.platform_id),
    months,
  );
  const claimants = new Map(measuredIds.map((id) => [id, [...new Set([...(keys.get(id)?.units.values() ?? [])].map((u) => u.productId))]]));
  const topicsNeeded = measuredIds.filter((id) => allocations.get(id)!.measure === 'confluentTopic').flatMap((id) => claimants.get(id)!);
  const topics = topicsNeeded.length ? memberTopics(topicsNeeded) : new Map<string, string[]>();
  const prices = new Map<string, MeasuredPrice | null>();
  for (const id of measuredIds) {
    const a = allocations.get(id)!;
    const measure = a.measure!;
    const pk = `${a.platform_id}\u0000${measure}`;
    if (!prices.has(pk)) prices.set(pk, measurePrice(a.platform_id, measure));
    out.set(id, {
      measure,
      subjects: subjectsOf(a, claimants.get(id)!, topics),
      usage: usage.get(usageKey(a.platform_id, measure, measureScope(measure, { kind: a.match_kind, value: a.match_value }, a.platform_id))),
      price: prices.get(pk) ?? null,
    });
  }
  return out;
}

// ---------- attribution ----------

interface Attributed {
  unit: Unit;
  month: string;
  platformId: string;
  currency: string;
  kind: 'direct' | 'share';
  rule: DataCostAllocationRule | null;
  share: number;
  key: Key;
  products: number;
  amount: number;
  measured?: { measure: DataCostMeasure; priced: boolean };
}

/**
 * Splits each line between the units that claim it and hands the parts of `wanted` products to `take` – the shared
 * arithmetic of the Costs tab, the list and the allocation view.
 */
function attribute(
  groups: readonly LineGroup[],
  keys: Map<string, KeyClaims>,
  allocations: Map<string, AllocationRow>,
  wanted: ReadonlySet<string>,
  take: (a: Attributed) => void,
  months: readonly string[] = [...new Set(groups.map((g) => g.month))],
): void {
  const index = indexKeys(keys.values());
  const measured = measuredContext(keys, allocations, months);
  for (const g of groups) {
    const ix = index.get(g.platform_id);
    if (!ix) continue;
    const matched = keysOfLine(ix, g);
    if (!matched.length) continue;
    const units = new Map<string, Unit>();
    for (const k of matched) for (const [id, u] of k.units) units.set(id, u);
    const list = [...units.values()].sort((a, b) => (unitKey(a) < unitKey(b) ? -1 : 1));
    if (!list.some((u) => wanted.has(u.productId))) continue;
    const products = new Set(list.map((u) => u.productId));
    const sorted = [...matched].sort(bySpecificity);
    const decisive = sorted.find((k) => allocations.has(keyOf(k)));
    const alloc = decisive ? allocations.get(keyOf(decisive)) : undefined;
    const amount = Number(g.amount);
    let parts: number[];
    let shares: number[];
    let rule: DataCostAllocationRule | null;
    let measure: Attributed['measured'];
    const m = alloc?.rule === 'measured' && decisive ? measured.get(keyOf(decisive)) : undefined;
    if (m) {
      // per product its measured use – priced where the book has a price in the line's currency, else its share of the
      // measured total – split equally between its environments; never more than the line together
      const perProduct = new Map<string, Unit[]>();
      for (const u of list) perProduct.set(u.productId, [...(perProduct.get(u.productId) ?? []), u]);
      const ps = [...perProduct.keys()].sort();
      const usage = m.usage?.get(g.month);
      const qty = ps.map((p) => (m.subjects.get(p) ?? []).reduce((sum, subject) => sum + (usage?.get(subject) ?? 0n), 0n));
      const priced = !!m.price && m.price.currency === g.currency.toUpperCase();
      let nums: bigint[];
      let den: bigint;
      if (priced) {
        nums = qty.map((q) => pricedMicros(q, m.price!));
        const sum = nums.reduce((x, y) => x + y, 0n);
        const line = BigInt(Math.abs(Math.trunc(amount)));
        den = sum > line ? sum : line;
      } else {
        nums = qty;
        const sum = qty.reduce((x, y) => x + y, 0n);
        const total = usage?.get('') ?? 0n;
        den = total > sum ? total : sum;
      }
      const productParts = den > 0n ? splitMicros(amount, nums, den) : ps.map(() => 0);
      const byUnit = new Map<string, { amount: number; share: number }>();
      ps.forEach((p, i) => {
        const us = perProduct.get(p)!;
        const sub = splitMicros(
          productParts[i]!,
          us.map(() => 1),
          us.length,
        );
        const share = den > 0n ? Number((nums[i]! * 1_000_000n) / den) / 1_000_000 : 0;
        us.forEach((u, j) => byUnit.set(unitKey(u), { amount: sub[j]!, share: share / us.length }));
      });
      parts = list.map((u) => byUnit.get(unitKey(u))!.amount);
      shares = list.map((u) => byUnit.get(unitKey(u))!.share);
      rule = 'measured';
      measure = { measure: m.measure, priced };
    } else if (alloc?.rule === 'weight') {
      // per product its weight, split equally between its environments
      const w = parseJson<Record<string, number>>(alloc.weights, {});
      const perProduct = new Map<string, Unit[]>();
      for (const u of list) perProduct.set(u.productId, [...(perProduct.get(u.productId) ?? []), u]);
      const ps = [...perProduct.keys()].sort();
      const pw = ps.map((p) => (Object.prototype.hasOwnProperty.call(w, p) ? bp(Number(w[p]) || 0) : 0));
      const productParts = splitMicros(amount, pw, 10_000);
      const byUnit = new Map<string, { amount: number; share: number }>();
      ps.forEach((p, i) => {
        const us = perProduct.get(p)!;
        const sub = splitMicros(
          productParts[i]!,
          us.map(() => 1),
          us.length,
        );
        us.forEach((u, j) => byUnit.set(unitKey(u), { amount: sub[j]!, share: pw[i]! / 10_000 / us.length }));
      });
      parts = list.map((u) => byUnit.get(unitKey(u))!.amount);
      shares = list.map((u) => byUnit.get(unitKey(u))!.share);
      rule = 'weight';
    } else {
      parts = splitMicros(
        amount,
        list.map(() => 1),
        list.length,
      );
      shares = list.map(() => 1 / list.length);
      rule = list.length > 1 ? 'equal' : null;
    }
    const kind: 'direct' | 'share' = rule === null ? 'direct' : 'share';
    const measuredOf = measure;
    list.forEach((u, i) => {
      if (!wanted.has(u.productId)) return;
      // the key the product's line is shown under: the deciding one when it claims it, else its own most specific
      const own = sorted.filter((k) => k.units.has(unitKey(u)));
      const key = decisive && decisive.units.has(unitKey(u)) ? decisive : (own[0] ?? sorted[0]!);
      take({
        unit: u,
        month: g.month,
        platformId: g.platform_id,
        currency: g.currency,
        kind,
        rule,
        share: kind === 'direct' ? 1 : shares[i]!,
        key,
        products: products.size,
        amount: parts[i]!,
        ...(measuredOf ? { measured: measuredOf } : {}),
      });
    });
  }
}

type MonthCosts = Omit<ProductCost, 'lines'> & { lines: DataProductCostLine[] };

/**
 * The attributed costs of these products per environment and month as `u` sees them (bulk). Lines of a platform whose
 * amounts `u` may not see are left out and mark the month incomplete. Without `u` (background work): everything.
 */
export function productCostsOf(
  u: AuthUser | null,
  productIds: readonly string[],
  months: readonly string[],
): Map<string, Map<string, Map<string, MonthCosts>>> {
  const wanted = new Set(productIds);
  const out = new Map<string, Map<string, Map<string, MonthCosts>>>();
  if (!wanted.size || !months.length) return out;
  const platforms = platformsOfProducts(productIds);
  if (!platforms.length) return out;
  const { keys, allocations } = claimsOf(platforms);
  const groups = lineGroups(keys.values(), months);
  const infos = u ? platformScopes(platforms, u) : null;
  const names = infos ?? platformScopes(platforms, null);
  const cell = (unit: Unit, month: string): MonthCosts => {
    const byEnv = out.get(unit.productId) ?? new Map<string, Map<string, MonthCosts>>();
    out.set(unit.productId, byEnv);
    const byMonth = byEnv.get(unit.environment) ?? new Map<string, MonthCosts>();
    byEnv.set(unit.environment, byMonth);
    let c = byMonth.get(month);
    if (!c) {
      c = { productId: unit.productId, environment: unit.environment, month, totals: [], lines: [], incomplete: false, amountsHidden: false };
      byMonth.set(month, c);
    }
    return c;
  };
  const lineIndex = new Map<MonthCosts, Map<string, DataProductCostLine>>();
  attribute(
    groups,
    keys,
    allocations,
    wanted,
    (a) => {
      const c = cell(a.unit, a.month);
      const info = infos ? infos.get(a.platformId) : undefined;
      if (infos && (!info || !info.amounts)) {
        // a part the reader may not see: left out, the month is incomplete
        c.incomplete = true;
        c.amountsHidden = true;
        return;
      }
      const id = JSON.stringify([a.platformId, a.kind, a.rule, a.share, a.currency, keyOf(a.key), a.measured?.priced ?? null]);
      const idx = lineIndex.get(c) ?? new Map<string, DataProductCostLine>();
      lineIndex.set(c, idx);
      const line = idx.get(id);
      if (line) {
        line.amountMicros += a.amount;
        line.products = Math.max(line.products, a.products);
      } else {
        const l: DataProductCostLine = {
          platformId: a.platformId,
          platformName: names.get(a.platformId)?.name ?? a.platformId,
          kind: a.kind,
          rule: a.rule,
          share: Math.round(a.share * 1_000_000) / 1_000_000,
          amountMicros: a.amount,
          currency: a.currency,
          match: { kind: a.key.kind, value: a.key.value, tagKey: a.key.tagKey },
          products: a.products,
          ...(a.measured ? { measured: a.measured } : {}),
        };
        idx.set(id, l);
        c.lines.push(l);
      }
    },
    months,
  );
  for (const byEnv of out.values())
    for (const byMonth of byEnv.values())
      for (const c of byMonth.values()) {
        const totals = new Map<string, number>();
        for (const l of c.lines) totals.set(l.currency, (totals.get(l.currency) ?? 0) + l.amountMicros);
        c.totals = [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amountMicros]) => ({ currency, amountMicros }));
        c.lines.sort(
          (x, y) => x.platformName.localeCompare(y.platformName) || (x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : 0) || y.amountMicros - x.amountMicros,
        );
      }
  return out;
}

/** Platforms the matches of these products (own and inherited from their elements) name: three statements per chunk. */
function platformsOfProducts(productIds: readonly string[]): string[] {
  const own = chunks([...new Set(productIds)]).flatMap((part) =>
    db().all<{ platform_id: string }>(`SELECT DISTINCT platform_id FROM dp_cost_matches WHERE product_id IN (${marks(part.length)})`, ...part),
  );
  const members = membersOf(productIds).map((m) => m.element_id);
  const inherited = chunks([...new Set(members)]).flatMap((part) =>
    db().all<{ platform_id: string }>(`SELECT DISTINCT platform_id FROM dp_cost_matches WHERE element_id IN (${marks(part.length)})`, ...part),
  );
  return [...new Set([...own, ...inherited].map((r) => r.platform_id))];
}

// ---------- the Costs tab ----------

/** The environment a view shows: the one asked for, else production first (sortEnvironments). */
function chosenEnvironment(asked: string | undefined, environments: string[]): string | null {
  if (asked) return asked;
  return environments[0] ?? null;
}

/** The product's own matches and those its member elements carry (in every environment). */
function matchesOfProduct(productId: string): { rows: CostMatchRow[]; elementEnv: Map<string, string> } {
  const own = db().all<CostMatchRow>('SELECT * FROM dp_cost_matches WHERE product_id = ? ORDER BY created_at, id', productId);
  const elementIds = membersOf([productId]).map((m) => m.element_id);
  const inherited = chunks(elementIds).flatMap((part) =>
    db().all<CostMatchRow>(`SELECT * FROM dp_cost_matches WHERE element_id IN (${marks(part.length)}) ORDER BY created_at, id`, ...part),
  );
  const elements = elementsByIds(inherited.map((r) => r.element_id!));
  return {
    rows: [...own, ...inherited.filter((r) => elements.has(r.element_id!))],
    elementEnv: new Map([...elements.values()].map((e) => [e.id, e.environment])),
  };
}

/**
 * GET /api/data-products/:id/costs: per month of the last `months` in one environment (production first), the lines
 * the product takes – direct or a share with its rule – totals per currency, its matches, and its value beside them.
 */
export function productCosts(productId: string, q: { environment?: string; months: number }, now = Date.now()): DataProductCosts {
  const u = me();
  const { row, perms } = visibleProduct(productId, u);
  const { rows, elementEnv } = matchesOfProduct(row.id);
  const envOf = (r: CostMatchRow) => (r.element_id ? (elementEnv.get(r.element_id) ?? r.environment) : r.environment);
  const environments = sortEnvironments([...environmentsOf([row.id]).map((e) => e.environment), ...rows.map(envOf)]);
  const environment = chosenEnvironment(q.environment, environments);
  const months = lastMonths(q.months, now);
  const costs = environment
    ? (productCostsOf(u, [row.id], months).get(row.id)?.get(environment) ?? new Map<string, MonthCosts>())
    : new Map<string, MonthCosts>();
  const monthList: MonthCosts[] = environment
    ? months.map((m) => costs.get(m) ?? { productId: row.id, environment, month: m, totals: [], lines: [], incomplete: false, amountsHidden: false })
    : [];
  const inEnv = rows.filter((r) => envOf(r) === environment);
  return {
    productId: row.id,
    environment,
    environments,
    months: monthList,
    matches: matchViews(u, inEnv, envOf, perms.includes('edit'), row.id),
    value: valueOf(row),
    incomplete: monthList.some((m) => m.incomplete),
    amountsHidden: monthList.some((m) => m.amountsHidden),
    canEditMatches: perms.includes('edit'),
  };
}

const valueOf = (p: ProductRow): DataProductCosts['value'] => ({
  statement: p.value_statement,
  tier: (p.value_tier as DataValueTier | null) ?? null,
  amount: p.value_amount === null ? null : Number(p.value_amount),
  currency: p.value_currency,
});

/** Matches as `u` sees them: a platform they may not see is neither named nor its value shown; sharing counted. */
function matchViews(u: AuthUser, rows: CostMatchRow[], envOf: (r: CostMatchRow) => string, canEditProduct: boolean, self: string | null): DataCostMatch[] {
  if (!rows.length) return [];
  const platforms = platformScopes(
    rows.map((r) => r.platform_id),
    u,
  );
  const { keys } = claimsOf([...new Set(rows.map((r) => r.platform_id))]);
  const elementIds = rows.flatMap((r) => (r.element_id ? [r.element_id] : []));
  const elements = elementsByIds(elementIds);
  const teams = elementTeamIds(elementIds);
  return rows.map((r) => {
    const info = platforms.get(r.platform_id);
    const k = keys.get(keyOf(rowKey(r)));
    const products = new Set([...(k?.units.values() ?? [])].map((x) => x.productId));
    const e = r.element_id ? elements.get(r.element_id) : undefined;
    const elementPerms = e ? elementAccess(u, teams.get(e.id) ?? []).permissions : [];
    return {
      id: r.id,
      productId: r.product_id,
      elementId: r.element_id,
      element: e ? { id: e.id, qualifiedName: e.qualified_name, visible: elementPerms.length > 0 } : null,
      environment: envOf(r),
      platformId: info ? r.platform_id : null,
      platformName: info?.name ?? null,
      platformHidden: !info,
      kind: r.match_kind,
      value: info ? r.match_value : null,
      tagKey: info ? r.tag_key : '',
      sharedWith: products.size - (self && products.has(self) ? 1 : 0),
      canDelete: r.product_id ? canEditProduct : elementPerms.includes('edit'),
      createdAt: r.created_at,
      createdBy: r.created_by,
    };
  });
}

// ---------- matches: writing ----------

const matchProblem = (context: 'tagKey' | 'platform' | 'duplicate', message: string, status = 400) =>
  new HttpError(status, message, 'DATA_COST_MATCH', { context });

function checkedMatch(u: AuthUser, platformId: string, kind: DataCostMatchKind, tagKey: string): { info: ScopeInfo; tagKey: string } {
  const info = platformScopes([platformId], u).get(platformId);
  if (!info) throw matchProblem('platform', `Platform ${platformId} not found`);
  if (kind === 'tag' && !tagKey) throw matchProblem('tagKey', 'A tag match needs the tag’s key');
  return { info, tagKey: kind === 'tag' ? tagKey : '' };
}

function refuseMatchLimit(): void {
  if (Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_cost_matches')!.n) >= L.costMatches)
    throw new HttpError(409, `Limit reached: at most ${L.costMatches.toLocaleString('en-GB')} (costMatches)`, 'DATA_PRODUCT_LIMIT', {
      context: 'costMatches',
      max: L.costMatches,
    });
}

const matchText = (kind: DataCostMatchKind, value: string, tagKey: string) => (kind === 'tag' ? `tag ${tagKey}=${value}` : `${kind} ${value}`);

/** POST /api/data-products/:id/costs/matches: who may edit the product, on a platform they may see. */
export function addProductMatch(productId: string, body: unknown): DataCostMatch {
  const u = me();
  const { row } = editableProduct(productId);
  const input = dataCostMatchInput.parse(body);
  const { info, tagKey } = checkedMatch(u, input.platformId, input.kind, input.tagKey);
  refuseMatchLimit();
  if (
    db().get(
      'SELECT 1 FROM dp_cost_matches WHERE product_id = ? AND environment = ? AND platform_id = ? AND match_kind = ? AND match_value = ? AND tag_key = ?',
      row.id,
      input.environment,
      input.platformId,
      input.kind,
      input.value,
      tagKey,
    )
  )
    throw matchProblem('duplicate', 'The product has this match already', 409);
  const id = newId(DATA_PRODUCT_ID_PREFIX.costMatch);
  db().tx(() => {
    db().run(
      `INSERT INTO dp_cost_matches (id, product_id, element_id, environment, platform_id, match_kind, match_value, tag_key, created_at, created_by)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      row.id,
      input.environment,
      input.platformId,
      input.kind,
      input.value,
      tagKey,
      nowIso(),
      actorName(),
    );
    ensureEnvironment(row.id, input.environment);
    audit({
      action: 'dataproduct.updated',
      entityType: 'data_product',
      entityId: row.id,
      summary: `Data product "${row.name}": cost match ${matchText(input.kind, input.value, tagKey)} on ${info.name} (${input.environment}) added`,
      details: { costMatch: { id, platformId: input.platformId, kind: input.kind, value: input.value, tagKey, environment: input.environment } },
    });
  });
  return productCosts(row.id, { environment: input.environment, months: 1 }).matches.find((m) => m.id === id)!;
}

export function deleteProductMatch(productId: string, matchId: string): void {
  const { row } = editableProduct(productId);
  const m = db().get<CostMatchRow>('SELECT * FROM dp_cost_matches WHERE id = ? AND product_id = ?', matchId, row.id);
  if (!m) throw new HttpError(404, `Cost match ${matchId} not found`, 'DATA_COST_MATCH', { context: 'notFound' });
  db().tx(() => {
    db().run('DELETE FROM dp_cost_matches WHERE id = ?', m.id);
    audit({
      action: 'dataproduct.updated',
      entityType: 'data_product',
      entityId: row.id,
      summary: `Data product "${row.name}": cost match ${matchText(m.match_kind, m.match_value, m.tag_key)} (${m.environment}) removed`,
      details: { costMatch: { id: m.id, platformId: m.platform_id, kind: m.match_kind, value: m.match_value, tagKey: m.tag_key, removed: true } },
    });
  });
}

function elementWithRight(id: string, right: 'view' | 'edit') {
  const u = me();
  const e = elementRow(id);
  if (!e) throw elementNotFound(id);
  const perms = elementAccess(u, elementTeamIds([e.id]).get(e.id) ?? []).permissions;
  if (!perms.length) throw elementNotFound(id);
  if (!perms.includes(right)) forbid('change this element', 'dataProducts');
  return { u, e, perms };
}

/** GET /api/data-elements/:id/cost-matches: the element's matches (inherited by its products). */
export function elementMatches(elementId: string): DataCostMatch[] {
  const { u, e, perms } = elementWithRight(elementId, 'view');
  const rows = db().all<CostMatchRow>('SELECT * FROM dp_cost_matches WHERE element_id = ? ORDER BY created_at, id', e.id);
  return matchViews(u, rows, () => e.environment, false, null).map((m) => ({ ...m, canDelete: perms.includes('edit') }));
}

/** POST /api/data-elements/:id/cost-matches: who may edit the element; its platform unless another is named. */
export function addElementMatch(elementId: string, body: unknown): DataCostMatch {
  const { u, e } = elementWithRight(elementId, 'edit');
  const input = dataElementCostMatchInput.parse(body);
  const platformId = input.platformId ?? e.platform_id;
  if (!platformId) throw matchProblem('platform', 'The element has no platform – name the platform of the costs');
  const { info, tagKey } = checkedMatch(u, platformId, input.kind, input.tagKey);
  refuseMatchLimit();
  if (
    db().get(
      'SELECT 1 FROM dp_cost_matches WHERE element_id = ? AND platform_id = ? AND match_kind = ? AND match_value = ? AND tag_key = ?',
      e.id,
      platformId,
      input.kind,
      input.value,
      tagKey,
    )
  )
    throw matchProblem('duplicate', 'The element has this match already', 409);
  const id = newId(DATA_PRODUCT_ID_PREFIX.costMatch);
  db().tx(() => {
    db().run(
      `INSERT INTO dp_cost_matches (id, product_id, element_id, environment, platform_id, match_kind, match_value, tag_key, created_at, created_by)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      e.id,
      e.environment,
      platformId,
      input.kind,
      input.value,
      tagKey,
      nowIso(),
      actorName(),
    );
    audit({
      action: 'dataelement.updated',
      entityType: 'data_element',
      entityId: e.id,
      summary: `Data element ${e.qualified_name}: cost match ${matchText(input.kind, input.value, tagKey)} on ${info.name} added`,
      details: { costMatch: { id, platformId, kind: input.kind, value: input.value, tagKey } },
    });
  });
  return elementMatches(e.id).find((m) => m.id === id)!;
}

export function deleteElementMatch(elementId: string, matchId: string): void {
  const { e } = elementWithRight(elementId, 'edit');
  const m = db().get<CostMatchRow>('SELECT * FROM dp_cost_matches WHERE id = ? AND element_id = ?', matchId, e.id);
  if (!m) throw new HttpError(404, `Cost match ${matchId} not found`, 'DATA_COST_MATCH', { context: 'notFound' });
  db().tx(() => {
    db().run('DELETE FROM dp_cost_matches WHERE id = ?', m.id);
    audit({
      action: 'dataelement.updated',
      entityType: 'data_element',
      entityId: e.id,
      summary: `Data element ${e.qualified_name}: cost match ${matchText(m.match_kind, m.match_value, m.tag_key)} removed`,
      details: { costMatch: { id: m.id, platformId: m.platform_id, kind: m.match_kind, value: m.match_value, tagKey: m.tag_key, removed: true } },
    });
  });
}

// ---------- allocations ----------

/**
 * GET /api/data-products/cost-allocations: the shared match keys (claimed by two or more products, or with an
 * allocation) of the platforms `u` may see – the products named where `u` may see them, the others counted; the weights
 * and what is not attributed only where `u` sees the platform's amounts.
 */
export function listAllocations(q: { platformId?: string }): DataCostAllocation[] {
  const u = me();
  const platformIds = q.platformId
    ? [q.platformId]
    : [
        ...new Set([
          ...db()
            .all<{ platform_id: string }>('SELECT DISTINCT platform_id FROM dp_cost_matches')
            .map((r) => r.platform_id),
          ...db()
            .all<{ platform_id: string }>('SELECT DISTINCT platform_id FROM dp_cost_allocations')
            .map((r) => r.platform_id),
        ]),
      ];
  const infos = platformScopes(platformIds, u);
  const visible = platformIds.filter((id) => infos.has(id));
  if (!visible.length) return [];
  const { keys, allocations } = claimsOf(visible);
  const all = new Map<string, KeyClaims>(keys);
  for (const [id, a] of allocations) if (!all.has(id)) all.set(id, { ...rowKey(a), units: new Map() });
  const productIds = [...all.values()].flatMap((k) => [...k.units.values()].map((x) => x.productId));
  const products = productsByIds(productIds);
  const sees = new Map([...products.values()].map((p) => [p.id, productAccess(u, p).permissions.length > 0]));
  const out: DataCostAllocation[] = [];
  const prices = new Map<string, boolean>();
  const pricing = (a: AllocationRow): 'book' | 'share' => {
    const pk = `${a.platform_id}\u0000${a.measure}`;
    if (!prices.has(pk)) prices.set(pk, !!measurePrice(a.platform_id, a.measure!));
    return prices.get(pk) ? 'book' : 'share';
  };
  const measuredClaimants = [...all]
    .filter(([id]) => allocations.get(id)?.rule === 'measured' && allocations.get(id)?.measure === 'confluentTopic')
    .flatMap(([, k]) => [...k.units.values()].map((x) => x.productId));
  const topics = measuredClaimants.length ? memberTopics(measuredClaimants) : new Map<string, string[]>();
  for (const [id, k] of all) {
    const info = infos.get(k.platformId);
    if (!info) continue;
    const a = allocations.get(id);
    const byProduct = new Map<string, string[]>();
    for (const x of k.units.values()) byProduct.set(x.productId, [...(byProduct.get(x.productId) ?? []), x.environment]);
    if (byProduct.size < 2 && !a) continue;
    const measured =
      a?.rule === 'measured' && a.measure ? { subjects: subjectsOf(a, [...byProduct.keys()], topics), pricing: info.amounts ? pricing(a) : null } : null;
    out.push(allocationView(k, a, byProduct, products, sees, info, measured));
  }
  return out.sort(
    (x, y) =>
      x.platformName.localeCompare(y.platformName) ||
      SPECIFICITY[x.kind] - SPECIFICITY[y.kind] ||
      x.value.localeCompare(y.value) ||
      x.tagKey.localeCompare(y.tagKey),
  );
}

function allocationView(
  k: Key,
  a: AllocationRow | undefined,
  byProduct: Map<string, string[]>,
  products: Map<string, ProductRow>,
  sees: Map<string, boolean>,
  info: ScopeInfo,
  measured: { subjects: Map<string, string[]>; pricing: 'book' | 'share' | null } | null = null,
): DataCostAllocation {
  const rule: DataCostAllocationRule = a?.rule ?? 'equal';
  const weights = rule === 'weight' ? parseJson<Record<string, number>>(a!.weights, {}) : {};
  const shown = info.amounts;
  const weightOf = (p: string): number => (rule === 'weight' ? (Object.prototype.hasOwnProperty.call(weights, p) ? Number(weights[p]) || 0 : 0) : 0);
  const named: DataCostAllocation['products'] = [];
  let hidden = 0;
  let hiddenBp = 0;
  let takenBp = 0;
  for (const [p, envs] of byProduct) {
    const row = products.get(p);
    if (!row) continue;
    takenBp += bp(weightOf(p));
    if (sees.get(p)) {
      const ref = refOf(row) as DataCostAllocation['products'][number]['product'];
      named.push({
        product: ref,
        environments: sortEnvironments(envs),
        weightPct: shown && rule === 'weight' ? weightOf(p) : null,
        ...(rule === 'measured' ? { subjects: shown && measured ? (measured.subjects.get(p) ?? []) : null } : {}),
      });
    } else {
      hidden++;
      hiddenBp += bp(weightOf(p));
    }
  }
  named.sort((x, y) => x.product.name.localeCompare(y.product.name));
  return {
    platformId: k.platformId,
    platformName: info.name,
    kind: k.kind,
    value: k.value,
    tagKey: k.tagKey,
    rule,
    products: named,
    hiddenProducts: hidden,
    hiddenWeightPct: shown && rule === 'weight' ? hiddenBp / 100 : null,
    // measured use: what is not attributed differs per month (the Costs tab shows each month's lines)
    notAttributedPct: shown && rule !== 'measured' ? (rule === 'weight' ? Math.max(0, 10_000 - takenBp) / 100 : 0) : null,
    weightsShown: shown,
    canEdit: info.canManageSource,
    updatedAt: a?.updated_at ?? null,
    updatedBy: a?.updated_by ?? null,
    measured:
      rule === 'measured' && a?.measure
        ? { measure: a.measure, readAt: shown ? a.read_at : null, error: shown ? a.read_error : null, pricing: measured?.pricing ?? null }
        : null,
  };
}

const allocationProblem = (
  context: 'over100' | 'product' | 'noMatch' | 'measure' | 'measurePlatform' | 'measureScope' | 'subjects',
  message: string,
  extra: Record<string, string | number> = {},
) => new HttpError(400, message, 'DATA_COST_ALLOCATION', { context, ...extra });

/**
 * PUT /api/data-products/cost-allocations (session only): who may manage the platform splits its lines of one match key
 * equally or by weight. Weights name products that match the key; those of matching products the manager may not see
 * stay as they are; together at most 100 %. Audited `dataproduct.cost_allocation_changed`.
 */
export function setAllocation(body: unknown): DataCostAllocation {
  const u = me();
  const input = dataCostAllocationInput.parse(body);
  const info = platformScopes([input.platformId], u).get(input.platformId);
  if (!info) throw new HttpError(404, `Platform ${input.platformId} not found`, 'COST_SCOPE_NOT_FOUND', { scope: 'platform', id: input.platformId });
  if (!info.canManageSource) forbid('split the costs of this platform', 'dataProductCosts');
  if (input.kind === 'tag' && !input.tagKey) throw matchProblem('tagKey', 'A tag match needs the tag’s key');
  const k: Key = { platformId: input.platformId, kind: input.kind, value: input.value, tagKey: input.kind === 'tag' ? input.tagKey : '' };
  const id = keyOf(k);
  const { keys, allocations } = claimsOf([input.platformId]);
  const claims = keys.get(id);
  const matching = new Set([...(claims?.units.values() ?? [])].map((x) => x.productId));
  if (!matching.size) throw allocationProblem('noMatch', 'No data product matches these lines');
  const products = productsByIds([...matching]);
  const sees = new Map([...products.values()].map((p) => [p.id, productAccess(u, p).permissions.length > 0]));
  const before = allocations.get(id);
  const beforeWeights = before?.rule === 'weight' ? parseJson<Record<string, number>>(before.weights, {}) : {};
  const weights = new Map<string, number>();
  const subjects = new Map<string, string[]>();
  if (input.rule === 'measured') {
    if (!input.measure) throw allocationProblem('measure', 'Say what is measured: Snowflake warehouses or query tags, or Confluent topics');
    const kind = db().get<{ kind: string }>('SELECT kind FROM platforms WHERE id = ?', input.platformId)?.kind ?? '';
    const kinds = MEASURE_PLATFORM_KINDS[input.measure];
    if (!kinds.includes(kind))
      throw allocationProblem('measurePlatform', `${input.measure} is measured on a platform of kind ${kinds.join(' or ')}`, { kind: kinds.join(', ') });
    if (input.measure === 'confluentTopic' && !measureScope(input.measure, k, input.platformId))
      throw allocationProblem(
        'measureScope',
        'Topics are measured per cluster: split the lines of the cluster (a resource match lkc-…, or a Kafka platform that names its cluster)',
      );
    // subjects of matching products the manager may not see stay as they are
    const beforeSubjects = before?.rule === 'measured' ? storedSubjects(before) : new Map<string, string[]>();
    for (const [p, list] of beforeSubjects) if (matching.has(p) && !sees.get(p)) subjects.set(p, list);
    for (const x of input.subjects) {
      if (!matching.has(x.productId) || !sees.get(x.productId))
        throw allocationProblem('product', `Data product ${x.productId} does not match these lines`, { productId: x.productId });
      subjects.set(x.productId, [...new Set(x.subjects)]);
    }
    const count = [...subjects.values()].reduce((n, l) => n + l.length, 0);
    if (count > DATA_COST_MEASURE_LIMITS.subjectsPerAllocation)
      throw allocationProblem('subjects', `At most ${DATA_COST_MEASURE_LIMITS.subjectsPerAllocation} warehouses, query tags or topics per split`, {
        max: DATA_COST_MEASURE_LIMITS.subjectsPerAllocation,
      });
  }
  if (input.rule === 'weight') {
    // weights of matching products the manager may not see stay as they are
    for (const [p, w] of Object.entries(beforeWeights)) if (matching.has(p) && !sees.get(p)) weights.set(p, Number(w) || 0);
    for (const w of input.weights) {
      if (!matching.has(w.productId) || !sees.get(w.productId))
        throw allocationProblem('product', `Data product ${w.productId} does not match these lines`, { productId: w.productId });
      weights.set(w.productId, Math.round(w.pct * 100) / 100);
    }
    const total = [...weights.values()].reduce((s, w) => s + bp(w), 0);
    if (total > 10_000) throw allocationProblem('over100', 'The weights add up to more than 100 %', { total: total / 100 });
  }
  const now = nowIso();
  const stored = Object.fromEntries([...weights].sort(([a], [b]) => a.localeCompare(b)));
  const storedSubj = Object.fromEntries([...subjects].sort(([a], [b]) => a.localeCompare(b)));
  // a new measure or other subjects are read again by the next run of the job
  const sameMeasure = before?.rule === 'measured' && before.measure === (input.measure ?? null) && before.subjects === JSON.stringify(storedSubj);
  db().tx(() => {
    if (input.rule === 'equal')
      db().run(
        'DELETE FROM dp_cost_allocations WHERE platform_id = ? AND match_kind = ? AND match_value = ? AND tag_key = ?',
        k.platformId,
        k.kind,
        k.value,
        k.tagKey,
      );
    else
      db().run(
        `INSERT INTO dp_cost_allocations (id, platform_id, match_kind, match_value, tag_key, rule, weights, updated_at, updated_by, measure, subjects, read_at, read_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (platform_id, match_kind, match_value, tag_key) DO UPDATE SET rule = excluded.rule, weights = excluded.weights, updated_at = excluded.updated_at,
           updated_by = excluded.updated_by, measure = excluded.measure, subjects = excluded.subjects, read_at = excluded.read_at, read_error = excluded.read_error`,
        before?.id ?? newId(DATA_PRODUCT_ID_PREFIX.allocation),
        k.platformId,
        k.kind,
        k.value,
        k.tagKey,
        input.rule,
        JSON.stringify(stored),
        now,
        u.username,
        input.rule === 'measured' ? input.measure! : null,
        JSON.stringify(input.rule === 'measured' ? storedSubj : {}),
        sameMeasure ? (before?.read_at ?? null) : null,
        sameMeasure ? (before?.read_error ?? null) : null,
      );
    const sum = [...weights.values()].reduce((s, w) => s + bp(w), 0) / 100;
    audit({
      action: 'dataproduct.cost_allocation_changed',
      entityType: 'platform',
      entityId: k.platformId,
      summary: `Costs of ${info.name}, ${matchText(k.kind, k.value, k.tagKey)}: ${before?.rule ?? 'equal'} → ${input.rule}${input.rule === 'weight' ? ` (${weights.size} weight(s), ${sum} % attributed)` : input.rule === 'measured' ? ` (${input.measure}, ${subjects.size} product(s) with subjects)` : ''}`,
      details: {
        match: { kind: k.kind, value: k.value, tagKey: k.tagKey },
        before: {
          rule: before?.rule ?? 'equal',
          weights: beforeWeights,
          ...(before?.rule === 'measured' ? { measure: before.measure, subjects: Object.fromEntries(storedSubjects(before)) } : {}),
        },
        after: { rule: input.rule, weights: stored, ...(input.rule === 'measured' ? { measure: input.measure, subjects: storedSubj } : {}) },
      },
    });
  });
  return listAllocations({ platformId: k.platformId }).find((a) => a.kind === k.kind && a.value === k.value && a.tagKey === k.tagKey)!;
}
