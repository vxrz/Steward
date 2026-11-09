import type { Db } from '../db.js';
import { logger } from '../log.js';

/**
 * Giving deleted space back on SQLite (O8 of the 0.10 review). SQLite keeps the pages that deletes free inside the file
 * and reuses them; the file only shrinks with a VACUUM. A full VACUUM rewrites the whole file and blocks every writer
 * while it runs, so Steward does not do it on its own while it serves requests:
 * - New databases are created with incremental auto-vacuum (drivers.ts, SM_SQLITE_AUTO_VACUUM: it must be chosen
 *   before the file's header is written). After the retention clean-up
 *   (maintenance.ts) the free pages go back in small steps, PRAGMA incremental_vacuum(2048) – 8 MB at a time with a
 *   turn for the event loop in between.
 * - Older databases (auto-vacuum off): SM_SQLITE_VACUUM_AT_START=1 for one start converts them (VACUUM before the
 *   server listens: main.ts); until then the clean-up logs how much could be given back.
 * Free space is a metric too (sm_db_free_bytes, system/metrics.ts).
 */

export type AutoVacuum = 'none' | 'full' | 'incremental';

export interface SqliteSpace {
  pageSize: number;
  pages: number;
  freePages: number;
  autoVacuum: AutoVacuum;
}

export function sqliteSpace(d: Db): SqliteSpace | null {
  if (d.dialect !== 'sqlite') return null;
  const n = (sql: string, col: string) => Number(d.get<Record<string, number>>(sql)?.[col] ?? 0);
  const mode = n('PRAGMA auto_vacuum', 'auto_vacuum');
  return {
    pageSize: n('PRAGMA page_size', 'page_size'),
    pages: n('PRAGMA page_count', 'page_count'),
    freePages: n('PRAGMA freelist_count', 'freelist_count'),
    autoVacuum: mode === 2 ? 'incremental' : mode === 1 ? 'full' : 'none',
  };
}

const STEP_PAGES = 2048;

/**
 * Gives the free pages of an incremental auto-vacuum database back to the file system in steps, yielding between them;
 * stops after `budgetMs`. Older databases: logs how much a VACUUM would give back (when it is worth it).
 */
export async function reclaimFreePages(d: Db, o: { budgetMs?: number; turn?: () => Promise<void> } = {}): Promise<{ freedBytes: number } | null> {
  const before = sqliteSpace(d);
  if (!before || before.freePages === 0) return before ? { freedBytes: 0 } : null;
  const freeBytes = before.freePages * before.pageSize;
  if (before.autoVacuum !== 'incremental') {
    if (freeBytes > 64 * 1024 * 1024 && before.freePages > before.pages / 4)
      logger.info(
        { freeMb: Math.round(freeBytes / 1024 / 1024), fileMb: Math.round((before.pages * before.pageSize) / 1024 / 1024) },
        'the database file has free space that only a VACUUM gives back: set SM_SQLITE_VACUUM_AT_START=1 for one restart (docs/INSTALL.md)',
      );
    return { freedBytes: 0 };
  }
  const turn = o.turn ?? (() => new Promise<void>((r) => setImmediate(r)));
  const until = Date.now() + (o.budgetMs ?? 5 * 60_000);
  let free = before.freePages;
  while (free > 0 && Date.now() < until) {
    d.exec(`PRAGMA incremental_vacuum(${STEP_PAGES})`);
    const next = sqliteSpace(d)!.freePages;
    if (next >= free) break;
    free = next;
    await turn();
  }
  d.compact();
  return { freedBytes: (before.freePages - free) * before.pageSize };
}

/**
 * SM_SQLITE_VACUUM_AT_START: before the server listens, a full VACUUM that also switches the database to incremental
 * auto-vacuum. Blocks for as long as it takes (seconds per GB): meant for one start after a large clean-up.
 */
export function vacuumAtStart(d: Db): void {
  const before = sqliteSpace(d);
  if (!before) return;
  if (before.autoVacuum === 'incremental' && before.freePages < before.pages / 10) {
    logger.info({ freePages: before.freePages }, 'SM_SQLITE_VACUUM_AT_START: nothing to do (incremental auto-vacuum is on) – the variable can be removed');
    return;
  }
  const t0 = Date.now();
  logger.warn(
    { fileMb: Math.round((before.pages * before.pageSize) / 1024 / 1024), freeMb: Math.round((before.freePages * before.pageSize) / 1024 / 1024) },
    'SM_SQLITE_VACUUM_AT_START: rewriting the database file (VACUUM) before the server starts – this takes a while',
  );
  d.exec('PRAGMA auto_vacuum = INCREMENTAL');
  d.exec('VACUUM');
  d.compact();
  const after = sqliteSpace(d)!;
  logger.warn(
    { ms: Date.now() - t0, fileMb: Math.round((after.pages * after.pageSize) / 1024 / 1024), autoVacuum: after.autoVacuum },
    'SM_SQLITE_VACUUM_AT_START: done – remove the variable again',
  );
}
