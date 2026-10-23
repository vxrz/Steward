// ---------- Notifications ----------

export const NOTIFICATION_EVENTS = [
  'task.assigned',
  'run.failed',
  'check.failed',
  'dataset.stale',
  'schedule.skipped',
  'monitor.status',
  'credential.due',
  'report.ready',
  'ticket.unchecked',
  'summary.daily',
  'access.undocumented',
  'document.review',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const NOTIFICATION_EVENT_INFO: Record<NotificationEvent, string> = {
  'task.assigned': 'A run waits for a decision you may take',
  'run.failed': 'A run you started (or a scheduled run you own) failed',
  'check.failed': 'A check failed in a run you started or a process you own',
  'dataset.stale': 'Dashboard data you feed is older than its freshness limit',
  'schedule.skipped': 'A schedule you own was skipped (missing rights, still running …)',
  'monitor.status': 'A monitor you own or subscribed to changed its status (root causes only)',
  'credential.due': 'A credential you own expires or needs rotating or a review soon (or is overdue)',
  'report.ready': 'A scheduled report you receive was generated',
  'ticket.unchecked': 'An open ticket reference you are responsible for was not checked for a while',
  'summary.daily': 'The daily summary of people who turned it on in their profile (in-app and e-mail only)',
  'access.undocumented': 'The access reconciliation found access changes without an access change entry',
  'document.review': 'A living document you review is due for its periodic review soon (or is overdue)',
};

export interface AppNotification {
  id: string;
  ts: string;
  event: NotificationEvent;
  title: string;
  body: string;
  /** In-app path, e.g. /runs/run_123 */
  link?: string;
  read: boolean;
}

export type NotificationChannel = 'inApp' | 'email' | 'teams' | 'webhook';

export interface NotificationSettings {
  email: { enabled: boolean; host: string; port: number; secure: boolean; user?: string; from: string; hasPassword: boolean };
  /** Microsoft Teams: incoming webhook / Workflows "post to channel" URL */
  teams: { enabled: boolean; hasWebhookUrl: boolean };
  /** Generic JSON webhook (e.g. ITSM, Slack, automation) */
  webhook: { enabled: boolean; hasUrl: boolean };
  /** Which channel each event uses */
  routes: Record<NotificationEvent, NotificationChannel[]>;
  /** Base URL used for links in e-mails/Teams (default SM_PUBLIC_URL or the address the admin uses) */
  baseUrl?: string;
  /**
   * Domains that plain e-mail addresses outside Steward (credential owners, report recipients) may have,
   * e.g. corp.example or *.corp.example (subdomains). Empty: the domains of the Steward users' own addresses.
   */
  allowedEmailDomains: string[];
}

export type NotificationSettingsInput = Omit<NotificationSettings, 'email' | 'teams' | 'webhook' | 'allowedEmailDomains'> & {
  /** Omitted: keep the stored list */
  allowedEmailDomains?: string[];
  email: Omit<NotificationSettings['email'], 'hasPassword'> & { password?: string };
  teams: { enabled: boolean; webhookUrl?: string };
  webhook: { enabled: boolean; url?: string };
};

// ---------- API tokens ----------

/**
 * read = GET requests only; full = everything the owner may do;
 * mcp = only the MCP endpoint (/api/mcp, read-only tools) – refused everywhere else.
 */
export const API_TOKEN_SCOPES = ['read', 'full', 'mcp'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export interface ApiToken {
  id: string;
  name: string;
  scope: ApiTokenScope;
  /** First characters, to recognise the token (e.g. smt_ab12) */
  prefix: string;
  owner: string;
  createdAt: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  revoked: boolean;
}

export interface ApiTokenCreated extends ApiToken {
  /** The full token – shown only once */
  token: string;
}

// ---------- Maintenance ----------

export interface MaintenanceStatus {
  databaseBytes: number;
  artifactBytes: number;
  runs: number;
  oldestRun?: string | null;
  auditEntries: number;
  lastCleanup?: { at: string; runsDeleted: number; artifactsDeleted: number; notificationsDeleted: number } | null;
}

// ---------- Editor support (expression assistant, inspector) ----------

export interface ScopeHints {
  inputs: string[];
  constants: string[];
  connections: { slot: string; vars: string[] }[];
  /** Variables known from the latest run (name + short sample) */
  vars: { name: string; sample: string }[];
  functions: { name: string; signature: string; help: string }[];
  runId?: string | null;
}

export interface EvaluateRequest {
  expression: string;
  /** Treat as template ({{ }} parts) instead of a plain expression */
  template?: boolean;
  /** Use the data of this run (default: latest run of the process) */
  runId?: string;
  /** Use the variables as they were just before this node ran */
  nodeId?: string;
  /** For per-item expressions: the item ($item / root) */
  item?: unknown;
}

export interface EvaluateResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  /** Run whose data was used */
  runId?: string | null;
}

export interface NodeInspection {
  runId: string;
  nodeId: string;
  activations: {
    key: string;
    status: string;
    startedAt: string;
    durationMs?: number | null;
    input?: unknown;
    output?: unknown;
    error?: string | null;
  }[];
  /** Variables just before the first activation (truncated previews) */
  varsBefore: Record<string, unknown>;
}
