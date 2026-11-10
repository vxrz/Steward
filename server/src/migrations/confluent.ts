import type { NamedMigration } from '../db.js';

/**
 * Confluent Cloud (0.14.0, #123, docs/CONFLUENT.md). Additive only.
 *
 * confluent_readouts: per Confluent Cloud platform, what Steward last read – environments, clusters, Schema Registry
 *   clusters and subjects, service accounts, API key metadata (never a secret) and managed connectors with their tasks
 *   (no configuration) – as JSON, with when and by whom.
 */
export const CONFLUENT_MIGRATIONS: NamedMigration[] = [
  {
    name: 'confluent-001-readouts',
    sql: `
      CREATE TABLE confluent_readouts (
        platform_id TEXT PRIMARY KEY REFERENCES platforms(id) ON DELETE CASCADE,
        readout TEXT NOT NULL,
        read_at TEXT NOT NULL,
        read_by TEXT NOT NULL
      );
    `,
  },
];
