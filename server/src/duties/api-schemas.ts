import { z, type ZodTypeAny } from 'zod';
import { DUTY_INTERVALS, DUTY_LEVELS, DUTY_PERIOD_STATUSES, DUTY_SKIP_STATUSES } from '@sm/shared';

/** Response and query schemas of the service duty endpoints of the public API (/api/v1/duties…). */

const ts = () => z.string().datetime({ offset: true }).describe('ISO 8601 timestamp (UTC)');
const page = {
  limit: z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)'),
  cursor: z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)'),
};

const DutySkipEntry = z.object({
  id: z.string(),
  periodKey: z.string(),
  status: z.enum(DUTY_SKIP_STATUSES),
  reason: z.string().describe('Why the period is skipped'),
  requestedBy: z.string(),
  requestedAt: ts(),
  decidedBy: z.string().nullable().describe('The second person who approved or rejected it (never the one who asked)'),
  decidedAt: ts().nullable(),
  comment: z.string(),
});

export const DutyPeriodEntry = z.object({
  key: z.string().describe('2026-W44, 2026-10, 2026-Q4, 2026-H2 or 2026'),
  start: ts().describe('Local midnight of the first day of the period (instance time zone)'),
  end: ts().describe('Local midnight after the last day (exclusive)'),
  graceEndsAt: ts().describe('End of the grace period (= end without one)'),
  status: z
    .enum(DUTY_PERIOD_STATUSES)
    .describe(
      'due: not over and nothing counts yet; done: a successful real run started in the period and ended by the end of the grace period; late: done by a run started in the grace period; skipped: an approved exception; failed: only failed or rejected runs; missed: no run',
    ),
  closed: z.boolean().describe('Stored for good: the result no longer changes'),
  closedAt: ts().nullable(),
  inGrace: z.boolean(),
  run: z
    .object({ id: z.string(), status: z.string(), startedAt: z.string(), finishedAt: z.string().nullable() })
    .nullable()
    .describe('The run that counts (done, late) or the last failed one; null when the token owner may not view the process'),
  failedRuns: z.number().int(),
  runsInProgress: z.number().int(),
  skip: DutySkipEntry.nullable().describe('The approved exception, or the one waiting for a second person'),
  snapshot: z
    .object({
      name: z.string(),
      level: z.enum(DUTY_LEVELS),
      interval: z.enum(DUTY_INTERVALS),
      graceDays: z.number().int(),
      processName: z.string().describe('Empty when the token owner may not view the process'),
      timeZone: z.string(),
    })
    .describe('What the period was judged against: frozen when it closed'),
});

export const DutyEntry = z.object({
  id: z.string(),
  serviceId: z.string(),
  serviceName: z.string(),
  applicationId: z.string().nullable().describe('The application of the service the duty is about, if any'),
  applicationName: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  processId: z.string().nullable().describe('The process whose real runs count; null when the token owner may not view it'),
  processName: z.string().nullable(),
  scheduleId: z.string().nullable().describe('The schedule that runs it (optional)'),
  interval: z.enum(DUTY_INTERVALS),
  level: z.enum(DUTY_LEVELS),
  graceDays: z.number().int().describe('Days into the next period a run may still end (and a late run start)'),
  remindDays: z.number().int().describe('Reminder this many days before the period ends; 0: none'),
  owners: z.array(z.string()).describe('Users and teams responsible for the duty (user:<name>, team:<name>); empty: the service owners'),
  archived: z.boolean(),
  timeZone: z.string().describe('The instance time zone the periods follow'),
  current: DutyPeriodEntry.nullable().describe('The period running now (null for archived duties)'),
  previous: DutyPeriodEntry.nullable().describe('The period before'),
  pendingSkips: z.number().int(),
  createdAt: ts(),
  createdBy: z.string(),
  updatedAt: ts(),
  updatedBy: z.string(),
});

export const DUTY_COMPONENTS: Record<string, ZodTypeAny> = { DutyEntry, DutyPeriodEntry };

export const DutyListQuery = z.object({
  ...page,
  serviceId: z.string().max(200).optional(),
  applicationId: z.string().max(200).optional(),
  level: z.enum(DUTY_LEVELS).optional(),
  archived: z.enum(['exclude', 'include', 'only']).default('exclude').describe('Archived duties: left out (default), included, or only these'),
});

export const DutyPeriodsQuery = z.object({
  ...page,
  status: z.enum(DUTY_PERIOD_STATUSES).optional(),
  closed: z.boolean().optional().describe('true: stored periods only'),
  from: ts().optional().describe('Periods that end after this time'),
  to: ts().optional().describe('Periods that start before this time'),
});
