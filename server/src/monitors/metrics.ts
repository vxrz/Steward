import { Counter, Gauge, type Registry } from 'prom-client';
import { MONITOR_STATUS_CODE, type MonitorStatus } from '@sm/shared';
import { db } from '../db.js';
import { parseJson } from '../util.js';
import { deprecatedAlias } from '../metrics-alias.js';

/**
 * Prometheus metrics of the monitors (registered by metrics.ts):
 *   sm_monitor_status{monitor,check}                    0 up, 1 degraded, 2 down, 3 unknown, 4 blocked, 5 maintenance (check="" = the monitor)
 *   sm_monitor_last_ok_timestamp_seconds{monitor,check} Unix time of the last ok result (seconds; 0 = never)
 *   sm_monitor_evaluations_total{type,result}           check evaluations
 * The steward_monitor_* names of 0.10 and older are served too, as deprecated aliases, until 0.12.
 */
let evaluations: Counter<'type' | 'result'> | undefined;

export function countEvaluation(type: string, result: string): void {
  evaluations?.inc({ type, result });
}

export function registerMonitorMetrics(registry: Registry): void {
  evaluations = new Counter({
    name: 'sm_monitor_evaluations_total',
    help: 'Monitor check evaluations by check type and raw result',
    labelNames: ['type', 'result'] as const,
    registers: [registry],
  });
  const rows = () =>
    db().all<{
      key: string;
      enabled: number;
      m_status: MonitorStatus | null;
      check_id: string | null;
      c_status: MonitorStatus | null;
      last_ok_at: string | null;
      definition: string;
    }>(
      `SELECT m.key, m.enabled, s.status AS m_status, c.check_id, c.status AS c_status, c.last_ok_at, m.definition
       FROM monitors m LEFT JOIN monitor_state s ON s.monitor_id = m.id LEFT JOIN monitor_checks c ON c.monitor_id = m.id
       WHERE m.is_template = 0`,
    );
  deprecatedAlias(registry, 'steward_monitor_evaluations_total', evaluations);
  const status = new Gauge({
    name: 'sm_monitor_status',
    help: 'Monitor and check status: 0 up, 1 degraded, 2 down, 3 unknown, 4 blocked, 5 maintenance (check="" is the monitor itself)',
    labelNames: ['monitor', 'check'] as const,
    registers: [registry],
    collect() {
      this.reset();
      const seen = new Set<string>();
      for (const r of rows()) {
        if (!r.enabled) continue;
        if (!seen.has(r.key)) {
          seen.add(r.key);
          this.set({ monitor: r.key, check: '' }, MONITOR_STATUS_CODE[r.m_status ?? 'unknown']);
        }
        const ids = new Set((parseJson<{ checks?: { id: string }[] }>(r.definition, {}).checks ?? []).map((c) => c.id));
        if (r.check_id && ids.has(r.check_id)) {
          const s = r.m_status === 'maintenance' ? 'maintenance' : (r.c_status ?? 'unknown');
          this.set({ monitor: r.key, check: r.check_id }, MONITOR_STATUS_CODE[s]);
        }
      }
    },
  });
  deprecatedAlias(registry, 'steward_monitor_status', status);
  const lastOk = new Gauge({
    name: 'sm_monitor_last_ok_timestamp_seconds',
    help: 'Unix time (seconds) of the last ok result of a check (0 = never)',
    labelNames: ['monitor', 'check'] as const,
    registers: [registry],
    collect() {
      this.reset();
      for (const r of rows())
        if (r.enabled && r.check_id) this.set({ monitor: r.key, check: r.check_id }, r.last_ok_at ? Math.floor(Date.parse(r.last_ok_at) / 1000) : 0);
    },
  });
  deprecatedAlias(registry, 'steward_monitor_last_ok_timestamp', lastOk);
}
