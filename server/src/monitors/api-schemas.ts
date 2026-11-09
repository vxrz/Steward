import { z, type ZodTypeAny } from 'zod';
import { CHECK_TYPES, MONITOR_STATUSES, QUERY_LIST_MAX } from '@sm/shared';

/** Response and query schemas of the monitor endpoints of the public API (/api/v1/monitors…). */

const ts = () => z.string().datetime({ offset: true }).describe('ISO 8601 timestamp (UTC)');
const status = () => z.enum(MONITOR_STATUSES);
const statusCode = () => z.number().int().describe('0 up, 1 degraded, 2 down, 3 unknown, 4 blocked, 5 maintenance');

const CauseRef = z.object({
  monitorId: z.string(),
  monitorKey: z.string(),
  monitorName: z.string(),
  checkId: z.string(),
  checkName: z.string(),
  hidden: z.boolean().optional().describe('A monitor you may not view (id, key and names are empty)'),
});
const Uptime = z
  .object({ h24: z.number().nullable(), d7: z.number().nullable(), d30: z.number().nullable() })
  .describe('Uptime in percent over 24 hours, 7 and 30 days (null without data); down vs. up/degraded, other time does not count');

export const Monitor = z.object({
  id: z.string(),
  key: z.string().describe('Stable key, e.g. machine-17-powermeter (used in item keys, LLD and Prometheus labels)'),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  owner: z.string(),
  enabled: z.boolean(),
  status: status(),
  statusCode: statusCode(),
  since: ts().nullable().describe('When the status last changed'),
  rootCauses: z.array(CauseRef).describe('Failing checks that explain the status (sub-monitor nodes are expanded)'),
  checkCount: z.number().int(),
  counts: z.record(z.string(), z.number().int()).describe('Checks per status'),
  uptime: Uptime,
  maintenance: z.object({ startsAt: ts(), endsAt: ts(), reason: z.string() }).nullable().describe('The active maintenance window'),
  acknowledged: z.object({ by: z.string(), at: ts(), comment: z.string() }).nullable(),
  templateId: z.string().nullable(),
  updatedAt: ts(),
  lastEvaluatedAt: ts().nullable(),
});

const Figures = z.object({ median: z.number(), p95: z.number(), max: z.number() }).describe('Seconds: median, 95th percentile (nearest rank), maximum');
const ObservedDelayVariable = z.object({
  name: z.string().describe("The variable ('' for an API source with one timestamp)"),
  samples: z.number().int(),
  coverageSeconds: z.number().describe("From the first sample's start to the last sample's end"),
  peakAge: Figures.nullable().describe('Upper bounds of how old the newest value became before a newer one was readable'),
  delay: z
    .object({ low: z.number(), high: z.number() })
    .nullable()
    .describe('Delay of new values after their timestamp: median of the lower and of the upper bounds (seconds)'),
});
const ObservedDelay = z
  .object({
    windowDays: z.number().int(),
    since: ts().describe('Start of this series (first read, or the source changed)'),
    intervalSeconds: z.number().describe('The check interval: the resolution of every figure'),
    worst: ObservedDelayVariable.nullable().describe('The variable with the highest 95th percentile peak age'),
    variables: z.array(ObservedDelayVariable),
    excluded: z
      .object({ failedReads: z.number().int(), wentBackwards: z.number().int(), futureTimestamps: z.number().int(), maintenance: z.number().int() })
      .describe('Reads and samples that were not used'),
    enough: z.boolean().describe('At least 24 hours and 20 samples (worst variable): a suggestion is made'),
    suggestion: z
      .object({
        changes: z.array(
          z.object({ field: z.enum(['allowedDelaySeconds', 'maxAgeSeconds', 'degradedAgeSeconds']), from: z.number().nullable(), to: z.number().nullable() }),
        ),
        basedOnSeconds: z.number().describe('95th percentile peak age (upper bounds) of the worst variable'),
        marginSeconds: z.number().describe('One check interval'),
      })
      .nullable(),
  })
  .describe('Freshness checks (0.13): the peak age and delay observed over the last 7 days (docs/MONITORS.md, "How fresh is fresh")');

export const MonitorCheckStatus = z.object({
  checkId: z.string(),
  key: z.string().describe('Check key (heartbeat key for gateway reports)'),
  name: z.string(),
  type: z.enum(CHECK_TYPES),
  critical: z.boolean(),
  enabled: z.boolean(),
  status: status(),
  statusCode: statusCode(),
  since: ts().nullable(),
  lastCheckedAt: ts().nullable(),
  lastOkAt: ts().nullable(),
  message: z.string().nullable().describe('Message of the latest result'),
  durationMs: z.number().nullable(),
  causedBy: z.array(CauseRef).describe('Failing parents that likely cause this check to fail'),
  note: z.string().nullable(),
  uptime: Uptime,
  observedDelay: ObservedDelay.nullable().optional(),
});

export const MonitorStatusReport = Monitor.extend({
  checks: z.array(MonitorCheckStatus),
  time: ts().describe('Server time of this answer'),
});

export const MonitorDetail = Monitor.extend({
  definition: z.record(z.string(), z.unknown()).describe('Definition: checks, links, outputs (no secrets)'),
});

export const MonitorHistoryEntry = z.object({
  id: z.string(),
  ts: ts(),
  checkId: z.string().nullable().describe('null: the monitor itself'),
  status: status(),
  previous: status().nullable(),
  message: z.string(),
  causedBy: z.array(CauseRef),
});

export const MonitorDiscovery = z
  .object({
    data: z
      .array(z.record(z.string(), z.string()))
      .describe('One object per check (or monitor) with {#MONITOR}, {#MONITORNAME}, {#CHECK}, {#CHECKNAME}, {#CHECKTYPE}, {#CHECKKEY}'),
  })
  .describe('Zabbix low-level discovery (LLD) format');

export const MONITOR_COMPONENTS: Record<string, ZodTypeAny> = {
  Monitor,
  MonitorDetail,
  MonitorCheckStatus,
  MonitorStatusReport,
  MonitorHistoryEntry,
  MonitorDiscovery,
};

const limit = z.number().int().min(1).max(200).default(50).describe('Page size (1–200, default 50)');
const cursor = z.string().max(2000).optional().describe('Cursor from the previous page (`nextCursor`)');

export const MonitorListQuery = z.object({
  limit,
  cursor,
  status: z.array(status()).max(QUERY_LIST_MAX).optional().describe('Only monitors with these statuses (repeat the parameter)'),
  tag: z.string().max(161).optional(),
  q: z.string().max(200).optional().describe('Case-insensitive search in key and name'),
});

export const MonitorDiscoveryQuery = z.object({
  level: z.enum(['checks', 'monitors']).default('checks').describe('checks: one entry per check; monitors: one per monitor'),
  tag: z.string().max(161).optional(),
});

export const MonitorHistoryQuery = z.object({
  limit,
  cursor,
  check: z.string().max(100).optional().describe('Only this check id; "" (empty) = the monitor itself'),
});
