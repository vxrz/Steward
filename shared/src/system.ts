/** About page and System status (GET /api/about, GET /api/system/status). No imports (the web imports it directly). */

export type DeploymentKind = 'executable' | 'container' | 'node';

/** Version and build of the server or of the web UI bundle. commit/date null = development build. */
export interface BuildInfo {
  version: string;
  commit: string | null;
  /** ISO date of the build */
  date: string | null;
}

/** GET /api/about (every signed-in user) */
export interface AboutInfo {
  build: BuildInfo;
}

export interface ReadinessCheck {
  ok: boolean;
  message?: string;
}
export type ReadinessChecks = Record<'vault' | 'database' | 'scheduler', ReadinessCheck>;

/**
 * GET /api/system/status: administrators get everything ("full"); auditors a
 * read-only view without paths, host names and connection details ("limited").
 * Never contains secrets.
 */
export interface SystemStatus {
  generatedAt: string;
  view: 'full' | 'limited';
  build: BuildInfo;
  deployment: DeploymentKind;
  ready: boolean;
  checks: ReadinessChecks;
  vault: { initialized: boolean; unlocked: boolean; unattendedUnlock: boolean };
  database: {
    kind: 'sqlite' | 'postgres';
    sizeBytes: number | null;
    /** full view: SQLite file or PostgreSQL URL without password */
    location?: string;
  };
  scheduler: { total: number; enabled: number; armed: number; next: { id: string; name: string; nextRunAt: string }[] };
  monitors: { engineRunning: boolean; total: number; enabled: number; checks: number; down: number; lastCheckAt: string | null };
  notifications: { email: boolean; teams: boolean; webhook: boolean };
  errorReporting: { server: boolean; browser: boolean; environment?: string };
  tracing: { enabled: boolean };
  /** How PDFs are drawn (#13): in the worker thread, or in the main thread (SM_PDF_WORKER=off, or the worker cannot start) */
  pdf: { mode: 'auto' | 'off'; worker: 'running' | 'idle' | 'unavailable' | 'off'; waiting: number; reason?: string };
  metrics: { access: 'public' | 'adminsAndAuditors' };
  publicApi: { enabled: boolean; basePath: string; docs: 'off' | 'authenticated' | 'public'; rateLimitPerMinute: number; apiVersion: string };
  retention: {
    runDays: number;
    notificationDays: number;
    monitorDays: number;
    lastCleanup: { at: string; runsDeleted: number; artifactsDeleted: number; notificationsDeleted: number } | null;
  };
  security: {
    tls: boolean;
    /** Who may sign in with a password (see Settings.passwordLogin) */
    passwordLogin?: 'all' | 'adminsOnly' | 'none';
    /** passwordLogin is set by SM_PASSWORD_LOGIN */
    passwordLoginFromEnv?: boolean;
    /** SM_PASSWORD_LOGIN=none waits for an administrator's first single sign-on (see Settings.passwordLoginPending) */
    passwordLoginPending?: 'none';
    /** full view: emergency access windows that are open (granted from the command line, not used yet) */
    emergencyWindowsOpen?: number;
    /** full view: extra host names accepted (SM_ALLOWED_HOSTS) */
    allowedHosts?: string[];
    /** full view: an outbound HTTP(S) proxy is configured in the environment */
    proxyFromEnvironment?: boolean;
    /** full view: a request to loosen the assurance policy waits for a second administrator (#210) */
    assurancePendingChange?: { id: string; requestedBy: string; expiresAt: string } | null;
  };
  /**
   * Steward's clock against a reference it has anyway (0.19.0): the PostgreSQL server's clock, or the Date header of the
   * latest platform answer – seconds Steward is ahead (negative: behind); null without a reference. warning: more than
   * 30 seconds
   */
  clock: { skewSeconds: number | null; source: 'database' | 'http' | null; checkedAt: string | null; warning: boolean };
  runtime: {
    node: string;
    platform: string;
    arch: string;
    cpus: number;
    uptimeSeconds: number;
    startedAt: string;
    memory: { rss: number; heapUsed: number; heapTotal: number };
    timeZone: string;
    /** full view */
    dataDir?: string;
    hostname?: string;
    pid?: number;
  };
}

/**
 * GET /api/system/update-notice (administrators only): the last update of the app, until the
 * administrator dismisses it or a newer update replaces it. Contains the path of the backup copy.
 */
export interface UpdateNotice {
  id: string;
  /** The version before the update (null: before versions were recorded, v0.1.0) */
  fromVersion: string | null;
  toVersion: string;
  /** Migrations applied ("core 6", then names) */
  migrations: string[];
  /** Copies of the database made before migrating (SQLite files, or pg_dump files on PostgreSQL) */
  backups: string[];
  /**
   * No copy: 'notNeeded' (no schema changes), 'disabled' (SM_UPGRADE_BACKUPS=0), 'failed' (the copy failed and
   * SM_UPGRADE_BACKUP_REQUIRED=0 migrated anyway); 'postgres' only in notices of 0.10 and older (no PostgreSQL copies then)
   */
  noBackupReason: 'notNeeded' | 'postgres' | 'disabled' | 'failed' | null;
  /** When the update was applied (ISO) */
  at: string;
}

/** How the last run of a background job ended. */
export type BackgroundJobResult = 'succeeded' | 'failed' | 'timedOut';

/**
 * GET /api/system/jobs (administrators): the periodic background jobs (reminders, integrations, clean-up, audit
 * checkpoints) and how their last run went. The state is kept in the database, so it survives restarts.
 */
export interface BackgroundJob {
  name: string;
  /** Interval in seconds, or `cron` */
  everySeconds: number | null;
  cron: string | null;
  timeoutSeconds: number;
  running: boolean;
  runningSince: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastDurationMs: number | null;
  lastResult: BackgroundJobResult | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  /** Whether the last run was planned or started with "Run now" */
  lastTrigger: 'schedule' | 'manual' | null;
  /** null while the job runner is stopped */
  nextRunAt: string | null;
  runs: number;
  failures: number;
  /** Starts skipped because the previous run had not ended yet */
  skipped: number;
  /** Its module is switched off (Settings → Modules): the job does not run */
  switchedOff?: boolean;
}
