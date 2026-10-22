import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { PgBridge, type PgBridgeOptions } from './pg-bridge.js';
import { describeTarget, toPgPlaceholders, type DatabaseTarget } from './sql.js';

export type Row = Record<string, unknown>;

/** What Db needs from a database: synchronous statements and transactions. */
export interface Driver {
  readonly dialect: 'sqlite' | 'postgres';
  readonly label: string;
  all(sql: string, params: unknown[]): Row[];
  get(sql: string, params: unknown[]): Row | undefined;
  run(sql: string, params: unknown[]): { changes: number };
  exec(sql: string): void;
  begin(): void;
  commit(): void;
  rollback(): void;
  sizeBytes(): number;
  compact(): void;
  close(): void;
}

function fileSize(f: string): number {
  try {
    return fs.statSync(f).size;
  } catch {
    return 0;
  }
}

export class SqliteDriver implements Driver {
  readonly dialect = 'sqlite' as const;
  readonly label: string;
  readonly raw: DatabaseSyncType;

  constructor(readonly file: string) {
    // Loaded lazily so the ExperimentalWarning filter in bootstrap.ts is active first.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.label = describeTarget({ kind: 'sqlite', file });
  }
  all(sql: string, params: unknown[]): Row[] {
    return this.raw.prepare(sql).all(...(params as never[])) as Row[];
  }
  get(sql: string, params: unknown[]): Row | undefined {
    return this.raw.prepare(sql).get(...(params as never[])) as Row | undefined;
  }
  run(sql: string, params: unknown[]): { changes: number } {
    return { changes: Number(this.raw.prepare(sql).run(...(params as never[])).changes) };
  }
  exec(sql: string): void {
    this.raw.exec(sql);
  }
  begin(): void {
    this.raw.exec('BEGIN IMMEDIATE');
  }
  commit(): void {
    this.raw.exec('COMMIT');
  }
  rollback(): void {
    this.raw.exec('ROLLBACK');
  }
  sizeBytes(): number {
    return fileSize(this.file) + fileSize(this.file + '-wal');
  }
  compact(): void {
    this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  close(): void {
    try {
      this.raw.close();
    } catch {
      /* already closed */
    }
  }
}

export class PostgresDriver implements Driver {
  readonly dialect = 'postgres' as const;
  readonly label: string;
  readonly bridge: PgBridge;
  private readonly translated = new Map<string, string>();

  constructor(target: Extract<DatabaseTarget, { kind: 'postgres' }>, extra: Partial<PgBridgeOptions> = {}) {
    if (isSea()) {
      throw new Error(
        'PostgreSQL (SM_DATABASE_URL) is not available in the desktop executable – it always uses its built-in SQLite database. ' +
          'Unset SM_DATABASE_URL, or run the Node.js or container version for PostgreSQL.',
      );
    }
    this.label = describeTarget(target);
    this.bridge = new PgBridge({ url: target.url, schema: target.schema, lock: target.lock ?? true, timeoutMs: target.timeoutMs ?? 30000, ...extra });
  }

  /** `?` → `$n`; cached, as the app's SQL strings are mostly constants. */
  private sql(sql: string): string {
    let t = this.translated.get(sql);
    if (t === undefined) {
      t = toPgPlaceholders(sql);
      if (this.translated.size > 2000) this.translated.clear();
      this.translated.set(sql, t);
    }
    return t;
  }
  all(sql: string, params: unknown[]): Row[] {
    return this.bridge.query(this.sql(sql), params).rows;
  }
  get(sql: string, params: unknown[]): Row | undefined {
    return this.bridge.query(this.sql(sql), params).rows[0];
  }
  run(sql: string, params: unknown[]): { changes: number } {
    return { changes: this.bridge.query(this.sql(sql), params).rowCount };
  }
  exec(sql: string): void {
    this.bridge.exec(sql);
  }
  begin(): void {
    this.bridge.begin();
  }
  commit(): void {
    this.bridge.commit();
  }
  rollback(): void {
    this.bridge.rollback();
  }
  sizeBytes(): number {
    const r = this.get(
      `SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0) AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = current_schema() AND c.relkind IN ('r', 'm')`,
      [],
    );
    return Number(r?.n ?? 0);
  }
  compact(): void {
    /* autovacuum */
  }
  close(): void {
    this.bridge.close();
  }
}

function isSea(): boolean {
  try {
    return (createRequire(import.meta.url)('node:sea') as { isSea(): boolean }).isSea();
  } catch {
    return false;
  }
}

export function openDriver(target: DatabaseTarget): Driver {
  return target.kind === 'sqlite' ? new SqliteDriver(target.file) : new PostgresDriver(target);
}
