import type { Column, ProcessDefinition } from './process.js';
import type { Locale } from './locales.js';

// ---------- Users, roles, permissions ----------

export const ROLES = ['admin', 'designer', 'operator', 'approver', 'auditor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_INFO: Record<Role, string> = {
  admin: 'Everything: users, teams, platforms and credentials, settings, all processes',
  designer: 'Create processes; edit and run processes (unless restricted)',
  operator: 'Run and schedule processes (unless restricted)',
  approver: 'Decide approvals and user tasks',
  auditor: 'Read-only access to all processes, runs, protocols and the audit log',
  viewer: 'Read-only access to processes and their runs (unless restricted)',
};

export const PROCESS_PERMISSIONS = ['view', 'run', 'edit', 'approve', 'manage'] as const;
export type ProcessPermission = (typeof PROCESS_PERMISSIONS)[number];
export const PLATFORM_PERMISSIONS = ['use', 'manage'] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

/** subject: user:<username> | team:<team name> | role:<role> */
export interface AclEntry<P extends string = string> {
  subject: string;
  permissions: P[];
}

export interface UserInfo {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  roles: Role[];
  teams: string[];
  active: boolean;
  mustChangePassword: boolean;
  lastLoginAt?: string | null;
  createdAt: string;
  /** 'local' (password) or the id of the single sign-on provider the account belongs to */
  authSource: string;
  /** Receive e-mail notifications (if an e-mail address is set and e-mail is configured) */
  emailNotifications: boolean;
  /** Preferred UI and notification language; null = not chosen yet (browser language in the UI, Settings.defaultLocale for messages) */
  locale: Locale | null;
}

// ---------- Single sign-on (OpenID Connect) ----------

export interface SsoRoleMapping {
  /** Value of the groups/roles claim, e.g. an Entra app role "SM.Operators" or a group object id */
  claimValue: string;
  roles: Role[];
  teams: string[];
}

export interface SsoProvider {
  id: string;
  displayName: string;
  /** 'entra' only changes defaults/help texts; both use standard OIDC */
  type: 'entra' | 'oidc';
  /** OIDC issuer, e.g. https://login.microsoftonline.com/<tenant-id>/v2.0 */
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  clientAuth: 'client_secret_post' | 'client_secret_basic' | 'none';
  scopes: string;
  usernameClaim: string;
  displayNameClaim: string;
  emailClaim: string;
  /** Claim with roles/groups used for the mappings (Entra: "roles" for app roles, "groups" for group ids) */
  groupsClaim: string;
  mappings: SsoRoleMapping[];
  /** Roles every user of this provider gets */
  defaultRoles: Role[];
  /** Create accounts on first sign-in */
  autoProvision: boolean;
  /** Overwrite roles (and mapped team memberships) from the claims at every sign-in */
  syncRoles: boolean;
  /** Deny sign-in when no mapping matches */
  requireMapping: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type SsoProviderInput = Omit<SsoProvider, 'id' | 'hasClientSecret' | 'createdAt' | 'updatedAt'> & {
  /** New secret; omit to keep the stored one, '' to remove it */
  clientSecret?: string;
};

export interface SsoProviderPublic {
  id: string;
  displayName: string;
  type: 'entra' | 'oidc';
}

export interface SsoDiscoveryResult {
  ok: boolean;
  message: string;
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  scopesSupported?: string[];
  claimsSupported?: string[];
}

export interface Team {
  id: string;
  name: string;
  description: string;
  members: string[];
  createdAt: string;
}

export interface Capabilities {
  manageUsers: boolean;
  manageSettings: boolean;
  viewAudit: boolean;
  createProcesses: boolean;
  createPlatforms: boolean;
}

export interface Me {
  user: UserInfo;
  capabilities: Capabilities;
}

export interface AuthStatus {
  /** Vault (master passphrase) exists */
  initialized: boolean;
  /** No user accounts yet – first-time setup creates the first administrator */
  setupRequired: boolean;
  unlocked: boolean;
  me: Me | null;
  /** Enabled single sign-on providers (buttons on the sign-in page) */
  ssoProviders: SsoProviderPublic[];
  /** 'adminsOnly': password sign-in is limited to administrators (break-glass) */
  passwordLogin: 'all' | 'adminsOnly';
  demo: boolean;
  version: string;
  browserAvailable: boolean;
}

export interface Subject {
  value: string;
  /** English display label (the web UI builds a translated one from kind + name) */
  label: string;
  kind: 'user' | 'team' | 'role';
  /** Team name (original spelling) or role id */
  name?: string;
}

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
  /** Retries for 429/502/503/504 and network errors, honouring Retry-After (exponential backoff with jitter) */
  retry?: {
    /** default 3; 0 disables */
    maxRetries?: number;
    /** default 500 ms */
    baseDelayMs?: number;
    /** default 30 s */
    maxDelayMs?: number;
    /** POST/PATCH are not repeated unless enabled (they may not be idempotent) */
    retryNonIdempotent?: boolean;
  };
  /** Maximum concurrent requests to this platform (default 4) */
  maxConcurrency?: number;
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
  acl: AclEntry<PlatformPermission>[];
  /** What the current user may do with this platform. */
  permissions: PlatformPermission[];
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
  /** Saved/imported connector type (vs. built-in preset) */
  custom?: boolean;
  /** Number of API specifications bundled with the connector type */
  specCount?: number;
  createdAt?: string;
}

/** Shareable connector definition (no credentials). */
export interface ConnectorPackage {
  /** 'steward-connector' (legacy files: 'service-manager-connector') */
  format: 'steward-connector' | 'service-manager-connector';
  version: 1;
  kind: string;
  label: string;
  description: string;
  baseUrl: string;
  config: PlatformConfig;
  secretFields: { key: string; label: string; help?: string }[];
  docs: { title: string; url: string }[];
  specs: { name: string; content: string }[];
}

export interface ParamSchema {
  type?: string;
  format?: string;
  enum?: unknown[];
  default?: unknown;
}

export interface ApiOperation {
  specId: string;
  operationId?: string;
  method: string;
  path: string;
  summary?: string;
  tag?: string;
  description?: string;
  parameters?: { name: string; in: string; required?: boolean; description?: string; schema?: ParamSchema }[];
  hasBody?: boolean;
  /** Content type of the request body (e.g. application/json) */
  requestContentType?: string;
  /** Example body generated from the request schema */
  requestBodyExample?: unknown;
  /** Status codes documented as success */
  successStatus?: number[];
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
  owner?: string | null;
  acl: AclEntry<ProcessPermission>[];
  /** What the current user may do with this process. */
  permissions: ProcessPermission[];
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
  trigger: 'manual' | 'schedule' | 'resume' | 'subprocess' | 'webhook';
  scheduleId?: string | null;
  /** Webhook trigger that started this run (trigger 'webhook') */
  triggerId?: string | null;
  triggerName?: string | null;
  /** Set when this run was started by a "subprocess" node of another run */
  parentRunId?: string | null;
  /** Activation key of the parent's subprocess node */
  parentStepKey?: string | null;
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
  /** Evaluated definition outputs (when the run succeeded and the process declares outputs) */
  outputs?: Record<string, unknown> | null;
  /** Runs started by subprocess nodes of this run */
  children?: RunChild[];
}

export interface RunChild {
  id: string;
  processId: string;
  processName: string;
  status: RunStatus;
  /** Activation key of the subprocess node that started it */
  parentStepKey: string | null;
  startedAt: string;
  finishedAt?: string | null;
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
  processId?: string;
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
  /** Who may decide (empty = everyone allowed to run/approve the process). */
  assignees: string[];
  fourEyes: boolean;
  /** Who started the run */
  startedBy?: string;
  /** Whether the current user may decide this task. */
  canDecide?: boolean;
  /** Why not (when canDecide is false). */
  cannotDecideReason?: string;
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
  /** Scheduled runs execute with the permissions of this user. */
  owner?: string | null;
  canEdit?: boolean;
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

/** @deprecated use AuthStatus */
export type VaultStatus = AuthStatus & { operator?: string };

export interface Settings {
  /** 'adminsOnly' limits password sign-in to administrators once SSO is in place */
  passwordLogin: 'all' | 'adminsOnly';
  browserHeadless: boolean;
  /** Delete runs (journal, logs, evidence files) older than this many days; 0 = keep forever. The audit log is never pruned. */
  retentionRunDays: number;
  /** Delete read notifications older than this many days */
  retentionNotificationDays: number;
  browserTimeoutMs: number;
  /** Language of messages that go to a channel rather than a person (Teams, webhook), and for users without a chosen language */
  defaultLocale: Locale;
  /** Who may open the public API documentation (Swagger UI) and its OpenAPI document. SM_API_DOCS overrides it. */
  apiDocs: ApiDocsMode;
}

// ---------- Public REST API (/api/v1) ----------

/** off: no documentation page; authenticated: signed-in users (session); public: everyone who can reach the server */
export const API_DOCS_MODES = ['off', 'authenticated', 'public'] as const;
export type ApiDocsMode = (typeof API_DOCS_MODES)[number];

/** Effective configuration of the public API, for the web UI (GET /api/public-api). */
export interface PublicApiStatus {
  enabled: boolean;
  /** Base path of the versioned API, e.g. "/api/v1" */
  basePath: string;
  /** Effective documentation mode (environment overrides the setting) */
  docs: ApiDocsMode;
  /** "env" when SM_API_DOCS decides the documentation mode (the setting is then ignored) */
  docsSource: 'env' | 'settings';
  /** Link to the Swagger UI when the current user may open it, else null */
  docsUrl: string | null;
  /** Requests per minute and token; 0 = unlimited */
  rateLimitPerMinute: number;
  apiVersion: string;
}

export interface DashboardData {
  openTasks: TaskRecord[];
  activeRuns: RunSummary[];
  recentRuns: RunSummary[];
  failedChecks: { runId: string; processName: string; name: string; message: string; severity: string; ts: string }[];
  upcoming: Schedule[];
  counts: { platforms: number; processes: number; schedules: number; runs24h: number; failed24h: number };
}

// ---------- API contract check (sandbox contract tests) ----------

export interface ContractCheckResult {
  platformId: string;
  /** Operations called */
  checked: number;
  passed: number;
  failed: number;
  /** GET operations left out (required path parameters, over the cap of 30) */
  skipped: number;
  results: {
    operationId?: string;
    method: string;
    path: string;
    status: number;
    ok: boolean;
    problems: string[];
    durationMs?: number;
  }[];
}
