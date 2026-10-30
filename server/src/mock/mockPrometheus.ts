import type { FastifyInstance } from 'fastify';

/**
 * Simulated Prometheus HTTP API for demo mode and tests, mounted at /mock/prometheus (#110):
 *   GET /api/v1/query?query=…        instant query: { status, data: { resultType: "vector", result: [{ metric, value: [ts, "v"] }] } }
 *   GET /api/v1/status/buildinfo     connection test
 * It knows a few fixed queries (the demo's) and whatever a test sets with setPromResult; anything else is an empty
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

function answer(query: string): Series[] {
  const known = results.get(query.trim());
  if (known) return known;
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
