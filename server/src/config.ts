import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDatabaseTarget, type DatabaseTarget } from './database/sql.js';
import { resolveBasePath } from './basePath.js';

// In the single-file executable import.meta is not available; paths then come from SM_* variables.
const here = typeof import.meta.url === 'string' ? path.dirname(fileURLToPath(import.meta.url)) : process.cwd();
export const ROOT_DIR = path.resolve(here, '..', '..');

const dataDir = path.resolve(process.env.SM_DATA_DIR ?? path.join(ROOT_DIR, 'data'));

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
      throw new Error(`SM_MASTER_PASSPHRASE_FILE: cannot read ${resolved}: ${(e as Error).message}`);
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

/**
 * SM_TRUST_PROXY: behind a reverse proxy, which X-Forwarded-For / -Proto / -Host to believe.
 * Off by default. A comma-separated list of proxy addresses/CIDRs ("10.0.0.5, 10.1.0.0/16", also
 * "loopback", "linklocal", "uniquelocal") – preferred – or a hop count ("1"); a hop count is only
 * honoured when the direct peer has a loopback or private address (see app.ts), so a client that
 * reaches Steward directly from outside cannot fake its address. "true" (trust everyone) is refused.
 */
export function parseTrustProxy(v: string | undefined): number | string[] | undefined {
  const s = v?.trim();
  if (!s || /^(0|false|off|no)$/i.test(s)) return undefined;
  if (/^\d+$/.test(s)) return Number(s);
  if (/^(true|on|yes|\*)$/i.test(s))
    throw new Error('SM_TRUST_PROXY=true would trust any client to set its own address – use the number of proxies (e.g. 1) or their addresses');
  const list = s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const x of list)
    if (!/^[0-9a-fA-F.:]+(\/\d{1,3})?$/.test(x) && !['loopback', 'linklocal', 'uniquelocal'].includes(x))
      throw new Error(`SM_TRUST_PROXY: "${x}" is not an IP address or CIDR`);
  return list;
}

/** A whole number from the environment within [min, max]; the default when unset, an error when invalid. */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}: "${raw}" is not a whole number from ${min} to ${max}`);
  return n;
}

/** SM_PUBLIC_URL (normalised: origin + base path) and SM_BASE_PATH; a mismatch or an invalid value refuses to start (see basePath.ts). */
const { basePath, publicUrl } = resolveBasePath(process.env);

export const config = {
  version: '0.2.8',
  host: process.env.SM_HOST ?? '127.0.0.1',
  port: Number(process.env.SM_PORT ?? 4310),
  dataDir,
  /**
   * SQLite file in the data directory (default) or PostgreSQL (SM_DATABASE_URL=postgres://…,
   * optional SM_DATABASE_SCHEMA and SM_DATABASE_CA). The data directory is needed either way
   * (vault file, artifacts, reports, uploaded docs).
   */
  database: (process.env.SM_DATABASE_URL
    ? parseDatabaseTarget(process.env.SM_DATABASE_URL, { schema: process.env.SM_DATABASE_SCHEMA, ca: process.env.SM_DATABASE_CA })
    : { kind: 'sqlite', file: path.join(dataDir, 'service-manager.db') }) as DatabaseTarget,
  demo: process.env.SM_DEMO === '1' || process.env.SM_DEMO === 'true',
  /** SQLite: automatic copies of the database made before migrations, kept in <data dir>/backups (0 = none). */
  upgradeBackups: envInt('SM_UPGRADE_BACKUPS', 3, 0, 100),
  webDist: process.env.SM_WEB_DIST ?? path.join(ROOT_DIR, 'web', 'dist'),
  templatesDir: path.join(process.env.SM_EXAMPLES_DIR ?? path.join(ROOT_DIR, 'examples'), 'processes'),
  dashboardsDir: path.join(process.env.SM_EXAMPLES_DIR ?? path.join(ROOT_DIR, 'examples'), 'dashboards'),
  /** Fonts, default logo and colour profile for PDF reports (server/assets; unpacked by the desktop executable) */
  assetsDir: process.env.SM_ASSETS_DIR ?? path.join(ROOT_DIR, 'server', 'assets'),
  /** Optional passphrase for unattended start (scheduled runs after reboot); see readMasterPassphrase. */
  masterPassphrase: readMasterPassphrase(),
  /** Serve HTTPS (recommended when other people access the tool over the network). */
  tls: process.env.SM_TLS_CERT && process.env.SM_TLS_KEY ? { cert: process.env.SM_TLS_CERT, key: process.env.SM_TLS_KEY } : undefined,
  /** The address users open (behind a reverse proxy: its https:// URL), including the base path. */
  publicUrl,
  /**
   * The path prefix Steward runs under behind a reverse proxy ('' = the root; e.g. '/steward'), from
   * SM_BASE_PATH or the path of SM_PUBLIC_URL. Everything is served below it (see basePath.ts).
   */
  basePath,
  /** Reverse proxy addresses / hop count whose X-Forwarded-* headers are believed (SM_TRUST_PROXY). */
  trustProxy: parseTrustProxy(process.env.SM_TRUST_PROXY),
  /**
   * Session lifetime (OWASP ASVS 4.0.3 V3.3.2, level 2): a session ends after SM_SESSION_IDLE_MINUTES without a
   * request (default 30; an open Steward tab keeps it alive) and SM_SESSION_MAX_HOURS after sign-in (default 12).
   */
  session: {
    idleMs: envInt('SM_SESSION_IDLE_MINUTES', 30, 5, 7 * 24 * 60) * 60_000,
    maxMs: envInt('SM_SESSION_MAX_HOURS', 12, 1, 30 * 24) * 3_600_000,
    /**
     * Step-up re-authentication (OWASP ASVS 3.7.1): how long a confirmation – the password again or a fresh single
     * sign-on – lets a session do sensitive actions, and how old a sign-in at the identity provider (auth_time) may be.
     */
    stepUpMs: envInt('SM_STEP_UP_MINUTES', 5, 1, 15) * 60_000,
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
 * (OWASP ASVS V14.1). `env` and `c` are parameters for tests.
 */
export function securityWarnings(
  env: NodeJS.ProcessEnv = process.env,
  c: { host: string; demo: boolean; secureCookies: boolean } = config,
  passphraseFromEnvironment = passphraseInEnvironment,
): string[] {
  const out: string[] = [];
  const hosts = (env.SM_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h && !LOOPBACK.includes(h));
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
  const login = env.SM_PASSWORD_LOGIN?.trim();
  if (login && !['all', 'adminsOnly', 'none'].includes(login)) {
    out.push(`SM_PASSWORD_LOGIN="${login.slice(0, 40)}" is not one of all, adminsOnly, none – it is ignored and the setting in the UI applies`);
  }
  if (env.SM_METRICS_PUBLIC === '1') out.push('SM_METRICS_PUBLIC=1: /api/metrics answers without signing in (counts of runs, checks and platforms)');
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
