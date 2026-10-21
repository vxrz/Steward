import type { Column, ProcessDefinition } from './process.js';

// ---------- Platforms ----------

export type AuthType =
  | 'none'
  | 'basic'
  | 'bearer'
  | 'apiKey'
  | 'oauth2_client_credentials'
  | 'token_request';

export interface AuthConfig {
  type: AuthType;
  /** oauth2: token endpoint (template, scope: vars, secrets) */
  tokenUrl?: string;
  scope?: string;
  /** oauth2: send client credentials as Basic header or in the form body */
  clientAuth?: 'basic' | 'body';
  extraParams?: Record<string, string>;
  /** apiKey */
  apiKeyIn?: 'header' | 'query';
  apiKeyName?: string;
  /** token_request: custom login call */
  request?: {
    method: 'POST' | 'GET' | 'PUT';
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
    bodyType?: 'json' | 'form';
  };
  /** token_request: expression for the token in the response body */
  tokenPath?: string;
  /** token_request: expression for lifetime in seconds (optional) */
  expiresInPath?: string;
  /** Header added to API calls; template with {{ token }} */
  headerName?: string;
  headerValue?: string;
}

export interface HttpOptions {
  /** Accept self-signed certificates (e.g. on-prem Industrial Edge Management). */
  insecureTls?: boolean;
  /** Extra CA certificate (PEM). */
  caPem?: string;
  /** Proxy URL; empty = use HTTPS_PROXY / NO_PROXY environment. 'none' = direct. */
  proxy?: string;
  timeoutMs?: number;
  defaultHeaders?: Record<string, string>;
}

export interface PlatformConfig {
  auth: AuthConfig;
  /** Non-secret variables, e.g. tenant, region. Usable as {{ vars.tenant }} in URLs. */
  variables: Record<string, string>;
  http: HttpOptions;
  /** Optional URL used by "Test connection" (relative to base URL). */
  testPath?: string;
  /** Browser automation start URL if different from base URL. */
  portalUrl?: string;
}

export interface Platform {
  id: string;
  name: string;
  kind: string;
  description: string;
  baseUrl: string;
  environment: string;
  config: PlatformConfig;
  /** Names of stored secrets (values are never returned). */
  secretKeys: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PlatformPreset {
  kind: string;
  label: string;
  description: string;
  baseUrl: string;
  config: PlatformConfig;
  secretFields: { key: string; label: string; help?: string }[];
  docs: { title: string; url: string }[];
}

export interface ApiOperation {
  specId: string;
  operationId?: string;
  method: string;
  path: string;
  summary?: string;
  tag?: string;
  parameters?: { name: string; in: string; required?: boolean; description?: string }[];
  hasBody?: boolean;
}

export interface PlatformSpec {
  id: string;
  platformId: string;
  name: string;
  format: string;
  title?: string;
  version?: string;
  serverUrl?: string;
  operationCount: number;
  createdAt: string;
}

export interface PlatformDoc {
  id: string;
  platformId: string;
  title: string;
  kind: 'note' | 'link' | 'file';
  content?: string;
  url?: string;
  filename?: string;
  mime?: string;
  size?: number;
  createdAt: string;
}

// ---------- Processes ----------

export interface ProcessSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  currentVersion: number;
  updatedAt: string;
  lastRun?: { id: string; status: RunStatus; startedAt: string } | null;
}

export interface ProcessDetail extends ProcessSummary {
  definition: ProcessDefinition;
  definitionHash: string;
}

export interface ProcessVersion {
  version: number;
  hash: string;
  author: string;
  comment: string;
  createdAt: string;
}

export interface ProcessTemplate {
  id: string;
  name: string;
  description: string;
  tags: string[];
  definition: ProcessDefinition;
}

// ---------- Runs ----------

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type StepStatus = 'running' | 'succeeded' | 'failed' | 'skipped' | 'waiting' | 'dryrun';

export interface RunSummary {
  id: string;
  processId: string;
  processName: string;
  processVersion: number;
  status: RunStatus;
  dryRun: boolean;
  trigger: 'manual' | 'schedule' | 'resume';
  scheduleId?: string | null;
  actor: string;
  startedAt: string;
  finishedAt?: string | null;
  error?: string | null;
  stats: RunStats;
}

export interface RunStats {
  steps: number;
  failedSteps: number;
  writes: number;
  skippedWrites: number;
  checksPassed: number;
  checksFailed: number;
  openTasks: number;
}

export interface RunStepRecord {
  id: number;
  key: string;
  parentKey: string | null;
  stepId: string;
  type: string;
  name: string;
  status: StepStatus;
  startedAt: string;
  finishedAt?: string | null;
  durationMs?: number | null;
  summary?: string | null;
  error?: string | null;
  /** Resolved request / configuration (secrets redacted). */
  input?: unknown;
  /** Output preview (truncated). Use the step endpoint for full output. */
  output?: unknown;
  outputTruncated?: boolean;
  seq: number;
}

export interface RunLog {
  id: number;
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  stepKey?: string | null;
  message: string;
  data?: unknown;
}

export interface RunArtifact {
  id: string;
  runId: string;
  stepKey: string;
  kind: 'screenshot' | 'file';
  name: string;
  mime: string;
  sha256: string;
  size: number;
  createdAt: string;
}

export interface RunReportSection {
  stepKey: string;
  title: string;
  text?: string;
  columns?: string[];
  rows?: unknown[][];
}

export interface RunDetail extends RunSummary {
  inputs: Record<string, unknown>;
  bindings: Record<string, { platformId: string; platformName: string; baseUrl: string }>;
  definitionHash: string;
  steps: RunStepRecord[];
  logs: RunLog[];
  tasks: TaskRecord[];
  artifacts: RunArtifact[];
  reports: RunReportSection[];
}

export interface StartRunRequest {
  processId: string;
  version?: number;
  inputs?: Record<string, unknown>;
  bindings?: Record<string, string>;
  dryRun?: boolean;
}

// ---------- Tasks ----------

export interface TaskItem {
  key: string;
  cells: string[];
  preselected: boolean;
}

export interface TaskRecord {
  id: string;
  runId: string;
  processName?: string;
  stepKey: string;
  mode: 'select' | 'approve';
  title: string;
  instructions?: string;
  columns: Column[];
  items: TaskItem[];
  status: 'open' | 'completed' | 'cancelled';
  decision?: TaskDecision | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
  createdAt: string;
  dryRun?: boolean;
}

export interface TaskDecision {
  approved: boolean;
  selectedKeys: string[];
  comment?: string;
}

// ---------- Schedules ----------

export interface Schedule {
  id: string;
  name: string;
  processId: string;
  processName?: string;
  cron: string;
  timezone?: string;
  inputs: Record<string, unknown>;
  bindings: Record<string, string>;
  dryRun: boolean;
  enabled: boolean;
  allowOverlap: boolean;
  lastRunAt?: string | null;
  lastRunId?: string | null;
  lastRunStatus?: RunStatus | null;
  nextRunAt?: string | null;
  createdAt: string;
}

// ---------- Audit ----------

export interface AuditEntry {
  seq: number;
  ts: string;
  actor: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  runId?: string | null;
  summary: string;
  details?: unknown;
  hash: string;
}

export interface AuditVerifyResult {
  ok: boolean;
  checked: number;
  firstBadSeq?: number;
  message: string;
}

// ---------- Misc ----------

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  operator?: string;
  demo: boolean;
  version: string;
  browserAvailable: boolean;
}

export interface Settings {
  operator: string;
  browserHeadless: boolean;
  browserTimeoutMs: number;
}

export interface DashboardData {
  openTasks: TaskRecord[];
  activeRuns: RunSummary[];
  recentRuns: RunSummary[];
  failedChecks: { runId: string; processName: string; name: string; message: string; severity: string; ts: string }[];
  upcoming: Schedule[];
  counts: { platforms: number; processes: number; schedules: number; runs24h: number; failed24h: number };
}
