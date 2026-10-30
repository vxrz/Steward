/**
 * Monitors: composable, dependency-aware health checks.
 *
 * A monitor is a small directed graph of checks. Every check runs on its own
 * interval; links never stop a check from running (unless `mode: hard`), they
 * are used to infer root causes and to suppress follow-up alerts.
 */
import { notifyPolicySchema } from './notifyPolicy.js';
import { z } from 'zod';
import type { AclEntry } from './api.js';
import { boundedRecord } from './zodLimits.js';
import { tagInput } from './tags.js';

// ---------- statuses ----------

export const MONITOR_STATUSES = ['up', 'degraded', 'down', 'unknown', 'blocked', 'maintenance'] as const;
export type MonitorStatus = (typeof MONITOR_STATUSES)[number];

/** Numeric codes used by Prometheus, Zabbix and other number-only consumers. */
export const MONITOR_STATUS_CODE: Record<MonitorStatus, number> = { up: 0, degraded: 1, down: 2, unknown: 3, blocked: 4, maintenance: 5 };

export const MONITOR_STATUS_INFO: Record<MonitorStatus, string> = {
  up: 'Healthy',
  degraded: 'Warning threshold reached',
  down: 'Failing',
  unknown: 'No data yet, or the check itself could not run',
  blocked: 'Not evaluated because a hard dependency is down',
  maintenance: 'In a maintenance window – alerts are silenced',
};

/** Ranking used to aggregate statuses ("worst" wins). */
const RANK: Record<MonitorStatus, number> = { up: 0, maintenance: 1, blocked: 2, unknown: 3, degraded: 4, down: 5 };
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
  'mqtt',
  'monitor',
] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

export const CHECK_TYPE_INFO: Record<CheckType, { label: string; help: string }> = {
  ping: { label: 'Ping', help: 'ICMP echo via the system ping command; falls back to a TCP connect when ping is not available' },
  tcp: { label: 'TCP port', help: 'Opens a TCP connection to host:port' },
  http: { label: 'HTTP(S)', help: 'Calls a URL: expected status, JSONata condition on the body, response time, TLS certificate expiry' },
  platform: { label: 'Platform API', help: 'Calls an operation through a configured platform (its authentication, base URL and retries)' },
  freshness: {
    label: 'Data freshness',
    help: 'Latest timestamp of a data source must be recent: expected cadence or maximum age (Insights Hub time series preset)',
  },
  heartbeat: { label: 'Heartbeat (push)', help: 'Another system (e.g. an IoT gateway) reports to Steward; missing reports turn the check down' },
  gatus: { label: 'Gatus endpoint', help: 'Status of an endpoint monitored by Gatus' },
  checkmk: { label: 'CheckMk host or service', help: 'Current state of a host or service in CheckMk (OK, WARN, CRIT, UNKNOWN)' },
  kubernetes: { label: 'Kubernetes deployments', help: 'Deployments of a namespace are ready (e.g. 3/3) and no pod is crash-looping' },
  kafka: { label: 'Kafka topic', help: 'New messages on a topic within N minutes, the lag of a consumer group, a group that is stuck, the schema version' },
  mqtt: { label: 'MQTT topics', help: 'Messages on an MQTT topic within N minutes, devices (topics of a pattern) that went silent, connected clients' },
  git: {
    label: 'Repository pipeline',
    help: 'The pipeline of the default branch on GitHub, GitLab or Forgejo passes; optionally few enough open security alerts',
  },
  prometheus: { label: 'Prometheus query', help: 'A PromQL query compared with WARN and CRIT levels; with several series the worst one counts' },
  monitor: { label: 'Sub-monitor', help: 'The aggregated status of another monitor (evaluated on its own schedule)' },
};

export const LINK_MODES = ['soft', 'hard'] as const;
export type LinkMode = (typeof LINK_MODES)[number];
export const AGGREGATE_RULES = ['worst', 'critical', 'quorum'] as const;
export const FRESHNESS_MODES = ['cadence', 'maxAge'] as const;
export const HEARTBEAT_AUTH_MODES = ['token', 'hmac', 'either'] as const;
export const OUTPUT_TYPES = ['notification', 'webhook', 'gatus', 'zabbix', 'process'] as const;
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
};

const freshnessFields = {
  mode: z.enum(FRESHNESS_MODES).default('cadence'),
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
};

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
  }),
  z.object({
    ...outputBase,
    type: z.literal('gatus'),
    platform: platformRef,
    endpointKey: z.string().min(1).max(300),
    /** Name of the platform credential holding the external endpoint token (default externalToken) */
    tokenSecret: z.string().max(100).optional(),
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
    /** code: 0 up, 1 degraded, 2 down, 3 unknown, 4 blocked, 5 maintenance; text: the status word */
    value: z.enum(['code', 'text']).default('code'),
  }),
  z.object({
    ...outputBase,
    type: z.literal('process'),
    processId: z.string().min(1).max(200),
    bindings: boundedRecord(z.string(), 100).default({}),
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
    if (c.type === 'freshness' && c.source === 'platform') {
      if (!c.path) issues.push({ path: `checks.${i}.path`, message: 'platform freshness needs the path', checkId: c.id });
      if (!c.timestamp) issues.push({ path: `checks.${i}.timestamp`, message: 'platform freshness needs the timestamp expression', checkId: c.id });
    }
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
  return issues;
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
  /** Kind the checks and outputs need; null: any platform */
  kind: string | null;
  usedBy: { type: 'check' | 'output'; id: string; name: string }[];
  /** What the reference resolves to without a choice (only a platform the user may use) */
  resolved: { id: string; name: string } | null;
  /** Platforms of that kind the user may use */
  candidates: { id: string; name: string; kind: string }[];
}
