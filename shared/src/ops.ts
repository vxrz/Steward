import type { QuietHours } from './quietHours.js';
// ---------- Notifications ----------

export const NOTIFICATION_EVENTS = [
  'task.assigned',
  'run.failed',
  'check.failed',
  'check.resolved',
  'dataset.stale',
  'schedule.skipped',
  'monitor.status',
  'monitor.state',
  'credential.due',
  'report.ready',
  'ticket.unchecked',
  'summary.daily',
  'access.undocumented',
  'access.share_expiring',
  'document.review',
  'stack.eol',
  'stack.release',
  'duty.due',
  'duty.missed',
  'duty.exception',
  'duty.ended',
  'objective.breached',
  'maintenance.announced',
  'measure.due',
  'corrective.action_due',
  'security.emergency',
  'backup.failed',
  'export.failed',
  'mcp.request',
  'platform.failing',
  'ai.budget',
  'cost.budget',
  'contract.failed',
  'plant.change_proposed',
  'plant.change_decided',
  'plant.advisory_matched',
  'supplier.certificate_expiring',
  'supplier.notice_due',
  'soa.approval_waiting',
  'cost.booking_due',
  'cost.volume',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/**
 * How the notification centre groups events (U9 of the 0.10 review): decisions someone waits for come first and are
 * never pushed out of the list by alerts; alerts tell that something broke; updates are reminders and news.
 */
export const NOTIFICATION_CATEGORIES = ['decision', 'alert', 'update'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
export const NOTIFICATION_DECISION_EVENTS: readonly NotificationEvent[] = [
  'task.assigned',
  'mcp.request',
  'duty.exception',
  'plant.change_proposed',
  'soa.approval_waiting',
];
const ALERT_EVENTS: readonly NotificationEvent[] = [
  'run.failed',
  'check.failed',
  'dataset.stale',
  'schedule.skipped',
  'monitor.status',
  'access.undocumented',
  'objective.breached',
  'security.emergency',
  'backup.failed',
  'export.failed',
  'platform.failing',
  'ai.budget',
  'cost.budget',
  'cost.volume',
  'contract.failed',
  'plant.advisory_matched',
];
export const notificationCategory = (event: string): NotificationCategory =>
  (NOTIFICATION_DECISION_EVENTS as readonly string[]).includes(event) ? 'decision' : (ALERT_EVENTS as readonly string[]).includes(event) ? 'alert' : 'update';

export const NOTIFICATION_EVENT_INFO: Record<NotificationEvent, string> = {
  'task.assigned': 'A run waits for a decision you may take',
  'run.failed': 'A run you started (or a scheduled run you own) failed',
  'check.failed': 'A check failed in a run you started or a process you own',
  'check.resolved': 'A check of a scheduled run passes again after it failed (when the schedule asks for it)',
  'dataset.stale': 'Dashboard data you feed is older than its freshness limit',
  'schedule.skipped': 'A schedule you own was skipped (missing rights, still running …)',
  'monitor.status': 'A monitor you own or subscribed to changed its status (root causes only)',
  'monitor.state': 'A monitor with states changed its state, e.g. Running → Off (information, when its notification output asks for it)',
  'credential.due': 'A credential you own expires or needs rotating or a review soon (or is overdue)',
  'report.ready': 'A scheduled report you receive was generated',
  'ticket.unchecked': 'An open ticket reference you are responsible for was not checked for a while',
  'summary.daily': 'The daily summary of people who turned it on in their profile (in-app and e-mail only)',
  'access.undocumented': 'The access reconciliation found access changes without an access change entry',
  'access.share_expiring': 'A share of an item you manage ends in 7 days (it is removed then unless someone extends it)',
  'document.review': 'A living document you review is due for its periodic review soon (or is overdue)',
  'stack.eol': 'A component of an application you own reaches the end of life of its release cycle soon (or reached it)',
  'stack.release': 'A new major release of a product in the tech stack of an application or system you are responsible for',
  'duty.due': 'A service duty you are responsible for is due soon and not done yet',
  'duty.missed': 'A period of a mandatory or recommended service duty you are responsible for ended without a successful run',
  'duty.exception': 'Someone asked to skip a period of a service duty you are responsible for: a second person decides',
  'duty.ended': 'Someone archived or changed a mandatory or recommended duty you are responsible for, and its current period ended without a run',
  'objective.breached': 'An availability objective of a service you are responsible for fell below its target (once per breach)',
  'maintenance.announced': 'Maintenance of something you are responsible for or own was planned, starts soon, started or ended',
  'measure.due': 'A measure from an incident review that you own is due soon or overdue',
  'corrective.action_due': 'An action of a corrective action finding that you own is due soon or overdue',
  'security.emergency': 'Someone signed in with emergency access from the server command line (administrators)',
  'backup.failed': 'A backup or the weekly restore test of the backups failed (administrators)',
  'export.failed': 'A scheduled export to S3 failed (administrators)',
  'mcp.request': 'An AI assistant asks to change something on a platform or to start a run, and you decide',
  'platform.failing': 'The periodic connection test of a platform you manage started failing',
  'ai.budget': 'An AI token budget reached 80 % or is used up (administrators; the gateway’s managers, the process owner)',
  'cost.budget': 'The monthly cost budget of a service, application or team you own reached 80 % or 100 %',
  'contract.failed': 'A test of a data contract your team owns failed (the owning team’s members and channel)',
  'plant.change_proposed': 'Someone proposed a change to the plant registry that you may apply (never the author)',
  'plant.change_decided': 'A plant change you wrote was applied, rejected, returned to you or expired (with the reviewer’s comment)',
  'plant.advisory_matched': 'A new high or critical security advisory affects assets of a site you manage (plant registry)',
  'supplier.certificate_expiring': 'A certificate of a supplier you own runs out in 90 or 30 days',
  'supplier.notice_due': 'The last day to give notice on a contract of a supplier you own is 90 or 30 days away',
  'soa.approval_waiting': 'A version of a statement of applicability was submitted and waits for your approval (approvers and administrators)',
  'cost.booking_due': 'Contract payments of last month of a service you own have no cost entry yet (off by default: turn it on in your profile)',
  'cost.volume':
    'A contract volume your service or platform pays runs out, is used up, passes its ceiling or is expected to end well below its committed minimum',
};

/**
 * Events a person turns on for themselves (0.18.0, ADR 0030): off by default, sent only to who opted in (Profile →
 * Notifications) – reminders some people want and others would find noise.
 */
export const NOTIFICATION_OPT_IN_EVENTS = ['cost.booking_due'] as const satisfies readonly NotificationEvent[];
export type NotificationOptInEvent = (typeof NOTIFICATION_OPT_IN_EVENTS)[number];

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
  /** Microsoft Teams: incoming webhook / Workflows "post to channel" URL; quiet hours of the channel (0.10.0, ADR 0012) */
  teams: { enabled: boolean; hasWebhookUrl: boolean; quietHours?: QuietHours };
  /** Generic JSON webhook (e.g. ITSM, Slack, automation); format teams: an Adaptive Card instead (#130), with quiet hours */
  webhook: { enabled: boolean; hasUrl: boolean; format?: 'json' | 'teams'; quietHours?: QuietHours };
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
  teams: { enabled: boolean; webhookUrl?: string; quietHours?: QuietHours | null };
  webhook: { enabled: boolean; url?: string; format?: 'json' | 'teams'; quietHours?: QuietHours | null };
};

// ---------- Look of e-mails and Teams messages ----------

/** Where the logo in e-mails and Teams cards comes from: the Appearance logo, the report logo, an own upload, or none. */
export const NOTIFICATION_LOGO_SOURCES = ['app', 'report', 'custom', 'none'] as const;
export type NotificationLogoSource = (typeof NOTIFICATION_LOGO_SOURCES)[number];
/** Height of the logo in the e-mail header: 20, 28 or 40 px. */
export const NOTIFICATION_LOGO_SIZES = ['small', 'medium', 'large'] as const;
export const NOTIFICATION_LOGO_ALIGNS = ['left', 'center'] as const;
/** solid: header in the colour; line: white header with a line in the colour; minimal: white header, thin grey line. */
export const NOTIFICATION_HEADER_STYLES = ['solid', 'line', 'minimal'] as const;
export const NOTIFICATION_CORNERS = ['rounded', 'square'] as const;
/** Fonts every mail client has: the system font, Arial/Helvetica, or a serif (Georgia). */
export const NOTIFICATION_FONTS = ['system', 'arial', 'serif'] as const;
/** Messages about dry runs: by e-mail, Teams and webhook as usual, marked as a test – or only in the app. */
export const NOTIFICATION_DRY_RUN_DELIVERY = ['marked', 'inAppOnly'] as const;
/** An own notification logo (PNG or JPEG): at most 512 KB, the limit for e-mail logos. */
export const NOTIFICATION_LOGO_MAX_BYTES = 512 * 1024;

export const NOTIFICATION_LOOK_NAME_MAX = 60;
export const NOTIFICATION_LOOK_FOOTER_MAX = 300;

/**
 * Settings → Notifications → Look (administrators). Empty fields follow Settings → Appearance:
 * the app name (else the product name) and the primary colour.
 */
export interface NotificationLookInput {
  /** Shown in the e-mail header, the subject prefix and the Teams card; '' = Appearance app name */
  name: string;
  /** Hex colour of the e-mail header (#rrggbb); '' = Appearance primary colour */
  color: string;
  logoSource: NotificationLogoSource;
  /** Small print at the bottom of every e-mail, e.g. "Internal – IT operations"; '' = none */
  footer: string;
  logoSize: (typeof NOTIFICATION_LOGO_SIZES)[number];
  logoAlign: (typeof NOTIFICATION_LOGO_ALIGNS)[number];
  headerStyle: (typeof NOTIFICATION_HEADER_STYLES)[number];
  /** Hex colour of the "Open in …" button; '' = the header colour */
  buttonColor: string;
  corners: (typeof NOTIFICATION_CORNERS)[number];
  font: (typeof NOTIFICATION_FONTS)[number];
  /** Notifications about dry runs: marked as a test on every channel, or only in the app */
  dryRunDelivery: (typeof NOTIFICATION_DRY_RUN_DELIVERY)[number];
}

export interface NotificationLook extends NotificationLookInput {
  /** What the messages use right now (the fallbacks applied) */
  effective: {
    name: string;
    color: string;
    /** The chosen logo exists and can be embedded (PNG or JPEG) */
    logo: boolean;
    /** Why there is no logo although one was chosen: missing, a WebP image mail clients cannot show, or larger than 512 KB */
    logoProblem?: 'missing' | 'type' | 'size';
  };
  /** An own notification logo is uploaded (logo source "custom") */
  customLogo: { mime: 'image/png' | 'image/jpeg'; size: number; updatedAt: string | null } | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const NOTIFICATION_LOOK_DEFAULTS: NotificationLookInput = {
  name: '',
  color: '',
  logoSource: 'app',
  footer: '',
  logoSize: 'medium',
  logoAlign: 'left',
  headerStyle: 'solid',
  buttonColor: '',
  corners: 'rounded',
  font: 'system',
  dryRunDelivery: 'marked',
};

/** POST /api/settings/notifications/look/preview: the sample message as it would be sent with the given draft. */
export interface NotificationLookPreview {
  subject: string;
  /** The complete HTML e-mail; the logo is inlined as a data URL for the preview only */
  html: string;
  /** The Teams card (Adaptive Card JSON) */
  teams: unknown;
}

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
  lastCleanup?: {
    at: string;
    runsDeleted: number;
    /** Of these, debug runs past their own retention (0.10.0, ADR 0010) */
    debugRunsDeleted?: number;
    artifactsDeleted: number;
    notificationsDeleted: number;
    /** Audit archives written by this cleanup (0.4.0) */
    auditArchived?: number;
    /** Archived audit entries deleted (audit retention) */
    auditEntriesDeleted?: number;
  } | null;
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
