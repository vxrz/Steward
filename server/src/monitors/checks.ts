import { execFile } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import { Agent, EnvHttpProxyAgent, fetch, type Dispatcher } from 'undici';
import type { CheckOf, MonitorStatus, Platform } from '@sm/shared';
import { evalExpr } from '../engine/expr.js';
import { platformRequest, type HttpResult } from '../platforms/http.js';
import { findRecording, missingRecording } from '../platforms/recordings.js';
import { assertAddressSafe, assertNetAllowed, assertOutboundAllowed, guardedLookup } from '../platforms/outbound.js';
import { outboundContext } from '../platforms/policyContext.js';
import { BRAND, isGitPlatformKind } from '@sm/shared';
import { freshnessStatus, freshnessWindowSeconds, fmtAge, statusMatcher } from './logic.js';
import { promInstant, seriesName } from '../platforms/prometheus.js';
import { readNamespace } from '../catalogue/kubernetes.js';
import { assertRepositoryPath, gitHost } from '../catalogue/repositories.js';
import { checkmkFetch, checkmkServiceKey, gatusFetch, ihFetch, ihKey, SourceError } from './batch.js';
import { CheckSetupError, platformFor } from './platforms.js';
import { endpointState, metricsEnabled, sourceRow } from '../gatus/metrics.js';

/**
 * Check executors. Each returns a raw result; `unknown` means the check could
 * not be carried out (missing platform, vault locked, expression error …),
 * not that the target is down.
 */

export interface RawResult {
  status: MonitorStatus;
  message: string;
  durationMs?: number;
  value?: unknown;
}

export interface ExecContext {
  owner: string;
  signal: AbortSignal;
  timeoutMs: number;
  now: () => number;
  /** Test run (#105): platform calls are answered by recorded responses; `recorded` is set when one answered */
  recorded?: { recorded: boolean };
}

/** A platform call of a check: the platform, or its recorded response in a test run (null: none recorded). */
async function checkRequest(
  ctx: ExecContext,
  platform: Platform,
  secrets: Record<string, string>,
  req: { method: string; url: string; query?: Record<string, unknown>; headers?: Record<string, string>; body?: unknown },
): Promise<HttpResult | { missing: string }> {
  if (ctx.recorded) {
    const hit = findRecording(platform.id, req);
    if (!hit) return { missing: missingRecording(platform.name, req.method, req.url, req.query).message };
    ctx.recorded.recorded = true;
    return hit.result;
  }
  return platformRequest(
    platform,
    secrets,
    { method: req.method as 'GET', url: req.url, query: req.query, headers: req.headers, body: req.body },
    AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)]),
  );
}

const GUARD = { timeoutMs: 1000, maxDepth: 200 };
const truthy = (v: unknown) => Boolean(Array.isArray(v) ? v.length : v);

// ---------- TCP / ping ----------

export function tcpConnect(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; ms: number; code?: string }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host, port, lookup: guardedLookup });
    let done = false;
    const finish = (ok: boolean, code?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      sock.destroy();
      resolve({ ok, ms: Date.now() - t0, code });
    };
    const onAbort = () => finish(false, 'ECANCELED');
    const timer = setTimeout(() => finish(false, 'ETIMEDOUT'), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    sock.once('connect', () => finish(true));
    sock.once('error', (e: NodeJS.ErrnoException) => finish(false, e.code ?? 'ERROR'));
  });
}

const TCP_MESSAGES: Record<string, string> = {
  ECONNREFUSED: 'connection refused',
  ETIMEDOUT: 'timeout',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'host name not found',
  EAI_AGAIN: 'name resolution failed',
};

async function checkTcp(c: CheckOf<'tcp'>, ctx: ExecContext): Promise<RawResult> {
  await assertNetAllowed(c.host, c.port, outboundContext());
  const r = await tcpConnect(c.host, c.port, ctx.timeoutMs, ctx.signal);
  if (!r.ok) return { status: 'down', message: `${c.host}:${c.port} – ${TCP_MESSAGES[r.code ?? ''] ?? r.code}`, durationMs: r.ms };
  if (c.degradedMs && r.ms > c.degradedMs)
    return { status: 'degraded', message: `Connected in ${r.ms} ms (warning above ${c.degradedMs} ms)`, durationMs: r.ms };
  return { status: 'up', message: `Connected to ${c.host}:${c.port} in ${r.ms} ms`, durationMs: r.ms };
}

let pingUnavailableUntil = 0;
let pingUnavailableReason = '';

/** Fixed arguments, one echo request; the host was validated by the schema (no leading "-"). */
function pingArgs(host: string, timeoutMs: number): string[] {
  if (process.platform === 'win32') return ['-n', '1', '-w', String(timeoutMs), host];
  if (process.platform === 'darwin') return ['-n', '-c', '1', '-W', String(timeoutMs), host];
  return ['-n', '-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), host];
}

function runPing(host: string, timeoutMs: number): Promise<{ unavailable: string } | { ok: boolean; rttMs?: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      'ping',
      pingArgs(host, timeoutMs),
      { timeout: timeoutMs + 2000, windowsHide: true, env: { PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        const out = `${stdout}\n${stderr}`;
        const e = err as (NodeJS.ErrnoException & { code?: string | number }) | null;
        if (e && (e.code === 'ENOENT' || e.code === 'EACCES'))
          return resolve({ unavailable: e.code === 'ENOENT' ? 'the ping command is not installed' : 'ping may not be executed' });
        if (/operation not permitted|permission denied|socket: |cap_net_raw/i.test(out))
          return resolve({ unavailable: 'ICMP is not permitted for this process' });
        const rtt = /time[=<]\s*([\d.]+)\s*ms/i.exec(out);
        resolve({ ok: !e, rttMs: rtt ? Number(rtt[1]) : undefined, output: out.trim().split('\n').slice(-2).join(' ').slice(0, 200) });
      },
    );
  });
}

async function checkPing(c: CheckOf<'ping'>, ctx: ExecContext): Promise<RawResult> {
  await assertNetAllowed(c.host, c.fallbackPort ?? 0, outboundContext());
  if (Date.now() >= pingUnavailableUntil) {
    const t0 = Date.now();
    const r = await runPing(c.host, ctx.timeoutMs);
    if (!('unavailable' in r)) {
      const ms = r.rttMs ?? Date.now() - t0;
      if (!r.ok) return { status: 'down', message: `${c.host} does not answer ping`, durationMs: Date.now() - t0 };
      if (c.degradedRttMs && ms > c.degradedRttMs)
        return { status: 'degraded', message: `Round trip ${ms} ms (warning above ${c.degradedRttMs} ms)`, durationMs: Math.round(ms) };
      return { status: 'up', message: `${c.host} answers ping in ${ms} ms`, durationMs: Math.round(ms) };
    }
    pingUnavailableReason = r.unavailable;
    pingUnavailableUntil = Date.now() + 10 * 60000;
  }
  // fallback: TCP connect – an accepted or a refused connection both prove that the host answers
  const port = c.fallbackPort ?? 80;
  const r = await tcpConnect(c.host, port, ctx.timeoutMs, ctx.signal);
  const via = `TCP fallback on port ${port}, because ${pingUnavailableReason}`;
  if (r.ok || r.code === 'ECONNREFUSED') {
    if (c.degradedRttMs && r.ms > c.degradedRttMs) return { status: 'degraded', message: `${c.host} answers in ${r.ms} ms (${via})`, durationMs: r.ms };
    return { status: 'up', message: `${c.host} answers (${via})`, durationMs: r.ms };
  }
  return { status: 'down', message: `${c.host} does not answer – ${TCP_MESSAGES[r.code ?? ''] ?? r.code} (${via})`, durationMs: r.ms };
}

/** For tests: forget that ping was unavailable. */
export function resetPingProbe(): void {
  pingUnavailableUntil = 0;
}

// ---------- HTTP ----------

const dispatchers = new Map<string, Dispatcher>();
function dispatcherFor(insecure: boolean, proxy: boolean): Dispatcher {
  const key = `${insecure}|${proxy}`;
  let d = dispatchers.get(key);
  if (!d) {
    const connect = { rejectUnauthorized: !insecure, lookup: guardedLookup };
    d = proxy ? new EnvHttpProxyAgent({ connect, requestTls: connect } as never) : new Agent({ connect });
    dispatchers.set(key, d);
  }
  return d;
}

const certCache = new Map<string, { at: number; validTo: number | null }>();
function certExpiry(host: string, port: number, timeoutMs: number): Promise<number | null> {
  const key = `${host}:${port}`;
  const hit = certCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600000) return Promise.resolve(hit.validTo);
  return new Promise((resolve) => {
    // Only reads the expiry date of whatever certificate the server presents (also an expired or self-signed one,
    // which is what this check reports); nothing is sent and the socket is closed right away.
    // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification -- no data goes over this connection
    const sock = tls.connect({
      host,
      port,
      servername: net.isIP(host) ? undefined : host,
      rejectUnauthorized: false,
      timeout: timeoutMs,
      lookup: guardedLookup,
    });
    const done = (v: number | null) => {
      sock.destroy();
      if (v !== null) certCache.set(key, { at: Date.now(), validTo: v });
      resolve(v);
    };
    sock.once('secureConnect', () => {
      const cert = sock.getPeerCertificate();
      done(cert?.valid_to ? Date.parse(cert.valid_to) : null);
    });
    sock.once('error', () => done(null));
    sock.once('timeout', () => done(null));
  });
}

async function readLimited(res: Awaited<ReturnType<typeof fetch>>, max = 1024 * 1024): Promise<string> {
  if (!res.body) return '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += (chunk as Uint8Array).length;
    if (size > max) break;
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function evaluateCondition(expr: string | undefined, scope: unknown): Promise<{ ok: boolean } | { error: string }> {
  if (!expr?.trim()) return { ok: true };
  try {
    return { ok: truthy(await evalExpr(expr, scope, {}, GUARD)) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * fetch for monitor http checks that follows redirects manually (max 5): the
 * check's own headers (which may carry credentials) are only sent to the initial
 * origin and dropped on any cross-origin redirect, and each hop is re-checked
 * against the outbound policy. The default `redirect: 'follow'` keeps custom
 * headers across origins, which would leak them.
 */
async function monitorFetch(c: CheckOf<'http'>, signal: AbortSignal): Promise<Awaited<ReturnType<typeof fetch>>> {
  const dispatcher = dispatcherFor(!!c.insecureTls, c.useProxy !== false);
  let url = c.url;
  let method = c.method;
  let body: string | undefined = c.method === 'POST' ? (c.body ?? '') : undefined;
  const initialOrigin = new URL(c.url).origin;
  for (let hop = 0; ; hop++) {
    const sameOrigin = new URL(url).origin === initialOrigin;
    const headers: Record<string, string> = { 'user-agent': `${BRAND.slug}-monitor` };
    if (sameOrigin) for (const [k, v] of Object.entries(c.headers ?? {})) headers[k] = v;
    const res = await fetch(url, { method, headers, body, dispatcher, signal, redirect: 'manual' });
    const location = res.headers.get('location');
    if (!REDIRECT_CODES.has(res.status) || !location || hop >= 5) return res;
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return res;
    }
    await assertAddressSafe(next.toString());
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
      method = 'GET';
      body = undefined;
    }
    url = next.toString();
  }
}

async function checkHttp(c: CheckOf<'http'>, ctx: ExecContext): Promise<RawResult> {
  const matcher = statusMatcher(c.expectStatus);
  const t0 = Date.now();
  try {
    await assertOutboundAllowed(c.url, outboundContext());
  } catch (e) {
    return { status: 'unknown', message: `Target not allowed: ${(e as Error).message}`.slice(0, 300), durationMs: Date.now() - t0 };
  }
  let res;
  try {
    res = await monitorFetch(c, AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)]));
  } catch (e) {
    const err = e as Error & { cause?: Error & { code?: string } };
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      status: 'down',
      message: `${c.method} ${c.url} failed: ${timedOut ? 'timeout' : (err.cause?.message ?? err.message)}`.slice(0, 300),
      durationMs: Date.now() - t0,
    };
  }
  const text = c.method === 'HEAD' ? '' : await readLimited(res).catch(() => '');
  const durationMs = Date.now() - t0;
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  let body: unknown = text;
  if (text && /json/i.test(headers['content-type'] ?? '')) {
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
  }
  if (!matcher(res.status)) return { status: 'down', message: `HTTP ${res.status} (expected ${c.expectStatus || '200-399'})`, durationMs, value: res.status };
  const cond = await evaluateCondition(c.condition, { status: res.status, headers, body, durationMs });
  // Never echo the upstream response body (the error message may embed it): report only that it errored.
  if ('error' in cond) return { status: 'unknown', message: 'Condition could not be evaluated (the response did not match the expression)', durationMs };
  if (!cond.ok) return { status: 'down', message: `HTTP ${res.status}, but the condition is false`, durationMs, value: res.status };
  if (/^https:/i.test(c.url) && (c.tlsExpiryWarnDays ?? 14) > 0) {
    const u = new URL(c.url);
    const validTo = await certExpiry(u.hostname, Number(u.port || 443), ctx.timeoutMs);
    if (validTo !== null) {
      const days = Math.floor((validTo - Date.now()) / 86400000);
      if (days < 0) return { status: 'down', message: `TLS certificate expired ${-days} days ago`, durationMs };
      if (days < (c.tlsExpiryWarnDays ?? 14)) return { status: 'degraded', message: `TLS certificate expires in ${days} days`, durationMs };
    }
  }
  if (c.degradedResponseMs && durationMs > c.degradedResponseMs) {
    return { status: 'degraded', message: `HTTP ${res.status} in ${durationMs} ms (warning above ${c.degradedResponseMs} ms)`, durationMs, value: res.status };
  }
  return { status: 'up', message: `HTTP ${res.status} in ${durationMs} ms`, durationMs, value: res.status };
}

// ---------- platform API ----------

async function checkPlatform(c: CheckOf<'platform'>, ctx: ExecContext): Promise<RawResult> {
  const { platform, secrets } = platformFor(ctx.owner, c.platform);
  const t0 = Date.now();
  let r;
  try {
    const res = await checkRequest(ctx, platform, secrets, {
      method: c.method,
      url: c.path,
      query: c.query,
      headers: c.headers,
      body: c.method === 'POST' ? c.body : undefined,
    });
    if ('missing' in res) return { status: 'unknown', message: res.missing.slice(0, 500), durationMs: 0 };
    r = res;
  } catch (e) {
    return {
      status: 'down',
      message: `${c.method} ${c.path} on "${platform.name}" failed: ${(e as Error).message}`.slice(0, 500),
      durationMs: Date.now() - t0,
    };
  }
  const durationMs = r.durationMs;
  const scope = { status: r.status, headers: r.headers, body: r.body, durationMs };
  if (c.condition?.trim()) {
    const cond = await evaluateCondition(c.condition, scope);
    if ('error' in cond) return { status: 'unknown', message: 'Condition could not be evaluated (the response did not match the expression)', durationMs };
    if (!cond.ok) return { status: 'down', message: `HTTP ${r.status}, but the condition is false`, durationMs, value: r.status };
  } else if (!r.ok) return { status: 'down', message: `HTTP ${r.status} from "${platform.name}"`, durationMs, value: r.status };
  if (c.degradedResponseMs && durationMs > c.degradedResponseMs) {
    return { status: 'degraded', message: `HTTP ${r.status} in ${durationMs} ms (warning above ${c.degradedResponseMs} ms)`, durationMs, value: r.status };
  }
  return { status: 'up', message: `HTTP ${r.status} in ${durationMs} ms`, durationMs, value: r.status };
}

// ---------- freshness ----------

/** Registers the shared read of an Insights Hub freshness check (called for all due checks before they run). */
export function planFreshness(c: CheckOf<'freshness'>, owner: string): void {
  if (c.source !== 'insightsHub' || !c.assetId || !c.aspect) return;
  ihFetch.plan(ihKey(c.platform, c.assetId, c.aspect), { owner, vars: c.variables ?? [], windowSeconds: Math.ceil(freshnessWindowSeconds(c) * 1.5) });
}

async function checkFreshness(c: CheckOf<'freshness'>, ctx: ExecContext): Promise<RawResult> {
  const now = ctx.now();
  const t0 = Date.now();
  if (c.source === 'insightsHub') {
    platformFor(ctx.owner, c.platform); // the owner's rights, also when the answer comes from the shared read
    const vars = c.variables ?? [];
    let latest;
    try {
      latest = await ihFetch.get(ihKey(c.platform, c.assetId!, c.aspect!), {
        owner: ctx.owner,
        vars,
        windowSeconds: Math.ceil(freshnessWindowSeconds(c) * 1.5),
      });
    } catch (e) {
      if (e instanceof CheckSetupError) throw e;
      return { status: 'unknown', message: `Freshness could not be read: ${(e as Error).message}`, durationMs: Date.now() - t0 };
    }
    const per = vars.map((v) => ({ v, ...freshnessStatus(latest.get(v) ?? null, now, c, `value of ${v}`) }));
    const worst = per.reduce((a, b) => (rank(b.status) > rank(a.status) ? b : a), per[0]!);
    const ages = Object.fromEntries(per.map((p) => [p.v, p.ageSeconds === null ? null : Math.round(p.ageSeconds)]));
    if (per.length === 1) return { status: worst.status, message: worst.message, durationMs: Date.now() - t0, value: ages };
    const bad = per.filter((p) => p.status !== 'up');
    const message = bad.length
      ? bad.map((p) => p.message).join('; ')
      : `All ${per.length} variables are fresh (oldest ${fmtAge(Math.max(...per.map((p) => p.ageSeconds ?? 0)))})`;
    return { status: worst.status, message, durationMs: Date.now() - t0, value: ages };
  }
  const { platform, secrets } = platformFor(ctx.owner, c.platform);
  let r;
  try {
    const res = await checkRequest(ctx, platform, secrets, { method: 'GET', url: c.path!, query: c.query });
    if ('missing' in res) return { status: 'unknown', message: res.missing.slice(0, 500), durationMs: 0 };
    r = res;
  } catch (e) {
    return { status: 'unknown', message: `Freshness could not be read: ${(e as Error).message}`.slice(0, 500), durationMs: Date.now() - t0 };
  }
  if (!r.ok) return { status: 'unknown', message: `Freshness could not be read: HTTP ${r.status} from "${platform.name}"`, durationMs: r.durationMs };
  let ts: unknown;
  try {
    ts = await evalExpr(c.timestamp!, r.body, {}, GUARD);
  } catch (e) {
    return { status: 'unknown', message: `Timestamp expression failed: ${(e as Error).message}`, durationMs: r.durationMs };
  }
  const times = (Array.isArray(ts) ? ts : [ts]).map(toMillis).filter((x): x is number => x !== undefined);
  const latest = times.length ? Math.max(...times) : null;
  const f = freshnessStatus(latest, now, c);
  return { status: f.status, message: f.message, durationMs: r.durationMs, value: latest ? new Date(latest).toISOString() : null };
}

const rank = (s: MonitorStatus) => ({ up: 0, maintenance: 1, blocked: 2, unknown: 3, degraded: 4, down: 5 })[s];

export function toMillis(t: unknown): number | undefined {
  if (t === undefined || t === null || t === '' || typeof t === 'boolean') return undefined;
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  const n = Date.parse(String(t));
  return Number.isNaN(n) ? undefined : n;
}

// ---------- Gatus ----------

/** Metrics mode: explicitly, or automatically when the platform has an enabled metrics source. */
const useMetrics = (c: CheckOf<'gatus'>): boolean => c.source === 'metrics' || ((c.source ?? 'auto') === 'auto' && metricsEnabled(c.platform));

export function planGatus(c: CheckOf<'gatus'>, owner: string): void {
  if (useMetrics(c)) return;
  gatusFetch.plan(c.platform, { owner, pageSize: Math.max(1, c.degradedOnRecentFailures ?? 1) });
}

/** Reads the state Steward scraped from Gatus' /metrics (no call to Gatus). */
function checkGatusMetrics(c: CheckOf<'gatus'>, ctx: ExecContext): RawResult {
  const src = sourceRow(c.platform);
  if (!src) return { status: 'unknown', message: 'Gatus metrics mode is not configured for this platform' };
  if (!src.last_success_at)
    return { status: 'unknown', message: `Gatus metrics have not been scraped yet${src.last_error ? `: ${src.last_error}` : ''}`.slice(0, 500) };
  const scrapeAge = (ctx.now() - Date.parse(src.last_success_at)) / 1000;
  if (scrapeAge > Math.max(3 * src.interval_seconds, 180)) {
    return {
      status: 'unknown',
      message: `The last successful Gatus metrics scrape is ${fmtAge(scrapeAge)} old${src.last_error ? ` (${src.last_error})` : ''}`.slice(0, 500),
    };
  }
  const e = endpointState(c.platform, c.endpointKey);
  if (!e) return { status: 'unknown', message: `Gatus has no endpoint with the key "${c.endpointKey}" in its metrics` };
  const ms = e.duration_s !== null ? Math.round(e.duration_s * 1000) : undefined;
  const label = `${e.group_name ? `${e.group_name}/` : ''}${e.name || e.key}`;
  if (c.maxAgeSeconds && e.last_result_at) {
    const age = (ctx.now() - Date.parse(e.last_result_at)) / 1000;
    if (age > c.maxAgeSeconds)
      return { status: 'down', message: `Gatus produced no new result for ${fmtAge(age)} (maximum ${fmtAge(c.maxAgeSeconds)})`, durationMs: ms };
  }
  if (e.success === null) return { status: 'unknown', message: `Gatus metrics have no success value for "${label}" yet`, durationMs: ms };
  if (!e.success) return { status: 'down', message: `Gatus: ${label} is failing (metrics)`, durationMs: ms };
  const n = c.degradedOnRecentFailures ?? 0;
  if (n > 0) {
    // results counted in the newest scrapes (each scrape's delta may hold several results)
    let seen = 0;
    let failed = 0;
    for (const s of e.recent) {
      if (seen >= n) break;
      seen += Number(s.ok) + Number(s.fail);
      failed += Number(s.fail);
    }
    if (failed > 0) return { status: 'degraded', message: `Gatus: ${label} is up, but ${failed} of the last ${seen} results failed`, durationMs: ms };
  }
  return { status: 'up', message: `Gatus: ${label} is up (metrics)`, durationMs: ms };
}

async function checkGatus(c: CheckOf<'gatus'>, ctx: ExecContext): Promise<RawResult> {
  platformFor(ctx.owner, c.platform);
  if (useMetrics(c)) return checkGatusMetrics(c, ctx);
  const t0 = Date.now();
  let all;
  try {
    all = await gatusFetch.get(c.platform, { owner: ctx.owner, pageSize: Math.max(1, c.degradedOnRecentFailures ?? 1) });
  } catch (e) {
    if (e instanceof CheckSetupError) throw e;
    return { status: 'unknown', message: `Gatus could not be read: ${(e as Error).message}`, durationMs: Date.now() - t0 };
  }
  const e = all.get(c.endpointKey);
  if (!e) return { status: 'unknown', message: `Gatus has no endpoint with the key "${c.endpointKey}"`, durationMs: Date.now() - t0 };
  const last = e.results.at(-1);
  if (!last) return { status: 'unknown', message: `Gatus has no results for "${e.name}" yet`, durationMs: Date.now() - t0 };
  const age = (ctx.now() - Date.parse(last.timestamp)) / 1000;
  const ms = last.duration !== undefined ? Math.round(last.duration / 1e6) : undefined;
  if (c.maxAgeSeconds && age > c.maxAgeSeconds)
    return { status: 'down', message: `The newest Gatus result is ${fmtAge(age)} old (maximum ${fmtAge(c.maxAgeSeconds)})`, durationMs: ms };
  if (!last.success)
    return {
      status: 'down',
      message: `Gatus: ${e.group ? `${e.group}/` : ''}${e.name} is failing${last.errors?.length ? ` – ${last.errors.join('; ')}` : ''}`.slice(0, 500),
      durationMs: ms,
    };
  const recent = e.results.slice(-(c.degradedOnRecentFailures ?? 0));
  if ((c.degradedOnRecentFailures ?? 0) > 0 && recent.some((r) => !r.success)) {
    return {
      status: 'degraded',
      message: `Gatus: ${e.name} is up, but ${recent.filter((r) => !r.success).length} of the last ${recent.length} results failed`,
      durationMs: ms,
    };
  }
  return { status: 'up', message: `Gatus: ${e.name} is up`, durationMs: ms };
}

// ---------- CheckMk ----------

const cmkPlan = (c: CheckOf<'checkmk'>, owner: string) => ({ owner, hosts: c.service ? [] : [c.host], serviceHosts: c.service ? [c.host] : [] });

export function planCheckmk(c: CheckOf<'checkmk'>, owner: string): void {
  checkmkFetch.plan(c.platform, cmkPlan(c, owner));
}

const HOST_STATES: Record<number, { word: string; status: RawResult['status'] }> = {
  0: { word: 'UP', status: 'up' },
  1: { word: 'DOWN', status: 'down' },
  2: { word: 'UNREACHABLE', status: 'unknown' },
};
const SERVICE_STATES: Record<number, { word: string; status: RawResult['status'] }> = {
  0: { word: 'OK', status: 'up' },
  1: { word: 'WARN', status: 'degraded' },
  2: { word: 'CRIT', status: 'down' },
  3: { word: 'UNKNOWN', status: 'unknown' },
};

/** The current state in CheckMk: OK / WARN / CRIT / UNKNOWN → up / degraded / down / unknown, the plugin output as message. */
async function checkCheckmk(c: CheckOf<'checkmk'>, ctx: ExecContext): Promise<RawResult> {
  const t0 = Date.now();
  let data;
  try {
    data = await checkmkFetch.get(c.platform, cmkPlan(c, ctx.owner));
  } catch (e) {
    if (e instanceof CheckSetupError) throw e;
    return { status: 'unknown', message: `CheckMk could not be read: ${(e as Error).message}`.slice(0, 500), durationMs: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  const label = c.service ? `${c.host} / ${c.service}` : c.host;
  const s = c.service ? data.services.get(checkmkServiceKey(c.host, c.service)) : data.hosts.get(c.host);
  if (!s) return { status: 'unknown', message: `CheckMk has no ${c.service ? 'service' : 'host'} "${label}"`, durationMs: ms };
  if (!s.checked) return { status: 'unknown', message: `CheckMk has not checked ${label} yet (pending)`, durationMs: ms };
  if (c.maxAgeSeconds && s.lastCheck !== null) {
    const age = Math.round((Date.now() - s.lastCheck) / 1000);
    if (age > c.maxAgeSeconds)
      return { status: 'unknown', message: `CheckMk last checked ${label} ${fmtAge(age)} ago (maximum ${fmtAge(c.maxAgeSeconds)})`, durationMs: ms };
  }
  const known = (c.service ? SERVICE_STATES : HOST_STATES)[s.state] ?? { word: `state ${s.state}`, status: 'unknown' as const };
  const notes = [s.downtime ? 'in a CheckMk downtime' : '', s.acknowledged ? 'acknowledged in CheckMk' : ''].filter(Boolean);
  return {
    status: known.status,
    message: `CheckMk: ${label} ${known.word}${s.output ? ` – ${s.output}` : ''}${notes.length ? ` (${notes.join(', ')})` : ''}`.slice(0, 500),
    durationMs: ms,
    value: { state: s.state, lastCheck: s.lastCheck ? new Date(s.lastCheck).toISOString() : null, downtime: s.downtime, acknowledged: s.acknowledged },
  };
}

// ---------- Prometheus ----------

const fmtNum = (v: number) => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(Math.round(v * 100) / 100));

/** A PromQL query against WARN and CRIT levels (#110): every series is judged, the worst one counts. */
async function checkPrometheus(c: CheckOf<'prometheus'>, ctx: ExecContext): Promise<RawResult> {
  const t0 = Date.now();
  const { platform, secrets } = platformFor(ctx.owner, c.platform);
  let series;
  try {
    series = await promInstant(platform, secrets, c.query, ctx.signal);
  } catch (e) {
    return { status: 'unknown', message: `Prometheus could not be read: ${(e as Error).message}`.slice(0, 500), durationMs: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  const unit = c.unit ?? '';
  if (!series.length) return { status: c.noData ?? 'unknown', message: 'Prometheus: the query returned no series', durationMs: ms, value: { series: 0 } };
  const bad = (v: number, level: number | undefined) => level !== undefined && (c.direction === 'below' ? v <= level : v >= level);
  const rank = { up: 0, unknown: 1, degraded: 2, down: 3 } as const;
  const judged = series.map((s) => {
    const status: keyof typeof rank = !Number.isFinite(s.value) ? 'unknown' : bad(s.value, c.crit) ? 'down' : bad(s.value, c.warn) ? 'degraded' : 'up';
    return { s, status };
  });
  // the worst series; among equals, the one furthest past the level
  const worst = judged.reduce((a, b) =>
    rank[b.status] > rank[a.status] || (rank[b.status] === rank[a.status] && (c.direction === 'below' ? b.s.value < a.s.value : b.s.value > a.s.value)) ? b : a,
  );
  const name = seriesName(worst.s, series);
  const levels = [c.warn !== undefined ? `WARN ${fmtNum(c.warn)}` : '', `CRIT ${fmtNum(c.crit)}`].filter(Boolean).join(', ');
  const value = Number.isFinite(worst.s.value) ? `${fmtNum(worst.s.value)}${unit}` : 'not a number';
  const count = series.length === 1 ? '' : ` (worst of ${series.length} series)`;
  const failing = judged.filter((j) => j.status === 'down' || j.status === 'degraded').length;
  const message =
    worst.status === 'up'
      ? `Prometheus: ${series.length === 1 ? `${name} ${value}` : `all ${series.length} series within the levels, worst ${name} ${value}`} (${levels})`
      : `Prometheus: ${name} ${value}${count}${failing > 1 ? `, ${failing} series past a level` : ''} (${levels})`;
  return {
    status: worst.status,
    message: message.slice(0, 500),
    durationMs: ms,
    value: { series: series.length, worst: Number.isFinite(worst.s.value) ? worst.s.value : null, labels: worst.s.labels },
  };
}

// ---------- Kubernetes ----------

/** Deployments ready and no pod crash-looping (#111): none ready → down; fewer ready than wanted, or unwell pods → degraded. */
async function checkKubernetes(c: CheckOf<'kubernetes'>, ctx: ExecContext): Promise<RawResult> {
  const t0 = Date.now();
  const { platform, secrets } = platformFor(ctx.owner, c.platform);
  let r;
  try {
    r = await readNamespace(platform, secrets, c.namespace);
  } catch (e) {
    return { status: 'unknown', message: `Kubernetes could not be read: ${(e as Error).message}`.slice(0, 500), durationMs: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  const deps = c.deployment ? r.deployments.filter((d) => d.name === c.deployment) : r.deployments;
  const where = c.deployment ? `${c.namespace}/${c.deployment}` : c.namespace;
  if (!deps.length)
    return {
      status: 'unknown',
      message: c.deployment ? `Kubernetes: no deployment "${c.deployment}" in ${c.namespace}` : `Kubernetes: no deployments in ${c.namespace}`,
      durationMs: ms,
    };
  const prefixes = deps.map((d) => `${d.name}-`);
  const pods = r.unhealthyPods.filter((p) => !c.deployment || prefixes.some((x) => p.name.startsWith(x)));
  const down = deps.filter((d) => d.desired > 0 && d.ready === 0);
  const short = deps.filter((d) => d.ready < d.desired && !down.includes(d));
  const parts = [
    ...[...down, ...short].map((d) => `${d.name} ${d.ready}/${d.desired} ready`),
    ...pods.slice(0, 3).map((p) => `pod ${p.name} ${p.reason}${p.restarts && !p.reason.includes('restarts') ? ` (${p.restarts} restarts)` : ''}`),
  ];
  const status = down.length ? 'down' : short.length || pods.length ? 'degraded' : 'up';
  const message =
    status === 'up'
      ? `Kubernetes: ${where} – ${deps.length === 1 ? `${deps[0]!.ready}/${deps[0]!.desired} ready` : `all ${deps.length} deployments ready`}`
      : `Kubernetes: ${where} – ${parts.join(', ')}${pods.length > 3 ? `, ${pods.length - 3} more pods` : ''}`;
  return {
    status,
    message: message.slice(0, 500),
    durationMs: ms,
    value: { deployments: deps.map((d) => ({ name: d.name, ready: d.ready, desired: d.desired })), unhealthyPods: pods.length },
  };
}

// ---------- Git platforms ----------

/** The pipeline of a branch (#107): failed → down (or degraded), running → up while the last finished run passed, none → unknown; too many open alerts → degraded. */
async function checkGit(c: CheckOf<'git'>, ctx: ExecContext): Promise<RawResult> {
  const t0 = Date.now();
  const { platform, secrets } = platformFor(ctx.owner, c.platform);
  if (!isGitPlatformKind(platform.kind))
    return { status: 'unknown', message: `Check could not run: "${platform.name}" is not a GitHub, GitLab or Forgejo/Gitea platform` };
  let pipeline;
  let alerts = null;
  let branch = c.branch ?? '';
  try {
    assertRepositoryPath(c.repository);
    const host = gitHost(platform, secrets);
    if (!branch) branch = (await host.repo(c.repository)).defaultBranch ?? 'main';
    const head = await host.head(c.repository, branch);
    if (!head) return { status: 'unknown', message: `Git: no branch "${branch}" in ${c.repository}`, durationMs: Date.now() - t0 };
    pipeline = await host.pipeline(c.repository, branch, head.sha);
    if (c.maxCritical !== undefined || c.maxHigh !== undefined) alerts = await host.alerts(c.repository, null);
  } catch (e) {
    return { status: 'unknown', message: `Git could not be read: ${(e as Error).message}`.slice(0, 500), durationMs: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  const where = `${c.repository}@${branch}`;
  const failed = pipeline.runs.filter((r) => r.state === 'failed').map((r) => r.name);
  const tooMany: string[] = [];
  if (alerts && c.maxCritical !== undefined && alerts.critical > c.maxCritical) tooMany.push(`${alerts.critical} critical alerts (at most ${c.maxCritical})`);
  if (alerts && c.maxHigh !== undefined && alerts.critical + alerts.high > c.maxHigh)
    tooMany.push(`${alerts.critical + alerts.high} critical or high alerts (at most ${c.maxHigh})`);
  const value = { pipeline: pipeline.state, runs: pipeline.runs.length, ...(alerts ? { alerts: { critical: alerts.critical, high: alerts.high } } : {}) };
  if (pipeline.state === 'none') return { status: 'unknown', message: `Git: ${where} – no pipeline run`, durationMs: ms, value };
  if (pipeline.state === 'failed')
    return {
      status: c.failedAs,
      message: `Git: ${where} – pipeline failed (${failed.slice(0, 3).join(', ')})${tooMany.length ? `, ${tooMany.join(', ')}` : ''}`.slice(0, 500),
      durationMs: ms,
      value,
    };
  if (tooMany.length) return { status: 'degraded', message: `Git: ${where} – ${tooMany.join(', ')}`.slice(0, 500), durationMs: ms, value };
  return {
    status: 'up',
    message: `Git: ${where} – ${pipeline.state === 'running' ? 'pipeline running' : 'pipeline passed'}${alerts ? `, ${alerts.critical} critical / ${alerts.high} high alerts` : ''}`,
    durationMs: ms,
    value,
  };
}

// ---------- Snowflake ----------

/** A Snowflake table's freshness, failing tasks or a warehouse's credits (#115). */
async function checkSnowflake(c: CheckOf<'snowflake'>, ctx: ExecContext): Promise<RawResult> {
  const t0 = Date.now();
  const { platform, secrets } = platformFor(ctx.owner, c.platform);
  if (platform.kind !== 'snowflake') return { status: 'unknown', message: `Check could not run: "${platform.name}" is not a Snowflake platform` };
  const { snowflakeCheck } = await import('../snowflake/service.js');
  try {
    return { ...(await snowflakeCheck(platform, secrets, c)), durationMs: Date.now() - t0 };
  } catch (e) {
    return { status: 'unknown', message: `Snowflake could not be read: ${(e as Error).message}`.slice(0, 500), durationMs: Date.now() - t0 };
  }
}

// ---------- Kafka ----------

/** Offsets seen per topic or group (for brokers without the newest-message time, and for stuck groups): value and since when. */
const kafkaSeen = new Map<string, { value: number; since: number }>();
const moved = (key: string, value: number, now: number) => {
  const prev = kafkaSeen.get(key);
  if (!prev || prev.value !== value) kafkaSeen.set(key, { value, since: now });
  return kafkaSeen.get(key)!;
};

const STATUS_RANK: Record<string, number> = { up: 0, degraded: 1, down: 2 };
const worst = (a: MonitorStatus, b: MonitorStatus): MonitorStatus => ((STATUS_RANK[b] ?? 0) > (STATUS_RANK[a] ?? 0) ? b : a);

/** A topic (#112): new messages within the window, a consumer group's lag and whether it is stuck, the schema version. */
async function checkKafka(c: CheckOf<'kafka'>, ctx: ExecContext): Promise<RawResult> {
  const t0 = Date.now();
  const { platform, secrets } = platformFor(ctx.owner, c.platform);
  if (platform.kind !== 'kafka') return { status: 'unknown', message: `Check could not run: "${platform.name}" is not a Kafka platform` };
  const { withKafka, kafkaError } = await import('../kafka/client.js');
  const { assertTopic, lagOf, schemaOf } = await import('../kafka/service.js');
  let r;
  try {
    assertTopic(c.topic);
    r = await withKafka(platform, secrets, async (k) => {
      const ends = await k.ends(c.topic);
      if (!ends.length) return null;
      const newest = c.messagesWithinMinutes ? await k.newest(c.topic) : null;
      const groups = c.group ? await k.groups(c.topic, [c.group]) : [];
      return { ends, newest, groups };
    });
  } catch (e) {
    return { status: 'unknown', message: `Kafka could not be read: ${kafkaError(e)}`.slice(0, 500), durationMs: Date.now() - t0 };
  }
  if (!r) return { status: 'unknown', message: `Kafka: no topic "${c.topic}"`, durationMs: Date.now() - t0 };
  const now = Date.now();
  const parts: string[] = [];
  let status: MonitorStatus = 'up';
  const endOffset = r.ends.reduce((n, e) => n + e.end, 0);
  const value: Record<string, unknown> = { endOffset };
  if (c.messagesWithinMinutes) {
    // the newest message's time (Kafka 3.0+), else when the end offsets last moved (known after the first window)
    const seen = moved(`${platform.id}|${c.topic}`, endOffset, now);
    const last = r.newest ?? (now - seen.since >= c.messagesWithinMinutes * 60_000 ? seen.since : null);
    const age = last === null ? null : Math.round((now - last) / 60_000);
    value.minutesSinceMessage = age;
    if (age !== null && age > c.messagesWithinMinutes) {
      status = worst(status, c.quietAs);
      parts.push(`no new message for ${age} minutes (expected within ${c.messagesWithinMinutes})`);
    } else parts.push(age === null ? 'watching for new messages' : `newest message ${age} minutes ago`);
  }
  if (c.group) {
    const g = r.groups[0];
    if (!g) return { status: 'unknown', message: `Kafka: consumer group "${c.group}" has no offsets on ${c.topic}`, durationMs: now - t0, value };
    const lag = lagOf(r.ends, g);
    const committed = [...g.committed.values()].reduce((n, x) => n + x, 0);
    const seen = moved(`${platform.id}|${c.group}|${c.topic}`, committed, now);
    value.lag = lag.lag;
    if (lag.lag > 0 && now - seen.since >= c.stuckMinutes * 60_000) {
      status = worst(status, 'down');
      parts.push(`group ${c.group} stuck: lag ${lag.lag}, no commit for ${Math.round((now - seen.since) / 60_000)} minutes`);
    } else if (c.maxLag !== undefined && lag.lag > c.maxLag) {
      status = worst(status, 'degraded');
      parts.push(`group ${c.group} lag ${lag.lag} (at most ${c.maxLag})`);
    } else parts.push(`group ${c.group} lag ${lag.lag}`);
  }
  if (c.schemaVersion !== undefined) {
    try {
      const sch = await schemaOf(platform, secrets, c.topic);
      value.schemaVersion = sch?.version ?? null;
      if (!sch) {
        status = worst(status, 'degraded');
        parts.push(`no schema ${c.topic}-value`);
      } else if (sch.version !== c.schemaVersion) {
        status = worst(status, 'degraded');
        parts.push(`schema version ${sch.version} (expected ${c.schemaVersion})`);
      } else parts.push(`schema version ${sch.version}`);
    } catch (e) {
      parts.push(`schema not readable: ${(e as Error).message}`);
    }
  }
  return { status, message: `Kafka: ${c.topic} – ${parts.join(', ') || 'topic readable'}`.slice(0, 500), durationMs: Date.now() - t0, value };
}

// ---------- MQTT ----------

/** Topics of a pattern (#113), from what the broker's listener saw: any message within the window, or every topic (silent devices). */
async function checkMqtt(c: CheckOf<'mqtt'>, ctx: ExecContext): Promise<RawResult> {
  const { platform } = platformFor(ctx.owner, c.platform);
  if (platform.kind !== 'mqtt') return { status: 'unknown', message: `Check could not run: "${platform.name}" is not an MQTT platform` };
  const { mqttState } = await import('../mqtt/listener.js');
  const st = await mqttState(platform.id, c.topic, c.minClients !== undefined);
  if (st.error && !st.listeningSince) return { status: 'unknown', message: `MQTT: ${st.error}`.slice(0, 500) };
  const now = Date.now();
  const window = c.withinMinutes * 60_000;
  const mins = (t: number) => Math.round((now - t) / 60_000);
  const parts: string[] = [];
  let status: MonitorStatus = 'up';
  const value: Record<string, unknown> = { topics: st.topics.length };
  const newest = st.topics.reduce((m, t) => Math.max(m, t.lastAt), 0);
  const watched = st.listeningSince ? now - st.listeningSince : 0;
  if (c.mode === 'any') {
    if (!newest && watched < window)
      return { status: 'unknown', message: `MQTT: ${c.topic} – watching for ${mins(st.listeningSince ?? now)} minutes, no message yet`, value };
    if (!newest || now - newest > window) {
      status = c.quietAs;
      parts.push(newest ? `no message for ${mins(newest)} minutes (expected within ${c.withinMinutes})` : `no message within ${c.withinMinutes} minutes`);
    } else parts.push(`newest message ${mins(newest)} minutes ago`);
  } else {
    if (!st.topics.length) return { status: 'unknown', message: `MQTT: ${c.topic} – no topic of the pattern seen yet`, value };
    const silent = st.topics.filter((t) => now - t.lastAt > window);
    value.silent = silent.length;
    if (silent.length === st.topics.length) status = c.quietAs;
    else if (silent.length) status = 'degraded';
    parts.push(
      silent.length
        ? `${silent.length} of ${st.topics.length} silent for more than ${c.withinMinutes} minutes: ${silent
            .slice(0, 5)
            .map((t) => t.topic)
            .join(', ')}${silent.length > 5 ? ` and ${silent.length - 5} more` : ''}`
        : `all ${st.topics.length} topics sent within ${c.withinMinutes} minutes`,
    );
  }
  if (c.minClients !== undefined) {
    value.clients = st.clients;
    if (st.clients === null) parts.push('connected clients unknown (the broker publishes no $SYS/broker/clients/connected)');
    else if (st.clients < c.minClients) {
      status = worst(status, 'degraded');
      parts.push(`${st.clients} clients connected (at least ${c.minClients})`);
    } else parts.push(`${st.clients} clients connected`);
  }
  if (st.error) parts.push(`listener: ${st.error}`);
  return { status, message: `MQTT: ${c.topic} – ${parts.join(', ')}`.slice(0, 500), value };
}

// ---------- dispatch ----------

type Active =
  | CheckOf<'ping'>
  | CheckOf<'tcp'>
  | CheckOf<'http'>
  | CheckOf<'platform'>
  | CheckOf<'freshness'>
  | CheckOf<'gatus'>
  | CheckOf<'checkmk'>
  | CheckOf<'prometheus'>
  | CheckOf<'kubernetes'>
  | CheckOf<'git'>
  | CheckOf<'kafka'>
  | CheckOf<'mqtt'>
  | CheckOf<'snowflake'>;

/** Runs an active check; heartbeat and sub-monitor checks are evaluated by the engine from stored state. */
export async function runActiveCheck(c: Active, ctx: ExecContext): Promise<RawResult> {
  try {
    switch (c.type) {
      case 'ping':
        return await checkPing(c, ctx);
      case 'tcp':
        return await checkTcp(c, ctx);
      case 'http':
        return await checkHttp(c, ctx);
      case 'platform':
        return await checkPlatform(c, ctx);
      case 'freshness':
        return await checkFreshness(c, ctx);
      case 'gatus':
        return await checkGatus(c, ctx);
      case 'checkmk':
        return await checkCheckmk(c, ctx);
      case 'prometheus':
        return await checkPrometheus(c, ctx);
      case 'kubernetes':
        return await checkKubernetes(c, ctx);
      case 'git':
        return await checkGit(c, ctx);
      case 'snowflake':
        return await checkSnowflake(c, ctx);
      case 'kafka':
        return await checkKafka(c, ctx);
      case 'mqtt':
        return await checkMqtt(c, ctx);
    }
  } catch (e) {
    if (e instanceof CheckSetupError) return { status: 'unknown', message: `Check could not run: ${e.message}` };
    if (e instanceof SourceError) return { status: 'unknown', message: e.message };
    return { status: 'unknown', message: `Check failed: ${(e as Error).message}`.slice(0, 500) };
  }
}

export const isActive = (c: { type: string }): c is Active => !['heartbeat', 'monitor'].includes(c.type);
