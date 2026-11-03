import type { Platform } from '@sm/shared';
import { platformRequest, resolveBaseUrl, secretValues, type HttpResult } from './http.js';
import { authHint, bodyKind, isJson } from './answers.js';

/**
 * PromQL instant queries against a Prometheus-compatible API (#110): Prometheus, Thanos, Mimir, VictoriaMetrics –
 * `POST {base}/api/v1/query` with the query as a form field (long queries do not hit URL limits; GET when the
 * server answers 405). The base URL includes any prefix (Mimir: …/prometheus). See docs/PROMETHEUS.md.
 */

export interface PromSeries {
  labels: Record<string, string>;
  value: number;
}

export class PromError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

/** A sample value as Prometheus writes it: a decimal string, or +Inf, -Inf and NaN (Go's float formatting). */
export function promNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const t = v.trim();
  if (/^[+]?inf(inity)?$/i.test(t)) return Infinity;
  if (/^-inf(inity)?$/i.test(t)) return -Infinity;
  if (/^nan$/i.test(t) || t === '') return NaN;
  return Number(t);
}

type PromBody = { status?: string; error?: string; errorType?: string; data?: { resultType?: string; result?: unknown } } | null;

/** The series of an instant query: a vector (one per label set) or a scalar (one series without labels). */
export async function promInstant(platform: Platform, secrets: Record<string, string>, query: string, signal?: AbortSignal): Promise<PromSeries[]> {
  const sig = signal ?? AbortSignal.timeout(30000);
  let r = await platformRequest(platform, secrets, { method: 'POST', url: '/api/v1/query', body: { query }, bodyType: 'form' }, sig);
  // a server (or a proxy in front of it) that only takes GET
  if (r.status === 405) r = await platformRequest(platform, secrets, { method: 'GET', url: '/api/v1/query', query: { query } }, sig);
  const body = (isJson(r) ? r.body : null) as PromBody;
  if (!r.ok || body?.status !== 'success') throw new PromError(redact(await promError(platform, secrets, r, body), secrets), r.status);
  const type = body.data?.resultType;
  const result = body.data?.result;
  if (type === 'scalar' && Array.isArray(result)) return [{ labels: {}, value: promNumber(result[1]) }];
  if (type === 'vector' && Array.isArray(result))
    return (result as { metric?: Record<string, string>; value?: unknown[] }[]).map((s) => ({
      labels: s.metric ?? {},
      value: promNumber(s.value?.[1]),
    }));
  throw new PromError(`The query must return an instant vector or a scalar, not ${type ?? 'nothing'} – use e.g. avg_over_time(…[5m]) for a range`);
}

/** A failed query in plain words: what answered, the likely cause and the fix. */
async function promError(platform: Platform, secrets: Record<string, string>, r: HttpResult, body: PromBody): Promise<string> {
  const head = `Prometheus answered HTTP ${r.status}`;
  if (body?.error) return `${head}: ${String(body.error).slice(0, 300)}`;
  const text = typeof r.body === 'string' ? r.body : '';
  if (r.status === 404) {
    const base = await resolveBaseUrl(platform, secrets).catch(() => platform.baseUrl);
    return `${head}: no Prometheus API at ${base}/api/v1/query – Mimir and Cortex need the prefix …/prometheus in the base URL, VictoriaMetrics cluster …/select/<tenant>/prometheus, Grafana Cloud …/api/prom; Prometheus, Thanos Query and single-node VictoriaMetrics take the server root (docs/PROMETHEUS.md)`;
  }
  if (r.status === 401 && /org\s*id/i.test(text))
    return `${head} (${bodyKind(r)}): a multi-tenant Mimir/Cortex needs the tenant – add the default header X-Scope-OrgID: <tenant> under Settings → HTTP (docs/PROMETHEUS.md)`;
  if (r.status === 401 || r.status === 403) return `${head} (${bodyKind(r)}) – ${authHint(platform, r.status)}`;
  if (r.ok) return `${head} with ${bodyKind(r)}, not the {"status":"success"} of a Prometheus query API – is the base URL the Prometheus API?`;
  return `${head} with ${bodyKind(r)}`;
}

function redact(text: string, secrets: Record<string, string>): string {
  return secretValues(secrets).reduce((t, v) => (v && t.includes(v) ? t.split(v).join('***') : t), text);
}

/** A short name for a series: the labels that tell series apart, else all of them (without __name__). */
export function seriesName(s: PromSeries, all: PromSeries[]): string {
  const keys = Object.keys(s.labels).filter((k) => k !== '__name__');
  const differing = keys.filter((k) => all.some((o) => o.labels[k] !== s.labels[k]));
  const shown = (differing.length ? differing : keys).slice(0, 4);
  const name = s.labels.__name__ ?? '';
  return shown.length ? `${name}{${shown.map((k) => `${k}="${s.labels[k]}"`).join(', ')}}` : name || 'result';
}
