import { execFile } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import { Agent, EnvHttpProxyAgent, fetch, type Dispatcher } from 'undici';
import type { CheckOf, MonitorStatus } from '@sm/shared';
import { evalExpr } from '../engine/expr.js';
import { platformRequest } from '../platforms/http.js';
import { assertAddressSafe, assertNetAllowed, assertOutboundAllowed, guardedLookup } from '../platforms/outbound.js';
import { outboundContext } from '../platforms/policyContext.js';
import { BRAND } from '@sm/shared';
import { freshnessStatus, freshnessWindowSeconds, fmtAge, statusMatcher } from './logic.js';
import { gatusFetch, ihFetch, ihKey, SourceError } from './batch.js';
import { CheckSetupError, platformFor } from './platforms.js';

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
  if (c.degradedMs && r.ms > c.degradedMs) return { status: 'degraded', message: `Connected in ${r.ms} ms (warning above ${c.degradedMs} ms)`, durationMs: r.ms };
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
    execFile('ping', pingArgs(host, timeoutMs), { timeout: timeoutMs + 2000, windowsHide: true, env: { PATH: process.env.PATH ?? '', LANG: 'C', LC_ALL: 'C' } }, (err, stdout, stderr) => {
      const out = `${stdout}\n${stderr}`;
      const e = err as (NodeJS.ErrnoException & { code?: string | number }) | null;
      if (e && (e.code === 'ENOENT' || e.code === 'EACCES')) return resolve({ unavailable: e.code === 'ENOENT' ? 'the ping command is not installed' : 'ping may not be executed' });
      if (/operation not permitted|permission denied|socket: |cap_net_raw/i.test(out)) return resolve({ unavailable: 'ICMP is not permitted for this process' });
      const rtt = /time[=<]\s*([\d.]+)\s*ms/i.exec(out);
      resolve({ ok: !e, rttMs: rtt ? Number(rtt[1]) : undefined, output: out.trim().split('\n').slice(-2).join(' ').slice(0, 200) });
    });
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
      if (c.degradedRttMs && ms > c.degradedRttMs) return { status: 'degraded', message: `Round trip ${ms} ms (warning above ${c.degradedRttMs} ms)`, durationMs: Math.round(ms) };
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
    const sock = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, timeout: timeoutMs, lookup: guardedLookup });
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
    return { status: 'down', message: `${c.method} ${c.url} failed: ${timedOut ? 'timeout' : (err.cause?.message ?? err.message)}`.slice(0, 300), durationMs: Date.now() - t0 };
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
    r = await platformRequest(
      platform,
      secrets,
      { method: c.method, url: c.path, query: c.query, headers: c.headers, body: c.method === 'POST' ? c.body : undefined },
      AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)]),
    );
  } catch (e) {
    return { status: 'down', message: `${c.method} ${c.path} on "${platform.name}" failed: ${(e as Error).message}`.slice(0, 500), durationMs: Date.now() - t0 };
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
      latest = await ihFetch.get(ihKey(c.platform, c.assetId!, c.aspect!), { owner: ctx.owner, vars, windowSeconds: Math.ceil(freshnessWindowSeconds(c) * 1.5) });
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
    r = await platformRequest(platform, secrets, { method: 'GET', url: c.path!, query: c.query }, AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)]));
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

export function planGatus(c: CheckOf<'gatus'>, owner: string): void {
  gatusFetch.plan(c.platform, { owner, pageSize: Math.max(1, c.degradedOnRecentFailures ?? 1) });
}

async function checkGatus(c: CheckOf<'gatus'>, ctx: ExecContext): Promise<RawResult> {
  platformFor(ctx.owner, c.platform);
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
  if (c.maxAgeSeconds && age > c.maxAgeSeconds) return { status: 'down', message: `The newest Gatus result is ${fmtAge(age)} old (maximum ${fmtAge(c.maxAgeSeconds)})`, durationMs: ms };
  if (!last.success) return { status: 'down', message: `Gatus: ${e.group ? `${e.group}/` : ''}${e.name} is failing${last.errors?.length ? ` – ${last.errors.join('; ')}` : ''}`.slice(0, 500), durationMs: ms };
  const recent = e.results.slice(-(c.degradedOnRecentFailures ?? 0));
  if ((c.degradedOnRecentFailures ?? 0) > 0 && recent.some((r) => !r.success)) {
    return { status: 'degraded', message: `Gatus: ${e.name} is up, but ${recent.filter((r) => !r.success).length} of the last ${recent.length} results failed`, durationMs: ms };
  }
  return { status: 'up', message: `Gatus: ${e.name} is up`, durationMs: ms };
}

// ---------- dispatch ----------

type Active = CheckOf<'ping'> | CheckOf<'tcp'> | CheckOf<'http'> | CheckOf<'platform'> | CheckOf<'freshness'> | CheckOf<'gatus'>;

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
    }
  } catch (e) {
    if (e instanceof CheckSetupError) return { status: 'unknown', message: `Check could not run: ${e.message}` };
    if (e instanceof SourceError) return { status: 'unknown', message: e.message };
    return { status: 'unknown', message: `Check failed: ${(e as Error).message}`.slice(0, 500) };
  }
}

export const isActive = (c: { type: string }): c is Active => !['heartbeat', 'monitor'].includes(c.type);
