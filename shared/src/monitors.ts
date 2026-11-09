import { PV_FINDING_KINDS } from './pvault.js';
/**
 * Monitors: composable, dependency-aware health checks.
 *
 * A monitor is a small directed graph of checks. Every check runs on its own
 * interval; links never stop a check from running (unless `mode: hard`), they
 * are used to infer root causes and to suppress follow-up alerts.
 */
import { notifyPolicySchema } from './notifyPolicy.js';
import { quietHoursSchema } from './quietHours.js';
import { z } from 'zod';
import type { AclEntry } from './api.js';
import { boundedRecord } from './zodLimits.js';
import { DB_LIMITS } from './database.js';
import { tagInput } from './tags.js';
import type { ObservedDelay } from './freshnessDelay.js';
import type { MonitorStateInfo } from './monitorStates.js';
import { AWS_REGION_RE } from './aws.js';
import { PAGE_WATCH_LIMITS, PAGE_WATCH_UUID_RE } from './changedetection.js';
import { COST_CHECK_PERIODS, COST_SCOPES, currencyCode, toMicros } from './costs.js';

// ---------- statuses ----------

/** `off` (0.13, ADR 0021): a monitor or check in a state with status off, every check agreeing – never an alert. */
export const MONITOR_STATUSES = ['up', 'degraded', 'down', 'unknown', 'blocked', 'maintenance', 'off'] as const;
export type MonitorStatus = (typeof MONITOR_STATUSES)[number];

/** Numeric codes used by Prometheus, Zabbix and other number-only consumers (codes 0–5 never move; off is 6). */
export const MONITOR_STATUS_CODE: Record<MonitorStatus, number> = { up: 0, degraded: 1, down: 2, unknown: 3, blocked: 4, maintenance: 5, off: 6 };

export const MONITOR_STATUS_INFO: Record<MonitorStatus, string> = {
  up: 'Healthy',
  degraded: 'Warning threshold reached',
  down: 'Failing',
  unknown: 'No data yet, or the check itself could not run',
  blocked: 'Not evaluated because a hard dependency is down',
  maintenance: 'In a maintenance window – alerts are silenced',
  off: 'Off – all checks agree with an expected state (no alert)',
};

/**
 * Ranking used to aggregate statuses ("worst" wins). `off` ranks below `up`: a monitor whose sub-monitor is off is up,
 * and off only when all its checks are (ADR 0021).
 */
const RANK: Record<MonitorStatus, number> = { off: -1, up: 0, maintenance: 1, blocked: 2, unknown: 3, degraded: 4, down: 5 };
export function worstStatus(list: MonitorStatus[]): MonitorStatus {
  if (!list.length) return 'unknown';
  return list.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
}
export const isProblem = (s: MonitorStatus | undefined): boolean => s === 'down' || s === 'degraded' || s === 'unknown';

// ---------- definitions ----------

export const CHECK_TYPES = [
  'ping',
  'tcp',
  'http',
  'platform',
  'freshness',
  'heartbeat',
  'gatus',
  'checkmk',
  'prometheus',
  'kubernetes',
  'git',
  'kafka',
  'kafka-connect',
  'mqtt',
  'snowflake',
  'database',
  'dynamodb',
  'db-schema',
  'cost',
  'data-contract',
  'dependency-track',
  'version-behind',
  'entra',
  'privilege-vault',
  'page-watch',
  'monitor',
] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

export const LINK_MODES = ['soft', 'hard'] as const;
export type LinkMode = (typeof LINK_MODES)[number];
export const AGGREGATE_RULES = ['worst', 'critical', 'quorum'] as const;
export const FRESHNESS_MODES = ['cadence', 'maxAge'] as const;
export const HEARTBEAT_AUTH_MODES = ['token', 'hmac', 'either'] as const;
export const OUTPUT_TYPES = ['notification', 'webhook', 'gatus', 'zabbix', 'process'] as const;
/** Gatus outputs while a monitor is off (ADR 0021): success (default), failure, or send nothing */
export const GATUS_WHILE_OFF = ['success', 'failure', 'skip'] as const;
export type OutputType = (typeof OUTPUT_TYPES)[number];
export const MONITOR_PERMISSIONS = ['view', 'acknowledge', 'edit', 'manage'] as const;
export type MonitorPermission = (typeof MONITOR_PERMISSIONS)[number];

/** Largest heartbeat request body (bytes), same as webhook triggers. */
export const HEARTBEAT_MAX_BODY_BYTES = 64 * 1024;
/** Most entries in one gateway batch call. */
export const HEARTBEAT_MAX_BATCH = 500;

export const CHECK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
export const MONITOR_KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const CHECK_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
/** Monitor keys that would collide with fixed API paths. */
export const RESERVED_MONITOR_KEYS = ['discovery', 'status', 'templates', 'gateways', 'wall', 'import', 'examples', 'new', 'meta', 'validate'];

const HOST_RE = /^(?!-)[A-Za-z0-9._:%[\]-]{1,253}$/;
const host = z.string().trim().regex(HOST_RE, 'enter a host name or IP address');
const expr = z.string().max(4000);
const seconds = (min: number, max: number) => z.number().int().min(min).max(max);

const checkBase = {
  id: z.string().regex(CHECK_ID_RE, 'letters, digits, _ and - (max. 48)'),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
  /** Stable key for gateway batch reports and integrations (default: <monitor key>.<check id>). */
  key: z.string().regex(CHECK_KEY_RE, 'letters, digits and _ . : / - (max. 128)').optional(),
  enabled: z.boolean().optional(),
  intervalSeconds: seconds(5, 86400).optional(),
  timeoutSeconds: seconds(1, 300).optional(),
  /** false: a failure only degrades the monitor (rule "critical"). Default true. */
  critical: z.boolean().optional(),
  failuresBeforeDown: seconds(1, 20).optional(),
  successesBeforeUp: seconds(1, 20).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  /**
   * Checks on a platform: the identity it reads with (0.13.0, ADR 0009) – its id or name; missing: the platform's
   * default identity. The monitor's owner must be allowed to use it.
   */
  identity: z.string().trim().min(1).max(200).optional(),
};

const freshnessLimits = {
  /** cadence: the source delivers data every N seconds */
  expectedIntervalSeconds: seconds(1, 7 * 86400).optional(),
  /** cadence: degraded after this many missed intervals (default 2) */
  degradedAfterMissed: seconds(1, 1000).optional(),
  /** cadence: down after this many missed intervals (default 4) */
  downAfterMissed: seconds(1, 1000).optional(),
  /** maxAge (on-change data): down when the newest value is older */
  maxAgeSeconds: seconds(1, 365 * 86400).optional(),
  /** maxAge: degraded when the newest value is older (optional) */
  degradedAgeSeconds: seconds(1, 365 * 86400).optional(),
  /**
   * Both modes (0.13): the data may arrive this much later than its timestamp (upload cycle, ingestion) – maxAge: down
   * after maxAgeSeconds + this; cadence: missed intervals count from the age minus this. Default 0.
   */
  allowedDelaySeconds: seconds(0, 86400).optional(),
};
const freshnessFields = { mode: z.enum(FRESHNESS_MODES).default('cadence'), ...freshnessLimits };

// ---------- requests of checks (#233) ----------

/** HTTP header names (RFC 9110 token) */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
/** Headers a check may not set: they belong to the connection or the platform's signing */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'te',
  'upgrade',
  'trailer',
  'keep-alive',
  'proxy-authorization',
]);
const MAX_BODY_CHARS = 65536;
const bodyChars = (b: unknown): number => (b === undefined || b === null ? 0 : typeof b === 'string' ? b.length : (JSON.stringify(b) ?? '').length);
/** Request headers of a check: valid names, none the connection sets – checked wherever a check is parsed (save, import, Check now) */
const requestHeaders = boundedRecord(z.string().max(2000), 100).superRefine((h, ctx) => {
  for (const name of Object.keys(h ?? {})) {
    if (!HEADER_NAME_RE.test(name)) ctx.addIssue({ code: 'custom', message: `"${name.slice(0, 40)}" is not a valid header name` });
    else if (RESERVED_HEADERS.has(name.toLowerCase())) ctx.addIssue({ code: 'custom', message: `the header ${name} is set by the connection` });
  }
});

// ---------- DynamoDB (#233) ----------

export const DYNAMODB_MODES = ['newestItem', 'writeActivity', 'hygiene'] as const;
export type DynamoDbMode = (typeof DYNAMODB_MODES)[number];
/** How the time attribute is read: auto (a number is epoch seconds below 1e11, else milliseconds; a string is ISO 8601 or a number) */
export const DYNAMODB_TIME_FORMATS = ['auto', 'iso8601', 'epochSeconds', 'epochMillis'] as const;
export const DYNAMODB_REQUIREMENTS = ['required', 'report'] as const;
export const DYNAMODB_LIMITS = {
  /** Partition key values per check: one Query each */
  partitionValues: 20,
  /** Characters of a partition key value */
  valueChars: 1024,
} as const;
/** Table and index names (DynamoDB naming rules): 3–255 of a-z A-Z 0-9 _ - . */
export const DYNAMODB_NAME_RE = /^[A-Za-z0-9_.-]{3,255}$/;

/** platform: id or name of a configured platform (names are resolved to ids when saving). */
const platformRef = z.string().trim().min(1).max(200);

export const checkSchema = z.discriminatedUnion('type', [
  z.object({
    ...checkBase,
    type: z.literal('ping'),
    host,
    /** Used when ICMP is not available: a TCP connect (a refused connection also proves the host answers). Default 80. */
    fallbackPort: z.number().int().min(1).max(65535).optional(),
    degradedRttMs: z.number().int().min(1).optional(),
  }),
  z.object({ ...checkBase, type: z.literal('tcp'), host, port: z.number().int().min(1).max(65535), degradedMs: z.number().int().min(1).optional() }),
  z.object({
    ...checkBase,
    type: z.literal('http'),
    url: z
      .string()
      .url()
      .refine((u) => /^https?:\/\//i.test(u), 'http(s) URLs only'),
    method: z.enum(['GET', 'HEAD', 'POST']).default('GET'),
    headers: boundedRecord(z.string().max(2000), 100).optional(),
    body: z.string().max(65536).optional(),
    /** e.g. "200", "200-299", "200,204,301-308" (default 200-399) */
    expectStatus: z.string().max(200).optional(),
    /** JSONata over { status, headers, body, durationMs }; false = down */
    condition: expr.optional(),
    degradedResponseMs: z.number().int().min(1).optional(),
    /** HTTPS: degraded when the certificate expires within this many days (default 14, 0 = off) */
    tlsExpiryWarnDays: z.number().int().min(0).max(365).optional(),
    insecureTls: z.boolean().optional(),
    /** Use HTTPS_PROXY/NO_PROXY from the environment (default true) */
    useProxy: z.boolean().optional(),
  }),
  z.object({
    ...checkBase,
    type: z.literal('platform'),
    platform: platformRef,
    method: z.enum(['GET', 'HEAD', 'POST']).default('GET'),
    path: z.string().min(1).max(2000),
    query: boundedRecord(z.string().max(2000), 100).optional(),
    headers: boundedRecord(z.string().max(2000), 100).optional(),
    body: z.unknown().optional(),
    /** JSONata over { status, headers, body, durationMs }; default: 2xx */
    condition: expr.optional(),
    degradedResponseMs: z.number().int().min(1).optional(),
  }),
  z.object({
    ...checkBase,
    type: z.literal('freshness'),
    /** insightsHub: IoT Time Series of an asset/aspect; platform: any API call + JSONata timestamp */
    source: z.enum(['insightsHub', 'platform']).default('insightsHub'),
    platform: platformRef,
    assetId: z.string().max(200).optional(),
    aspect: z.string().max(200).optional(),
    variables: z.array(z.string().min(1).max(200)).max(50).optional(),
    path: z.string().max(2000).optional(),
    query: boundedRecord(z.string().max(2000), 100).optional(),
    /** platform source: GET (default) or POST – POST only for APIs that read with it (search, GraphQL, JSON RPC) */
    method: z.enum(['GET', 'POST']).optional(),
    /** platform source: extra request headers (the platform's own authentication is added as usual) */
    headers: requestHeaders.optional(),
    /** platform source, POST: the request body (JSON, or a string sent as it is) */
    body: z
      .unknown()
      .refine((b) => bodyChars(b) <= MAX_BODY_CHARS, `the body may have at most ${MAX_BODY_CHARS} characters`)
      .optional(),
    /** platform source: JSONata over the response body returning a timestamp (or a list – the newest counts) */
    timestamp: expr.optional(),
    ...freshnessFields,
  }),
  z.object({
    ...checkBase,
    type: z.literal('heartbeat'),
    ...freshnessFields,
    /** JSONata over the last report { status, value, ts, data }; false = down */
    condition: expr.optional(),
    /** JSONata over the report returning up/degraded/down (or true/false); default: the report's "status" field if present */
    statusExpression: expr.optional(),
    authMode: z.enum(HEARTBEAT_AUTH_MODES).default('token'),
    allowedCidrs: z.array(z.string().max(64)).max(50).optional(),
    rateLimitPerMinute: z.number().int().min(1).max(600).optional(),
  }),
  z.object({
    ...checkBase,
    type: z.literal('gatus'),
    platform: platformRef,
    /** Gatus endpoint key: <group>_<name>, e.g. plant_historian-api */
    endpointKey: z.string().min(1).max(300),
    /** down when Gatus has no result newer than this (optional) */
    maxAgeSeconds: seconds(1, 365 * 86400).optional(),
    /** degraded when one of the last N results failed although the newest one succeeded (0 = off) */
    degradedOnRecentFailures: z.number().int().min(0).max(100).optional(),
    /** api: Gatus status API; metrics: the samples Steward scraped from /metrics; auto: metrics when metrics mode is on for the platform */
    source: z.enum(['auto', 'api', 'metrics']).optional(),
  }),
  z.object({
    ...checkBase,
    type: z.literal('checkmk'),
    platform: platformRef,
    /** CheckMk host name */
    host: z.string().trim().min(1).max(253),
    /** Service description, exactly as in CheckMk; empty: the state of the host */
    service: z.string().trim().max(500).optional(),
    /** unknown when CheckMk has not checked it for this long (optional) */
    maxAgeSeconds: seconds(1, 365 * 86400).optional(),
  }),
  z.object({
    ...checkBase,
    type: z.literal('prometheus'),
    platform: platformRef,
    /** PromQL instant query; several series: the worst one counts (#110) */
    query: z.string().trim().min(1).max(4000),
    /** above: a value at or above the level is bad (default); below: at or below (e.g. free space, replicas) */
    direction: z.enum(['above', 'below']).default('above'),
    /** degraded from this value on (optional) */
    warn: z.number().finite().optional(),
    /** down from this value on */
    crit: z.number().finite(),
    /** status when the query returns no series (default unknown: the target may have vanished) */
    noData: z.enum(['unknown', 'up', 'down']).default('unknown'),
    /** shown after values, e.g. "%" */
    unit: z.string().max(20).optional(),
  }),
  z.object({
    ...checkBase,
    type: z.literal('kubernetes'),
    platform: platformRef,
    namespace: z.string().trim().min(1).max(253),
    /** One deployment; empty: every deployment of the namespace (#111) */
    deployment: z.string().trim().max(253).optional(),
  }),
  z.object({
    ...checkBase,
    type: z.literal('git'),
    platform: platformRef,
    /** owner/repo (GitLab: group/project) on a GitHub, GitLab or Forgejo/Gitea platform (#107) */
    repository: z.string().trim().min(3).max(300),
    /** Branch; empty: the repository's default branch */
    branch: z.string().trim().max(250).optional(),
    /** Status when the pipeline failed (default down) */
    failedAs: z.enum(['down', 'degraded']).default('down'),
    /** degraded when more open security alerts of this severity or higher (GitHub Dependabot); unset: alerts are not checked */
    maxCritical: z.number().int().min(0).max(100000).optional(),
    maxHigh: z.number().int().min(0).max(100000).optional(),
  }),
  z.object({
    ...checkBase,
    type: z.literal('dependency-track'),
    platform: platformRef,
    /** name@version, name@latest or the project's UUID (#119) */
    project: z.string().trim().min(3).max(360),
    /** Down (or failAs) above this many open critical findings (default 0) */
    maxCritical: z.number().int().min(0).max(100000).default(0),
    /** Degraded above this many open critical or high findings; unset: high findings are not checked */
    maxHigh: z.number().int().min(0).max(100000).optional(),
    /** A failing policy violation counts like a critical finding (default true) */
    policyFail: z.boolean().default(true),
    failAs: z.enum(['down', 'degraded']).default('down'),
  }),
  z.object({
    ...checkBase,
    type: z.literal('version-behind'),
    /** The application whose tech stack is checked: its id or name (#241) */
    application: z.string().trim().min(1).max(200),
    /** Only components and systems of this environment (and those of all environments); empty: every one */
    environment: z.string().trim().max(60).optional(),
    /** Only these products (endoflife.date ids); empty: the whole stack */
    products: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    /** Degraded above this many minor releases behind (default 2) */
    maxMinors: z.number().int().min(0).max(1000).default(2),
    /** Degraded when the first newer release came out more than this many days ago; unset: not checked */
    maxDays: z.number().int().min(1).max(3650).optional(),
    /** A major release behind: down (default) or degraded */
    majorAs: z.enum(['down', 'degraded']).default('down'),
    /** The release cycle reached its end of life: down (default), degraded, or not checked */
    eolAs: z.enum(['down', 'degraded', 'ignore']).default('down'),
  }),
  z.object({
    ...checkBase,
    type: z.literal('privilege-vault'),
    platform: platformRef,
    /** Only secrets of this folder and below (\IT\Servers); empty: all the service account may list (#205) */
    folder: z.string().trim().max(500).optional(),
    /** A password changed longer ago (or never) counts as not rotated */
    maxAgeDays: z.number().int().min(1).max(3650).default(90),
    /** Folders (and below) and templates whose secrets count as privileged: they need checkout and approval */
    privilegedFolders: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
    privilegedTemplates: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
    /** The findings looked for (default all) */
    kinds: z.array(z.enum(PV_FINDING_KINDS)).max(PV_FINDING_KINDS.length).optional(),
    /** Findings allowed before the check fails (default 0) */
    maxFindings: z.number().int().min(0).max(100000).default(0),
    /** Status with more findings: degraded (default) or down; a finding on a privileged secret always counts */
    failAs: z.enum(['down', 'degraded']).default('degraded'),
  }),
  z.object({
    ...checkBase,
    type: z.literal('page-watch'),
    /** A changedetection.io platform (#242) */
    platform: platformRef,
    /** One watch (its UUID); empty: the watches with the tag, or all watches */
    watch: z
      .string()
      .trim()
      .refine((v) => !v || PAGE_WATCH_UUID_RE.test(v), 'the UUID of a watch in changedetection.io')
      .optional(),
    /** The watches with this tag (its name in changedetection.io, case does not matter); ignored with a watch */
    tag: z.string().trim().max(PAGE_WATCH_LIMITS.tag).optional(),
    /** A change within this many hours is reported (default 24) … */
    changedWithinHours: z.number().int().min(1).max(8760).default(24),
    /** … as information (up, the default) or as degraded */
    changedAs: z.enum(['up', 'degraded']).default('up'),
    /** Status of a watch whose last check failed (fetch error, filter not found …) or that was not checked for too long */
    failingAs: z.enum(['down', 'degraded']).default('degraded'),
    /** Not checked for this many hours counts as failing (optional: an instance or watch that stopped checking) */
    maxCheckAgeHours: z.number().int().min(1).max(8760).optional(),
    /** Paused watches: left out (default), or degraded (a paused watch notices nothing) */
    pausedAs: z.enum(['ignore', 'degraded']).default('ignore'),
  }),
  z.object({
    ...checkBase,
    type: z.literal('snowflake'),
    platform: platformRef,
    /**
     * freshness: the table DATABASE.SCHEMA.TABLE changed within maxAgeMinutes (INFORMATION_SCHEMA, current);
     * tasks: no task of DATABASE (or DATABASE.SCHEMA) failed within withinHours (ACCOUNT_USAGE, up to 45 minutes behind);
     * credits: the warehouse used at most maxCredits within withinHours (ACCOUNT_USAGE, up to 3 hours behind) (#115)
     */
    mode: z.enum(['freshness', 'tasks', 'credits']),
    object: z.string().trim().min(1).max(800),
    maxAgeMinutes: z.number().int().min(1).max(525600).optional(),
    withinHours: z.number().int().min(1).max(720).optional(),
    maxCredits: z.number().min(0).max(10_000_000).optional(),
    /** Status when the limit is not met (default down) */
    failAs: z.enum(['down', 'degraded']).default('down'),
  }),
  z.object({
    ...checkBase,
    type: z.literal('database'),
    platform: platformRef,
    /**
     * connection: connects and reads the server version (degraded when the account can write); replication: the largest
     * replication lag in seconds (catalog query "replication"); query: the first column of the first row of a read-only
     * statement, compared with warn and crit (#203)
     */
    mode: z.enum(['connection', 'replication', 'query']).default('connection'),
    sql: z.string().trim().max(DB_LIMITS.sqlChars).optional(),
    params: z
      .array(z.union([z.string().max(DB_LIMITS.paramChars), z.number(), z.boolean()]))
      .max(DB_LIMITS.params)
      .optional(),
    /** above: a value at or above the level is bad (default); below: at or below */
    direction: z.enum(['above', 'below']).default('above'),
    warn: z.number().finite().optional(),
    crit: z.number().finite().optional(),
    /** Status when the query returns no row, or replication has no replica (default unknown) */
    noData: z.enum(['unknown', 'up', 'down']).default('unknown'),
    unit: z.string().max(20).optional(),
  }),
  z.object({
    ...checkBase,
    type: z.literal('dynamodb'),
    /** An AWS account platform (#116, #233) */
    platform: platformRef,
    /** The table's region; empty: the platform's main region */
    region: z
      .string()
      .trim()
      .max(40)
      .refine((v) => !v || AWS_REGION_RE.test(v), 'an AWS region, e.g. eu-central-1')
      .optional(),
    table: z.string().trim().regex(DYNAMODB_NAME_RE, 'a DynamoDB table name: 3–255 of a-z, A-Z, 0-9, _ - .'),
    /**
     * newestItem: one Query per partition key value (Limit 1, newest first by the sort key) – the item's time attribute is
     * the age; writeActivity: CloudWatch ConsumedWriteCapacityUnits – the newest minute with writes is the age;
     * hygiene: DescribeTable, DescribeContinuousBackups, DescribeTimeToLive
     */
    mode: z.enum(DYNAMODB_MODES).default('newestItem'),
    /** newestItem: a global or local secondary index whose sort key is the time; empty: the table's own key */
    indexName: z
      .string()
      .trim()
      .max(255)
      .refine((v) => !v || DYNAMODB_NAME_RE.test(v), 'an index name: 3–255 of a-z, A-Z, 0-9, _ - .')
      .optional(),
    /** newestItem: the partition key attribute of the table or index, and its type (S string, N number) */
    partitionKey: z.string().min(1).max(255).optional(),
    partitionKeyType: z.enum(['S', 'N']).default('S'),
    /** newestItem: the partition key values, each with its own age (e.g. device#press-07) */
    partitionValues: z.array(z.string().min(1).max(DYNAMODB_LIMITS.valueChars)).max(DYNAMODB_LIMITS.partitionValues).optional(),
    /** newestItem: the attribute with the item's time (usually the sort key) */
    timeAttribute: z.string().min(1).max(255).optional(),
    timeFormat: z.enum(DYNAMODB_TIME_FORMATS).default('auto'),
    /** newestItem and writeActivity: cadence (expected every N seconds) or maxAge, like the freshness check */
    freshnessMode: z.enum(FRESHNESS_MODES).default('cadence'),
    ...freshnessLimits,
    /** hygiene: each requirement is required (fails the check) or only reported */
    activeTable: z.enum(DYNAMODB_REQUIREMENTS).default('required'),
    pointInTimeRecovery: z.enum(DYNAMODB_REQUIREMENTS).default('report'),
    timeToLive: z.enum(DYNAMODB_REQUIREMENTS).default('report'),
    /** hygiene: the status when a required one is not met (default degraded) */
    failAs: z.enum(['down', 'degraded']).default('degraded'),
  }),
  z.object({
    ...checkBase,
    type: z.literal('db-schema'),
    /** A database platform … */
    platform: platformRef.optional(),
    /** … or a system with imported tbls schemas (exactly one of the two) */
    system: z.string().trim().min(1).max(100).optional(),
    /** breaking: a breaking change fails the check (default); changed: any change does */
    mode: z.enum(['breaking', 'changed']).default('breaking'),
    /** The window: changes of snapshots taken within the last N hours count (default 24) */
    withinHours: z.number().int().min(1).max(8760).default(24),
    /** Read the database platform first (a snapshot when the schema changed); otherwise only stored snapshots count */
    read: z.boolean().default(false),
    /** Status of a failing check (default: down for breaking changes, degraded for changes) */
    failAs: z.enum(['down', 'degraded']).optional(),
    /** Status while there is no snapshot yet (default unknown) */
    noData: z.enum(['unknown', 'up', 'down']).default('unknown'),
  }),
  z.object({
    ...checkBase,
    type: z.literal('cost'),
    /** What the costs are of (#226): a service, application, team or platform – by id */
    scope: z.enum(COST_SCOPES),
    target: z.string().trim().min(1).max(100),
    /**
     * month: the last complete month against the month before; monthToDate: this month so far against the same share of
     * the month before
     */
    period: z.enum(COST_CHECK_PERIODS).default('month'),
    /** The currency compared (default: the one with the highest costs) */
    currency: currencyCode.optional(),
    /** Fails when the costs rose by more than this many percent … */
    maxIncreasePct: z.number().min(0).max(100_000).optional(),
    /** … or by more than this amount (decimal, in the currency) */
    maxIncrease: z
      .string()
      .trim()
      .max(32)
      .refine((v) => toMicros(v) !== null && toMicros(v)! >= 0, 'an amount like 500 or 500.50')
      .optional(),
    failAs: z.enum(['down', 'degraded']).default('degraded'),
    /** Status without costs in the periods (default unknown) */
    noData: z.enum(['unknown', 'up']).default('unknown'),
  }),
  z.object({
    ...checkBase,
    type: z.literal('data-contract'),
    /** The data contract (its id, #221) */
    contract: z.string().trim().min(1).max(100),
    /** test: run its test through the data contract service; findings: Steward's own checks, without the service */
    mode: z.enum(['test', 'findings']).default('test'),
    /** findings: a contract not tested within this many days counts as a warning (default 7) */
    testedWithinDays: z.number().int().min(1).max(365).default(7),
    /** Status of a failed test or an error finding (default down) */
    failAs: z.enum(['down', 'degraded']).default('down'),
    /** Status of a test with warnings or a warning finding (default degraded) */
    warningAs: z.enum(['degraded', 'up']).default('degraded'),
  }),
  z.object({
    ...checkBase,
    type: z.literal('kafka'),
    platform: platformRef,
    /** The topic (#112) */
    topic: z.string().trim().min(1).max(249),
    /** down (or quietAs) when the newest message is older than this */
    messagesWithinMinutes: z.number().int().min(1).max(43200).optional(),
    quietAs: z.enum(['down', 'degraded']).default('down'),
    /** A consumer group: degraded above maxLag, down when it is stuck (lag and no commit for stuckMinutes) */
    group: z.string().trim().max(255).optional(),
    maxLag: z.number().int().min(0).optional(),
    stuckMinutes: z.number().int().min(1).max(10080).default(15),
    /** degraded when the latest schema version of <topic>-value is another one */
    schemaVersion: z.number().int().min(1).optional(),
  }),
  z.object({
    ...checkBase,
    type: z.literal('kafka-connect'),
    /** A Kafka Connect platform (#223) */
    platform: platformRef,
    /** One connector; empty: every connector of the cluster */
    connector: z.string().trim().max(255).optional(),
    /** Status of a connector or task that is FAILED, UNASSIGNED or RESTARTING (default down) */
    notRunningAs: z.enum(['down', 'degraded']).default('down'),
    /** Status of a PAUSED or STOPPED connector or task (default degraded) */
    pausedAs: z.enum(['up', 'degraded', 'down']).default('degraded'),
    /** A failed task counts as notRunningAs only once it has failed for this many minutes (degraded before) */
    failedMinutes: z.number().int().min(1).max(10080).optional(),
    /** Sink connectors: degraded above this consumer lag, read on the linked Kafka platform */
    maxLag: z.number().int().min(0).optional(),
    /** Debezium source connectors: quietAs when none of its topics got a message for this many minutes */
    quietMinutes: z.number().int().min(1).max(43200).optional(),
    quietAs: z.enum(['down', 'degraded']).default('degraded'),
  }),
  z.object({
    ...checkBase,
    type: z.literal('mqtt'),
    platform: platformRef,
    /** Topic or pattern with + and # (#113), e.g. plant/+/status */
    topic: z.string().trim().min(1).max(500),
    /** any: a message on any matching topic within the window; each: every topic of the pattern seen so far (silent devices) */
    mode: z.enum(['any', 'each']).default('any'),
    withinMinutes: z.number().int().min(1).max(43200),
    quietAs: z.enum(['down', 'degraded']).default('down'),
    /** degraded below this many connected clients (brokers that publish $SYS/broker/clients/connected) */
    minClients: z.number().int().min(0).optional(),
  }),
  z.object({
    ...checkBase,
    type: z.literal('entra'),
    platform: platformRef,
    /**
     * app-credentials: per app registration and type, the secret or certificate that lasts longest ends within
     * withinDays (degraded) or downWithinDays (down; expired too) – a rotated one next to a newer one does not count;
     * service-health: a Microsoft 365 service is not operational (degraded; an interruption: down) (v0.5.0)
     */
    mode: z.enum(['app-credentials', 'service-health']).default('app-credentials'),
    withinDays: z.number().int().min(1).max(365).default(30),
    downWithinDays: z.number().int().min(0).max(365).default(7),
    /** app-credentials: only these app registrations (display names or application ids); empty: all */
    apps: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
    /** service-health: only these services (e.g. "Exchange Online", "Microsoft Teams"); empty: all */
    services: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  }),
  z.object({ ...checkBase, type: z.literal('monitor'), monitor: z.string().trim().min(1).max(200) }),
]);
export type CheckDef = z.output<typeof checkSchema>;
export type CheckOf<T extends CheckType> = Extract<CheckDef, { type: T }>;

export const linkSchema = z.object({
  from: z.string().regex(CHECK_ID_RE),
  to: z.string().regex(CHECK_ID_RE),
  mode: z.enum(LINK_MODES).default('soft'),
});
export type LinkDef = z.output<typeof linkSchema>;

const outputBase = {
  id: z.string().regex(CHECK_ID_RE),
  name: z.string().max(120).optional(),
  enabled: z.boolean().default(true),
  /** change: on every status change; every: after every evaluation (at most every minIntervalSeconds) */
  on: z.enum(['change', 'every']).default('change'),
  minIntervalSeconds: seconds(10, 86400).optional(),
  /** Only these new statuses are sent (default: all) */
  statuses: z.array(z.enum(MONITOR_STATUSES)).max(MONITOR_STATUSES.length).optional(),
  /** monitor: the aggregated monitor status; checks: each check; all: both (default: monitor for notification and process, all for the others) */
  include: z.enum(['monitor', 'checks', 'all']).optional(),
  /** Restrict to these check ids */
  checks: z.array(z.string()).max(100).optional(),
  /** Leave out checks whose failure is explained by a failing parent (default: true for notification and process) */
  suppressDependents: z.boolean().optional(),
  /**
   * Outputs to a platform: the identity it sends with (0.13.0, ADR 0009) – its id or name; missing: the platform's
   * default identity. It must not be read-only; the monitor's owner must be allowed to use it.
   */
  identity: z.string().trim().min(1).max(200).optional(),
};

/** Output targets may use ${monitor.key}, ${monitor.name}, ${check.id}, ${check.key}, ${check.name} placeholders. */
export const outputSchema = z.discriminatedUnion('type', [
  z.object({
    ...outputBase,
    type: z.literal('notification'),
    /** user:<name>, team:<name> or role:<role>; the monitor owner is always notified */
    subscribers: z.array(z.string().max(200)).max(100).default([]),
    /** Wait this long before alerting, so a parent failing a little later still explains the failure (default 0) */
    holdSeconds: seconds(0, 3600).optional(),
    /** Urgent – a change to down interrupts quiet hours (0.10.0, ADR 0012) */
    urgent: z.boolean().optional(),
    /** Monitors with states (ADR 0021): also tell state changes as information (event monitor.state, never urgent) */
    stateChanges: z.boolean().optional(),
  }),
  z.object({
    ...outputBase,
    type: z.literal('webhook'),
    /** Plain URL (no credentials) … */
    url: z.string().url().optional(),
    /** … or a platform (its authentication) plus a path; a "Microsoft Teams channel" platform holds the Workflows URL as a credential */
    platform: platformRef.optional(),
    path: z.string().max(2000).optional(),
    /** json: Steward's event payload (default); teams: an Adaptive Card for a Teams Workflows URL (#130) */
    format: z.enum(['json', 'teams']).optional(),
    /** Teams format only: the channel's quiet hours (0.10.0, ADR 0012); JSON is never held */
    quietHours: quietHoursSchema.optional(),
    /** Teams format only: a change to down interrupts the quiet hours */
    urgent: z.boolean().optional(),
  }),
  z.object({
    ...outputBase,
    type: z.literal('gatus'),
    platform: platformRef,
    endpointKey: z.string().min(1).max(300),
    /** Name of the platform credential holding the external endpoint token (default externalToken) */
    tokenSecret: z.string().max(100).optional(),
    /**
     * What Gatus gets while off (ADR 0021): success (default), failure, or skip (nothing is sent). A contradiction and
     * Off beyond the maximum are failures whatever this says.
     */
    whileOff: z.enum(GATUS_WHILE_OFF).optional(),
  }),
  z.object({
    ...outputBase,
    type: z.literal('zabbix'),
    platform: platformRef,
    /** sender: trapper protocol (TCP 10051); api: JSON-RPC history.push (Zabbix 7.0+) */
    via: z.enum(['sender', 'api']).default('sender'),
    /** Zabbix host name (default: platform variable "host") */
    host: z.string().max(300).optional(),
    itemKeyMonitor: z.string().max(500).optional(),
    itemKeyCheck: z.string().max(500).optional(),
    /** code: 0 up, 1 degraded, 2 down, 3 unknown, 4 blocked, 5 maintenance, 6 off; text: the status word */
    value: z.enum(['code', 'text']).default('code'),
  }),
  z.object({
    ...outputBase,
    type: z.literal('process'),
    processId: z.string().min(1).max(200),
    bindings: boundedRecord(z.string(), 100).default({}),
    /** Slot → identity id (0.13.0, ADR 0009); a missing slot uses the platform's default identity */
    identities: boundedRecord(z.string().max(200), 100).optional(),
    /** Process input → JSONata over { monitor, check, event } */
    inputs: boundedRecord(z.string().max(2000), 200).default({}),
    dryRun: z.boolean().default(false),
    /** Messages of the runs it starts (#139); missing: after every run, as before 0.2.4 */
    notify: notifyPolicySchema.optional(),
  }),
]);
export type OutputDef = z.output<typeof outputSchema>;

export const templateParamSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,47}$/),
  label: z.string().max(120).optional(),
  type: z.enum(['string', 'number']).default('string'),
  default: z.union([z.string(), z.number()]).optional(),
  required: z.boolean().default(true),
  description: z.string().max(500).optional(),
});
export type TemplateParam = z.output<typeof templateParamSchema>;

// ---------- states (0.13, ADR 0021) ----------

/** A cell of the decision table: up (up or degraded), down (down or blocked), off (a sub-monitor that is off), any */
export const STATE_CELLS = ['up', 'down', 'off', 'any'] as const;
export type StateCell = (typeof STATE_CELLS)[number];
export const STATE_LIMITS = {
  cases: 10,
  /** Settle time of a state (seconds) */
  settleMin: 60,
  settleMax: 86400,
  /** Maximum off time when the monitor does not set one (hours) */
  defaultMaxOffHours: 8,
  maxOffHoursMax: 8760,
  /** More state changes than this within an hour make the monitor degraded */
  changesPerHour: 4,
} as const;
const cells = boundedRecord(z.enum(STATE_CELLS), 100);

export const stateCaseSchema = z.object({
  /** The state's id (as a check id); a follower names the leader's state ids */
  id: z.string().regex(CHECK_ID_RE, 'letters, digits, _ and - (max. 48)'),
  name: z.string().trim().max(120).optional(),
  /** The status shown while every check agrees: up (default) or off */
  status: z.enum(['up', 'off']).optional(),
  /** The condition: check id → cell (the first row whose condition matches wins) */
  when: cells.optional(),
  /** Checks that must be up for the state to be trusted (a gateway's own heartbeat) */
  requires: z.array(z.string().regex(CHECK_ID_RE)).max(20).optional(),
  /** Expected statuses of the other checks */
  expect: cells.optional(),
  /** Deviations do not count this long after a change to this state (default: derived from the checks) */
  settleSeconds: seconds(STATE_LIMITS.settleMin, STATE_LIMITS.settleMax).optional(),
  /** Off rows: the maximum off time of this state (default: the monitor's; 0 = none) */
  maxOffHours: z.number().min(0).max(STATE_LIMITS.maxOffHoursMax).optional(),
  /** What a contradiction makes the monitor: down (default) or degraded */
  contradiction: z.enum(['down', 'degraded']).optional(),
});
export type StateCase = z.output<typeof stateCaseSchema>;

export const statesSchema = z.object({
  /** Follow another monitor's state (its id or key): the cases name its state ids and have no condition */
  from: z.string().trim().min(1).max(200).optional(),
  /** Maximum off time in hours (default 8; 0 = none) */
  maxOffHours: z.number().min(0).max(STATE_LIMITS.maxOffHoursMax).optional(),
  cases: z.array(stateCaseSchema).max(STATE_LIMITS.cases).default([]),
});
export type StatesDef = z.output<typeof statesSchema>;

export const monitorDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(4000).default(''),
  tags: z.array(tagInput()).max(30).default([]),
  intervalSeconds: seconds(5, 86400).default(60),
  timeoutSeconds: seconds(1, 300).default(10),
  failuresBeforeDown: seconds(1, 20).default(2),
  successesBeforeUp: seconds(1, 20).default(1),
  aggregate: z.object({ rule: z.enum(AGGREGATE_RULES).default('worst'), quorum: z.number().int().min(1).optional() }).default({ rule: 'worst' }),
  checks: z.array(checkSchema).max(100).default([]),
  links: z.array(linkSchema).max(500).default([]),
  outputs: z.array(outputSchema).max(30).default([]),
  /** Templates only: parameters substituted as {{ params.<name> }} when an instance is created */
  parameters: z.array(templateParamSchema).max(50).optional(),
  /** States and expected statuses (0.13, ADR 0021); without them the monitor behaves as before */
  states: statesSchema.optional(),
});
export type MonitorDefinition = z.output<typeof monitorDefinitionSchema>;
export type MonitorDefinitionInput = z.input<typeof monitorDefinitionSchema>;

/** File format of examples/monitors/*.yaml and of the export. */
export const monitorFileSchema = monitorDefinitionSchema.extend({
  kind: z.enum(['monitor', 'monitorTemplate']),
  key: z.string().regex(MONITOR_KEY_RE).optional(),
  enabled: z.boolean().optional(),
});

export interface DefinitionIssue {
  path: string;
  message: string;
  checkId?: string;
  /** Shown, but does not stop saving (a state that can never match) */
  warning?: boolean;
}

/** Structural rules beyond the schema: unique ids, valid links, no cycles, sensible check settings. */
export function definitionIssues(def: MonitorDefinition, opts: { template?: boolean } = {}): DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];
  const ids = new Set<string>();
  def.checks.forEach((c, i) => {
    if (ids.has(c.id)) issues.push({ path: `checks.${i}.id`, message: `duplicate check id "${c.id}"`, checkId: c.id });
    ids.add(c.id);
    if ((c.type === 'freshness' || c.type === 'heartbeat') && c.mode === 'cadence' && !c.expectedIntervalSeconds) {
      issues.push({ path: `checks.${i}.expectedIntervalSeconds`, message: 'cadence mode needs the expected interval', checkId: c.id });
    }
    if ((c.type === 'freshness' || c.type === 'heartbeat') && c.mode === 'maxAge' && !c.maxAgeSeconds) {
      issues.push({ path: `checks.${i}.maxAgeSeconds`, message: 'maxAge mode needs the maximum age', checkId: c.id });
    }
    if (c.type === 'freshness' && c.mode === 'cadence' && (c.degradedAfterMissed ?? 2) > (c.downAfterMissed ?? 4)) {
      issues.push({ path: `checks.${i}.downAfterMissed`, message: 'must be at least degradedAfterMissed', checkId: c.id });
    }
    // one issue per missing field, so editors can show it on the field (#141)
    if (c.type === 'freshness' && c.source === 'insightsHub') {
      if (!c.assetId) issues.push({ path: `checks.${i}.assetId`, message: 'Insights Hub freshness needs the asset id', checkId: c.id });
      if (!c.aspect) issues.push({ path: `checks.${i}.aspect`, message: 'Insights Hub freshness needs the aspect', checkId: c.id });
      if (!c.variables?.length) issues.push({ path: `checks.${i}.variables`, message: 'Insights Hub freshness needs at least one variable', checkId: c.id });
    }
    if (c.type === 'database' && c.mode === 'query' && !c.sql)
      issues.push({ path: `checks.${i}.sql`, message: 'query mode needs the SQL statement', checkId: c.id });
    if (c.type === 'database' && c.mode !== 'connection' && c.crit === undefined)
      issues.push({ path: `checks.${i}.crit`, message: `${c.mode} mode needs the CRIT level`, checkId: c.id });
    if (c.type === 'db-schema' && !c.platform === !c.system)
      issues.push({ path: `checks.${i}.platform`, message: 'name a database platform or a system (one of them)', checkId: c.id });
    if (c.type === 'cost' && c.maxIncreasePct === undefined && c.maxIncrease === undefined)
      issues.push({ path: `checks.${i}.maxIncreasePct`, message: 'a cost change check needs a percentage or an amount', checkId: c.id });
    if (c.type === 'db-schema' && c.read && !c.platform)
      issues.push({ path: `checks.${i}.read`, message: 'only a database platform can be read', checkId: c.id });
    if (c.type === 'freshness' && c.source === 'platform') {
      if (!c.path) issues.push({ path: `checks.${i}.path`, message: 'platform freshness needs the path', checkId: c.id });
      if (!c.timestamp) issues.push({ path: `checks.${i}.timestamp`, message: 'platform freshness needs the timestamp expression', checkId: c.id });
    }
    if (c.type === 'freshness') issues.push(...requestIssues(c, i));
    if (c.type === 'dynamodb') issues.push(...dynamoDbIssues(c, i));
  });
  const seen = new Set<string>();
  def.links.forEach((l, i) => {
    if (!ids.has(l.from)) issues.push({ path: `links.${i}.from`, message: `unknown check "${l.from}"` });
    if (!ids.has(l.to)) issues.push({ path: `links.${i}.to`, message: `unknown check "${l.to}"` });
    if (l.from === l.to) issues.push({ path: `links.${i}`, message: 'a check cannot depend on itself' });
    const k = `${l.from}>${l.to}`;
    if (seen.has(k)) issues.push({ path: `links.${i}`, message: `duplicate link ${l.from} → ${l.to}` });
    seen.add(k);
  });
  const cycle = findCycle(
    [...ids],
    def.links.map((l) => [l.from, l.to]),
  );
  if (cycle) issues.push({ path: 'links', message: `links form a cycle: ${cycle.join(' → ')}` });
  const outIds = new Set<string>();
  def.outputs.forEach((o, i) => {
    if (outIds.has(o.id)) issues.push({ path: `outputs.${i}.id`, message: `duplicate output id "${o.id}"` });
    outIds.add(o.id);
    if (o.type === 'webhook' && !o.url && !o.platform) issues.push({ path: `outputs.${i}`, message: 'webhook needs a URL or a platform' });
    if (o.type === 'webhook' && o.url && /\/\/[^/]*@/.test(o.url))
      issues.push({ path: `outputs.${i}.url`, message: 'no credentials in the URL – use a platform instead' });
  });
  if (def.aggregate.rule === 'quorum' && !def.aggregate.quorum)
    issues.push({ path: 'aggregate.quorum', message: 'the quorum rule needs k (checks that must be up)' });
  if (!opts.template && def.parameters?.length) issues.push({ path: 'parameters', message: 'only templates have parameters' });
  // warnings (a state that can never match) are the editor's: stateIssues lists them
  if (def.states) issues.push(...stateIssues(def).filter((i) => !i.warning));
  return issues;
}

/**
 * The rules of the decision table (ADR 0021): unique state ids, cells that name existing enabled checks, a condition
 * per row (none for a follower), `off` only on a sub-monitor column, a required check in no other cell of its row, and
 * a warning for a row that can never match. Warnings have `warning: true` and do not stop saving.
 */
export function stateIssues(def: MonitorDefinition): DefinitionIssue[] {
  const st = def.states;
  if (!st) return [];
  const out: DefinitionIssue[] = [];
  const checks = new Map(def.checks.map((c) => [c.id, c]));
  const ids = new Set<string>();
  const follower = !!st.from;
  st.cases.forEach((r, i) => {
    const at = `states.cases.${i}`;
    if (ids.has(r.id)) out.push({ path: `${at}.id`, message: `duplicate state id "${r.id}"` });
    ids.add(r.id);
    const cellsOf = (field: 'when' | 'expect') => Object.entries(r[field] ?? {});
    for (const field of ['when', 'expect'] as const) {
      for (const [cid, cell] of cellsOf(field)) {
        const c = checks.get(cid);
        if (!c) out.push({ path: `${at}.${field}.${cid}`, message: `unknown check "${cid}"` });
        else if (c.enabled === false) out.push({ path: `${at}.${field}.${cid}`, message: `the check "${c.name}" is disabled`, checkId: cid });
        else if (cell === 'off' && c.type !== 'monitor')
          out.push({ path: `${at}.${field}.${cid}`, message: 'off is only for sub-monitor checks', checkId: cid });
      }
    }
    for (const cid of Object.keys(r.when ?? {}))
      if (r.expect && cid in r.expect) out.push({ path: `${at}.expect.${cid}`, message: `"${cid}" is a condition of this state already`, checkId: cid });
    for (const cid of r.requires ?? []) {
      const c = checks.get(cid);
      if (!c) out.push({ path: `${at}.requires`, message: `unknown check "${cid}"` });
      else if (c.enabled === false) out.push({ path: `${at}.requires`, message: `the check "${c.name}" is disabled`, checkId: cid });
      if ((r.when && cid in r.when) || (r.expect && cid in r.expect))
        out.push({ path: `${at}.requires`, message: `a required check is no other cell of its state ("${cid}")`, checkId: cid });
    }
    const condition = cellsOf('when').filter(([, v]) => v !== 'any');
    if (follower && r.when && Object.keys(r.when).length)
      out.push({ path: `${at}.when`, message: 'a state that follows another monitor has no condition of its own' });
    if (!follower && !condition.length) out.push({ path: `${at}.when`, message: 'a state needs at least one condition cell' });
    if (!follower && r.status !== 'off' && r.maxOffHours !== undefined)
      out.push({ path: `${at}.maxOffHours`, message: 'only an off state has a maximum off time' });
    // a row that an earlier row always wins against: every condition cell of the earlier row is in this one, the same
    if (!follower && condition.length) {
      const earlier = st.cases.slice(0, i).find((e) => {
        const ec = Object.entries(e.when ?? {}).filter(([, v]) => v !== 'any');
        return ec.length > 0 && ec.every(([k, v]) => r.when?.[k] === v) && !(e.requires ?? []).length;
      });
      if (earlier)
        out.push({
          path: `${at}.when`,
          message: `this state can never match: "${earlier.name || earlier.id}" comes first with the same or a wider condition`,
          warning: true,
        });
    }
  });
  if (follower && st.maxOffHours !== undefined)
    out.push({ path: 'states.maxOffHours', message: 'a state that follows another monitor has no maximum off time of its own' });
  return out;
}

/** method, headers and body of a freshness check: only with the platform source, a body only with POST (#233). */
function requestIssues(c: CheckOf<'freshness'>, i: number): DefinitionIssue[] {
  const out: DefinitionIssue[] = [];
  const at = (field: string, message: string) => out.push({ path: `checks.${i}.${field}`, message, checkId: c.id });
  if (c.source !== 'platform') {
    for (const f of ['method', 'headers', 'body'] as const) if (c[f] !== undefined) at(f, 'only the platform source sends a request of its own');
    return out;
  }
  // header names and the body's size are rules of the schema
  if (bodyChars(c.body) > 0 && (c.method ?? 'GET') !== 'POST') at('body', 'a body is only sent with POST');
  return out;
}

/** The fields each DynamoDB mode needs (#233). */
function dynamoDbIssues(c: CheckOf<'dynamodb'>, i: number): DefinitionIssue[] {
  const out: DefinitionIssue[] = [];
  const at = (field: string, message: string) => out.push({ path: `checks.${i}.${field}`, message, checkId: c.id });
  // region and index name are rules of the schema
  if (c.mode === 'newestItem') {
    if (!c.partitionKey) at('partitionKey', 'newest item needs the partition key attribute');
    if (!c.partitionValues?.length) at('partitionValues', 'newest item needs at least one partition key value');
    else if (new Set(c.partitionValues).size !== c.partitionValues.length) at('partitionValues', 'each partition key value only once');
    else if (c.partitionKeyType === 'N' && c.partitionValues.some((v) => !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)))
      at('partitionValues', 'the partition key is a number: every value must be one');
    if (!c.timeAttribute) at('timeAttribute', 'newest item needs the time attribute');
    else if (c.timeAttribute === c.partitionKey) at('timeAttribute', 'the time attribute cannot be the partition key');
  }
  if (c.mode !== 'hygiene') {
    if (c.freshnessMode === 'cadence' && !c.expectedIntervalSeconds) at('expectedIntervalSeconds', 'cadence mode needs the expected interval');
    if (c.freshnessMode === 'maxAge' && !c.maxAgeSeconds) at('maxAgeSeconds', 'maxAge mode needs the maximum age');
    if (c.freshnessMode === 'cadence' && (c.degradedAfterMissed ?? 2) > (c.downAfterMissed ?? 4)) at('downAfterMissed', 'must be at least degradedAfterMissed');
  }
  return out;
}

/**
 * Names the card or output an issue path points at (#141): `checks.1.variables` becomes
 * `Check "Power Meter – Insights Hub" (pm-ih) – variables`, so messages never show bare indexes.
 */
export function issueLabel(def: unknown, path: string): string {
  const d = (def ?? {}) as { checks?: { id?: unknown; name?: unknown }[]; outputs?: { id?: unknown }[] };
  const m = /^(checks|outputs|links)\.(\d+)(?:\.(.+))?$/.exec(path);
  if (!m) return path;
  const [, list, index, field] = m;
  const suffix = field ? ` – ${field}` : '';
  if (list === 'checks') {
    const c = d.checks?.[Number(index)];
    if (!c) return path;
    const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : '';
    const id = typeof c.id === 'string' ? c.id : '';
    return `Check ${name ? `"${name}"` : `#${Number(index) + 1}`}${id && id !== name ? ` (${id})` : ''}${suffix}`;
  }
  if (list === 'outputs') {
    const o = d.outputs?.[Number(index)];
    return o && typeof o.id === 'string' ? `Output "${o.id}"${suffix}` : path;
  }
  return `Link #${Number(index) + 1}${suffix}`;
}

/** An issue path that belongs to a check: its index and field (`checks.2.port` → { index: 2, field: 'port' }). */
export function checkIssueTarget(path: string): { index: number; field: string | null } | null {
  const m = /^checks\.(\d+)(?:\.([^.]+))?/.exec(path);
  return m ? { index: Number(m[1]), field: m[2] ?? null } : null;
}

/** Returns one cycle (list of node ids) or null. */
export function findCycle(nodes: string[], edges: [string, string][]): string[] | null {
  const out = new Map<string, string[]>();
  for (const [a, b] of edges) out.set(a, [...(out.get(a) ?? []), b]);
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    state.set(n, 1);
    stack.push(n);
    for (const m of out.get(n) ?? []) {
      if (state.get(m) === 1) return [...stack.slice(stack.indexOf(m)), m];
      if (!state.has(m)) {
        const c = visit(m);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of nodes) {
    if (!state.has(n)) {
      const c = visit(n);
      if (c) return c;
    }
  }
  return null;
}

// ---------- API shapes ----------

export interface CauseRef {
  monitorId: string;
  monitorKey: string;
  monitorName: string;
  checkId: string;
  checkName: string;
  /** A monitor the viewer may not view: id, key and names are empty ("a monitor you cannot view") */
  hidden?: boolean;
}

/** Stands in for the id of a sub-monitor the viewer may not view (in definitions and exports); saving it keeps the stored reference. */
export const HIDDEN_MONITOR_REF = '(hidden)';

export interface UptimeSet {
  h24: number | null;
  d7: number | null;
  d30: number | null;
}

export interface CheckResultInfo {
  ts: string;
  status: MonitorStatus;
  message: string;
  durationMs?: number | null;
  value?: unknown;
}

export interface CheckState {
  checkId: string;
  name: string;
  type: CheckType;
  key: string;
  critical: boolean;
  enabled: boolean;
  /** After flapping control (what alerts are based on) */
  status: MonitorStatus;
  since: string | null;
  /** Latest raw result */
  last: CheckResultInfo | null;
  lastOkAt: string | null;
  nextCheckAt: string | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  /** Failing parents that explain this check's failure (root causes) */
  causedBy: CauseRef[];
  /** e.g. "Down while 2 dependent checks are healthy – the check itself may be broken" */
  note: string | null;
  uptime: UptimeSet;
  /** Freshness checks (0.13): the peak age and delay Steward observed over the last days, and what it suggests */
  observedDelay?: ObservedDelay | null;
  /** Heartbeat checks */
  heartbeat?: { path: string; secretPrefix: string | null; authMode: string; lastPushAt: string | null; lastPush: unknown };
  /** Sub-monitor checks (hidden: a monitor the viewer may not view – id, key and name are empty) */
  monitorRef?: { id: string; key: string; name: string; hidden?: boolean } | null;
}

export interface MaintenanceWindow {
  id: string;
  monitorId: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  createdBy: string;
  createdAt: string;
  active: boolean;
}

export interface MonitorSummary {
  id: string;
  key: string;
  name: string;
  description: string;
  tags: string[];
  owner: string;
  enabled: boolean;
  isTemplate: boolean;
  templateId: string | null;
  templateVersion: number | null;
  templateOutdated: boolean;
  version: number;
  status: MonitorStatus;
  since: string | null;
  rootCauses: CauseRef[];
  counts: Partial<Record<MonitorStatus, number>>;
  checkCount: number;
  uptime: UptimeSet;
  maintenance: MaintenanceWindow | null;
  acknowledged: { by: string; at: string; comment: string } | null;
  permissions: MonitorPermission[];
  updatedAt: string;
  lastEvaluatedAt: string | null;
  /** Monitors with states (0.13, ADR 0021): the selected state and why the status is what it is; null without states */
  state: MonitorStateInfo | null;
  /** Hours off as expected in the uptime windows (not counted in the uptime); null when never off */
  offHours: UptimeSet | null;
}

export interface MonitorDetail extends MonitorSummary {
  definition: MonitorDefinition;
  acl: AclEntry<MonitorPermission>[];
  templateParams: Record<string, unknown> | null;
  checks: CheckState[];
  /** Monitors that include this one as a sub-monitor */
  usedBy: { id: string; key: string; name: string }[];
  createdAt: string;
}

export interface MonitorHistoryEntry {
  id: number;
  ts: string;
  checkId: string | null;
  status: MonitorStatus;
  /** Monitors with states: the state at this entry (null: none, or before 0.13) */
  state?: string | null;
  previous: MonitorStatus | null;
  message: string;
  causedBy: CauseRef[];
}

export interface MonitorSaveResult {
  monitor: MonitorDetail;
  /** Secrets of new heartbeat checks – shown once */
  secrets: { checkId: string; secret: string; path: string }[];
}

export interface MonitorGateway {
  id: string;
  name: string;
  description: string;
  owner: string;
  enabled: boolean;
  authMode: (typeof HEARTBEAT_AUTH_MODES)[number];
  allowedCidrs: string[];
  /** Check keys this gateway may report (glob with *, empty = any heartbeat check) */
  allowedKeys: string[];
  rateLimitPerMinute: number;
  secretPrefix: string;
  secretRotatedAt: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  acceptedCount: number;
  rejectedCount: number;
  canEdit: boolean;
}

export interface HeartbeatReport {
  key?: string;
  status?: string | boolean;
  value?: unknown;
  ts?: string | number;
  data?: unknown;
}

export interface MonitorTemplateInstanceRequest {
  rows: { params: Record<string, unknown>; name?: string; key?: string }[];
}

/** ${monitor.key}-style placeholders of output targets. */
export function fillPlaceholders(text: string, ctx: Record<string, Record<string, unknown>>): string {
  return text.replace(/\$\{\s*([a-z]+)\.([a-zA-Z]+)\s*\}/g, (m, a: string, b: string) => {
    const v = ctx[a]?.[b];
    return v === undefined || v === null ? '' : String(v);
  });
}

/** A platform reference in a monitor file (import, Git sync), where it is used and which platforms may stand for it. */
export interface MonitorPlatformReference {
  /** The value in the file: a platform name or id */
  ref: string;
  /** Kind the checks and outputs need; null: any platform, or one of several (kinds) */
  kind: string | null;
  /** The kinds the checks and outputs accept, one of them (the repository check: GitHub, GitLab or Forgejo); empty: any platform */
  kinds: string[];
  usedBy: { type: 'check' | 'output'; id: string; name: string }[];
  /** What the reference resolves to without a choice (only a platform the user may use) */
  resolved: { id: string; name: string } | null;
  /** Platforms of those kinds the user may use */
  candidates: { id: string; name: string; kind: string }[];
}
