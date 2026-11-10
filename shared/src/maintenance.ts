/**
 * Maintenance windows (#108): planned work on platforms, systems, applications, services and monitors – once or
 * repeating weekly or monthly. During a window the affected monitors stay quiet (still recorded), check messages of
 * affected runs can be paused, and availability figures show the planned minutes next to them.
 *
 * Since 0.11 (ADR 0018) this is the one maintenance-window concept: a window can list monitors directly, and the
 * monitors' own windows of earlier versions were copied into such windows.
 */

export const MAINTENANCE_TARGET_KINDS = ['platform', 'system', 'application', 'service', 'monitor', 'site', 'asset', 'device', 'collection'] as const;
export type MaintenanceTargetKind = (typeof MAINTENANCE_TARGET_KINDS)[number];
/**
 * 0.14: plant targets – a site, an asset, a device (`<asset>/<device>`, e.g. a gateway or a switch) or a data collection
 * (`<asset>/<collection>`). Only while the plant registry is on; they reach nothing in the engine by themselves: what
 * they affect is the window's impact (monitors are added to it on purpose, `POST …/impact/downtime`).
 */
export const PLANT_MAINTENANCE_TARGET_KINDS = ['site', 'asset', 'device', 'collection'] as const;
export type PlantMaintenanceTargetKind = (typeof PLANT_MAINTENANCE_TARGET_KINDS)[number];
export const isPlantMaintenanceTarget = (k: string): k is PlantMaintenanceTargetKind => (PLANT_MAINTENANCE_TARGET_KINDS as readonly string[]).includes(k);
/** kind:id of a target in a query (`?target=`, `?targets=`): plant ids hold `.`, a device or collection `<asset>/<id>`. */
export const MAINTENANCE_TARGET_RE = /^(platform|system|application|service|monitor|site|asset|device|collection):[\w.-]{1,80}(\/[\w.-]{1,80})?$/;

export const MAINTENANCE_FREQS = ['weekly', 'monthly'] as const;

/**
 * What a window does (0.13, ADR 0021): maintenance silences the affected monitors; planned downtime (weekends,
 * holidays, shutdowns) leaves their status as it is, suspends the maximum off time of monitors with states and still
 * alerts contradictions. Monitors without states are not affected by downtime. Downtime announces nothing by default.
 */
export const MAINTENANCE_KINDS = ['maintenance', 'downtime'] as const;
export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];
export type MaintenanceFreq = (typeof MAINTENANCE_FREQS)[number];

export const MAINTENANCE_LIMITS = {
  title: 160,
  note: 4000,
  targets: 100,
  maxDays: 31,
  interval: 12,
  reminderHoursMax: 336,
  /** Occurrences computed at most for one window and range */
  occurrences: 500,
} as const;

export interface MaintenanceRecurrence {
  freq: MaintenanceFreq;
  /** Every n weeks / months */
  interval: number;
  /** Last day a window may start (ISO); null: no end */
  until: string | null;
}

export interface MaintenanceTarget {
  kind: MaintenanceTargetKind;
  id: string;
  /** Null for a platform the reader may not see (or something deleted) */
  name: string | null;
}

export interface MaintenanceWindowSummary {
  id: string;
  /** maintenance (default) or downtime (ADR 0021) */
  kind: MaintenanceKind;
  title: string;
  note: string;
  /** The first occurrence */
  startsAt: string;
  endsAt: string;
  recurrence: MaintenanceRecurrence | null;
  /** The time zone the repetition keeps its wall-clock time in */
  timeZone: string;
  responsible: string[];
  targets: MaintenanceTarget[];
  changeRecord: { id: string; number: string; title: string } | null;
  /** Affected monitors show "maintenance" and send no alerts (checks are still recorded) */
  quietMonitors: boolean;
  /** Check and run messages of runs on affected platforms go to the app only */
  pauseMessages: boolean;
  /** Reminder this many hours before each occurrence (0: none) */
  reminderHours: number;
  cancelledAt: string | null;
  cancelledBy: string | null;
  /** False: disabled (a copy starts so) – it neither applies nor announces anything until enabled */
  enabled: boolean;
  /** The occurrence going on now, or the next one */
  current: { startsAt: string; endsAt: string; active: boolean } | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  canEdit: boolean;
}

export interface MaintenanceWindowDetail extends MaintenanceWindowSummary {
  /** The next occurrences (at most 20) */
  upcoming: { startsAt: string; endsAt: string }[];
  /** What it reaches beyond the listed items */
  affected: { platforms: number; monitors: number; applications: number; services: number };
}

/** One occurrence of a window in a range (the calendar). */
export interface MaintenanceOccurrence {
  windowId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  active: boolean;
  targets: MaintenanceTarget[];
}

export interface MaintenanceList {
  windows: MaintenanceWindowSummary[];
  occurrences: MaintenanceOccurrence[];
  from: string;
  to: string;
  canPlan: boolean;
}

// ---------- repetition in a time zone ----------

type Parts = { y: number; m: number; d: number; h: number; mi: number; s: number };
const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(t: number, tz: string): Parts {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(t))) if (x.type !== 'literal') p[x.type] = x.value;
  return { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour!, mi: +p.minute!, s: +p.second! };
}
const offset = (t: number, tz: string) => {
  const p = parts(t, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
};
/** The instant of a local wall-clock time (fields may overflow, e.g. day 32). */
function zoned(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - offset(guess, tz);
  const o2 = offset(t, tz);
  if (guess - o2 !== t) t = guess - o2;
  return t;
}
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * The n-th start of a window (n = 0: the first), keeping the local wall-clock time across daylight saving changes.
 * Monthly windows on the 29th–31st fall on the last day of shorter months.
 */
export function nthStart(start: number, r: MaintenanceRecurrence | null, n: number, tz: string): number {
  if (!r || n === 0) return start;
  const p = parts(start, tz);
  if (r.freq === 'weekly') return zoned(p.y, p.m, p.d + 7 * r.interval * n, p.h, p.mi, tz);
  const months = p.m - 1 + r.interval * n;
  const y = p.y + Math.floor(months / 12);
  const m = (months % 12) + 1;
  return zoned(y, m, Math.min(p.d, daysIn(y, m)), p.h, p.mi, tz);
}

/** The occurrences of a window that overlap [from, to), at most `max`. */
export function occurrencesBetween(
  w: { startsAt: string; endsAt: string; recurrence: MaintenanceRecurrence | null; timeZone: string },
  from: number,
  to: number,
  max: number = MAINTENANCE_LIMITS.occurrences,
): { start: number; end: number }[] {
  const s0 = Date.parse(w.startsAt);
  const dur = Date.parse(w.endsAt) - s0;
  if (!(dur > 0)) return [];
  const until = w.recurrence?.until ? Date.parse(w.recurrence.until) : Infinity;
  const out: { start: number; end: number }[] = [];
  if (!w.recurrence) return s0 < to && s0 + dur > from ? [{ start: s0, end: s0 + dur }] : [];
  // skip ahead roughly, then walk
  const period = (w.recurrence.freq === 'weekly' ? 7 : 28) * 86400000 * w.recurrence.interval;
  let n = Math.max(0, Math.floor((from - dur - s0) / period) - 2);
  for (let guard = 0; guard < 100000 && out.length < max; guard++, n++) {
    const start = nthStart(s0, w.recurrence, n, w.timeZone);
    if (start >= to || start > until) break;
    if (start + dur > from) out.push({ start, end: start + dur });
  }
  return out;
}

// ---------- impact before maintenance (0.14) ----------

/**
 * What a window affects, before it is saved and on its page: the graph from its targets – catalogue reach (down from
 * services, applications and systems, up from platforms and systems) and the plant (a site's assets, an asset's parts,
 * the devices behind a device such as a switch, data paths, collections, the data points they collect, the KPI jobs and
 * coverage that read them, datasets and dashboards, monitors and the owners to tell). Bounded: chains are followed
 * `depth` steps, each group names at most `items` and counts the rest; the walk stops after `nodes` entries.
 */
export const IMPACT_LIMITS = { depth: 4, items: 100, nodes: 5000, targets: MAINTENANCE_LIMITS.targets } as const;

export const IMPACT_GROUPS = [
  'assets',
  'devices',
  'dataPaths',
  'collections',
  'kpis',
  'coverage',
  'datasets',
  'dashboards',
  'monitors',
  'platforms',
  'systems',
  'applications',
  'services',
] as const;
export type ImpactGroupKind = (typeof IMPACT_GROUPS)[number];

/** Why an item is affected (the step of the walk that reached it). */
export type ImpactVia =
  | 'target'
  | 'site'
  | 'part'
  | 'switch'
  | 'device'
  | 'asset'
  | 'collector'
  | 'host'
  | 'chain'
  | 'dataPath'
  | 'collection'
  | 'dataPoint'
  | 'result'
  | 'sink'
  | 'platform'
  | 'reach'
  | 'link'
  | 'check';

export interface ImpactItem {
  /** Unique in its group: the item's id (plant entries of an asset: `<asset>/<id>`, a KPI job `<asset>/<job>`) */
  id: string;
  name: string;
  /** Its page in the web app (null: none, or not for this reader) */
  path: string | null;
  /** Context in words: the asset of a device, the KPI of a job, the site of an asset */
  detail: string;
  via: ImpactVia;
  /** The target or item it comes through (its name), when not a target itself */
  from: string | null;
}

/** What a monitor does during the window: stays quiet (maintenance), shows Off (it has an Off state), goes down. */
export const IMPACT_EXPECTATIONS = ['maintenance', 'downtime', 'off', 'down'] as const;
export type ImpactExpectation = (typeof IMPACT_EXPECTATIONS)[number];

export interface ImpactMonitor extends ImpactItem {
  /** Its status now (null: not evaluated yet) */
  status: string | null;
  enabled: boolean;
  /** It has states (ADR 0021) with an Off state: a stop on purpose shows Off, not Down */
  offState: boolean;
  /**
   * During the window: maintenance – the window keeps it quiet (it lists the monitor or an affected platform it checks);
   * downtime – planned downtime covers it; off – it goes Off (Off state); down – it would go down and alert
   */
  expect: ImpactExpectation;
  /** The window lists it already */
  listed: boolean;
  /** The planner may list it (acknowledge right) */
  canAdd: boolean;
}

export interface ImpactGroup<T extends ImpactItem = ImpactItem> {
  /** Every affected item the reader may see */
  total: number;
  /** Affected items the reader may not see: counted, not named */
  hidden: number;
  /** At most IMPACT_LIMITS.items, in a stable order */
  items: T[];
}

/** Someone to tell: an owner or contact of an affected item. */
export interface ImpactContact {
  /** user:<name> or team:<name> (a site's contacts without a Steward account: `contact:<name>`, shown only) */
  subject: string;
  label: string;
  /** What they own or look after, by name (at most 5) */
  of: string[];
  /** A Steward user or team: the announcement can reach them */
  notifiable: boolean;
}

export interface MaintenanceImpact {
  /** The targets as the reader may see them */
  targets: MaintenanceTarget[];
  /** maintenance or downtime: what the window does to monitors (the expectation) */
  kind: MaintenanceKind;
  groups: { [K in ImpactGroupKind]: K extends 'monitors' ? ImpactGroup<ImpactMonitor> : ImpactGroup };
  contacts: ImpactContact[];
  /** The walk stopped at IMPACT_LIMITS.nodes, or a chain was cut at the depth: there may be more */
  truncated: boolean;
  /** Monitors the planner may add, not listed yet (the one click "planned downtime for the affected monitors") */
  addableMonitors: number;
  /** The plant registry is on (plant targets and groups) */
  plant: boolean;
}

/** POST /api/maintenance-windows/:id/impact/downtime: planned downtime for the affected monitors, or list them in the window. */
export interface ImpactDowntimeResult {
  /** The window that now covers them: a new planned downtime, or this window (mode include) */
  window: MaintenanceWindowDetail;
  /** Monitors added */
  added: number;
  /** Affected monitors the planner may not list (no acknowledge right): left out */
  skipped: number;
}

/** POST /api/maintenance-windows/:id/impact/notify: the affected owners told (the announcement "Maintenance planned"). */
export interface ImpactNotifyResult {
  /** People the announcement went to */
  recipients: number;
  /** Sent for this version of the window before: nothing sent again */
  already: boolean;
}
