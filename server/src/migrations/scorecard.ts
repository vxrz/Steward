import type { NamedMigration } from '../db.js';

/**
 * Availability objectives and the service scorecard (#86): objectives per Gatus endpoint with targets for Gatus'
 * windows (percent in hundredths, so 99.95 % is 9995 – exact on SQLite and PostgreSQL), their hourly samples and
 * breaches, the expected-document rules on the CIA rating, and one scorecard snapshot per service and day (trends read
 * the snapshots, they never recompute history from changed data).
 */
export const SCORECARD_MIGRATIONS: NamedMigration[] = [
  {
    name: 'scorecard-001-objectives-and-snapshots',
    sql: `
      CREATE TABLE availability_objectives (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL REFERENCES services(id),
        application_id TEXT REFERENCES applications(id),
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        platform_id TEXT NOT NULL,
        endpoint_key TEXT NOT NULL,
        target_h1 INTEGER,
        target_h24 INTEGER,
        target_d7 INTEGER,
        target_d30 INTEGER,
        notify INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX availability_objectives_service ON availability_objectives(service_id);

      -- one row per objective and hour: the values Steward had read from Gatus then (hundredths of a percent)
      CREATE TABLE objective_samples (
        objective_id TEXT NOT NULL,
        bucket TEXT NOT NULL,
        value_h1 INTEGER,
        value_h24 INTEGER,
        value_d7 INTEGER,
        value_d30 INTEGER,
        status TEXT NOT NULL,
        sampled_at TEXT NOT NULL,
        PRIMARY KEY (objective_id, bucket)
      );
      CREATE INDEX objective_samples_bucket ON objective_samples(bucket);

      -- a breach: from the first sample below target to the first sample that meets every target again
      CREATE TABLE objective_breaches (
        id TEXT PRIMARY KEY,
        objective_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        windows TEXT NOT NULL DEFAULT '[]',
        notified_at TEXT
      );
      CREATE INDEX objective_breaches_objective ON objective_breaches(objective_id, started_at);

      CREATE TABLE scorecard_rules (
        id TEXT PRIMARY KEY,
        type_id TEXT NOT NULL,
        dimension TEXT NOT NULL,
        min_level TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );

      -- the scorecard of a service on a day (local day of the instance time zone): written during the day, never after
      CREATE TABLE scorecard_snapshots (
        day TEXT NOT NULL,
        service_id TEXT NOT NULL,
        service_name TEXT NOT NULL,
        owners TEXT NOT NULL DEFAULT '[]',
        attention INTEGER NOT NULL,
        duties TEXT NOT NULL,
        availability TEXT NOT NULL,
        documentation TEXT NOT NULL,
        protection TEXT NOT NULL,
        document_ids TEXT NOT NULL DEFAULT '[]',
        details TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (day, service_id)
      );
      CREATE INDEX scorecard_snapshots_service ON scorecard_snapshots(service_id, day);
    `,
  },
  {
    // objectives are archived, not deleted: their samples and breaches stay until the retention removes them, and an
    // objective archived recently still counts on the scorecard until its longest window has passed
    name: 'scorecard-002-objective-archive',
    sql: `
      ALTER TABLE availability_objectives ADD COLUMN archived_at TEXT;
      ALTER TABLE availability_objectives ADD COLUMN archived_by TEXT;
    `,
  },
];
