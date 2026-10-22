/** Gatus metrics mode: Steward scrapes Gatus' Prometheus endpoint and keeps a compact time series. */

export interface GatusMetricsSource {
  platformId: string;
  platformName: string;
  enabled: boolean;
  /** Scrape interval (default 60 s) */
  intervalSeconds: number;
  /** Hourly aggregates and status changes are kept this long (default 90 days) */
  retentionDays: number;
  /** Per-scrape samples are kept this long (default 14 days) */
  rawRetentionDays: number;
  /** Path of the metrics endpoint below the platform's base URL (default /metrics) */
  metricsPath: string;
  /** Also read Gatus' uptime API (/api/v1/endpoints/{key}/uptimes/{1h|24h|7d|30d}) once per hour */
  fetchUptimes: boolean;
  /** Scrapes run with this user's rights on the platform */
  owner: string;
  lastScrapeAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  /** Gatus process start time (detects restarts that reset the counters) */
  gatusStartedAt: string | null;
  endpointCount: number;
  updatedAt: string;
  updatedBy: string;
}

export interface GatusUptimes {
  h1: number | null;
  h24: number | null;
  d7: number | null;
  d30: number | null;
}

export interface GatusEndpointState {
  key: string;
  group: string;
  name: string;
  type: string;
  /** gatus_results_endpoint_success of the newest result */
  success: boolean | null;
  /** gatus_results_duration_seconds of the newest result, in ms */
  durationMs: number | null;
  certificateExpiresAt: string | null;
  domainExpiresAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /** When the result counters last increased (the newest result Gatus produced, to the scrape interval) */
  lastResultAt: string | null;
  /** Uptime in percent from the counter deltas Steward recorded */
  uptime: GatusUptimes;
  /** Uptime in percent as reported by Gatus' own API (when fetchUptimes is on) */
  gatusUptime: GatusUptimes | null;
}
