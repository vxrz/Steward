import type { NamedMigration } from '../db.js';

/**
 * Platforms and their API specifications.
 * - platforms-004: what Steward last read from a Kafka Connect cluster (0.9.0, #223, kafkaconnect/service.ts): connectors,
 *   tasks and plugins – never a connector configuration.
 * - platforms-003: the periodic connection test of a platform (v0.4.0, platforms/health.ts): off by default.
 * - platforms-002: recorded responses for test runs (#105).
 * - platforms-001: the path prefix of an API specification (the path of its server URL, editable per spec). NULL for
 *   specs imported before: their prefix is derived from server_url when read (platforms/service.ts, specPrefix).
 */
export const PLATFORM_MIGRATIONS: NamedMigration[] = [
  {
    name: 'platforms-001-spec-path-prefix',
    sql: `ALTER TABLE platform_specs ADD COLUMN path_prefix TEXT;`,
  },
  {
    // Recorded responses (#105): answers that test runs use instead of the platform
    name: 'platforms-002-recordings',
    sql: `
      CREATE TABLE platform_recordings (
        id TEXT PRIMARY KEY,
        platform_id TEXT NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        query TEXT NOT NULL DEFAULT '{}',
        body_match TEXT,
        status INTEGER NOT NULL,
        headers TEXT NOT NULL DEFAULT '{}',
        body TEXT,
        note TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX platform_recordings_platform ON platform_recordings(platform_id, method);
    `,
  },
  {
    // Platform health (v0.4.0): an optional periodic connection test; failures notify the platform's managers
    name: 'platforms-003-health',
    sql: `
      CREATE TABLE platform_health (
        platform_id TEXT PRIMARY KEY REFERENCES platforms(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0,
        interval_minutes INTEGER NOT NULL DEFAULT 60,
        last_run_at TEXT,
        failing_since TEXT,
        notified_at TEXT,
        updated_by TEXT,
        updated_at TEXT
      );
    `,
  },
  {
    // Kafka Connect (0.9.0, #223): the last readout per platform (no configuration) and the Kafka platform it was linked to
    name: 'platforms-004-kafka-connect',
    sql: `
      CREATE TABLE kafka_connect_readouts (
        platform_id TEXT PRIMARY KEY REFERENCES platforms(id) ON DELETE CASCADE,
        kafka_platform_id TEXT,
        readout TEXT NOT NULL,
        read_at TEXT NOT NULL,
        read_by TEXT NOT NULL
      );
    `,
  },
];
