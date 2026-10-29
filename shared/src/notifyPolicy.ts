import { z } from 'zod';

/**
 * The notification policy of a source that repeats runs (#139): schedules, webhook triggers and monitor outputs that
 * start a process. It decides who is interrupted, how and when – never what is recorded (run history, checks, start
 * page, summaries and reports always show every result). Runs started by hand follow the routes; sub-processes
 * follow the source of their parent.
 *
 * - mode: failed checks notify on change (a check starts failing, its result changes, a reminder while it keeps
 *   failing), after every run, or never. `resolved`: a message when the check passes again.
 * - change: what counts as a change – the message or severity (`result`), or only the start and end of failing (`state`).
 * - channels: null = as configured (the routes per event); a list = only these channels (a channel turned off stays off).
 * - pause: no messages until a time (or until resumed), optionally still in the app; a pause that ends while a check
 *   still fails sends one "still failing" message.
 */
export const SCHEDULE_NOTIFY_MODES = ['change', 'every', 'off'] as const;
export type ScheduleNotifyMode = (typeof SCHEDULE_NOTIFY_MODES)[number];
export const NOTIFY_CHANGE_KINDS = ['result', 'state'] as const;
export type NotifyChange = (typeof NOTIFY_CHANGE_KINDS)[number];
export const NOTIFY_CHANNELS = ['inApp', 'email', 'teams', 'webhook'] as const;
export const SCHEDULE_REMINDER_MAX_HOURS = 24 * 14;

export interface NotifyPause {
  /** ISO time the pause ends; null: until resumed */
  until: string | null;
  reason: string;
  /** Still show the messages in the app */
  inApp: boolean;
  /** When the pause was set */
  at?: string;
}

export interface ScheduleNotify {
  mode: ScheduleNotifyMode;
  /** On change: remind after this many hours while the check keeps failing with the same result (0: no reminder) */
  reminderHours: number;
  resolved: boolean;
  /** What counts as a change (default `result`) */
  change?: NotifyChange;
  /** null or missing: as configured (the routes); a list: only these channels */
  channels?: (typeof NOTIFY_CHANNELS)[number][] | null;
  /** Set and ended with the pause and resume actions (schedules, triggers) or in the definition (monitor outputs) */
  pause?: NotifyPause | null;
}
/** The policy of every source */
export type NotifyPolicy = ScheduleNotify;

export const DEFAULT_SCHEDULE_NOTIFY: ScheduleNotify = { mode: 'change', reminderHours: 4, resolved: false, change: 'result', channels: null, pause: null };
/** Webhook triggers and monitor outputs start as before 0.2.4: every failed check notifies */
export const DEFAULT_TRIGGER_NOTIFY: ScheduleNotify = { ...DEFAULT_SCHEDULE_NOTIFY, mode: 'every' };

export const notifyPauseSchema = z
  .object({
    until: z.iso.datetime({ offset: true }).nullable(),
    reason: z.string().trim().max(500).default(''),
    inApp: z.boolean().default(true),
    at: z.string().max(40).optional(),
  })
  .strict();

export const notifyPolicySchema = z
  .object({
    mode: z.enum(SCHEDULE_NOTIFY_MODES),
    reminderHours: z.number().int().min(0).max(SCHEDULE_REMINDER_MAX_HOURS),
    resolved: z.boolean(),
    change: z.enum(NOTIFY_CHANGE_KINDS).optional(),
    channels: z
      .array(z.enum(NOTIFY_CHANNELS))
      .max(NOTIFY_CHANNELS.length)
      .transform((l) => [...new Set(l)])
      .nullable()
      .optional(),
    pause: notifyPauseSchema.nullable().optional(),
  })
  .strict();

/** A pause in effect at `now` */
export const pauseActive = (p: NotifyPause | null | undefined, now = Date.now()): boolean => !!p && (p.until === null || Date.parse(p.until) > now);
