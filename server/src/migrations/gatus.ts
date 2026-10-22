import type { NamedMigration } from '../db.js';

/** Gatus metrics mode (server/src/gatus): scrape targets, endpoint state, samples, hourly aggregates, status changes. */
export const GATUS_MIGRATIONS: NamedMigration[] = [
  {
    name: 'gatus-001-metrics',
    sql: `
      CREATE TABLE gatus_sources (
        platform_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        interval_seconds INTEGER NOT NULL DEFAULT 60,
        retention_days INTEGER NOT NULL DEFAULT 90,
        raw_retention_days INTEGER NOT NULL DEFAULT 14,
        metrics_path TEXT NOT NULL DEFAULT '/metrics',
        fetch_uptimes INTEGER NOT NULL DEFAULT 0,
        owner TEXT NOT NULL,
        last_scrape_at TEXT,
        last_success_at TEXT,
        last_error TEXT,
        last_duration_ms INTEGER,
        gatus_started_at TEXT,
        last_uptimes_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );

      -- newest state per endpoint, plus the counter values of the previous scrape (for deltas)
      CREATE TABLE gatus_endpoints (
        platform_id TEXT NOT NULL,
        key TEXT NOT NULL,
        group_name TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT '',
        success INTEGER,
        duration_s REAL,
        cert_expires_at TEXT,
        domain_expires_at TEXT,
        total_ok REAL,
        total_fail REAL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_result_at TEXT,
        gatus_uptime TEXT,
        PRIMARY KEY (platform_id, key)
      );

      -- one row per scrape and endpoint (kept rawRetentionDays)
      CREATE TABLE gatus_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform_id TEXT NOT NULL,
        key TEXT NOT NULL,
        ts TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 0,
        fail INTEGER NOT NULL DEFAULT 0,
        success INTEGER,
        duration_s REAL,
        reset INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX gatus_samples_series ON gatus_samples(platform_id, key, ts);
      CREATE INDEX gatus_samples_ts ON gatus_samples(ts);

      -- hourly aggregates (kept retentionDays): result counts from counter deltas, response times
      CREATE TABLE gatus_hourly (
        platform_id TEXT NOT NULL,
        key TEXT NOT NULL,
        bucket TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 0,
        fail INTEGER NOT NULL DEFAULT 0,
        duration_sum REAL NOT NULL DEFAULT 0,
        duration_count INTEGER NOT NULL DEFAULT 0,
        duration_max REAL,
        PRIMARY KEY (platform_id, key, bucket)
      );
      CREATE INDEX gatus_hourly_bucket ON gatus_hourly(bucket);

      -- changes of gatus_results_endpoint_success (outages for reports)
      CREATE TABLE gatus_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform_id TEXT NOT NULL,
        key TEXT NOT NULL,
        ts TEXT NOT NULL,
        success INTEGER NOT NULL
      );
      CREATE INDEX gatus_transitions_series ON gatus_transitions(platform_id, key, ts);
    `,
  },
];
