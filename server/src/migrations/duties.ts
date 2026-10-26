import type { NamedMigration } from '../db.js';

/**
 * Service duties (#85): the duties of services, one row per period of a duty (open periods are kept up to date, closed
 * ones are never changed again: the service scorecard reads them), exceptions ("skipped for this period") with the
 * four-eyes decision, and the bookkeeping of the reminders sent.
 */
export const DUTY_MIGRATIONS: NamedMigration[] = [
  {
    name: 'duties-001-service-duties',
    sql: `
      CREATE TABLE service_duties (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL REFERENCES services(id),
        application_id TEXT REFERENCES applications(id),
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        process_id TEXT NOT NULL,
        schedule_id TEXT,
        interval_kind TEXT NOT NULL,
        level TEXT NOT NULL,
        grace_days INTEGER NOT NULL DEFAULT 0,
        remind_days INTEGER NOT NULL DEFAULT 5,
        owners TEXT NOT NULL DEFAULT '[]',
        archived INTEGER NOT NULL DEFAULT 0,
        active_from TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE INDEX service_duties_service ON service_duties(service_id);
      CREATE INDEX service_duties_process ON service_duties(process_id);

      -- one row per duty and period; what the period was judged against is copied in (name, level, interval, grace,
      -- process name, time zone), so a closed period never changes when the duty or the process changes later
      CREATE TABLE duty_periods (
        duty_id TEXT NOT NULL REFERENCES service_duties(id),
        period_key TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        grace_end TEXT NOT NULL,
        status TEXT NOT NULL,
        run_id TEXT,
        run_status TEXT,
        run_started_at TEXT,
        run_finished_at TEXT,
        failed_runs INTEGER NOT NULL DEFAULT 0,
        skip_id TEXT,
        service_id TEXT NOT NULL,
        application_id TEXT,
        duty_name TEXT NOT NULL,
        process_id TEXT NOT NULL,
        process_name TEXT NOT NULL,
        level TEXT NOT NULL,
        interval_kind TEXT NOT NULL,
        grace_days INTEGER NOT NULL,
        time_zone TEXT NOT NULL,
        evaluated_at TEXT NOT NULL,
        closed_at TEXT,
        PRIMARY KEY (duty_id, period_key)
      );
      CREATE INDEX duty_periods_end ON duty_periods(period_end);
      CREATE INDEX duty_periods_service ON duty_periods(service_id, period_end);

      CREATE TABLE duty_skips (
        id TEXT PRIMARY KEY,
        duty_id TEXT NOT NULL REFERENCES service_duties(id),
        period_key TEXT NOT NULL,
        period_start TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        decided_by TEXT,
        decided_at TEXT,
        decision_comment TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX duty_skips_duty ON duty_skips(duty_id, period_key);

      -- reminders and "missed" messages sent, so each goes out once (also across restarts)
      CREATE TABLE duty_notifications (
        duty_id TEXT NOT NULL,
        period_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (duty_id, period_key, kind)
      );
    `,
  },
  {
    // periods closed before the end of their grace period (the duty was archived or its rules changed), and the
    // status "inactive" for the periods an archived duty went through
    name: 'duties-002-close-note',
    sql: `ALTER TABLE duty_periods ADD COLUMN close_note TEXT;`,
  },
  {
    // what exactly was done: the process version and definition hash of the run that counted
    name: 'duties-003-run-version',
    sql: `
      ALTER TABLE duty_periods ADD COLUMN run_version INTEGER;
      ALTER TABLE duty_periods ADD COLUMN run_definition_hash TEXT;
    `,
  },
  {
    // who may decide an exception: the duty's and the service's owners as of the request (four-eyes)
    name: 'duties-004-skip-deciders',
    sql: `ALTER TABLE duty_skips ADD COLUMN decider_subjects TEXT NOT NULL DEFAULT '[]';`,
  },
];
