import type { FastifyInstance } from 'fastify';

/**
 * Simulated Prometheus HTTP API for demo mode and tests, mounted at /mock/prometheus (#110):
 *   GET /api/v1/query?query=…        instant query: { status, data: { resultType: "vector", result: [{ metric, value: [ts, "v"] }] } }
 *   GET /api/v1/status/buildinfo     connection test
 * It knows a few fixed queries (the demo's), request ratios over http_requests_total per service (requestRatio) and
 * whatever a test sets with setPromResult; anything else is an empty
 * vector, and a query with "syntax_error" answers 400 like Prometheus does.
 */

type Series = { metric: Record<string, string>; value: number };

const WINDOW_UPTIME: Record<string, number> = { '1h': 1, '24h': 0.9993, '7d': 0.9978, '30d': 0.9991 };

function defaults(): Map<string, Series[]> {
  return new Map([
    [
      'up{job="shop"}',
      [
        { metric: { __name__: 'up', job: 'shop', instance: 'shop-1:9100' }, value: 1 },
        { metric: { __name__: 'up', job: 'shop', instance: 'shop-2:9100' }, value: 1 },
      ],
    ],
    [
      '100 * (1 - node_filesystem_avail_bytes{mountpoint="/var"} / node_filesystem_size_bytes{mountpoint="/var"})',
      [
        { metric: { instance: 'db01:9100', mountpoint: '/var' }, value: 82.04 },
        { metric: { instance: 'web01:9100', mountpoint: '/var' }, value: 41.5 },
      ],
    ],
  ]);
}

let results = defaults();

/** For tests: the answer to a query (null: forget it again). */
export function setPromResult(query: string, series: Series[] | null): void {
  if (series) results.set(query, series);
  else results.delete(query);
}
export function resetPrometheus(): void {
  results = defaults();
}

/** Share of good requests per service and window (SLO report, burn-rate monitor): shop-api burns its budget fast. */
const GOOD_RATIO: Record<string, Record<string, number>> = {
  'shop-web': { '28d': 0.9995, '6h': 0.9996, '1h': 0.999 },
  'shop-api': { '28d': 0.9982, '6h': 0.99, '1h': 0.985 },
  checkout: { '28d': 0.9992, '6h': 0.9995, '1h': 0.9999 },
};

/**
 * Queries over http_requests_total with a range: the share of good requests per service (`… by (service) …`, or the
 * services of a service="…" matcher); `1 - (…)` is the share of errors, and `(…) / (1 - 0.999)` the burn rate.
 */
function requestRatio(query: string): Series[] | null {
  const q = query.trim();
  const range = /http_requests_total[^[]*\[(\d+[smhdw])\]/.exec(q)?.[1];
  if (!range) return null;
  const only = /service="([^"]+)"/.exec(q)?.[1];
  const errors = /^\(?\s*1\s*-/.test(q);
  const target = /\/\s*\(\s*1\s*-\s*(0\.\d+)\s*\)\s*$/.exec(q)?.[1];
  return Object.entries(GOOD_RATIO)
    .filter(([service]) => !only || service === only)
    .map(([service, by]) => {
      const good = by[range] ?? by['28d']!;
      let value = errors ? 1 - good : good;
      if (target) value = value / (1 - Number(target));
      return { metric: { service }, value: Math.round(value * 1e6) / 1e6 };
    });
}

function answer(query: string): Series[] {
  const known = results.get(query.trim());
  if (known) return known;
  const ratio = requestRatio(query);
  if (ratio) return ratio;
  // availability over a window, e.g. avg_over_time(up{job="shop"}[7d])
  const m = /^avg_over_time\(up\{job="shop"\}\[(1h|24h|7d|30d)\]\)$/.exec(query.trim());
  if (m) return [{ metric: { job: 'shop' }, value: WINDOW_UPTIME[m[1]!]! }];
  return [];
}

export async function mockPrometheus(app: FastifyInstance): Promise<void> {
  app.get('/prometheus/api/v1/status/buildinfo', async () => ({
    status: 'success',
    data: { version: '3.5.0', revision: 'demo', branch: 'HEAD', buildUser: 'steward', goVersion: 'go1.24' },
  }));
  app.get('/prometheus/api/v1/query', async (req, reply) => {
    const query = String((req.query as { query?: unknown }).query ?? '');
    if (!query || query.includes('syntax_error'))
      return reply.code(400).send({ status: 'error', errorType: 'bad_data', error: `invalid parameter "query": 1:1: parse error: unexpected identifier` });
    const ts = Date.now() / 1000;
    return {
      status: 'success',
      data: { resultType: 'vector', result: answer(query).map((s) => ({ metric: s.metric, value: [ts, String(s.value)] })) },
    };
  });
}
