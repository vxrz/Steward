import path from 'node:path';
import fs from 'node:fs';
import { parseDatabaseTarget, type DatabaseTarget } from './database/sql.js';
import { resolveBasePath } from './basePath.js';
import { ConfigError, parseEnv, resolveFileVariants, withoutName, type Env } from './config-schema.js';

export { ConfigError, parseEnv, parseTrustProxy, type Env } from './config-schema.js';

import { ROOT_DIR } from './root-dir.js';

export { ROOT_DIR };

/**
 * The environment, as the build sees it: the desktop executable has SM_BUILD_COMMIT / SM_BUILD_DATE compiled in
 * (esbuild replaces these two expressions, see scripts/build-exe.mjs), everything else comes from process.env.
 */
function environment(): Record<string, string | undefined> {
  const raw = { ...process.env, SM_BUILD_COMMIT: process.env.SM_BUILD_COMMIT, SM_BUILD_DATE: process.env.SM_BUILD_DATE };
  // secrets from files (SM_DATABASE_URL_FILE, …; systemd credentials as %d/…): config-schema.ts FILE_VARIANTS
  const { env, problems } = resolveFileVariants(raw, (file) => readPassphraseFile(file.replace(/^%d(?=[\\/])/, process.env.CREDENTIALS_DIRECTORY ?? '%d')));
  if (problems.length) throw new ConfigError(problems);
  return env;
}

/**
 * Every environment variable, validated once at start-up (config-schema.ts): an invalid value refuses to start
 * with one line per bad variable. The rest of the server reads `env.SM_…` instead of process.env.
 *
 * Tests that change process.env after the server started call reloadConfig() (or overrideConfig() for single
 * values); the object keeps its identity, so modules that read `env.X` at use time see the new values.
 */
export const env: Env = parseEnv(environment());

/**
 * Re-reads process.env into `env` (tests that change variables at runtime; also after a CLI set SM_DATA_DIR before
 * starting anything). Throws a ConfigError like the start does. Values derived once at start-up (`config.port`,
 * `config.dataDir`, `config.database`, the base path, the session lifetimes) keep their values.
 */
export function reloadConfig(): Env {
  const next = parseEnv(environment());
  for (const k of Object.keys(env)) delete (env as Record<string, unknown>)[k];
  Object.assign(env, next);
  return env;
}

/** Sets single validated values (tests): `overrideConfig({ SM_API_RATE_LIMIT: 0 })`; reloadConfig() undoes it. */
export function overrideConfig(patch: Partial<Env>): void {
  Object.assign(env, patch);
}

const dataDir = path.resolve(env.SM_DATA_DIR ?? path.join(ROOT_DIR, 'data'));

/**
 * The master passphrase for unattended start: SM_MASTER_PASSPHRASE_FILE (preferred: a Docker/Kubernetes
 * secret, a systemd credential, a file only the service account can read) or SM_MASTER_PASSPHRASE.
 * Both variables are removed from the environment right away, so child processes (the browser for
 * browser steps, the user's browser started by the desktop launcher) never inherit the passphrase
 * and it does not show up in /proc/<pid>/environ of later processes.
 */
/** Whether the passphrase came from SM_MASTER_PASSPHRASE itself (visible in the process environment of the start). */
let passphraseInEnvironment = false;
function readMasterPassphrase(): string | undefined {
  const file = process.env.SM_MASTER_PASSPHRASE_FILE?.trim();
  const direct = process.env.SM_MASTER_PASSPHRASE;
  passphraseInEnvironment = !file && !!direct;
  delete process.env.SM_MASTER_PASSPHRASE;
  delete process.env.SM_MASTER_PASSPHRASE_FILE;
  if (file) {
    // systemd credentials: SM_MASTER_PASSPHRASE_FILE=%d/steward-passphrase (LoadCredential=…)
    const resolved = file.replace(/^%d(?=[\\/])/, process.env.CREDENTIALS_DIRECTORY ?? '%d');
    try {
      return readPassphraseFile(resolved);
    } catch (e) {
      throw new ConfigError([{ name: 'SM_MASTER_PASSPHRASE_FILE', message: `cannot read ${resolved}: ${(e as Error).message}` }]);
    }
  }
  return direct || undefined;
}

/** A passphrase file: its content without the trailing line break. Windows: a DPAPI-protected file (see docs/SECURITY-HARDENING.md) can be read by a wrapper script. */
export function readPassphraseFile(file: string): string {
  const text = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  if (!text) throw new Error('the file is empty');
  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o077;
    if (mode & 0o007) process.emitWarning(`${file} is readable by other users – restrict it (chmod 600)`, { code: 'SM_PASSPHRASE_FILE_MODE' });
  }
  return text;
}

/** A start-up check across variables, reported like a bad single variable. */
function check<T>(name: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError([{ name, message: withoutName((e as Error).message, name) }]);
  }
}

/** SM_PUBLIC_URL (normalised: origin + base path) and SM_BASE_PATH; a mismatch refuses to start (see basePath.ts). */
const { basePath, publicUrl } = check('SM_BASE_PATH', () => resolveBasePath(process.env));

const examplesDir = env.SM_EXAMPLES_DIR ?? path.join(ROOT_DIR, 'examples');

export const config = {
  version: '0.23.0',
  host: env.SM_HOST,
  port: env.SM_PORT,
  /** The Teams bot listener (ADR 0013): undefined = none */
  teamsBotPort: env.SM_TEAMS_BOT_PORT as number | undefined,
  teamsBotHost: env.SM_TEAMS_BOT_HOST ?? env.SM_HOST,
  dataDir,
  /**
   * SQLite file in the data directory (default) or PostgreSQL (SM_DATABASE_URL=postgres://…,
   * optional SM_DATABASE_SCHEMA and SM_DATABASE_CA). The data directory is needed either way
   * (vault file, artifacts, reports, uploaded docs).
   */
  database: (env.SM_DATABASE_URL
    ? check('SM_DATABASE_URL', () => parseDatabaseTarget(env.SM_DATABASE_URL!, { schema: env.SM_DATABASE_SCHEMA, ca: env.SM_DATABASE_CA }))
    : { kind: 'sqlite', file: path.join(dataDir, 'service-manager.db') }) as DatabaseTarget,
  demo: env.SM_DEMO,
  /** Automatic copies of the database made before migrations (SQLite file or pg_dump), kept in upgradeBackupDir (0 = none). */
  upgradeBackups: env.SM_UPGRADE_BACKUPS,
  upgradeBackupDir: path.resolve(env.SM_UPGRADE_BACKUP_DIR ?? path.join(dataDir, 'backups')),
  /** Runs at the same time (SM_MAX_CONCURRENT_RUNS, 0 = no limit): further runs wait in status queued, first come first served (engine/runner.ts). */
  maxConcurrentRuns: env.SM_MAX_CONCURRENT_RUNS,
  /** On SIGTERM/SIGINT: how long running steps may still finish before their runs are marked interrupted (bootstrap.ts). */
  shutdownGraceMs: env.SM_SHUTDOWN_GRACE_SECONDS * 1000,
  webDist: env.SM_WEB_DIST ?? path.join(ROOT_DIR, 'web', 'dist'),
  /** The example library (processes, dashboards, monitors) */
  examplesDir,
  templatesDir: path.join(examplesDir, 'processes'),
  dashboardsDir: path.join(examplesDir, 'dashboards'),
  /** Fonts, default logo and colour profile for PDF reports (server/assets; unpacked by the desktop executable) */
  assetsDir: env.SM_ASSETS_DIR ?? path.join(ROOT_DIR, 'server', 'assets'),
  /**
   * PDFs are drawn in a worker thread (#13): "auto" (default) uses it and falls back to drawing in the main thread
   * when the worker cannot start; "off" always draws in the main thread (no time limit then).
   */
  pdfWorker: env.SM_PDF_WORKER,
  /** Optional passphrase for unattended start (scheduled runs after reboot); see readMasterPassphrase. */
  masterPassphrase: readMasterPassphrase(),
  /** Serve HTTPS (recommended when other people access the tool over the network). */
  tls: env.SM_TLS_CERT && env.SM_TLS_KEY ? { cert: env.SM_TLS_CERT, key: env.SM_TLS_KEY } : undefined,
  /** The address users open (behind a reverse proxy: its https:// URL), including the base path. */
  publicUrl,
  /**
   * The path prefix Steward runs under behind a reverse proxy ('' = the root; e.g. '/steward'), from
   * SM_BASE_PATH or the path of SM_PUBLIC_URL. Everything is served below it (see basePath.ts).
   */
  basePath,
  /** Reverse proxy addresses / hop count whose X-Forwarded-* headers are believed (SM_TRUST_PROXY). */
  trustProxy: env.SM_TRUST_PROXY,
  /**
   * Session lifetime (OWASP ASVS 4.0.3 V3.3.2, level 2): a session ends after SM_SESSION_IDLE_MINUTES without a
   * request (default 30; an open Steward tab keeps it alive) and SM_SESSION_MAX_HOURS after sign-in (default 12).
   */
  session: {
    idleMs: env.SM_SESSION_IDLE_MINUTES * 60_000,
    maxMs: env.SM_SESSION_MAX_HOURS * 3_600_000,
    /**
     * Step-up re-authentication (OWASP ASVS 3.7.1): how long a confirmation – the password again or a fresh single
     * sign-on – lets a session do sensitive actions, and how old a sign-in at the identity provider (auth_time) may be.
     */
    stepUpMs: env.SM_STEP_UP_MINUTES * 60_000,
  },
  /** Session cookie with Secure and HSTS: built-in TLS, or an https public URL (TLS terminated by a proxy). */
  get secureCookies(): boolean {
    return !!this.tls || !!publicUrl?.startsWith('https://');
  },
};

/** This server on loopback, below the base path (the demo's mock platforms and simulators call it). */
export const loopbackUrl = (): string => `http://127.0.0.1:${config.port}${config.basePath}`;

const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '[::1]'];

/**
 * Settings that are fine on a laptop but weaken a shared server: logged as warnings at startup
 * (OWASP ASVS V14.1). `e` and `c` are parameters for tests.
 */
export function securityWarnings(
  e: Pick<Env, 'SM_ALLOWED_HOSTS' | 'SM_METRICS_PUBLIC'> = env,
  c: { host: string; demo: boolean; secureCookies: boolean; trustProxy?: unknown; publicUrl?: string } = config,
  passphraseFromEnvironment = passphraseInEnvironment,
): string[] {
  const out: string[] = [];
  const hosts = e.SM_ALLOWED_HOSTS.filter((h) => !LOOPBACK.includes(h));
  const remote = hosts.length > 0;
  if (remote && !c.secureCookies) {
    out.push(
      `Reachable as ${hosts.join(', ')} without HTTPS: passwords and session cookies cross the network in clear text – set SM_TLS_CERT/SM_TLS_KEY, or SM_PUBLIC_URL=https://… behind a TLS reverse proxy`,
    );
  }
  if (c.demo && (remote || !LOOPBACK.includes(c.host))) {
    out.push(
      'Demo mode (SM_DEMO) on a server reachable from the network: it serves mock platforms and lets administrators load demo users with a known password',
    );
  }
  if (passphraseFromEnvironment) {
    out.push('The master passphrase comes from SM_MASTER_PASSPHRASE – prefer SM_MASTER_PASSPHRASE_FILE (a secret file only the service account can read)');
  }
  if (c.trustProxy !== undefined && !c.publicUrl) {
    out.push(
      'SM_TRUST_PROXY is set without SM_PUBLIC_URL: the addresses of single sign-on and of the OAuth sign-in for MCP clients come from the forwarded host header – set SM_PUBLIC_URL to the address people use',
    );
  }
  if (e.SM_METRICS_PUBLIC) out.push('SM_METRICS_PUBLIC=1: /api/metrics answers without signing in (counts of runs, checks and platforms)');
  if (config.session.maxMs > 12 * 3_600_000 || config.session.idleMs > 30 * 60_000) {
    out.push('Sessions last longer than OWASP ASVS level 2 allows (12 h after sign-in, 30 min idle) – see SM_SESSION_MAX_HOURS / SM_SESSION_IDLE_MINUTES');
  }
  return out;
}

/**
 * Creates the data folders. On Linux/macOS the data directory is private to the service account
 * (0700) and the database, vault and key files are 0600 – also fixed on existing installations
 * (best effort; problems are returned for the log).
 */
export function ensureDataDirs(): string[] {
  const problems: string[] = [];
  const posix = process.platform !== 'win32';
  for (const d of ['', 'artifacts', 'docs', 'reports']) {
    const dir = path.join(config.dataDir, d);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (posix) {
      try {
        if ((fs.statSync(dir).mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
      } catch (e) {
        problems.push(`${dir}: ${(e as Error).message}`);
      }
    }
  }
  if (posix) {
    for (const f of fs.readdirSync(config.dataDir)) {
      if (!/^(service-manager\.db(-wal|-shm|-journal)?|vault\.json.*|audit-anchor\.json|instance\.json)$/.test(f)) continue;
      const file = path.join(config.dataDir, f);
      try {
        const st = fs.statSync(file);
        if (st.isFile() && (st.mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
      } catch (e) {
        problems.push(`${file}: ${(e as Error).message}`);
      }
    }
  }
  return problems;
}
