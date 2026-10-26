import {
  CIA_DIMENSIONS,
  SCORECARD_PARTS,
  SCORECARD_PART_STATUSES,
  levelRank,
  type DutyLevel,
  type DutyPeriodStatus,
  type ScorecardAvailability,
  type ScorecardDocumentRef,
  type ScorecardDocumentation,
  type ScorecardDutyCounts,
  type ScorecardDutyItem,
  type ScorecardDuties,
  type ScorecardExpectedDocument,
  type ScorecardOverview,
  type ScorecardPart,
  type ScorecardPartCounts,
  type ScorecardPartStatus,
  type ScorecardProtection,
  type ScorecardRollupGroup,
  type ScorecardTrendPoint,
  type ServiceCriticality,
  type ServiceScorecard,
  type ServiceScorecardDetail,
  type ServiceScorecardHistoryPoint,
} from '@sm/shared';
import { db } from '../db.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { matches } from '../auth/permissions.js';
import { HttpError, parseJson } from '../util.js';
import { canReadRecordRow, me } from '../records/access.js';
import { documentStates } from '../records/document-model.js';
import { documentRows } from '../catalogue/documents.js';
import { currentScale, protectionNeeds, ratingsOf } from '../catalogue/cia.js';
import { instanceTimeZone, localDate, periodAt } from '../duties/periods.js';
import type { DutyRow } from '../duties/evaluate.js';
import { judge, readingCache, type ObjectiveRow } from './objectives.js';
import { ruleRows, ruleValid } from './rules.js';

/**
 * The service scorecard (#86): per service four parts, each with its own status – no weighting.
 *
 *   - Duties (#85): from the stored duty periods (the duty job keeps them): a mandatory duty is met when its last
 *     closed period was done, late or skipped and its current period is done, late or skipped; "open" while the
 *     current period is still due; not met when the last closed period was missed or failed. Recommended duties are
 *     counted separately and never set "attention"; optional ones are only shown.
 *   - Availability: the service's availability objectives – attention when one is below target, pending when one has
 *     no data.
 *   - Documentation: the living documents linked to the service or applying to its applications – attention when none
 *     is released, a review is overdue, or a document expected by a rule on the CIA rating is missing.
 *   - Protection need (#84): attention when it is not rated – no applications, a dimension without a level,
 *     applications not rated or not counted (re-rating after a scale change), or the stored scale is not valid.
 *
 * "Attention needed": any part needs attention. Everything is computed for a reader: documents they may not read
 * neither count nor show (nothing else on the scorecard is restricted – services, duties and objective statuses are
 * readable by everyone who can sign in). The daily snapshots (jobs.ts) are computed for no particular reader and
 * remember which documents counted; a reader who may not read one of them sees that day's documentation as hidden.
 */

const OK_DUTY: DutyPeriodStatus[] = ['done', 'late', 'skipped'];
const BAD_DUTY: DutyPeriodStatus[] = ['missed', 'failed'];

interface ServiceRow {
  id: string;
  name: string;
  owners: string;
  criticality: string | null;
  archived: number;
}

interface PeriodRef {
  duty_id: string;
  period_key: string;
  status: DutyPeriodStatus;
  period_end: string;
}

/** Everything the scorecards of a set of services need, read in bulk. */
interface Data {
  tz: string;
  now: number;
  services: ServiceRow[];
  duties: Map<string, DutyRow[]>;
  lastClosed: Map<string, PeriodRef>;
  open: Map<string, PeriodRef>;
  objectives: Map<string, ObjectiveRow[]>;
  appNames: Map<string, string>;
  members: Map<string, string[]>;
  /** record ids per service: linked (either way) and applying to its applications */
  linked: Map<string, Set<string>>;
  scoped: Map<string, string[]>;
}

function load(serviceIds: string[] | undefined, now: number): Data {
  const services = db()
    .all<ServiceRow>('SELECT id, name, owners, criticality, archived FROM services WHERE archived = 0 ORDER BY name, id')
    .filter((s) => !serviceIds || serviceIds.includes(s.id));
  const ids = new Set(services.map((s) => s.id));
  const group = <T>(rows: T[], key: (r: T) => string) => {
    const m = new Map<string, T[]>();
    for (const r of rows) if (ids.has(key(r))) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
    return m;
  };
  const duties = group(db().all<DutyRow>('SELECT * FROM service_duties WHERE archived = 0 ORDER BY name, id'), (d) => d.service_id);
  const lastClosed = new Map<string, PeriodRef>();
  for (const r of db().all<PeriodRef>(
    `SELECT p.duty_id, p.period_key, p.status, p.period_end FROM duty_periods p
     JOIN (SELECT duty_id, MAX(period_end) AS e FROM duty_periods WHERE closed_at IS NOT NULL GROUP BY duty_id) m ON m.duty_id = p.duty_id AND m.e = p.period_end
     WHERE p.closed_at IS NOT NULL`,
  ))
    lastClosed.set(r.duty_id, r);
  const open = new Map<string, PeriodRef>();
  for (const r of db().all<PeriodRef>('SELECT duty_id, period_key, status, period_end FROM duty_periods WHERE closed_at IS NULL'))
    open.set(`${r.duty_id}\n${r.period_key}`, r);
  const members = new Map<string, string[]>();
  for (const m of db().all<{ service_id: string; application_id: string }>(
    'SELECT sa.service_id, sa.application_id FROM service_applications sa JOIN applications a ON a.id = sa.application_id WHERE a.archived = 0',
  ))
    if (ids.has(m.service_id)) members.set(m.service_id, [...(members.get(m.service_id) ?? []), m.application_id]);
  const linked = new Map<string, Set<string>>();
  for (const l of db().all<{ item: string; record: string }>(
    `SELECT to_id AS item, from_id AS record FROM item_links WHERE from_kind = 'record' AND to_kind = 'service'
     UNION SELECT from_id AS item, to_id AS record FROM item_links WHERE from_kind = 'service' AND to_kind = 'record'`,
  ))
    if (ids.has(l.item)) linked.set(l.item, (linked.get(l.item) ?? new Set()).add(l.record));
  const scoped = new Map<string, string[]>();
  for (const r of db().all<{ record_id: string; application_id: string }>('SELECT record_id, application_id FROM record_applications'))
    scoped.set(r.record_id, [...(scoped.get(r.record_id) ?? []), r.application_id]);
  return {
    tz: instanceTimeZone(),
    now,
    services,
    duties,
    lastClosed,
    open,
    objectives: group(db().all<ObjectiveRow>('SELECT * FROM availability_objectives ORDER BY name, id'), (o) => o.service_id),
    appNames: new Map(
      db()
        .all<{ id: string; name: string }>('SELECT id, name FROM applications')
        .map((a) => [a.id, a.name]),
    ),
    members,
    linked,
    scoped,
  };
}

// ---------- parts ----------

const counts = (): ScorecardDutyCounts => ({ total: 0, met: 0, open: 0, notMet: 0 });
const levelStatus = (c: ScorecardDutyCounts): ScorecardPartStatus => (!c.total ? 'none' : c.notMet ? 'attention' : c.open ? 'pending' : 'ok');

function dutiesPart(d: Data, serviceId: string): ScorecardDuties {
  const by: Record<DutyLevel, ScorecardDutyCounts> = { mandatory: counts(), recommended: counts(), optional: counts() };
  const items: ScorecardDutyItem[] = [];
  for (const duty of d.duties.get(serviceId) ?? []) {
    const last = d.lastClosed.get(duty.id) ?? null;
    const cur = periodAt(duty.interval_kind, d.now, d.tz);
    // nothing stored for the current period: nothing counts yet (the job stores a period once something happened)
    const curStatus: DutyPeriodStatus = d.open.get(`${duty.id}\n${cur.key}`)?.status ?? 'due';
    const result = last && BAD_DUTY.includes(last.status) ? 'notMet' : OK_DUTY.includes(curStatus) ? 'met' : BAD_DUTY.includes(curStatus) ? 'notMet' : 'open';
    by[duty.level].total++;
    by[duty.level][result]++;
    items.push({
      dutyId: duty.id,
      name: duty.name,
      level: duty.level,
      applicationName: duty.application_id ? (d.appNames.get(duty.application_id) ?? null) : null,
      lastClosed: last ? { key: last.period_key, status: last.status } : null,
      current: { key: cur.key, status: curStatus },
      result,
    });
  }
  const rec = levelStatus(by.recommended);
  return {
    status: levelStatus(by.mandatory),
    mandatory: by.mandatory,
    // recommended duties never set "attention": a recommended duty not met is shown as pending
    recommended: { ...by.recommended, status: rec === 'attention' ? 'pending' : rec },
    optional: { total: by.optional.total },
    items,
  };
}

function availabilityPart(d: Data, serviceId: string, cache: ReturnType<typeof readingCache>): ScorecardAvailability {
  const list = (d.objectives.get(serviceId) ?? []).map((o) => ({
    id: o.id,
    name: o.name,
    status: judge(o, cache.read(o.platform_id, o.endpoint_key).values).status,
    applicationName: o.application_id ? (d.appNames.get(o.application_id) ?? null) : null,
  }));
  const n = (s: string) => list.filter((o) => o.status === s).length;
  const below = n('below');
  const noData = n('noData');
  return {
    status: !list.length ? 'none' : below ? 'attention' : noData ? 'pending' : 'ok',
    total: list.length,
    met: n('met'),
    below,
    noData,
    objectives: list,
  };
}

interface DocCtx {
  rows: Map<string, { id: string; number: string; title: string; type_id: string; type_key: string; type_name: string; status: string }>;
  states: ReturnType<typeof documentStates>;
  rules: { id: string; type_id: string; dimension: (typeof CIA_DIMENSIONS)[number]; min_level: string }[];
  ratings: ReturnType<typeof ratingsOf>;
  scale: ReturnType<typeof currentScale>;
  types: Map<string, { id: string; key: string; name: string; workflow: string; archived: number }>;
}

function docCtx(d: Data, viewer: AuthUser | null): DocCtx {
  const apps = new Set([...d.members.values()].flat());
  const ids = new Set<string>();
  for (const s of d.linked.values()) for (const r of s) ids.add(r);
  for (const [r, a] of d.scoped) if (a.some((x) => apps.has(x))) ids.add(r);
  // documents the reader may not read neither count nor show (viewer null: the snapshot, no particular reader)
  const rows = documentRows([...ids]).filter((r) => !viewer || canReadRecordRow(viewer, r));
  const scale = currentScale();
  const types = new Map(
    db()
      .all<{ id: string; key: string; name: string; workflow: string; archived: number }>('SELECT id, key, name, workflow, archived FROM record_types')
      .map((t) => [t.id, t]),
  );
  return {
    rows: new Map(rows.map((r) => [r.id, r])),
    states: documentStates(
      undefined,
      undefined,
      rows.map((r) => r.id),
    ),
    rules: ruleRows().filter((r) => r.enabled && ruleValid(r, types.get(r.type_id), scale)),
    ratings: ratingsOf([...apps]),
    scale,
    types,
  };
}

function documentationPart(d: Data, serviceId: string, c: DocCtx): ScorecardDocumentation & { ids: string[] } {
  const apps = d.members.get(serviceId) ?? [];
  const linked = d.linked.get(serviceId) ?? new Set<string>();
  const ids = [...c.rows.keys()].filter((id) => linked.has(id) || (d.scoped.get(id) ?? []).some((a) => apps.includes(a)));
  const list: ScorecardDocumentRef[] = ids
    .map((id) => {
      const r = c.rows.get(id)!;
      const st = c.states.get(id);
      return {
        id,
        number: r.number,
        title: r.title,
        typeKey: r.type_key,
        released: !!st?.edition && r.status !== 'withdrawn',
        reviewStatus: st?.review.status ?? 'none',
      };
    })
    .sort((a, b) => a.number.localeCompare(b.number));
  const released = list.filter((x) => x.released);
  const expected: ScorecardExpectedDocument[] = [];
  for (const rule of c.rules) {
    const levels = c.scale.levels[rule.dimension];
    const min = levelRank(levels, rule.min_level);
    for (const a of apps) {
      const rating = c.ratings.get(a)?.[rule.dimension];
      if (!rating || rating.needsRerating || levelRank(levels, rating.level) < min) continue;
      const satisfiedBy = released
        .filter((x) => c.rows.get(x.id)!.type_id === rule.type_id)
        .filter((x) => {
          const scope = d.scoped.get(x.id) ?? [];
          // the document applies to the application, or to the whole service (linked to it, not limited to applications)
          return scope.includes(a) || (linked.has(x.id) && !scope.length);
        })
        .map((x) => ({ id: x.id, number: x.number, title: x.title }));
      const t = c.types.get(rule.type_id);
      expected.push({
        ruleId: rule.id,
        typeKey: t?.key ?? rule.type_id,
        typeName: t?.name ?? rule.type_id,
        dimension: rule.dimension,
        minLevel: rule.min_level,
        applicationId: a,
        applicationName: d.appNames.get(a) ?? a,
        level: rating.level,
        satisfiedBy,
      });
    }
  }
  const overdue = released.filter((x) => x.reviewStatus === 'overdue').length;
  const missing = expected.filter((e) => !e.satisfiedBy.length).length;
  return {
    status: !released.length || overdue || missing ? 'attention' : 'ok',
    documents: list.length,
    released: released.length,
    overdue,
    dueSoon: released.filter((x) => x.reviewStatus === 'dueSoon').length,
    missing,
    list,
    expected: expected.sort((a, b) => a.applicationName.localeCompare(b.applicationName) || a.typeKey.localeCompare(b.typeKey)),
    ids: released.map((x) => x.id),
  };
}

function protectionPart(need: ReturnType<typeof protectionNeeds> extends Map<string, infer V> ? V : never, apps: number): ScorecardProtection {
  const scaleInvalid = CIA_DIMENSIONS.some((dim) => need[dim].scaleInvalid);
  const dimensions = CIA_DIMENSIONS.map((dim) => {
    const x = need[dim];
    const override = !!x.override && !x.override.needsRerating;
    return {
      dimension: dim,
      effective: x.effective,
      ok: !x.scaleInvalid && !!x.effective && (override || (x.total > 0 && x.rated === x.total && x.needsRerating === 0)),
      rated: x.rated,
      total: x.total,
      needsRerating: x.needsRerating,
      override,
    };
  });
  return { status: dimensions.every((x) => x.ok) ? 'ok' : 'attention', applications: apps, scaleInvalid, dimensions };
}

// ---------- scorecards ----------

export interface Computed {
  card: ServiceScorecard;
  /** Released documents that counted (snapshots) */
  documentIds: string[];
}

/**
 * The scorecards of these services (all not archived: undefined) for a reader; `viewer` null computes them for no
 * particular reader (every document counts) – the daily snapshot.
 */
export function computeScorecards(serviceIds: string[] | undefined, viewer: AuthUser | null, now = Date.now()): Computed[] {
  const d = load(serviceIds, now);
  if (!d.services.length) return [];
  const cache = readingCache(now);
  const docs = docCtx(d, viewer);
  const needs = protectionNeeds(d.services.map((s) => s.id));
  return d.services.map((s) => {
    const duties = dutiesPart(d, s.id);
    const availability = availabilityPart(d, s.id, cache);
    const { ids, ...documentation } = documentationPart(d, s.id, docs);
    const protection = protectionPart(needs.get(s.id)!, (d.members.get(s.id) ?? []).length);
    return {
      card: {
        serviceId: s.id,
        serviceName: s.name,
        owners: parseJson<string[]>(s.owners, []),
        criticality: (s.criticality as ServiceCriticality | null) ?? null,
        attention: [duties, availability, documentation, protection].some((p) => p.status === 'attention'),
        duties,
        availability,
        documentation,
        protection,
      },
      documentIds: ids,
    };
  });
}

const emptyParts = (): Record<ScorecardPart, ScorecardPartCounts> =>
  Object.fromEntries(SCORECARD_PARTS.map((p) => [p, Object.fromEntries(SCORECARD_PART_STATUSES.map((s) => [s, 0]))])) as Record<
    ScorecardPart,
    ScorecardPartCounts
  >;

function rollup(cards: ServiceScorecard[], owner: string | null, key: string): ScorecardRollupGroup {
  const parts = emptyParts();
  for (const c of cards) for (const p of SCORECARD_PARTS) parts[p][c[p].status]++;
  return { owner, key, services: cards.length, attention: cards.filter((c) => c.attention).length, parts };
}

/** Rollups: overall, and per owner (a user or a team; a service with two owners counts for both; "none": no owners). */
export function rollups(cards: ServiceScorecard[]): ScorecardOverview['rollup'] {
  const owners = [...new Set(cards.flatMap((c) => c.owners))].sort();
  const groups = owners.map((o) =>
    rollup(
      cards.filter((c) => c.owners.includes(o)),
      o,
      o,
    ),
  );
  const none = cards.filter((c) => !c.owners.length);
  if (none.length) groups.push(rollup(none, null, 'none'));
  return { overall: rollup(cards, null, 'all'), owners: groups };
}

export function scorecardOverview(now = Date.now()): ScorecardOverview {
  const u = me();
  const cards = computeScorecards(undefined, u, now).map((c) => c.card);
  return { generatedAt: new Date(now).toISOString(), services: cards, rollup: rollups(cards) };
}

// ---------- snapshots (history) ----------

export interface SnapshotRow {
  day: string;
  service_id: string;
  service_name: string;
  owners: string;
  attention: number;
  duties: ScorecardPartStatus;
  availability: ScorecardPartStatus;
  documentation: ScorecardPartStatus;
  protection: ScorecardPartStatus;
  document_ids: string;
  details: string;
  updated_at: string;
}

/** The local day (instance time zone) of an instant: 2026-10-26. */
export function dayOf(t: number, tz = instanceTimeZone()): string {
  const p = localDate(t, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Whether the reader may read every document a snapshot counted (deleted documents do not hide anything). */
function snapshotReader(u: AuthUser, rows: SnapshotRow[]): (r: SnapshotRow) => boolean {
  const ids = [...new Set(rows.flatMap((r) => parseJson<string[]>(r.document_ids, [])))];
  const hidden = new Set(
    documentRows(ids)
      .filter((r) => !canReadRecordRow(u, r))
      .map((r) => r.id),
  );
  return (r) => !hidden.size || !parseJson<string[]>(r.document_ids, []).some((id) => hidden.has(id));
}

function pointOf(r: SnapshotRow, readable: boolean): ServiceScorecardHistoryPoint {
  const parts = {
    duties: r.duties,
    availability: r.availability,
    documentation: readable ? r.documentation : ('hidden' as const),
    protection: r.protection,
  };
  return { day: r.day, attention: SCORECARD_PARTS.some((p) => parts[p] === 'attention'), parts };
}

const DAY = 86400000;
const sinceDay = (days: number, now: number) => dayOf(now - Math.max(1, Math.min(days, 730)) * DAY);

/** The rollup per stored day (oldest first), optionally of the services one owner had that day. */
export function scorecardTrend(o: { days?: number; owner?: string; from?: string; to?: string } = {}, now = Date.now()): ScorecardTrendPoint[] {
  const u = me();
  const from = o.from ?? sinceDay(o.days ?? 90, now);
  const rows = db()
    .all<SnapshotRow>(`SELECT * FROM scorecard_snapshots WHERE day >= ?${o.to ? ' AND day <= ?' : ''} ORDER BY day, service_id`, from, ...(o.to ? [o.to] : []))
    .filter((r) => {
      if (!o.owner) return true;
      const owners = parseJson<string[]>(r.owners, []);
      return o.owner === 'none' ? !owners.length : owners.includes(o.owner.toLowerCase());
    });
  const readable = snapshotReader(u, rows);
  const days = new Map<string, ScorecardTrendPoint>();
  for (const r of rows) {
    let p = days.get(r.day);
    if (!p) {
      const parts = Object.fromEntries(Object.entries(emptyParts()).map(([k, v]) => [k, { ...v, hidden: 0 }])) as ScorecardTrendPoint['parts'];
      p = { day: r.day, services: 0, attention: 0, parts };
      days.set(r.day, p);
    }
    const pt = pointOf(r, readable(r));
    p.services++;
    if (pt.attention) p.attention++;
    for (const part of SCORECARD_PARTS) p.parts[part][pt.parts[part]]++;
  }
  return [...days.values()];
}

export function serviceHistory(serviceId: string, days = 90, now = Date.now()): ServiceScorecardHistoryPoint[] {
  const u = me();
  const rows = db().all<SnapshotRow>('SELECT * FROM scorecard_snapshots WHERE service_id = ? AND day >= ? ORDER BY day', serviceId, sinceDay(days, now));
  const readable = snapshotReader(u, rows);
  return rows.map((r) => pointOf(r, readable(r)));
}

/** The stored scorecards of one day (reports for a period that has ended), for the reader. */
export function snapshotsOf(day: string): { serviceName: string; serviceId: string; point: ServiceScorecardHistoryPoint }[] {
  const u = me();
  const rows = db().all<SnapshotRow>('SELECT * FROM scorecard_snapshots WHERE day = ? ORDER BY service_name, service_id', day);
  const readable = snapshotReader(u, rows);
  return rows.map((r) => ({ serviceId: r.service_id, serviceName: r.service_name, point: pointOf(r, readable(r)) }));
}

export function serviceScorecard(serviceId: string, now = Date.now()): ServiceScorecardDetail {
  const u = me();
  const s = db().get<{ id: string; archived: number }>('SELECT id, archived FROM services WHERE id = ?', serviceId);
  if (!s) throw new HttpError(404, `Service ${serviceId} not found`, 'SERVICE_NOT_FOUND', { id: serviceId });
  if (s.archived) throw new HttpError(409, 'The service is archived: it has no scorecard', 'SCORECARD_SERVICE_ARCHIVED', { id: serviceId });
  const card = computeScorecards([serviceId], u, now)[0]!.card;
  return { ...card, history: serviceHistory(serviceId, 90, now) };
}

// ---------- start page ----------

/** Service editors, auditors and administrators see every service on the start page; the others the services they own. */
const seesAll = (u: AuthUser) => u.roles.some((r) => r === 'admin' || r === 'designer' || r === 'auditor');

/** The start page tile: services whose scorecard needs attention; null when the user owns none (and does not see all). */
export function scorecardAttention(now = Date.now()): { attention: number; services: number } | null {
  const u = currentUser();
  if (!u) return null;
  const all = seesAll(u);
  let ids: string[] | undefined;
  if (!all) {
    ids = db()
      .all<{ id: string; owners: string }>('SELECT id, owners FROM services WHERE archived = 0')
      .filter((s) => parseJson<string[]>(s.owners, []).some((o) => matches(u, o)))
      .map((s) => s.id);
    if (!ids.length) return null;
  }
  const cards = computeScorecards(ids, u, now);
  return { attention: cards.filter((c) => c.card.attention).length, services: cards.length };
}
