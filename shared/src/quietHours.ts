import { z } from 'zod';
import type { NotificationEvent } from './ops.js';

/**
 * Quiet hours and digests (0.10.0, #236, ADR 0012, docs/NOTIFICATIONS.md). Quiet hours decide when an interrupting
 * message (e-mail, a Teams post) reaches its target – never whether: a held message goes out later, in one catch-up
 * message at the end of the quiet hours or in a digest. The app always gets everything at once; JSON webhooks are never
 * held.
 */

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
/** JavaScript's getDay() order (0 = Sunday) */
export const WEEKDAY_OF_JS: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export const QUIET_LIMITS = { windows: 14, openPerTarget: 500, releasedDays: 7, statesPerItem: 5 } as const;

export interface QuietWindow {
  days: Weekday[];
  /** HH:MM local time; a `to` not after `from` crosses midnight and belongs to its start day */
  from: string;
  to: string;
}

export interface QuietHours {
  enabled: boolean;
  /** IANA, e.g. Europe/Berlin */
  timeZone: string;
  windows: QuietWindow[];
  /** Whole days, e.g. the weekend */
  allDay: Weekday[];
  /** Messages from sources marked urgent break through (the fixed break-throughs always do) */
  urgentBreaksThrough: boolean;
}

export const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: false,
  timeZone: 'UTC',
  windows: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: '18:00', to: '07:30' }],
  allDay: ['sat', 'sun'],
  urgentBreaksThrough: true,
};

/** The event groups of digests (decision 3 of ADR 0012): a new event joins a group. */
export const DIGEST_GROUPS = ['decisions', 'runs', 'monitors', 'reminders', 'reports', 'costs'] as const;
export type DigestGroup = (typeof DIGEST_GROUPS)[number];

/** Which group an event belongs to; null: never digested (security.emergency, the daily summary). */
export const EVENT_DIGEST_GROUP: Record<NotificationEvent, DigestGroup | null> = {
  'task.assigned': 'decisions',
  'mcp.request': 'decisions',
  'duty.exception': 'decisions',
  'plant.change_proposed': 'decisions',
  'run.failed': 'runs',
  'check.failed': 'runs',
  'check.resolved': 'runs',
  'schedule.skipped': 'runs',
  'dataset.stale': 'runs',
  'backup.failed': 'runs',
  'export.failed': 'runs',
  'contract.failed': 'runs',
  'plant.advisory_matched': 'reminders',
  'monitor.status': 'monitors',
  'monitor.state': 'monitors',
  'platform.failing': 'monitors',
  'objective.breached': 'monitors',
  'maintenance.announced': 'monitors',
  'credential.due': 'reminders',
  'document.review': 'reminders',
  'ticket.unchecked': 'reminders',
  'duty.due': 'reminders',
  'duty.missed': 'reminders',
  'duty.ended': 'reminders',
  'measure.due': 'reminders',
  'supplier.certificate_expiring': 'reminders',
  'supplier.notice_due': 'reminders',
  'corrective.action_due': 'reminders',
  'access.undocumented': 'reminders',
  'plant.change_decided': 'reminders',
  'report.ready': 'reports',
  'stack.eol': 'reports',
  'stack.release': 'reports',
  'ai.budget': 'costs',
  'cost.budget': 'costs',
  'summary.daily': null,
  'security.emergency': null,
};

export const DIGEST_RHYTHMS = ['immediately', 'hourly', 'daily', 'weekly'] as const;
export type DigestRhythm = (typeof DIGEST_RHYTHMS)[number];
/** A run waits on a decision: never daily or weekly */
export const DECISION_RHYTHMS: readonly DigestRhythm[] = ['immediately', 'hourly'];

export interface DigestChoice {
  rhythm: DigestRhythm;
  /** daily, weekly: HH:MM local time */
  time?: string;
  /** weekly */
  weekday?: Weekday;
}

export interface DigestPrefs {
  /** IANA time zone of the daily and weekly times */
  timeZone: string;
  /** Groups left out: immediately */
  groups: Partial<Record<DigestGroup, DigestChoice>>;
}

export const DEFAULT_DIGESTS: DigestPrefs = { timeZone: 'UTC', groups: {} };

/** A person's quiet hours and digests (Profile → Notifications), or a team's default for its members. */
export interface NotificationPrefs {
  quietHours: QuietHours;
  digests: DigestPrefs;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { quietHours: DEFAULT_QUIET_HOURS, digests: DEFAULT_DIGESTS };

const validTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM, e.g. 07:30');
const timeZone = z.string().min(1).max(64).refine(validTimeZone, 'unknown time zone');
const days = z
  .array(z.enum(WEEKDAYS))
  .max(7)
  .transform((l) => WEEKDAYS.filter((d) => l.includes(d)));

export const quietHoursSchema = z
  .object({
    enabled: z.boolean(),
    timeZone,
    windows: z.array(z.object({ days, from: hhmm, to: hhmm }).strict()).max(QUIET_LIMITS.windows),
    allDay: days,
    urgentBreaksThrough: z.boolean(),
  })
  .strict();

const digestChoice = z
  .object({ rhythm: z.enum(DIGEST_RHYTHMS), time: hhmm.optional(), weekday: z.enum(WEEKDAYS).optional() })
  .strict()
  .superRefine((c, ctx) => {
    if ((c.rhythm === 'daily' || c.rhythm === 'weekly') && !c.time) ctx.addIssue({ code: 'custom', path: ['time'], message: 'choose a time' });
    if (c.rhythm === 'weekly' && !c.weekday) ctx.addIssue({ code: 'custom', path: ['weekday'], message: 'choose a day' });
  });

export const digestPrefsSchema = z
  .object({
    timeZone,
    groups: z
      .object(Object.fromEntries(DIGEST_GROUPS.map((g) => [g, digestChoice.optional()])) as Record<DigestGroup, z.ZodOptional<typeof digestChoice>>)
      .strict(),
  })
  .strict()
  .superRefine((d, ctx) => {
    const r = d.groups.decisions?.rhythm;
    if (r && !DECISION_RHYTHMS.includes(r))
      ctx.addIssue({ code: 'custom', path: ['groups', 'decisions', 'rhythm'], message: 'decisions are sent immediately or hourly – a run waits' });
  });

export const notificationPrefsSchema = z.object({ quietHours: quietHoursSchema, digests: digestPrefsSchema }).strict();

/** Where a person's settings come from: their own, a team default, or the instance default (off). */
export type NotificationPrefsSource = { from: 'own' } | { from: 'team'; team: string } | { from: 'instance' };

/** GET /api/me/notification-prefs */
export interface NotificationPrefsState {
  prefs: NotificationPrefs;
  source: NotificationPrefsSource;
  /** Administrators allow quiet hours and digests */
  allowed: boolean;
  /** Now: in quiet hours until (local HH:MM, in the quiet hours' time zone), and how many messages are held */
  quiet: { active: boolean; until: string | null; held: number };
}

/** Settings → Notifications: who uses quiet hours and digests (never the content). */
export interface QuietHoursAdmin {
  allowed: boolean;
  users: {
    username: string;
    displayName: string;
    source: NotificationPrefsSource['from'];
    quietHours: boolean;
    timeZone: string;
    digests: Partial<Record<DigestGroup, DigestRhythm>>;
    held: number;
  }[];
  /** Channel targets with quiet hours: the instance channels, team channels, monitor outputs */
  channels: { target: string; label: string; held: number }[];
}

/** The bell during quiet hours: "Quiet hours until 07:30 · 4 messages held". */
export interface QuietInfo {
  until: string | null;
  held: number;
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * Quiet by the wall clock alone (`weekday`: 0 = Sunday, `minutes` after local midnight): a whole day, or a window (one
 * that crosses midnight belongs to its start day). A whole day joins up with the next morning: with Saturday and Sunday
 * all day, "weekdays 18:00–07:30" is quiet until Monday 07:30. The server adds the daylight-saving rules
 * (server/src/notifications/quiet.ts); the profile's week grid uses this as it is.
 */
export function wallQuiet(qh: Pick<QuietHours, 'windows' | 'allDay'>, c: { weekday: number; minutes: number }): boolean {
  const day = WEEKDAY_OF_JS[c.weekday]!;
  const prev = WEEKDAY_OF_JS[(c.weekday + 6) % 7]!;
  if (qh.allDay.includes(day)) return true;
  for (const w of qh.windows) {
    const from = minutesOf(w.from);
    const to = minutesOf(w.to);
    if (to > from) {
      if (w.days.includes(day) && c.minutes >= from && c.minutes < to) return true;
    } else {
      // to ≤ from: across midnight (to = from: a whole day from that time on)
      if (w.days.includes(day) && c.minutes >= from) return true;
      if ((w.days.includes(prev) || (qh.allDay.includes(prev) && w.days.includes(day))) && c.minutes < to) return true;
    }
  }
  return false;
}
