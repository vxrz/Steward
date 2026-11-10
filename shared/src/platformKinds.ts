/**
 * The platform kinds (0.11.0, docs/ARCHITECTURE.md#adding-a-platform-kind): one descriptor per built-in connector –
 * what it is, which monitor checks, outputs and process steps read it, how its connection is tested, which access
 * check source and cost source read it, and how far it is (maturity). Everything else derives from this table: the
 * "Get started" panel, the check-type → kind map of the monitor editor and the server, the connector groups of the
 * setup wizard, the hints of the connection test.
 *
 * The wire keeps `kind: string`: a platform may have an own connector type (imported or defined by hand), which has no
 * descriptor here and gets the generic behaviour (an HTTP API, tested with GET on its test path).
 */

import type { AccessCheckSource } from './compliance.js';
import type { CostSource } from './costs.js';
import type { KindMaturity } from './modules.js';
import type { CheckType, OutputType } from './monitors.js';
import type { StepType } from './process.js';

/** The groups of the setup wizard's connector list (kinds of no group, and own connector types: "Other"). */
export const PLATFORM_KIND_GROUPS = ['industrial', 'monitoring', 'cloud', 'databases', 'development', 'ai', 'messaging', 'other'] as const;
export type PlatformKindGroup = (typeof PLATFORM_KIND_GROUPS)[number];

/** How "Test connection" works: GET on the test path (http), or the connector's own test (own: server/src/platforms/drivers.ts). */
export type ConnectionTestKind = 'http' | 'own';

export interface PlatformKindDef {
  id: string;
  /** The product's name (English; product names are not translated) */
  label: string;
  /** Group of the setup wizard's connector list */
  group: PlatformKindGroup;
  /** An HTTP API of its own: the "platform" monitor check (an HTTP request) and the MCP gateway fit it */
  http: boolean;
  /** The test path answers JSON: an HTML page or other text there fails the connection test */
  jsonApi: boolean;
  /** The API base URL the kind expects, for the hints of a failing connection test */
  apiExample?: string;
  connectionTest: ConnectionTestKind;
  /** Monitor check types that read this kind (besides "platform" for every kind with an HTTP API) */
  checkTypes: readonly CheckType[];
  /** Monitor output types that write to this kind */
  outputTypes: readonly OutputType[];
  /** Process step types whose connection must be of this kind (the http step works with every HTTP API) */
  stepTypes: readonly StepType[];
  /** The access check source that reads this kind directly (the dataset source works with every platform) */
  accessSource: AccessCheckSource | null;
  /** How its costs are read: its connector, or FOCUS files (every kind without a cost reader) */
  costSource: CostSource;
  maturity: KindMaturity;
}

type KindInput = Pick<PlatformKindDef, 'label' | 'group' | 'maturity'> & Partial<Omit<PlatformKindDef, 'id' | 'label' | 'group' | 'maturity'>>;

const beta = { maturity: 'beta', verified: 'mock' } as const;
const preview = { maturity: 'preview', verified: 'mock' } as const;
const gitApi = { group: 'development', jsonApi: true, checkTypes: ['git'], accessSource: 'git', maturity: beta } as const;

/**
 * Maturity (docs/MODULES.md): conservative – a connector only tested against Steward's mock server is at most beta;
 * connectors from 0.9.0 and later are preview.
 */
const KINDS = {
  // the generic HTTP/OpenAPI kind: the engine's own client, no product behind it
  generic: { label: 'Generic HTTP API', group: 'other', maturity: { maturity: 'stable', verified: 'none' } },
  // PostgreSQL, MariaDB/MySQL and SQL Server run against real servers in CI (.github/workflows/ci.yml)
  database: {
    label: 'Database',
    group: 'databases',
    http: false,
    connectionTest: 'own',
    checkTypes: ['database', 'db-schema'],
    stepTypes: ['query'],
    maturity: { maturity: 'stable', verified: 'real' },
  },
  // the flagship, but its API assumptions are not yet checked on a real tenant (#8)
  'insights-hub': {
    label: 'Siemens Insights Hub',
    group: 'industrial',
    jsonApi: true,
    checkTypes: ['freshness'],
    accessSource: 'insights-hub',
    maturity: beta,
  },
  'industrial-edge-management': { label: 'Siemens Industrial Edge Management', group: 'industrial', jsonApi: true, maturity: beta },
  mqtt: { label: 'MQTT broker', group: 'industrial', http: false, connectionTest: 'own', checkTypes: ['mqtt'], maturity: beta },
  gatus: { label: 'Gatus', group: 'monitoring', jsonApi: true, checkTypes: ['gatus'], outputTypes: ['gatus'], maturity: beta },
  checkmk: {
    label: 'Checkmk',
    group: 'monitoring',
    jsonApi: true,
    apiExample: 'https://HOST/SITE/check_mk/api/1.0',
    checkTypes: ['checkmk'],
    maturity: beta,
  },
  prometheus: {
    label: 'Prometheus',
    group: 'monitoring',
    jsonApi: true,
    apiExample: 'https://HOST, Mimir/Cortex …/prometheus',
    checkTypes: ['prometheus'],
    maturity: beta,
  },
  // no HTTP API Steward calls: values go to it with the trapper protocol or JSON-RPC (monitor output)
  zabbix: { label: 'Zabbix', group: 'monitoring', http: false, outputTypes: ['zabbix'], maturity: beta },
  aws: {
    label: 'AWS account',
    group: 'cloud',
    http: false,
    connectionTest: 'own',
    checkTypes: ['dynamodb'],
    accessSource: 'aws',
    costSource: 'aws',
    maturity: beta,
  },
  kubernetes: { label: 'Kubernetes', group: 'cloud', jsonApi: true, apiExample: 'https://HOST:6443', checkTypes: ['kubernetes'], maturity: beta },
  snowflake: {
    label: 'Snowflake',
    group: 'cloud',
    http: false,
    connectionTest: 'own',
    checkTypes: ['snowflake'],
    accessSource: 'snowflake',
    costSource: 'snowflake',
    maturity: beta,
  },
  kafka: { label: 'Apache Kafka', group: 'cloud', http: false, connectionTest: 'own', checkTypes: ['kafka'], maturity: beta },
  'microsoft-graph': {
    label: 'Microsoft Graph',
    group: 'cloud',
    jsonApi: true,
    connectionTest: 'own',
    checkTypes: ['entra'],
    accessSource: 'entra',
    maturity: beta,
  },
  github: { label: 'GitHub', apiExample: 'https://api.github.com or https://HOST/api/v3', ...gitApi },
  gitlab: { label: 'GitLab', apiExample: 'https://HOST/api/v4', ...gitApi },
  forgejo: { label: 'Forgejo / Gitea', apiExample: 'https://HOST/api/v1', ...gitApi },
  'dependency-track': {
    label: 'Dependency-Track',
    group: 'development',
    jsonApi: true,
    apiExample: 'the API server, not the UI',
    checkTypes: ['dependency-track'],
    maturity: beta,
  },
  'endoflife-date': { label: 'endoflife.date', group: 'development', jsonApi: true, maturity: beta },
  'container-registry': { label: 'Container registry', group: 'development', connectionTest: 'own', maturity: beta },
  // not in a group of the connector list (Other), as before 0.11
  'privilege-vault': {
    label: 'IBM Verify Privilege Vault',
    group: 'other',
    jsonApi: true,
    apiExample: 'https://HOST/SecretServer or https://TENANT.secretservercloud.com',
    connectionTest: 'own',
    checkTypes: ['privilege-vault'],
    accessSource: 'privilege-vault',
    maturity: beta,
  },
  'llm-gateway': { label: 'LLM gateway', group: 'ai', connectionTest: 'own', stepTypes: ['ai'], costSource: 'ai', maturity: beta },
  // 0.9.0 and later
  'kafka-connect': { label: 'Kafka Connect', group: 'cloud', checkTypes: ['kafka-connect'], maturity: preview },
  'confluent-cloud': {
    label: 'Confluent Cloud',
    group: 'cloud',
    jsonApi: true,
    apiExample: 'https://api.confluent.cloud',
    checkTypes: ['confluent'],
    accessSource: 'confluent',
    costSource: 'confluent',
    maturity: preview,
  },
  datacontract: { label: 'Data contract service', group: 'databases', maturity: preview },
  changedetection: { label: 'changedetection.io', group: 'monitoring', checkTypes: ['page-watch'], maturity: preview },
  // the Workflows URL of a channel, kept as a credential: the Teams card of a webhook output posts to it
  teams: { label: 'Microsoft Teams channel', group: 'messaging', http: false, maturity: preview },
} as const satisfies Record<string, KindInput>;

export type PlatformKind = keyof typeof KINDS;
export const PLATFORM_KIND_IDS = Object.keys(KINDS) as PlatformKind[];

const fill = (id: string, k: KindInput): PlatformKindDef => ({
  id,
  http: true,
  jsonApi: false,
  connectionTest: 'http',
  checkTypes: [],
  outputTypes: [],
  stepTypes: [],
  accessSource: null,
  costSource: 'focus',
  ...k,
});

/** Every built-in platform kind, in the order of the table. */
export const PLATFORM_KINDS: Readonly<Record<PlatformKind, PlatformKindDef>> = Object.fromEntries(
  Object.entries(KINDS).map(([id, k]) => [id, fill(id, k as KindInput)]),
) as Record<PlatformKind, PlatformKindDef>;
export const PLATFORM_KIND_LIST: readonly PlatformKindDef[] = PLATFORM_KIND_IDS.map((id) => PLATFORM_KINDS[id]);

export const isPlatformKind = (k: unknown): k is PlatformKind => typeof k === 'string' && Object.hasOwn(KINDS, k);

/** The descriptor of a built-in kind; undefined for an own connector type. */
export const platformKind = (k: string | null | undefined): PlatformKindDef | undefined => (isPlatformKind(k) ? PLATFORM_KINDS[k] : undefined);

/** Whether a kind has an HTTP API of its own (own connector types do). */
export const hasHttpApi = (k: string): boolean => platformKind(k)?.http ?? true;

/** The kinds a monitor check type reads; empty: any platform, or none (http, ping, cost, …). */
export function checkTypeKinds(type: string): string[] {
  return PLATFORM_KIND_LIST.filter((k) => (k.checkTypes as readonly string[]).includes(type)).map((k) => k.id);
}

/** The kinds a monitor output type writes to; empty: any platform, or none. */
export function outputTypeKinds(type: string): string[] {
  return PLATFORM_KIND_LIST.filter((k) => (k.outputTypes as readonly string[]).includes(type)).map((k) => k.id);
}

/** Monitor check types that read a kind: its own, then "platform" (an HTTP request) for every HTTP API. */
export function checkTypesOfKind(k: string): string[] {
  const own = [...(platformKind(k)?.checkTypes ?? [])];
  return hasHttpApi(k) ? [...own, 'platform'] : own;
}

/** The access check source that reads a kind directly, if any. */
export const accessSourceOfKind = (k: string | null | undefined): AccessCheckSource | null => platformKind(k)?.accessSource ?? null;

/** The kinds an access check source reads (empty for the dataset source: every platform). */
export function accessSourceKinds(source: string): string[] {
  return PLATFORM_KIND_LIST.filter((k) => k.accessSource === source).map((k) => k.id);
}

/** How the costs of a kind are read: its connector, or FOCUS files. */
export const costSourceOfKind = (k: string): CostSource => platformKind(k)?.costSource ?? 'focus';

/** The maturity of a built-in kind; own connector types have none. */
export const kindMaturity = (k: string | null | undefined): KindMaturity | undefined => platformKind(k)?.maturity;
