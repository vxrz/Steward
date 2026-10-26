/**
 * Service duties (#85): recurring tasks a service must (or should) have done – an access review every quarter, a
 * restore test every month. A duty names a process, an interval of calendar periods in the instance time zone, a
 * level and an optional grace period; every period gets a status from the real runs of the process, and the result
 * of every closed period is stored (the service scorecard reads it).
 */

/** Calendar periods: ISO weeks (Monday to Sunday), months, quarters, half years and years. */
export const DUTY_INTERVALS = ['weekly', 'monthly', 'quarterly', 'halfYearly', 'yearly'] as const;
export type DutyInterval = (typeof DUTY_INTERVALS)[number];

export const DUTY_LEVELS = ['mandatory', 'recommended', 'optional'] as const;
export type DutyLevel = (typeof DUTY_LEVELS)[number];

/**
 * due: the period (or its grace period) has not ended and nothing counts yet; done: a successful run started in the
 * period and ended by the end of the grace period; late: done, but the run started in the grace period; failed: only
 * failed or rejected runs; missed: no run at all; skipped: an approved exception for the period.
 */
export const DUTY_PERIOD_STATUSES = ['due', 'done', 'late', 'failed', 'missed', 'skipped'] as const;
export type DutyPeriodStatus = (typeof DUTY_PERIOD_STATUSES)[number];

export const DUTY_SKIP_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const;
export type DutySkipStatus = (typeof DUTY_SKIP_STATUSES)[number];

export const DUTY_LIMITS = {
  name: 160,
  description: 4000,
  owners: 20,
  /** Days into the next period */
  graceDays: 90,
  /** Reminder this many days before the period ends (0: none) */
  remindDays: 90,
  reason: 2000,
  /** Skips can be planned for periods that start within this many days */
  skipAheadDays: 400,
} as const;

/** The key of a period: 2026-W44, 2026-10, 2026-Q4, 2026-H2, 2026. */
export const DUTY_PERIOD_KEY_RE: Record<DutyInterval, RegExp> = {
  weekly: /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/,
  monthly: /^\d{4}-(0[1-9]|1[0-2])$/,
  quarterly: /^\d{4}-Q[1-4]$/,
  halfYearly: /^\d{4}-H[12]$/,
  yearly: /^\d{4}$/,
};

/** The run that made a period done or late (or, for a failed period, the last failed one). */
export interface DutyRunRef {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface DutySkip {
  id: string;
  dutyId: string;
  periodKey: string;
  periodStart: string;
  reason: string;
  status: DutySkipStatus;
  requestedBy: string;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  comment: string;
  /** The reader may approve or reject it (a second person: never the one who asked) */
  canDecide: boolean;
  /** Why the reader may not decide it (code for errors:codes.<code>), when they could otherwise */
  decideBlocked: string | null;
  canWithdraw: boolean;
}

export interface DutyPeriod {
  key: string;
  /** Local midnight of the first day, as an ISO timestamp */
  start: string;
  /** Local midnight after the last day (exclusive) */
  end: string;
  /** End of the grace period (= end without one) */
  graceEndsAt: string;
  status: DutyPeriodStatus;
  /** Stored for good: the period and its grace period have ended and the result no longer changes */
  closed: boolean;
  closedAt: string | null;
  /** The period has ended, the grace period has not */
  inGrace: boolean;
  /** Evidence: the run that counts (done, late) or the last failed one; null when the reader may not see the process */
  run: DutyRunRef | null;
  failedRuns: number;
  /** Runs started in the period that have not ended yet (waiting for a decision or a manual step, running) */
  runsInProgress: number;
  /** The approved skip or the one waiting for a second person */
  skip: DutySkip | null;
  /** What the period was judged against (frozen when it closed) */
  snapshot: { name: string; level: DutyLevel; interval: DutyInterval; graceDays: number; processName: string; timeZone: string };
}

export interface DutyScheduleRef {
  id: string;
  name: string;
  enabled: boolean;
  dryRun: boolean;
  nextRunAt: string | null;
}

export interface DutySummary {
  id: string;
  serviceId: string;
  serviceName: string;
  applicationId: string | null;
  applicationName: string | null;
  name: string;
  description: string;
  /** null when the reader may not see the process */
  processId: string | null;
  processName: string | null;
  processVisible: boolean;
  schedule: DutyScheduleRef | null;
  interval: DutyInterval;
  level: DutyLevel;
  graceDays: number;
  remindDays: number;
  owners: string[];
  archived: boolean;
  timeZone: string;
  current: DutyPeriod | null;
  previous: DutyPeriod | null;
  /** Skips waiting for a second person */
  pendingSkips: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  canEdit: boolean;
  canRequestSkip: boolean;
}

export interface DutyDetail extends DutySummary {
  /** Newest first: the open periods and the stored ones */
  periods: DutyPeriod[];
  skips: DutySkip[];
}

export interface DutyInput {
  serviceId: string;
  applicationId?: string | null;
  name: string;
  description?: string;
  processId: string;
  scheduleId?: string | null;
  interval: DutyInterval;
  level: DutyLevel;
  graceDays?: number;
  remindDays?: number;
  owners?: string[];
}
