import { z } from 'zod';
import { DAILY_SUMMARY_SECTIONS } from '@sm/shared';

/** The settings of a daily summary: a person's own, or a team's default for its members (#136). */

const validTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const prefsSchema = z
  .object({
    enabled: z.boolean(),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM, e.g. 07:30'),
    timeZone: z.string().min(1).max(64).refine(validTimeZone, 'unknown time zone'),
    days: z.enum(['weekdays', 'everyday']),
    channel: z.enum(['inApp', 'inAppEmail']),
    sections: z.array(z.enum(DAILY_SUMMARY_SECTIONS)).max(DAILY_SUMMARY_SECTIONS.length),
    skipEmpty: z.boolean(),
  })
  .strict();
