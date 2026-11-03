import { spec } from './gitSpecs.js';

/**
 * The read endpoints of the Prometheus HTTP API (also Thanos, Mimir, Cortex, VictoriaMetrics), attached to platforms
 * made from the Prometheus preset: so MCP clients can run PromQL through the platform gateway and process steps can
 * look the operations up. GET only – the gateway never sends a changing call to Prometheus.
 */
export const prometheusSpec = () =>
  spec('Prometheus HTTP API (read endpoints)', 'https://prometheus.io/docs/prometheus/latest/querying/api/', [
    ['/api/v1/query', 'query', 'Instant query: evaluate a PromQL expression at one time (default: now)', ['query', 'time', 'timeout', 'limit']],
    [
      '/api/v1/query_range',
      'queryRange',
      'Range query: a PromQL expression over a time range with a step',
      ['query', 'start', 'end', 'step', 'timeout', 'limit'],
    ],
    ['/api/v1/series', 'series', 'Series that match a selector (match[]) in a time range', ['match[]', 'start', 'end', 'limit']],
    ['/api/v1/labels', 'labels', 'Label names', ['match[]', 'start', 'end', 'limit']],
    ['/api/v1/label/{name}/values', 'labelValues', 'Values of one label', ['match[]', 'start', 'end', 'limit']],
    ['/api/v1/metadata', 'metadata', 'Metric metadata (type, help, unit)', ['metric', 'limit']],
    ['/api/v1/targets', 'targets', 'Scrape targets and their health', ['state']],
    ['/api/v1/alerts', 'alerts', 'Active alerts'],
    ['/api/v1/rules', 'rules', 'Alerting and recording rules', ['type']],
    ['/api/v1/status/buildinfo', 'buildInfo', 'Version (connection test)'],
  ]);
