import { config } from './config.js';
import { OPS_MIGRATIONS } from './migrations/ops.js';
import { ENGINE_MIGRATIONS } from './migrations/engine.js';
import { PERF_MIGRATIONS } from './migrations/perf.js';
import { TRIGGER_MIGRATIONS } from './migrations/triggers.js';
import { openDriver, type Driver, type Row } from './database/drivers.js';
import { describeTarget, pgDdl, PG_CREATE_NOCASE, type DatabaseTarget } from './database/sql.js';
import { REPORT_MIGRATIONS } from './migrations/reports.js';
import { MONITOR_MIGRATIONS } from './migrations/monitors.js';
import { SECURITY_MIGRATIONS } from './migrations/security.js';
import { CREDENTIAL_MIGRATIONS } from './migrations/credentials.js';
import { GATUS_MIGRATIONS } from './migrations/gatus.js';
import { REPORT_SCHEDULE_MIGRATIONS } from './migrations/report-schedules.js';
import { RECORD_MIGRATIONS } from './migrations/records.js';
import { TICKET_MIGRATIONS } from './migrations/tickets.js';

export type { DatabaseTarget } from './database/sql.js';

export interface NamedMigration {
  name: string;
  /** SQLite DDL. */
  sql: string;
  /** PostgreSQL DDL; default: `sql` translated by pgDdl() (database/sql.ts). */
  pg?: string;
}
const NAMED_MIGRATIONS: NamedMigration[] = [
  ...OPS_MIGRATIONS,
  ...ENGINE_MIGRATIONS,
  ...PERF_MIGRATIONS,
  ...REPORT_MIGRATIONS,
  ...TRIGGER_MIGRATIONS,
  ...MONITOR_MIGRATIONS,
  ...SECURITY_MIGRATIONS,
  ...CREDENTIAL_MIGRATIONS,
  ...GATUS_MIGRATIONS,
  ...REPORT_SCHEDULE_MIGRATIONS,
  ...RECORD_MIGRATIONS,
  ...TICKET_MIGRATIONS,
];

const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE platforms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    base_url TEXT NOT NULL,
    environment TEXT NOT NULL DEFAULT '',
    config TEXT NOT NULL,
    secrets TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE platform_specs (
    id TEXT PRIMARY KEY,
    platform_id TEXT NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    format TEXT NOT NULL,
    title TEXT, version TEXT, server_url TEXT,
    content TEXT NOT NULL,
    operations TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE platform_docs (
    id TEXT PRIMARY KEY,
    platform_id TEXT NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT, url TEXT, filename TEXT, mime TEXT, size INTEGER,
    created_at TEXT NOT NULL
  );

  CREATE TABLE processes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    current_version INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE process_versions (
    process_id TEXT NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    definition TEXT NOT NULL,
    hash TEXT NOT NULL,
    author TEXT NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (process_id, version)
  );

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    process_id TEXT NOT NULL,
    process_name TEXT NOT NULL,
    process_version INTEGER NOT NULL,
    definition_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    dry_run INTEGER NOT NULL DEFAULT 0,
    trigger TEXT NOT NULL,
    schedule_id TEXT,
    actor TEXT NOT NULL,
    inputs TEXT NOT NULL,
    bindings TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error TEXT,
    stats TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX runs_started ON runs(started_at DESC);
  CREATE INDEX runs_process ON runs(process_id, started_at DESC);

  CREATE TABLE run_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    parent_key TEXT,
    step_id TEXT NOT NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    duration_ms INTEGER,
    summary TEXT,
    error TEXT,
    input TEXT,
    output TEXT,
    UNIQUE (run_id, key)
  );

  CREATE TABLE run_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    level TEXT NOT NULL,
    step_key TEXT,
    message TEXT NOT NULL,
    data TEXT
  );
  CREATE INDEX run_logs_run ON run_logs(run_id, id);

  CREATE TABLE run_tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    step_key TEXT NOT NULL,
    mode TEXT NOT NULL,
    title TEXT NOT NULL,
    instructions TEXT,
    columns TEXT NOT NULL,
    items TEXT NOT NULL,
    status TEXT NOT NULL,
    decision TEXT,
    decided_by TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, step_key)
  );

  CREATE TABLE run_artifacts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    step_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    process_id TEXT NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
    cron TEXT NOT NULL,
    timezone TEXT,
    inputs TEXT NOT NULL,
    bindings TEXT NOT NULL,
    dry_run INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    allow_overlap INTEGER NOT NULL DEFAULT 0,
    last_run_at TEXT,
    last_run_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE audit_log (
    seq INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    run_id TEXT,
    summary TEXT NOT NULL,
    details TEXT,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE INDEX audit_run ON audit_log(run_id);
  CREATE INDEX audit_entity ON audit_log(entity_type, entity_id);
  `,
  // 2: users, teams, sessions, access control
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    email TEXT,
    password_hash TEXT NOT NULL,
    roles TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  );
  CREATE TABLE teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE team_members (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (team_id, user_id)
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT
  );
  ALTER TABLE processes ADD COLUMN acl TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE processes ADD COLUMN owner TEXT;
  ALTER TABLE platforms ADD COLUMN acl TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE schedules ADD COLUMN owner TEXT;
  ALTER TABLE run_tasks ADD COLUMN assignees TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE run_tasks ADD COLUMN four_eyes INTEGER NOT NULL DEFAULT 0;
  `,
  // 3: reusable connector types
  `
  CREATE TABLE platform_types (
    kind TEXT PRIMARY KEY,
    package TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // 4: single sign-on (OpenID Connect)
  `
  CREATE TABLE identity_providers (
    id TEXT PRIMARY KEY,
    config TEXT NOT NULL,
    secret TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  ALTER TABLE users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local';
  ALTER TABLE users ADD COLUMN external_id TEXT;
  CREATE UNIQUE INDEX users_external_id ON users(external_id) WHERE external_id IS NOT NULL;
  `,
  // 5: datasets for dashboards, metric history, dashboards
  `
  CREATE TABLE datasets (
    key TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    process_id TEXT NOT NULL,
    process_name TEXT NOT NULL,
    run_id TEXT NOT NULL,
    dry_run INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    columns TEXT NOT NULL,
    rows TEXT NOT NULL,
    status_counts TEXT NOT NULL,
    metrics TEXT NOT NULL,
    stale_after_minutes INTEGER
  );
  CREATE TABLE dataset_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset_key TEXT NOT NULL,
    name TEXT NOT NULL,
    ts TEXT NOT NULL,
    value REAL NOT NULL,
    run_id TEXT
  );
  CREATE INDEX dataset_metrics_series ON dataset_metrics(dataset_key, name, ts);
  CREATE TABLE dashboards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    definition TEXT NOT NULL,
    owner TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
];

/** PostgreSQL-only additions, appended to the translated core migration with this index. */
const PG_CORE_EXTRA: Record<number, string> = {
  // SQLite's implicit rowid breaks ties in ORDER BY started_at, rowid (runs started in the same millisecond)
  0: 'ALTER TABLE runs ADD COLUMN rowid BIGINT GENERATED BY DEFAULT AS IDENTITY;',
};

/** Core migrations as run on the given dialect (exported for the schema parity test). */
export function coreMigrations(dialect: 'sqlite' | 'postgres'): string[] {
  return MIGRATIONS.map((m, i) => (dialect === 'sqlite' ? m : pgDdl(m) + '\n' + (PG_CORE_EXTRA[i] ?? '')));
}
export function namedMigrations(dialect: 'sqlite' | 'postgres'): { name: string; sql: string }[] {
  return NAMED_MIGRATIONS.map((m) => ({ name: m.name, sql: dialect === 'sqlite' ? m.sql : (m.pg ?? pgDdl(m.sql)) }));
}

/**
 * The app's database: synchronous API on SQLite (default) or PostgreSQL (SM_DATABASE_URL).
 * Write portable SQL: `?` placeholders, `ON CONFLICT … DO NOTHING/UPDATE`, no SQLite-only
 * functions or PRAGMAs, quoted camelCase aliases (`AS "runId"`), `lower(x) LIKE lower(?)`
 * for case-insensitive search. server/test/db.test.ts checks the sources for common slips.
 */
export class Db {
  readonly driver: Driver;

  constructor(target: DatabaseTarget | Driver, opts: { migrate?: boolean } = {}) {
    this.driver = 'dialect' in target ? target : openDriver(target);
    try {
      if (opts.migrate !== false) this.migrate();
    } catch (e) {
      this.driver.close();
      throw e;
    }
  }

  get dialect(): 'sqlite' | 'postgres' {
    return this.driver.dialect;
  }
  /** SQL expression for a top-level text field of a JSON column (portable json_extract). */
  jsonText(column: string, key: string): string {
    if (!/^[a-zA-Z_][\w.]*$/.test(column) || !/^\w+$/.test(key)) throw new Error('invalid JSON field reference');
    return this.dialect === 'postgres' ? `(${column}::jsonb ->> '${key}')` : `json_extract(${column}, '$.${key}')`;
  }
  /** Where the data lives, without credentials (for logs and the UI). */
  get label(): string {
    return this.driver.label;
  }

  /**
   * Feature migrations by name (applied once, in list order, after the core list).
   * Feature modules own their lists, so parallel work never collides on numbers.
   */
  private migrateNamed(): void {
    this.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const m of namedMigrations(this.dialect)) {
      if (this.get('SELECT 1 FROM schema_migrations WHERE name = ?', m.name)) continue;
      this.tx(() => {
        this.exec(m.sql);
        this.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', m.name, new Date().toISOString());
      });
    }
  }

  private migrate(): void {
    if (this.dialect === 'postgres') {
      try {
        this.exec(PG_CREATE_NOCASE);
      } catch (e) {
        throw new Error(`Could not create the case-insensitive collation (PostgreSQL with ICU support is required): ${(e as Error).message}`);
      }
    }
    const core = coreMigrations(this.dialect);
    this.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.get<{ version: number }>('SELECT version FROM schema_version');
    let version = row?.version ?? 0;
    if (!row) this.run('INSERT INTO schema_version (version) VALUES (0)');
    if (version > core.length) throw new Error(`The database schema (version ${version}) is newer than this version of the app supports (${core.length})`);
    while (version < core.length) {
      this.tx(() => {
        this.exec(core[version]!);
        version++;
        this.run('UPDATE schema_version SET version = ?', version);
      });
    }
    this.migrateNamed();
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.driver.all(sql, params) as T[];
  }
  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.driver.get(sql, params) as T | undefined;
  }
  run(sql: string, ...params: unknown[]): { changes: number } {
    return this.driver.run(sql, params);
  }
  /** Statements without parameters (DDL, several statements separated by `;`). */
  exec(sql: string): void {
    this.driver.exec(sql);
  }
  private depth = 0;
  /** Run fn in a transaction (nested calls join the outer transaction). */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.driver.begin();
    this.depth++;
    try {
      const out = fn();
      this.driver.commit();
      return out;
    } catch (e) {
      try {
        this.driver.rollback();
      } catch {
        /* keep the original error */
      }
      throw e;
    } finally {
      this.depth--;
    }
  }
  get inTransaction(): boolean {
    return this.depth > 0;
  }
  /** Size of the stored data in bytes (SQLite: file + WAL, PostgreSQL: tables and indexes of the schema). */
  sizeBytes(): number {
    return this.driver.sizeBytes();
  }
  /** After large deletes: give space back (SQLite WAL checkpoint; PostgreSQL autovacuum handles it). */
  compact(): void {
    this.driver.compact();
  }
  close(): void {
    this.driver.close();
  }
}

/** Database chosen by SM_DATABASE_URL (default: SQLite file in the data directory). */
export function databaseTarget(): DatabaseTarget {
  return config.database;
}
export const databaseLabel = (): string => describeTarget(databaseTarget());

let instance: Db | undefined;
export function db(): Db {
  if (!instance) instance = new Db(databaseTarget());
  return instance;
}
/** For tests. */
export function setDb(d: Db): void {
  instance = d;
}
