import type { Metric, MetricObjectWithValues, MetricValue, Registry } from 'prom-client';

/**
 * A metric under its old name, for one release after a rename (0.11: one prefix, `sm_`, for all of Steward's metrics;
 * docs/METRICS.md). It has no values of its own: every scrape reads the new metric and serves the same series again
 * under the old name, with "Deprecated: use <new name>" in its help text.
 */
export function deprecatedAlias(registry: Registry, oldName: string, metric: Metric): void {
  const target = metric as unknown as {
    name: string;
    help: string;
    type: string;
    aggregator: string;
    get(): Promise<MetricObjectWithValues<MetricValue<string>>>;
    getForPromString?(): Promise<MetricObjectWithValues<MetricValue<string>>>;
  };
  const rename = (m: MetricObjectWithValues<MetricValue<string>>) => ({
    ...m,
    name: oldName,
    help: `Deprecated: use ${target.name} (this name is removed in 0.12). ${m.help}`,
    values: m.values.map((v) => {
      const name = (v as { metricName?: string }).metricName;
      return name?.startsWith(target.name) ? { ...v, metricName: oldName + name.slice(target.name.length) } : v;
    }),
  });
  const alias = {
    name: oldName,
    help: target.help,
    type: target.type,
    aggregator: target.aggregator,
    get: async () => rename(await target.get()),
    getForPromString: async () => rename(await (target.getForPromString ?? target.get).call(target)),
    reset: () => undefined,
  };
  registry.registerMetric(alias as unknown as Metric);
}
