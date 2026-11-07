/**
 * The local wall clock in an IANA time zone (shared by the daily summary and quiet hours, ADR 0012). Steward never
 * computes and stores a future local time as an instant: "is it quiet now?" and "is the summary due?" are answered
 * from the wall clock each time, so daylight-saving switches need no special case beyond the ones in quiet.ts.
 */

const formats = new Map<string, Intl.DateTimeFormat>();

function format(timeZone: string): Intl.DateTimeFormat {
  let f = formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    if (formats.size > 500) formats.clear();
    formats.set(timeZone, f);
  }
  return f;
}

export interface LocalClock {
  /** YYYY-MM-DD */
  day: string;
  /** 0 = Sunday */
  weekday: number;
  /** Minutes after local midnight */
  minutes: number;
}

/** Local calendar day (YYYY-MM-DD), weekday (0 = Sunday) and minutes after midnight in a time zone. */
export function localClock(now: number, timeZone: string): LocalClock {
  const parts: Record<string, string> = {};
  for (const p of format(timeZone).formatToParts(new Date(now))) parts[p.type] = p.value;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday ?? '');
  return { day: `${parts.year}-${parts.month}-${parts.day}`, weekday, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** Offset of the zone from UTC at `now`, in minutes (Europe/Berlin in winter: 60). */
export function utcOffsetMinutes(now: number, timeZone: string): number {
  const c = localClock(now, timeZone);
  const [y, m, d] = c.day.split('-').map(Number);
  const local = Date.UTC(y!, m! - 1, d!, Math.floor(c.minutes / 60), c.minutes % 60);
  const minute = Math.floor(now / 60000) * 60000;
  return Math.round((local - minute) / 60000);
}

/** "HH:MM" → minutes after midnight */
export const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
};

export const hhmmOf = (minutes: number): string => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
