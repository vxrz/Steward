import {
  COST_PLAN_LIMITS,
  costEntryInput,
  costPlanCopyInput,
  costPlanLineInput,
  costPlanLineUpdate,
  fiscalYearBounds,
  fiscalYearLabel,
  fiscalYearMonths,
  fiscalYearOf,
  fromMicros,
  planMonths,
  toMicros,
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
import { catalogueTeams } from '../auth/policy.js';
import { catalogueVisibleNow } from '../records/access.js';
import { csvCell } from '../csv.js';
import { HttpError, newId, nowIso } from '../util.js';
import { costSettings, requireScope, scopeInfo, seesWholeScope, type ScopeInfo } from './access.js';
import { forecastFromGroups, monthOf } from './query.js';

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
 * - A plan line of category cloud for an application or a platform takes the costs read for it (the platform: the
 *   service's applications' share). Each cost belongs to one line at most: the first line (oldest) for its
 *   application and currency, else the first for its platform and currency; the rest is "cloud and platform (read)".
 */

interface LineRow {
  id: string;
  service_id: string;
  fiscal_year: number;
  title: string;
  category: CostPlanCategory;
  target_kind: CostPlanTargetKind | null;
  target_id: string | null;
  vendor: string;
  amount: number;
  currency: string;
  cadence: CostPlanCadence;
  once_index: number | null;
  renewal_date: string | null;
  note: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

interface EntryRow {
  id: string;
  service_id: string;
  entry_date: string;
  amount: number;
  currency: string;
  plan_line_id: string | null;
  target_kind: CostPlanTargetKind | null;
  target_id: string | null;
  reference: string;
  note: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

const startMonth = () => costSettings().fiscalYearStartMonth;
const today = (now: number) => new Date(now).toISOString().slice(0, 10);

function serviceInfo(serviceId: string): ScopeInfo {
  return requireScope('service', serviceId);
}

function requireEdit(serviceId: string): ScopeInfo {
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

function catalogueOf(serviceId: string): Catalogue {
  const apps = serviceApps(serviceId);
  return { apps: new Set(apps), systems: new Set(serviceSystems(apps)) };
}

function targetOf(kind: CostPlanTargetKind | null, id: string | null, cat: Catalogue): CostPlanTarget | null {
  if (!kind || !id) return null;
  if (kind === 'platform') {
    const p = db().get<{ name: string }>('SELECT name FROM platforms WHERE id = ?', id);
    const visible = !!p && !!scopeInfo('platform', id);
    return { kind, id, name: visible ? p!.name : '', visible, ...(p ? {} : { gone: true }) };
  }
  const r = db().get<{ id: string; name: string; owners: string }>(
    `SELECT id, name, owners FROM ${kind === 'application' ? 'applications' : 'systems'} WHERE id = ?`,
    id,
  );
  const visible = !!r && catalogueVisibleNow(kind, r);
  const gone = !r || !(kind === 'application' ? cat.apps : cat.systems).has(id);
  return { kind, id, name: visible ? r!.name : '', visible, ...(gone ? { gone: true } : {}) };
}

/** An application or system of the service, or a platform – one the caller may see. */
function checkTarget(t: { kind: CostPlanTargetKind; id: string } | null, cat: Catalogue): void {
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

const lineRows = (serviceId: string, fiscalYear: number) =>
  db().all<LineRow>('SELECT * FROM cost_plan_lines WHERE service_id = ? AND fiscal_year = ? ORDER BY created_at, id', serviceId, fiscalYear);

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
  const info = serviceInfo(serviceId);
  const start = startMonth();
  const nowMonth = monthOf(now);
  const day = today(now);
  const fy = year ?? fiscalYearOf(nowMonth, start);
  const months = fiscalYearMonths(fy, start);
  const cur = nowMonth < months[0]! ? -1 : nowMonth > months[11]! ? 12 : months.indexOf(nowMonth);
  const bounds = fiscalYearBounds(fy, start);
  const cat = catalogueOf(serviceId);
  const lines = lineRows(serviceId, fy);
  const entries = entryRows(serviceId, bounds.from, bounds.to);
  const show = (n: number) => (info.amounts ? fromMicros(n) : null);
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
      readOf.set(owner, [...(readOf.get(owner) ?? []), b]);
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
  for (const e of entries) if (e.plan_line_id && lineIds.has(e.plan_line_id)) byLine.set(e.plan_line_id, [...(byLine.get(e.plan_line_id) ?? []), e]);
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
    const plan = planMonths(Number(l.amount), l.cadence, l.once_index);
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
    if (read === 'matched' || l.cadence === 'monthly') {
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
    return {
      id: l.id,
      serviceId: l.service_id,
      fiscalYear: Number(l.fiscal_year),
      title: l.title,
      category: l.category,
      target: targetOf(l.target_kind, l.target_id, cat),
      vendor: l.vendor,
      amount: show(Number(l.amount)),
      currency: l.currency,
      cadence: l.cadence,
      onceMonth: l.cadence === 'once' && l.once_index !== null ? (months[Number(l.once_index)] ?? null) : null,
      renewalDate: l.renewal_date,
      note: l.note,
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
  const outEntries: CostEntry[] = entries.map((e) => {
    const line = e.plan_line_id ? lineTarget.get(e.plan_line_id) : undefined;
    return {
      id: e.id,
      serviceId: e.service_id,
      date: e.entry_date,
      amount: show(Number(e.amount)),
      currency: e.currency,
      planLineId: e.plan_line_id,
      planLineTitle: e.plan_line_id ? (titleOf.get(e.plan_line_id) ?? null) : null,
      target: e.target_kind ? targetOf(e.target_kind, e.target_id, cat) : line ? targetOf(line.target_kind, line.target_id, cat) : null,
      reference: e.reference,
      note: e.note,
      unplanned: !line,
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
    targets: targetsOf(cat),
    years: yearsOf(serviceId, fy, fiscalYearOf(nowMonth, start), start),
    limits: { linesPerYear: COST_PLAN_LIMITS.linesPerYear, entriesPerYear: COST_PLAN_LIMITS.entriesPerYear },
  };
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
  const to = today(now + COST_PLAN_LIMITS.renewalDays * 86_400_000);
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

function targetsOf(cat: Catalogue): CostPlanYear['targets'] {
  const of = (kind: 'application' | 'system', ids: Set<string>) =>
    ids.size
      ? db()
          .all<{ id: string; name: string; owners: string }>(
            `SELECT id, name, owners FROM ${kind === 'application' ? 'applications' : 'systems'} WHERE id IN (${[...ids].map(() => '?').join(', ')}) ORDER BY name`,
            ...ids,
          )
          .filter((r) => catalogueVisibleNow(kind, r))
          .map((r) => ({ kind, id: r.id, name: r.name }))
      : [];
  return [...of('application', cat.apps), ...of('system', cat.systems)];
}

function yearsOf(serviceId: string, shown: number, current: number, start: number): CostPlanYear['years'] {
  const ys = new Set<number>([shown, current, current + 1]);
  for (const r of db().all<{ fy: number }>('SELECT DISTINCT fiscal_year AS fy FROM cost_plan_lines WHERE service_id = ?', serviceId)) ys.add(Number(r.fy));
  for (const r of db().all<{ m: string }>('SELECT DISTINCT substr(entry_date, 1, 7) AS m FROM cost_entries WHERE service_id = ?', serviceId))
    ys.add(fiscalYearOf(r.m, start));
  return [...ys].sort((a, b) => b - a).map((fiscalYear) => ({ fiscalYear, label: fiscalYearLabel(fiscalYear, start) }));
}

// ---------- plan lines ----------

const fmt = (micros: number, currency: string) => `${fromMicros(micros)} ${currency}`;

function lineRow(serviceId: string, lineId: string): LineRow {
  const r = db().get<LineRow>('SELECT * FROM cost_plan_lines WHERE id = ? AND service_id = ?', lineId, serviceId);
  if (!r) throw new HttpError(404, `Plan line ${lineId} not found`, 'COST_PLAN_LINE_NOT_FOUND');
  return r;
}

/** The position (0–11) of a one-off payment's month in the fiscal year; 400 outside it. */
function onceIndexOf(cadence: CostPlanCadence, onceMonth: string | null, fiscalYear: number): number | null {
  if (cadence !== 'once' || !onceMonth) return null;
  const i = fiscalYearMonths(fiscalYear, startMonth()).indexOf(onceMonth);
  if (i < 0)
    throw new HttpError(400, `The month ${onceMonth} is not in ${fiscalYearLabel(fiscalYear, startMonth())}`, 'COST_PLAN_MONTH', {
      month: onceMonth,
      year: fiscalYearLabel(fiscalYear, startMonth()),
    });
  return i;
}

const lineSnapshot = (
  r: Pick<LineRow, 'title' | 'category' | 'target_kind' | 'target_id' | 'vendor' | 'amount' | 'currency' | 'cadence' | 'once_index' | 'renewal_date'>,
) => ({
  title: r.title,
  category: r.category,
  target: r.target_kind ? { kind: r.target_kind, id: r.target_id } : null,
  vendor: r.vendor,
  amount: fromMicros(Number(r.amount)),
  currency: r.currency,
  cadence: r.cadence,
  onceIndex: r.once_index === null ? null : Number(r.once_index),
  renewalDate: r.renewal_date,
});

export function addPlanLine(serviceId: string, body: unknown): CostPlanYear {
  const info = requireEdit(serviceId);
  const x = costPlanLineInput.parse(body);
  checkTarget(x.target, catalogueOf(serviceId));
  const onceIndex = onceIndexOf(x.cadence, x.onceMonth, x.fiscalYear);
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
  const row = {
    title: x.title,
    category: x.category,
    target_kind: x.target?.kind ?? null,
    target_id: x.target?.id ?? null,
    vendor: x.vendor,
    amount,
    currency: x.currency,
    cadence: x.cadence,
    once_index: onceIndex,
    renewal_date: x.renewalDate,
  };
  db().tx(() => {
    db().run(
      `INSERT INTO cost_plan_lines (id, service_id, fiscal_year, title, category, target_kind, target_id, vendor, amount, currency, cadence, once_index, renewal_date, note,
         created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      serviceId,
      x.fiscalYear,
      x.title,
      x.category,
      row.target_kind,
      row.target_id,
      x.vendor,
      amount,
      x.currency,
      x.cadence,
      onceIndex,
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
  return planYear(serviceId, x.fiscalYear);
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
  if (x.currency !== before.currency) {
    const other = db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_entries WHERE plan_line_id = ? AND currency <> ?', lineId, x.currency);
    if (Number(other?.n ?? 0) > 0)
      throw new HttpError(409, 'The line has entries in another currency – move or change them first', 'COST_PLAN_CURRENCY', { currency: before.currency });
  }
  const amount = toMicros(x.amount)!;
  const row = {
    title: x.title,
    category: x.category,
    target_kind: x.target?.kind ?? null,
    target_id: x.target?.id ?? null,
    vendor: x.vendor,
    amount,
    currency: x.currency,
    cadence: x.cadence,
    once_index: onceIndex,
    renewal_date: x.renewalDate,
  };
  db().tx(() => {
    db().run(
      `UPDATE cost_plan_lines SET title = ?, category = ?, target_kind = ?, target_id = ?, vendor = ?, amount = ?, currency = ?, cadence = ?, once_index = ?,
         renewal_date = ?, note = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      x.title,
      x.category,
      row.target_kind,
      row.target_id,
      x.vendor,
      amount,
      x.currency,
      x.cadence,
      onceIndex,
      x.renewalDate,
      x.note,
      nowIso(),
      currentActor(),
      lineId,
    );
    audit({
      action: 'cost.plan_line_changed',
      entityType: 'service',
      entityId: serviceId,
      summary: `Plan line "${x.title}" of "${info.name}" (${fiscalYearLabel(fy, startMonth())}) changed: ${fmt(amount, x.currency)} ${x.cadence} (was ${fmt(Number(before.amount), before.currency)} ${before.cadence})`,
      details: { lineId, fiscalYear: fy, before: lineSnapshot(before), after: lineSnapshot(row) },
    });
  });
  return planYear(serviceId, fy);
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
  return planYear(serviceId, fy);
}

/**
 * Copies the plan lines of a fiscal year into the next one (refused when the next one has lines already). A renewal
 * date before the new year moves on by a year; one-off payments keep their position in the year.
 */
export function copyPlanYear(serviceId: string, body: unknown): CostPlanYear {
  const info = requireEdit(serviceId);
  const { fromYear } = costPlanCopyInput.parse(body);
  const toYear = fromYear + 1;
  const src = lineRows(serviceId, fromYear);
  if (!src.length) throw new HttpError(400, `${fiscalYearLabel(fromYear, startMonth())} has no plan lines to copy`, 'COST_PLAN_NOTHING_TO_COPY');
  if (db().get('SELECT id FROM cost_plan_lines WHERE service_id = ? AND fiscal_year = ? LIMIT 1', serviceId, toYear))
    throw new HttpError(409, `${fiscalYearLabel(toYear, startMonth())} has plan lines already`, 'COST_PLAN_YEAR_NOT_EMPTY', {
      year: fiscalYearLabel(toYear, startMonth()),
    });
  const newStart = fiscalYearBounds(toYear, startMonth()).from;
  const now = nowIso();
  db().tx(() => {
    for (const l of src) {
      const renewal = l.renewal_date && l.renewal_date < newStart ? nextYearDate(l.renewal_date) : l.renewal_date;
      db().run(
        `INSERT INTO cost_plan_lines (id, service_id, fiscal_year, title, category, target_kind, target_id, vendor, amount, currency, cadence, once_index, renewal_date, note,
           created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId('cpl_'),
        serviceId,
        toYear,
        l.title,
        l.category,
        l.target_kind,
        l.target_id,
        l.vendor,
        Number(l.amount),
        l.currency,
        l.cadence,
        l.once_index,
        renewal,
        l.note,
        now,
        currentActor(),
        now,
        currentActor(),
      );
    }
    audit({
      action: 'cost.plan_copied',
      entityType: 'service',
      entityId: serviceId,
      summary: `Cost plan of "${info.name}" copied from ${fiscalYearLabel(fromYear, startMonth())} to ${fiscalYearLabel(toYear, startMonth())}: ${src.length} line(s)`,
      details: { fromYear, toYear, lines: src.length },
    });
  });
  return planYear(serviceId, toYear);
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

interface EntryValues {
  date: string;
  amount: number;
  currency: string;
  planLineId: string | null;
  target: { kind: CostPlanTargetKind; id: string } | null;
  reference: string;
  note: string;
}

/** `before`: the entry being changed (its target may stay as it is; it counts towards the limit already). */
function checkEntry(serviceId: string, body: unknown, before?: EntryRow): EntryValues {
  const x = costEntryInput.parse(body);
  const fy = fiscalYearOf(x.date, startMonth());
  if (x.planLineId) {
    const l = db().get<LineRow>('SELECT * FROM cost_plan_lines WHERE id = ? AND service_id = ?', x.planLineId, serviceId);
    if (!l || Number(l.fiscal_year) !== fy || l.currency !== x.currency)
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
  if (!before && n >= COST_PLAN_LIMITS.entriesPerYear)
    throw new HttpError(409, `A service has at most ${COST_PLAN_LIMITS.entriesPerYear} cost entries per fiscal year`, 'COST_ENTRY_LIMIT', {
      max: COST_PLAN_LIMITS.entriesPerYear,
    });
  return { date: x.date, amount: toMicros(x.amount)!, currency: x.currency, planLineId: x.planLineId, target: x.target, reference: x.reference, note: x.note };
}

const entrySnapshot = (e: { date: string; amount: number; currency: string; planLineId: string | null; target: unknown; reference: string }) => ({
  date: e.date,
  amount: fromMicros(e.amount),
  currency: e.currency,
  planLineId: e.planLineId,
  target: e.target,
  reference: e.reference,
});
const entryOfRow = (r: EntryRow) => ({
  date: r.entry_date,
  amount: Number(r.amount),
  currency: r.currency,
  planLineId: r.plan_line_id,
  target: r.target_kind ? { kind: r.target_kind, id: r.target_id } : null,
  reference: r.reference,
});

export function addEntry(serviceId: string, body: unknown): CostPlanYear {
  const info = requireEdit(serviceId);
  const x = checkEntry(serviceId, body);
  const id = newId('cen_');
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO cost_entries (id, service_id, entry_date, amount, currency, plan_line_id, target_kind, target_id, reference, note, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      serviceId,
      x.date,
      x.amount,
      x.currency,
      x.planLineId,
      x.target?.kind ?? null,
      x.target?.id ?? null,
      x.reference,
      x.note,
      now,
      currentActor(),
      now,
      currentActor(),
    );
    audit({
      action: 'cost.entry_added',
      entityType: 'service',
      entityId: serviceId,
      summary: `Cost entry of ${fmt(x.amount, x.currency)} on ${x.date} added to "${info.name}"${x.planLineId ? '' : ' (unplanned)'}${x.reference ? `, reference ${x.reference}` : ''}`,
      details: { entryId: id, after: entrySnapshot(x) },
    });
  });
  return planYear(serviceId, fiscalYearOf(x.date, startMonth()));
}

export function updateEntry(serviceId: string, entryId: string, body: unknown): CostPlanYear {
  const info = requireEdit(serviceId);
  const before = entryRow(serviceId, entryId);
  const x = checkEntry(serviceId, body, before);
  db().tx(() => {
    db().run(
      `UPDATE cost_entries SET entry_date = ?, amount = ?, currency = ?, plan_line_id = ?, target_kind = ?, target_id = ?, reference = ?, note = ?,
         updated_at = ?, updated_by = ? WHERE id = ?`,
      x.date,
      x.amount,
      x.currency,
      x.planLineId,
      x.target?.kind ?? null,
      x.target?.id ?? null,
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
  return planYear(serviceId, fiscalYearOf(x.date, startMonth()));
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
  return planYear(serviceId, fiscalYearOf(before.entry_date, startMonth()));
}

// ---------- CSV ----------

/** A cell; amounts (decimal strings Steward wrote) stay numbers – also negative ones, which are no formula. */
const num = (v: string | null) => v ?? '';

/** The header and the rows (CSV lines) of the plan lines or the entries of a year – also for scheduled exports. */
export function planCsvRows(y: CostPlanYear, what: 'plan' | 'entries'): { head: string; rows: string[] } {
  const target = (t: CostPlanTarget | null) => (t ? (t.visible ? t.name : '') : '');
  const [head, ...rows]: string[] =
    what === 'plan'
      ? [
          'Fiscal year,Title,Category,For (kind),For,Vendor or contract,Amount,Currency,Cadence,Once in,Renewal,Planned (year),Planned to date,Incurred to date,Expected,Difference,Note',
          ...y.lines.map((l) =>
            [
              csvCell(y.label, 'needed'),
              csvCell(l.title, 'needed'),
              l.category,
              l.target?.kind ?? '',
              csvCell(target(l.target), 'needed'),
              csvCell(l.vendor, 'needed'),
              num(l.amount),
              l.currency,
              l.cadence,
              l.onceMonth ?? '',
              l.renewalDate ?? '',
              num(l.planned),
              num(l.plannedToDate),
              num(l.incurredToDate),
              num(l.expected),
              num(l.difference),
              csvCell(l.note, 'needed'),
            ].join(','),
          ),
        ]
      : [
          'Date,Amount,Currency,Plan line,Unplanned,For (kind),For,Reference,Note',
          ...y.entries.map((e) =>
            [
              e.date,
              num(e.amount),
              e.currency,
              csvCell(e.planLineTitle ?? '', 'needed'),
              e.unplanned ? 'yes' : 'no',
              e.target?.kind ?? '',
              csvCell(target(e.target), 'needed'),
              csvCell(e.reference, 'needed'),
              csvCell(e.note, 'needed'),
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

// ---------- the team rollup ----------

/** The plans of the team's services in a fiscal year, per currency; a service of two teams counts for both. */
export function teamPlanYear(teamId: string, year?: number, now = Date.now()): CostPlanTeamYear {
  const team = requireScope('team', teamId);
  const start = startMonth();
  const fy = year ?? fiscalYearOf(monthOf(now), start);
  const totals = new Map<string, Figures>();
  const services: CostPlanTeamYear['services'] = [];
  for (const s of db().all<{ id: string }>('SELECT id FROM services WHERE archived = 0 ORDER BY name')) {
    const teams = catalogueTeams('service', s.id);
    if (!teams.some((t) => t.id === teamId)) continue;
    if (!scopeInfo('service', s.id)) continue;
    const y = planYear(s.id, fy, now);
    if (!y.lines.length && !y.entries.length && y.cloud === 'none') continue;
    services.push({
      id: s.id,
      name: y.serviceName,
      amountsVisible: y.amountsVisible,
      cloud: y.cloud,
      shared: teams.length > 1,
      currencies: y.currencies.map((c) => ({
        currency: c.currency,
        planned: c.planned,
        plannedToDate: c.plannedToDate,
        incurredToDate: c.incurredToDate,
        expected: c.expected,
        difference: c.difference,
      })),
    });
    if (!y.amountsVisible) continue;
    for (const c of y.currencies) {
      const t = totals.get(c.currency) ?? { planned: 0, plannedToDate: 0, incurredToDate: 0, expected: 0 };
      t.planned += toMicros(c.planned) ?? 0;
      t.plannedToDate += toMicros(c.plannedToDate) ?? 0;
      t.incurredToDate += toMicros(c.incurredToDate) ?? 0;
      t.expected += toMicros(c.expected) ?? 0;
      totals.set(c.currency, t);
    }
  }
  const cur = fiscalYearOf(monthOf(now), start);
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
