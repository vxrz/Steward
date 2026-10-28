import { z, type ZodTypeAny } from 'zod';
import {
  CIA_DIMENSIONS,
  DUTY_LEVELS,
  DUTY_PERIOD_STATUSES,
  OBJECTIVE_BREACH_END_REASONS,
  OBJECTIVE_NO_DATA_REASONS,
  OBJECTIVE_STATUSES,
  OBJECTIVE_WINDOWS,
  REVIEW_STATUSES,
  SCORECARD_PART_STATUSES,
} from '@sm/shared';

/** Response and query schemas of the availability objective and scorecard endpoints of the public API (#86). */

const ts = () => z.string().datetime({ offset: true }).describe('ISO 8601 timestamp (UTC)');
const page = {
  limit: z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)'),
  cursor: z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)'),
};
const pct = () => z.number().nullable();
const perWindow = (desc: string) =>
  z.object({ h1: pct(), h24: pct(), d7: pct(), d30: pct() }).describe(`${desc} per window (1 h, 24 h, 7 d, 30 d) in percent; null: none`);
const partStatus = () =>
  z
    .enum(SCORECARD_PART_STATUSES)
    .describe('ok: everything that counts is met; attention: something that counts is not met; pending: still open or no data; none: nothing to judge');

const ObjectiveBreachEntry = z.object({
  id: z.string(),
  startedAt: ts(),
  endedAt: ts().nullable().describe('null: still below target'),
  endReason: z
    .enum(OBJECTIVE_BREACH_END_REASONS)
    .nullable()
    .describe('recovered: every target met again; archived: ended because the objective was archived (not a recovery)'),
  windows: z.array(z.enum(OBJECTIVE_WINDOWS)).describe('The windows below target when the breach started'),
  notified: z.boolean(),
});

export const ObjectiveEntry = z.object({
  id: z.string(),
  serviceId: z.string(),
  serviceName: z.string(),
  applicationId: z.string().nullable(),
  applicationName: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  platformVisible: z.boolean().describe('The token owner may see the Gatus platform; otherwise platform and endpoint are null'),
  platformId: z.string().nullable(),
  platformName: z.string().nullable(),
  endpointKey: z.string().nullable().describe('The Gatus endpoint key (group_name)'),
  endpointName: z.string().nullable(),
  targets: perWindow('Targets'),
  windows: z
    .array(z.object({ window: z.enum(OBJECTIVE_WINDOWS), target: z.number(), value: pct(), status: z.enum(OBJECTIVE_STATUSES) }))
    .describe("The windows with a target: Gatus' current uptime and the status"),
  status: z.enum(OBJECTIVE_STATUSES).describe('below: a window is below target; noData: a window has no value; met: every target is reached'),
  noDataReason: z.enum(OBJECTIVE_NO_DATA_REASONS).nullable(),
  valuesAt: ts().nullable().describe("When Steward last read Gatus' uptime figures of the platform"),
  notify: z.boolean(),
  breach: ObjectiveBreachEntry.nullable().describe('The breach going on now'),
  noDataSince: ts().nullable().describe('No data: since when'),
  noDataTooLong: z.boolean().describe('No data for more than 24 hours: needs attention on the scorecard'),
  archived: z.boolean().describe('Archived objectives are not sampled and show the status of their last sample'),
  archivedAt: ts().nullable(),
  archivedBy: z.string().nullable(),
  createdAt: ts(),
  createdBy: z.string(),
  updatedAt: ts(),
  updatedBy: z.string(),
});

export const ObjectiveSampleEntry = z.object({
  at: ts().describe('Start of the hour (UTC)'),
  values: perWindow("Gatus' uptime"),
  status: z.enum(OBJECTIVE_STATUSES),
});

const DutyCounts = z.object({ total: z.number().int(), met: z.number().int(), open: z.number().int(), notMet: z.number().int() });

export const ScorecardServiceEntry = z.object({
  serviceId: z.string(),
  serviceName: z.string(),
  owners: z.array(z.string()),
  criticality: z.string().nullable(),
  attention: z.boolean().describe('Any part needs attention'),
  duties: z.object({
    status: partStatus().describe('From the mandatory duties: attention when one was not met in its last closed period or now'),
    mandatory: DutyCounts,
    recommended: DutyCounts.extend({ status: partStatus() }).describe('Shown separately; never sets attention'),
    optional: z.object({ total: z.number().int() }),
    archivedThisPeriod: z.number().int(),
    items: z.array(
      z.object({
        dutyId: z.string(),
        name: z.string(),
        level: z.enum(DUTY_LEVELS),
        applicationName: z.string().nullable(),
        archivedAt: ts().nullable().describe('Archived during its current period: it counts until that period ends'),
        lastClosed: z.object({ key: z.string(), status: z.enum(DUTY_PERIOD_STATUSES) }).nullable(),
        current: z.object({ key: z.string(), status: z.enum(DUTY_PERIOD_STATUSES) }).nullable(),
        result: z.enum(['met', 'open', 'notMet']),
      }),
    ),
  }),
  availability: z.object({
    status: partStatus(),
    total: z.number().int(),
    met: z.number().int(),
    below: z.number().int(),
    noData: z.number().int(),
    noDataTooLong: z.number().int().describe('Objectives without data for more than 24 hours (attention)'),
    objectives: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        status: z.enum(OBJECTIVE_STATUSES),
        applicationName: z.string().nullable(),
        source: z.string().nullable().describe('"platform · endpoint"; null when the token owner may not see the platform'),
        noDataReason: z.enum(OBJECTIVE_NO_DATA_REASONS).nullable(),
        noDataTooLong: z.boolean(),
        archivedAt: ts().nullable().describe('Archived recently: counts with its last status until its longest window has passed'),
      }),
    ),
  }),
  documentation: z.object({
    status: partStatus().describe('attention: no released document, a review overdue, or an expected document missing'),
    documents: z.number().int(),
    released: z.number().int(),
    overdue: z.number().int(),
    dueSoon: z.number().int(),
    missing: z.number().int(),
    list: z.array(
      z.object({ id: z.string(), number: z.string(), title: z.string(), typeKey: z.string(), released: z.boolean(), reviewStatus: z.enum(REVIEW_STATUSES) }),
    ),
    expected: z.array(
      z.object({
        ruleId: z.string(),
        typeKey: z.string(),
        typeName: z.string(),
        dimension: z.enum(CIA_DIMENSIONS),
        minLevel: z.string(),
        applicationId: z.string(),
        applicationName: z.string(),
        level: z.string(),
        satisfiedBy: z.array(z.object({ id: z.string(), number: z.string(), title: z.string() })),
      }),
    ),
  }),
  protection: z.object({
    status: partStatus().describe('attention: not rated (no applications, a dimension without a level, members not rated or not counted, invalid scale)'),
    applications: z.number().int(),
    scaleInvalid: z.boolean(),
    dimensions: z.array(
      z.object({
        dimension: z.enum(CIA_DIMENSIONS),
        effective: z.string().nullable(),
        ok: z.boolean(),
        rated: z.number().int(),
        total: z.number().int(),
        needsRerating: z.number().int(),
        override: z.boolean(),
      }),
    ),
  }),
  lifecycle: z
    .object({
      status: partStatus().describe(
        'attention: a component past its end of life; pending: one within the warning period; none: not counted (turned off) or no tech stack',
      ),
      enabled: z.boolean().describe('The part is counted (Applications → End of life → Count on the scorecard)'),
      entries: z.number().int().describe('Tech stack entries of the service’s applications'),
      eol: z.number().int(),
      ending: z.number().int(),
      items: z.array(
        z.object({
          applicationId: z.string(),
          applicationName: z.string(),
          componentName: z.string(),
          product: z.string(),
          label: z.string(),
          version: z.string(),
          cycle: z.string().nullable(),
          eolFrom: z.string().nullable().describe('YYYY-MM-DD'),
          state: z.enum(['ending', 'eol']),
        }),
      ),
    })
    .describe('Tech stack: end of life of the components of the service’s applications (from endoflife.date)'),
});

const PartCounts = z.object({ ok: z.number().int(), attention: z.number().int(), pending: z.number().int(), none: z.number().int() });
const RollupGroup = z.object({
  owner: z.string().nullable().describe('user:<name> or team:<name>; null: overall, or the services without owners (key "none")'),
  key: z.string(),
  services: z.number().int(),
  attention: z.number().int(),
  parts: z.object({ duties: PartCounts, availability: PartCounts, documentation: PartCounts, protection: PartCounts, lifecycle: PartCounts }),
});

export const ScorecardEntry = z.object({
  generatedAt: ts(),
  services: z.array(ScorecardServiceEntry),
  rollup: z.object({ overall: RollupGroup, owners: z.array(RollupGroup) }),
});

const HistoryPart = z.enum([...SCORECARD_PART_STATUSES, 'hidden']);
const TrendCounts = PartCounts.extend({ hidden: z.number().int().describe('Relied on documents the token owner may not read') });
export const ScorecardTrendEntry = z.object({
  day: z.string().describe('Local day (instance time zone), YYYY-MM-DD'),
  services: z.number().int(),
  attention: z.number().int(),
  parts: z.object({ duties: TrendCounts, availability: TrendCounts, documentation: TrendCounts, protection: TrendCounts, lifecycle: TrendCounts }),
});

export const ServiceScorecardEntry = ScorecardServiceEntry.extend({
  history: z
    .array(
      z.object({
        day: z.string(),
        attention: z.boolean(),
        parts: z.object({ duties: HistoryPart, availability: HistoryPart, documentation: HistoryPart, protection: HistoryPart, lifecycle: HistoryPart }),
      }),
    )
    .describe('The stored daily snapshots of the last 90 days, oldest first'),
});

export const SCORECARD_COMPONENTS: Record<string, ZodTypeAny> = {
  ObjectiveEntry,
  ObjectiveSampleEntry,
  ScorecardServiceEntry,
  ScorecardEntry,
  ScorecardTrendEntry,
  ServiceScorecardEntry,
};

export const ObjectiveListQuery = z.object({
  ...page,
  archived: z.enum(['exclude', 'include', 'only']).default('exclude').describe('Archived objectives: left out (default), included, or only these'),
  serviceId: z.string().max(200).optional(),
  applicationId: z.string().max(200).optional(),
  status: z.enum(OBJECTIVE_STATUSES).optional(),
});

export const ObjectiveSamplesQuery = z.object({
  ...page,
  from: ts().optional().describe('Samples from this time'),
  to: ts().optional().describe('Samples before this time'),
});

export const ScorecardTrendQuery = z.object({
  days: z.number().int().min(1).max(730).default(90).describe('Days back (default 90)'),
  owner: z.string().max(130).optional().describe('Only the services this owner had on each day (user:<name>, team:<name>, or none)'),
});
