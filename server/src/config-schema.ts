/**
 * Every environment variable the server reads: its validation (zod), its default and its documentation.
 *
 * - config.ts parses process.env with this schema once at start-up and refuses to start with one clear
 *   line per bad variable (fail fast) – the rest of the server reads the typed values from `env` there.
 * - `npm run config:docs` writes the variable tables in README.md and docs/CONFIGURATION.md from it;
 *   `npm run config:docs -- --check` (CI) fails when they are out of date.
 *
 * Kept free of side effects and of other server modules (only zod and the pure parsers of basePath.ts),
 * so the documentation script, the health check and the CLIs can use it without starting anything.
 */
import { z } from 'zod';
import { parseBasePath, resolveBasePath } from './basePath.js';

/** Where a variable is documented: every variable is in docs/CONFIGURATION.md; `readme` ones also in README.md. */
export interface VarDoc {
  group: Group;
  /** The default as written in the documentation ('' = none). */
  default?: string;
  /** Plain-text description (Markdown allowed: links, code). */
  description: string;
  /** Also listed in the README's short table. */
  readme?: boolean;
  /** The value is a secret: never logged or shown. */
  secret?: boolean;
}

export const GROUPS = [
  'Server and network',
  'Database and data',
  'Unlocking',
  'Sign-in and sessions',
  'Limits',
  'API, MCP and metrics',
  'Audit log and evidence',
  'Browser steps and reports',
  'Logging, tracing and error reporting',
  'Backups and migration',
  'Monitors (tests and development)',
  'Build and packaging',
] as const;
export type Group = (typeof GROUPS)[number];

// ---------------------------------------------------------------------------
// Value types. An empty or blank value counts as "not set" everywhere.

const OFF_WORDS = ['0', 'false', 'off', 'no', 'disabled'];
const ON_WORDS = ['1', 'true', 'on', 'yes', 'enabled'];

const raw = z
  .string()
  .optional()
  .transform((s) => (s?.trim() ? s.trim() : undefined));

const fail = (ctx: z.RefinementCtx, message: string) => {
  ctx.addIssue({ code: 'custom', message });
  return z.NEVER;
};

/** A parser's message without the variable name it starts with ("SM_X: …", "SM_X=…"), since the issue names it already. */
export function withoutName(message: string, name: string): string {
  if (!message.startsWith(name)) return message;
  const rest = message.slice(name.length);
  return /^[: =]/.test(rest) ? rest.slice(1).trimStart() : message;
}

const quote = (s: string) => JSON.stringify(s.length > 80 ? `${s.slice(0, 80)}…` : s);

/** A string (trimmed); undefined when not set. */
const text = () => raw;
/** A string with a default. */
const textOr = (fallback: string) => raw.transform((s) => s ?? fallback);

/** A whole number within [min, max]. */
function int(fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) {
  return raw.transform((s, ctx) => {
    if (s === undefined) return fallback;
    const n = Number(s);
    if (!Number.isInteger(n) || n < min || n > max) return fail(ctx, `${quote(s)} is not a whole number from ${min} to ${max}`);
    return n;
  });
}

/** A whole number within [min, max]; undefined when not set. */
function optionalInt(min: number, max: number) {
  return raw.transform((s, ctx): number | undefined => {
    if (s === undefined) return undefined;
    const n = Number(s);
    if (!Number.isInteger(n) || n < min || n > max) return fail(ctx, `${quote(s)} is not a whole number from ${min} to ${max}`);
    return n;
  });
}

/** A number within [min, max] (decimals allowed). */
function num(fallback: number, min: number, max: number) {
  return raw.transform((s, ctx) => {
    if (s === undefined) return fallback;
    const n = Number(s);
    if (!Number.isFinite(n) || n < min || n > max) return fail(ctx, `${quote(s)} is not a number from ${min} to ${max}`);
    return n;
  });
}

/** A number greater than 0 (decimals allowed, e.g. a size of 0.5 MB). */
function positive(fallback: number) {
  return raw.transform((s, ctx) => {
    if (s === undefined) return fallback;
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return fail(ctx, `${quote(s)} is not a number greater than 0`);
    return n;
  });
}

/** Requests per minute: a whole number, 0 or "off" = no limit. */
function limit(fallback: number) {
  return raw.transform((s, ctx) => {
    if (s === undefined) return fallback;
    if (OFF_WORDS.includes(s.toLowerCase())) return 0;
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0) return fail(ctx, `${quote(s)} is not a whole number (0 or "off" = no limit)`);
    return n;
  });
}

/** On/off: 1/true/on/yes/enabled or 0/false/off/no/disabled. */
function flag(fallback: boolean) {
  return raw.transform((s, ctx) => {
    if (s === undefined) return fallback;
    const v = s.toLowerCase();
    if (ON_WORDS.includes(v)) return true;
    if (OFF_WORDS.includes(v)) return false;
    return fail(ctx, `${quote(s)} is not on or off (1/0, true/false, on/off)`);
  });
}

/** On/off without a default (undefined = decided elsewhere, e.g. a setting or automatically). */
function optionalFlag() {
  return raw.transform((s, ctx): boolean | undefined => {
    if (s === undefined) return undefined;
    const v = s.toLowerCase();
    if (ON_WORDS.includes(v)) return true;
    if (OFF_WORDS.includes(v)) return false;
    return fail(ctx, `${quote(s)} is not on or off (1/0, true/false, on/off)`);
  });
}

/** One of a fixed list (exact spelling). */
function oneOf<const T extends readonly string[]>(values: T) {
  return raw.transform((s, ctx): T[number] | undefined => {
    if (s === undefined) return undefined;
    if ((values as readonly string[]).includes(s)) return s as T[number];
    return fail(ctx, `${quote(s)} is not one of ${values.join(', ')}`);
  });
}

/** A comma-separated list (blank entries dropped). */
const list = () =>
  raw.transform((s) =>
    (s ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

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
  const items = s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const x of items)
    if (!/^[0-9a-fA-F.:]+(\/\d{1,3})?$/.test(x) && !['loopback', 'linklocal', 'uniquelocal'].includes(x))
      throw new Error(`SM_TRUST_PROXY: "${x}" is not an IP address or CIDR`);
  return items;
}

/** Runs a parser that throws with a "NAME: message" text; the issue gets the message without the name. */
function parsedBy<T>(name: string, parse: (s: string) => T) {
  return raw.transform((s, ctx): T | undefined => {
    if (s === undefined) return undefined;
    try {
      return parse(s);
    } catch (e) {
      return fail(ctx, withoutName((e as Error).message, name));
    }
  });
}

// ---------------------------------------------------------------------------
// The variables. Order = order in the documentation (within a group).

const v = <S extends z.ZodType>(schema: S, doc: VarDoc) => ({ schema, doc });

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export const VARS = {
  // Server and network
  SM_PORT: v(int(4310, 0, 65535), {
    group: 'Server and network',
    default: '4310',
    description: 'HTTP port (`0`: any free port, shown in the start log)',
    readme: true,
  }),
  SM_HOST: v(textOr('127.0.0.1'), {
    group: 'Server and network',
    default: '127.0.0.1',
    description: 'Bind address. Keep it local unless you know what you are doing.',
    readme: true,
  }),
  SM_ALLOWED_HOSTS: v(list(), {
    group: 'Server and network',
    description: "Extra allowed `Host` headers (comma-separated), e.g. the machine's DNS name when colleagues use it",
    readme: true,
  }),
  SM_TEAMS_BOT_PORT: v(optionalInt(1, 65535), {
    group: 'Server and network',
    description:
      'Port of a second, minimal listener for the Microsoft Teams bot (preview, ADR 0013): it serves only `POST /teams/bot/messages` – no cookies, no web app, no other route. Not set: no bot listener. Publish only this port to the internet (docs/TEAMS.md).',
  }),
  SM_TEAMS_BOT_HOST: v(text(), {
    group: 'Server and network',
    description: 'Bind address of the Teams bot listener (default: `SM_HOST`). Uses `SM_TLS_CERT`/`SM_TLS_KEY` like the main listener.',
  }),
  SM_TLS_CERT: v(text(), {
    group: 'Server and network',
    description: 'Path to a certificate (PEM). With `SM_TLS_KEY` Steward serves HTTPS, which is recommended when others connect over the network.',
    readme: true,
  }),
  SM_TLS_KEY: v(text(), { group: 'Server and network', description: 'Path to the private key of `SM_TLS_CERT` (PEM)', readme: true }),
  SM_TLS_CIPHERS: v(text(), {
    group: 'Server and network',
    default: 'modern list',
    description: 'OpenSSL cipher list for TLS 1.2 with the built-in HTTPS (TLS 1.3 suites are always on; TLS 1.0/1.1 are off)',
    readme: true,
  }),
  SM_PUBLIC_URL: v(
    parsedBy('SM_PUBLIC_URL', (s) => resolveBasePath({ SM_PUBLIC_URL: s }).publicUrl),
    {
      group: 'Server and network',
      description:
        'External URL (e.g. `https://steward.corp.example`, or `https://apps.corp.example/steward`) behind a reverse proxy. Used for the SSO redirect URI and links; `https://` makes the session cookie `Secure` and turns on HSTS. Its path is the base path.',
      readme: true,
    },
  ),
  SM_BASE_PATH: v(
    parsedBy('SM_BASE_PATH', (s) => parseBasePath(s)),
    {
      group: 'Server and network',
      default: '– (the root)',
      description:
        'Path prefix behind a reverse proxy, e.g. `/steward`: everything (UI, `/api`, health) moves below it; the proxy must not strip it. Must match the path of `SM_PUBLIC_URL`. An own subdomain is safer: [INSTALL.md](docs/INSTALL.md#behind-a-reverse-proxy)',
      readme: true,
    },
  ),
  SM_SHUTDOWN_GRACE_SECONDS: v(int(25, 0, 3600), {
    group: 'Server and network',
    default: '25',
    description:
      'On SIGTERM/SIGINT: how long running steps may still finish before their runs are marked interrupted. Give the container a little more (Docker `stop_grace_period`, Kubernetes `terminationGracePeriodSeconds`), see [docs/INSTALL.md](docs/INSTALL.md)',
    readme: true,
  }),
  SM_TRUST_PROXY: v(parsedBy('SM_TRUST_PROXY', parseTrustProxy), {
    group: 'Server and network',
    default: '– (off)',
    description:
      "Behind a reverse proxy: the proxies' addresses/CIDRs (`10.0.0.5,10.1.0.0/16`, `loopback`) or the number of proxies (`1`, only for a proxy on a loopback/private address) whose `X-Forwarded-For/-Proto/-Host` are believed. Client addresses in the audit log, sign-in lockouts and webhook CIDR checks then are the real ones.",
    readme: true,
  }),
  SM_OUTBOUND_POLICY: v(oneOf(['platforms', 'allowList', 'open'] as const), {
    group: 'Server and network',
    default: '– (the setting)',
    description:
      'Where platform calls, notifications and webhooks may connect: `platforms`, `allowList` or `open`. Overrides **Settings → Outbound connections**; loopback, link-local addresses and the own port are always blocked.',
  }),
  HTTPS_PROXY: v(text(), {
    group: 'Server and network',
    description: 'Corporate proxy (also `HTTP_PROXY`, `NO_PROXY`), used for platform calls unless a platform overrides it',
    readme: true,
  }),
  SM_DATASET_CACHE_ROWS: v(int(100_000, 0), {
    group: 'Database and data',
    default: '100000',
    description: 'Parsed dataset rows kept in memory between reads (dashboards, API pages); `0` turns the cache off',
    readme: true,
  }),
  SM_DEMO: v(flag(false), {
    group: 'Server and network',
    default: 'off',
    description: '`1` mounts the mock platforms under `/mock` and offers the demo data',
    readme: true,
  }),

  // Database and data
  SM_DATA_DIR: v(text(), { group: 'Database and data', default: './data', description: 'Data directory', readme: true }),
  SM_DATABASE_URL: v(text(), {
    group: 'Database and data',
    default: '– (SQLite in the data directory)',
    description:
      'Use PostgreSQL: `postgres://user:password@host:5432/database`. Not available in the desktop executable. See [Database](docs/INSTALL.md#5-database-sqlite-or-postgresql). Or `SM_DATABASE_URL_FILE`: a file with the URL (a Docker or Kubernetes secret)',
    readme: true,
    secret: true,
  }),
  SM_DATABASE_SCHEMA: v(text(), { group: 'Database and data', default: 'public', description: 'PostgreSQL schema (created if missing)', readme: true }),
  SM_DATABASE_CA: v(text(), {
    group: 'Database and data',
    description: "CA certificate (PEM file) for verifying the PostgreSQL server's TLS certificate",
    readme: true,
  }),
  SM_UPGRADE_BACKUPS: v(int(3, 0, 100), {
    group: 'Database and data',
    default: '3',
    description:
      'Automatic copies of the database made before an update migrates it, kept in `SM_UPGRADE_BACKUP_DIR` (`0` = none): a SQLite copy, or a `pg_dump` of the PostgreSQL schema (`SM_PG_DUMP`). See [Updating](docs/INSTALL.md#6-updating)',
    readme: true,
  }),
  SM_UPGRADE_BACKUP_DIR: v(text(), {
    group: 'Database and data',
    default: '`<data dir>/backups`',
    description: 'Folder of the automatic copies made before an update migrates the database (e.g. another volume for a large PostgreSQL dump)',
  }),
  SM_UPGRADE_BACKUP_REQUIRED: v(flag(true), {
    group: 'Database and data',
    default: 'on',
    description:
      'When the copy before migrating fails (no disk space, no `pg_dump`, a `pg_dump` older than the PostgreSQL server), the start stops without changing the database. `0` logs a warning and migrates without the copy',
  }),
  SM_UPGRADE_BACKUP_TIMEOUT_SECONDS: v(int(3600, 0, 7 * 24 * 3600), {
    group: 'Database and data',
    default: '3600',
    description: 'PostgreSQL: longest time the `pg_dump` before migrating may take (`0` = no limit); a dump that takes longer counts as failed',
  }),
  SM_SQLITE_AUTO_VACUUM: v(flag(true), {
    group: 'Database and data',
    default: 'on',
    description:
      'SQLite: new databases are created with incremental auto-vacuum, and the retention clean-up gives deleted space back to the file system in small steps. `0`: new databases without it',
  }),
  SM_SQLITE_VACUUM_AT_START: v(flag(false), {
    group: 'Database and data',
    default: 'off',
    description:
      'SQLite: `1` rewrites the database file before the server starts (VACUUM; seconds per GB, nothing answers meanwhile) and turns on incremental auto-vacuum – once, for a database made before 0.11 after a large clean-up. See [Disk space](docs/INSTALL.md#disk-space-after-a-clean-up)',
  }),
  SM_METRIC_RETENTION_DAYS: v(int(400, 1), {
    group: 'Database and data',
    default: '400',
    description: 'How long dashboard metric history is kept',
    readme: true,
  }),
  SM_AI_USAGE_RETENTION_DAYS: v(int(400, 1), {
    group: 'Database and data',
    default: '400',
    description: 'How long the usage log of AI model calls is kept (days; budgets need the current month). See [AI models](docs/AI.md#reporting)',
  }),

  // Unlocking (read by config.ts and removed from the environment at once – never part of `env`)
  SM_MASTER_PASSPHRASE_FILE: v(text(), {
    group: 'Unlocking',
    description:
      'File with the master passphrase: unlock automatically at start-up, so schedules run after a reboot. Use a Docker secret, a systemd credential (`%d/…`) or a file only the service account can read.',
    readme: true,
  }),
  SM_MASTER_PASSPHRASE: v(text(), {
    group: 'Unlocking',
    description: 'The same, as a variable (prefer the file). Both are removed from the environment at start, so child processes never see them.',
    readme: true,
    secret: true,
  }),

  // Sign-in and sessions
  SM_PASSWORD_LOGIN: v(oneOf(['all', 'adminsOnly', 'none'] as const), {
    group: 'Sign-in and sessions',
    default: '– (the setting)',
    description:
      "Who may sign in with a password: `all`, `adminsOnly` or `none` (single sign-on only, from an admin's first SSO). Wins over **Settings → Sign-in**, which then shows it read-only. Emergency access from the server's command line works in every mode ([docs/INSTALL.md](docs/INSTALL.md#locked-out-of-single-sign-on)).",
    readme: true,
  }),
  SM_SESSION_IDLE_MINUTES: v(int(30, 5, 7 * 24 * 60), {
    group: 'Sign-in and sessions',
    default: '30',
    description: 'A session ends after this many minutes without a request (an open Steward tab keeps it alive), 5–10080',
    readme: true,
  }),
  SM_SESSION_MAX_HOURS: v(int(12, 1, 30 * 24), {
    group: 'Sign-in and sessions',
    default: '12',
    description: 'A session ends this many hours after sign-in, used or not (OWASP ASVS level 2), 1–720',
    readme: true,
  }),
  SM_STEP_UP_MINUTES: v(int(5, 1, 15), {
    group: 'Sign-in and sessions',
    default: '5',
    description:
      'How long a confirmation for sensitive actions lasts (step-up: the password again or a fresh single sign-on), 1–15; also the oldest `auth_time` accepted. The longest age: the assurance policy can set a shorter one per action ([docs/ASSURANCE.md](docs/ASSURANCE.md)). See [docs/SECURITY-HARDENING.md](docs/SECURITY-HARDENING.md#step-up-re-authentication)',
    readme: true,
  }),
  SM_PASSWORD_HASH_CONCURRENCY: v(int(2, 1, 64), {
    group: 'Sign-in and sessions',
    default: '2',
    description: 'Password hashes computed at the same time; further sign-ins wait in a short queue (503 when it is full)',
  }),

  // Limits
  SM_RATE_LIMIT_PER_MINUTE: v(limit(600), {
    group: 'Limits',
    default: '600',
    description:
      "Requests per minute and signed-in user (otherwise per client address) on the web app's API, webhooks and web UI files; expensive actions have lower limits of their own; `0` = off. See [docs/SECURITY-HARDENING.md](docs/SECURITY-HARDENING.md#request-rate-limits)",
    readme: true,
  }),
  SM_MAX_CONCURRENT_RUNS: v(int(20, 0, 10000), {
    group: 'Limits',
    default: '20',
    description: 'Runs at the same time; more wait in status _queued_ (first come, first served) until one ends or waits for a decision. `0`: no limit',
    readme: true,
  }),
  SM_MAP_CACHE_MB: v(int(256, 0, 1_000_000), {
    group: 'Limits',
    default: '256',
    description:
      'Disk cache of the map of sites (`<data>/cache/map/`, least recently used out), in MB; `0` = no disk cache. See [docs/PLANT.md](docs/PLANT.md#map)',
  }),
  SM_EVENT_LOOP_WARN_MS: v(int(1000, 50), {
    group: 'Limits',
    default: '1000',
    description: 'A warning is logged when the event loop was blocked longer (at most once a minute); `sm_event_loop_lag_seconds` has the p99',
    readme: true,
  }),
  SM_EXPR_TIMEOUT_MS: v(int(5000, 1), { group: 'Limits', default: '5000', description: 'Time limit of one JSONata expression evaluation (ms)' }),
  SM_EXPR_MAX_DEPTH: v(int(1000, 1), { group: 'Limits', default: '1000', description: 'Maximum recursion depth of a JSONata expression' }),
  SM_EXPR_MAX_SEQUENCE: v(int(1_000_000, 1), {
    group: 'Limits',
    default: '1000000',
    description: 'Longest sequence (array, range `[a..b]`) a JSONata expression may create',
  }),

  // API, MCP and metrics
  SM_API_V1: v(flag(true), {
    group: 'API, MCP and metrics',
    default: 'on',
    description: '`off` turns the public REST API (`/api/v1`) and its documentation off',
    readme: true,
  }),
  SM_API_DOCS: v(oneOf(['off', 'authenticated', 'public'] as const), {
    group: 'API, MCP and metrics',
    default: '– (the setting)',
    description:
      'Who may open the API documentation (`/api/docs/`, `openapi.json` without a token): `off`, `authenticated` (signed-in users, the default) or `public`. Overrides the setting under **Settings → REST API**.',
    readme: true,
  }),
  SM_API_RATE_LIMIT: v(limit(600), {
    group: 'API, MCP and metrics',
    default: '600',
    description: 'Requests per minute and API token on `/api/v1`; `0` = unlimited',
    readme: true,
  }),
  SM_MCP: v(optionalFlag(), {
    group: 'API, MCP and metrics',
    default: '– (the setting)',
    description: '`off` turns the MCP server (`/api/mcp`) off, whatever **Settings → MCP server** says (`on` has no effect: the setting decides)',
    readme: true,
  }),
  SM_MCP_RATE_LIMIT: v(int(120, 1), { group: 'API, MCP and metrics', default: '120', description: 'MCP requests per minute and token', readme: true }),
  SM_MCP_GATEWAY_RATE_LIMIT: v(int(30, 1), {
    group: 'API, MCP and metrics',
    default: '30',
    description: 'MCP platform gateway calls per minute, user and platform',
    readme: true,
  }),
  SM_MCP_GATEWAY_CONCURRENCY: v(int(2, 1), {
    group: 'API, MCP and metrics',
    default: '2',
    description: "MCP gateway calls at the same time per platform (never more than half of the platform's _max. concurrent requests_)",
  }),
  SM_MCP_ALLOWED_ORIGINS: v(list(), {
    group: 'API, MCP and metrics',
    description: 'Origins of browser-based MCP clients allowed to call `/api/mcp` (comma-separated)',
    readme: true,
  }),
  SM_METRICS_PUBLIC: v(flag(false), {
    group: 'API, MCP and metrics',
    default: 'off',
    description: '`1` serves `/api/metrics` without sign-in (otherwise admins, auditors or an API token)',
    readme: true,
  }),

  // Audit log and evidence
  SM_AUDIT_ANCHOR: v(text(), {
    group: 'Audit log and evidence',
    description:
      'A signed audit checkpoint kept outside Steward. Every verification fails if the log is shorter than it or differs. See [docs/SECURITY-HARDENING.md](docs/SECURITY-HARDENING.md#audit-log-as-evidence).',
    readme: true,
  }),
  SM_AUDIT_ANCHOR_FILE: v(text(), {
    group: 'Audit log and evidence',
    description: 'A file with a signed audit checkpoint (e.g. on a write-once share); checked like `SM_AUDIT_ANCHOR`',
    readme: true,
  }),
  SM_AUDIT_CHECKPOINT_MINUTES: v(int(60, 5), {
    group: 'Audit log and evidence',
    default: '60',
    description: 'Interval of signed audit checkpoints (at least 5)',
    readme: true,
  }),
  SM_AUDIT_FULL_VERIFY_DAYS: v(int(7, 0), {
    group: 'Audit log and evidence',
    default: '7',
    description:
      'Days between automatic full verifications of the audit chain in the background (`0`: only by hand). *Verify chain* itself is incremental, from the newest signed checkpoint',
    readme: true,
  }),
  SM_EVIDENCE_MAX_MB: v(int(512, 1), { group: 'Audit log and evidence', default: '512', description: 'Largest audit evidence pack (MB)' }),
  SM_EVIDENCE_RETENTION_DAYS: v(int(7, 1), {
    group: 'Audit log and evidence',
    default: '7',
    description: 'How long a built evidence pack is kept for download',
  }),

  // Browser steps and reports
  SM_CHROMIUM_SANDBOX: v(optionalFlag(), {
    group: 'Browser steps and reports',
    default: 'auto',
    description: "`1`/`0` forces Chromium's sandbox for browser steps on/off (default: on, except as root)",
    readme: true,
  }),
  SM_CHROMIUM_PATH: v(text(), {
    group: 'Browser steps and reports',
    description: 'Use a specific Chromium/Chrome binary for browser steps',
    readme: true,
  }),
  SM_PDF_WORKER: v(
    raw.transform((s, ctx): 'auto' | 'off' => {
      const x = (s ?? '').toLowerCase();
      if (!x || x === 'auto' || x === 'on') return 'auto';
      if (x === 'off' || x === '0' || x === 'false') return 'off';
      return fail(ctx, `${quote(s!)} is not auto or off`);
    }),
    {
      group: 'Browser steps and reports',
      default: 'auto',
      description:
        'PDF reports are drawn in a worker thread (`auto`; falls back to the main thread when it cannot start) or always in the main thread (`off`, no time limit then). See [docs/REPORTS.md](docs/REPORTS.md)',
    },
  ),

  // Logging, tracing and error reporting
  SM_LOG_LEVEL: v(oneOf(LOG_LEVELS), {
    group: 'Logging, tracing and error reporting',
    default: 'info',
    description: '`fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. Logs are JSON lines on stdout.',
    readme: true,
  }),
  SM_LOG_LEVEL_FORMAT: v(oneOf(['number', 'label'] as const), {
    group: 'Logging, tracing and error reporting',
    default: 'number',
    description:
      'How log lines carry their level: `number` (pino: `"level":30`) or `label` (`"level":"info"`, for Loki, Elasticsearch or Cloud Logging pipelines that expect words)',
  }),
  OTEL_EXPORTER_OTLP_ENDPOINT: v(text(), {
    group: 'Logging, tracing and error reporting',
    description: 'Turns on OpenTelemetry tracing (OTLP/HTTP). Standard `OTEL_*` variables apply, e.g. `OTEL_SERVICE_NAME` and `OTEL_EXPORTER_OTLP_HEADERS`.',
    readme: true,
  }),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: v(text(), {
    group: 'Logging, tracing and error reporting',
    description: 'The traces endpoint only (wins over `OTEL_EXPORTER_OTLP_ENDPOINT`)',
  }),
  OTEL_SERVICE_NAME: v(textOr('steward'), {
    group: 'Logging, tracing and error reporting',
    default: 'steward',
    description: 'Service name of the traces',
  }),
  SM_OTEL_PROPAGATE: v(flag(true), {
    group: 'Logging, tracing and error reporting',
    default: 'on',
    description: '`0` stops adding `traceparent` headers to platform calls',
    readme: true,
  }),
  SM_SENTRY_DSN: v(text(), {
    group: 'Logging, tracing and error reporting',
    description:
      'Report unexpected errors to Sentry, GlitchTip or Bugsink (off by default; scrubbed, no personal data). More variables and exactly what is sent: [docs/ERROR-REPORTING.md](docs/ERROR-REPORTING.md). An invalid DSN only logs a warning. Or `SM_SENTRY_DSN_FILE`',
    readme: true,
    secret: true,
  }),
  SM_SENTRY_DSN_WEB: v(text(), {
    group: 'Logging, tracing and error reporting',
    default: '`SM_SENTRY_DSN`',
    description: 'DSN for errors in the web UI (`off` turns browser reporting off)',
  }),
  SM_SENTRY_ENVIRONMENT: v(textOr('production'), {
    group: 'Logging, tracing and error reporting',
    default: 'production',
    description: 'Environment name of reported errors',
  }),
  SM_SENTRY_RELEASE: v(text(), {
    group: 'Logging, tracing and error reporting',
    default: 'steward@<version>',
    description: 'Release name of reported errors',
  }),
  SM_SENTRY_TRACES_SAMPLE_RATE: v(num(0, 0, 1), {
    group: 'Logging, tracing and error reporting',
    default: '0',
    description: 'Share of requests traced to Sentry, 0–1 (0 = errors only); ignored while OpenTelemetry export is on',
  }),

  // Backups and migration
  SM_PG_DUMP: v(textOr('pg_dump'), {
    group: 'Backups and migration',
    default: 'pg_dump',
    description: '`pg_dump` program for backups of a PostgreSQL database (a newer server needs a matching version)',
  }),
  SM_PG_RESTORE: v(textOr('pg_restore'), { group: 'Backups and migration', default: 'pg_restore', description: '`pg_restore` program for restores' }),
  SM_BACKUP_PASSPHRASE: v(text(), {
    group: 'Backups and migration',
    description: 'Passphrase for `steward backup` (automation only; prefer `--passphrase-file` or the prompt). Or `SM_BACKUP_PASSPHRASE_FILE`',
    secret: true,
  }),
  SM_BACKUP_SINGLE_PUT_BYTES: v(int(32 * 1024 * 1024, 1), {
    group: 'Backups and migration',
    default: '33554432',
    description: 'S3 backups: larger archives are uploaded in parts',
  }),
  SM_BACKUP_PART_BYTES: v(int(16 * 1024 * 1024, 1024), {
    group: 'Backups and migration',
    default: '16777216',
    description: 'S3 backups: size of one part of a multipart upload (larger for archives that would need more than 10,000 parts)',
  }),
  SM_MIGRATION_MAX_MB: v(int(2048, 1), {
    group: 'Backups and migration',
    default: '2048',
    description: 'Largest migration package the web UI accepts for an import ([docs/MIGRATION.md](docs/MIGRATION.md))',
    readme: true,
  }),
  SM_MIGRATION_MAX_UNPACKED_MB: v(positive(20 * 1024), {
    group: 'Backups and migration',
    default: '20480',
    description:
      'Most a migration package may unpack to (tables, files, audit log); the import also checks for free disk space first ([docs/MIGRATION.md](docs/MIGRATION.md))',
    readme: true,
  }),
  SM_TRANSFER_PASSPHRASE: v(text(), {
    group: 'Backups and migration',
    description:
      'Transfer passphrase for `steward migrate` (automation only; prefer `--transfer-passphrase-file` or the prompt). Or `SM_TRANSFER_PASSPHRASE_FILE`',
    readme: true,
    secret: true,
  }),

  // Monitors (tests and development)
  SM_MONITOR_AUTOSTART: v(flag(true), {
    group: 'Monitors (tests and development)',
    default: 'on',
    description: '`0` does not start the monitor scheduler (tests drive it themselves)',
  }),
  SM_MONITOR_TICK_MS: v(int(1000, 1), { group: 'Monitors (tests and development)', default: '1000', description: 'Tick of the monitor scheduler (ms)' }),
  SM_MONITOR_CONCURRENCY: v(int(8, 1), { group: 'Monitors (tests and development)', default: '8', description: 'Monitor checks running at the same time' }),
  SM_MONITOR_EVAL_CONCURRENCY: v(int(8, 1), {
    group: 'Monitors (tests and development)',
    default: '8',
    description: 'Monitor hook evaluations at the same time',
  }),
  SM_MONITOR_DEMO_SIMULATOR: v(flag(true), {
    group: 'Monitors (tests and development)',
    default: 'on',
    description: 'Demo mode: `0` does not start the simulated gateway behind the demo monitors',
  }),
  SM_GATUS_AUTOSTART: v(flag(true), {
    group: 'Monitors (tests and development)',
    default: 'on',
    description: '`0` does not start the Gatus scraper (tests drive it themselves)',
  }),

  // Build and packaging (set by the image, the desktop executable or the build)
  SM_BUILD_COMMIT: v(text(), {
    group: 'Build and packaging',
    description: 'Commit of this build (About page, System status); set by the container image and compiled into the desktop executable',
  }),
  SM_BUILD_DATE: v(text(), { group: 'Build and packaging', description: 'Build date (ISO 8601), like `SM_BUILD_COMMIT`' }),
  SM_DEPLOYMENT: v(oneOf(['container', 'executable', 'node'] as const), {
    group: 'Build and packaging',
    default: 'detected',
    description: 'Installation type shown in System status; the container image sets `container`',
  }),
  SM_WEB_DIST: v(text(), { group: 'Build and packaging', default: 'web/dist', description: 'Folder of the built web UI' }),
  SM_EXAMPLES_DIR: v(text(), {
    group: 'Build and packaging',
    default: 'examples',
    description: 'Folder of the example library (processes, dashboards, monitors)',
  }),
  SM_ASSETS_DIR: v(text(), { group: 'Build and packaging', default: 'server/assets', description: 'Fonts, default logo and colour profile for PDF reports' }),
  SM_SWAGGER_UI_DIR: v(text(), {
    group: 'Build and packaging',
    default: 'from node_modules',
    description: 'Swagger UI files for the API documentation page (set by the desktop executable)',
  }),
} as const;

export type VarName = keyof typeof VARS;

/** Read by config.ts itself and removed from the environment right away: never part of the parsed `Env`. */
const NOT_KEPT = ['SM_MASTER_PASSPHRASE', 'SM_MASTER_PASSPHRASE_FILE'] as const;
type NotKept = (typeof NOT_KEPT)[number];

type Shape = { [K in Exclude<VarName, NotKept>]: (typeof VARS)[K]['schema'] };
const shape = Object.fromEntries(
  Object.entries(VARS)
    .filter(([k]) => !(NOT_KEPT as readonly string[]).includes(k))
    .map(([k, x]) => [k, x.schema]),
) as Shape;

export const envSchema = z.object(shape);
/** The validated configuration from the environment. */
export type Env = z.output<typeof envSchema>;

/** Raised for invalid variables: one line per variable, ready to print. */
export class ConfigError extends Error {
  constructor(readonly problems: { name: string; message: string }[]) {
    super(`Invalid configuration – fix these environment variables and start again:\n${problems.map((p) => `  ${p.name}: ${p.message}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Parses an environment (process.env, or an object in tests); throws a ConfigError listing every bad variable. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const r = envSchema.safeParse(source);
  if (r.success) return r.data;
  const seen = new Set<string>();
  const problems: { name: string; message: string }[] = [];
  for (const i of r.error.issues) {
    const name = String(i.path[0] ?? '?');
    if (seen.has(name)) continue;
    seen.add(name);
    problems.push({ name, message: i.message });
  }
  throw new ConfigError(problems);
}

/**
 * Secrets that can come from a file instead (`<NAME>_FILE`, the convention of Docker and Kubernetes secrets): every
 * variable marked `secret`. The master passphrase has its own SM_MASTER_PASSPHRASE_FILE (config.ts).
 */
export const FILE_VARIANTS: readonly VarName[] = (Object.keys(VARS) as VarName[]).filter((k) => VARS[k].doc.secret && k !== 'SM_MASTER_PASSPHRASE');

/**
 * `<NAME>_FILE` → `<NAME>`: the file's content without its trailing line break (read by `read`, so this stays free of
 * I/O). Setting both is an error, as is a file that cannot be read or is empty. Returns the environment with the values.
 */
export function resolveFileVariants(
  source: Record<string, string | undefined>,
  read: (file: string) => string,
): { env: Record<string, string | undefined>; problems: { name: string; message: string }[] } {
  const out = { ...source };
  const problems: { name: string; message: string }[] = [];
  for (const name of FILE_VARIANTS) {
    const fileVar = `${name}_FILE`;
    const file = source[fileVar]?.trim();
    if (!file) continue;
    if (source[name]?.trim()) {
      problems.push({ name: fileVar, message: `set either ${name} or ${fileVar}, not both` });
      continue;
    }
    try {
      out[name] = read(file);
    } catch (e) {
      problems.push({ name: fileVar, message: `cannot read ${file}: ${(e as Error).message}` });
    }
  }
  return { env: out, problems };
}

/** Variables with the SM_ prefix that are not Steward's own but expected in its environment (tests, CLIs). */
const OTHER_SM = ['SM_URL', 'SM_PLATFORM', 'SM_TOKEN'];
const OTHER_SM_PREFIXES = ['SM_TEST_', 'SM_E2E_'];

/** Levenshtein distance (small strings only). */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * SM_* variables that are set but mean nothing to Steward – usually a typo, which otherwise is silently ignored
 * (SM_DATABSE_URL starts on SQLite) – each with the closest known name when it is near enough. Names only, never values.
 */
export function unknownVariables(source: Record<string, string | undefined>): { name: string; suggestion?: string }[] {
  const known = [...Object.keys(VARS), ...FILE_VARIANTS.map((n) => `${n}_FILE`)];
  const knownSet = new Set([...known, ...OTHER_SM]);
  const out: { name: string; suggestion?: string }[] = [];
  for (const name of Object.keys(source).sort()) {
    if (!name.startsWith('SM_') || knownSet.has(name) || OTHER_SM_PREFIXES.some((p) => name.startsWith(p))) continue;
    let best: { name: string; d: number } | undefined;
    for (const k of known) {
      const d = distance(name, k);
      if (!best || d < best.d) best = { name: k, d };
    }
    // two edits, or three for long names (a missing word part: SM_UPGRADE_BACKUP → SM_UPGRADE_BACKUPS)
    out.push(best && best.d <= (name.length > 16 ? 3 : 2) ? { name, suggestion: best.name } : { name });
  }
  return out;
}

/** Only some variables (CLIs and the health check): an invalid variable they do not use does not stop them. */
export function parseEnvPart<K extends keyof Env>(source: Record<string, string | undefined>, keys: readonly K[]): Pick<Env, K> {
  const out: Record<string, unknown> = {};
  const problems: { name: string; message: string }[] = [];
  for (const k of keys) {
    const r = (VARS[k].schema as z.ZodType).safeParse(source[k]);
    if (r.success) out[k] = r.data;
    else problems.push({ name: k, message: r.error.issues[0]?.message ?? 'invalid value' });
  }
  if (problems.length) throw new ConfigError(problems);
  return out as Pick<Env, K>;
}
