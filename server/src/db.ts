import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { config } from './config.js';

// Loaded lazily so the ExperimentalWarning filter in bootstrap.ts is active first.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

type Row = Record<string, unknown>;

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
];

export class Db {
  readonly raw: DatabaseSyncType;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.get<{ version: number }>('SELECT version FROM schema_version');
    let version = row?.version ?? 0;
    if (!row) this.run('INSERT INTO schema_version (version) VALUES (0)');
    while (version < MIGRATIONS.length) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[version]!);
        version++;
        this.run('UPDATE schema_version SET version = ?', version);
      });
    }
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.raw.prepare(sql).all(...(params as never[])) as T[];
  }
  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.raw.prepare(sql).get(...(params as never[])) as T | undefined;
  }
  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...(params as never[]));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
  private depth = 0;
  /** Run fn in a transaction (nested calls join the outer transaction). */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }
}

let instance: Db | undefined;
export function db(): Db {
  if (!instance) instance = new Db(path.join(config.dataDir, 'service-manager.db'));
  return instance;
}
/** For tests. */
export function setDb(d: Db): void {
  instance = d;
}
