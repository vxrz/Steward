import {
  COST_PLAN_LIMITS,
  costBookInput,
  costEntryInput,
  costPlanCopyInput,
  costPlanLineInput,
  costPlanLineUpdate,
  defaultBookIndex,
  fiscalYearBounds,
  fitsCurrency,
  lastDayOf,
  fiscalYearLabel,
  fiscalYearMonths,
  fiscalYearOf,
  fromMicros,
  fromMicrosIn,
  isBookable,
  moneyText,
  planMonths,
  toMicros,
  basisDiffers,
  hasFixedEnd,
  type CostContractChange,
  type CostProposalLine,
  type SupplierRef,
  type CostEntry,
  type CostPlanCadence,
  type CostPlanCategory,
  type CostPlanCloudState,
  type CostPlanCurrency,
  type CostPlanFigures,
  type CostPlanLine,
  type CostPlanReadState,
  type CostPlanTarget,
  type CostPlanTargetKind,
  type CostPlanTeamYear,
  type CostPlanYear,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentActor } from '../auth/context.js';
import { catalogueVisibleNow } from '../records/access.js';
import { csvCell } from '../csv.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { costSettings, requireScope, scopeInfo, seesWholeScope, type ScopeInfo } from './access.js';
import { forecastFromGroups } from './query.js';
import { instanceTimeZone, localDate } from '../duties/periods.js';
import { allContracts, resolveSupplierContract, resolveSupplierLink, supplierRefs, visibleContracts } from '../suppliers/links.js';
import { insertScheduleLine, proposalLine, schedulesOfService, scheduleLineTitle, type Schedule } from './schedule-model.js';

/**
 * Service cost planning (0.16.0, ADR 0026, docs/COSTS.md#planning-per-service): plan lines per service and fiscal year,
 * cost entries, and the year view that sets them against each other – with the cloud and platform costs the cost model
 * already links to the service's applications.
 *
 * - Who may change the service (its editors, not while it is archived) changes its plan and its entries, without a
 *   step-up: a plan commits nothing and stops nothing (showback, like the budgets' lowering). Every change is audited
 *   (`cost.plan_line_added|changed|removed`, `cost.plan_copied`, `cost.entry_added|changed|removed`).
 * - Who may see the service reads its plan and entries; amounts follow "hide amounts from viewers" (access.ts).
 * - The cloud and platform costs read for the service cover all its applications: a reader who does not see every
 *   one of them gets no cloud figures (they could be subtracted), only that there are some (`cloud: 'hidden'`).
 * - 0.18.0 (ADR 0030): lines may cover part of the year (`from_index`/`to_index`), the cadence "quarterly", prepaid
 *   one-off payments (`covers_from`/`covers_to`), entries with a supplier and contract, and "Book": one entry from a
 *   line's payment in a month (`cost.entry_added` with `via: "book"`); months with a payment and no entry on their line
 *   are "not booked".
 * - A plan line of category cloud for an application or a platform takes the costs read for it (the platform: the
 *   service's applications' share). Each cost belongs to one line at most: the first line (oldest) for its
 *   application and currency, else the first for its platform and currency; the rest is "cloud and platform (read)".
 */

export interface LineRow {
  id: string;
  service_id: string;
  fiscal_year: number;
  title: string;
  category: CostPlanCategory;
  target_kind: CostPlanTargetKind | null;
  target_id: string | null;
  vendor: string;
  /** The supplier and its contract (0.17.0, ADR 0029); `vendor` stays as the fallback text */
  supplier_id: string | null;
  supplier_contract_id: string | null;
  amount: number;
  currency: string;
  cadence: CostPlanCadence;
  once_index: number | null;
  /** 0.18.0 (ADR 0030): the months of a part-year line (positions 0–11; null: the whole year) */
  from_index: number | null;
  to_index: number | null;
  /** The payment schedule and part it was made from, and the twelve month amounts of that proposal (JSON) */
  schedule_id: string | null;
  schedule_part: string | null;
  schedule_basis: string | null;
  /** The days a prepaid one-off payment covers */
  covers_from: string | null;
  covers_to: string | null;
  renewal_date: string | null;
  note: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface EntryRow {
  id: string;
  service_id: string;
  entry_date: string;
  amount: number;
  currency: string;
  plan_line_id: string | null;
  target_kind: CostPlanTargetKind | null;
  target_id: string | null;
  /** 0.18.0 (ADR 0030): the supplier and contract, and the CSV import it came from */
  supplier_id: string | null;
  supplier_contract_id: string | null;
  import_id: string | null;
  reference: string;
  note: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

/** The months of a line as stored (positions 0–11; null: the whole year) and its currency, for planMonths(). */
export const spanOf = (l: Pick<LineRow, 'from_index' | 'to_index' | 'currency'>) => ({
  from: l.from_index === null || l.from_index === undefined ? null : Number(l.from_index),
  to: l.to_index === null || l.to_index === undefined ? null : Number(l.to_index),
  currency: l.currency,
});
/** The twelve planned month amounts of a line (micros). */
export const lineMonths = (l: Pick<LineRow, 'amount' | 'cadence' | 'once_index' | 'from_index' | 'to_index' | 'currency'>): number[] =>
  planMonths(Number(l.amount), l.cadence, l.once_index === null ? null : Number(l.once_index), spanOf(l));

export const startMonth = () => costSettings().fiscalYearStartMonth;
const pad2 = (n: number) => String(n).padStart(2, '0');
/** Today in the instance's time zone (TZ): an entry dated today counts as incurred, and a month starts at local midnight. */
export const today = (now: number) => {
  const d = localDate(now, instanceTimeZone());
  return `${d.y}-${pad2(d.m)}-${pad2(d.d)}`;
};
export const thisMonth = (now: number) => today(now).slice(0, 7);
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

function serviceInfo(serviceId: string): ScopeInfo {
  return requireScope('service', serviceId);
}

export function requireEdit(serviceId: string): ScopeInfo {
  const info = serviceInfo(serviceId);
  if (!info.canEditBudget) throw new HttpError(403, `You are not allowed to change the cost plan of "${info.name}"`, 'FORBIDDEN', { context: 'costPlan' });
  return info;
}

// ---------- what a line or an entry is for ----------

const serviceApps = (serviceId: string): string[] =>
  db()
    .all<{ application_id: string }>('SELECT application_id FROM service_applications WHERE service_id = ? ORDER BY application_id', serviceId)
    .map((r) => r.application_id);

function serviceSystems(apps: string[]): string[] {
  if (!apps.length) return [];
  return db()
    .all<{ system_id: string }>(
      `SELECT DISTINCT system_id FROM application_systems WHERE application_id IN (${apps.map(() => '?').join(', ')}) ORDER BY system_id`,
      ...apps,
    )
    .map((r) => r.system_id);
}

interface Catalogue {
  apps: Set<string>;
  systems: Set<string>;
}

export function catalogueOf(serviceId: string): Catalogue {
  const apps = serviceApps(serviceId);
  return { apps: new Set(apps), systems: new Set(serviceSystems(apps)) };
}

/** Rows fetched by id in chunks (one statement per 500 ids, never one per id). */
function rowsByIds<R extends { id: string }>(sql: (marks: string) => string, ids: string[]): R[] {
  const out: R[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    out.push(...db().all<R>(sql(part.map(() => '?').join(', ')), ...part));
  }
  return out;
}

interface CatalogueRow {
  id: string;
  name: string;
  owners: string;
}

/**
 * What the lines and entries of a view are for, resolved in bulk: one statement per kind for every target (and the
 * service's own applications and systems, for the forms) – not one or two per line and entry. A platform's visibility
 * is looked up once per platform.
 */
class Targets {
  private readonly apps = new Map<string, CatalogueRow>();
  private readonly systems = new Map<string, CatalogueRow>();
  private readonly platforms = new Map<string, { name: string; visible: boolean }>();
  private readonly seen = new Map<string, boolean>();

  constructor(
    pairs: Iterable<readonly [CostPlanTargetKind | null, string | null]>,
    private readonly cat: Catalogue,
    withOffered = true,
  ) {
    const want: Record<CostPlanTargetKind, Set<string>> = withOffered
      ? { application: new Set(cat.apps), system: new Set(cat.systems), platform: new Set() }
      : { application: new Set(), system: new Set(), platform: new Set() };
    for (const [kind, id] of pairs) if (kind && id) want[kind].add(id);
    for (const r of rowsByIds<CatalogueRow>((m) => `SELECT id, name, owners FROM applications WHERE id IN (${m})`, [...want.application]))
      this.apps.set(r.id, r);
    for (const r of rowsByIds<CatalogueRow>((m) => `SELECT id, name, owners FROM systems WHERE id IN (${m})`, [...want.system])) this.systems.set(r.id, r);
    for (const r of rowsByIds<{ id: string; name: string }>((m) => `SELECT id, name FROM platforms WHERE id IN (${m})`, [...want.platform]))
      this.platforms.set(r.id, { name: r.name, visible: !!scopeInfo('platform', r.id) });
  }

  private visible(kind: 'application' | 'system', r: CatalogueRow): boolean {
    const k = `${kind}|${r.id}`;
    let v = this.seen.get(k);
    if (v === undefined) {
      v = catalogueVisibleNow(kind, r);
      this.seen.set(k, v);
    }
    return v;
  }

  of(kind: CostPlanTargetKind | null, id: string | null): CostPlanTarget | null {
    if (!kind || !id) return null;
    if (kind === 'platform') {
      const p = this.platforms.get(id);
      const visible = !!p?.visible;
      return { kind, id, name: visible ? p!.name : '', visible, ...(p ? {} : { gone: true }) };
    }
    const r = (kind === 'application' ? this.apps : this.systems).get(id);
    const visible = !!r && this.visible(kind, r);
    const gone = !r || !(kind === 'application' ? this.cat.apps : this.cat.systems).has(id);
    return { kind, id, name: visible ? r!.name : '', visible, ...(gone ? { gone: true } : {}) };
  }

  /** The service's applications and systems the reader may see, by name (for the forms). */
  offered(): CostPlanYear['targets'] {
    const of = (kind: 'application' | 'system', ids: Set<string>, rows: Map<string, CatalogueRow>) =>
      [...ids]
        .map((id) => rows.get(id))
        .filter((r): r is CatalogueRow => !!r && this.visible(kind, r))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1))
        .map((r) => ({ kind, id: r.id, name: r.name }));
    return [...of('application', this.cat.apps, this.apps), ...of('system', this.cat.systems, this.systems)];
  }
}

export function targetOf(kind: CostPlanTargetKind | null, id: string | null, cat: Catalogue): CostPlanTarget | null {
  return new Targets([[kind, id]], cat, false).of(kind, id);
}

/** An application or system of the service, or a platform – one the caller may see. */
export function checkTarget(t: { kind: CostPlanTargetKind; id: string } | null, cat: Catalogue): void {
  if (!t) return;
  const refuse = () => {
    throw new HttpError(400, `Not an application or system of this service, or a platform you may see: ${t.kind} ${t.id}`, 'COST_PLAN_TARGET', {
      kind: t.kind,
    });
  };
  const x = targetOf(t.kind, t.id, cat);
  if (!x || !x.visible || x.gone) refuse();
}

// ---------- reading ----------

export const lineRows = (serviceId: string, fiscalYear: number) =>
  db().all<LineRow>(
    // lines added in one step (a contract's proposal) in the order of their months
    'SELECT * FROM cost_plan_lines WHERE service_id = ? AND fiscal_year = ? ORDER BY created_at, COALESCE(from_index, once_index, 0), id',
    serviceId,
    fiscalYear,
  );

const entryRows = (serviceId: string, from: string, to: string) =>
  db().all<EntryRow>(
    'SELECT * FROM cost_entries WHERE service_id = ? AND entry_date >= ? AND entry_date < ? ORDER BY entry_date, created_at, id',
    serviceId,
    from,
    to,
  );

interface Bucket {
  app: string | null;
  plat: string;
  month: string;
  currency: string;
  e: number;
  end: string | null;
}

/** The costs read for these applications in the months, per application, platform, month and currency. */
function readBuckets(apps: string[], first: string, last: string): Bucket[] {
  if (!apps.length) return [];
  return db()
    .all<{ app: string | null; plat: string; month: string; currency: string; e: number; e_end: string | null }>(
      `SELECT application_id AS app, platform_id AS plat, month, billing_currency AS currency, SUM(effective_cost) AS e, MAX(charge_period_end) AS e_end
         FROM cost_records WHERE application_id IN (${apps.map(() => '?').join(', ')}) AND month >= ? AND month <= ?
         GROUP BY application_id, platform_id, month, billing_currency`,
      ...apps,
      first,
      last,
    )
    .map((r) => ({ app: r.app, plat: r.plat, month: r.month, currency: r.currency, e: Number(r.e ?? 0), end: r.e_end }));
}

const zeros = () => Array.from({ length: 12 }, () => 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

interface Figures {
  planned: number;
  plannedToDate: number;
  incurredToDate: number;
  expected: number;
}

const matchable = (l: LineRow) => l.category === 'cloud' && (l.target_kind === 'application' || l.target_kind === 'platform') && !!l.target_id;

/**
 * The year view of a service's plan: lines, entries, the costs read, per currency – see the module comment and
 * docs/COSTS.md#planning-per-service for how "to date" and "expected" are worked out.
 */
export function planYear(serviceId: string, year?: number, now = Date.now()): CostPlanYear {
  return planYearOf(serviceInfo(serviceId), year, now, startMonth());
}

/** The year view for a service the caller may see (`info`), with the fiscal year start read once by the caller. */
export function planYearOf(info: ScopeInfo, year: number | undefined, now: number, start: number): CostPlanYear {
  const serviceId = info.id;
  const nowMonth = thisMonth(now);
  const day = today(now);
  const fy = year ?? fiscalYearOf(nowMonth, start);
  const months = fiscalYearMonths(fy, start);
  const cur = nowMonth < months[0]! ? -1 : nowMonth > months[11]! ? 12 : months.indexOf(nowMonth);
  const bounds = fiscalYearBounds(fy, start);
  const cat = catalogueOf(serviceId);
  const lines = lineRows(serviceId, fy);
  const entries = entryRows(serviceId, bounds.from, bounds.to);
  const targets = new Targets([...lines.map((l) => [l.target_kind, l.target_id] as const), ...entries.map((e) => [e.target_kind, e.target_id] as const)], cat);
  const suppliers = new Suppliers([...lines, ...entries]);
  const show = (n: number) => (info.amounts ? fromMicros(n) : null);
  // ---- payment schedules (ADR 0030): what each schedule proposes for the year, against the lines made from it ----
  const curFy = fiscalYearOf(nowMonth, start);
  const schedules = schedulesOfService(serviceId);
  const scheduleById = new Map(schedules.map((x) => [x.row.id, x]));
  const scheduleChanges = new Map<string, CostContractChange[]>();
  // fiscal years that are over are never offered: history stays as planned
  if (fy >= curFy)
    for (const sch of schedules) {
      const mine = lines.filter((l) => l.schedule_id === sch.row.id);
      if (!mine.length) continue;
      const parts = sch.parts(fy, start);
      const changes: CostContractChange[] = [];
      for (const l of mine) {
        const p = parts.find((x) => x.part === l.schedule_part);
        if (!p || basisDiffers(basisOf(l), p.months))
          changes.push({
            part: l.schedule_part ?? '',
            lineId: l.id,
            before: lineAsProposal(l, months, show),
            after: p ? proposalLine(p, l.title, months, show) : null,
            entries: entries.filter((e) => e.plan_line_id === l.id).length,
          });
      }
      for (const p of parts)
        if (!mine.some((l) => l.schedule_part === p.part))
          changes.push({ part: p.part, lineId: null, before: null, after: proposalLine(p, lineTitleFor(sch), months, show), entries: 0 });
      // a part that goes (its entries become unplanned) first
      changes.sort((a, b) => Number(!!a.after) - Number(!!b.after));
      if (changes.length) scheduleChanges.set(sch.row.id, changes);
    }
  // contracts with a schedule paying in this year: a hand-made line for one of them is a second line for it
  const scheduledContracts = new Set(schedules.filter((x) => x.parts(fy, start).length).map((x) => x.contract.id));
  const monthIndex = (date: string) => months.indexOf(date.slice(0, 7));

  // ---- the costs read (cloud and platform), whole service ----
  const apps = [...cat.apps];
  const buckets = readBuckets(apps, months[0]!, months[11]!);
  const whole = seesWholeScope('service', serviceId);
  const cloud: CostPlanCloudState = !buckets.length ? 'none' : whole ? 'shown' : 'hidden';
  const takers = new Map<string, string>();
  for (const l of lines)
    if (matchable(l)) {
      const k = `${l.target_kind}|${l.target_id}|${l.currency}`;
      if (!takers.has(k)) takers.set(k, l.id);
    }
  const readOf = new Map<string, Bucket[]>(); // line id (or "" for the rest) → its buckets
  if (cloud === 'shown')
    for (const b of buckets) {
      const owner = (b.app && takers.get(`application|${b.app}|${b.currency}`)) || takers.get(`platform|${b.plat}|${b.currency}`) || '';
      const list = readOf.get(owner);
      if (list) list.push(b);
      else readOf.set(owner, [b]);
    }
  /** Per month what was read, and the forecast of the current month (null: none) */
  const readMonths = (bs: Bucket[], currency?: string) => {
    const m = zeros();
    const mine = currency ? bs.filter((b) => b.currency === currency) : bs;
    for (const b of mine) {
      const i = months.indexOf(b.month);
      if (i >= 0) m[i]! += b.e;
    }
    const inCur = cur >= 0 && cur < 12 ? mine.filter((b) => b.month === nowMonth) : [];
    const fc = inCur.length ? (forecastFromGroups(inCur, nowMonth, now).values().next().value ?? null) : null;
    return { m, fc, any: (i: number) => mine.some((b) => b.month === months[i]) };
  };

  // ---- the lines ----
  const lineIds = new Set(lines.map((l) => l.id));
  const byLine = new Map<string, EntryRow[]>();
  for (const e of entries)
    if (e.plan_line_id && lineIds.has(e.plan_line_id)) {
      const list = byLine.get(e.plan_line_id);
      if (list) list.push(e);
      else byLine.set(e.plan_line_id, [e]);
    }
  const perCurrency = new Map<string, { plan: number[]; incurred: number[]; read: number[]; f: Figures }>();
  const acc = (currency: string) => {
    let x = perCurrency.get(currency);
    if (!x) {
      x = { plan: zeros(), incurred: zeros(), read: zeros(), f: { planned: 0, plannedToDate: 0, incurredToDate: 0, expected: 0 } };
      perCurrency.set(currency, x);
    }
    return x;
  };
  const add = (f: Figures, g: Figures) => {
    f.planned += g.planned;
    f.plannedToDate += g.plannedToDate;
    f.incurredToDate += g.incurredToDate;
    f.expected += g.expected;
  };

  const outLines: CostPlanLine[] = lines.map((l) => {
    const plan = lineMonths(l);
    const es = byLine.get(l.id) ?? [];
    const booked = zeros();
    const has = Array.from({ length: 12 }, () => false);
    let entriesToDate = 0;
    for (const e of es) {
      const i = monthIndex(e.entry_date);
      if (i < 0) continue;
      booked[i]! += Number(e.amount);
      has[i] = true;
      if (e.entry_date <= day) entriesToDate += Number(e.amount);
    }
    let read: CostPlanReadState = 'none';
    if (matchable(l)) {
      if (cloud === 'hidden') read = 'hidden';
      else read = takers.get(`${l.target_kind}|${l.target_id}|${l.currency}`) === l.id ? 'matched' : 'taken';
    }
    const r = readMonths(read === 'matched' ? (readOf.get(l.id) ?? []) : []);
    const incurred = booked.map((b, i) => b + r.m[i]!);
    const upto = Math.min(cur, 11);
    const planned = sum(plan);
    const plannedToDate = upto < 0 ? 0 : sum(plan.slice(0, upto + 1));
    const incurredToDate = entriesToDate + (upto < 0 ? 0 : sum(r.m.slice(0, upto + 1)));
    let expected: number;
    if (read === 'matched' || l.cadence === 'monthly' || l.cadence === 'quarterly') {
      // month by month: what was incurred in the months that are over; for the current month and those to come what
      // is booked (the current month: its forecast from the costs read), else the plan
      expected = 0;
      for (let i = 0; i < 12; i++) {
        if (i < cur) expected += incurred[i]!;
        else if (i === cur) {
          const readNow = read === 'matched' && r.any(i) ? (r.fc ?? r.m[i]!) : 0;
          expected += has[i] || (read === 'matched' && r.any(i)) ? booked[i]! + readNow : plan[i]!;
        } else expected += has[i] ? booked[i]! : plan[i]!;
      }
    } else {
      // a yearly or one-off amount: what is booked counts against it, so at least the plan is expected
      expected = Math.max(planned, sum(booked));
    }
    const f = { planned, plannedToDate, incurredToDate, expected };
    const c = acc(l.currency);
    add(c.f, f);
    plan.forEach((v, i) => (c.plan[i]! += v));
    incurred.forEach((v, i) => (c.incurred[i]! += v));
    r.m.forEach((v, i) => (c.read[i]! += v));
    const bookable = isBookable(l.cadence);
    const idx = (v: number | null) => (v === null || v === undefined ? null : (months[Number(v)] ?? null));
    const sch = l.schedule_id ? scheduleById.get(l.schedule_id) : undefined;
    const part = sch?.parts(fy, start).find((x) => x.part === l.schedule_part);
    return {
      id: l.id,
      serviceId: l.service_id,
      fiscalYear: Number(l.fiscal_year),
      title: l.title,
      category: l.category,
      target: targets.of(l.target_kind, l.target_id),
      vendor: l.vendor,
      ...suppliers.line(l),
      amount: show(Number(l.amount)),
      currency: l.currency,
      cadence: l.cadence,
      onceMonth: l.cadence === 'once' && l.once_index !== null ? (months[Number(l.once_index)] ?? null) : null,
      fromMonth: l.cadence === 'once' ? null : idx(l.from_index),
      toMonth: l.cadence === 'once' ? null : idx(l.to_index),
      coversFrom: l.covers_from ?? null,
      coversTo: l.covers_to ?? null,
      renewalDate: l.renewal_date,
      note: l.note,
      schedule: sch ? { id: sch.row.id, contractId: sch.contract.id, title: sch.row.title, changed: scheduleChanges.has(sch.row.id) } : null,
      contractEnds: suppliers.contractEnds(l, bounds),
      twoLines: !l.schedule_id && !!l.supplier_contract_id && scheduledContracts.has(l.supplier_contract_id),
      paymentDates: part?.paymentDates ?? null,
      bookable: bookable && plan.some((v) => v !== 0),
      // the payments of the months that are over and of the current month without an entry on the line
      notBooked: bookable ? months.filter((_, i) => i <= cur && plan[i] !== 0 && !has[i]) : [],
      months: plan.map(show),
      incurredMonths: incurred.map((v, i) => (i > cur && !has[i] ? null : show(v))),
      planned: show(planned),
      plannedToDate: show(plannedToDate),
      incurredToDate: show(incurredToDate),
      expected: show(expected),
      difference: show(expected - planned),
      read,
      entries: es.length,
      createdAt: l.created_at,
      createdBy: l.created_by,
      updatedAt: l.updated_at,
      updatedBy: l.updated_by,
    };
  });

  // ---- unplanned entries ----
  const unplanned = new Map<string, { toDate: number; all: number; count: number }>();
  for (const e of entries) {
    if (e.plan_line_id && lineIds.has(e.plan_line_id)) continue;
    const u = unplanned.get(e.currency) ?? { toDate: 0, all: 0, count: 0 };
    u.all += Number(e.amount);
    u.count++;
    if (e.entry_date <= day) u.toDate += Number(e.amount);
    unplanned.set(e.currency, u);
    const c = acc(e.currency);
    const i = monthIndex(e.entry_date);
    if (i >= 0) c.incurred[i]! += Number(e.amount);
  }

  // ---- the costs read that no line takes ----
  const rest = readOf.get('') ?? [];
  const restCurrencies = [...new Set(rest.map((b) => b.currency))];
  const restOf = new Map<string, { m: number[]; toDate: number; expected: number }>();
  for (const currency of restCurrencies) {
    const r = readMonths(rest, currency);
    const upto = Math.min(cur, 11);
    const toDate = upto < 0 ? 0 : sum(r.m.slice(0, upto + 1));
    let expected = toDate;
    if (cur >= 0 && cur < 12) {
      // the current month's forecast, and the months to come at that rate (else the last month's)
      const nowValue = r.fc ?? r.m[cur]!;
      const rate = r.fc ?? (cur > 0 ? r.m[cur - 1]! : r.m[cur]!);
      expected = sum(r.m.slice(0, cur)) + nowValue + rate * (11 - cur);
    }
    restOf.set(currency, { m: r.m, toDate, expected });
    const c = acc(currency);
    r.m.forEach((v, i) => {
      c.incurred[i]! += v;
      c.read[i]! += v;
    });
  }

  // ---- per currency ----
  const currencies: CostPlanCurrency[] = [...perCurrency.keys()].sort().map((currency) => {
    const c = perCurrency.get(currency)!;
    const u = unplanned.get(currency);
    const r = restOf.get(currency);
    const f = { ...c.f };
    if (u) add(f, { planned: 0, plannedToDate: 0, incurredToDate: u.toDate, expected: u.all });
    if (r) add(f, { planned: 0, plannedToDate: 0, incurredToDate: r.toDate, expected: r.expected });
    return {
      currency,
      months: months.map((month, i) => ({
        month,
        planned: show(c.plan[i]!),
        incurred: i > cur && c.incurred[i] === 0 ? null : show(c.incurred[i]!),
        read: cloud === 'shown' && i <= cur ? show(c.read[i]!) : null,
      })),
      ...figures(f, show),
      read: r ? { incurredToDate: show(r.toDate), expected: show(r.expected), months: r.m.map((v, i) => (i > cur ? null : show(v))) } : null,
      unplanned: { incurredToDate: show(u?.toDate ?? 0), expected: show(u?.all ?? 0), count: u?.count ?? 0 },
    };
  });

  const titleOf = new Map(lines.map((l) => [l.id, l.title]));
  const lineTarget = new Map(lines.map((l) => [l.id, l]));
  // entries linked to a line of another fiscal year (the start month changed since): the link stays, named with its year
  const elsewhere = new Map<string, { title: string; fiscalYear: number }>();
  const otherIds = [...new Set(entries.filter((e) => e.plan_line_id && !lineIds.has(e.plan_line_id)).map((e) => e.plan_line_id!))];
  for (const r of rowsByIds<{ id: string; title: string; fiscal_year: number }>(
    (m) => `SELECT id, title, fiscal_year FROM cost_plan_lines WHERE id IN (${m})`,
    otherIds,
  ))
    elsewhere.set(r.id, { title: r.title, fiscalYear: Number(r.fiscal_year) });
  const outEntries: CostEntry[] = entries.map((e) => {
    const line = e.plan_line_id ? lineTarget.get(e.plan_line_id) : undefined;
    const other = e.plan_line_id && !line ? elsewhere.get(e.plan_line_id) : undefined;
    return {
      id: e.id,
      serviceId: e.service_id,
      date: e.entry_date,
      amount: show(Number(e.amount)),
      currency: e.currency,
      planLineId: e.plan_line_id,
      planLineTitle: e.plan_line_id ? (titleOf.get(e.plan_line_id) ?? other?.title ?? null) : null,
      target: e.target_kind ? targets.of(e.target_kind, e.target_id) : line ? targets.of(line.target_kind, line.target_id) : null,
      ...suppliers.line(e),
      importId: e.import_id ?? null,
      reference: e.reference,
      note: e.note,
      unplanned: !line,
      planLineYear: other ? { fiscalYear: other.fiscalYear, label: fiscalYearLabel(other.fiscalYear, start) } : null,
      createdAt: e.created_at,
      createdBy: e.created_by,
      updatedAt: e.updated_at,
      updatedBy: e.updated_by,
    };
  });

  return {
    serviceId,
    serviceName: info.name,
    fiscalYear: fy,
    label: fiscalYearLabel(fy, start),
    startMonth: start,
    months,
    currentIndex: cur,
    from: bounds.from,
    to: bounds.last,
    amountsVisible: info.amounts,
    canEdit: info.canEditBudget,
    cloud,
    lines: outLines,
    entries: outEntries,
    currencies,
    renewals: renewals(serviceId, now),
    targets: targets.offered(),
    years: yearsOf(serviceId, fy, fiscalYearOf(nowMonth, start), start),
    limits: { linesPerYear: COST_PLAN_LIMITS.linesPerYear, entriesPerYear: COST_PLAN_LIMITS.entriesPerYear },
    prepaid: prepaidRows(serviceId, fy, bounds, start, show),
    proposals: schedules.filter((x) => x.parts(fy, start).length && !lines.some((l) => l.schedule_id === x.row.id)).length,
    contractChanges: [...scheduleChanges.entries()].map(([scheduleId, changes]) => ({
      scheduleId,
      title: lineTitleFor(scheduleById.get(scheduleId)!),
      changes,
    })),
  };
}

/** The title of a schedule's lines – without the contract's title for a reader who may not see the contract. */
function lineTitleFor(s: Schedule): string {
  return visibleContracts([s.contract.id]).has(s.contract.id) ? scheduleLineTitle(s) : s.row.title;
}

/** The twelve month amounts a schedule line was made from. */
const basisOf = (l: LineRow): number[] | null => {
  if (!l.schedule_basis) return null;
  const v = parseJson<unknown>(l.schedule_basis, null);
  return Array.isArray(v) ? v.map((x) => Number(x)) : null;
};

/** A line as "before" in Update lines: its values now (a line changed by hand shows the hand-made value). */
function lineAsProposal(l: LineRow, months: string[], show: (n: number) => string | null): CostProposalLine {
  const m = lineMonths(l);
  return {
    part: l.schedule_part ?? '',
    title: l.title,
    cadence: l.cadence,
    fromMonth: l.cadence === 'once' ? null : (months[l.from_index === null ? 0 : Number(l.from_index)] ?? null),
    toMonth: l.cadence === 'once' ? null : (months[l.to_index === null ? 11 : Number(l.to_index)] ?? null),
    onceMonth: l.once_index === null ? null : (months[Number(l.once_index)] ?? null),
    amount: show(Number(l.amount)),
    planned: show(m.reduce((a, b) => a + b, 0)),
    coversFrom: l.covers_from ?? null,
    coversTo: l.covers_to ?? null,
  };
}

/**
 * Prepaid payments of earlier fiscal years that cover part of this one (ADR 0030 part 4): quiet rows "Prepaid in
 * FY …", not counted – cash by the year it leaves, no amortisation.
 */
function prepaidRows(
  serviceId: string,
  fy: number,
  bounds: { from: string; last: string },
  start: number,
  show: (n: number) => string | null,
): CostPlanYear['prepaid'] {
  return db()
    .all<{ id: string; title: string; fiscal_year: number; amount: number; currency: string; covers_from: string; covers_to: string }>(
      `SELECT id, title, fiscal_year, amount, currency, covers_from, covers_to FROM cost_plan_lines
        WHERE service_id = ? AND fiscal_year < ? AND covers_from IS NOT NULL AND covers_to >= ? AND covers_from <= ? ORDER BY fiscal_year, title, id`,
      serviceId,
      fy,
      bounds.from,
      bounds.last,
    )
    .map((r) => ({
      lineId: r.id,
      title: r.title,
      fiscalYear: Number(r.fiscal_year),
      label: fiscalYearLabel(Number(r.fiscal_year), start),
      amount: show(Number(r.amount)),
      currency: r.currency,
      coversFrom: r.covers_from,
      coversTo: r.covers_to,
    }));
}

function figures(f: Figures, show: (n: number) => string | null): CostPlanFigures {
  return {
    planned: show(f.planned),
    plannedToDate: show(f.plannedToDate),
    incurredToDate: show(f.incurredToDate),
    expected: show(f.expected),
    difference: show(f.expected - f.planned),
  };
}

function renewals(serviceId: string, now: number): CostPlanYear['renewals'] {
  const from = today(now);
  const to = addDays(from, COST_PLAN_LIMITS.renewalDays);
  const seen = new Set<string>();
  const out: CostPlanYear['renewals'] = [];
  for (const r of db().all<{ id: string; title: string; fiscal_year: number; renewal_date: string }>(
    `SELECT id, title, fiscal_year, renewal_date FROM cost_plan_lines WHERE service_id = ? AND renewal_date >= ? AND renewal_date <= ?
      ORDER BY renewal_date, fiscal_year DESC, title`,
    serviceId,
    from,
    to,
  )) {
    // a line copied into the next year names the same renewal: once
    const k = `${r.title.toLowerCase()}|${r.renewal_date}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      lineId: r.id,
      title: r.title,
      fiscalYear: Number(r.fiscal_year),
      renewalDate: r.renewal_date,
      days: Math.round((Date.parse(`${r.renewal_date}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000),
    });
  }
  return out;
}

function yearsOf(serviceId: string, shown: number, current: number, start: number): CostPlanYear['years'] {
  const ys = new Set<number>([shown, current, current + 1]);
  for (const r of db().all<{ fy: number }>('SELECT DISTINCT fiscal_year AS fy FROM cost_plan_lines WHERE service_id = ?', serviceId)) ys.add(Number(r.fy));
  for (const r of db().all<{ m: string }>('SELECT DISTINCT substr(entry_date, 1, 7) AS m FROM cost_entries WHERE service_id = ?', serviceId))
    ys.add(fiscalYearOf(r.m, start));
  return [...ys].sort((a, b) => b - a).map((fiscalYear) => ({ fiscalYear, label: fiscalYearLabel(fiscalYear, start) }));
}

// ---------- plan lines ----------

const fmt = (micros: number, currency: string) => moneyText(micros, currency);

function lineRow(serviceId: string, lineId: string): LineRow {
  const r = db().get<LineRow>('SELECT * FROM cost_plan_lines WHERE id = ? AND service_id = ?', lineId, serviceId);
  if (!r) throw new HttpError(404, `Plan line ${lineId} not found`, 'COST_PLAN_LINE_NOT_FOUND');
  return r;
}

/** The position (0–11) of a month in the fiscal year; 400 outside it. */
function monthIndexIn(month: string, fiscalYear: number): number {
  const i = fiscalYearMonths(fiscalYear, startMonth()).indexOf(month);
  if (i < 0)
    throw new HttpError(400, `The month ${month} is not in ${fiscalYearLabel(fiscalYear, startMonth())}`, 'COST_PLAN_MONTH', {
      month,
      year: fiscalYearLabel(fiscalYear, startMonth()),
    });
  return i;
}

/** The position (0–11) of a one-off payment's month in the fiscal year; 400 outside it. */
function onceIndexOf(cadence: CostPlanCadence, onceMonth: string | null, fiscalYear: number): number | null {
  if (cadence !== 'once' || !onceMonth) return null;
  return monthIndexIn(onceMonth, fiscalYear);
}

/**
 * The months a monthly, quarterly or yearly line covers (ADR 0030): positions 0–11 in the fiscal year, null for the
 * whole year (also when from and to are the first and the last month); one-off lines have their month instead.
 */
function spanIndexOf(
  x: { cadence: CostPlanCadence; fromMonth: string | null; toMonth: string | null },
  fiscalYear: number,
): { from_index: number | null; to_index: number | null } {
  if (x.cadence === 'once') return { from_index: null, to_index: null };
  const from = x.fromMonth ? monthIndexIn(x.fromMonth, fiscalYear) : 0;
  const to = x.toMonth ? monthIndexIn(x.toMonth, fiscalYear) : 11;
  if (to < from) throw new HttpError(400, 'The last month is before the first', 'COST_PLAN_SPAN');
  return { from_index: from === 0 && to === 11 ? null : from, to_index: from === 0 && to === 11 ? null : to };
}

/** The days a prepaid one-off payment covers (none for other cadences). */
const coversOf = (x: { cadence: CostPlanCadence; coversFrom: string | null; coversTo: string | null }) =>
  x.cadence === 'once' && x.coversFrom && x.coversTo ? { covers_from: x.coversFrom, covers_to: x.coversTo } : { covers_from: null, covers_to: null };

/**
 * The suppliers and contracts of a view's lines and entries as the reader may see them, read in bulk (one statement
 * for the suppliers, one for the contracts – contracts through contractVisible, ADR 0030/0031).
 */
class Suppliers {
  private readonly refs: Map<string, SupplierRef>;
  private readonly contracts: ReturnType<typeof visibleContracts>;
  constructor(rows: readonly Pick<LineRow, 'supplier_id' | 'supplier_contract_id'>[]) {
    this.refs = supplierRefs(rows.map((r) => r.supplier_id));
    this.contracts = visibleContracts(rows.map((r) => r.supplier_contract_id));
  }
  /** A 0.17-style contract line (no schedule): the end of its contract when that falls in the line's fiscal year. */
  contractEnds(l: Pick<LineRow, 'supplier_contract_id' | 'schedule_id'>, bounds: { from: string; last: string }): string | null {
    const c = !l.schedule_id && l.supplier_contract_id ? this.contracts.get(l.supplier_contract_id) : undefined;
    if (!c || !hasFixedEnd(c) || !c.endsOn) return null;
    return c.endsOn >= bounds.from && c.endsOn <= bounds.last ? c.endsOn : null;
  }
  line(l: Pick<LineRow, 'supplier_id' | 'supplier_contract_id'>): Pick<CostPlanLine, 'supplier' | 'supplierHidden' | 'supplierContract'> {
    const supplier = l.supplier_id ? (this.refs.get(l.supplier_id) ?? null) : null;
    const c = supplier && l.supplier_contract_id ? this.contracts.get(l.supplier_contract_id) : undefined;
    return {
      supplier,
      supplierHidden: !!l.supplier_id && !supplier,
      supplierContract: c && c.supplierId === supplier!.id ? { id: c.id, title: c.title, reference: c.reference } : null,
    };
  }
}

const lineSnapshot = (
  r: Pick<
    LineRow,
    | 'title'
    | 'category'
    | 'target_kind'
    | 'target_id'
    | 'vendor'
    | 'supplier_id'
    | 'supplier_contract_id'
    | 'amount'
    | 'currency'
    | 'cadence'
    | 'once_index'
    | 'from_index'
    | 'to_index'
    | 'covers_from'
    | 'covers_to'
    | 'renewal_date'
  >,
) => ({
  title: r.title,
  category: r.category,
  target: r.target_kind ? { kind: r.target_kind, id: r.target_id } : null,
  vendor: r.vendor,
  supplierId: r.supplier_id ?? null,
  supplierContractId: r.supplier_contract_id ?? null,
  amount: fromMicros(Number(r.amount)),
  currency: r.currency,
  cadence: r.cadence,
  onceIndex: r.once_index === null ? null : Number(r.once_index),
  fromIndex: r.from_index === null || r.from_index === undefined ? null : Number(r.from_index),
  toIndex: r.to_index === null || r.to_index === undefined ? null : Number(r.to_index),
  coversFrom: r.covers_from ?? null,
  coversTo: r.covers_to ?? null,
  renewalDate: r.renewal_date,
});

export function addPlanLine(serviceId: string, body: unknown): CostPlanYear {
  const info = requireEdit(serviceId);
  const x = costPlanLineInput.parse(body);
  checkTarget(x.target, catalogueOf(serviceId));
  const onceIndex = onceIndexOf(x.cadence, x.onceMonth, x.fiscalYear);
  const span = spanIndexOf(x, x.fiscalYear);
  const covers = coversOf(x);
  const n = Number(
    db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_plan_lines WHERE service_id = ? AND fiscal_year = ?', serviceId, x.fiscalYear)?.n ?? 0,
  );
  if (n >= COST_PLAN_LIMITS.linesPerYear)
    throw new HttpError(409, `A service has at most ${COST_PLAN_LIMITS.linesPerYear} plan lines per fiscal year`, 'COST_PLAN_LIMIT', {
      max: COST_PLAN_LIMITS.linesPerYear,
    });
  const id = newId('cpl_');
  const now = nowIso();
  const amount = toMicros(x.amount)!;
  const supplierId = resolveSupplierLink(x.supplierId, null);
  const row = {
    title: x.title,
    category: x.category,
    target_kind: x.target?.kind ?? null,
    target_id: x.target?.id ?? null,
    vendor: x.vendor,
    supplier_id: supplierId,
    supplier_contract_id: resolveSupplierContract(supplierId, x.supplierContractId, null),
    amount,
    currency: x.currency,
    cadence: x.cadence,
    once_index: onceIndex,
    ...span,
    ...covers,
    renewal_date: x.renewalDate,
  };
  db().tx(() => {
    db().run(
      `INSERT INTO cost_plan_lines (id, service_id, fiscal_year, title, category, target_kind, target_id, vendor, supplier_id, supplier_contract_id, amount, currency, cadence,
         once_index, from_index, to_index, covers_from, covers_to, renewal_date, note, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      serviceId,
      x.fiscalYear,
      x.title,
      x.category,
      row.target_kind,
      row.target_id,
      x.vendor,
      row.supplier_id,
      row.supplier_contract_id,
      amount,
      x.currency,
      x.cadence,
      onceIndex,
      span.from_index,
      span.to_index,
      covers.covers_from,
      covers.covers_to,
      x.renewalDate,
      x.note,
      now,
      currentActor(),
      now,
      currentActor(),
    );
    audit({
      action: 'cost.plan_line_added',
      entityType: 'service',
      entityId: serviceId,
      summary: `Plan line "${x.title}" added to the cost plan of "${info.name}" for ${fiscalYearLabel(x.fiscalYear, startMonth())}: ${fmt(amount, x.currency)} ${x.cadence}`,
      details: { lineId: id, fiscalYear: x.fiscalYear, after: lineSnapshot(row) },
    });
  });
  return planYearOf(info, x.fiscalYear, Date.now(), startMonth());
}

export function updatePlanLine(serviceId: string, lineId: string, body: unknown): CostPlanYear {
  const info = requireEdit(serviceId);
  const before = lineRow(serviceId, lineId);
  const x = costPlanLineUpdate.parse(body);
  const fy = Number(before.fiscal_year);
  // a target already on the line may stay as it is (also one removed from the service since)
  const sameTarget = x.target && x.target.kind === before.target_kind && x.target.id === before.target_id;
  if (!sameTarget) checkTarget(x.target, catalogueOf(serviceId));
  const onceIndex = onceIndexOf(x.cadence, x.onceMonth, fy);
  const span = spanIndexOf(x, fy);
  const covers = coversOf(x);
  if (x.currency !== before.currency) {
    const other = db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_entries WHERE plan_line_id = ? AND currency <> ?', lineId, x.currency);
    if (Number(other?.n ?? 0) > 0)
      throw new HttpError(409, 'The line has entries in another currency – move or change them first', 'COST_PLAN_CURRENCY', { currency: before.currency });
  }
  const amount = toMicros(x.amount)!;
  const supplierId = resolveSupplierLink(x.supplierId, before.supplier_id);
  // "Unlink from contract" (ADR 0030): an ordinary line from now on, without Contract changed hints
  const unlink = x.scheduleId === null && !!before.schedule_id;
  const row = {
    title: x.title,
    category: x.category,
    target_kind: x.target?.kind ?? null,
    target_id: x.target?.id ?? null,
    vendor: x.vendor,
    supplier_id: supplierId,
    supplier_contract_id: resolveSupplierContract(supplierId, x.supplierContractId, supplierId === before.supplier_id ? before.supplier_contract_id : null),
    amount,
    currency: x.currency,
    cadence: x.cadence,
    once_index: onceIndex,
    ...span,
    ...covers,
    renewal_date: x.renewalDate,
  };
  db().tx(() => {
    db().run(
      `UPDATE cost_plan_lines SET title = ?, category = ?, target_kind = ?, target_id = ?, vendor = ?, supplier_id = ?, supplier_contract_id = ?, amount = ?, currency = ?,
         cadence = ?, once_index = ?, from_index = ?, to_index = ?, covers_from = ?, covers_to = ?, renewal_date = ?, note = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      x.title,
      x.category,
      row.target_kind,
      row.target_id,
      x.vendor,
      row.supplier_id,
      row.supplier_contract_id,
      amount,
      x.currency,
      x.cadence,
      onceIndex,
      span.from_index,
      span.to_index,
      covers.covers_from,
      covers.covers_to,
      x.renewalDate,
      x.note,
      nowIso(),
      currentActor(),
      lineId,
    );
    if (unlink) db().run('UPDATE cost_plan_lines SET schedule_id = NULL, schedule_part = NULL, schedule_basis = NULL WHERE id = ?', lineId);
    audit({
      action: 'cost.plan_line_changed',
      entityType: 'service',
      entityId: serviceId,
      summary: `Plan line "${x.title}" of "${info.name}" (${fiscalYearLabel(fy, startMonth())}) changed: ${fmt(amount, x.currency)} ${x.cadence} (was ${fmt(Number(before.amount), before.currency)} ${before.cadence})`,
      details: {
        lineId,
        fiscalYear: fy,
        before: lineSnapshot(before),
        after: lineSnapshot(row),
        ...(unlink ? { unlinkedFromSchedule: before.schedule_id } : {}),
      },
    });
  });
  return planYearOf(info, fy, Date.now(), startMonth());
}

/** Removes a plan line; its entries stay and become unplanned. */
export function removePlanLine(serviceId: string, lineId: string): CostPlanYear {
  const info = requireEdit(serviceId);
  const before = lineRow(serviceId, lineId);
  const fy = Number(before.fiscal_year);
  db().tx(() => {
    const unlinked = db().run('UPDATE cost_entries SET plan_line_id = NULL WHERE plan_line_id = ?', lineId).changes;
    db().run('DELETE FROM cost_plan_lines WHERE id = ?', lineId);
    audit({
      action: 'cost.plan_line_removed',
      entityType: 'service',
      entityId: serviceId,
      summary: `Plan line "${before.title}" removed from the cost plan of "${info.name}" (${fiscalYearLabel(fy, startMonth())})${unlinked ? `; ${unlinked} entr${unlinked === 1 ? 'y is' : 'ies are'} unplanned now` : ''}`,
      details: { lineId, fiscalYear: fy, before: lineSnapshot(before), entriesUnplanned: unlinked },
    });
  });
  return planYearOf(info, fy, Date.now(), startMonth());
}

/**
 * Copies the plan lines of a fiscal year into the next one. A renewal date before the new year moves on by a year;
 * one-off payments keep their position in the year. With contracts (ADR 0030): a line made from a payment schedule is
 * not copied – the schedule's proposal for the new year is added instead (when it has payments there and is not
 * planned there yet); a line that names a contract without a schedule (0.17 style) is left out when the contract ends
 * before the new year, copied up to the end's month (monthly and quarterly lines) or copied as it is and marked
 * "Contract ends …" (yearly and one-off lines) when it ends in it. Refused only when the new year has lines that were
 * not made from a schedule – confirming a contract's next year early does not block it.
 */
export function copyPlanYear(serviceId: string, body: unknown): CostPlanYear {
  const info = requireEdit(serviceId);
  const { fiscalYear: fromYear } = costPlanCopyInput.parse(body);
  const toYear = fromYear + 1;
  const start = startMonth();
  const src = lineRows(serviceId, fromYear);
  if (!src.length) throw new HttpError(400, `${fiscalYearLabel(fromYear, start)} has no plan lines to copy`, 'COST_PLAN_NOTHING_TO_COPY');
  const there = lineRows(serviceId, toYear);
  if (there.some((l) => !l.schedule_id))
    throw new HttpError(409, `${fiscalYearLabel(toYear, start)} has plan lines already`, 'COST_PLAN_YEAR_NOT_EMPTY', {
      year: fiscalYearLabel(toYear, start),
    });
  const nb = fiscalYearBounds(toYear, start);
  const newMonths = fiscalYearMonths(toYear, start);
  const contracts = allContracts(src.map((l) => l.supplier_contract_id));
  const result = { copied: [] as string[], proposed: [] as string[], shortened: [] as string[], leftOut: [] as string[] };
  const copies: { l: LineRow; toIndex: number | null; fromIndex: number | null }[] = [];
  for (const l of src) {
    if (l.schedule_id) continue;
    const c = l.supplier_contract_id ? contracts.get(l.supplier_contract_id) : undefined;
    if (c && hasFixedEnd(c) && c.endsOn) {
      if (c.endsOn < nb.from) {
        result.leftOut.push(l.title);
        continue;
      }
      if (c.endsOn <= nb.last && (l.cadence === 'monthly' || l.cadence === 'quarterly')) {
        const endIndex = newMonths.indexOf(c.endsOn.slice(0, 7));
        const from = l.from_index === null ? 0 : Number(l.from_index);
        const to = Math.min(l.to_index === null ? 11 : Number(l.to_index), endIndex);
        if (to < from) {
          result.leftOut.push(l.title);
          continue;
        }
        copies.push({ l, fromIndex: from, toIndex: to });
        result.shortened.push(l.title);
        continue;
      }
    }
    copies.push({ l, fromIndex: l.from_index ?? null, toIndex: l.to_index ?? null });
    result.copied.push(l.title);
  }
  // the schedules whose lines are not copied: their proposals for the new year, when not planned there yet
  const schedules = schedulesOfService(serviceId).filter(
    (x) => src.some((l) => l.schedule_id === x.row.id) && !there.some((l) => l.schedule_id === x.row.id) && x.parts(toYear, start).length,
  );
  const adding = copies.length + schedules.reduce((n, x) => n + x.parts(toYear, start).length, 0);
  if (there.length + adding > COST_PLAN_LIMITS.linesPerYear)
    throw new HttpError(409, `A service has at most ${COST_PLAN_LIMITS.linesPerYear} plan lines per fiscal year`, 'COST_PLAN_LIMIT', {
      max: COST_PLAN_LIMITS.linesPerYear,
    });
  if (!adding) throw new HttpError(400, `${fiscalYearLabel(fromYear, start)} has no plan lines to copy`, 'COST_PLAN_NOTHING_TO_COPY');
  const now = nowIso();
  db().tx(() => {
    for (const { l, fromIndex, toIndex } of copies) {
      const renewal = l.renewal_date && l.renewal_date < nb.from ? nextYearDate(l.renewal_date) : l.renewal_date;
      const whole = (fromIndex === null || fromIndex === 0) && (toIndex === null || toIndex === 11);
      db().run(
        `INSERT INTO cost_plan_lines (id, service_id, fiscal_year, title, category, target_kind, target_id, vendor, supplier_id, supplier_contract_id, amount, currency,
           cadence, once_index, from_index, to_index, renewal_date, note, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId('cpl_'),
        serviceId,
        toYear,
        l.title,
        l.category,
        l.target_kind,
        l.target_id,
        l.vendor,
        l.supplier_id ?? null,
        l.supplier_contract_id ?? null,
        Number(l.amount),
        l.currency,
        l.cadence,
        l.once_index,
        whole ? null : (fromIndex ?? 0),
        whole ? null : (toIndex ?? 11),
        renewal,
        l.note,
        now,
        currentActor(),
        now,
        currentActor(),
      );
    }
    for (const x of schedules) {
      for (const p of x.parts(toYear, start)) insertScheduleLine(serviceId, toYear, x, p);
      result.proposed.push(scheduleLineTitle(x));
    }
    audit({
      action: 'cost.plan_copied',
      entityType: 'service',
      entityId: serviceId,
      summary: `Cost plan of "${info.name}" copied from ${fiscalYearLabel(fromYear, start)} to ${fiscalYearLabel(toYear, start)}: ${result.copied.length + result.shortened.length} line(s) copied${result.shortened.length ? ` (${result.shortened.length} up to their contract's end)` : ''}${result.proposed.length ? `, ${result.proposed.length} payment schedule(s) proposed` : ''}${result.leftOut.length ? `, ${result.leftOut.length} left out (contract ended)` : ''}`,
      details: { fromYear, toYear, lines: copies.length, ...result },
    });
  });
  return { ...planYearOf(info, toYear, Date.now(), start), copyResult: result };
}

/** The same day a year later (29 February: 28 February). */
export function nextYearDate(date: string): string {
  const y = Number(date.slice(0, 4)) + 1;
  const md = date.slice(5);
  if (md === '02-29') return `${y}-02-28`;
  return `${y}-${md}`;
}

// ---------- entries ----------

function entryRow(serviceId: string, entryId: string): EntryRow {
  const r = db().get<EntryRow>('SELECT * FROM cost_entries WHERE id = ? AND service_id = ?', entryId, serviceId);
  if (!r) throw new HttpError(404, `Cost entry ${entryId} not found`, 'COST_ENTRY_NOT_FOUND');
  return r;
}

export interface EntryValues {
  date: string;
  amount: number;
  currency: string;
  planLineId: string | null;
  target: { kind: CostPlanTargetKind; id: string } | null;
  supplierId: string | null;
  supplierContractId: string | null;
  reference: string;
  note: string;
}

/**
 * `before`: the entry being changed – it counts towards the limit of its fiscal year already (moved into another
 * year by its date, it counts there); its target may stay as it is, and so may its plan line: a line of another fiscal
 * year than the entry's (the fiscal year start changed since it was linked) stays linked while it is kept.
 */
function checkEntry(serviceId: string, body: unknown, before?: EntryRow): EntryValues {
  const x = costEntryInput.parse(body);
  const fy = fiscalYearOf(x.date, startMonth());
  let l: LineRow | undefined;
  if (x.planLineId) {
    const kept = !!before && before.plan_line_id === x.planLineId;
    l = db().get<LineRow>('SELECT * FROM cost_plan_lines WHERE id = ? AND service_id = ?', x.planLineId, serviceId);
    if (!l || (!kept && Number(l.fiscal_year) !== fy) || l.currency !== x.currency)
      throw new HttpError(400, `Not a plan line of this service in ${fiscalYearLabel(fy, startMonth())} and ${x.currency}`, 'COST_ENTRY_PLAN_LINE', {
        year: fiscalYearLabel(fy, startMonth()),
        currency: x.currency,
      });
  }
  const same = x.target && before && x.target.kind === before.target_kind && x.target.id === before.target_id;
  if (!same) checkTarget(x.target, catalogueOf(serviceId));
  const bounds = fiscalYearBounds(fy, startMonth());
  const n = Number(
    db().get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM cost_entries WHERE service_id = ? AND entry_date >= ? AND entry_date < ?',
      serviceId,
      bounds.from,
      bounds.to,
    )?.n ?? 0,
  );
  // a new entry, or one moved into this fiscal year by its date (one that stays counts already)
  const joins = !before || fiscalYearOf(before.entry_date, startMonth()) !== fy;
  if (joins && n >= COST_PLAN_LIMITS.entriesPerYear)
    throw new HttpError(409, `A service has at most ${COST_PLAN_LIMITS.entriesPerYear} cost entries per fiscal year`, 'COST_ENTRY_LIMIT', {
      max: COST_PLAN_LIMITS.entriesPerYear,
    });
  // the supplier and contract (0.18.0): missing keeps them – on a new entry with a plan line, the line's
  const current = before ? before.supplier_id : (l?.supplier_id ?? null);
  const supplierId = resolveSupplierLink(x.supplierId, current ?? null);
  const currentContract = before ? before.supplier_contract_id : (l?.supplier_contract_id ?? null);
  const supplierContractId = resolveSupplierContract(supplierId, x.supplierContractId, supplierId === current ? (currentContract ?? null) : null);
  return {
    date: x.date,
    amount: toMicros(x.amount)!,
    currency: x.currency,
    planLineId: x.planLineId,
    target: x.target,
    supplierId,
    supplierContractId,
    reference: x.reference,
    note: x.note,
  };
}

const entrySnapshot = (e: {
  date: string;
  amount: number;
  currency: string;
  planLineId: string | null;
  target: unknown;
  supplierId: string | null;
  supplierContractId: string | null;
  reference: string;
}) => ({
  date: e.date,
  amount: fromMicros(e.amount),
  currency: e.currency,
  planLineId: e.planLineId,
  target: e.target,
  supplierId: e.supplierId,
  supplierContractId: e.supplierContractId,
  reference: e.reference,
});
const entryOfRow = (r: EntryRow) => ({
  date: r.entry_date,
  amount: Number(r.amount),
  currency: r.currency,
  planLineId: r.plan_line_id,
  target: r.target_kind ? { kind: r.target_kind, id: r.target_id } : null,
  supplierId: r.supplier_id ?? null,
  supplierContractId: r.supplier_contract_id ?? null,
  reference: r.reference,
});

/** Inserts an entry (no audit, no checks): the entry routes, Book and the CSV import. */
export function insertEntry(serviceId: string, x: EntryValues, importId: string | null = null): string {
  const id = newId('cen_');
  const now = nowIso();
  db().run(
    `INSERT INTO cost_entries (id, service_id, entry_date, amount, currency, plan_line_id, target_kind, target_id, supplier_id, supplier_contract_id, import_id,
       reference, note, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    serviceId,
    x.date,
    x.amount,
    x.currency,
    x.planLineId,
    x.target?.kind ?? null,
    x.target?.id ?? null,
    x.supplierId,
    x.supplierContractId,
    importId,
    x.reference,
    x.note,
    now,
    currentActor(),
    now,
    currentActor(),
  );
  return id;
}

export function addEntry(serviceId: string, body: unknown): CostPlanYear {
  const info = requireEdit(serviceId);
  const x = checkEntry(serviceId, body);
  db().tx(() => {
    const id = insertEntry(serviceId, x);
    audit({
      action: 'cost.entry_added',
      entityType: 'service',
      entityId: serviceId,
      summary: `Cost entry of ${fmt(x.amount, x.currency)} on ${x.date} added to "${info.name}"${x.planLineId ? '' : ' (unplanned)'}${x.reference ? `, reference ${x.reference}` : ''}`,
      details: { entryId: id, after: entrySnapshot(x) },
    });
  });
  return planYearOf(info, fiscalYearOf(x.date, startMonth()), Date.now(), startMonth());
}

export function updateEntry(serviceId: string, entryId: string, body: unknown): CostPlanYear {
  const info = requireEdit(serviceId);
  const before = entryRow(serviceId, entryId);
  const x = checkEntry(serviceId, body, before);
  db().tx(() => {
    db().run(
      `UPDATE cost_entries SET entry_date = ?, amount = ?, currency = ?, plan_line_id = ?, target_kind = ?, target_id = ?, supplier_id = ?, supplier_contract_id = ?,
         reference = ?, note = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      x.date,
      x.amount,
      x.currency,
      x.planLineId,
      x.target?.kind ?? null,
      x.target?.id ?? null,
      x.supplierId,
      x.supplierContractId,
      x.reference,
      x.note,
      nowIso(),
      currentActor(),
      entryId,
    );
    audit({
      action: 'cost.entry_changed',
      entityType: 'service',
      entityId: serviceId,
      summary: `Cost entry of "${info.name}" changed: ${fmt(x.amount, x.currency)} on ${x.date} (was ${fmt(Number(before.amount), before.currency)} on ${before.entry_date})`,
      details: { entryId, before: entrySnapshot(entryOfRow(before)), after: entrySnapshot(x) },
    });
  });
  return planYearOf(info, fiscalYearOf(x.date, startMonth()), Date.now(), startMonth());
}

export function removeEntry(serviceId: string, entryId: string): CostPlanYear {
  const info = requireEdit(serviceId);
  const before = entryRow(serviceId, entryId);
  db().tx(() => {
    db().run('DELETE FROM cost_entries WHERE id = ?', entryId);
    audit({
      action: 'cost.entry_removed',
      entityType: 'service',
      entityId: serviceId,
      summary: `Cost entry of ${fmt(Number(before.amount), before.currency)} on ${before.entry_date} removed from "${info.name}"`,
      details: { entryId, before: entrySnapshot(entryOfRow(before)) },
    });
  });
  return planYearOf(info, fiscalYearOf(before.entry_date, startMonth()), Date.now(), startMonth());
}

// ---------- Book (0.18.0, ADR 0030) ----------

/** The payment date of a schedule line in a month (Book's default date); null for other lines. */
function paymentDateOf(l: LineRow, month: string): string | null {
  if (!l.schedule_id) return null;
  const sch = schedulesOfService(l.service_id).find((x) => x.row.id === l.schedule_id);
  const fy = Number(l.fiscal_year);
  const start = startMonth();
  const part = sch?.parts(fy, start).find((x) => x.part === l.schedule_part);
  return part?.paymentDates[fiscalYearMonths(fy, start).indexOf(month)] ?? null;
}

/**
 * Book: one entry from a line's payment in a month – the planned amount, the line's currency, supplier, contract and
 * target; the date the schedule's payment date in that month, else today (the current month) or the month's last day.
 * Monthly, quarterly and one-off lines only (a yearly line's months are a spread, not payments); never a month after
 * the current one. A month with an entry on the line already is refused unless `again` (the dialog asks first). A
 * person's statement, as any entry: audited as `cost.entry_added` with `via: "book"`.
 */
export function bookLine(serviceId: string, lineId: string, body: unknown, now = Date.now()): CostPlanYear {
  const info = requireEdit(serviceId);
  const l = lineRow(serviceId, lineId);
  const x = costBookInput.parse(body ?? {});
  if (!isBookable(l.cadence))
    throw new HttpError(400, 'A yearly line is spread over its months – enter an entry instead of booking it', 'COST_BOOK_YEARLY', { title: l.title });
  const start = startMonth();
  const fy = Number(l.fiscal_year);
  const months = fiscalYearMonths(fy, start);
  const nowMonth = thisMonth(now);
  const cur = nowMonth < months[0]! ? -1 : nowMonth > months[11]! ? 12 : months.indexOf(nowMonth);
  const plan = lineMonths(l);
  const onLine = db().all<{ entry_date: string; amount: number }>('SELECT entry_date, amount FROM cost_entries WHERE plan_line_id = ?', lineId);
  const booked = months.map((m) => onLine.some((e) => e.entry_date.slice(0, 7) === m));
  const i = x.month
    ? monthIndexIn(x.month, fy)
    : defaultBookIndex(
        plan.map((v) => v !== 0),
        booked,
        cur,
      );
  if (i === null || plan[i] === 0)
    throw new HttpError(400, `"${l.title}" has no payment planned in ${x.month ?? 'a month up to now'}`, 'COST_BOOK_NO_PAYMENT', {
      title: l.title,
      month: x.month ?? '',
    });
  const month = months[i]!;
  if (i > cur) throw new HttpError(400, `${month} is still to come – book a payment once it is made`, 'COST_BOOK_FUTURE', { month });
  if (booked[i] && !x.again) {
    const sum = onLine.filter((e) => e.entry_date.slice(0, 7) === month).reduce((a, e) => a + Number(e.amount), 0);
    throw new HttpError(409, `Already booked for ${month}: ${moneyText(sum, l.currency)} – book again?`, 'COST_BOOK_AGAIN', {
      month,
      amount: moneyText(sum, l.currency),
    });
  }
  const date = x.date ?? paymentDateOf(l, month) ?? (month === nowMonth ? today(now) : lastDayOf(month));
  if (fiscalYearOf(date, start) !== fy || date > today(now))
    throw new HttpError(400, `The date ${date} is not in ${fiscalYearLabel(fy, start)} up to today`, 'COST_BOOK_DATE', {
      date,
      year: fiscalYearLabel(fy, start),
    });
  const amount = x.amount ? toMicros(x.amount)! : plan[i]!;
  if (!fitsCurrency(amount, l.currency)) throw new HttpError(400, `Too many decimals for ${l.currency}`, 'COST_BOOK_DECIMALS', { currency: l.currency });
  const bounds = fiscalYearBounds(fy, start);
  const n = Number(
    db().get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM cost_entries WHERE service_id = ? AND entry_date >= ? AND entry_date < ?',
      serviceId,
      bounds.from,
      bounds.to,
    )?.n ?? 0,
  );
  if (n >= COST_PLAN_LIMITS.entriesPerYear)
    throw new HttpError(409, `A service has at most ${COST_PLAN_LIMITS.entriesPerYear} cost entries per fiscal year`, 'COST_ENTRY_LIMIT', {
      max: COST_PLAN_LIMITS.entriesPerYear,
    });
  const v: EntryValues = {
    date,
    amount,
    currency: l.currency,
    planLineId: l.id,
    target: l.target_kind && l.target_id ? { kind: l.target_kind, id: l.target_id } : null,
    supplierId: l.supplier_id ?? null,
    supplierContractId: l.supplier_contract_id ?? null,
    reference: x.reference,
    note: x.note,
  };
  db().tx(() => {
    const id = insertEntry(serviceId, v);
    audit({
      action: 'cost.entry_added',
      entityType: 'service',
      entityId: serviceId,
      summary: `Payment of "${l.title}" for ${month} booked on "${info.name}": ${fmt(amount, l.currency)} on ${date}${booked[i] ? ' (booked again)' : ''}${x.reference ? `, reference ${x.reference}` : ''}`,
      details: { entryId: id, via: 'book', lineId: l.id, month, again: booked[i], after: entrySnapshot(v) },
    });
  });
  return planYearOf(info, fy, Date.now(), start);
}

// ---------- CSV ----------

/**
 * A cell with an amount (a decimal string Steward wrote), rounded to the minor units of its currency (0.18.0: no
 * decimals for JPY, three for KWD); stays a number – also a negative one, which is no formula.
 */
const num = (v: string | null, currency: string) => {
  const micros = v === null ? null : toMicros(v);
  return micros === null ? (v ?? '') : fromMicrosIn(micros, currency);
};

/** The CSV headers of the plan lines and of the entries – fixed, whatever a year holds. */
export const PLAN_CSV_HEADS = {
  plan: 'Fiscal year,Title,Category,For (kind),For,Vendor or contract,Amount,Currency,Cadence,Once in,Renewal,Planned (year),Planned to date,Incurred to date,Expected,Difference,Note,From month,To month,Covers from,Covers to,Payment schedule,Not booked',
  entries: 'Date,Amount,Currency,Plan line,Unplanned,For (kind),For,Reference,Note,Supplier,Contract,Import',
} as const;

/** The header and the rows (CSV lines) of the plan lines or the entries of a year – also for scheduled exports. */
export function planCsvRows(y: CostPlanYear, what: 'plan' | 'entries'): { head: string; rows: string[] } {
  const target = (t: CostPlanTarget | null) => (t ? (t.visible ? t.name : '') : '');
  const [head, ...rows]: string[] =
    what === 'plan'
      ? [
          PLAN_CSV_HEADS.plan,
          ...y.lines.map((l) =>
            [
              csvCell(y.label, 'needed'),
              csvCell(l.title, 'needed'),
              l.category,
              l.target?.kind ?? '',
              csvCell(target(l.target), 'needed'),
              // the linked supplier (and its contract), else the free text (0.17.0)
              csvCell(l.supplier ? [l.supplier.name, l.supplierContract?.title].filter(Boolean).join(' – ') : l.vendor, 'needed'),
              num(l.amount, l.currency),
              l.currency,
              l.cadence,
              l.onceMonth ?? '',
              l.renewalDate ?? '',
              num(l.planned, l.currency),
              num(l.plannedToDate, l.currency),
              num(l.incurredToDate, l.currency),
              num(l.expected, l.currency),
              num(l.difference, l.currency),
              csvCell(l.note, 'needed'),
              // 0.18.0 (ADR 0030): part of the year, prepaid, the payment schedule, the months not booked
              l.fromMonth ?? '',
              l.toMonth ?? '',
              l.coversFrom ?? '',
              l.coversTo ?? '',
              csvCell(l.schedule ? l.schedule.title : '', 'needed'),
              l.notBooked.join(' '),
            ].join(','),
          ),
        ]
      : [
          PLAN_CSV_HEADS.entries,
          ...y.entries.map((e) =>
            [
              e.date,
              num(e.amount, e.currency),
              e.currency,
              csvCell(e.planLineTitle ?? '', 'needed'),
              e.unplanned ? 'yes' : 'no',
              e.target?.kind ?? '',
              csvCell(target(e.target), 'needed'),
              csvCell(e.reference, 'needed'),
              csvCell(e.note, 'needed'),
              csvCell(e.supplier?.name ?? '', 'needed'),
              csvCell(e.supplierContract?.title ?? '', 'needed'),
              e.importId ?? '',
            ].join(','),
          ),
        ];
  return { head: head!, rows };
}

/** The plan lines or the entries of a fiscal year as CSV (UTF-8 with a byte order mark, comma separated). */
export function planCsv(serviceId: string, year: number | undefined, what: 'plan' | 'entries'): { name: string; csv: string } {
  const y = planYear(serviceId, year);
  const { head, rows } = planCsvRows(y, what);
  const fyText = y.label.replace(/[^0-9A-Za-z]+/g, '-');
  return { name: `cost-${what}-${fyText}.csv`, csv: '﻿' + [head, ...rows].join('\r\n') + '\r\n' };
}

// ---------- many services: the team rollup, the dataset, the export ----------

/** Lets other work run between two services: on PostgreSQL every statement holds the event loop (pg-bridge.ts). */
const breathe = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The services whose plans the team rollup, the dataset "Cost plans" and the scheduled export cover – one rule for
 * all three: not archived, with plan lines or cost entries in the fiscal year, by name. With `teamId`: of that team
 * (its owning teams, like catalogueTeams), with how many teams own each.
 */
export function planServices(fiscalYear: number, start: number, teamId?: string): { id: string; name: string; teams: number }[] {
  const b = fiscalYearBounds(fiscalYear, start);
  const has = `(EXISTS (SELECT 1 FROM cost_plan_lines l WHERE l.service_id = s.id AND l.fiscal_year = ?)
      OR EXISTS (SELECT 1 FROM cost_entries e WHERE e.service_id = s.id AND e.entry_date >= ? AND e.entry_date < ?))`;
  const teams = `(SELECT COUNT(*) FROM resource_teams r2 JOIN teams t2 ON t2.id = r2.team_id WHERE r2.kind = 'service' AND r2.resource_id = s.id)`;
  const rows = teamId
    ? db().all<{ id: string; name: string; teams: number }>(
        `SELECT s.id, s.name, ${teams} AS teams FROM services s JOIN resource_teams r ON r.kind = 'service' AND r.resource_id = s.id AND r.team_id = ?
          WHERE s.archived = 0 AND ${has} ORDER BY s.name, s.id`,
        teamId,
        fiscalYear,
        b.from,
        b.to,
      )
    : db().all<{ id: string; name: string; teams: number }>(
        `SELECT s.id, s.name, ${teams} AS teams FROM services s WHERE s.archived = 0 AND ${has} ORDER BY s.name, s.id`,
        fiscalYear,
        b.from,
        b.to,
      );
  return rows.map((r) => ({ id: r.id, name: r.name, teams: Number(r.teams) }));
}

/** The CSV headers of the scheduled export: the service first, so one file holds every service's lines or entries. */
export const PLAN_EXPORT_HEADS = {
  plan: `Service id,Service,${PLAN_CSV_HEADS.plan}`,
  entries: `Service id,Service,${PLAN_CSV_HEADS.entries}`,
} as const;

/**
 * The plan lines and entries of every service of a fiscal year (planServices), service by service as CSV lines under
 * PLAN_EXPORT_HEADS – the same columns whether there are services or not. Yields between services.
 */
export async function* planExportRows(fiscalYear: number, now = Date.now()): AsyncGenerator<{ serviceId: string; plan: string[]; entries: string[] }> {
  const start = startMonth();
  for (const s of planServices(fiscalYear, start)) {
    const info = scopeInfo('service', s.id);
    if (!info) continue;
    const y = planYearOf(info, fiscalYear, now, start);
    const svc = `${csvCell(y.serviceId, 'needed')},${csvCell(y.serviceName, 'needed')}`;
    yield {
      serviceId: s.id,
      plan: planCsvRows(y, 'plan').rows.map((r) => `${svc},${r}`),
      entries: planCsvRows(y, 'entries').rows.map((r) => `${svc},${r}`),
    };
    await breathe();
  }
}

/** The year views of every service of the current fiscal year (planServices) – for the dataset; yields between services. */
export async function* planYearsOfAll(now = Date.now()): AsyncGenerator<CostPlanYear> {
  const start = startMonth();
  const fy = fiscalYearOf(thisMonth(now), start);
  for (const s of planServices(fy, start)) {
    const info = scopeInfo('service', s.id);
    if (!info) continue;
    yield planYearOf(info, fy, now, start);
    await breathe();
  }
}

/** The plans of the team's services in a fiscal year, per currency; a service of two teams counts for both. */
export async function teamPlanYear(teamId: string, year?: number, now = Date.now()): Promise<CostPlanTeamYear> {
  const team = requireScope('team', teamId);
  const start = startMonth();
  const cur = fiscalYearOf(thisMonth(now), start);
  const fy = year ?? cur;
  const totals = new Map<string, Figures>();
  const services: CostPlanTeamYear['services'] = [];
  for (const s of planServices(fy, start, teamId)) {
    const info = scopeInfo('service', s.id);
    if (!info) continue;
    const y = planYearOf(info, fy, now, start);
    services.push({
      id: s.id,
      name: y.serviceName,
      amountsVisible: y.amountsVisible,
      cloud: y.cloud,
      shared: s.teams > 1,
      currencies: y.currencies.map((c) => ({
        currency: c.currency,
        planned: c.planned,
        plannedToDate: c.plannedToDate,
        incurredToDate: c.incurredToDate,
        expected: c.expected,
        difference: c.difference,
      })),
    });
    if (y.amountsVisible)
      for (const c of y.currencies) {
        const t = totals.get(c.currency) ?? { planned: 0, plannedToDate: 0, incurredToDate: 0, expected: 0 };
        t.planned += toMicros(c.planned) ?? 0;
        t.plannedToDate += toMicros(c.plannedToDate) ?? 0;
        t.incurredToDate += toMicros(c.incurredToDate) ?? 0;
        t.expected += toMicros(c.expected) ?? 0;
        totals.set(c.currency, t);
      }
    await breathe();
  }
  return {
    teamId,
    teamName: team.name,
    fiscalYear: fy,
    label: fiscalYearLabel(fy, start),
    services,
    totals: [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, f]) => ({ currency, ...figures(f, fromMicros) })),
    years: [...new Set([fy, cur, cur + 1, cur - 1])].sort((a, b) => b - a).map((fiscalYear) => ({ fiscalYear, label: fiscalYearLabel(fiscalYear, start) })),
  };
}
