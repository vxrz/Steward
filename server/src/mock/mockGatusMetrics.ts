import type { FastifyInstance } from 'fastify';

/**
 * Prometheus endpoint of the simulated Gatus (/mock/gatus/metrics), in the format
 * of prometheus/client_golang as Gatus serves it with `metrics: true`
 * (metrics/metrics.go on master): gatus_results_total{key,group,name,type,success},
 * gatus_results_duration_seconds, gatus_results_code_total, gatus_results_connected_total,
 * gatus_results_certificate_expiration_seconds, gatus_results_endpoint_success,
 * plus the Go process collector's process_start_time_seconds.
 *
 * Every scrape counts as one more check of every endpoint. Test controls:
 *   POST /mock/gatus/metrics/restart   counters back to zero, new process start time (a Gatus restart)
 *   POST /mock/gatus/metrics/set       {key, success?, durationSeconds?, certificateDays?}
 *   POST /mock/gatus/metrics/reset     back to the initial state
 */

interface Ep {
  key: string;
  group: string;
  name: string;
  type: string;
  success: boolean;
  durationS: number;
  code?: number;
  /** seconds until the TLS certificate expires (0 = none) */
  certS: number;
  ok: number;
  fail: number;
}

const DAY_S = 86400;

function seed(): { started: number; eps: Ep[] } {
  const ep = (group: string, name: string, type: string, success: boolean, durationS: number, code: number | undefined, certDays: number, ok: number, fail: number): Ep => ({
    key: `${group}_${name.toLowerCase().replace(/[/_.,\s#+&]/g, '-')}`,
    group,
    name,
    type,
    success,
    durationS,
    code,
    certS: certDays * DAY_S,
    ok,
    fail,
  });
  return {
    started: Math.floor(Date.now() / 1000) - 7 * DAY_S,
    eps: [
      ep('core', 'Steward API', 'HTTP', true, 0.014, 200, 61, 2016, 0),
      ep('plant', 'MES frontend', 'HTTP', true, 0.31, 200, 20, 1940, 76),
      ep('plant', 'Historian API', 'HTTP', false, 0.048, 503, 0, 1985, 31),
      ep('edge', 'OPC UA gateway', 'TCP', true, 1.45, undefined, 0, 2016, 0),
    ],
  };
}

export async function mockGatusMetrics(app: FastifyInstance): Promise<void> {
  let state = seed();

  app.get('/gatus/metrics', async (_req, reply) => {
    const lines: string[] = [];
    const lbl = (e: Ep, extra: Record<string, string> = {}) =>
      `{${Object.entries({ group: e.group, key: e.key, name: e.name, ...extra, type: e.type })
        .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
        .join(',')}}`;
    for (const e of state.eps) {
      if (e.success) e.ok++;
      else e.fail++;
    }
    lines.push('# HELP gatus_results_total Number of results per endpoint', '# TYPE gatus_results_total counter');
    for (const e of state.eps) {
      lines.push(`gatus_results_total${lbl(e, { success: 'false' })} ${e.fail}`);
      lines.push(`gatus_results_total${lbl(e, { success: 'true' })} ${e.ok}`);
    }
    lines.push('# HELP gatus_results_duration_seconds Duration of the request in seconds', '# TYPE gatus_results_duration_seconds gauge');
    for (const e of state.eps) lines.push(`gatus_results_duration_seconds${lbl(e)} ${e.durationS}`);
    lines.push('# HELP gatus_results_code_total Total number of results by code', '# TYPE gatus_results_code_total counter');
    for (const e of state.eps) if (e.code) lines.push(`gatus_results_code_total${lbl(e, { code: String(e.code) })} ${e.ok + e.fail}`);
    lines.push('# HELP gatus_results_connected_total Total number of results in which a connection was successfully established', '# TYPE gatus_results_connected_total counter');
    for (const e of state.eps) lines.push(`gatus_results_connected_total${lbl(e)} ${e.ok + e.fail}`);
    lines.push('# HELP gatus_results_certificate_expiration_seconds Number of seconds until the certificate expires', '# TYPE gatus_results_certificate_expiration_seconds gauge');
    for (const e of state.eps) if (e.certS) lines.push(`gatus_results_certificate_expiration_seconds${lbl(e)} ${e.certS.toExponential(9).replace('e+', 'e+0')}`);
    lines.push('# HELP gatus_results_endpoint_success Displays whether or not the endpoint was a success', '# TYPE gatus_results_endpoint_success gauge');
    for (const e of state.eps) lines.push(`gatus_results_endpoint_success${lbl(e)} ${e.success ? 1 : 0}`);
    lines.push('# HELP process_start_time_seconds Start time of the process since unix epoch in seconds.', '# TYPE process_start_time_seconds gauge');
    lines.push(`process_start_time_seconds ${state.started.toExponential(9).replace('e+', 'e+0')}`);
    lines.push('# HELP go_goroutines Number of goroutines that currently exist.', '# TYPE go_goroutines gauge', 'go_goroutines 23');
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(lines.join('\n') + '\n');
  });

  app.post('/gatus/metrics/restart', async () => {
    for (const e of state.eps) {
      e.ok = 0;
      e.fail = 0;
    }
    state.started = Math.floor(Date.now() / 1000);
    return { ok: true };
  });

  app.post('/gatus/metrics/set', async (req, reply) => {
    const b = (req.body ?? {}) as { key?: string; success?: boolean; durationSeconds?: number; certificateDays?: number };
    const e = state.eps.find((x) => x.key === b.key);
    if (!e) return reply.code(404).send({ error: 'unknown key' });
    if (typeof b.success === 'boolean') e.success = b.success;
    if (typeof b.durationSeconds === 'number') e.durationS = b.durationSeconds;
    if (typeof b.certificateDays === 'number') e.certS = b.certificateDays * DAY_S;
    return { ok: true };
  });

  app.post('/gatus/metrics/reset', async () => {
    state = seed();
    return { ok: true };
  });
}
