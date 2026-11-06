/**
 * TanStack Query keys, one factory per feature. Use these instead of writing key arrays inline, so a list and its
 * invalidation cannot drift apart: `useQuery({ queryKey: runKeys.detail(id), … })`,
 * `qc.invalidateQueries({ queryKey: runKeys.all })`.
 *
 * Keys are prefix-matched on invalidation: `platformKeys.all` (['platforms']) also refreshes
 * `platformKeys.ofKind('kafka')`, `platformKeys.detail(id)` (['platform', id]) its operations, docs and specs. The
 * arrays are exactly the ones used before the factories, so cached data and invalidations behave as they did.
 *
 * Migrated: runs, processes, platforms, monitors, dashboards, datasets, schedules. Other features still write their
 * keys inline – move them here when you touch them.
 */

export const runKeys = {
  /** Every run list (['runs', …]) */
  all: ['runs'] as const,
  list: (status: unknown, processId: unknown, since: unknown, checks: unknown, pageSize: unknown) =>
    ['runs', status, processId, since, checks, pageSize] as const,
  /** The latest runs of a process (start page, process cards, the flow editor) */
  latest: (processId: string | null | undefined) => ['runs', 'latest', processId] as const,
  palette: ['runs', 'palette'] as const,
  /** Every single run (['run', id]) */
  details: ['run'] as const,
  detail: (id: string | null | undefined) => ['run', id] as const,
  reports: (runId: string | null | undefined) => ['run-reports', runId] as const,
};

export const processKeys = {
  all: ['processes'] as const,
  detail: (id: string | null | undefined) => ['process', id] as const,
  version: (id: string | null | undefined, version: number | 'current') => ['process', id, 'version', version] as const,
  versions: (id: string | null | undefined, currentVersion?: number) =>
    (currentVersion === undefined ? ['process-versions', id] : ['process-versions', id, currentVersion]) as readonly unknown[],
};

export const platformKeys = {
  all: ['platforms'] as const,
  /** Platforms of one kind (pickers in the editors) */
  ofKind: (kind: string) => ['platforms', kind] as const,
  detail: (id: string | null | undefined) => ['platform', id] as const,
  operations: (id: string | null | undefined) => ['platform', id, 'operations'] as const,
  docs: (id: string | null | undefined) => ['platform', id, 'docs'] as const,
  specs: (id: string | null | undefined) => ['platform', id, 'specs'] as const,
  application: (id: string | null | undefined) => ['platform', id, 'application'] as const,
  presets: ['platform-presets'] as const,
  recordings: (id: string | null | undefined) => ['platform-recordings', id] as const,
  /** LLM gateways (0.6.0): budgets, use and the latest calls; refreshed with the platform (prefix ['platform', id]) */
  aiUsage: (id: string | null | undefined) => ['platform', id, 'ai-usage'] as const,
};

/** AI models (0.6.0): every budget (administrators and auditors) */
export const aiKeys = {
  budgets: ['ai-budgets'] as const,
};

export const monitorKeys = {
  all: ['monitors'] as const,
  palette: ['monitors', 'palette'] as const,
  detail: (id: string | null | undefined) => ['monitor', id] as const,
  history: (id: string, checkId: string, since: unknown) => ['monitor-history', id, checkId, since] as const,
  results: (id: string, checkId: string, last: unknown) => ['monitor-results', id, checkId, last] as const,
  maintenance: (id: string, windowId: string | undefined) => ['monitor-maintenance', id, windowId] as const,
  gateways: ['monitor-gateways'] as const,
  templates: ['monitor-templates'] as const,
  examples: ['monitor-examples'] as const,
};

export const dashboardKeys = {
  all: ['dashboards'] as const,
  /** Every single dashboard (['dashboard', id]) */
  details: ['dashboard'] as const,
  detail: (id: string | null | undefined) => ['dashboard', id] as const,
  templates: ['dashboard-templates'] as const,
};

export const datasetKeys = {
  all: ['datasets'] as const,
  detail: (key: string | undefined, qs: string) => ['dataset', key, qs] as const,
  metrics: (key: string | undefined, names: string, days: unknown, qs: string) => ['dataset-metrics', key, names, days, qs] as const,
  publishers: (key: string | undefined) => ['dataset-publishers', key] as const,
};

export const scheduleKeys = {
  all: ['schedules'] as const,
  reports: ['report-schedules'] as const,
  /** Report schedules of the reports page */
  reportsList: ['report-schedules', 'reports'] as const,
};

/** The assurance policy (#210): Settings → Assurance policy, its history. */
export const assuranceKeys = {
  all: ['assurance'] as const,
  policy: ['assurance', 'policy'] as const,
  history: ['assurance', 'history'] as const,
};

/** The plant registry (#218, opt-in module). */
export const plantKeys = {
  /** Everything of the module (after an import or the settings changed) */
  all: ['plant'] as const,
  config: ['plant', 'config'] as const,
  settings: ['plant', 'settings'] as const,
  sites: ['plant', 'sites'] as const,
  site: (id: string | null | undefined) => ['plant', 'site', id] as const,
  hierarchy: ['plant', 'hierarchy'] as const,
  assets: (filter: string) => ['plant', 'assets', filter] as const,
  asset: (id: string | null | undefined) => ['plant', 'asset', id] as const,
  imports: ['plant', 'imports'] as const,
  // part 2 (#219): catalogues, assignments, checks, search
  profiles: ['plant', 'profiles'] as const,
  profile: (id: string | null | undefined) => ['plant', 'profile', id] as const,
  point: (profileId: string | null | undefined, pointId: string | null | undefined) => ['plant', 'point', profileId, pointId] as const,
  kpis: ['plant', 'kpis'] as const,
  kpi: (id: string | null | undefined) => ['plant', 'kpi', id] as const,
  assignment: (assetId: string | null | undefined) => ['plant', 'assignment', assetId] as const,
  checks: ['plant', 'checks'] as const,
  explore: (q: string) => ['plant', 'explore', q] as const,
  // part 3 (#220): the OT network of a site, of an asset
  network: (siteId: string | null | undefined) => ['plant', 'network', siteId] as const,
  /** #230: the VLANs the hosts of a site's data paths are in (the diagram) */
  placement: (siteId: string | null | undefined) => ['plant', 'network', siteId, 'placement'] as const,
  assetNetwork: (assetId: string | null | undefined) => ['plant', 'assetNetwork', assetId] as const,
  // visualizations (#230)
  overview: ['plant', 'views', 'overview'] as const,
  coverage: (filter: string) => ['plant', 'views', 'coverage', filter] as const,
  structure: (siteId: string | null | undefined) => ['plant', 'views', 'structure', siteId] as const,
  flow: (assetId: string | null | undefined) => ['plant', 'views', 'flow', assetId] as const,
  lineage: (profileId: string | null | undefined, pointId: string | null | undefined) => ['plant', 'views', 'lineage', profileId, pointId] as const,
};

/** Database schemas (#222): per platform or system, its snapshots and comparisons. */
export const dbSchemaKeys = {
  all: ['db-schema'] as const,
  overview: (kind: string, id: string | null | undefined) => ['db-schema', kind, id] as const,
  snapshot: (kind: string, id: string | null | undefined, snapshotId: string | null | undefined) => ['db-schema', kind, id, 'snapshot', snapshotId] as const,
  compare: (kind: string, id: string | null | undefined, from: string | null | undefined, to: string | null | undefined) =>
    ['db-schema', kind, id, 'compare', from, to] as const,
  pushTokens: (kind: string, id: string | null | undefined) => ['db-schema', kind, id, 'push-tokens'] as const,
};

/** Data contracts (#221): the list, one contract, its versions, comparisons and test runs. */
export const dataContractKeys = {
  all: ['data-contracts'] as const,
  list: ['data-contracts', 'list'] as const,
  detail: (id: string | null | undefined) => ['data-contracts', 'detail', id] as const,
  versions: (id: string | null | undefined) => ['data-contracts', 'detail', id, 'versions'] as const,
  version: (id: string | null | undefined, v: number | null | undefined) => ['data-contracts', 'detail', id, 'version', v] as const,
  compare: (id: string | null | undefined, from: number | null | undefined, to: number | null | undefined) =>
    ['data-contracts', 'detail', id, 'compare', from, to] as const,
  runs: (id: string | null | undefined) => ['data-contracts', 'detail', id, 'runs'] as const,
  run: (id: string | null | undefined, runId: string | null | undefined) => ['data-contracts', 'detail', id, 'run', runId] as const,
};
