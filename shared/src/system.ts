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
  };
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
  /** SQLite: copies of the database made before migrating */
  backups: string[];
  /** No copy: 'notNeeded' (no schema changes), 'postgres' (back up with pg_dump), 'disabled' (SM_UPGRADE_BACKUPS=0) */
  noBackupReason: 'notNeeded' | 'postgres' | 'disabled' | null;
  /** When the update was applied (ISO) */
  at: string;
}
