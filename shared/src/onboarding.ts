/**
 * Onboarding (v0.4.0): template bundles ("set up together"), what to do next with a platform (the setup wizard's last
 * step and the platform page's "Get started" panel), the health of a platform (its last connection test and an
 * optional periodic test), Kafka topics by prefix and the Confluent Cloud access source.
 */

import { GIT_PLATFORM_KINDS } from './git.js';

// ---------- template bundles ----------

/** A platform a bundle needs: the processes, dashboards and monitors of the bundle are bound to one platform per entry. */
export interface TemplateBundlePlatform {
  /** Name of the binding inside the bundle (`hub`, `git`) */
  key: string;
  label: string;
  /** Platform kinds that fit (one of them) */
  kinds: string[];
}

/** What exists already of a bundle item (re-running a setup offers update or skip for these). */
export interface TemplateBundleExisting {
  id: string;
  name: string;
}

export interface TemplateBundleProcess {
  /** Process template id (examples/processes file name without .yaml) */
  template: string;
  name: string;
  /** The schedule the setup creates (disabled), from the template's recommended schedule or the bundle; null: none */
  schedule: { cron: string; text: string } | null;
  /** The bundle platform each connection slot of the process is bound to (slot → bundle platform key) */
  connections: Record<string, string>;
  existing: TemplateBundleExisting | null;
  /** An existing schedule of this process made by a bundle setup (kept on a re-run) */
  existingSchedule: TemplateBundleExisting | null;
}

export interface TemplateBundleDashboard {
  template: string;
  name: string;
  existing: TemplateBundleExisting | null;
}

export interface TemplateBundleMonitor {
  /** Example file in examples/monitors */
  file: string;
  name: string;
  key: string | null;
  /** Monitors are optional: the setup asks for them */
  optional: boolean;
  existing: TemplateBundleExisting | null;
}

export interface TemplateBundle {
  id: string;
  name: string;
  description: string;
  tags: string[];
  platforms: TemplateBundlePlatform[];
  /** Every platform kind that fits one of the bundle's platforms, sorted (for "matches your platforms") */
  kinds: string[];
  processes: TemplateBundleProcess[];
  dashboards: TemplateBundleDashboard[];
  monitors: TemplateBundleMonitor[];
  /** `# steward-min-version` of the bundle file, or null */
  minVersion: string | null;
  /** Problems of the bundle file (a template it names is missing …); a bundle with problems can still be set up partly */
  problems: string[];
}

export type TemplateBundleExistingMode = 'update' | 'skip';

export interface TemplateBundleSetupRequest {
  /** Bundle platform key → platform id */
  bindings: Record<string, string>;
  /** What happens to processes and dashboards that exist already (schedules and monitors are always kept) */
  existing?: TemplateBundleExistingMode;
  /** Create the optional monitors */
  monitors?: boolean;
  /** Start one dry run per process (default true) */
  dryRuns?: boolean;
}

export type TemplateBundleItemType = 'process' | 'dashboard' | 'schedule' | 'monitor' | 'dryRun';

export interface TemplateBundleSetupItem {
  type: TemplateBundleItemType;
  /** The template, example file or process the item comes from */
  source: string;
  name: string;
  action: 'created' | 'updated' | 'skipped' | 'kept' | 'started' | 'failed';
  /** Id of the process, dashboard, schedule, monitor or run */
  id: string | null;
  /** In-app link */
  link: string | null;
  message?: string;
}

export interface TemplateBundleSetupResult {
  bundle: { id: string; name: string };
  items: TemplateBundleSetupItem[];
  /** Schedules and monitors made by this setup that are off – the "turn on" step */
  turnOn: { schedules: string[]; monitors: string[] };
}

// ---------- what's next with a platform ----------

export interface PlatformGetStarted {
  kind: string;
  templates: { id: string; name: string; recommendedSchedule: string | null }[];
  bundles: { id: string; name: string; description: string }[];
  /** Monitor check types that read this kind of platform */
  monitorTypes: string[];
  /** Example monitors (examples/monitors) for this kind */
  monitorExamples: { file: string; name: string }[];
  /** Access check sources that read this kind of platform directly */
  accessSources: string[];
  /** Whether the MCP gateway can expose the platform's operations to AI assistants */
  mcp: boolean;
}

/** Monitor check types and the platform kind they read (types not listed: any or no platform). */
export const MONITOR_TYPE_KINDS: Readonly<Record<string, readonly string[]>> = {
  freshness: ['insights-hub'],
  gatus: ['gatus'],
  checkmk: ['checkmk'],
  prometheus: ['prometheus'],
  kubernetes: ['kubernetes'],
  git: GIT_PLATFORM_KINDS,
  kafka: ['kafka'],
  mqtt: ['mqtt'],
  snowflake: ['snowflake'],
  'dependency-track': ['dependency-track'],
  entra: ['microsoft-graph'],
  'privilege-vault': ['privilege-vault'],
};

/** Platform kinds without an HTTP API of their own: the "platform" monitor check (an HTTP request) does not fit them. */
export const NON_HTTP_KINDS: ReadonlySet<string> = new Set(['kafka', 'mqtt', 'aws', 'snowflake', 'teams', 'zabbix']);

// ---------- platform health ----------

/** Allowed intervals of the periodic connection test (minutes). */
export const PLATFORM_HEALTH_INTERVALS = [15, 30, 60, 180, 360, 720, 1440] as const;

export interface PlatformHealth {
  platformId: string;
  /** The latest connection test (by hand or periodic), from the audit log */
  lastTest: { at: string; ok: boolean; message: string; by: string } | null;
  /** Periodic connection test: off by default; failures notify the platform's managers (event platform.failing) */
  periodic: { enabled: boolean; intervalMinutes: number; nextAt: string | null; updatedBy: string | null; updatedAt: string | null };
  /** Since when the periodic test fails (null: it passes or never ran) */
  failingSince: string | null;
}

// ---------- Kafka topics by prefix ----------

export interface TopicPrefixListing {
  prefix: string;
  topics: { name: string; added: boolean }[];
  /** More topics under the prefix than listed */
  truncated: boolean;
}

/** "Keep in sync": topics under a prefix that are not components of the application yet are offered. */
export interface TopicPrefixSync {
  id: string;
  applicationId: string;
  platformId: string;
  platformName: string | null;
  prefix: string;
  environment: string;
  /** Topics under the prefix that are not components yet (and not dismissed) */
  offered: string[];
  checkedAt: string | null;
  error: string | null;
  createdBy: string;
  createdAt: string;
}

export const TOPIC_PREFIX_LIMITS = {
  /** Topics listed (and added) at once */
  maxTopics: 500,
  /** Prefixes kept in sync per application */
  syncsPerApplication: 20,
  /** A synced prefix is read again after (hours) */
  refreshHours: 24,
} as const;

// ---------- Confluent Cloud ----------

export const CONFLUENT_KIND = 'confluent-cloud';

/**
 * A Confluent Cloud resource name (CRN) the role bindings are read for: the organisation, an environment or a cluster,
 * e.g. crn://confluent.cloud/organization=1111aaaa-…/environment=env-abc12/cloud-cluster=lkc-xyz89. Checked by
 * confluentCrnProblem (a scan, no regular expression).
 */
export const CONFLUENT_CRN_PREFIX = 'crn://confluent.cloud/';

/** Segment names of a CRN Steward accepts, in order (the first must be organization). */
const CRN_SEGMENTS = [
  'organization',
  'environment',
  'cloud-cluster',
  'kafka',
  'topic',
  'group',
  'schema-registry',
  'subject',
  'service-account',
  'identity-provider',
];

const crnValueChar = (c: string) =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-' || c === '_' || c === '.' || c === '*';

/** Why a CRN pattern is not accepted, or null. At most 500 characters, segments name=value, values of letters, digits, - _ . *. */
export function confluentCrnProblem(crn: string): string | null {
  if (crn.length > 500) return 'The CRN is longer than 500 characters';
  if (!crn.startsWith(CONFLUENT_CRN_PREFIX)) return `A Confluent Cloud CRN starts with ${CONFLUENT_CRN_PREFIX}`;
  const parts = crn.slice(CONFLUENT_CRN_PREFIX.length).split('/');
  if (!parts.length || !parts[0]) return 'The CRN names the organization (organization=<id>)';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const eq = p.indexOf('=');
    if (eq <= 0 || eq === p.length - 1) return `"${p.slice(0, 60)}" is not name=value`;
    const name = p.slice(0, eq);
    const value = p.slice(eq + 1);
    if (i === 0 && name !== 'organization') return 'The CRN starts with organization=<id>';
    if (!CRN_SEGMENTS.includes(name)) return `Unknown CRN part "${name.slice(0, 40)}"`;
    if (![...value].every(crnValueChar)) return `The value of ${name} has characters other than letters, digits, - _ . *`;
  }
  return null;
}
