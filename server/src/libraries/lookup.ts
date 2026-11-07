import type { LibraryOrigin } from '@sm/shared';
import { db } from '../db.js';
import { HttpError, parseJson } from '../util.js';
import { keyStateOf } from './trust.js';

/**
 * Small lookups other modules need (the engine, run details, reports): their own module, so those do not import
 * the install code.
 */

/** The library a process belongs to while that library is on hold (ADR 0014): the engine refuses new runs of it. */
export function heldLibraryOf(processId: string): string | null {
  return (
    db().get<{ library: string }>(
      "SELECT i.library FROM sync_items s JOIN library_installs i ON s.source_id = 'lib:' || i.library WHERE s.kind = 'process' AND s.entity_id = ? AND i.held = 1",
      processId,
    )?.library ?? null
  );
}

export type VersionOrigin = LibraryOrigin & { keyRevoked: boolean };

/** The library release a process version came from (process_versions.origin), with the state of its key now. */
export function versionOrigin(processId: string, version: number): VersionOrigin | null {
  const r = db().get<{ origin: string | null }>('SELECT origin FROM process_versions WHERE process_id = ? AND version = ?', processId, version);
  const o = r?.origin ? parseJson<LibraryOrigin | null>(r.origin, null) : null;
  return o ? { ...o, keyRevoked: keyStateOf(o.keyFingerprint) === 'revoked' } : null;
}

/** The held library a monitor belongs to (null: none, or not on hold). */
export function heldLibraryOfMonitor(monitorId: string): string | null {
  return (
    db().get<{ library: string }>(
      "SELECT i.library FROM sync_items s JOIN library_installs i ON s.source_id = 'lib:' || i.library WHERE s.kind = 'monitor' AND s.entity_id = ? AND i.held = 1",
      monitorId,
    )?.library ?? null
  );
}

/**
 * While a library is on hold, nothing of it is switched on again by hand: a schedule or webhook trigger of its
 * processes, or one of its monitors. Whoever may lift the hold (an administrator) lifts it first – that is audited
 * and turns on again exactly what the hold paused.
 */
export function refuseResumeWhileHeld(what: { processId?: string; monitorId?: string }): void {
  const library = what.processId ? heldLibraryOf(what.processId) : what.monitorId ? heldLibraryOfMonitor(what.monitorId) : null;
  if (library)
    throw new HttpError(409, `The library ${library} is on hold – an administrator lifts the hold first, which turns on again what it paused`, 'LIBRARY_HELD', {
      library,
      context: 'resume',
    });
}
