/**
 * Optional error reporting to a Sentry-compatible service (Sentry, GlitchTip,
 * Bugsink, …). Off unless SM_SENTRY_DSN (server) and/or SM_SENTRY_DSN_WEB
 * (browser) is set. The SDK is only loaded when a DSN is configured.
 *
 *   SM_SENTRY_DSN                  DSN for server errors (also used for the web UI unless SM_SENTRY_DSN_WEB is set)
 *   SM_SENTRY_DSN_WEB              DSN for browser errors ("off" disables browser reporting)
 *   SM_SENTRY_ENVIRONMENT          environment name (default "production")
 *   SM_SENTRY_RELEASE              release name (default "steward@<version>")
 *   SM_SENTRY_TRACES_SAMPLE_RATE   0..1, performance traces to Sentry (default 0 = errors only);
 *                                  ignored while OpenTelemetry export (OTEL_EXPORTER_OTLP_*) is on
 *
 * Only *unexpected* errors are reported: 5xx responses, unhandled exceptions and
 * rejections, internal engine errors. Failed runs, rejected requests, platforms
 * answering 4xx etc. are business outcomes and stay in the run log and audit log.
 * Every event is scrubbed (see @sm/shared scrubEvent) – what is sent is listed in
 * docs/ERROR-REPORTING.md.
 */
import { createHash } from 'node:crypto';
import os from 'node:os';
import { BRAND, scrubBreadcrumb, scrubEvent, type ClientConfig } from '@sm/shared';
import { config } from './config.js';
import { logger } from './log.js';
import { activeTraceIds, tracingEnabled } from './telemetry.js';
import { HttpError } from './util.js';

type SentryNode = typeof import('@sentry/node');

export interface ErrorReportingSettings {
  dsn?: string;
  webDsn?: string;
  environment: string;
  release: string;
  tracesSampleRate: number;
}

/** Checks a DSN (https://<public key>@<host>/<project id>); returns undefined when it is not usable. */
export function parseDsn(dsn: string | undefined): URL | undefined {
  if (!dsn?.trim()) return undefined;
  try {
    const u = new URL(dsn.trim());
    if (!/^https?:$/.test(u.protocol) || !u.username || !/\/\d+$|\/[\w-]+$/.test(u.pathname)) return undefined;
    return u;
  } catch {
    return undefined;
  }
}

export function errorReportingSettings(env: NodeJS.ProcessEnv = process.env): ErrorReportingSettings {
  const dsn = env.SM_SENTRY_DSN?.trim() || undefined;
  const webRaw = env.SM_SENTRY_DSN_WEB?.trim();
  const webDsn = webRaw === 'off' || webRaw === '0' || webRaw === 'false' ? undefined : webRaw || dsn;
  const rate = Number(env.SM_SENTRY_TRACES_SAMPLE_RATE ?? 0);
  return {
    dsn: parseDsn(dsn) ? dsn : undefined,
    webDsn: parseDsn(webDsn) ? webDsn : undefined,
    environment: env.SM_SENTRY_ENVIRONMENT?.trim() || 'production',
    release: env.SM_SENTRY_RELEASE?.trim() || `${BRAND.slug}@${config.version}`,
    tracesSampleRate: Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 0,
  };
}

/** What the web UI needs to report its own errors (served by GET /api/client-config). */
export function clientConfig(): ClientConfig {
  const s = errorReportingSettings();
  return { errorReporting: s.webDsn ? { dsn: s.webDsn, environment: s.environment, release: s.release } : null };
}

/** Extra CSP connect-src origins: the browser DSN's host, only when browser reporting is on. */
export function cspConnectSources(): string[] {
  const u = parseDsn(errorReportingSettings().webDsn);
  return u ? [u.origin] : [];
}

// ---------------------------------------------------------------------------

let sentry: SentryNode | undefined;
let staticSecrets: string[] = [];
let dynamicSecrets: (() => string[]) | undefined;
/** Secrets known only where the error happened (e.g. the run's redactor), keyed by the error object. */
const errorSecrets = new WeakMap<object, string[]>();

const SECRET_ENV = /SECRET|PASSW|PASSPHRASE|TOKEN|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|_KEY$|^SM_SENTRY_DSN/i;

function envSecrets(): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!v || v.length < 6 || !SECRET_ENV.test(k)) continue;
    if (/^SM_SENTRY_DSN/.test(k)) {
      // the DSN's public key is not secret, but there is no reason to repeat it in events either
      const u = parseDsn(v);
      if (u?.username) out.push(u.username);
      continue;
    }
    out.push(v);
  }
  if (config.masterPassphrase) out.push(config.masterPassphrase);
  return out;
}

export function errorReportingEnabled(): boolean {
  return !!sentry;
}

/** Opaque, stable id for a user (no names, no e-mail): lets you count affected users. */
export function userHash(userId: string): string {
  return createHash('sha256').update(`${BRAND.slug}:${userId}`).digest('hex').slice(0, 16);
}

export interface InitOptions {
  /** Current secret values to scrub (e.g. all platform secrets); called per event, failures are ignored. */
  secretValues?: () => string[];
  /** Overrides (tests). */
  settings?: Partial<ErrorReportingSettings>;
}

/** Initialises the SDK when SM_SENTRY_DSN is set. Never throws: a broken setup only logs a warning. */
export async function initErrorReporting(opts: InitOptions = {}): Promise<boolean> {
  if (sentry) return true;
  const s = { ...errorReportingSettings(), ...opts.settings };
  if (process.env.SM_SENTRY_DSN && !s.dsn) logger.warn('SM_SENTRY_DSN is not a valid DSN (https://<key>@<host>/<project>) – error reporting stays off');
  if (process.env.SM_SENTRY_DSN_WEB && !['off', '0', 'false'].includes(process.env.SM_SENTRY_DSN_WEB) && !s.webDsn) {
    logger.warn('SM_SENTRY_DSN_WEB is not a valid DSN – browser error reporting stays off');
  }
  if (!s.dsn) return false;
  let S: SentryNode;
  try {
    S = await import('@sentry/node');
  } catch (e) {
    logger.warn({ err: e }, 'error reporting is configured but the Sentry SDK cannot be loaded in this build – continuing without it');
    return false;
  }
  staticSecrets = envSecrets();
  dynamicSecrets = opts.secretValues;

  // Tracing: OpenTelemetry (telemetry.ts) owns the tracer provider when OTLP export is on. Sentry then only
  // reports errors (no second tracer provider, no double instrumentation). Without OTLP export a sample rate
  // > 0 lets Sentry set up OpenTelemetry itself, and the run/step/HTTP spans of telemetry.ts go to Sentry.
  let traces = s.tracesSampleRate;
  if (traces > 0 && tracingEnabled()) {
    logger.warn('SM_SENTRY_TRACES_SAMPLE_RATE is ignored while OpenTelemetry export is on – send the OTLP traces to your tracing backend');
    traces = 0;
  }
  const sentryTracing = traces > 0;

  try {
    S.init({
      dsn: s.dsn,
      environment: s.environment,
      release: s.release,
      sendDefaultPii: false,
      serverName: BRAND.slug, // not the host name
      // explicit list instead of the defaults: no console/HTTP breadcrumbs, no local variables,
      // no request bodies/headers, no module list, no release-health sessions
      defaultIntegrations: false,
      integrations: [
        S.eventFiltersIntegration(),
        S.functionToStringIntegration(),
        S.linkedErrorsIntegration(),
        S.dedupeIntegration(),
        S.onUncaughtExceptionIntegration(),
        // keep Node's default (crash on an unhandled rejection), but report it first
        S.onUnhandledRejectionIntegration({ mode: 'strict' }),
        S.contextLinesIntegration(),
        S.nodeContextIntegration({ cloudResource: false }),
        S.systemErrorIntegration(),
        ...(sentryTracing ? [S.httpIntegration({ breadcrumbs: false }), S.nativeNodeFetchIntegration({ breadcrumbs: false }), ...S.getAutoPerformanceIntegrations()] : []),
      ],
      ...(sentryTracing ? { tracesSampleRate: traces } : { skipOpenTelemetrySetup: true }),
      registerEsmLoaderHooks: false,
      includeLocalVariables: false,
      maxBreadcrumbs: 30,
      beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb, { secrets: staticSecrets }),
      beforeSend: (event, hint) => scrub(event, hint?.originalException),
      beforeSendTransaction: (event) => scrub(event, undefined),
    });
  } catch (e) {
    logger.warn({ err: e }, 'could not initialise error reporting – continuing without it');
    return false;
  }
  sentry = S;
  logger.info({ host: parseDsn(s.dsn)!.host, environment: s.environment, release: s.release, traces: sentryTracing }, 'error reporting on');
  return true;
}

function scrub<T>(event: T, original: unknown): T {
  const secrets = [...staticSecrets, ...homeDirs()];
  if (dynamicSecrets) {
    try {
      secrets.push(...dynamicSecrets());
    } catch {
      /* vault locked etc. – the patterns below still apply */
    }
  }
  if (original && typeof original === 'object') secrets.push(...(errorSecrets.get(original) ?? []));
  return scrubEvent(event, { secrets });
}

/** The home directory contains the OS user name (e.g. C:\\Users\\jdoe on a work laptop). */
function homeDirs(): string[] {
  try {
    const h = os.homedir();
    return h.length >= 6 ? [h] : [];
  } catch {
    return [];
  }
}

/** True for programming errors (TypeError etc.) – not for network failures or invalid user input. */
export function isInternalError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e instanceof HttpError) return e.statusCode >= 500;
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return false;
  const code = (e as NodeJS.ErrnoException).code;
  if (e instanceof TypeError) {
    // fetch() reports network problems and invalid URLs as TypeError
    if (e.cause || code === 'ERR_INVALID_URL' || /fetch failed|invalid url|failed to parse url/i.test(e.message)) return false;
    return true;
  }
  return e instanceof ReferenceError || e instanceof RangeError || e instanceof EvalError;
}

/** False for expected outcomes (4xx HttpErrors). */
export function isUnexpected(e: unknown): boolean {
  return !(e instanceof HttpError && e.statusCode < 500);
}

export interface ReportContext {
  /** Low-cardinality labels (e.g. route pattern, node type). No user data. */
  tags?: Record<string, string | number | boolean | undefined>;
  /** The signed-in user; only a hash of the id is sent. */
  userId?: string | null;
  /** Method and path (the query string is removed). */
  request?: { method: string; url: string };
  /** Additional secret values known at the call site (e.g. a run's redactor). */
  secrets?: string[];
  level?: 'fatal' | 'error' | 'warning';
}

/** Reports an unexpected error (no-op when error reporting is off). Returns the event id. */
export function reportError(err: unknown, ctx: ReportContext = {}): string | undefined {
  if (!sentry) return undefined;
  try {
    if (ctx.secrets?.length && err && typeof err === 'object') errorSecrets.set(err, ctx.secrets);
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(ctx.tags ?? {})) if (v !== undefined) tags[k] = String(v);
    const trace = activeTraceIds();
    if (trace.trace_id) tags.trace_id = trace.trace_id; // correlate with the OpenTelemetry trace
    return sentry.captureException(err, {
      level: ctx.level ?? 'error',
      tags,
      ...(ctx.userId ? { user: { id: userHash(ctx.userId) } } : {}),
      ...(ctx.request ? { contexts: { route: { method: ctx.request.method, path: ctx.request.url.split('?')[0] } } } : {}),
    });
  } catch {
    return undefined; // reporting must never break the caller
  }
}

export async function flushErrorReporting(timeoutMs = 2000): Promise<void> {
  await sentry?.flush(timeoutMs).catch(() => undefined);
}

export async function closeErrorReporting(timeoutMs = 2000): Promise<void> {
  const s = sentry;
  sentry = undefined;
  await s?.close(timeoutMs).catch(() => undefined);
}
