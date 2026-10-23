import type { GatusEndpointState, GatusMetricsSource, GatusUptimes } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { vault } from '../vault.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { platformRequest, resolveBaseUrl } from '../platforms/http.js';
import { assertOutboundAllowed } from '../platforms/outbound.js';
import { outboundContext } from '../platforms/policyContext.js';
import { platformFor } from '../monitors/platforms.js';
import { parsePrometheus, type PromSample } from './prometheus.js';

/**
 * Gatus metrics mode: Steward scrapes Gatus' Prometheus endpoint (/metrics,
 * `metrics: true` in the Gatus configuration) on an interval and keeps
 *   - the newest state per endpoint (success gauge, duration, certificate and
 *     domain expiry, the counter values of the previous scrape),
 *   - one sample per scrape and endpoint (raw, kept rawRetentionDays),
 *   - hourly aggregates of the result counts and durations (kept retentionDays),
 *   - the changes of the success gauge (outages for reports).
 *
 * Uptime comes from the deltas of gatus_results_total{success="true|false"}:
 * the number of results Gatus produced between two scrapes. A counter that goes
 * down (Gatus restarted, or process_start_time_seconds changed) is a reset: the
 * new value is the number of results since the restart.
 *
 * /metrics is unauthenticated in Gatus. It is reached through the platform (its
 * base URL, proxy and TLS settings; credentials only to its own origin) and the
 * outbound policy, with a size limit and a timeout.
 */

export const METRICS_MAX_BYTES = 8 * 1024 * 1024;
/** Endpoints stored per scrape (bounds the samples written per interval). */
export const MAX_ENDPOINTS = 2000;
const HOUR = 3600000;
const DAY = 86400000;
export const UPTIME_DURATIONS = ['1h', '24h', '7d', '30d'] as const;

export interface SourceRow {
  platform_id: string;
  enabled: number;
  interval_seconds: number;
  retention_days: number;
  raw_retention_days: number;
  metrics_path: string;
  fetch_uptimes: number;
  owner: string;
  last_scrape_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_duration_ms: number | null;
  gatus_started_at: string | null;
  last_uptimes_at: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

interface EndpointRow {
  platform_id: string;
  key: string;
  group_name: string;
  name: string;
  type: string;
  success: number | null;
  duration_s: number | null;
  cert_expires_at: string | null;
  domain_expires_at: string | null;
  total_ok: number | null;
  total_fail: number | null;
  first_seen_at: string;
  last_seen_at: string;
  last_result_at: string | null;
  gatus_uptime: string | null;
}

export const sourceRow = (platformId: string): SourceRow | undefined => db().get<SourceRow>('SELECT * FROM gatus_sources WHERE platform_id = ?', platformId);

export function toSource(r: SourceRow): GatusMetricsSource {
  const p = db().get<{ name: string }>('SELECT name FROM platforms WHERE id = ?', r.platform_id);
  const n = db().get<{ n: number }>('SELECT COUNT(*) AS n FROM gatus_endpoints WHERE platform_id = ?', r.platform_id)?.n ?? 0;
  return {
    platformId: r.platform_id,
    platformName: p?.name ?? r.platform_id,
    enabled: !!r.enabled,
    intervalSeconds: r.interval_seconds,
    retentionDays: r.retention_days,
    rawRetentionDays: r.raw_retention_days,
    metricsPath: r.metrics_path,
    fetchUptimes: !!r.fetch_uptimes,
    owner: r.owner,
    lastScrapeAt: r.last_scrape_at,
    lastSuccessAt: r.last_success_at,
    lastError: r.last_error,
    lastDurationMs: r.last_duration_ms,
    gatusStartedAt: r.gatus_started_at,
    endpointCount: Number(n),
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

/** Whether a platform's Gatus data comes from the metrics scrape (enabled source). */
export const metricsEnabled = (platformId: string): boolean => !!sourceRow(platformId)?.enabled;

export interface SourceInput {
  enabled: boolean;
  intervalSeconds: number;
  retentionDays: number;
  rawRetentionDays: number;
  metricsPath: string;
  fetchUptimes: boolean;
}

/**
 * A path below the platform's base URL – never an absolute URL, so the scrape stays on the platform's
 * origin. No "." or ".." segments, also not percent-encoded (%2e), no encoded slashes or backslashes
 * (%2f, %5c) and no encoded percent signs (%25) that a server or proxy might decode into one.
 */
export function checkMetricsPath(p: string): string {
  const path = p.trim() || '/metrics';
  if (
    !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(path) ||
    path.startsWith('//') ||
    /%(2e|2f|5c|25)/i.test(path) ||
    /%(?![0-9a-f]{2})/i.test(path) ||
    /(^|\/)\.{1,2}(\/|$)/.test(path)
  ) {
    throw new HttpError(400, 'The metrics path must be a path below the base URL, e.g. /metrics', 'GATUS_METRICS_PATH');
  }
  return path;
}

/** The scrape URL: the path resolved below the base URL; refused when the resolved path leaves the base path. */
export function metricsUrlBelow(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  const url = new URL(baseUrl.replace(/\/+$/, '') + checkMetricsPath(path));
  const basePath = base.pathname.replace(/\/+$/, '') + '/';
  if (url.origin !== base.origin || !(url.pathname + '/').startsWith(basePath)) {
    throw new HttpError(400, 'The metrics path must be a path below the base URL, e.g. /metrics', 'GATUS_METRICS_PATH');
  }
  return url.toString();
}

export function saveSource(platformId: string, input: SourceInput, actor: string): SourceRow {
  const now = nowIso();
  const path = checkMetricsPath(input.metricsPath);
  db().run(
    `INSERT INTO gatus_sources (platform_id, enabled, interval_seconds, retention_days, raw_retention_days, metrics_path, fetch_uptimes, owner, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform_id) DO UPDATE SET enabled = excluded.enabled, interval_seconds = excluded.interval_seconds, retention_days = excluded.retention_days,
       raw_retention_days = excluded.raw_retention_days, metrics_path = excluded.metrics_path, fetch_uptimes = excluded.fetch_uptimes,
       owner = excluded.owner, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    platformId,
    input.enabled ? 1 : 0,
    input.intervalSeconds,
    input.retentionDays,
    input.rawRetentionDays,
    path,
    input.fetchUptimes ? 1 : 0,
    actor,
    now,
    now,
    actor,
  );
  return sourceRow(platformId)!;
}

/** Removes the source and every sample of it (also when the platform is deleted). */
export function deleteSource(platformId: string): void {
  manualScrapes.delete(platformId);
  db().tx(() => {
    for (const t of ['gatus_samples', 'gatus_hourly', 'gatus_transitions', 'gatus_endpoints', 'gatus_sources'])
      db().run(`DELETE FROM ${t} WHERE platform_id = ?`, platformId);
  });
}

// ---------- scraping ----------

interface Parsed {
  key: string;
  group: string;
  name: string;
  type: string;
  ok: number;
  fail: number;
  success: number | null;
  durationS: number | null;
  certS: number | null;
  domainS: number | null;
}

const KEPT = new Set([
  'gatus_results_total',
  'gatus_results_duration_seconds',
  'gatus_results_certificate_expiration_seconds',
  'gatus_results_domain_expiration_seconds',
  'gatus_results_endpoint_success',
  'process_start_time_seconds',
]);

/** Folds the samples into one record per endpoint key (extra labels are summed / the last value wins). */
export function endpointsFromSamples(samples: PromSample[]): { endpoints: Map<string, Parsed>; startedAt: number | null } {
  const endpoints = new Map<string, Parsed>();
  let startedAt: number | null = null;
  for (const s of samples) {
    if (s.name === 'process_start_time_seconds') {
      if (Number.isFinite(s.value) && s.value > 0) startedAt = s.value * 1000;
      continue;
    }
    const key = s.labels.key;
    if (!key || key.length > 300 || !Number.isFinite(s.value)) continue;
    let e = endpoints.get(key);
    if (!e) {
      e = {
        key,
        group: s.labels.group ?? '',
        name: s.labels.name ?? '',
        type: s.labels.type ?? '',
        ok: 0,
        fail: 0,
        success: null,
        durationS: null,
        certS: null,
        domainS: null,
      };
      endpoints.set(key, e);
    }
    switch (s.name) {
      case 'gatus_results_total':
        if (s.labels.success === 'true') e.ok += s.value;
        else if (s.labels.success === 'false') e.fail += s.value;
        break;
      case 'gatus_results_duration_seconds':
        e.durationS = s.value;
        break;
      case 'gatus_results_certificate_expiration_seconds':
        e.certS = s.value;
        break;
      case 'gatus_results_domain_expiration_seconds':
        e.domainS = s.value;
        break;
      case 'gatus_results_endpoint_success':
        e.success = s.value >= 1 ? 1 : 0;
        break;
    }
  }
  return { endpoints, startedAt };
}

const hourOf = (t: number) => new Date(Math.floor(t / HOUR) * HOUR).toISOString();
const minuteIso = (t: number) => new Date(Math.round(t / 60000) * 60000).toISOString();

export interface ScrapeResult {
  ok: boolean;
  endpoints: number;
  samples: number;
  malformed: number;
  resets: number;
  durationMs: number;
  error?: string;
}

/** Hook for the credentials register: keep "expires at" in sync (registered by credentials/service.ts). */
let onCertificateExpiry: ((platformId: string, expiries: Map<string, string>) => void) | undefined;
export function setCertificateExpiryHook(fn: typeof onCertificateExpiry): void {
  onCertificateExpiry = fn;
}

/** Stores one scrape (exported for tests). */
export function storeScrape(platformId: string, text: string, now: number): { endpoints: number; samples: number; malformed: number; resets: number } {
  const parsed = parsePrometheus(text, { keep: (n) => KEPT.has(n), maxBytes: METRICS_MAX_BYTES });
  const { endpoints: all, startedAt } = endpointsFromSamples(parsed.samples);
  const endpoints = new Map([...all].slice(0, MAX_ENDPOINTS));
  if (all.size > MAX_ENDPOINTS)
    logger.warn({ platformId, endpoints: all.size, stored: MAX_ENDPOINTS }, 'Gatus metrics: too many endpoints, the rest is ignored');
  const src = sourceRow(platformId);
  const prevStart = src?.gatus_started_at ? Date.parse(src.gatus_started_at) : null;
  // a different process start time means Gatus restarted: all counters started from zero
  const restarted = startedAt !== null && prevStart !== null && Math.abs(startedAt - prevStart) > 1000;
  const ts = new Date(now).toISOString();
  const bucket = hourOf(now);
  let resets = 0;
  const expiries = new Map<string, string>();
  db().tx(() => {
    for (const e of endpoints.values()) {
      const prev = db().get<EndpointRow>('SELECT * FROM gatus_endpoints WHERE platform_id = ? AND key = ?', platformId, e.key);
      let dOk = 0;
      let dFail = 0;
      let reset = false;
      if (prev && prev.total_ok !== null && prev.total_fail !== null) {
        reset = restarted || e.ok < prev.total_ok || e.fail < prev.total_fail;
        dOk = reset ? e.ok : e.ok - prev.total_ok;
        dFail = reset ? e.fail : e.fail - prev.total_fail;
      }
      if (reset) resets++;
      dOk = Math.max(0, Math.round(dOk));
      dFail = Math.max(0, Math.round(dFail));
      const fresh = dOk + dFail > 0;
      db().run(
        'INSERT INTO gatus_samples (platform_id, key, ts, ok, fail, success, duration_s, reset) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        platformId,
        e.key,
        ts,
        dOk,
        dFail,
        e.success,
        e.durationS,
        reset ? 1 : 0,
      );
      const countDuration = fresh && e.durationS !== null;
      db().run(
        `INSERT INTO gatus_hourly (platform_id, key, bucket, ok, fail, duration_sum, duration_count, duration_max) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(platform_id, key, bucket) DO UPDATE SET ok = gatus_hourly.ok + excluded.ok, fail = gatus_hourly.fail + excluded.fail,
           duration_sum = gatus_hourly.duration_sum + excluded.duration_sum, duration_count = gatus_hourly.duration_count + excluded.duration_count,
           duration_max = CASE WHEN excluded.duration_max IS NULL THEN gatus_hourly.duration_max
                               WHEN gatus_hourly.duration_max IS NULL OR excluded.duration_max > gatus_hourly.duration_max THEN excluded.duration_max
                               ELSE gatus_hourly.duration_max END`,
        platformId,
        e.key,
        bucket,
        dOk,
        dFail,
        countDuration ? e.durationS : 0,
        countDuration ? 1 : 0,
        countDuration ? e.durationS : null,
      );
      if (e.success !== null && (!prev || prev.success === null || prev.success !== e.success)) {
        db().run('INSERT INTO gatus_transitions (platform_id, key, ts, success) VALUES (?, ?, ?, ?)', platformId, e.key, ts, e.success);
      }
      const cert = e.certS !== null && e.certS > 0 ? minuteIso(now + e.certS * 1000) : null;
      const domain = e.domainS !== null && e.domainS > 0 ? minuteIso(now + e.domainS * 1000) : null;
      if (cert) expiries.set(e.key, cert);
      db().run(
        `INSERT INTO gatus_endpoints (platform_id, key, group_name, name, type, success, duration_s, cert_expires_at, domain_expires_at, total_ok, total_fail, first_seen_at, last_seen_at, last_result_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(platform_id, key) DO UPDATE SET group_name = excluded.group_name, name = excluded.name, type = excluded.type, success = excluded.success,
           duration_s = excluded.duration_s, cert_expires_at = excluded.cert_expires_at, domain_expires_at = excluded.domain_expires_at,
           total_ok = excluded.total_ok, total_fail = excluded.total_fail, last_seen_at = excluded.last_seen_at,
           last_result_at = COALESCE(excluded.last_result_at, gatus_endpoints.last_result_at)`,
        platformId,
        e.key,
        e.group,
        e.name,
        e.type,
        e.success,
        e.durationS,
        cert,
        domain,
        e.ok,
        e.fail,
        ts,
        ts,
        fresh || !prev ? ts : null,
      );
    }
    if (src) {
      db().run(
        'UPDATE gatus_sources SET gatus_started_at = ? WHERE platform_id = ?',
        startedAt !== null ? new Date(startedAt).toISOString() : src.gatus_started_at,
        platformId,
      );
    }
  });
  if (expiries.size && onCertificateExpiry) {
    try {
      onCertificateExpiry(platformId, expiries);
    } catch (err) {
      logger.warn({ err, platformId }, 'certificate expiry sync failed');
    }
  }
  return { endpoints: endpoints.size, samples: parsed.samples.length, malformed: parsed.malformed, resets };
}

const running = new Set<string>();

/** One scrape of a source: fetch /metrics, store it, optionally refresh the uptime figures from Gatus' API. */
export async function scrape(platformId: string, now = Date.now()): Promise<ScrapeResult> {
  const src = sourceRow(platformId);
  if (!src) throw new HttpError(404, 'Metrics mode is not configured for this platform', 'GATUS_METRICS_OFF');
  if (running.has(platformId)) return { ok: false, endpoints: 0, samples: 0, malformed: 0, resets: 0, durationMs: 0, error: 'A scrape is already running' };
  running.add(platformId);
  const t0 = Date.now();
  try {
    const { platform, secrets } = platformFor(src.owner, platformId);
    const url = metricsUrlBelow(await resolveBaseUrl(platform, secrets), src.metrics_path);
    await assertOutboundAllowed(url, outboundContext());
    const timeout = Math.min(30, Math.max(5, src.interval_seconds - 1)) * 1000;
    const r = await platformRequest(
      platform,
      secrets,
      {
        method: 'GET',
        url: src.metrics_path,
        headers: { accept: 'text/plain;version=0.0.4;q=1, */*;q=0.1' },
        maxResponseBytes: METRICS_MAX_BYTES,
        rawText: true,
      },
      AbortSignal.timeout(timeout),
    );
    if (r.status !== 200)
      throw new Error(
        `Gatus answered HTTP ${r.status} for ${src.metrics_path}${r.status === 404 ? ' – is "metrics: true" set in the Gatus configuration?' : ''}`,
      );
    const stored = storeScrape(platformId, String(r.body ?? ''), now);
    if (!stored.endpoints) throw new Error('The answer contains no gatus_results_* metrics – is this the Gatus metrics endpoint?');
    const durationMs = Date.now() - t0;
    db().run(
      'UPDATE gatus_sources SET last_scrape_at = ?, last_success_at = ?, last_error = NULL, last_duration_ms = ? WHERE platform_id = ?',
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      durationMs,
      platformId,
    );
    if (src.fetch_uptimes && (!src.last_uptimes_at || now - Date.parse(src.last_uptimes_at) >= HOUR)) {
      await fetchUptimes(platformId, src.owner).catch((err) =>
        logger.warn({ err: { message: (err as Error).message }, platformId }, 'Gatus uptime figures could not be read'),
      );
      db().run('UPDATE gatus_sources SET last_uptimes_at = ? WHERE platform_id = ?', new Date(now).toISOString(), platformId);
    }
    return { ok: true, ...stored, durationMs };
  } catch (e) {
    const message = String((e as Error).message ?? e).slice(0, 500);
    db().run(
      'UPDATE gatus_sources SET last_scrape_at = ?, last_error = ?, last_duration_ms = ? WHERE platform_id = ?',
      new Date(now).toISOString(),
      message,
      Date.now() - t0,
      platformId,
    );
    return { ok: false, endpoints: 0, samples: 0, malformed: 0, resets: 0, durationMs: Date.now() - t0, error: message };
  } finally {
    running.delete(platformId);
  }
}

/** Shortest time between two manual scrapes of a source (each one writes a sample per endpoint). */
export const MANUAL_SCRAPE_MIN_MS = 15000;
const manualScrapes = new Map<string, number>();

/** "Scrape now" from the UI/API: at most every MANUAL_SCRAPE_MIN_MS per source (429 otherwise). */
export async function manualScrape(platformId: string, now = Date.now()): Promise<ScrapeResult> {
  if (!sourceRow(platformId)) throw new HttpError(404, 'Metrics mode is not configured for this platform', 'GATUS_METRICS_OFF');
  const last = manualScrapes.get(platformId);
  if (last !== undefined && now - last < MANUAL_SCRAPE_MIN_MS) {
    const seconds = Math.ceil((MANUAL_SCRAPE_MIN_MS - (now - last)) / 1000);
    throw new HttpError(429, `This source was scraped a moment ago – try again in ${seconds} s`, 'RATE_LIMITED', { context: 'scrape', seconds });
  }
  manualScrapes.set(platformId, now);
  return scrape(platformId, now);
}

/** For tests: forget the manual scrape times. */
export function resetManualScrapes(): void {
  manualScrapes.clear();
}

/** A fraction (0.958333, text/plain in Gatus ≤ v5) or JSON ({"uptime":0.95} or a bare number) → percent. */
export function parseUptime(body: unknown): number | null {
  let v: unknown = body;
  if (v && typeof v === 'object') v = (v as { uptime?: unknown; value?: unknown }).uptime ?? (v as { value?: unknown }).value;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*[\d.]+(e-?\d+)?\s*$/i.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return Math.round(n * 10000) / 100;
}

/** Reads /api/v1/endpoints/{key}/uptimes/{1h,24h,7d,30d} (unauthenticated in Gatus) for every known endpoint. */
async function fetchUptimes(platformId: string, owner: string): Promise<void> {
  const { platform, secrets } = platformFor(owner, platformId);
  const keys = db()
    .all<{ key: string }>('SELECT key FROM gatus_endpoints WHERE platform_id = ? ORDER BY last_seen_at DESC LIMIT 200', platformId)
    .map((r) => r.key);
  const queue = [...keys];
  const worker = async () => {
    for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
      const out: GatusUptimes = { h1: null, h24: null, d7: null, d30: null };
      for (const d of UPTIME_DURATIONS) {
        const r = await platformRequest(
          platform,
          secrets,
          { method: 'GET', url: `/api/v1/endpoints/${encodeURIComponent(key)}/uptimes/${d}`, maxResponseBytes: 4096 },
          AbortSignal.timeout(10000),
        ).catch(() => null);
        if (r?.ok) out[d === '1h' ? 'h1' : d === '24h' ? 'h24' : d === '7d' ? 'd7' : 'd30'] = parseUptime(r.body);
      }
      db().run('UPDATE gatus_endpoints SET gatus_uptime = ? WHERE platform_id = ? AND key = ?', JSON.stringify(out), platformId, key);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

// ---------- engine ----------

let timer: NodeJS.Timeout | undefined;

/** Scrapes every enabled source when it is due (checked every 5 s; nothing runs while the vault is locked). */
export function tickScraper(now = Date.now()): string[] {
  if (!vault().unlocked) return [];
  const due = db()
    .all<SourceRow>('SELECT * FROM gatus_sources WHERE enabled = 1')
    .filter((s) => !running.has(s.platform_id) && (!s.last_scrape_at || now - Date.parse(s.last_scrape_at) >= s.interval_seconds * 1000 - 500));
  for (const s of due) {
    scrape(s.platform_id).then(
      (r) => {
        if (!r.ok) logger.warn({ platformId: s.platform_id, error: r.error }, 'Gatus metrics scrape failed');
      },
      (err) => logger.warn({ err, platformId: s.platform_id }, 'Gatus metrics scrape failed'),
    );
  }
  return due.map((s) => s.platform_id);
}

export function startGatusScraper(): void {
  // tests drive the scraper themselves
  if (timer || process.env.SM_GATUS_AUTOSTART === '0') return;
  timer = setInterval(() => {
    try {
      tickScraper();
    } catch (err) {
      logger.warn({ err }, 'Gatus scraper tick failed');
    }
  }, 5000);
  timer.unref();
}

export function stopGatusScraper(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

// ---------- retention ----------

/**
 * Raw samples after rawRetentionDays, hourly data and status changes after retentionDays (the newest change
 * per endpoint stays), endpoints not seen for retentionDays with their data.
 */
export function pruneGatusData(now = Date.now()): { samples: number; hourly: number; transitions: number } {
  const out = { samples: 0, hourly: 0, transitions: 0 };
  for (const s of db().all<SourceRow>('SELECT * FROM gatus_sources')) {
    const raw = new Date(now - s.raw_retention_days * DAY).toISOString();
    const agg = new Date(now - s.retention_days * DAY).toISOString();
    db().tx(() => {
      out.samples += db().run('DELETE FROM gatus_samples WHERE platform_id = ? AND ts < ?', s.platform_id, raw).changes;
      out.hourly += db().run('DELETE FROM gatus_hourly WHERE platform_id = ? AND bucket < ?', s.platform_id, agg).changes;
      out.transitions += db().run(
        `DELETE FROM gatus_transitions WHERE platform_id = ? AND ts < ?
           AND id NOT IN (SELECT keep FROM (SELECT MAX(id) AS keep FROM gatus_transitions WHERE platform_id = ? GROUP BY key) newest)`,
        s.platform_id,
        agg,
        s.platform_id,
      ).changes;
      // endpoints removed from the Gatus configuration: nothing left to report once their data is gone
      for (const t of ['gatus_transitions', 'gatus_hourly', 'gatus_samples']) {
        db().run(
          `DELETE FROM ${t} WHERE platform_id = ? AND key IN (SELECT key FROM gatus_endpoints WHERE platform_id = ? AND last_seen_at < ?)`,
          s.platform_id,
          s.platform_id,
          agg,
        );
      }
      db().run('DELETE FROM gatus_endpoints WHERE platform_id = ? AND last_seen_at < ?', s.platform_id, agg);
    });
  }
  // data of sources that were removed
  db().run('DELETE FROM gatus_samples WHERE platform_id NOT IN (SELECT platform_id FROM gatus_sources)');
  return out;
}

// ---------- queries ----------

const pct = (ok: number, fail: number) => (ok + fail > 0 ? Math.round((ok / (ok + fail)) * 10000) / 100 : null);

/** Uptime per endpoint over a period, from the hourly aggregates. */
export function uptimeBetween(
  platformId: string,
  from: number,
  to: number,
): Map<string, { ok: number; fail: number; uptime: number | null; durationSum: number; durationCount: number; durationMax: number | null }> {
  const rows = db().all<{ key: string; ok: number; fail: number; ds: number; dc: number; dm: number | null }>(
    `SELECT key, SUM(ok) AS ok, SUM(fail) AS fail, SUM(duration_sum) AS ds, SUM(duration_count) AS dc, MAX(duration_max) AS dm
     FROM gatus_hourly WHERE platform_id = ? AND bucket >= ? AND bucket < ? GROUP BY key`,
    platformId,
    hourOf(from),
    new Date(to).toISOString(),
  );
  return new Map(
    rows.map((r) => [
      r.key,
      {
        ok: Number(r.ok),
        fail: Number(r.fail),
        uptime: pct(Number(r.ok), Number(r.fail)),
        durationSum: Number(r.ds),
        durationCount: Number(r.dc),
        durationMax: r.dm === null ? null : Number(r.dm),
      },
    ]),
  );
}

export function endpointStates(platformId: string, now = Date.now()): GatusEndpointState[] {
  const rows = db().all<EndpointRow>('SELECT * FROM gatus_endpoints WHERE platform_id = ? ORDER BY group_name, name, key', platformId);
  const windows: [keyof GatusUptimes, number][] = [
    ['h1', HOUR],
    ['h24', DAY],
    ['d7', 7 * DAY],
    ['d30', 30 * DAY],
  ];
  const ups = windows.map(([k, ms]) => [k, uptimeBetween(platformId, now - ms, now + HOUR)] as const);
  return rows.map((r) => {
    const uptime = Object.fromEntries(ups.map(([k, m]) => [k, m.get(r.key)?.uptime ?? null])) as unknown as GatusUptimes;
    return {
      key: r.key,
      group: r.group_name,
      name: r.name,
      type: r.type,
      success: r.success === null ? null : !!r.success,
      durationMs: r.duration_s === null ? null : Math.round(r.duration_s * 1000),
      certificateExpiresAt: r.cert_expires_at,
      domainExpiresAt: r.domain_expires_at,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      lastResultAt: r.last_result_at,
      uptime,
      gatusUptime: r.gatus_uptime ? parseJson<GatusUptimes | null>(r.gatus_uptime, null) : null,
    };
  });
}

export function endpointState(platformId: string, key: string): (EndpointRow & { recent: { ok: number; fail: number; ts: string }[] }) | null {
  const r = db().get<EndpointRow>('SELECT * FROM gatus_endpoints WHERE platform_id = ? AND key = ?', platformId, key);
  if (!r) return null;
  const recent = db().all<{ ok: number; fail: number; ts: string }>(
    'SELECT ok, fail, ts FROM gatus_samples WHERE platform_id = ? AND key = ? AND (ok > 0 OR fail > 0) ORDER BY id DESC LIMIT 100',
    platformId,
    key,
  );
  return { ...r, recent };
}

export interface EndpointAvailability {
  key: string;
  group: string;
  name: string;
  uptime: number | null;
  results: number;
  failed: number;
  avgMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  /** p95 is computed from the raw samples; null when they were already pruned for the period */
  outages: { from: string; to: string | null; durationMs: number }[];
  downtimeMs: number;
}

const p95 = (values: number[]): number | null => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
};

/** Availability per endpoint for a report period: uptime (counter deltas), response times, outages (success gauge changes). */
export function availability(platformId: string, keys: string[] | null, from: number, to: number): EndpointAvailability[] {
  const ups = uptimeBetween(platformId, from, to);
  const eps = db()
    .all<EndpointRow>('SELECT * FROM gatus_endpoints WHERE platform_id = ? ORDER BY group_name, name, key', platformId)
    .filter((e) => !keys || keys.includes(e.key));
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to).toISOString();
  return eps.map((e) => {
    const u = ups.get(e.key);
    const durations = db()
      .all<{ d: number }>(
        'SELECT duration_s AS d FROM gatus_samples WHERE platform_id = ? AND key = ? AND ts >= ? AND ts < ? AND duration_s IS NOT NULL AND (ok > 0 OR fail > 0)',
        platformId,
        e.key,
        fromIso,
        toIso,
      )
      .map((r) => Number(r.d) * 1000);
    const before = db().get<{ ts: string; success: number }>(
      'SELECT ts, success FROM gatus_transitions WHERE platform_id = ? AND key = ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT 1',
      platformId,
      e.key,
      fromIso,
    );
    const changes = db().all<{ ts: string; success: number }>(
      'SELECT ts, success FROM gatus_transitions WHERE platform_id = ? AND key = ? AND ts >= ? AND ts < ? ORDER BY ts, id',
      platformId,
      e.key,
      fromIso,
      toIso,
    );
    const outages = outagesFrom(
      before
        ? [{ t: from, down: !before.success }, ...changes.map((c) => ({ t: Date.parse(c.ts), down: !c.success }))]
        : changes.map((c) => ({ t: Date.parse(c.ts), down: !c.success })),
      to,
    );
    return {
      key: e.key,
      group: e.group_name,
      name: e.name,
      uptime: u?.uptime ?? null,
      results: (u?.ok ?? 0) + (u?.fail ?? 0),
      failed: u?.fail ?? 0,
      avgMs: u && u.durationCount ? Math.round((u.durationSum / u.durationCount) * 1000) : null,
      p95Ms: durations.length ? Math.round(p95(durations)!) : null,
      maxMs: u?.durationMax !== null && u?.durationMax !== undefined ? Math.round(u.durationMax * 1000) : null,
      outages,
      downtimeMs: outages.reduce((s, o) => s + o.durationMs, 0),
    };
  });
}

/** Down intervals from a sorted list of state points, clipped to `to` (an open outage has to = null). */
export function outagesFrom(points: { t: number; down: boolean }[], to: number): EndpointAvailability['outages'] {
  const out: EndpointAvailability['outages'] = [];
  let start: number | null = null;
  for (const p of points) {
    if (p.down && start === null) start = p.t;
    else if (!p.down && start !== null) {
      out.push({ from: new Date(start).toISOString(), to: new Date(p.t).toISOString(), durationMs: p.t - start });
      start = null;
    }
  }
  if (start !== null) out.push({ from: new Date(start).toISOString(), to: null, durationMs: Math.max(0, Math.min(to, Date.now()) - start) });
  return out;
}

export const listSources = (): SourceRow[] => db().all<SourceRow>('SELECT * FROM gatus_sources ORDER BY platform_id');
