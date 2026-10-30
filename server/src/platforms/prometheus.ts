import type { Platform } from '@sm/shared';
import { platformRequest } from './http.js';

/**
 * PromQL instant queries against a Prometheus-compatible API (#110): Prometheus, Thanos, Mimir, VictoriaMetrics –
 * `GET {base}/api/v1/query?query=…`. The base URL includes any prefix (Mimir: …/prometheus).
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

const num = (v: unknown): number => (typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN);

/** The series of an instant query: a vector (one per label set) or a scalar (one series without labels). */
export async function promInstant(platform: Platform, secrets: Record<string, string>, query: string, signal?: AbortSignal): Promise<PromSeries[]> {
  const r = await platformRequest(platform, secrets, { method: 'GET', url: '/api/v1/query', query: { query } }, signal ?? AbortSignal.timeout(30000));
  const body = r.body as { status?: string; error?: string; errorType?: string; data?: { resultType?: string; result?: unknown } } | null;
  if (!r.ok || body?.status !== 'success') {
    const why = body?.error ? `: ${String(body.error).slice(0, 300)}` : r.status === 401 || r.status === 403 ? ' (check the credentials)' : '';
    throw new PromError(`Prometheus answered HTTP ${r.status}${why}`, r.status);
  }
  const type = body.data?.resultType;
  const result = body.data?.result;
  if (type === 'scalar' && Array.isArray(result)) return [{ labels: {}, value: num(result[1]) }];
  if (type === 'vector' && Array.isArray(result))
    return (result as { metric?: Record<string, string>; value?: unknown[] }[]).map((s) => ({
      labels: s.metric ?? {},
      value: num(s.value?.[1]),
    }));
  throw new PromError(`The query must return an instant vector or a scalar, not ${type ?? 'nothing'} – use e.g. avg_over_time(…[5m]) for a range`);
}

/** A short name for a series: the labels that tell series apart, else all of them (without __name__). */
export function seriesName(s: PromSeries, all: PromSeries[]): string {
  const keys = Object.keys(s.labels).filter((k) => k !== '__name__');
  const differing = keys.filter((k) => all.some((o) => o.labels[k] !== s.labels[k]));
  const shown = (differing.length ? differing : keys).slice(0, 4);
  const name = s.labels.__name__ ?? '';
  return shown.length ? `${name}{${shown.map((k) => `${k}="${s.labels[k]}"`).join(', ')}}` : name || 'result';
}
