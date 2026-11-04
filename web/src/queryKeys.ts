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
