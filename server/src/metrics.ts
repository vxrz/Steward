import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { db } from './db.js';
import { on } from './events.js';
import { registerMonitorMetrics } from './monitors/metrics.js';

/**
 * Prometheus metrics (GET /api/metrics). Counters and histograms are fed by
 * domain events; gauges are read from the database on every scrape.
 */

export const registry = new Registry();
let initialized = false;

const statusClass = (status: number) => (status > 0 ? `${Math.floor(status / 100)}xx` : 'error');

/** Register metrics and subscribe to domain events (idempotent). */
export function initMetrics(): Registry {
  if (initialized) return registry;
  initialized = true;
  collectDefaultMetrics({ register: registry, prefix: 'sm_' });

  const runs = new Counter({
    name: 'sm_runs_total',
    help: 'Finished process runs',
    labelNames: ['process', 'status', 'trigger'] as const,
    registers: [registry],
  });
  const runDuration = new Histogram({
    name: 'sm_run_duration_seconds',
    help: 'Duration of finished process runs (including time waiting for decisions)',
    labelNames: ['process'] as const,
    buckets: [0.1, 0.5, 1, 5, 15, 60, 300, 900, 3600, 4 * 3600, 86400],
    registers: [registry],
  });
  const stepDuration = new Histogram({
    name: 'sm_step_duration_seconds',
    help: 'Duration of executed process steps by node type and result',
    labelNames: ['type', 'status'] as const,
    buckets: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 10, 30, 120, 600],
    registers: [registry],
  });
  const httpRequests = new Counter({
    name: 'sm_http_requests_total',
    help: 'Platform API calls (every attempt, including token requests)',
    labelNames: ['host', 'method', 'status_class'] as const,
    registers: [registry],
  });
  const httpDuration = new Histogram({
    name: 'sm_http_request_duration_seconds',
    help: 'Duration of platform API calls',
    labelNames: ['host'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [registry],
  });

  const mcpRequests = new Counter({
    name: 'steward_mcp_requests_total',
    help: 'Messages to the MCP endpoint by JSON-RPC method and outcome',
    labelNames: ['method', 'outcome'] as const,
    registers: [registry],
  });
  const mcpTools = new Counter({ name: 'steward_mcp_tool_calls_total', help: 'MCP tool calls by tool and outcome', labelNames: ['tool', 'outcome'] as const, registers: [registry] });
  const mcpGateway = new Counter({
    name: 'steward_mcp_gateway_calls_total',
    help: 'Platform calls through the MCP gateway by platform id and outcome',
    labelNames: ['platform', 'outcome'] as const,
    registers: [registry],
  });
  // method labels are bounded: anything that is not a known MCP method counts as "other"
  const KNOWN = new Set(['initialize', 'ping', 'server/discover', 'tools/list', 'tools/call', 'resources/list', 'resources/read', 'resources/templates/list', 'notifications/initialized', 'notifications/cancelled']);
  on('mcp.request', (e) => mcpRequests.inc({ method: KNOWN.has(e.method) ? e.method : 'other', outcome: e.outcome }));
  on('mcp.tool', (e) => mcpTools.inc({ tool: e.tool, outcome: e.outcome }));
  on('mcp.gateway', (e) => mcpGateway.inc({ platform: e.platformId, outcome: e.outcome }));

  on('run.finished', (e) => {
    runs.inc({ process: e.processId, status: e.status, trigger: e.trigger });
    runDuration.observe({ process: e.processId }, e.durationMs / 1000);
  });
  on('step.finished', (e) => {
    stepDuration.observe({ type: e.nodeType, status: e.status }, Math.max(0, e.durationMs) / 1000);
  });
  on('http.request', (e) => {
    httpRequests.inc({ host: e.host, method: e.method, status_class: statusClass(e.status) });
    httpDuration.observe({ host: e.host }, Math.max(0, e.durationMs) / 1000);
  });

  new Gauge({
    name: 'sm_runs_active',
    help: 'Runs that are running or waiting',
    registers: [registry],
    collect() {
      this.set(db().get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued', 'running', 'waiting')")!.n);
    },
  });
  new Gauge({
    name: 'sm_tasks_open',
    help: 'Open user tasks (decisions)',
    registers: [registry],
    collect() {
      this.set(db().get<{ n: number }>("SELECT COUNT(*) AS n FROM run_tasks WHERE status = 'open'")!.n);
    },
  });
  new Gauge({
    name: 'sm_task_oldest_age_seconds',
    help: 'Age of the oldest open user task (0 when none)',
    registers: [registry],
    collect() {
      const r = db().get<{ ts: string | null }>("SELECT MIN(created_at) AS ts FROM run_tasks WHERE status = 'open'");
      this.set(r?.ts ? Math.max(0, (Date.now() - Date.parse(r.ts)) / 1000) : 0);
    },
  });
  const datasets = () =>
    db().all<{ key: string; updated_at: string; stale_after_minutes: number | null }>('SELECT key, updated_at, stale_after_minutes FROM datasets');
  new Gauge({
    name: 'sm_dataset_age_seconds',
    help: 'Age of the latest snapshot of a dashboard dataset',
    labelNames: ['dataset'] as const,
    registers: [registry],
    collect() {
      this.reset();
      for (const d of datasets()) this.set({ dataset: d.key }, Math.max(0, (Date.now() - Date.parse(d.updated_at)) / 1000));
    },
  });
  new Gauge({
    name: 'sm_dataset_stale',
    help: '1 when a dataset is older than its staleAfterMinutes',
    labelNames: ['dataset'] as const,
    registers: [registry],
    collect() {
      this.reset();
      for (const d of datasets()) {
        const age = Date.now() - Date.parse(d.updated_at);
        this.set({ dataset: d.key }, d.stale_after_minutes && age > d.stale_after_minutes * 60000 ? 1 : 0);
      }
    },
  });
  registerMonitorMetrics(registry);
  return registry;
}

export async function metricsText(): Promise<{ contentType: string; body: string }> {
  initMetrics();
  return { contentType: registry.contentType, body: await registry.metrics() };
}
