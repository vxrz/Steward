import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './log.js';
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
import { GITSYNC_MIGRATIONS } from './migrations/gitsync.js';
import { TICKET_MIGRATIONS } from './migrations/tickets.js';
import { DAILY_SUMMARY_MIGRATIONS } from './migrations/daily-summary.js';
import { COMPLIANCE_MIGRATIONS } from './migrations/compliance.js';

export type { DatabaseTarget } from './database/sql.js';

/** What a start-up changed on an existing database (Db.upgrade; audited as system.upgraded). */
export interface UpgradeInfo {
  fromSchema: { core: number; named: number };
  toSchema: { core: number; named: number };
  /** The app version that last opened the database (null: before versions were recorded). */
  fromVersion: string | null;
  toVersion: string;
  /** Migrations applied, in order ("core 6", then names). */
  migrations: string[];
  /** SQLite: the copy made before migrating (null: nothing to migrate, turned off, or PostgreSQL). */
  backup: string | null;
  at: string;
}

export interface DbOptions {
  migrate?: boolean;
  /**
   * SQLite: before applying migrations to an existing database, copy it to
   * `<dir>/pre-<version>-<UTC time>.db` and keep the newest `keep` copies (0 = no copy).
   */
  backup?: { dir: string; keep: number };
  /** The app version recorded in the database (default: config.version). */
  appVersion?: string;
  /** Tests: named migrations run after the built-in ones. */
  extraMigrations?: NamedMigration[];
}

/** Settings rows the migration code maintains ("system." keys are internal, see settings.ts). */
export const APP_VERSION_KEY = 'system.appVersion';
export const PENDING_UPGRADES_KEY = 'system.pendingUpgrades';

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
  ...GITSYNC_MIGRATIONS,
  ...TICKET_MIGRATIONS,
  ...DAILY_SUMMARY_MIGRATIONS,
  ...COMPLIANCE_MIGRATIONS,
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

  /** Set when this open migrated an existing database or found it last opened by another app version. */
  upgrade?: UpgradeInfo;

  constructor(
    target: DatabaseTarget | Driver,
    private readonly opts: DbOptions = {},
  ) {
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

  private migrate(): void {
    if (this.dialect === 'postgres') {
      try {
        this.exec(PG_CREATE_NOCASE);
      } catch (e) {
        throw new Error(`Could not create the case-insensitive collation (PostgreSQL with ICU support is required): ${(e as Error).message}`);
      }
    }
    const core = coreMigrations(this.dialect);
    // Feature migrations by name (applied once, in list order, after the core list): feature
    // modules own their lists, so parallel work never collides on numbers.
    const named = [
      ...namedMigrations(this.dialect),
      ...(this.opts.extraMigrations ?? []).map((m) => ({ name: m.name, sql: this.dialect === 'sqlite' ? m.sql : (m.pg ?? pgDdl(m.sql)) })),
    ];
    this.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    this.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const row = this.get<{ version: number }>('SELECT version FROM schema_version');
    const from = Number(row?.version ?? 0);
    if (!row) this.run('INSERT INTO schema_version (version) VALUES (0)');
    if (from > core.length) throw new Error(`The database schema (version ${from}) is newer than this version of the app supports (${core.length})`);
    const done = new Set(this.all<{ name: string }>('SELECT name FROM schema_migrations').map((r) => r.name));
    const pendingNamed = named.filter((m) => !done.has(m.name));
    // an existing database: the core schema was there before this start
    const existing = from > 0;
    const pending = from < core.length || pendingNamed.length > 0;
    const backup = existing && pending ? this.backupBeforeMigrating() : null;
    if (existing && pending && !backup) {
      const count = core.length - from + pendingNamed.length;
      if (this.dialect === 'postgres')
        logger.warn(
          { migrations: count },
          'PostgreSQL: migrating the database without an automatic backup – back up with pg_dump before you update the app (see docs/INSTALL.md, "Updating")',
        );
      else logger.warn({ migrations: count }, 'migrating the database without an automatic backup (SM_UPGRADE_BACKUPS=0)');
    }

    const applied: string[] = [];
    let step = '';
    try {
      for (let version = from; version < core.length;) {
        step = `core migration ${version + 1}`;
        this.tx(() => {
          this.exec(core[version]!);
          version++;
          this.run('UPDATE schema_version SET version = ?', version);
        });
        applied.push(`core ${version}`);
      }
      for (const m of pendingNamed) {
        step = `migration "${m.name}"`;
        this.tx(() => {
          this.exec(m.sql);
          this.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', m.name, new Date().toISOString());
        });
        applied.push(m.name);
      }
    } catch (e) {
      throw new Error(this.migrationFailed(step, (e as Error).message, applied, backup));
    }
    this.recordVersion({ existing, from, done: done.size, core: core.length, named: named.length, applied, backup });
  }

  /** The start-up error for a failed migration: what happened, and where the copy from before is. */
  private migrationFailed(step: string, message: string, applied: string[], backup: string | null): string {
    const lines = [`Database upgrade failed: ${step} did not apply: ${message}`];
    lines.push(
      applied.length
        ? `This migration was rolled back; ${applied.length} migration(s) before it were applied (${applied.join(', ')}).`
        : 'This migration was rolled back; the database was not changed.',
    );
    if (backup)
      lines.push(
        `A copy of the database from before the upgrade is at ${backup} – to go back, stop the app, replace the database with it and start the previous version.`,
      );
    else if (this.dialect === 'postgres') lines.push('To go back, restore the pg_dump backup made before the upgrade and start the previous version.');
    else lines.push('No automatic copy was made (SM_UPGRADE_BACKUPS=0).');
    lines.push('Please report the problem with this message.');
    return lines.join('\n');
  }

  /**
   * SQLite: a consistent copy of the whole database (VACUUM INTO: synchronous and online, unlike
   * node:sqlite's backup(), which is asynchronous) to <dir>/pre-<version>-<UTC time>.db, 0600 like
   * the database itself (it holds the same encrypted secrets). Older automatic copies beyond `keep`
   * are removed. A failed copy stops the start: nothing is migrated without the safety net.
   */
  private backupBeforeMigrating(): string | null {
    const b = this.opts.backup;
    if (this.dialect !== 'sqlite' || !b || b.keep <= 0) return null;
    const version = (this.opts.appVersion ?? config.version).replace(/[^\w.+-]/g, '_');
    const stamp = new Date()
      .toISOString()
      .replace(/\.\d+Z$/, 'Z')
      .replace(/:/g, '-');
    try {
      fs.mkdirSync(b.dir, { recursive: true, mode: 0o700 });
      // VACUUM INTO accepts an empty file: created first – exclusively ('wx', so an existing file or link is never
      // reused) and narrowed to 0600 on the open handle (not by name, umask aside) – so it never has wider permissions
      const create = (name: string): number | null => {
        try {
          return fs.openSync(name, 'wx', 0o600);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EEXIST') return null;
          throw e;
        }
      };
      let file = path.join(b.dir, `pre-${version}-${stamp}.db`);
      let fd = create(file);
      for (let n = 2; fd === null && n < 1000; n++) {
        file = path.join(b.dir, `pre-${version}-${stamp}-${n}.db`);
        fd = create(file);
      }
      if (fd === null) throw new Error(`no free file name for the copy in ${b.dir}`);
      try {
        if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
      } finally {
        fs.closeSync(fd);
      }
      try {
        this.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
      } catch (e) {
        fs.rmSync(file, { force: true });
        throw e;
      }
      pruneBackups(b.dir, b.keep);
      logger.info({ backup: file }, 'database backed up before migrating');
      return file;
    } catch (e) {
      throw new Error(
        `Database upgrade stopped: could not back up the database to ${b.dir} before migrating: ${(e as Error).message}. ` +
          'Free disk space or fix the folder permissions (or set SM_UPGRADE_BACKUPS=0 to upgrade without a copy).',
      );
    }
  }

  /**
   * Records the app version that opened an existing database and, for an upgrade, what changed
   * (audited as system.upgraded once the vault is open, see upgrades.ts).
   */
  private recordVersion(o: { existing: boolean; from: number; done: number; core: number; named: number; applied: string[]; backup: string | null }): void {
    const toVersion = this.opts.appVersion ?? config.version;
    const stored = this.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', APP_VERSION_KEY);
    let fromVersion: string | null = null;
    try {
      fromVersion = stored ? (JSON.parse(stored.value) as string) : null;
    } catch {
      /* unreadable: treated as unknown */
    }
    const put = (key: string, value: unknown) =>
      this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
    const upgraded = o.existing && (o.applied.length > 0 || (fromVersion !== null && fromVersion !== toVersion));
    this.tx(() => {
      if (upgraded) {
        this.upgrade = {
          fromSchema: { core: o.from, named: o.done },
          toSchema: { core: o.core, named: o.named },
          fromVersion,
          toVersion,
          migrations: o.applied,
          backup: o.backup,
          at: new Date().toISOString(),
        };
        const list = this.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', PENDING_UPGRADES_KEY);
        let pendingList: UpgradeInfo[] = [];
        try {
          pendingList = list ? (JSON.parse(list.value) as UpgradeInfo[]) : [];
        } catch {
          /* replaced */
        }
        put(PENDING_UPGRADES_KEY, [...pendingList.slice(-9), this.upgrade]);
      }
      // not on a new, empty database: it stays empty (db:copy only copies into empty targets)
      if (o.existing && fromVersion !== toVersion) put(APP_VERSION_KEY, toVersion);
    });
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

/** Automatic copies made before migrating (pre-<version>-<time>[-n].db), newest first. */
const BACKUP_FILE = /^pre-.+-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)(?:-(\d+))?\.db$/;
export function listUpgradeBackups(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const key = (n: string) => {
    const m = BACKUP_FILE.exec(n)!;
    return `${m[1]}#${String(Number(m[2] ?? 1)).padStart(6, '0')}`;
  };
  return names
    .filter((n) => BACKUP_FILE.test(n))
    .sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0))
    .map((n) => path.join(dir, n));
}
function pruneBackups(dir: string, keep: number): void {
  for (const f of listUpgradeBackups(dir).slice(keep)) fs.rmSync(f, { force: true });
}

/** The app's database with the start-up options: copies before migrating go to <data dir>/backups (SM_UPGRADE_BACKUPS). */
export function openAppDb(target: DatabaseTarget = databaseTarget(), extra: Pick<DbOptions, 'extraMigrations'> = {}): Db {
  return new Db(target, { backup: { dir: path.join(config.dataDir, 'backups'), keep: config.upgradeBackups }, ...extra });
}

let instance: Db | undefined;
export function db(): Db {
  if (!instance) instance = openAppDb();
  return instance;
}
/** For tests. */
export function setDb(d: Db): void {
  instance = d;
}
