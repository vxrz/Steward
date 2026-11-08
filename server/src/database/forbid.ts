/**
 * Threads that must not read the database (the PDF worker, #13) say so here: db() then throws instead of opening a
 * second connection. Its own tiny module, so the worker can set it without loading db.ts and the migrations.
 */
let reason: string | null = null;

export function forbidDatabase(why: string): void {
  reason = why;
}

/** Why this thread has no database (null: it may open one). */
export const databaseForbidden = (): string | null => reason;
