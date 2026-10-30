/**
 * Maintenance windows (#108): planned work on platforms, systems, applications and services – once or repeating
 * weekly or monthly. During a window the affected monitors stay quiet (still recorded), check messages of affected
 * runs can be paused, and availability figures show the planned minutes next to them.
 */

export const MAINTENANCE_TARGET_KINDS = ['platform', 'system', 'application', 'service'] as const;
export type MaintenanceTargetKind = (typeof MAINTENANCE_TARGET_KINDS)[number];

export const MAINTENANCE_FREQS = ['weekly', 'monthly'] as const;
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
