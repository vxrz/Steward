import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

/** A SQLite file other than the live database – a backup's snapshot (#117) – opened read-only. */
export interface SqliteFile {
  get<T>(sql: string, ...params: unknown[]): T | undefined;
  all<T>(sql: string, ...params: unknown[]): T[];
  /** PRAGMA integrity_check: ['ok'] when the file is sound */
  integrity(): string[];
  close(): void;
}

export function openSqliteFile(file: string): SqliteFile {
  const { DatabaseSync: Sqlite } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const d: DatabaseSync = new Sqlite(file, { readOnly: true });
  return {
    get: <T>(sql: string, ...params: unknown[]) => d.prepare(sql).get(...(params as [])) as T | undefined,
    all: <T>(sql: string, ...params: unknown[]) => d.prepare(sql).all(...(params as [])) as T[],
    integrity: () => (d.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]).map((r) => r.integrity_check),
    close: () => d.close(),
  };
}
