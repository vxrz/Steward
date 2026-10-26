import type { CiaDimension } from './catalogue.js';
import type { DutyLevel, DutyPeriodStatus } from './duties.js';
import type { ReviewStatus, ServiceCriticality } from './records.js';

/**
 * Availability objectives and the service scorecard (#86).
 *
 * An availability objective names one Gatus endpoint and targets for the windows Gatus reports (1 h, 24 h, 7 d,
 * 30 d; each optional). The values are Gatus' own uptime figures, which Steward reads once an hour when a Gatus
 * platform's metrics mode has "read Gatus' uptime figures" on – no service hours, no calculation of its own.
 *
 * The scorecard shows, per service, four parts side by side – duties, availability, documentation, protection need –
 * each with its own status. There is no weighting: "attention needed" when any part needs attention.
 */

/** The windows of Gatus' uptime API (/api/v1/endpoints/{key}/uptimes/{1h|24h|7d|30d}). */
export const OBJECTIVE_WINDOWS = ['h1', 'h24', 'd7', 'd30'] as const;
export type ObjectiveWindow = (typeof OBJECTIVE_WINDOWS)[number];

/** met: every target with a value is reached; below: a value is below its target; noData: no value to judge. */
export const OBJECTIVE_STATUSES = ['met', 'below', 'noData'] as const;
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

/**
 * Why an objective has no data: the platform has no metrics source (or it is off), Gatus' uptime figures are not
 * read, the figures are older than OBJECTIVE_LIMITS.staleHours, Gatus does not report the endpoint (any more), or it
 * reported no value for the window.
 */
export const OBJECTIVE_NO_DATA_REASONS = ['noSource', 'uptimesOff', 'stale', 'noEndpoint', 'noValue'] as const;
export type ObjectiveNoDataReason = (typeof OBJECTIVE_NO_DATA_REASONS)[number];

export const OBJECTIVE_LIMITS = {
  name: 160,
  description: 2000,
  /** Objectives per service */
  perService: 100,
  /** Gatus' figures are read hourly; older ones count as "no data" */
  staleHours: 3,
  /** Hourly samples are kept this long */
  sampleRetentionDays: 90,
  /** Ended breaches are kept this long */
  breachRetentionDays: 400,
  /** "No data" for longer than this needs attention on the scorecard (a source turned off, an endpoint gone) */
  noDataAttentionHours: 24,
  /** No second breach message for the same objective within this time (the breaches are still recorded) */
  breachMessageCooldownHours: 24,
} as const;

/** Milliseconds of each window: an archived objective counts on the scorecard until its longest window has passed. */
export const OBJECTIVE_WINDOW_MS: Record<ObjectiveWindow, number> = { h1: 3600000, h24: 86400000, d7: 7 * 86400000, d30: 30 * 86400000 };

export const SCORECARD_LIMITS = {
  /** Daily scorecard snapshots are kept this long */
  snapshotRetentionDays: 730,
  /** Expected-document rules */
  rules: 100,
  note: 500,
} as const;

export type ObjectiveTargets = Record<ObjectiveWindow, number | null>;
export type ObjectiveValues = Record<ObjectiveWindow, number | null>;

export interface ObjectiveWindowState {
  window: ObjectiveWindow;
  /** Target in percent */
  target: number;
  /** Gatus' uptime in percent (null: no data) */
  value: number | null;
  status: ObjectiveStatus;
}

export interface ObjectiveBreach {
  id: string;
  startedAt: string;
  /** null: still below target */
  endedAt: string | null;
  /** The windows below target when the breach started */
  windows: ObjectiveWindow[];
  notified: boolean;
}

export interface ObjectiveSummary {
  id: string;
  serviceId: string;
  serviceName: string;
  applicationId: string | null;
  applicationName: string | null;
  name: string;
  description: string;
  /**
   * The reader may see the Gatus platform. Readers who may not see it get the status and the values, but no
   * platform, endpoint key or endpoint name (as duties hide the names of processes the reader may not view).
   */
  platformVisible: boolean;
  platformId: string | null;
  platformName: string | null;
  endpointKey: string | null;
  endpointName: string | null;
  targets: ObjectiveTargets;
  /** The windows with a target, in window order */
  windows: ObjectiveWindowState[];
  status: ObjectiveStatus;
  noDataReason: ObjectiveNoDataReason | null;
  /** When Steward last read Gatus' figures for the platform */
  valuesAt: string | null;
  /** Send a message when the objective falls below target (once per breach) */
  notify: boolean;
  /** The breach going on now */
  breach: ObjectiveBreach | null;
  /** No data: since when (the hour after the last sample with data, or when the objective was defined) */
  noDataSince: string | null;
  /** No data for longer than OBJECTIVE_LIMITS.noDataAttentionHours: needs attention on the scorecard */
  noDataTooLong: boolean;
  /** Archived objectives are not sampled; they show the status of their last sample */
  archived: boolean;
  archivedAt: string | null;
  archivedBy: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  canEdit: boolean;
}

/** One hourly sample: the values Steward had read from Gatus at that hour. */
export interface ObjectiveSample {
  /** Start of the hour (UTC) */
  at: string;
  values: ObjectiveValues;
  status: ObjectiveStatus;
}

export interface ObjectiveDetail extends ObjectiveSummary {
  /** Newest first, at most OBJECTIVE_LIMITS.sampleRetentionDays */
  samples: ObjectiveSample[];
  /** Newest first */
  breaches: ObjectiveBreach[];
}

// ---------- scorecard ----------

export const SCORECARD_PARTS = ['duties', 'availability', 'documentation', 'protection'] as const;
export type ScorecardPart = (typeof SCORECARD_PARTS)[number];

/**
 * ok: everything that counts is met; attention: something that counts is not met (sets "attention needed");
 * pending: nothing failed, but something is still open or has no data; none: nothing to judge.
 */
export const SCORECARD_PART_STATUSES = ['ok', 'attention', 'pending', 'none'] as const;
export type ScorecardPartStatus = (typeof SCORECARD_PART_STATUSES)[number];

/** met: done, late or skipped; open: the current period is still due; notMet: missed or failed. */
export type ScorecardDutyResult = 'met' | 'open' | 'notMet';

export interface ScorecardDutyItem {
  dutyId: string;
  name: string;
  level: DutyLevel;
  applicationName: string | null;
  /** Archived during its current period: it still counts until that period ends, with its last status */
  archivedAt: string | null;
  /** The newest stored (closed) period */
  lastClosed: { key: string; status: DutyPeriodStatus } | null;
  /** The period running now (stored state; due when nothing is stored for it) */
  current: { key: string; status: DutyPeriodStatus } | null;
  result: ScorecardDutyResult;
}

export interface ScorecardDutyCounts {
  total: number;
  met: number;
  open: number;
  notMet: number;
}

export interface ScorecardDuties {
  /** From the mandatory duties: attention when one was not met in its last closed period or now */
  status: ScorecardPartStatus;
  mandatory: ScorecardDutyCounts;
  /** Shown separately; never sets "attention needed" */
  recommended: ScorecardDutyCounts & { status: ScorecardPartStatus };
  /** Shown only */
  optional: { total: number };
  /** Duties archived during their current period (they still count until it ends) */
  archivedThisPeriod: number;
  items: ScorecardDutyItem[];
}

export interface ScorecardObjectiveItem {
  id: string;
  name: string;
  status: ObjectiveStatus;
  applicationName: string | null;
  /** "platform · endpoint" when the reader may see the platform; null: hidden */
  source: string | null;
  noDataReason: ObjectiveNoDataReason | null;
  /** No data for longer than OBJECTIVE_LIMITS.noDataAttentionHours (needs attention) */
  noDataTooLong: boolean;
  /** Archived recently: it counts with the status of its last sample until its longest window has passed */
  archivedAt: string | null;
}

export interface ScorecardAvailability {
  /** attention: an objective below target or without data for more than a day; pending: no data for a shorter time */
  status: ScorecardPartStatus;
  total: number;
  met: number;
  below: number;
  noData: number;
  /** Of those without data: for more than OBJECTIVE_LIMITS.noDataAttentionHours */
  noDataTooLong: number;
  objectives: ScorecardObjectiveItem[];
}

export interface ScorecardDocumentRef {
  id: string;
  number: string;
  title: string;
  typeKey: string;
  /** An approved edition exists and the document is not withdrawn */
  released: boolean;
  reviewStatus: ReviewStatus;
}

/** A document type an application is expected to have by a rule on its CIA rating. */
export interface ScorecardExpectedDocument {
  ruleId: string;
  typeKey: string;
  typeName: string;
  dimension: CiaDimension;
  minLevel: string;
  applicationId: string;
  applicationName: string;
  /** The application's rating of the dimension */
  level: string;
  /** Released documents of the type that apply to the application (or to the whole service) */
  satisfiedBy: { id: string; number: string; title: string }[];
}

export interface ScorecardDocumentation {
  /** attention: no released document, a review overdue or an expected document missing */
  status: ScorecardPartStatus;
  documents: number;
  released: number;
  overdue: number;
  dueSoon: number;
  /** Expected documents (rules) that are missing */
  missing: number;
  list: ScorecardDocumentRef[];
  expected: ScorecardExpectedDocument[];
}

export interface ScorecardProtectionDimension {
  dimension: CiaDimension;
  effective: string | null;
  /** Rated: an effective level, and every application counted (or an override) */
  ok: boolean;
  rated: number;
  total: number;
  needsRerating: number;
  override: boolean;
}

export interface ScorecardProtection {
  /** attention: not rated – no applications, a dimension without a level, members not rated or not counted, or the scale is not valid */
  status: ScorecardPartStatus;
  applications: number;
  scaleInvalid: boolean;
  dimensions: ScorecardProtectionDimension[];
}

export interface ServiceScorecard {
  serviceId: string;
  serviceName: string;
  owners: string[];
  criticality: ServiceCriticality | null;
  /** Any part needs attention */
  attention: boolean;
  duties: ScorecardDuties;
  availability: ScorecardAvailability;
  documentation: ScorecardDocumentation;
  protection: ScorecardProtection;
}

export type ScorecardPartCounts = Record<ScorecardPartStatus, number>;

export interface ScorecardRollupGroup {
  /** Owner subject (user:<name>, team:<name>); null: overall, or services without owners (key "none") */
  owner: string | null;
  key: string;
  services: number;
  attention: number;
  parts: Record<ScorecardPart, ScorecardPartCounts>;
}

export interface ScorecardOverview {
  generatedAt: string;
  services: ServiceScorecard[];
  rollup: { overall: ScorecardRollupGroup; owners: ScorecardRollupGroup[] };
}

/** One day of the stored scorecard snapshots (rollup over the services of that day). */
export interface ScorecardTrendPoint {
  day: string;
  services: number;
  attention: number;
  /** Per part; "hidden" counts the services whose part relied on documents the reader may not read */
  parts: Record<ScorecardPart, ScorecardPartCounts & { hidden: number }>;
}

export interface ServiceScorecardHistoryPoint {
  day: string;
  attention: boolean;
  parts: Record<ScorecardPart, ScorecardPartStatus | 'hidden'>;
}

export interface ServiceScorecardDetail extends ServiceScorecard {
  history: ServiceScorecardHistoryPoint[];
}

/** An expected-document rule: applications rated at least `minLevel` in `dimension` should have a document of the type. */
export interface ScorecardRule {
  id: string;
  typeId: string;
  typeKey: string | null;
  typeName: string | null;
  dimension: CiaDimension;
  minLevel: string;
  enabled: boolean;
  note: string;
  /** The record type is a document type and the level is on the dimension's scale; otherwise the rule is not applied */
  valid: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}
