import { DUTY_PERIOD_KEY_RE, type DutyInterval } from '@sm/shared';

/**
 * Calendar periods of duties in a time zone: ISO weeks (Monday 00:00 to the next Monday 00:00), months, quarters,
 * half years and years. Boundaries are local midnights, so a period of a zone with daylight saving time is an hour
 * shorter or longer than its days suggest; nothing here counts in fixed 24-hour days.
 */

export interface Period {
  key: string;
  /** Local midnight of the first day (epoch ms) */
  start: number;
  /** Local midnight after the last day (exclusive) */
  end: number;
}

/** The instance time zone: the server's (TZ), as the system status shows it. */
export function instanceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

interface Parts {
  y: number;
  m: number;
  d: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
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
  return f;
}

function zoneParts(t: number, tz: string): Parts & { h: number; mi: number; s: number } {
  const p: Record<string, string> = {};
  for (const x of formatter(tz).formatToParts(new Date(t))) if (x.type !== 'literal') p[x.type] = x.value;
  return { y: +p.year!, m: +p.month!, d: +p.day!, h: +p.hour!, mi: +p.minute!, s: +p.second! };
}

/** Local time minus UTC at instant t (ms). */
function offset(t: number, tz: string): number {
  const p = zoneParts(t, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
}

/** The instant of local midnight of y-m-d in tz (month and day may overflow: 2026-13-01 is 2027-01-01). */
export function localMidnight(y: number, m: number, d: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offset(guess, tz);
  const o2 = offset(t, tz);
  if (guess - o2 !== t) t = guess - o2;
  return t;
}

/** The local calendar date of an instant. */
export function localDate(t: number, tz: string): Parts {
  const p = zoneParts(t, tz);
  return { y: p.y, m: p.m, d: p.d };
}

/** Local midnight `days` calendar days after the local date of t (t itself is usually a midnight). */
export function addLocalDays(t: number, days: number, tz: string): number {
  const p = localDate(t, tz);
  return localMidnight(p.y, p.m, p.d + days, tz);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** ISO 8601 week-numbering year and week of a calendar date. */
function isoWeek(y: number, m: number, d: number): { year: number; week: number } {
  const date = new Date(Date.UTC(y, m - 1, d));
  // the Thursday of this week decides the year
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const year = date.getUTCFullYear();
  const week = Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return { year, week };
}

/** Months per period of the month-based intervals. */
const MONTHS: Partial<Record<DutyInterval, number>> = { monthly: 1, quarterly: 3, halfYearly: 6, yearly: 12 };

function monthKey(interval: DutyInterval, y: number, firstMonth: number): string {
  if (interval === 'monthly') return `${y}-${pad(firstMonth)}`;
  if (interval === 'quarterly') return `${y}-Q${(firstMonth - 1) / 3 + 1}`;
  if (interval === 'halfYearly') return `${y}-H${firstMonth === 1 ? 1 : 2}`;
  return String(y);
}

/** The period of `interval` that contains instant t. */
export function periodAt(interval: DutyInterval, t: number, tz: string): Period {
  const p = localDate(t, tz);
  if (interval === 'weekly') {
    const wd = (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7;
    const start = localMidnight(p.y, p.m, p.d - wd, tz);
    const w = isoWeek(p.y, p.m, p.d);
    return { key: `${w.year}-W${pad(w.week)}`, start, end: localMidnight(p.y, p.m, p.d - wd + 7, tz) };
  }
  const n = MONTHS[interval]!;
  const first = Math.floor((p.m - 1) / n) * n + 1;
  return { key: monthKey(interval, p.y, first), start: localMidnight(p.y, first, 1, tz), end: localMidnight(p.y, first + n, 1, tz) };
}

/** The period after p. */
export const nextPeriod = (interval: DutyInterval, p: Period, tz: string): Period => periodAt(interval, p.end + 3600000, tz);

/** The period with this key (null: not a key of the interval). */
export function periodOfKey(interval: DutyInterval, key: string, tz: string): Period | null {
  if (!DUTY_PERIOD_KEY_RE[interval].test(key)) return null;
  const y = Number(key.slice(0, 4));
  let p: Period;
  if (interval === 'weekly') {
    const week = Number(key.slice(6));
    // the Monday of week 1 is the Monday on or before 4 January
    const jan4 = new Date(Date.UTC(y, 0, 4));
    const monday = 4 - ((jan4.getUTCDay() + 6) % 7);
    p = periodAt(interval, localMidnight(y, 1, monday + (week - 1) * 7, tz) + 3600000, tz);
  } else if (interval === 'monthly') p = periodAt(interval, localMidnight(y, Number(key.slice(5)), 1, tz) + 3600000, tz);
  else if (interval === 'quarterly') p = periodAt(interval, localMidnight(y, (Number(key.slice(6)) - 1) * 3 + 1, 1, tz) + 3600000, tz);
  else if (interval === 'halfYearly') p = periodAt(interval, localMidnight(y, key.endsWith('1') ? 1 : 7, 1, tz) + 3600000, tz);
  else p = periodAt(interval, localMidnight(y, 1, 1, tz) + 3600000, tz);
  // week 53 of a year with 52 weeks names the first week of the next year: not a key of its own
  return p.key === key ? p : null;
}

/** End of the grace period: `graceDays` calendar days after the end of the period. */
export const graceEnd = (p: Period, graceDays: number, tz: string): number => (graceDays > 0 ? addLocalDays(p.end, graceDays, tz) : p.end);
