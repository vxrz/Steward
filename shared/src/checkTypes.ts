/**
 * The monitor check types (0.11.0, docs/ARCHITECTURE.md#adding-a-check-type): one descriptor per type – its name and
 * help, whether it reads a platform, whether it runs itself, the module it belongs to and the fields of a new check.
 * The config schema is the type's entry of `checkSchema` (monitors.ts); the platform kinds it reads come from the kind
 * descriptors (platformKinds.ts). The server's evaluator is in server/src/monitors/checks.ts (CHECK_RUNNERS), the web
 * form in web/src/components/monitors/checks (CHECK_FIELDS); both are typed records, so a type missing there does not
 * compile.
 */

import type { ModuleId } from './modules.js';
import type { CheckOf, CheckType } from './monitors.js';
import { checkTypeKinds } from './platformKinds.js';

/** none: no platform; any: any platform (an HTTP request); kind: a platform of the kinds whose descriptor lists the type */
export type CheckPlatformUse = 'none' | 'any' | 'kind';

export interface CheckTypeDef<T extends CheckType = CheckType> {
  type: T;
  /** English name and help (the web app translates monitors:checkTypes.<type>) */
  label: string;
  help: string;
  /** English name of a new check (the web app translates monitors:newCheck.<type>) */
  defaultName: string;
  platform: CheckPlatformUse;
  /**
   * The kinds a check with these settings reads, when its settings decide them (the freshness check: Insights Hub,
   * InfluxDB, or any platform for an API request as its source); empty: any platform. Without it: the type's kinds.
   */
  kindsOf?: (c: { source?: unknown }) => string[];
  /** Makes a call on its interval (heartbeat and sub-monitor checks are evaluated from stored state) */
  active: boolean;
  /** Offered in the monitor editor only while this module is on (existing checks stay as they are) */
  module?: ModuleId;
  /** The fields of a new check besides id, name and type */
  defaults: Partial<Omit<CheckOf<T>, 'id' | 'name' | 'type'>>;
}

type Defs = { [T in CheckType]: Omit<CheckTypeDef<T>, 'type'> };

const DEFS: Defs = {
  ping: {
    label: 'Ping',
    help: 'ICMP echo via the system ping command; falls back to a TCP connect when ping is not available',
    defaultName: 'Host reachable',
    platform: 'none',
    active: true,
    defaults: { host: '' },
  },
  tcp: {
    label: 'TCP port',
    help: 'Opens a TCP connection to host:port',
    defaultName: 'Port open',
    platform: 'none',
    active: true,
    defaults: { host: '', port: 502 },
  },
  http: {
    label: 'HTTP(S)',
    help: 'Calls a URL: expected status, JSONata condition on the body, response time, TLS certificate expiry',
    defaultName: 'HTTP endpoint',
    platform: 'none',
    active: true,
    defaults: { url: 'https://', method: 'GET' },
  },
  platform: {
    label: 'Platform API',
    help: 'Calls an operation through a configured platform (its authentication, base URL and retries)',
    defaultName: 'Platform API',
    platform: 'any',
    active: true,
    defaults: { platform: '', method: 'GET', path: '/' },
  },
  freshness: {
    label: 'Data freshness',
    help: 'Latest timestamp of a data source must be recent: expected cadence or maximum age (Insights Hub time series, InfluxDB series or an API answer)',
    defaultName: 'Data in Insights Hub',
    platform: 'kind',
    // the platform source is any API call with a JSONata timestamp; the InfluxDB source reads an InfluxDB platform
    kindsOf: (c) => (c.source === 'platform' ? [] : c.source === 'influxdb' ? ['influxdb'] : ['insights-hub']),
    active: true,
    defaults: { source: 'insightsHub', platform: '', assetId: '', aspect: '', variables: [], mode: 'cadence', expectedIntervalSeconds: 60 },
  },
  heartbeat: {
    label: 'Heartbeat (push)',
    help: 'Another system (e.g. an IoT gateway) reports to Steward; missing reports turn the check down',
    defaultName: 'Data reported by the gateway',
    platform: 'none',
    active: false,
    defaults: { mode: 'cadence', expectedIntervalSeconds: 60, authMode: 'token' },
  },
  gatus: {
    label: 'Gatus endpoint',
    help: 'Status of an endpoint monitored by Gatus',
    defaultName: 'Gatus endpoint',
    platform: 'kind',
    active: true,
    defaults: { platform: '', endpointKey: '' },
  },
  checkmk: {
    label: 'Checkmk host or service',
    help: 'Current state of a host or service in Checkmk (OK, WARN, CRIT, UNKNOWN)',
    defaultName: 'Checkmk service',
    platform: 'kind',
    active: true,
    defaults: { platform: '', host: '' },
  },
  prometheus: {
    label: 'Prometheus query',
    help: 'A PromQL query compared with WARN and CRIT levels; with several series the worst one counts',
    defaultName: 'Prometheus query',
    platform: 'kind',
    active: true,
    defaults: { platform: '', query: '', direction: 'above', crit: 90, noData: 'unknown' },
  },
  kubernetes: {
    label: 'Kubernetes deployments',
    help: 'Deployments of a namespace are ready (e.g. 3/3) and no pod is crash-looping',
    defaultName: 'Kubernetes deployments',
    platform: 'kind',
    active: true,
    defaults: { platform: '', namespace: '' },
  },
  git: {
    label: 'Repository pipeline',
    help: 'The pipeline of the default branch on GitHub, GitLab or Forgejo passes; optionally few enough open security alerts',
    defaultName: 'Repository pipeline',
    platform: 'kind',
    active: true,
    defaults: { platform: '', repository: '', failedAs: 'down' },
  },
  kafka: {
    label: 'Kafka topic',
    help: 'New messages on a topic within N minutes, the lag of a consumer group, a group that is stuck, the schema version',
    defaultName: 'Kafka topic',
    platform: 'kind',
    active: true,
    defaults: { platform: '', topic: '', messagesWithinMinutes: 15, quietAs: 'down', stuckMinutes: 15 },
  },
  'kafka-connect': {
    label: 'Kafka Connect connectors',
    help: 'Connectors and their tasks are RUNNING, a task failed for N minutes, the consumer lag of a sink connector, a Debezium connector whose topics got no message for N minutes',
    defaultName: 'Connectors running',
    platform: 'kind',
    active: true,
    defaults: { platform: '', notRunningAs: 'down', pausedAs: 'degraded', failedMinutes: 10, quietAs: 'degraded' },
  },
  confluent: {
    label: 'Confluent Cloud',
    help: 'The Kafka clusters of a Confluent Cloud organisation are provisioned, or its managed connectors and their tasks are RUNNING (a task failed for N minutes)',
    defaultName: 'Confluent connectors running',
    platform: 'kind',
    active: true,
    defaults: { platform: '', target: 'connectors', notRunningAs: 'down', pausedAs: 'degraded', failedMinutes: 10 },
  },
  mqtt: {
    label: 'MQTT topics',
    help: 'Messages on an MQTT topic within N minutes, devices (topics of a pattern) that went silent, connected clients',
    defaultName: 'MQTT topics',
    platform: 'kind',
    active: true,
    defaults: { platform: '', topic: '', mode: 'any', withinMinutes: 15, quietAs: 'down' },
  },
  snowflake: {
    label: 'Snowflake',
    help: 'A Snowflake table changed recently enough, no task of a database failed, or a warehouse stayed within its credits',
    defaultName: 'Snowflake table fresh',
    platform: 'kind',
    active: true,
    defaults: { platform: '', mode: 'freshness', object: '', maxAgeMinutes: 1440, failAs: 'down' },
  },
  database: {
    label: 'Database',
    help: 'A database platform: the connection works (and is read-only), replication lag stays below a limit, or the value of a read-only query is judged against WARN and CRIT levels',
    defaultName: 'Database reachable',
    platform: 'kind',
    active: true,
    defaults: { platform: '', mode: 'connection', direction: 'above', noData: 'unknown' },
  },
  dynamodb: {
    label: 'DynamoDB table',
    help: 'A DynamoDB table on an AWS platform: the newest item per partition key is recent enough, the table had writes within the window (CloudWatch), or its status, point-in-time recovery and time to live',
    defaultName: 'DynamoDB table fresh',
    platform: 'kind',
    active: true,
    defaults: {
      platform: '',
      table: '',
      mode: 'newestItem',
      partitionKeyType: 'S',
      partitionValues: [],
      timeFormat: 'auto',
      freshnessMode: 'cadence',
      expectedIntervalSeconds: 300,
      activeTable: 'required',
      pointInTimeRecovery: 'report',
      timeToLive: 'report',
      failAs: 'degraded',
    },
  },
  'db-schema': {
    label: 'Database schema changes',
    help: 'The schema snapshots of a database platform or a system: no change, or no breaking change, within the last N hours; optionally reads the platform first',
    defaultName: 'No breaking schema change',
    platform: 'kind',
    active: true,
    defaults: { platform: '', mode: 'breaking', withinHours: 24, read: false, noData: 'unknown' },
  },
  cost: {
    label: 'Cost change',
    help: 'The costs of a service, application, team or platform: up by more than a percentage or an amount compared with the month before',
    defaultName: 'Costs not rising',
    platform: 'none',
    active: true,
    module: 'costs',
    defaults: { scope: 'service', target: '', period: 'month', maxIncreasePct: 20, failAs: 'degraded', noData: 'unknown' },
  },
  'data-contract': {
    label: 'Data contract',
    help: 'An ODCS data contract: its test through the data contract service passes (warnings degrade), or Steward’s own checks – owner, last test, columns of linked datasets and tables – find nothing',
    defaultName: 'Data contract holds',
    platform: 'none',
    active: true,
    module: 'dataContracts',
    defaults: { contract: '', mode: 'test', testedWithinDays: 7, failAs: 'down', warningAs: 'degraded' },
  },
  'data-element': {
    label: 'Data element',
    help: 'An element of a data product (a Snowflake table, dynamic table, task or schema, a Kafka topic or bundle): its data is fresh by metadata, or its columns match the data contract of its output port',
    defaultName: 'Data element fresh',
    platform: 'none',
    active: true,
    module: 'dataProducts',
    defaults: { element: '', mode: 'freshness', maxAgeMinutes: 1440, each: 'any', failAs: 'down', warningAs: 'degraded' },
  },
  'dependency-track': {
    label: 'Vulnerabilities (Dependency-Track)',
    help: 'A Dependency-Track project has no more open critical (or high) findings than allowed and no failing policy violation',
    defaultName: 'No critical vulnerabilities',
    platform: 'kind',
    active: true,
    defaults: { platform: '', project: '', maxCritical: 0, policyFail: true, failAs: 'down' },
  },
  'version-behind': {
    label: 'Version behind',
    help: 'The tech stack of an application is up to date: degraded when more minor releases or days behind than allowed, down when a major release behind or the release cycle reached its end of life (version watch)',
    defaultName: 'Tech stack up to date',
    platform: 'none',
    active: true,
    module: 'versionWatch',
    defaults: { application: '', maxMinors: 2, majorAs: 'down', eolAs: 'down' },
  },
  entra: {
    label: 'Entra ID (Microsoft Graph)',
    help: 'App registrations whose secrets or certificates expire within N days, or the Microsoft 365 service health',
    defaultName: 'App credentials valid',
    platform: 'kind',
    active: true,
    defaults: { platform: '', mode: 'app-credentials', withinDays: 30, downWithinDays: 7 },
  },
  'privilege-vault': {
    label: 'Vault hygiene (IBM Verify Privilege Vault)',
    help: 'Secrets of IBM Verify Privilege Vault: failed heartbeats, passwords not rotated or expired, automatic changing off, no owner, privileged secrets without checkout or approval',
    defaultName: 'Vault hygiene',
    platform: 'kind',
    active: true,
    defaults: { platform: '', maxAgeDays: 90, privilegedFolders: [], privilegedTemplates: [], maxFindings: 0, failAs: 'degraded' },
  },
  'page-watch': {
    label: 'Page watch (changedetection.io)',
    help: 'Watches of changedetection.io: a page changed within the last N hours (informational or degraded), a watch whose last check failed or that was not checked for too long',
    defaultName: 'Vendor pages watched',
    platform: 'kind',
    active: true,
    module: 'changedetection',
    defaults: { platform: '', changedWithinHours: 24, changedAs: 'up', failingAs: 'degraded', pausedAs: 'ignore' },
  },
  monitor: {
    label: 'Sub-monitor',
    help: 'The aggregated status of another monitor (evaluated on its own schedule)',
    defaultName: 'Sub-monitor',
    platform: 'none',
    active: false,
    defaults: { monitor: '' },
  },
};

/** Every check type's descriptor. */
export const CHECK_TYPE_DEFS: { readonly [T in CheckType]: CheckTypeDef<T> } = Object.fromEntries(
  Object.entries(DEFS).map(([type, d]) => [type, { type, ...d }]),
) as { [T in CheckType]: CheckTypeDef<T> };

const defOf = (type: string): CheckTypeDef | undefined => (Object.hasOwn(CHECK_TYPE_DEFS, type) ? CHECK_TYPE_DEFS[type as CheckType] : undefined);

/** English name and help per check type. */
export const CHECK_TYPE_INFO: Readonly<Record<CheckType, { label: string; help: string }>> = Object.fromEntries(
  Object.entries(DEFS).map(([type, d]) => [type, { label: d.label, help: d.help }]),
) as Record<CheckType, { label: string; help: string }>;

/** Whether a check type makes a call on its interval (not heartbeat or sub-monitor). */
export const isActiveCheckType = (type: string): boolean => defOf(type)?.active ?? false;

/**
 * The platform kinds a check (or a check type, without settings) may read: one of these; empty: any platform, or none.
 * GitHub, GitLab and Forgejo for the repository check; Insights Hub for the freshness check – InfluxDB with the InfluxDB
 * source, any platform with an API request as its source.
 */
export function checkPlatformKinds(c: { type: string; source?: unknown }): string[] {
  const d = defOf(c.type);
  if (d?.platform !== 'kind') return [];
  return d.kindsOf ? d.kindsOf(c) : checkTypeKinds(c.type);
}
