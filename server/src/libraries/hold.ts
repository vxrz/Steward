import { db } from '../db.js';

/**
 * The library a process belongs to while that library is on hold (ADR 0014): the engine refuses new runs of it
 * (engine/runner.ts startRun). Its own module, so the engine does not import the install code.
 */
export function heldLibraryOf(processId: string): string | null {
  return (
    db().get<{ library: string }>(
      "SELECT i.library FROM sync_items s JOIN library_installs i ON s.source_id = 'lib:' || i.library WHERE s.kind = 'process' AND s.entity_id = ? AND i.held = 1",
      processId,
    )?.library ?? null
  );
}
